/**
 * AirPurifierAccessory
 *
 * Xiaomi Air Purifier (2S / Pro) 통합 액세서리.
 *
 * 통합 시 적용한 개선점 (선풍기 fix 와 동일한 사상):
 *  - "Command grace period": set_power 직후 폴링이 펌웨어가 아직 상태 전이를 끝내지
 *    못한 값을 반환해 홈킷 아이콘이 잠깐 OFF로 깜빡이는 race condition을 방지.
 *    set 동안 짧은 보호 구간을 두어 폴링 값으로 낙관적 값을 덮어쓰지 않도록 한다.
 *  - 짧은 burst 폴링 (300/800/1500ms)로 set 후 실제 상태가 일치하면 빨리 grace 해제.
 *  - 연결 실패 시 지수 백오프, polling 실패 시 자동 재연결.
 *  - 가능한 모든 onSet은 낙관적 업데이트 + grace + 실제 호출 + 실패시 롤백 패턴.
 */

'use strict';

const LocalMiioDevice = require('../common/LocalMiioDevice.js');
const { clamp, isFiniteNumber, sleep, capitalize, applyServiceName, requireValidIpAndToken, withTimeout } = require('../common/helpers.js');

const DEFAULT_POLLING_MS = 15000;
const RECONNECT_INTERVAL_MS = 30000;
const CONNECT_RETRY_MAX = 5;
const CONNECT_RETRY_BASE_MS = 800;
const CALL_TIMEOUT_MS = 8000;                   // miio 호출이 응답 없이 매달리는 것 방지
const CONNECT_TIMEOUT_MS = 8000;                // miio.device() 연결이 매달리는 것 방지

// === 새 개선: command grace ===
const COMMAND_GRACE_MS = 4000;                  // set 직후 보호 구간 (전원/모드). 전이가 느린 기기에서 전원 타일이 잠깐 반대로 깜빡이는 것 방지.
const VERIFY_BURST_DELAYS = [300, 900, 1700];   // set 후 빠른 재폴링 시점

// === keepFavoriteMode (v1.2.22) ===
// 전원 ON 직후 이 시간 안에 동반된 자동(auto) 모드 요청은 사용자의 의도가 아니라
// Apple 홈이 전원 명령에 몰래 같이 보내는 자동 전환으로 판정한다.
const HK_POWERON_AUTO_WINDOW_MS = 3000;
// 집행 가능한 "정상 모드 문자열" 화이트리스트 (v1.2.23) — get_prop 짧은/밀린 응답으로
// mode 슬롯에 쓰레기 값이 들어와도 오발사하지 않게 방어(선풍기 76f1aca와 동일 사상).
const ENFORCEABLE_MODES = ['auto', 'silent', 'sleep', 'idle', 'low', 'medium', 'high', 'strong'];
// 자동 모드일 때 홈킷 속도 표시값 (v1.2.24) — 실측 불가라 표시용 고정 %
const AUTO_MODE_DISPLAY_PERCENT = 40;
// 속도 슬라이더 디바운스 (v1.2.25) — 드래그 중 중간값마다 기기로 전송하지 않고
// 손을 뗀 뒤(마지막 값) 한 번만 전송. 선풍기 setRotationSpeed와 동일 패턴/동일 값.
const SPEED_DEBOUNCE_MS = 500;

class AirPurifierAccessory {
  constructor(ctx, config) {
    this.ctx = ctx;
    this.api = ctx.api;
    this.log = ctx.log;
    this.hap = ctx.hap;
    this.Service = this.hap.Service;
    this.Characteristic = this.hap.Characteristic;
    this.PLUGIN_NAME = ctx.PLUGIN_NAME;
    this.PLATFORM_NAME = ctx.PLATFORM_NAME;

    // === 설정 정규화 ===
    this.config = this.normalizeConfig(config);
    requireValidIpAndToken(this.config, `AirPurifier '${this.config.name}'`);

    this.device = null;
    this.connecting = false;
    this.pollTimer = null;
    this.reconnectTimer = null;
    this.burstTimers = [];

    // pending = 보호 구간에 잠겨 있는 상태값들
    // 각 key 별로 { target, expire }
    this.pending = {};

    // keepFavoriteMode: 홈킷에서 의도적으로 비-favorite 모드를 선택했는지 기억 (집행 예외).
    // 재시작하면 초기화 → favorite 유지 정책이 기본으로 되살아난다.
    this._hkNonFavoriteIntent = false;
    this._lastHkPowerOnTs = 0;

    this.state = {}; // power, mode, aqi, favorite_level, buzzer, led, temperature, humidity, filter1_life ...
    this.filterSvc = null;
    this.child = {
      temp: null, humi: null, aq: null,
      led: null, buzzer: null,
      auto: null, sleep: null, fav: null,
    };

    this.UUID = this.hap.uuid.generate(`xiaomi-km81:airpurifier:${this.config.ip}:${this.config.token}:${this.config.name}`);

    let accessory = this.ctx.accessories.get(this.UUID);
    if (!accessory) {
      accessory = new this.api.platformAccessory(this.config.name, this.UUID, this.hap.Categories.AIR_PURIFIER);
      accessory.context.config = this.config;
      this.api.registerPlatformAccessories(this.PLUGIN_NAME, this.PLATFORM_NAME, [accessory]);
      this.ctx.accessories.set(this.UUID, accessory);
      this.logDebug(`새 액세서리 등록`);
    } else {
      this.logDebug(`캐시 액세서리 재사용`);
      accessory.context.config = this.config;
    }
    this.accessory = accessory;

    this.setupInformation();
    this.setupAirPurifierService();
    this.ensureSensorsAndSwitches();

    // 비동기 연결 및 폴링 시작 (init 자체는 throw 하지 않음)
    this.connectWithRetry().then(() => {
      return this.refresh();
    }).catch((e) => {
      this.logDebug(`초기 연결 실패 (재시도 예약됨): ${e.message || e}`);
    }).finally(() => {
      this.schedulePolling();
    });
  }

  getAccessoryUUIDs() {
    const uuids = [this.UUID];
    Object.values(this.child).forEach(c => { if (c && c.acc && c.acc.UUID !== this.UUID) uuids.push(c.acc.UUID); });
    return uuids;
  }

  shutdown() {
    this._shutdown = true;
    this.clearBurstTimers();
    if (this.pollTimer) { clearTimeout(this.pollTimer); this.pollTimer = null; }
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this._speedDebounceTimer) { clearTimeout(this._speedDebounceTimer); this._speedDebounceTimer = null; }
    if (this.device && typeof this.device.destroy === 'function') {
      try { this.device.destroy(); } catch (_) {}
    }
    this.device = null;
  }

  /*============================================================
   *                     CONFIG NORMALIZATION
   *============================================================*/
  normalizeConfig(c) {
    c = c || {};
    const name = (c.name || c.ip || 'Air Purifier').toString();
    const ip = (c.ip || '').toString();
    const token = (c.token || '').toString();
    const type = (c.type || 'MiAirPurifier2S').toString();
    const aq = c.airQualityThresholds || {};
    const pick = (flat, nested, fallback) =>
      isFiniteNumber(flat) ? Number(flat) : (isFiniteNumber(nested) ? Number(nested) : fallback);
    return {
      name, ip, token, type,
      serialNumber: c.serialNumber || c.deviceId,
      pollingInterval: isFiniteNumber(c.pollingInterval) ? c.pollingInterval : DEFAULT_POLLING_MS,

      showTemperature: c.showTemperature !== false,
      separateTemperatureAccessory: !!c.separateTemperatureAccessory,
      temperatureName: c.temperatureName || '',

      showHumidity: c.showHumidity !== false,
      separateHumidityAccessory: !!c.separateHumidityAccessory,
      humidityName: c.humidityName || '',

      showAirQuality: c.showAirQuality !== false,
      separateAirQualityAccessory: !!c.separateAirQualityAccessory,
      airQualityName: c.airQualityName || '',
      airQualityThresholds: {
        t1: pick(c.aqExcellent, aq.t1, 5),
        t2: pick(c.aqGood,      aq.t2, 15),
        t3: pick(c.aqFair,      aq.t3, 35),
        t4: pick(c.aqInferior,  aq.t4, 55),
      },

      showLED: !!c.showLED,
      separateLedAccessory: !!c.separateLedAccessory,
      ledName: c.ledName || '',

      showBuzzer: !!c.showBuzzer,
      separateBuzzerAccessory: !!c.separateBuzzerAccessory,
      buzzerName: c.buzzerName || '',

      showAutoModeSwitch: !!c.showAutoModeSwitch,
      separateAutoModeAccessory: !!c.separateAutoModeAccessory,
      autoModeName: c.autoModeName || '',

      showSleepModeSwitch: !!c.showSleepModeSwitch,
      separateSleepModeAccessory: !!c.separateSleepModeAccessory,
      sleepModeName: c.sleepModeName || '',

      showFavoriteModeSwitch: !!c.showFavoriteModeSwitch,
      separateFavoriteModeAccessory: !!c.separateFavoriteModeAccessory,
      favoriteModeName: c.favoriteModeName || '',

      // 기기·타 앱에서 auto/silent로 바뀌면 favorite으로 자동 복귀 (홈킷發 의도적 전환은 존중)
      keepFavoriteMode: !!c.keepFavoriteMode,
    };
  }

  /*============================================================
   *                     SETUP SERVICES
   *============================================================*/

  setupInformation() {
    const { Service, Characteristic } = this;
    let info = this.accessory.getService(Service.AccessoryInformation);
    if (!info) info = this.accessory.addService(Service.AccessoryInformation);
    info.setCharacteristic(Characteristic.Manufacturer, 'Xiaomi')
      .setCharacteristic(Characteristic.Model, this.config.type || 'Air Purifier')
      .setCharacteristic(Characteristic.SerialNumber, this.config.serialNumber || this.config.ip)
      .setCharacteristic(Characteristic.FirmwareRevision, this.ctx.packageVersion);
  }

  setupAirPurifierService() {
    const { Service, Characteristic } = this;

    const ap = this.accessory.getService(Service.AirPurifier)
      || this.accessory.addService(Service.AirPurifier, this.config.name);
    applyServiceName(Characteristic, ap, this.config.name);

    this.filterSvc = this.accessory.getService(Service.FilterMaintenance)
      || this.accessory.addService(Service.FilterMaintenance, `${this.config.name} Filter`);

    ap.getCharacteristic(Characteristic.Active).onSet(async (v) => {
      const next = v ? 'on' : 'off';
      const prev = this.state.power;
      // keepFavoriteMode: 전원 ON 시각 기록 — 직후 동반되는 자동 모드 요청 판정용.
      // (dedupe return보다 먼저 기록해야 이미 켜진 상태의 재-ON에도 창이 열린다.)
      if (next === 'on') this._lastHkPowerOnTs = Date.now();
      // 이미 같은 상태면 호출 생략 (회전속도 슬라이더 등에서 중복 호출 방지)
      if (prev === next && !this.pending.power) return;
      this.beginGrace('power', next);
      this.state.power = next;
      this.updateAll();
      try {
        await this.call('set_power', [next]);
      } catch (e) {
        this.endGrace('power');
        this.state.power = prev;
        this.updateAll();
        throw e;
      }
    });

    ap.getCharacteristic(Characteristic.TargetAirPurifierState).onSet(async (v) => {
      const wantsAuto = (v === Characteristic.TargetAirPurifierState.AUTO);
      // keepFavoriteMode: Apple 홈이 전원 ON에 동반해 자동(auto)을 몰래 같이 보내는 요청 차단.
      // 전원 ON 직후 짧은 창 안의 auto는 사용자의 의도적 모드 전환이 아니라고 판정한다.
      if (wantsAuto && this.config.keepFavoriteMode
          && (Date.now() - this._lastHkPowerOnTs) < HK_POWERON_AUTO_WINDOW_MS) {
        this.logInfo('keepFavoriteMode: 전원 ON에 동반된 자동 모드 요청 무시 (favorite 유지)');
        setTimeout(() => {
          try {
            ap.updateCharacteristic(Characteristic.TargetAirPurifierState,
              Characteristic.TargetAirPurifierState.MANUAL);
          } catch (_) {}
        }, 250);
        return;
      }
      const next = wantsAuto ? 'auto' : 'favorite';
      const prev = this.state.mode;
      this.beginGrace('mode', next);
      this.state.mode = next;
      this.updateAll();
      try {
        await this.call('set_mode', [next]);
        // 홈킷發 의도적 전환 기억 — keepFavoriteMode 집행 예외 (성공했을 때만)
        this._hkNonFavoriteIntent = (next !== 'favorite');
      } catch (e) {
        this.endGrace('mode');
        this.state.mode = prev;
        this.updateAll();
        throw e;
      }
    });

    ap.getCharacteristic(Characteristic.RotationSpeed).onSet(async (percent) => {
      // HomeKit이 전원 OFF와 함께 RotationSpeed 0을 보내는 경우가 있다. 이때 즐겨찾기
      // 모드로 강제 전환하면 방금 내린 전원 OFF와 충돌해 전원 타일이 깜빡인다 → 0이면 무시.
      if (!isFiniteNumber(percent) || percent <= 0) return;
      // v1.2.25: 낙관 UI는 즉시(grace 보호 — 드래그가 길어도 매 틱 재무장), 기기 전송은
      // 500ms 디바운스로 마지막 값만 (선풍기 setRotationSpeed와 동일 패턴).
      const level = clamp(Math.round((clamp(percent, 0, 100) / 100) * 16), 1, 16);
      this.beginGrace('mode', 'favorite');
      this.beginGrace('favorite_level', level); // 드래그 중 verify burst가 옛 값으로 슬라이더 되돌리는 것 방지
      this.state.mode = 'favorite';
      this.state.favorite_level = level;
      this.updateAll();
      this._speedTarget = percent;
      if (this._speedDebounceTimer) clearTimeout(this._speedDebounceTimer);
      this._speedDebounceTimer = setTimeout(() => {
        this._speedDebounceTimer = null;
        if (this._shutdown) return;
        this.setFavoriteLevelPercent(this._speedTarget)
          .then(() => { this._hkNonFavoriteIntent = false; }) // 속도 조절 = favorite 복귀 → 집행 재개
          .catch((e) => {
            this.endGrace('mode');
            this.endGrace('favorite_level');
            this.logWarn(`속도 설정 실패 (다음 폴링에서 상태 복원): ${e.message || e}`);
            this.refresh().catch(() => { /* 다음 정규 폴링으로 회복 */ });
          });
      }, SPEED_DEBOUNCE_MS);
    });
  }

  ensureSensorsAndSwitches() {
    const { Service, Characteristic } = this;
    const c = this.config;

    // Temperature
    if (c.showTemperature) {
      if (c.separateTemperatureAccessory) {
        this.child.temp = this.ensureChild('temp', c.temperatureName || `${c.name} Temperature`, Service.TemperatureSensor);
      } else {
        const svc = this.accessory.getServiceById(Service.TemperatureSensor, 'TEMP')
          || this.accessory.addService(Service.TemperatureSensor, c.temperatureName || `${c.name} Temperature`, 'TEMP');
        applyServiceName(Characteristic, svc, c.temperatureName || `${c.name} Temperature`);
        this.child.temp = { acc: this.accessory, svc };
      }
    } else {
      this.removeChild('temp');
      const svc = this.accessory.getServiceById(Service.TemperatureSensor, 'TEMP');
      if (svc) this.accessory.removeService(svc);
      this.child.temp = null;
    }

    // Humidity
    if (c.showHumidity) {
      if (c.separateHumidityAccessory) {
        this.child.humi = this.ensureChild('humi', c.humidityName || `${c.name} Humidity`, Service.HumiditySensor);
      } else {
        const svc = this.accessory.getServiceById(Service.HumiditySensor, 'HUMI')
          || this.accessory.addService(Service.HumiditySensor, c.humidityName || `${c.name} Humidity`, 'HUMI');
        applyServiceName(Characteristic, svc, c.humidityName || `${c.name} Humidity`);
        this.child.humi = { acc: this.accessory, svc };
      }
    } else {
      this.removeChild('humi');
      const svc = this.accessory.getServiceById(Service.HumiditySensor, 'HUMI');
      if (svc) this.accessory.removeService(svc);
      this.child.humi = null;
    }

    // Air Quality
    if (c.showAirQuality) {
      if (c.separateAirQualityAccessory) {
        this.child.aq = this.ensureChild('aq', c.airQualityName || `${c.name} AQI`, Service.AirQualitySensor);
      } else {
        const svc = this.accessory.getServiceById(Service.AirQualitySensor, 'AQI')
          || this.accessory.addService(Service.AirQualitySensor, c.airQualityName || `${c.name} AQI`, 'AQI');
        applyServiceName(Characteristic, svc, c.airQualityName || `${c.name} AQI`);
        this.child.aq = { acc: this.accessory, svc };
      }
    } else {
      this.removeChild('aq');
      const svc = this.accessory.getServiceById(Service.AirQualitySensor, 'AQI');
      if (svc) this.accessory.removeService(svc);
      this.child.aq = null;
    }

    // LED
    if (c.showLED) {
      this.child.led = this.bindSimpleSwitch(
        'led', 'LED', c.ledName || `${c.name} LED`, c.separateLedAccessory,
        async (on) => {
          const prev = this.state.led;
          const next = on ? 'on' : 'off';
          this.beginGrace('led', next);
          this.state.led = next;
          this.updateAll();
          try {
            if (this.config.type === 'MiAirPurifierPro') {
              await this.call('set_led_b', [on ? 0 : 2]);
            } else {
              await this.call('set_led', [next]);
            }
          } catch (e) {
            this.endGrace('led');
            this.state.led = prev;
            this.updateAll();
            throw e;
          }
        }
      );
    } else {
      this.removeChild('led');
      const svc = this.accessory.getServiceById(Service.Switch, 'LED');
      if (svc) this.accessory.removeService(svc);
      this.child.led = null;
    }

    // Buzzer
    if (c.showBuzzer) {
      this.child.buzzer = this.bindSimpleSwitch(
        'buzzer', 'Buzzer', c.buzzerName || `${c.name} Buzzer`, c.separateBuzzerAccessory,
        async (on) => {
          const prev = this.state.buzzer;
          const next = on ? 'on' : 'off';
          this.beginGrace('buzzer', next);
          this.state.buzzer = next;
          this.updateAll();
          try {
            await this.call('set_buzzer', [next]);
          } catch (e) {
            this.endGrace('buzzer');
            this.state.buzzer = prev;
            this.updateAll();
            throw e;
          }
        }
      );
    } else {
      this.removeChild('buzzer');
      const svc = this.accessory.getServiceById(Service.Switch, 'Buzzer');
      if (svc) this.accessory.removeService(svc);
      this.child.buzzer = null;
    }

    // Mode switches
    const bindModeSwitch = (kind, title, whenOn, whenOffIfWas) => {
      const key = `mode-${kind}`;
      let holder;
      if (this.config[`separate${capitalize(kind)}ModeAccessory`]) {
        holder = this.ensureChild(key, title, Service.Switch);
      } else {
        const svc = this.accessory.getServiceById(Service.Switch, key)
          || this.accessory.addService(Service.Switch, title, key);
        applyServiceName(Characteristic, svc, title);
        holder = { acc: this.accessory, svc };
      }
      holder.svc.getCharacteristic(Characteristic.On).onSet(async (on) => {
        const prev = this.state.mode;
        const next = on ? whenOn : (prev === whenOn ? whenOffIfWas : prev);
        if (next !== prev) {
          this.beginGrace('mode', next);
          this.state.mode = next;
          this.updateAll();
        }
        try {
          if (on) {
            await this.call('set_mode', [whenOn]);
            this._hkNonFavoriteIntent = (whenOn !== 'favorite');   // 홈킷發 의도 기억
          } else if (prev === whenOn) {
            await this.call('set_mode', [whenOffIfWas]);
            this._hkNonFavoriteIntent = (whenOffIfWas !== 'favorite');
          }
        } catch (e) {
          this.endGrace('mode');
          this.state.mode = prev;
          this.updateAll();
          throw e;
        }
      });
      return holder;
    };

    if (c.showAutoModeSwitch) {
      this.child.auto = bindModeSwitch('Auto', c.autoModeName || `${c.name} Auto Mode`, 'auto', 'favorite');
    } else {
      this.removeChild('mode-Auto');
      const svc = this.accessory.getServiceById(Service.Switch, 'mode-Auto');
      if (svc) this.accessory.removeService(svc);
      this.child.auto = null;
    }
    if (c.showSleepModeSwitch) {
      this.child.sleep = bindModeSwitch('Sleep', c.sleepModeName || `${c.name} Sleep Mode`, 'silent', 'favorite');
    } else {
      this.removeChild('mode-Sleep');
      const svc = this.accessory.getServiceById(Service.Switch, 'mode-Sleep');
      if (svc) this.accessory.removeService(svc);
      this.child.sleep = null;
    }
    if (c.showFavoriteModeSwitch) {
      this.child.fav = bindModeSwitch('Favorite', c.favoriteModeName || `${c.name} Favorite Mode`, 'favorite', 'auto');
    } else {
      this.removeChild('mode-Favorite');
      const svc = this.accessory.getServiceById(Service.Switch, 'mode-Favorite');
      if (svc) this.accessory.removeService(svc);
      this.child.fav = null;
    }
  }

  bindSimpleSwitch(key, subType, displayName, separateAcc, onSetHandler) {
    const { Service, Characteristic } = this;
    let holder;
    if (separateAcc) {
      holder = this.ensureChild(key, displayName, Service.Switch);
    } else {
      const svc = this.accessory.getServiceById(Service.Switch, subType)
        || this.accessory.addService(Service.Switch, displayName, subType);
      applyServiceName(Characteristic, svc, displayName);
      holder = { acc: this.accessory, svc };
    }
    holder.svc.getCharacteristic(Characteristic.On).onSet(onSetHandler);
    return holder;
  }

  ensureChild(suffix, name, svcType) {
    const uuid = this.hap.uuid.generate(`${this.UUID}:${suffix}`);
    let acc = this.ctx.accessories.get(uuid);
    if (!acc) {
      acc = new this.api.platformAccessory(name, uuid);
      acc.category = this.hap.Categories.OTHER;
      acc.context.parentUUID = this.UUID;
      const svc = acc.getService(svcType) || acc.addService(svcType, name);
      applyServiceName(this.Characteristic, svc, name);
      this.api.registerPlatformAccessories(this.PLUGIN_NAME, this.PLATFORM_NAME, [acc]);
      this.ctx.accessories.set(uuid, acc);
      return { acc, svc };
    }
    const svc = acc.getService(svcType) || acc.addService(svcType, name);
    applyServiceName(this.Characteristic, svc, name);
    return { acc, svc };
  }

  removeChild(suffix) {
    const uuid = this.hap.uuid.generate(`${this.UUID}:${suffix}`);
    const acc = this.ctx.accessories.get(uuid);
    if (acc) {
      try { this.api.unregisterPlatformAccessories(this.PLUGIN_NAME, this.PLATFORM_NAME, [acc]); } catch (_) {}
      this.ctx.accessories.delete(uuid);
    }
  }

  /*============================================================
   *                     CONNECT / POLL / CALL
   *============================================================*/

  async connectWithRetry() {
    if (this._shutdown) return false;
    if (this.device) return true;
    if (this.connecting) return false;
    this.connecting = true;

    try {
      let attempt = 0;
      while (attempt < CONNECT_RETRY_MAX && !this.device) {
        if (this._shutdown) return false;
        attempt++;
        try {
          this.logInfo(`연결 시도 ${attempt}/${CONNECT_RETRY_MAX} ... (${this.config.ip})`);
          const device = await withTimeout(
            new LocalMiioDevice(this.config.ip, this.config.token, null, this.config.type, this.log).connect(),
            CONNECT_TIMEOUT_MS,
            'connect'
          );
          // shutdown 이 연결 대기 중에 발생했다면, 방금 만든 살아있는 연결을 그대로 두면
          // 소켓이 누수된다 → 즉시 파기하고 빠져나간다 (shutdown 후 부활 방지).
          if (this._shutdown) { try { device.destroy(); } catch (_) {} return false; }
          this.device = device;
          this.logInfo('연결됨');
          return true;
        } catch (e) {
          const delay = CONNECT_RETRY_BASE_MS * Math.pow(2, attempt - 1);
          this.logWarn(`연결 실패: ${e.message || e} → ${Math.round(delay)}ms 후 재시도`);
          await sleep(delay);
          if (this._shutdown) return false;
        }
      }
      // 모든 시도가 실패 → 재연결 예약 (실패 경로에서 반드시 재무장)
      this.scheduleReconnect();
      return false;
    } finally {
      this.connecting = false;
    }
  }

  scheduleReconnect() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(async () => {
      if (this._shutdown) return;
      try { this.device && this.device.destroy(); } catch (_) {}
      this.device = null;
      await this.connectWithRetry();
    }, RECONNECT_INTERVAL_MS);
  }

  schedulePolling() {
    if (this.pollTimer) clearTimeout(this.pollTimer);
    const iv = Math.max(3000, Number(this.config.pollingInterval) || DEFAULT_POLLING_MS);
    const loop = async () => {
      if (this.pollTimer) clearTimeout(this.pollTimer);
      try {
        await this.refresh();
        // 실패 로그가 찍힌 뒤 첫 성공 — 복구를 명시 (v2.0.0)
        if (this._pollFailStreak) {
          this.logInfo(`폴링 복구 — ${this._pollFailStreak}회 실패 후 정상화`);
          this._pollFailStreak = 0;
        }
      } catch (e) {
        this._pollFailStreak = (this._pollFailStreak || 0) + 1;
        // 첫 실패 + 매 10회만 error, 나머지는 debug (장애 지속 시 로그 홍수 방지, v2.0.0)
        if (this._pollFailStreak === 1 || this._pollFailStreak % 10 === 0) {
          this.logError(`폴링 실패 x${this._pollFailStreak}: ${e.message || e}`);
        } else {
          this.logDebug(`폴링 실패 x${this._pollFailStreak}: ${e.message || e}`);
        }
        this.scheduleReconnect();
      } finally {
        if (!this._shutdown) this.pollTimer = setTimeout(loop, iv);
      }
    };
    this.pollTimer = setTimeout(loop, iv);
  }

  async refresh() {
    if (!this.device) {
      const ok = await this.connectWithRetry();
      if (!ok) return;
    }
    const props = await this.call('get_prop', [
      'power', 'mode', 'aqi', 'favorite_level', 'buzzer', 'led', 'led_b',
      'temperature', 'temp_dec', 'humidity',
      'filter1_life', 'filter1_hours', 'average_aqi'
    ], true);
    this.applyProps(props);
    this.updateAll();
    await this.maybeEnforceFavorite();
  }

  // keepFavoriteMode: 기기 본체 버튼·Mi Home 등 외부에서 auto/silent로 바뀌면 favorite으로
  // 자동 복귀시킨다. 홈킷에서 의도적으로 바꾼 모드는 존중(_hkNonFavoriteIntent).
  // 절대 throw하지 않는다 — 폴링 루프를 죽이면 안 됨.
  async maybeEnforceFavorite() {
    try {
      if (!this.config.keepFavoriteMode || this._shutdown) return;
      if (this._hkNonFavoriteIntent) return;               // 홈킷發 의도적 전환은 존중
      if (this.pending.mode || this.pending.power) return; // 명령 보호 구간엔 개입 금지 (불변식)
      if (this.state.power !== 'on') return;
      const m = this.state.mode;
      if (m === undefined || m === null || m === 'favorite') return;
      // 화이트리스트 밖 값(짧은 응답으로 밀린 숫자 등)은 신뢰하지 않고 이번 사이클 스킵
      if (typeof m !== 'string' || !ENFORCEABLE_MODES.includes(m)) {
        this.logWarn(`keepFavoriteMode: mode 값이 비정상('${m}') — 이번 폴링은 집행 생략`);
        return;
      }
      this.logInfo(`keepFavoriteMode: 외부에서 모드가 '${m}'로 바뀐 것을 감지 → favorite 복귀`);
      this.beginGrace('mode', 'favorite');
      this.state.mode = 'favorite';
      this.updateAll();
      try {
        await this.call('set_mode', ['favorite']);
      } catch (e) {
        this.endGrace('mode');
        this.state.mode = m;   // 낙관값 롤백 (onSet 핸들러들과 동일 패턴)
        this.updateAll();
        this.logWarn(`keepFavoriteMode: favorite 복귀 실패 (다음 폴링에서 재시도): ${e.message || e}`);
      }
    } catch (e) {
      this.logWarn(`keepFavoriteMode: 내부 오류 (무시): ${e.message || e}`);
    }
  }

  applyProps(arr) {
    const keys = ['power', 'mode', 'aqi', 'favorite_level', 'buzzer', 'led', 'led_b',
      'temperature', 'temp_dec', 'humidity', 'filter1_life', 'filter1_hours', 'average_aqi'];
    for (let i = 0; i < keys.length && i < arr.length; i++) {
      this.state[keys[i]] = arr[i];
    }
    if (!isFiniteNumber(this.state.temperature) && isFiniteNumber(this.state.temp_dec)) {
      this.state.temperature = Number(this.state.temp_dec) / 10;
    }
    if (this.state.led_b !== undefined && this.config.type === 'MiAirPurifierPro') {
      this.state.led = (Number(this.state.led_b) === 0) ? 'on' : 'off';
    }
    // grace 적용: 폴링값이 목표와 다르면 목표값을 우선 사용
    this.applyGrace();
  }

  applyGrace() {
    const now = Date.now();
    for (const key of Object.keys(this.pending)) {
      const p = this.pending[key];
      if (!p) continue;
      if (now >= p.expire) {
        this.endGrace(key);
        continue;
      }
      const currentValue = this.state[key];
      if (currentValue === p.target) {
        // 폴링이 목표값을 확인 → 보호 구간 즉시 해제
        this.endGrace(key);
      } else {
        // 폴링이 다른 값을 반환 → 일시적으로 목표값으로 덮어씀 (UI 안정)
        this.state[key] = p.target;
      }
    }
  }

  beginGrace(key, target) {
    this.pending[key] = { target, expire: Date.now() + COMMAND_GRACE_MS };
    this.scheduleVerifyBurst();
  }

  endGrace(key) {
    delete this.pending[key];
    if (Object.keys(this.pending).length === 0) {
      this.clearBurstTimers();
    }
  }

  scheduleVerifyBurst() {
    this.clearBurstTimers();
    VERIFY_BURST_DELAYS.forEach(d => {
      const t = setTimeout(() => {
        // 보호 구간 중에는 짧은 간격으로 폴링하여 실제 상태 확인
        if (Object.keys(this.pending).length > 0) {
          this.refresh().catch(() => { /* burst 실패는 다음 정규 폴링으로 회복 */ });
        }
      }, d);
      this.burstTimers.push(t);
    });
  }

  clearBurstTimers() {
    this.burstTimers.forEach(t => clearTimeout(t));
    this.burstTimers = [];
  }

  async call(method, args, silent = false) {
    if (!this.device) {
      await this.connectWithRetry();
      if (!this.device) throw new Error('not connected');
    }
    try {
      const res = await withTimeout(this.device.call(method, args), CALL_TIMEOUT_MS, method);
      if (!silent && this.log.debug) this.log.debug(`[${this.config.name}] ${method}(${JSON.stringify(args)}) → ${JSON.stringify(res)}`);
      return res;
    } catch (e) {
      this.logWarn(`${method} 호출 실패: ${e.message || e} → 재연결 시도`);
      try { this.device && this.device.destroy(); } catch (_) {}   // dgram 소켓 정리(누수 방지)
      this.device = null;
      await this.connectWithRetry();
      if (!this.device) {
        this.scheduleReconnect();
        throw e;
      }
      try {
        const res2 = await withTimeout(this.device.call(method, args), CALL_TIMEOUT_MS, method);
        this.logInfo(`${method} 재연결 후 재시도 성공 — 복구됨`); // 위 warn과 짝 (v2.0.0)
        return res2;
      } catch (e2) {
        // 재시도마저 실패 → half-dead device 방지: 정리 후 재연결 예약
        try { this.device && this.device.destroy(); } catch (_) {}
        this.device = null;
        this.scheduleReconnect();
        throw e2;
      }
    }
  }

  async setFavoriteLevelPercent(percent) {
    const p = clamp(percent, 0, 100);
    const max = 16, min = 1;
    const level = clamp(Math.round((p / 100) * max), min, max);
    // v1.2.23: 기기가 auto/silent 상태일 때 속도만 바꾸면 모드가 그대로 남는다(캐시가 최대
    // 폴링 주기만큼 stale일 수 있어 캐시로는 판단 불가) → 항상 favorite 선행 전환(멱등).
    await this.call('set_mode', ['favorite']);
    await this.call('set_level_favorite', [level]);
    this.state.favorite_level = level;
  }

  mapAqiToHK(aqi) {
    const t = this.config.airQualityThresholds;
    const C = this.Characteristic;
    if (!isFiniteNumber(aqi)) return C.AirQuality.UNKNOWN;
    if (aqi <= t.t1) return C.AirQuality.EXCELLENT;
    if (aqi <= t.t2) return C.AirQuality.GOOD;
    if (aqi <= t.t3) return C.AirQuality.FAIR;
    if (aqi <= t.t4) return C.AirQuality.INFERIOR;
    return C.AirQuality.POOR;
  }

  updateAll() {
    const { Service, Characteristic } = this;
    const ap = this.accessory.getService(Service.AirPurifier);
    if (!ap) return;

    const powerOn = (this.state.power === 'on');
    ap.updateCharacteristic(Characteristic.Active, powerOn ? 1 : 0);

    const target = this.state.mode === 'auto'
      ? Characteristic.TargetAirPurifierState.AUTO
      : Characteristic.TargetAirPurifierState.MANUAL;
    ap.updateCharacteristic(Characteristic.TargetAirPurifierState, target);

    const current = powerOn
      ? Characteristic.CurrentAirPurifierState.PURIFYING_AIR
      : Characteristic.CurrentAirPurifierState.INACTIVE;
    ap.updateCharacteristic(Characteristic.CurrentAirPurifierState, current);

    // 회전속도 슬라이더는 즐겨찾기(수동) 모드에서만 의미가 있다. auto/silent 에서는 0으로
    // 표시해 "슬라이더는 올라가 있는데 효과가 없는" 혼란을 막는다(reference 동작과 동일).
    const fav = Number(this.state.favorite_level);
    if (this.state.mode === 'favorite' && isFiniteNumber(fav)) {
      const speed = clamp(Math.round((fav / 16) * 100), 0, 100);
      ap.updateCharacteristic(Characteristic.RotationSpeed, speed);
    } else if (this.state.mode === 'auto' && this.state.power === 'on') {
      // v1.2.24: 자동 모드는 기기가 속도를 스스로 정하므로 실측값이 없다 — 0%는 "안 도는
      // 것처럼" 보여서 표시용 고정 40%. 슬라이더를 만지면 기존대로 favorite 전환.
      ap.updateCharacteristic(Characteristic.RotationSpeed, AUTO_MODE_DISPLAY_PERCENT);
    } else {
      ap.updateCharacteristic(Characteristic.RotationSpeed, 0);
    }

    if (this.child.temp && this.child.temp.svc && isFiniteNumber(this.state.temperature)) {
      this.child.temp.svc.updateCharacteristic(Characteristic.CurrentTemperature, Number(this.state.temperature));
    }
    if (this.child.humi && this.child.humi.svc && isFiniteNumber(this.state.humidity)) {
      this.child.humi.svc.updateCharacteristic(Characteristic.CurrentRelativeHumidity, Number(this.state.humidity));
    }
    if (this.child.aq && this.child.aq.svc && isFiniteNumber(this.state.aqi)) {
      this.child.aq.svc.updateCharacteristic(Characteristic.AirQuality, this.mapAqiToHK(Number(this.state.aqi)));
      this.child.aq.svc.updateCharacteristic(Characteristic.PM2_5Density, Number(this.state.aqi));
    }

    // LED/부저 설정은 전원과 독립적으로 유지되므로 전원이 꺼져 있어도 설정 상태를 그대로
    // 표시한다 (powerOn 게이트 제거). led_b(Pro)는 applyProps 에서 이미 state.led 로 변환되므로
    // state.led 만 보면 되고, 과거의 `Number(null)===0 → 항상 ON` 버그도 제거된다.
    const ledOn = (this.state.led === 'on');
    const ledSvc = (this.child.led && this.child.led.svc) || this.accessory.getServiceById(Service.Switch, 'LED');
    if (ledSvc) ledSvc.updateCharacteristic(Characteristic.On, ledOn);

    const bzOn = (this.state.buzzer === 'on');
    const bzSvc = (this.child.buzzer && this.child.buzzer.svc) || this.accessory.getServiceById(Service.Switch, 'Buzzer');
    if (bzSvc) bzSvc.updateCharacteristic(Characteristic.On, bzOn);

    const autoOn = (this.state.mode === 'auto');
    const sleepOn = (this.state.mode === 'silent');
    const favOn = (this.state.mode === 'favorite');
    const autoSvc = (this.child.auto && this.child.auto.svc) || this.accessory.getServiceById(Service.Switch, 'mode-Auto');
    if (autoSvc) autoSvc.updateCharacteristic(Characteristic.On, powerOn && autoOn);
    const sleepSvc = (this.child.sleep && this.child.sleep.svc) || this.accessory.getServiceById(Service.Switch, 'mode-Sleep');
    if (sleepSvc) sleepSvc.updateCharacteristic(Characteristic.On, powerOn && sleepOn);
    const favSvc = (this.child.fav && this.child.fav.svc) || this.accessory.getServiceById(Service.Switch, 'mode-Favorite');
    if (favSvc) favSvc.updateCharacteristic(Characteristic.On, powerOn && favOn);

    if (this.filterSvc && isFiniteNumber(this.state.filter1_life)) {
      this.filterSvc.updateCharacteristic(Characteristic.FilterLifeLevel, Number(this.state.filter1_life));
    }
  }

  /*============================================================
   *                     LOG
   *============================================================*/
  logInfo(m, ...a)  { this.log.info(`[${this.config.name}] ${m}`, ...a); }
  logWarn(m, ...a)  { this.log.warn(`[${this.config.name}] ${m}`, ...a); }
  logDebug(m, ...a) { this.log.debug(`[${this.config.name}] ${m}`, ...a); }
  logError(m, ...a) { this.log.error(`[${this.config.name}] ${m}`, ...a); }
}

module.exports = AirPurifierAccessory;

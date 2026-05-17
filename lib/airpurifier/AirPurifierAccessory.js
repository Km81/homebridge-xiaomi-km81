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

const miio = require('miio');
const { clamp, isFiniteNumber, sleep, capitalize, applyServiceName, requireValidIpAndToken } = require('../common/helpers.js');

const DEFAULT_POLLING_MS = 15000;
const RECONNECT_INTERVAL_MS = 30000;
const CONNECT_RETRY_MAX = 5;
const CONNECT_RETRY_BASE_MS = 800;

// === 새 개선: command grace ===
const COMMAND_GRACE_MS = 2500;                  // set 직후 보호 구간 (전원/모드)
const VERIFY_BURST_DELAYS = [300, 900, 1700];   // set 후 빠른 재폴링 시점

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
    this.clearBurstTimers();
    if (this.pollTimer) { clearTimeout(this.pollTimer); this.pollTimer = null; }
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
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
      serialNumber: c.serialNumber,
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
      const next = (v === Characteristic.TargetAirPurifierState.AUTO) ? 'auto' : 'favorite';
      const prev = this.state.mode;
      this.beginGrace('mode', next);
      this.state.mode = next;
      this.updateAll();
      try {
        await this.call('set_mode', [next]);
      } catch (e) {
        this.endGrace('mode');
        this.state.mode = prev;
        this.updateAll();
        throw e;
      }
    });

    ap.getCharacteristic(Characteristic.RotationSpeed).onSet(async (percent) => {
      const prevMode = this.state.mode;
      this.beginGrace('mode', 'favorite');
      this.state.mode = 'favorite';
      this.updateAll();
      try {
        await this.setFavoriteLevelPercent(percent);
      } catch (e) {
        this.endGrace('mode');
        this.state.mode = prevMode;
        this.updateAll();
        throw e;
      }
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
          if (on) await this.call('set_mode', [whenOn]);
          else if (prev === whenOn) await this.call('set_mode', [whenOffIfWas]);
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
    if (this.device) return true;
    if (this.connecting) return false;
    this.connecting = true;

    let attempt = 0;
    while (attempt < CONNECT_RETRY_MAX && !this.device) {
      attempt++;
      try {
        this.logInfo(`연결 시도 ${attempt}/${CONNECT_RETRY_MAX} ... (${this.config.ip})`);
        this.device = await miio.device({ address: this.config.ip, token: this.config.token });
        this.logInfo('연결됨');
        this.connecting = false;
        return true;
      } catch (e) {
        const delay = CONNECT_RETRY_BASE_MS * Math.pow(2, attempt - 1);
        this.logWarn(`연결 실패: ${e.message || e} → ${Math.round(delay)}ms 후 재시도`);
        await sleep(delay);
      }
    }
    this.connecting = false;
    this.scheduleReconnect();
    return false;
  }

  scheduleReconnect() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(async () => {
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
      } catch (e) {
        this.logError(`폴링 실패: ${e.message || e}`);
        this.scheduleReconnect();
      } finally {
        this.pollTimer = setTimeout(loop, iv);
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
      const res = await this.device.call(method, args);
      if (!silent && this.log.debug) this.log.debug(`[${this.config.name}] ${method}(${JSON.stringify(args)}) → ${JSON.stringify(res)}`);
      return res;
    } catch (e) {
      this.logWarn(`${method} 호출 실패: ${e.message || e} → 재연결 시도`);
      this.device = null;
      await this.connectWithRetry();
      if (!this.device) {
        this.scheduleReconnect();
        throw e;
      }
      const res2 = await this.device.call(method, args);
      return res2;
    }
  }

  async setFavoriteLevelPercent(percent) {
    const p = clamp(percent, 0, 100);
    const max = 16, min = 1;
    const level = clamp(Math.round((p / 100) * max), min, max);
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

    const fav = Number(this.state.favorite_level);
    if (isFiniteNumber(fav)) {
      const speed = clamp(Math.round((fav / 16) * 100), 0, 100);
      ap.updateCharacteristic(Characteristic.RotationSpeed, speed);
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

    const ledOn = (this.state.led === 'on' || Number(this.state.led_b) === 0);
    const ledSvc = (this.child.led && this.child.led.svc) || this.accessory.getServiceById(Service.Switch, 'LED');
    if (ledSvc) ledSvc.updateCharacteristic(Characteristic.On, powerOn && !!ledOn);

    const bzOn = (this.state.buzzer === 'on');
    const bzSvc = (this.child.buzzer && this.child.buzzer.svc) || this.accessory.getServiceById(Service.Switch, 'Buzzer');
    if (bzSvc) bzSvc.updateCharacteristic(Characteristic.On, powerOn && !!bzOn);

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

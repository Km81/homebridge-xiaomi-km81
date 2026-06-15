/**
 * HumidifierAccessory
 *
 * Xiaomi 가습기 (zhimi/deerma/shuii 시리즈) 통합 액세서리.
 * nt0xa/homebridge-mi-humidifier 의 모델 정의를 포팅한 후 다음을 적용했다:
 *
 *  - 단일 'miio' 패키지를 사용해 다른 디바이스 (선풍기/공기청정기/멀티탭) 와 일관성 유지
 *  - 낙관적 UI 업데이트 + Command Grace Period: set 직후 폴링 race로 인한 깜빡임 방지
 *  - 자동 재연결 (지수 백오프, 연속 실패 임계치)
 *  - setInterval 대신 setTimeout 루프 → 폴링 실패 시 안전한 재진입
 *  - getOrCreateService 패턴 + ConfiguredName 보존
 *  - HumidifierDehumidifier 서비스 / 옵션 부저, LED, 온도/습도 센서, 청소 모드 스위치 지원
 *  - 가습기는 일반적으로 Dehumidify 기능이 없으므로 TargetState 를 HUMIDIFIER 로 고정
 */

'use strict';

const miio = require('miio');
const { clamp, isFiniteNumber, sleep, withTimeout, applyServiceName, requireValidIpAndToken } = require('../common/helpers.js');
const { resolveModel, listSupportedModels } = require('./models.js');

const DEFAULT_POLLING_MS = 30000;
const MIN_POLLING_MS = 5000;
const CONNECT_RETRY_BASE_MS = 1500;
const CONNECT_RETRY_MAX_DELAY_MS = 60000;
const COMMAND_GRACE_MS = 4000;   // set 직후 보호 구간 (전 장비 4초 통일)
const VERIFY_BURST_DELAYS = [400, 1000, 1900];
const POLL_FAIL_THRESHOLD = 3;
const CALL_TIMEOUT_MS = 8000;
const CONNECT_TIMEOUT_MS = 8000;

class HumidifierAccessory {
  constructor(ctx, config) {
    this.ctx = ctx;
    this.api = ctx.api;
    this.log = ctx.log;
    this.hap = ctx.hap;
    this.Service = this.hap.Service;
    this.Characteristic = this.hap.Characteristic;
    this.PLUGIN_NAME = ctx.PLUGIN_NAME;
    this.PLATFORM_NAME = ctx.PLATFORM_NAME;

    this.cfg = this.normalizeConfig(config);
    requireValidIpAndToken(this.cfg, `Humidifier '${this.cfg.name}'`);

    this.modelDef = resolveModel(this.cfg.model);
    if (!this.modelDef) {
      throw new Error(`Humidifier '${this.cfg.name}': 알 수 없는 모델 '${this.cfg.model}'. ` +
        `지원 모델: ${listSupportedModels().join(', ')}`);
    }
    this.protocol = this.modelDef.protocol;

    // 상태
    this.device = null;
    this.connecting = false;
    this.connectingAttempt = 0;
    this.consecutiveFailures = 0;
    this.pending = {};      // key -> {target, expire}
    this.cache = {};        // 마지막 polled raw 값 (modelDef key 그대로)
    this.pollTimer = null;
    this.reconnectTimer = null;
    this.burstTimers = [];

    this.UUID = this.hap.uuid.generate(`xiaomi-km81:humidifier:${this.cfg.ip}:${this.cfg.token}`);

    let accessory = this.ctx.accessories.get(this.UUID);
    if (!accessory) {
      accessory = new this.api.platformAccessory(this.cfg.name, this.UUID, this.hap.Categories.AIR_HUMIDIFIER);
      this.api.registerPlatformAccessories(this.PLUGIN_NAME, this.PLATFORM_NAME, [accessory]);
      this.ctx.accessories.set(this.UUID, accessory);
      this.logInfo('새 액세서리 등록');
    } else {
      this.logInfo('캐시 액세서리 복원');
    }
    this.accessory = accessory;

    this.setupInformation();
    this.setupHumidifierService();
    this.setupOptionalServices();

    // 비동기 연결 시작
    this.connect();
  }

  getAccessoryUUIDs() { return [this.UUID]; }

  shutdown() {
    if (this.pollTimer) { clearTimeout(this.pollTimer); this.pollTimer = null; }
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    this.clearBurst();
    if (this.device && this.device.destroy) {
      try { this.device.destroy(); } catch (_) {}
    }
    this.device = null;
  }

  /*============================================================
   *                  CONFIG
   *============================================================*/
  normalizeConfig(c) {
    c = c || {};
    return {
      name: (c.name || 'Xiaomi Humidifier').toString(),
      ip: (c.ip || '').toString(),
      token: (c.token || '').toString(),
      deviceId: c.deviceId,
      model: (c.model || '').toString(),
      serialNumber: c.serialNumber,
      pollingInterval: clamp(Number(c.pollingInterval) * 1000, MIN_POLLING_MS, 600000) || DEFAULT_POLLING_MS,
      // sub-services
      enableTemperatureSensor: c.enableTemperatureSensor !== false,
      temperatureSensorName: c.temperatureSensorName,
      enableHumiditySensor: c.enableHumiditySensor !== false,
      humiditySensorName: c.humiditySensorName,
      enableBuzzerSwitch: !!c.enableBuzzerSwitch,
      buzzerSwitchName: c.buzzerSwitchName,
      enableLedBulb: !!c.enableLedBulb,
      ledBulbName: c.ledBulbName,
      enableCleanModeSwitch: !!c.enableCleanModeSwitch,
      cleanModeSwitchName: c.cleanModeSwitchName,
      disableTargetHumidity: !!c.disableTargetHumidity,
      autoSwitchToHumidityMode: c.autoSwitchToHumidityMode !== false,
    };
  }

  /*============================================================
   *                  SERVICE SETUP
   *============================================================*/

  setupInformation() {
    const { Service, Characteristic } = this;
    let info = this.accessory.getService(Service.AccessoryInformation);
    if (!info) info = this.accessory.addService(Service.AccessoryInformation);
    info.setCharacteristic(Characteristic.Manufacturer, 'Xiaomi')
      .setCharacteristic(Characteristic.Model, this.cfg.model)
      .setCharacteristic(Characteristic.SerialNumber, this.cfg.serialNumber || this.cfg.deviceId || this.cfg.ip)
      .setCharacteristic(Characteristic.FirmwareRevision, this.ctx.packageVersion);
  }

  getOrCreateService(ServiceClass, displayName, subType) {
    const { Characteristic } = this;
    let service;
    if (subType) {
      service = this.accessory.getServiceById(ServiceClass, subType);
      if (!service) service = this.accessory.addService(ServiceClass, displayName, subType);
    } else {
      service = this.accessory.getService(ServiceClass);
      if (!service) service = this.accessory.addService(ServiceClass, displayName);
    }
    applyServiceName(Characteristic, service, displayName);
    return service;
  }

  removeSubService(ServiceClass, subType) {
    const svc = this.accessory.getServiceById(ServiceClass, subType);
    if (svc) this.accessory.removeService(svc);
  }

  setupHumidifierService() {
    const { Service, Characteristic } = this;
    const md = this.modelDef;
    const svc = this.getOrCreateService(Service.HumidifierDehumidifier, this.cfg.name);
    this.humSvc = svc;

    // TargetHumidifierDehumidifierState: HUMIDIFIER 고정
    svc.getCharacteristic(Characteristic.TargetHumidifierDehumidifierState)
      .setProps({ validValues: [Characteristic.TargetHumidifierDehumidifierState.HUMIDIFIER] })
      .updateValue(Characteristic.TargetHumidifierDehumidifierState.HUMIDIFIER);

    // Active (power)
    svc.getCharacteristic(Characteristic.Active).onSet(async (v) => {
      const wantOn = (v === Characteristic.Active.ACTIVE);
      const target = wantOn ? md.power.on : md.power.off;
      const prev = this.cache[md.power.key];
      if (prev === target && !this.pending[md.power.key]) return;
      this.beginGrace(md.power.key, target);
      this.cache[md.power.key] = target;
      this.pushUpdates();
      try {
        await this.callSet(md.power.key, target, md.power.call);
      } catch (e) {
        this.endGrace(md.power.key);
        this.cache[md.power.key] = prev;
        this.pushUpdates();
        throw e;
      }
    });

    // RotationSpeed = mode
    if (md.mode) {
      const N = md.mode.values.length;
      svc.getCharacteristic(Characteristic.RotationSpeed)
        .setProps({ minValue: 0, maxValue: N, minStep: 1 })
        .onSet(async (val) => {
          // Home.app은 RotationSpeed 0 으로 전원 OFF를 보내므로 1 이상만 처리
          if (val < 1) return;
          const idx = clamp(Math.round(val), 1, N) - 1;
          const targetMode = md.mode.values[idx];
          const prev = this.cache[md.mode.key];
          if (prev === targetMode && !this.pending[md.mode.key]) return;
          this.beginGrace(md.mode.key, targetMode);
          this.cache[md.mode.key] = targetMode;
          this.pushUpdates();
          try {
            await this.callSet(md.mode.key, targetMode, md.mode.call);
          } catch (e) {
            this.endGrace(md.mode.key);
            this.cache[md.mode.key] = prev;
            this.pushUpdates();
            throw e;
          }
        });
    }

    // CurrentRelativeHumidity
    if (md.humidity) {
      svc.getCharacteristic(Characteristic.CurrentRelativeHumidity).onGet(() =>
        clamp(Number(this.cache[md.humidity.key]) || 0, 0, 100));
    }

    // Target humidity threshold
    if (md.targetHumidity && !this.cfg.disableTargetHumidity) {
      const th = md.targetHumidity;
      svc.getCharacteristic(Characteristic.RelativeHumidityHumidifierThreshold)
        .setProps({ minValue: th.min, maxValue: th.max, minStep: 1 })
        .onSet(async (val) => {
          const v = clamp(Math.round(val), th.min, th.max);
          const prev = this.cache[th.key];
          this.beginGrace(th.key, v);
          this.cache[th.key] = v;
          this.pushUpdates();
          try {
            // switchToMode 옵션: 목표 습도 설정 시 모드를 auto/humidity 로 전환
            if (this.cfg.autoSwitchToHumidityMode && th.switchToMode) {
              const sm = th.switchToMode;
              await this.callSet(sm.key, sm.value, sm.call);
              this.beginGrace(sm.key, sm.value);
              this.cache[sm.key] = sm.value;
            }
            await this.callSet(th.key, v, th.call);
          } catch (e) {
            this.endGrace(th.key);
            this.cache[th.key] = prev;
            this.pushUpdates();
            throw e;
          }
        });
    }

    // ChildLock (LockPhysicalControls)
    if (md.childLock) {
      const cl = md.childLock;
      svc.getCharacteristic(Characteristic.LockPhysicalControls)
        .onSet(async (v) => {
          const on = (v === Characteristic.LockPhysicalControls.CONTROL_LOCK_ENABLED);
          const target = on ? cl.on : cl.off;
          const prev = this.cache[cl.key];
          this.beginGrace(cl.key, target);
          this.cache[cl.key] = target;
          this.pushUpdates();
          try {
            await this.callSet(cl.key, target, cl.call);
          } catch (e) {
            this.endGrace(cl.key);
            this.cache[cl.key] = prev;
            this.pushUpdates();
            throw e;
          }
        });
    }

    // WaterLevel
    if (md.waterLevel) {
      svc.getCharacteristic(Characteristic.WaterLevel).onGet(() => {
        const raw = this.cache[md.waterLevel.key];
        if (raw === undefined) return 0;
        return clamp(Number(md.waterLevel.mapFn(raw)) || 0, 0, 100);
      });
    }

    // SwingMode (dry)
    if (md.dry) {
      svc.getCharacteristic(Characteristic.SwingMode).onSet(async (v) => {
        const on = (v === Characteristic.SwingMode.SWING_ENABLED);
        const target = on ? md.dry.on : md.dry.off;
        const prev = this.cache[md.dry.key];
        this.beginGrace(md.dry.key, target);
        this.cache[md.dry.key] = target;
        this.pushUpdates();
        try {
          await this.callSet(md.dry.key, target, md.dry.call);
        } catch (e) {
          this.endGrace(md.dry.key);
          this.cache[md.dry.key] = prev;
          this.pushUpdates();
          throw e;
        }
      });
    }
  }

  setupOptionalServices() {
    const { Service, Characteristic } = this;
    const md = this.modelDef;

    // Buzzer Switch
    if (this.cfg.enableBuzzerSwitch && md.buzzer) {
      const name = this.cfg.buzzerSwitchName || `${this.cfg.name} Buzzer`;
      const svc = this.getOrCreateService(Service.Switch, name, 'buzzer-switch');
      svc.getCharacteristic(Characteristic.On)
        .onGet(() => this.cache[md.buzzer.key] === md.buzzer.on)
        .onSet(async (v) => {
          const target = v ? md.buzzer.on : md.buzzer.off;
          const prev = this.cache[md.buzzer.key];
          this.beginGrace(md.buzzer.key, target);
          this.cache[md.buzzer.key] = target;
          this.pushUpdates();
          try {
            await this.callSet(md.buzzer.key, target, md.buzzer.call);
          } catch (e) {
            this.endGrace(md.buzzer.key);
            this.cache[md.buzzer.key] = prev;
            this.pushUpdates();
            throw e;
          }
        });
      this.buzzerSvc = svc;
    } else {
      this.removeSubService(Service.Switch, 'buzzer-switch');
    }

    // LED bulb
    if (this.cfg.enableLedBulb && md.led) {
      const name = this.cfg.ledBulbName || `${this.cfg.name} LED`;
      const svc = this.getOrCreateService(Service.Lightbulb, name, 'led-bulb');
      const md_led = md.led;
      svc.getCharacteristic(Characteristic.On)
        .onGet(() => {
          const v = this.cache[md_led.key];
          return v !== md_led.off;
        })
        .onSet(async (v) => {
          const target = v ? md_led.on : md_led.off;
          const cur = this.cache[md_led.key];
          // 이미 켜진 LED에 brightness 변경 후 set(On=true)가 와도 brightness가 리셋되지 않도록
          // 현재값과 목표가 같다면 skip
          if (v === (cur !== md_led.off)) return;
          const prev = cur;
          this.beginGrace(md_led.key, target);
          this.cache[md_led.key] = target;
          this.pushUpdates();
          try {
            const sendVal = md_led.toString ? String(target) : target;
            await this.callSet(md_led.key, sendVal, md_led.call);
          } catch (e) {
            this.endGrace(md_led.key);
            this.cache[md_led.key] = prev;
            this.pushUpdates();
            throw e;
          }
        });

      // 3단계 이상이면 Brightness 추가
      if (Array.isArray(md_led.levels) && md_led.levels.length > 2) {
        const maxBri = md_led.levels.length - 1;
        if (!svc.testCharacteristic(Characteristic.Brightness)) svc.addCharacteristic(Characteristic.Brightness);
        svc.getCharacteristic(Characteristic.Brightness)
          .setProps({ minValue: 0, maxValue: maxBri, minStep: 1 })
          .onGet(() => {
            const v = this.cache[md_led.key];
            const idx = md_led.levels.findIndex(x => x === v);
            return idx > 0 ? idx : 0;
          })
          .onSet(async (val) => {
            const i = clamp(Math.round(val), 0, maxBri);
            const target = md_led.levels[i];
            const prev = this.cache[md_led.key];
            this.beginGrace(md_led.key, target);
            this.cache[md_led.key] = target;
            this.pushUpdates();
            try {
              const sendVal = md_led.toString ? String(target) : target;
              await this.callSet(md_led.key, sendVal, md_led.call);
            } catch (e) {
              this.endGrace(md_led.key);
              this.cache[md_led.key] = prev;
              this.pushUpdates();
              throw e;
            }
          });
      }
      this.ledSvc = svc;
    } else {
      this.removeSubService(Service.Lightbulb, 'led-bulb');
    }

    // Clean Mode Switch
    if (this.cfg.enableCleanModeSwitch && md.clean) {
      const name = this.cfg.cleanModeSwitchName || `${this.cfg.name} Clean Mode`;
      const svc = this.getOrCreateService(Service.Switch, name, 'clean-mode-switch');
      svc.getCharacteristic(Characteristic.On)
        .onGet(() => this.cache[md.clean.key] === md.clean.on)
        .onSet(async (v) => {
          const target = v ? md.clean.on : md.clean.off;
          const prev = this.cache[md.clean.key];
          this.beginGrace(md.clean.key, target);
          this.cache[md.clean.key] = target;
          this.pushUpdates();
          try {
            await this.callSet(md.clean.key, target, md.clean.call);
          } catch (e) {
            this.endGrace(md.clean.key);
            this.cache[md.clean.key] = prev;
            this.pushUpdates();
            throw e;
          }
        });
      this.cleanSvc = svc;
    } else {
      this.removeSubService(Service.Switch, 'clean-mode-switch');
    }

    // Temperature sensor
    if (this.cfg.enableTemperatureSensor && md.temperature) {
      const name = this.cfg.temperatureSensorName || `${this.cfg.name} Temperature`;
      const svc = this.getOrCreateService(Service.TemperatureSensor, name, 'temp-sensor');
      svc.getCharacteristic(Characteristic.CurrentTemperature).onGet(() => {
        const raw = this.cache[md.temperature.key];
        return clamp(Number(raw) * md.temperature.scale, -40, 100);
      });
      this.tempSvc = svc;
    } else {
      this.removeSubService(Service.TemperatureSensor, 'temp-sensor');
    }

    // External humidity sensor (별도 SensorAccessory 분리는 안 함 - 같은 액세서리 내 서비스)
    if (this.cfg.enableHumiditySensor && md.humidity) {
      const name = this.cfg.humiditySensorName || `${this.cfg.name} Humidity`;
      const svc = this.getOrCreateService(Service.HumiditySensor, name, 'humi-sensor');
      svc.getCharacteristic(Characteristic.CurrentRelativeHumidity).onGet(() =>
        clamp(Number(this.cache[md.humidity.key]) || 0, 0, 100));
      this.humSensorSvc = svc;
    } else {
      this.removeSubService(Service.HumiditySensor, 'humi-sensor');
    }
  }

  /*============================================================
   *                  CONNECT / POLL / CALL
   *============================================================*/

  async connect() {
    if (this.connecting || this.device) return;
    this.connecting = true;
    this.connectingAttempt++;
    try {
      this.logInfo(`연결 시도 ${this.connectingAttempt}... (${this.cfg.ip})`);
      this.device = await withTimeout(miio.device({ address: this.cfg.ip, token: this.cfg.token, model: this.cfg.model }), CONNECT_TIMEOUT_MS, 'connect');
      if (typeof this.device.init === 'function') { try { await withTimeout(this.device.init(), CONNECT_TIMEOUT_MS, 'init'); } catch (_) {} }
      this.logInfo(`연결 성공 (${this.cfg.model})`);
      this.connectingAttempt = 0;
      this.consecutiveFailures = 0;

      await this.safePoll();
      this.startPollLoop();
    } catch (e) {
      const delay = Math.min(CONNECT_RETRY_BASE_MS * Math.pow(2, this.connectingAttempt - 1), CONNECT_RETRY_MAX_DELAY_MS);
      this.logError(`연결 실패 (${Math.round(delay / 1000)}초 후 재시도): ${e.message || e}`);
      this.scheduleReconnect(delay);
    } finally {
      this.connecting = false;
    }
  }

  scheduleReconnect(delayMs = 5000) {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => { this.reconnectTimer = null; this.connect(); }, delayMs);
  }

  forceReconnect(reason) {
    this.logWarn(`강제 재연결: ${reason}`);
    if (this.pollTimer) { clearTimeout(this.pollTimer); this.pollTimer = null; }
    if (this.device && this.device.destroy) {
      try { this.device.destroy(); } catch (_) {}
    }
    this.device = null;
    this.consecutiveFailures = 0;
    this.connectingAttempt = 0;
    this.scheduleReconnect(1000);
  }

  startPollLoop() {
    if (this.pollTimer) clearTimeout(this.pollTimer);
    const tick = async () => {
      try { await this.poll(); }
      catch (e) { this.logDebug(`폴링 예외: ${e.message || e}`); }
      finally { this.pollTimer = setTimeout(tick, this.cfg.pollingInterval); }
    };
    this.pollTimer = setTimeout(tick, this.cfg.pollingInterval);
  }

  async safePoll() {
    try { await this.poll(); } catch (e) { this.logDebug(`안전 폴링 예외: ${e.message || e}`); }
  }

  async poll() {
    if (!this.device) {
      if (!this.connecting && !this.reconnectTimer) this.scheduleReconnect(500);
      return;
    }
    try {
      const result = (this.protocol === 'miot') ? await this.miotGetAll() : await this.miioGetAll();
      Object.assign(this.cache, result);
      this.applyGrace();
      this.pushUpdates();
      this.consecutiveFailures = 0;
    } catch (e) {
      this.consecutiveFailures++;
      this.logError(`폴링 실패 (${this.consecutiveFailures}/${POLL_FAIL_THRESHOLD}): ${e.message || e}`);
      if (this.consecutiveFailures >= POLL_FAIL_THRESHOLD) {
        this.forceReconnect(`연속 ${this.consecutiveFailures}회 폴링 실패`);
      }
    }
  }

  async miotGetAll() {
    const md = this.modelDef;
    const keys = Object.keys(md.propsMiot);
    const params = keys.map(k => ({ did: k, ...md.propsMiot[k] }));
    const res = await withTimeout(this.device.call('get_properties', params), CALL_TIMEOUT_MS, 'get_properties');
    const out = {};
    if (Array.isArray(res)) {
      for (let i = 0; i < keys.length; i++) {
        const r = res[i];
        if (r && r.code === 0 && r.value !== undefined && r.value !== null) {
          out[keys[i]] = r.value;
        }
      }
    }
    return out;
  }

  async miioGetAll() {
    const md = this.modelDef;
    const keys = md.propsMiio;
    const getCall = md.getCall || 'get_prop';
    const batch = md.propsMaxBatch || 15;

    const out = {};
    if (md.getArgsEmpty) {
      const res = await withTimeout(this.device.call(getCall, []), CALL_TIMEOUT_MS, getCall);
      if (Array.isArray(res)) {
        for (let i = 0; i < keys.length && i < res.length; i++) out[keys[i]] = res[i];
      }
    } else {
      for (let i = 0; i < keys.length; i += batch) {
        const slice = keys.slice(i, i + batch);
        const res = await withTimeout(this.device.call(getCall, slice), CALL_TIMEOUT_MS, getCall);
        if (Array.isArray(res)) {
          for (let j = 0; j < slice.length && j < res.length; j++) out[slice[j]] = res[j];
        }
      }
    }
    return out;
  }

  async callSet(propKey, value, miioCall) {
    if (!this.device) {
      await this.connect();
      if (!this.device) throw new Error('not connected');
    }
    if (this.protocol === 'miot') {
      const def = this.modelDef.propsMiot[propKey];
      if (!def) throw new Error(`miot prop ${propKey} 정의 없음`);
      const res = await withTimeout(this.device.call('set_properties', [{ did: propKey, ...def, value }]), CALL_TIMEOUT_MS, 'set_properties');
      if (Array.isArray(res)) {
        const r = res[0];
        if (!r || r.code !== 0) throw new Error(`set_properties 실패: ${JSON.stringify(r)}`);
      }
      return res;
    }
    const callName = miioCall || (this.modelDef.setCalls && this.modelDef.setCalls[propKey]);
    if (!callName) throw new Error(`miio set 함수명 모름: ${propKey}`);
    const res = await withTimeout(this.device.call(callName, [value]), CALL_TIMEOUT_MS, callName);
    // miio set 결과는 ['ok']
    if (Array.isArray(res) && res[0] !== 'ok' && res[0] !== undefined) {
      // 일부 펌웨어는 빈 배열을 반환하기도 함; 너무 엄격하지 않게 검증
      this.logDebug(`set ${propKey} 응답: ${JSON.stringify(res)}`);
    }
    return res;
  }

  /*============================================================
   *                  GRACE PERIOD
   *============================================================*/
  beginGrace(key, target) {
    this.pending[key] = { target, expire: Date.now() + COMMAND_GRACE_MS };
    this.scheduleVerifyBurst();
  }
  endGrace(key) {
    delete this.pending[key];
    if (Object.keys(this.pending).length === 0) this.clearBurst();
  }
  applyGrace() {
    const now = Date.now();
    for (const k of Object.keys(this.pending)) {
      const p = this.pending[k];
      if (!p) continue;
      if (now >= p.expire) { this.endGrace(k); continue; }
      if (this.cache[k] === p.target) this.endGrace(k);
      else this.cache[k] = p.target;
    }
  }
  scheduleVerifyBurst() {
    this.clearBurst();
    VERIFY_BURST_DELAYS.forEach(d => {
      const t = setTimeout(() => {
        if (Object.keys(this.pending).length > 0) this.safePoll();
      }, d);
      this.burstTimers.push(t);
    });
  }
  clearBurst() {
    this.burstTimers.forEach(t => clearTimeout(t));
    this.burstTimers = [];
  }

  /*============================================================
   *                  PUSH STATE TO CHARACTERISTICS
   *============================================================*/
  pushUpdates() {
    const { Characteristic } = this;
    const md = this.modelDef;
    const svc = this.humSvc;
    if (!svc) return;
    try {
      const powerOn = this.cache[md.power.key] === md.power.on;
      svc.updateCharacteristic(Characteristic.Active, powerOn ? Characteristic.Active.ACTIVE : Characteristic.Active.INACTIVE);
      svc.updateCharacteristic(Characteristic.CurrentHumidifierDehumidifierState,
        powerOn
          ? Characteristic.CurrentHumidifierDehumidifierState.HUMIDIFYING
          : Characteristic.CurrentHumidifierDehumidifierState.INACTIVE);

      if (md.mode && this.cache[md.mode.key] !== undefined) {
        const idx = md.mode.values.findIndex(x => x === this.cache[md.mode.key]);
        if (idx >= 0) {
          svc.updateCharacteristic(Characteristic.RotationSpeed, idx + 1);
        }
      }

      if (md.humidity && this.cache[md.humidity.key] !== undefined) {
        svc.updateCharacteristic(Characteristic.CurrentRelativeHumidity, clamp(Number(this.cache[md.humidity.key]) || 0, 0, 100));
      }

      if (md.targetHumidity && !this.cfg.disableTargetHumidity && this.cache[md.targetHumidity.key] !== undefined) {
        svc.updateCharacteristic(Characteristic.RelativeHumidityHumidifierThreshold,
          clamp(Number(this.cache[md.targetHumidity.key]) || md.targetHumidity.min, md.targetHumidity.min, md.targetHumidity.max));
      }

      if (md.childLock && this.cache[md.childLock.key] !== undefined) {
        svc.updateCharacteristic(Characteristic.LockPhysicalControls,
          this.cache[md.childLock.key] === md.childLock.on
            ? Characteristic.LockPhysicalControls.CONTROL_LOCK_ENABLED
            : Characteristic.LockPhysicalControls.CONTROL_LOCK_DISABLED);
      }

      if (md.waterLevel && this.cache[md.waterLevel.key] !== undefined) {
        const wl = clamp(Number(md.waterLevel.mapFn(this.cache[md.waterLevel.key])) || 0, 0, 100);
        svc.updateCharacteristic(Characteristic.WaterLevel, wl);
      }

      if (md.dry && this.cache[md.dry.key] !== undefined) {
        svc.updateCharacteristic(Characteristic.SwingMode,
          this.cache[md.dry.key] === md.dry.on
            ? Characteristic.SwingMode.SWING_ENABLED
            : Characteristic.SwingMode.SWING_DISABLED);
      }

      if (this.buzzerSvc && md.buzzer && this.cache[md.buzzer.key] !== undefined) {
        this.buzzerSvc.updateCharacteristic(Characteristic.On, this.cache[md.buzzer.key] === md.buzzer.on);
      }
      if (this.cleanSvc && md.clean && this.cache[md.clean.key] !== undefined) {
        this.cleanSvc.updateCharacteristic(Characteristic.On, this.cache[md.clean.key] === md.clean.on);
      }
      if (this.ledSvc && md.led && this.cache[md.led.key] !== undefined) {
        this.ledSvc.updateCharacteristic(Characteristic.On, this.cache[md.led.key] !== md.led.off);
        if (md.led.levels && md.led.levels.length > 2 && this.ledSvc.testCharacteristic(Characteristic.Brightness)) {
          const idx = md.led.levels.findIndex(x => x === this.cache[md.led.key]);
          this.ledSvc.updateCharacteristic(Characteristic.Brightness, idx > 0 ? idx : 0);
        }
      }
      if (this.tempSvc && md.temperature && this.cache[md.temperature.key] !== undefined) {
        this.tempSvc.updateCharacteristic(Characteristic.CurrentTemperature,
          clamp(Number(this.cache[md.temperature.key]) * md.temperature.scale, -40, 100));
      }
      if (this.humSensorSvc && md.humidity && this.cache[md.humidity.key] !== undefined) {
        this.humSensorSvc.updateCharacteristic(Characteristic.CurrentRelativeHumidity,
          clamp(Number(this.cache[md.humidity.key]) || 0, 0, 100));
      }
    } catch (e) {
      this.logDebug(`pushUpdates 예외: ${e.message}`);
    }
  }

  /*============================================================
   *                  LOG
   *============================================================*/
  logInfo(m, ...a)  { this.log.info(`[${this.cfg.name}] ${m}`, ...a); }
  logWarn(m, ...a)  { this.log.warn(`[${this.cfg.name}] ${m}`, ...a); }
  logDebug(m, ...a) { this.log.debug(`[${this.cfg.name}] ${m}`, ...a); }
  logError(m, ...a) { this.log.error(`[${this.cfg.name}] ${m}`, ...a); }
}

module.exports = HumidifierAccessory;

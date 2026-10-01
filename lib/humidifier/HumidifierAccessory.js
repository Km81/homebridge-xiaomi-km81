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
 *  - 홈킷 매핑 (v2.5.0):
 *      모드 선택   = 「가습」 고정(v2.5.2). ⛔「자동」을 여기 두지 말 것 — 홈 앱의 「자동」은 가습+제습 범위라
 *                    문턱이 둘일 때만 슬라이더를 그린다. 가습 문턱 하나뿐이면 **목표 습도 슬라이더가 사라진다**(2.5.0~2.5.1 실사용).
 *      스윙 모드   = 자동 토글(v2.5.2): 켬 = 기기 자동(습도) 모드 / 끔 = 수동 단계(마지막 단계로 복귀).
 *                    ⚠️토글 이름 「스윙 모드」는 홈 앱이 정한다. 자동 모드가 없는 모델은 토글을 내지 않는다.
 *      회전속도    = 수동 단계만(자동 값은 빠진다). 자동일 때는 0 으로 보인다
 *                    (맨 윗 단계와 구분되도록 — 특성을 그때그때 숨기는 것은 홈킷이 지원하지 않는다).
 *      목표 습도   = 눈금 0~100. 기기 범위(예: 30~80) 밖으로 끌면 하한·상한으로 되돌아간다. 0 은 끈다(v2.5.1).
 *      속도 0      = 끈다(v2.5.1).
 *      건조        = 내보내지 않는다(스윙 토글은 자동이 쓴다).
 *      잠금        = 기본으로 내보내지 않는다(enableChildLock 로 켠다).
 *      되돌림      = 잘라 보낸 값·끈 뒤의 슬라이더는 **쓰기 응답이 나간 뒤**(SNAP_BACK_MS)에 실제 값으로 되돌린다.
 *                    응답 전에 보내면 홈 앱이 자기가 쓴 값으로 덮어 손잡이가 안 돌아온다.
 *                    ⛔끌 때는 특성을 **회수**한다 — 안 그러면 캐시에 남아 홈 앱에 계속 보인다.
 */

'use strict';

const LocalMiioDevice = require('../common/LocalMiioDevice.js');
const { clamp, isFiniteNumber, sleep, withTimeout, applyServiceName, requireValidIpAndToken } = require('../common/helpers.js');
const { resolveModel, listSupportedModels } = require('./models.js');
const { isPutAway, PUT_AWAY_MESSAGE, PUT_AWAY_SEAL_EMPTY, sealForPutAway } = require('../common/putAway.js');

const DEFAULT_POLLING_MS = 30000;
const MIN_POLLING_MS = 5000;
const CONNECT_RETRY_BASE_MS = 1500;
const CONNECT_RETRY_MAX_DELAY_MS = 60000;
const COMMAND_GRACE_MS = 4000;   // set 직후 보호 구간 (전 장비 4초 통일)
const VERIFY_BURST_DELAYS = [400, 1000, 1900];
const POLL_FAIL_THRESHOLD = 3;
const CALL_TIMEOUT_MS = 8000;
const CONNECT_TIMEOUT_MS = 8000;
const SNAP_BACK_MS = 600;         // 쓰기 응답 뒤에 슬라이더를 실제 값으로 되돌리는 지연

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

    // ⛔★임시 연결해제(v2.3.0): 통신을 시작하지 않는다. lib/common/putAway.js
    if (isPutAway(config)) {
      this.logInfo(PUT_AWAY_MESSAGE);
      if (sealForPutAway(this.accessory) === 0) this.logWarn(PUT_AWAY_SEAL_EMPTY);   // ★마지막 상태를 정상 연결로 표시
      this._shutdown = true;   // 이중 잠금 — connect()·재연결·폴링이 전부 이 표식을 본다
      return;
    }
    // 비동기 연결 시작
    this.connect();
  }

  getAccessoryUUIDs() { return [this.UUID]; }

  shutdown() {
    this._shutdown = true;
    if (this.pollTimer) { clearTimeout(this.pollTimer); this.pollTimer = null; }
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    this.clearBurst();
    (this.snapTimers || []).forEach(t => clearTimeout(t));
    this.snapTimers = [];
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
      enableChildLock: !!c.enableChildLock,
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

    // 모드 값 나누기: 자동 값 하나 + 나머지(수동 단계)
    const modeValues = (md.mode && Array.isArray(md.mode.values)) ? md.mode.values : [];
    this.hasAuto = !!md.mode && md.mode.auto !== undefined && modeValues.includes(md.mode.auto);
    this.manualModes = this.hasAuto ? modeValues.filter(v => v !== md.mode.auto) : modeValues.slice();
    // 「가습」으로 돌아갈 때 쓸 마지막 수동 단계 — 재시작해도 남도록 액세서리 컨텍스트에 둔다
    const ctx = this.accessory.context || (this.accessory.context = {});
    this.lastManualMode = this.manualModes.includes(ctx.humLastManualMode) ? ctx.humLastManualMode : this.manualModes[0];

    // TargetHumidifierDehumidifierState: 「가습」 고정 — 「자동」을 두면 홈 앱이 목표 습도 슬라이더를 숨긴다(머리말).
    //   ⚠️값을 먼저 맞추고 눈금을 좁힌다(캐시에 「자동」 값 0 이 남아 있을 수 있다 — 2.5.0~2.5.1).
    const TS = Characteristic.TargetHumidifierDehumidifierState;
    const targetState = svc.getCharacteristic(TS);
    targetState.updateValue(TS.HUMIDIFIER);
    targetState.setProps({ validValues: [TS.HUMIDIFIER] });

    // Active (power)
    svc.getCharacteristic(Characteristic.Active).onSet(async (v) => {
      await this.setPower(v === Characteristic.Active.ACTIVE);
    });

    // RotationSpeed = 수동 단계 (자동 값은 여기 없다 — 모드 선택의 「자동」이 맡는다)
    if (md.mode && this.manualModes.length > 0) {
      const N = this.manualModes.length;
      svc.getCharacteristic(Characteristic.RotationSpeed)
        .setProps({ minValue: 0, maxValue: N, minStep: 1 })
        .onSet(async (val) => {
          // 0 으로 내리면 끈다(v2.5.1). 슬라이더는 한 박자 뒤 실제 단계로 되돌린다
          // (hap 이 처리기 뒤에 0 을 대입한다 — 꺼진 채 0 으로 남으면 다음에 켰을 때 단계가 거짓이 된다).
          if (val < 1) { await this.powerOffFromSlider(); return; }
          const idx = clamp(Math.round(val), 1, N) - 1;
          await this.setMode(this.manualModes[idx]);   // 단계를 고르면 자동에서 빠져나온다
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
      // ★눈금은 0~100 그대로 둔다(v2.5.1) — 최댓값을 기기 상한(80)으로 줄이면 홈 앱 슬라이더가
      //   80 을 100% 로 그려 어긋난다(2.5.0 실사용 지적). 대신 기기가 받는 th.min~th.max 로 잘라 보내고
      //   슬라이더를 그 값에 세운다: 1~하한 → 하한, 상한~100 → 상한. **0 은 끈다.**
      //   ⚠️캐시에 옛 눈금(30~80, 0~80)이 남아 있으므로 0·100 을 명시해 되돌린다.
      svc.getCharacteristic(Characteristic.RelativeHumidityHumidifierThreshold)
        .setProps({ minValue: 0, maxValue: 100, minStep: 1 })
        .onSet(async (val) => {
          if (Math.round(val) <= 0) { await this.powerOffFromSlider(); return; }
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
          // hap 은 처리기가 끝난 **뒤에** 받은 값을 그대로 대입한다 → 잘라 보낸 값(하한·상한)은
          // 쓰기 응답이 나간 뒤에 다시 반영해야 슬라이더가 실제 값에 선다.
          this.snapBack();
        });
    }

    // ChildLock (LockPhysicalControls) — 켰을 때만. 끄면 회수한다.
    if (md.childLock && this.cfg.enableChildLock) {
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
    } else {
      this.dropCharacteristic(svc, Characteristic.LockPhysicalControls);
    }

    // WaterLevel
    if (md.waterLevel) {
      svc.getCharacteristic(Characteristic.WaterLevel).onGet(() => {
        const raw = this.cache[md.waterLevel.key];
        if (raw === undefined) return 0;
        return clamp(Number(md.waterLevel.mapFn(raw)) || 0, 0, 100);
      });
    }

    // SwingMode = 자동 토글 (v2.5.2). 자동 모드가 없는 모델은 내지 않고, 캐시에 남은 것은 회수한다.
    this.autoSwing = this.hasAuto && this.manualModes.length > 0;
    if (this.autoSwing) {
      svc.getCharacteristic(Characteristic.SwingMode).onSet(async (v) => {
        if (v === Characteristic.SwingMode.SWING_ENABLED) { await this.setMode(md.mode.auto); return; }
        // 끔 — 이미 수동이면 단계를 건드리지 않는다
        const cur = this.cache[md.mode.key];
        if (this.manualModes.includes(cur) && !this.pending[md.mode.key]) return;
        await this.setMode(this.lastManualMode);
      });
    } else {
      this.dropCharacteristic(svc, Characteristic.SwingMode);
    }
  }

  /**
   * 선택 특성을 서비스에서 걷어낸다 — 옵션을 끄거나 기본값이 바뀌었을 때 캐시에 남은 것을 회수.
   * ⚠️`getCharacteristic` 은 선택 특성을 **없으면 만들어** 돌려주므로 먼저 `testCharacteristic` 으로 본다.
   */
  dropCharacteristic(svc, CharClass) {
    if (svc.testCharacteristic(CharClass)) svc.removeCharacteristic(svc.getCharacteristic(CharClass));
  }

  /** 전원을 기기에 쓴다(낙관 반영 + 실패 시 되돌림). */
  async setPower(wantOn) {
    const md = this.modelDef;
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
  }

  /**
   * 슬라이더(속도·목표 습도)를 0 으로 내렸을 때 — 끈다.
   * ⛔방금 「켜기」를 보낸 직후면 끄지 않는다: 자동일 때 속도는 0 으로 보이는데, 홈 앱이 켜면서
   *   그 0 을 함께 써 보내면 켜자마자 꺼진다. 켜기 유예(grace) 중의 0 은 표시값이 되돌아온 것으로 본다.
   */
  async powerOffFromSlider() {
    const md = this.modelDef;
    const p = this.pending[md.power.key];
    const turningOn = !!p && p.target === md.power.on;
    try {
      if (!turningOn) await this.setPower(false);
    } finally {
      this.snapBack();   // 슬라이더를 실제 값(단계·목표 습도)으로 되돌린다
    }
  }

  /**
   * 슬라이더를 실제 값으로 되돌린다 — **쓰기 응답이 나간 뒤에.**
   * ⛔`setImmediate` 로 바로 보내면 안 된다(2.5.1): 되돌림 알림이 쓰기 응답보다 먼저 나가
   *   홈 앱이 자기가 쓴 값으로 덮는다 → 손잡이는 100 에 남고 타일만 80 으로 보인다.
   */
  snapBack() {
    const base = this.snapBackMs === undefined ? SNAP_BACK_MS : this.snapBackMs;
    const later = (ms, fn) => {
      const t = setTimeout(() => {
        this.snapTimers = (this.snapTimers || []).filter(x => x !== t);
        if (!this._shutdown) { try { fn(); } catch (e) { this.logDebug(`되돌림 예외: ${e.message}`); } }
      }, ms);
      (this.snapTimers || (this.snapTimers = [])).push(t);
    };
    later(base, () => this.pushUpdates());
    // 한 번 더 — 값이 이미 같으면 hap 은 알림을 안 보낸다. 홈 앱이 첫 알림을 놓쳤을 때를 위해
    // 슬라이더 두 개(속도·목표 습도)는 현재 값을 **강제로** 다시 알린다.
    later(base * 3, () => {
      this.pushUpdates();
      const { Characteristic } = this;
      for (const C of [Characteristic.RotationSpeed, Characteristic.RelativeHumidityHumidifierThreshold]) {
        if (!this.humSvc || !this.humSvc.testCharacteristic(C)) continue;
        const ch = this.humSvc.getCharacteristic(C);
        if (typeof ch.sendEventNotification === 'function' && ch.value !== null && ch.value !== undefined) ch.sendEventNotification(ch.value);
      }
    });
  }

  /** 모드 값을 기기에 쓴다(낙관 반영 + 실패 시 되돌림). 수동 단계면 「마지막 수동 단계」로 기억한다. */
  async setMode(targetMode) {
    const md = this.modelDef;
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
  }

  /** 수동 단계가 보이면 기억해 둔다 — 「자동 → 가습」으로 돌아올 때 그 단계로 간다. */
  rememberManualMode(v) {
    if (!this.manualModes || !this.manualModes.includes(v) || this.lastManualMode === v) return;
    this.lastManualMode = v;
    if (this.accessory && this.accessory.context) this.accessory.context.humLastManualMode = v;
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
    if (this._shutdown || this.connecting || this.device) return;
    this.connecting = true;
    this.connectingAttempt++;
    try {
      this.logInfo(`연결 시도 ${this.connectingAttempt}... (${this.cfg.ip})`);
      const device = await withTimeout(new LocalMiioDevice(this.cfg.ip, this.cfg.token, null, this.cfg.model, this.log).connect(), CONNECT_TIMEOUT_MS, 'connect');
      // 연결 대기 중 shutdown 이 발생했다면 방금 만든 살아있는 연결을 파기하고 빠져나간다
      // (그대로 두면 소켓이 누수되고 폴링이 부활할 수 있다).
      if (this._shutdown) { try { device.destroy(); } catch (_) {} return; }
      this.device = device;
      if (typeof this.device.init === 'function') { try { await withTimeout(this.device.init(), CONNECT_TIMEOUT_MS, 'init'); } catch (_) {} }
      if (this._shutdown) { try { this.device.destroy(); } catch (_) {} this.device = null; return; }
      this.logInfo(`연결됨 (${this.cfg.model})`);
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
    this.reconnectTimer = setTimeout(() => { this.reconnectTimer = null; if (this._shutdown) return; this.connect(); }, delayMs);
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
    if (this._shutdown) return;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    const tick = async () => {
      try { await this.poll(); }
      catch (e) { this.logDebug(`폴링 예외: ${e.message || e}`); }
      finally { if (!this._shutdown) this.pollTimer = setTimeout(tick, this.cfg.pollingInterval); }
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
      // 실패 로그가 찍힌 뒤 첫 성공 — 복구를 명시 (v2.0.0)
      if (this.consecutiveFailures > 0) this.logInfo(`폴링 복구 — ${this.consecutiveFailures}회 실패 후 정상화`);
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

      if (md.mode && this.cache[md.mode.key] !== undefined && this.manualModes.length > 0) {
        const mode = this.cache[md.mode.key];
        const isAuto = this.hasAuto && mode === md.mode.auto;
        const idx = this.manualModes.findIndex(x => x === mode);
        if (this.autoSwing && (isAuto || idx >= 0)) {
          svc.updateCharacteristic(Characteristic.SwingMode,
            isAuto ? Characteristic.SwingMode.SWING_ENABLED : Characteristic.SwingMode.SWING_DISABLED);
        }
        // 자동이면 0 — 맨 윗 단계(100%)와 구분된다. 수동이면 그 단계.
        if (isAuto) svc.updateCharacteristic(Characteristic.RotationSpeed, 0);
        else if (idx >= 0) {
          svc.updateCharacteristic(Characteristic.RotationSpeed, idx + 1);
          this.rememberManualMode(mode);
        }
      }

      if (md.humidity && this.cache[md.humidity.key] !== undefined) {
        svc.updateCharacteristic(Characteristic.CurrentRelativeHumidity, clamp(Number(this.cache[md.humidity.key]) || 0, 0, 100));
      }

      if (md.targetHumidity && !this.cfg.disableTargetHumidity && this.cache[md.targetHumidity.key] !== undefined) {
        svc.updateCharacteristic(Characteristic.RelativeHumidityHumidifierThreshold,
          clamp(Number(this.cache[md.targetHumidity.key]) || md.targetHumidity.min, md.targetHumidity.min, md.targetHumidity.max));
      }

      // ⛔옵션이 꺼져 있으면 건드리지 않는다 — updateCharacteristic 이 회수한 특성을 되살린다.
      if (md.childLock && this.cfg.enableChildLock && this.cache[md.childLock.key] !== undefined) {
        svc.updateCharacteristic(Characteristic.LockPhysicalControls,
          this.cache[md.childLock.key] === md.childLock.on
            ? Characteristic.LockPhysicalControls.CONTROL_LOCK_ENABLED
            : Characteristic.LockPhysicalControls.CONTROL_LOCK_DISABLED);
      }

      if (md.waterLevel && this.cache[md.waterLevel.key] !== undefined) {
        const wl = clamp(Number(md.waterLevel.mapFn(this.cache[md.waterLevel.key])) || 0, 0, 100);
        svc.updateCharacteristic(Characteristic.WaterLevel, wl);
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

/**
 * FanAccessory
 *
 * 통합 플랫폼(homebridge-xiaomi-km81)에서 단일 Xiaomi 선풍기 액세서리를
 * 관리하는 래퍼 클래스. 기존 homebridge-xiaomi-fan-km81 의 xiaomiFanDevice
 * 클래스를 거의 그대로 가져왔으며, Service/Characteristic/Homebridge 등
 * 전역 참조 대신 ctx 객체를 통해 주입받도록 적응시켰다.
 *
 * 핵심 개선점 (오리지널 fork 기준):
 *  - getOrCreateService 패턴 → 사용자 ConfiguredName 보존
 *  - 캐시 액세서리 재사용 (Dynamic platform pattern)
 *  - LockPhysicalControls 레거시 제거
 *  - 자연풍 모드 토글: RotationDirection 재활용
 *  - setPowerOn 시 refreshDelay 1000ms → 전원 ON 직후 OFF 깜빡임 방지
 *  - 액세서리 즉시 등록: 디바이스 연결 전에도 HomeKit 에서 액세서리가 보이도록
 *    constructor 에서 registerPlatformAccessories 를 호출. fanDevice ready 시
 *    실제 서비스(Fanv2/Switch/Sensor) 들을 추가.
 */

'use strict';

const fs = require('fs');
const FanController = require('./FanController.js');
const Events = require('./Events.js');

const BATTERY_LOW_THRESHOLD = 20;
const BUTTON_RESET_TIMEOUT = 20;
const FAN_PLATFORM_SUBKEY = 'xiaomifan';
// 전원 set 직후 보호 구간(ms). 끄기/켜기 직후 폴링이 아직 전이가 끝나지 않은
// stale 값을 읽어 Active 가 잠깐 반대로 깜빡이는 것을 막는다.
const POWER_GRACE_MS = 5000;

class FanAccessory {
  /**
   * 캐시 매칭에 쓰일 UUID를 계산한다 (등록 전 미리 확인용).
   */
  static computeUUID(hap, config) {
    if (!config || !config.ip || !config.token) return null;
    return hap.uuid.generate(config.token + config.ip + FAN_PLATFORM_SUBKEY);
  }

  /**
   * ctx = { api, log, hap, PLUGIN_NAME, PLATFORM_NAME, accessories, packageVersion }
   * config = single fan config
   */
  constructor(ctx, config) {
    this.ctx = ctx;
    this.api = ctx.api;
    this.log = ctx.log;
    this.hap = ctx.hap;
    this.Service = this.hap.Service;
    this.Characteristic = this.hap.Characteristic;
    this.PLUGIN_NAME = ctx.PLUGIN_NAME;
    this.PLATFORM_NAME = ctx.PLATFORM_NAME;
    this.PLUGIN_VERSION = ctx.packageVersion;
    this.config = config;

    if (!config.ip) throw new Error(`Fan '${config.name || '(unnamed)'}': ip가 필요합니다`);
    if (!config.token) throw new Error(`Fan '${config.name || '(unnamed)'}': token이 필요합니다`);

    this.name = config.name || 'Xiaomi Fan';
    this.ip = config.ip;
    this.token = config.token;
    this.deviceId = config.deviceId;
    this.model = config.model;
    this.pollingInterval = ((config.pollingInterval && Number(config.pollingInterval)) || 5) * 1000;
    this.prefsDir = (config.prefsDir || (this.api.user.storagePath() + '/.xiaomiFan/'));
    this.deepDebugLog = config.deepDebugLog === true;
    this.buzzerControl     = config.buzzerControl !== false;
    this.ledControl        = config.ledControl !== false;
    this.naturalModeControl = config.naturalModeControl !== false;
    this.sleepModeControl  = config.sleepModeControl !== false;
    this.moveControl       = config.moveControl === true;
    this.fanLevelControl   = config.fanLevelControl !== false;
    this.shutdownTimer     = config.shutdownTimer === true;
    this.ioniserControl    = config.ioniserControl === true;
    this.angleButtons          = config.angleButtons;
    this.verticalAngleButtons  = config.verticalAngleButtons;
    this.angleLightbulb        = config.angleLightbulb === true;
    this.angleLightbulbLevels  = config.angleLightbulbLevels;

    if (!this.prefsDir.endsWith('/')) this.prefsDir += '/';
    if (!fs.existsSync(this.prefsDir)) {
      try { fs.mkdirSync(this.prefsDir, { recursive: true }); } catch (e) { /* ignore */ }
    }

    this.fanInfoFile = this.prefsDir + 'info_' + this.ip.split('.').join('') + '_' + this.token;

    this.fanDevice = undefined;
    this.cachedFanInfo = {};
    this.rotationSpeedTimeout = null;
    this.angleLightbulbTimeout = null;
    this.powerGrace = null;

    // UUID 계산
    this.UUID = FanAccessory.computeUUID(this.hap, config);

    // 캐시 정보 로드 (model fallback 용)
    this.loadFanInfo();

    // 액세서리는 즉시 등록 (다른 카테고리 - airPurifier / humidifier / powerStrip / airMonitor - 와 동일한 패턴).
    // 디바이스 연결이 늦거나 실패해도 HomeKit 에서 일단 보이도록 한다. fanDevice 가 준비되면
    // FAN_DEVICE_READY 핸들러에서 실제 Fanv2 / Switch / Sensor 서비스들을 추가한다.
    this.fanAccesory = this.ctx.accessories.get(this.UUID) || null;
    if (this.fanAccesory) {
      this.logDebug(`캐시 액세서리 재사용: ${this.fanAccesory.displayName}`);
    } else {
      this.fanAccesory = new this.api.platformAccessory(this.name, this.UUID, this.hap.Categories.FAN);
      this.api.registerPlatformAccessories(this.PLUGIN_NAME, this.PLATFORM_NAME, [this.fanAccesory]);
      this.ctx.accessories.set(this.UUID, this.fanAccesory);
      this.logInfo(`새 액세서리 등록: ${this.name}`);
    }

    // 연결 전에도 HomeKit 에서 디바이스가 보이도록 AccessoryInformation 을 즉시 채움.
    this.ensureBaseInformationService();

    this.discoverFan();
  }

  ensureBaseInformationService() {
    try {
      const { Service, Characteristic } = this;
      let info = this.fanAccesory.getService(Service.AccessoryInformation);
      if (!info) info = this.fanAccesory.addService(Service.AccessoryInformation);
      info.setCharacteristic(Characteristic.Manufacturer, 'Xiaomi')
        .setCharacteristic(Characteristic.Model, this.model || (this.cachedFanInfo && this.cachedFanInfo.model) || 'Xiaomi Fan')
        .setCharacteristic(Characteristic.SerialNumber, (this.cachedFanInfo && this.cachedFanInfo.deviceId) || this.ip)
        .setCharacteristic(Characteristic.FirmwareRevision, this.PLUGIN_VERSION);
    } catch (e) {
      this.logDebug(`ensureBaseInformationService 오류: ${e.message || e}`);
    }
  }

  getAccessoryUUIDs() {
    return [this.UUID];
  }

  shutdown() {
    if (this.fanController) {
      try { this.fanController.shutdown(); } catch (_) {}
    }
  }

  /*----------========== SETUP ==========----------*/

  discoverFan() {
    this.fanController = new FanController(
      this.ip, this.token, this.deviceId,
      this.model || this.cachedFanInfo.model,
      this.name, this.pollingInterval, this.log
    );
    this.fanController.setDeepDebugLogEnabled(this.deepDebugLog);

    this.fanController.on(Events.FAN_DEVICE_READY, (fanDevice) => {
      this.fanDevice = fanDevice;
      if (this.servicesInitialized || !this.fanAccesory) return;
      try {
        this.setupAccessoryServices();
        this.servicesInitialized = true;
        this.logDebug('Fan 서비스 설정 완료');
      } catch (e) {
        this.logError(`Fan 서비스 설정 실패: ${e.message || e}`);
        if (e.stack) this.logDebug(e.stack);
      }
    });

    this.fanController.on(Events.FAN_CONNECTED, () => {
      this.updateInformationService();
      this.saveFanInfo();
    });

    this.fanController.on(Events.FAN_DISCONNECTED, () => this.updateFanStatus());
    this.fanController.on(Events.FAN_PROPERTIES_UPDATED, () => this.updateFanStatus());

    this.fanController.connectToFan();
  }

  /*----------========== SETUP SERVICES ==========----------*/

  getOrCreateService(ServiceClass, displayName, subType) {
    const { Characteristic } = this;
    let service = this.fanAccesory.getServiceById(ServiceClass, subType);
    if (!service) {
      service = new ServiceClass(displayName, subType);
      this.fanAccesory.addService(service);
    }
    service.setCharacteristic(Characteristic.Name, displayName);
    if (!service.testCharacteristic(Characteristic.ConfiguredName)) {
      service.addCharacteristic(Characteristic.ConfiguredName);
      service.setCharacteristic(Characteristic.ConfiguredName, displayName);
    }
    return service;
  }

  setupAccessoryServices() {
    this.updateInformationService();
    this.prepareFanService();
    this.prepareMoveControlService();
    this.prepareBuzzerControlService();
    this.prepareLedControlService();
    this.prepareNaturalModeControlService();
    this.prepareShutdownTimerService();
    this.prepareAngleButtonsService();
    this.prepareAngleLightbulbService();
    this.prepareVerticalAngleButtonsService();
    this.prepareFanLevelControlService();
    this.prepareSleepModeControlService();
    this.prepareIoniserControlService();
    this.prepareTemperatureService();
    this.prepareRelativeHumidityService();
    this.prepareBatteryService();
  }

  updateInformationService() {
    const { Service, Characteristic } = this;
    let infoService = this.fanAccesory.getService(Service.AccessoryInformation);
    if (!infoService) infoService = this.fanAccesory.addService(Service.AccessoryInformation);
    const fanModel = (this.fanDevice && this.fanDevice.getFanModel()) || this.cachedFanInfo.model || 'Unknown';
    const fanDeviceId = (this.fanDevice && this.fanDevice.getDeviceId()) || 'Unknown';
    infoService
      .setCharacteristic(Characteristic.Manufacturer, 'Xiaomi')
      .setCharacteristic(Characteristic.Model, fanModel)
      .setCharacteristic(Characteristic.SerialNumber, fanDeviceId)
      .setCharacteristic(Characteristic.FirmwareRevision, this.PLUGIN_VERSION);
    this.informationService = infoService;
  }

  prepareFanService() {
    const { Service, Characteristic } = this;
    this.fanService = this.getOrCreateService(Service.Fanv2, this.name, 'fanService');

    if (this.fanService.testCharacteristic(Characteristic.LockPhysicalControls)) {
      const lockChar = this.fanService.getCharacteristic(Characteristic.LockPhysicalControls);
      this.fanService.removeCharacteristic(lockChar);
      this.logDebug('레거시 LockPhysicalControls characteristic 제거됨');
    }

    this.fanService.getCharacteristic(Characteristic.Active)
      .onGet(this.getPowerState.bind(this))
      .onSet(this.setPowerState.bind(this));

    if (!this.fanService.testCharacteristic(Characteristic.CurrentFanState)) {
      this.fanService.addCharacteristic(Characteristic.CurrentFanState);
    }
    this.fanService.getCharacteristic(Characteristic.CurrentFanState).onGet(this.getFanState.bind(this));

    if (this.fanDevice.supportsFanSpeed()) {
      if (!this.fanService.testCharacteristic(Characteristic.RotationSpeed)) {
        this.fanService.addCharacteristic(Characteristic.RotationSpeed);
      }
      this.fanService.getCharacteristic(Characteristic.RotationSpeed)
        .onGet(this.getRotationSpeed.bind(this))
        .onSet(this.setRotationSpeed.bind(this));
    }

    if (!this.fanService.testCharacteristic(Characteristic.SwingMode)) {
      this.fanService.addCharacteristic(Characteristic.SwingMode);
    }
    this.fanService.getCharacteristic(Characteristic.SwingMode)
      .onGet(this.getSwingMode.bind(this))
      .onSet(this.setSwingMode.bind(this));

    // RotationDirection을 자연풍 모드 토글로 재활용
    if (this.fanDevice.supportsNaturalMode()) {
      if (!this.fanService.testCharacteristic(Characteristic.RotationDirection)) {
        this.fanService.addCharacteristic(Characteristic.RotationDirection);
      }
      this.fanService.getCharacteristic(Characteristic.RotationDirection)
        .onGet(this.getRotationDirection.bind(this))
        .onSet(this.setRotationDirection.bind(this));
    }
  }

  prepareMoveControlService() {
    const { Service, Characteristic } = this;
    if (this.moveControl && this.fanDevice.supportsLeftRightMove()) {
      this.moveLeftService = this.getOrCreateService(Service.Switch, 'Move left', 'moveLeftService');
      this.moveLeftService.getCharacteristic(Characteristic.On)
        .onGet(this.getMoveFanSwitch.bind(this))
        .onSet((s) => this.setMoveFanSwitch(s, 'left'));
      this.moveRightService = this.getOrCreateService(Service.Switch, 'Move right', 'moveRightService');
      this.moveRightService.getCharacteristic(Characteristic.On)
        .onGet(this.getMoveFanSwitch.bind(this))
        .onSet((s) => this.setMoveFanSwitch(s, 'right'));
    }
    if (this.moveControl && this.fanDevice.supportsUpDownMove()) {
      this.moveUpService = this.getOrCreateService(Service.Switch, 'Move Up', 'moveUpService');
      this.moveUpService.getCharacteristic(Characteristic.On)
        .onGet(this.getMoveFanSwitch.bind(this))
        .onSet((s) => this.setMoveFanSwitch(s, 'up'));
      this.moveDownService = this.getOrCreateService(Service.Switch, 'Move down', 'moveDownService');
      this.moveDownService.getCharacteristic(Characteristic.On)
        .onGet(this.getMoveFanSwitch.bind(this))
        .onSet((s) => this.setMoveFanSwitch(s, 'down'));
    }
  }

  prepareBuzzerControlService() {
    const { Service, Characteristic } = this;
    if (this.buzzerControl && this.fanDevice.supportsBuzzerControl()) {
      this.buzzerService = this.getOrCreateService(Service.Switch, 'Buzzer', 'buzzerService');
      this.buzzerService.getCharacteristic(Characteristic.On)
        .onGet(this.getBuzzer.bind(this))
        .onSet(this.setBuzzer.bind(this));
    }
  }

  prepareLedControlService() {
    const { Service, Characteristic } = this;
    if (this.ledControl && this.fanDevice.supportsLedControl()) {
      if (this.fanDevice.supportsLedBrightness()) {
        this.ledBrightnessService = this.getOrCreateService(Service.Lightbulb, 'LED', 'ledBrightnessService');
        this.ledBrightnessService.getCharacteristic(Characteristic.On)
          .onGet(this.getLed.bind(this)).onSet(this.setLed.bind(this));
        if (!this.ledBrightnessService.testCharacteristic(Characteristic.Brightness)) {
          this.ledBrightnessService.addCharacteristic(Characteristic.Brightness);
        }
        this.ledBrightnessService.getCharacteristic(Characteristic.Brightness)
          .onGet(this.getLedBrightness.bind(this)).onSet(this.setLedBrightness.bind(this));
      } else {
        this.ledService = this.getOrCreateService(Service.Switch, 'LED', 'ledService');
        this.ledService.getCharacteristic(Characteristic.On)
          .onGet(this.getLed.bind(this)).onSet(this.setLed.bind(this));
      }
    }
  }

  prepareNaturalModeControlService() {
    const { Service, Characteristic } = this;
    if (this.naturalModeControl && this.fanDevice.supportsNaturalMode()) {
      this.naturalModeControlService = this.getOrCreateService(Service.Switch, 'Natural mode', 'naturalModeControlService');
      this.naturalModeControlService.getCharacteristic(Characteristic.On)
        .onGet(this.getNaturalMode.bind(this)).onSet(this.setNaturalMode.bind(this));
    }
  }

  prepareSleepModeControlService() {
    const { Service, Characteristic } = this;
    if (this.sleepModeControl && this.fanDevice.supportsSleepMode()) {
      this.sleepModeControlService = this.getOrCreateService(Service.Switch, 'Sleep mode', 'sleepModeControlService');
      this.sleepModeControlService.getCharacteristic(Characteristic.On)
        .onGet(this.getSleepMode.bind(this)).onSet(this.setSleepMode.bind(this));
    }
  }

  prepareShutdownTimerService() {
    const { Service, Characteristic } = this;
    if (this.shutdownTimer && this.fanDevice.supportsPowerOffTimer()) {
      this.shutdownTimerService = this.getOrCreateService(Service.Lightbulb, 'Shutdown timer', 'shutdownTimerService');
      this.shutdownTimerService.getCharacteristic(Characteristic.On)
        .onGet(this.getShutdownTimerEnabled.bind(this)).onSet(this.setShutdownTimerEnabled.bind(this));
      if (!this.shutdownTimerService.testCharacteristic(Characteristic.Brightness)) {
        this.shutdownTimerService.addCharacteristic(Characteristic.Brightness);
      }
      this.shutdownTimerService.getCharacteristic(Characteristic.Brightness)
        .onGet(this.getShutdownTimer.bind(this)).onSet(this.setShutdownTimer.bind(this));
    }
  }

  prepareAngleButtonsService() {
    const { Service, Characteristic } = this;
    if (this.fanDevice.supportsOscillationAngle() === false && this.fanDevice.supportsOscillationLevels() === false) return;
    if (this.angleButtons === false) return;
    if (this.angleButtons === undefined || this.angleButtons === null) {
      if (this.fanDevice.supportsOscillationLevels()) this.angleButtons = this.fanDevice.oscillationLevels();
      else return;
    }
    if (!Array.isArray(this.angleButtons)) {
      this.logWarn('angleButtons는 배열이어야 합니다.');
      return;
    }

    this.angleButtonsService = [];
    this.angleButtons.forEach((value, i) => {
      const parsedValue = parseInt(value);
      if (this.checkAngleButtonValue(parsedValue) === false) return;
      this.angleButtons[i] = parsedValue;
      const angleName = 'Angle - ' + parsedValue;
      const btn = this.getOrCreateService(Service.Switch, angleName, 'angleButtonService' + i);
      btn.getCharacteristic(Characteristic.On)
        .onGet(() => this.getAngleButtonState(parsedValue))
        .onSet((s) => this.setAngleButtonState(s, parsedValue));
      this.angleButtonsService.push(btn);
    });
  }

  prepareAngleLightbulbService() {
    const { Service, Characteristic } = this;
    if (this.fanDevice.supportsOscillationAngle() === false && this.fanDevice.supportsOscillationLevels() === false) return;
    if (this.angleLightbulb !== true) return;

    // 사용할 각도 단계 결정: config 지정값 우선, 없으면 모델 기본값
    let levels = this.angleLightbulbLevels;
    if (Array.isArray(levels) && levels.length > 0) {
      levels = Array.from(new Set(levels.map(v => parseInt(v)).filter(v => !isNaN(v) && v > 0))).sort((a, b) => a - b);
    } else {
      levels = this.fanDevice.oscillationLightbulbLevels();
    }
    if (!Array.isArray(levels) || levels.length === 0) {
      this.logWarn('회전 각도 전구를 사용할 수 없습니다. 지원 각도 단계를 찾지 못했습니다. angleLightbulbLevels 를 직접 지정해 보세요.');
      return;
    }
    this.angleLightbulbLevelsResolved = levels;
    this.logDebug(`회전 각도 전구 활성화 - 사용 각도 단계: ${JSON.stringify(levels)}`);

    this.angleLightbulbService = this.getOrCreateService(Service.Lightbulb, 'Angle', 'angleLightbulbService');
    this.angleLightbulbService.getCharacteristic(Characteristic.On)
      .onGet(this.getAngleLightbulbOn.bind(this))
      .onSet(this.setAngleLightbulbOn.bind(this));
    if (!this.angleLightbulbService.testCharacteristic(Characteristic.Brightness)) {
      this.angleLightbulbService.addCharacteristic(Characteristic.Brightness);
    }
    this.angleLightbulbService.getCharacteristic(Characteristic.Brightness)
      .onGet(this.getAngleLightbulbBrightness.bind(this))
      .onSet(this.setAngleLightbulbBrightness.bind(this));
  }

  async getAngleLightbulbOn() {
    if (this.fanDevice && this.fanDevice.isFanConnected()) {
      return this.fanDevice.isPowerOn() && this.fanDevice.isSwingModeEnabled();
    }
    return false;
  }

  async setAngleLightbulbOn(state) {
    if (this.fanDevice && this.fanDevice.isFanConnected()) {
      // 전구 On/Off = 회전(스윙) On/Off
      this.fanDevice.setSwingModeEnabled(!!state);
      this.updateAngleButtonsAndSwingMode(null, !!state);
    } else {
      throw new this.hap.HapStatusError(this.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

  async getAngleLightbulbBrightness() {
    if (this.fanDevice && this.fanDevice.isFanConnected()) {
      return this.angleToLightbulbBrightness(this.fanDevice.getAngle());
    }
    return 0;
  }

  async setAngleLightbulbBrightness(value) {
    if (this.fanDevice && this.fanDevice.isFanConnected()) {
      // HomeKit이 On=true 직후 Brightness=0 을 보내는 경우가 있어 0은 무시
      if (value <= 0) return;
      // 슬라이더를 드래그하는 동안 onSet 이 연속 발화해 setAngle 이 여러 번 전송되면
      // 기기에서 비프음이 여러 번 난다. 풍속 슬라이더(setRotationSpeed)와 동일하게
      // 디바운스하여, 손을 뗀 뒤(마지막 값)에 한 번만 전송한다.
      if (this.angleLightbulbTimeout) clearTimeout(this.angleLightbulbTimeout);
      this.angleLightbulbTimeout = setTimeout(() => {
        if (this.fanDevice.isSwingModeEnabled() === false) this.fanDevice.setSwingModeEnabled(true);
        const targetAngle = this.lightbulbBrightnessToAngle(value);
        this.fanDevice.setAngle(targetAngle);
        this.updateAngleButtonsAndSwingMode(targetAngle, true);
      }, 500);
    } else {
      throw new this.hap.HapStatusError(this.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

  // 밝기(1~100) -> 각도 단계. 각도값 자체를 구간 경계로 사용한다.
  //   예) 단계 [30,60,90,150]: 1~30->30, 31~60->60, 61~90->90, 91~100->150
  lightbulbBrightnessToAngle(brightness) {
    const levels = this.angleLightbulbLevelsResolved;
    if (!Array.isArray(levels) || levels.length === 0) return brightness;
    for (let i = 0; i < levels.length; i++) {
      if (i === levels.length - 1) return levels[i];
      if (brightness <= levels[i]) return levels[i];
    }
    return levels[levels.length - 1];
  }

  // 실제 각도 -> 밝기 표시값 (0~100). 100° 초과(120/150)는 100%로 표시.
  angleToLightbulbBrightness(angle) {
    if (angle === undefined || angle === null || isNaN(angle)) return 0;
    if (angle < 0) angle = 0;
    if (angle > 100) angle = 100;
    return angle;
  }

  prepareVerticalAngleButtonsService() {
    const { Service, Characteristic } = this;
    if (this.fanDevice.supportsVerticalOscillationAngle() === false && this.fanDevice.supportsOscillationVerticalLevels() === false) return;
    if (this.verticalAngleButtons === false) return;
    if (this.verticalAngleButtons === undefined || this.verticalAngleButtons === null) {
      if (this.fanDevice.supportsOscillationVerticalLevels()) this.verticalAngleButtons = this.fanDevice.oscillationVerticalLevels();
      else return;
    }
    if (!Array.isArray(this.verticalAngleButtons)) {
      this.logWarn('verticalAngleButtons는 배열이어야 합니다.');
      return;
    }
    this.verticalAngleButtonsService = [];
    this.verticalAngleButtons.forEach((value, i) => {
      const parsedValue = parseInt(value);
      if (this.checkVerticalAngleButtonValue(parsedValue) === false) return;
      this.verticalAngleButtons[i] = parsedValue;
      const vAngleName = 'Vertical Angle - ' + parsedValue;
      const btn = this.getOrCreateService(Service.Switch, vAngleName, 'verticalAngleButtonService' + i);
      btn.getCharacteristic(Characteristic.On)
        .onGet(() => this.getVerticalAngleButtonState(parsedValue))
        .onSet((s) => this.setVerticalAngleButtonState(s, parsedValue));
      this.verticalAngleButtonsService.push(btn);
    });
  }

  prepareFanLevelControlService() {
    const { Service, Characteristic } = this;
    if (this.fanLevelControl && this.fanDevice.supportsFanLevel()) {
      this.fanLevelControlService = [];
      for (let i = 1; i <= this.fanDevice.numberOfFanLevels(); i++) {
        const levelName = 'Level ' + i;
        const btn = this.getOrCreateService(Service.Switch, levelName, 'levelControlService' + i);
        btn.getCharacteristic(Characteristic.On)
          .onGet(() => this.getFanLevelState(i))
          .onSet((s) => this.setFanLevelState(s, i));
        this.fanLevelControlService.push(btn);
      }
    }
  }

  prepareIoniserControlService() {
    const { Service, Characteristic } = this;
    if (this.ioniserControl && this.fanDevice.supportsIoniser()) {
      this.ioniserControlService = this.getOrCreateService(Service.Switch, 'Ioniser', 'ioniserControlService');
      this.ioniserControlService.getCharacteristic(Characteristic.On)
        .onGet(this.getIoniserState.bind(this)).onSet(this.setIoniserState.bind(this));
    }
  }

  prepareTemperatureService() {
    const { Service, Characteristic } = this;
    if (this.fanDevice.supportsTemperatureReporting()) {
      this.temperatureService = this.getOrCreateService(Service.TemperatureSensor, 'Temp', 'temperatureService');
      this.temperatureService
        .setCharacteristic(Characteristic.StatusFault, Characteristic.StatusFault.NO_FAULT)
        .setCharacteristic(Characteristic.StatusTampered, Characteristic.StatusTampered.NOT_TAMPERED)
        .setCharacteristic(Characteristic.StatusLowBattery, Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL);
      this.temperatureService.getCharacteristic(Characteristic.CurrentTemperature)
        .onGet(this.getCurrentTemperature.bind(this));
    }
  }

  prepareRelativeHumidityService() {
    const { Service, Characteristic } = this;
    if (this.fanDevice.supportsRelativeHumidityReporting()) {
      this.relativeHumidityService = this.getOrCreateService(Service.HumiditySensor, 'Humidity', 'relativeHumidityService');
      this.relativeHumidityService
        .setCharacteristic(Characteristic.StatusFault, Characteristic.StatusFault.NO_FAULT)
        .setCharacteristic(Characteristic.StatusTampered, Characteristic.StatusTampered.NOT_TAMPERED)
        .setCharacteristic(Characteristic.StatusLowBattery, Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL);
      this.relativeHumidityService.getCharacteristic(Characteristic.CurrentRelativeHumidity)
        .onGet(this.getCurrentRelativeHumidity.bind(this));
    }
  }

  prepareBatteryService() {
    const { Service, Characteristic } = this;
    if (this.fanDevice.hasBuiltInBattery() && this.fanDevice.supportsBatteryStateReporting()) {
      const BatteryServiceClass = Service.Battery || Service.BatteryService;
      this.batteryService = this.getOrCreateService(BatteryServiceClass, 'Battery', 'batteryService');
      this.batteryService
        .setCharacteristic(Characteristic.ChargingState, Characteristic.ChargingState.NOT_CHARGING)
        .setCharacteristic(Characteristic.StatusLowBattery, Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL);
      this.batteryService.getCharacteristic(Characteristic.BatteryLevel)
        .onGet(this.getBatteryLevel.bind(this));
      this.batteryService.getCharacteristic(Characteristic.StatusLowBattery)
        .onGet(this.getBatteryLevelStatus.bind(this));
    }
  }

  /*----------========== GETTERS / SETTERS ==========----------*/

  async getPowerState() {
    const { Characteristic } = this;
    let on = false;
    if (this.fanDevice && this.fanDevice.isFanConnected()) on = this.applyPowerGrace(this.fanDevice.isPowerOn());
    return on ? Characteristic.Active.ACTIVE : Characteristic.Active.INACTIVE;
  }

  async setPowerState(state) {
    const { Characteristic } = this;
    if (this.fanDevice && this.fanDevice.isFanConnected()) {
      const wantOn = state === Characteristic.Active.ACTIVE;
      // 회전속도 슬라이더가 set 이벤트를 여러 번 호출하더라도 이미 켜져 있으면 중복 호출 안 함
      if (wantOn === false || this.fanDevice.isPowerOn() === false) {
        // 보호 구간 시작: 이후 폴링 stale 값이 들어와도 이 목표값을 우선 표시한다.
        this.powerGrace = { target: wantOn, expire: Date.now() + POWER_GRACE_MS };
        this.fanDevice.setPowerOn(wantOn);
      }
    } else {
      throw new this.hap.HapStatusError(this.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

  // 전원 보호 구간: set 직후 일정 시간 동안은 폴링이 반대값을 읽어와도 목표값을 유지해
  // HomeKit 전원 타일이 잠깐 반대로 깜빡이는 것을 막는다. 시간이 지나면 실제값을 그대로 쓴다.
  applyPowerGrace(actualOn) {
    if (!this.powerGrace) return actualOn;
    if (Date.now() >= this.powerGrace.expire) { this.powerGrace = null; return actualOn; }
    return this.powerGrace.target;
  }

  async getFanState() {
    const { Characteristic } = this;
    if (this.fanDevice && this.fanDevice.isFanConnected()) {
      return this.applyPowerGrace(this.fanDevice.isPowerOn()) ? Characteristic.CurrentFanState.BLOWING_AIR : Characteristic.CurrentFanState.IDLE;
    }
    return Characteristic.CurrentFanState.INACTIVE;
  }

  async getRotationSpeed() {
    if (this.fanDevice && this.fanDevice.isFanConnected()) {
      return this.clampPercent(this.fanDevice.getRotationSpeed());
    }
    return 0;
  }

  async setRotationSpeed(value) {
    if (this.fanDevice && this.fanDevice.isFanConnected()) {
      if (this.rotationSpeedTimeout) clearTimeout(this.rotationSpeedTimeout);
      this.rotationSpeedTimeout = setTimeout(() => this.fanDevice.setRotationSpeed(value), 500);
    } else {
      throw new this.hap.HapStatusError(this.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

  async getSwingMode() {
    const { Characteristic } = this;
    let on = false;
    if (this.fanDevice && this.fanDevice.isFanConnected()) on = this.fanDevice.isSwingModeEnabled();
    return on ? Characteristic.SwingMode.SWING_ENABLED : Characteristic.SwingMode.SWING_DISABLED;
  }

  async setSwingMode(state) {
    const { Characteristic } = this;
    if (this.fanDevice && this.fanDevice.isFanConnected()) {
      const enabled = state === Characteristic.SwingMode.SWING_ENABLED;
      this.fanDevice.setSwingModeEnabled(enabled);
      this.updateAngleButtonsAndSwingMode(null, enabled);
    } else {
      throw new this.hap.HapStatusError(this.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

  // RotationDirection을 자연풍/일반풍 토글로 재활용
  async getRotationDirection() {
    const { Characteristic } = this;
    let natural = false;
    if (this.fanDevice && this.fanDevice.isFanConnected() && this.fanDevice.supportsNaturalMode()) {
      natural = this.fanDevice.isNaturalModeEnabled();
    }
    return natural ? Characteristic.RotationDirection.CLOCKWISE : Characteristic.RotationDirection.COUNTER_CLOCKWISE;
  }

  async setRotationDirection(state) {
    const { Characteristic } = this;
    if (this.fanDevice && this.fanDevice.isFanConnected() && this.fanDevice.supportsNaturalMode()) {
      const enableNatural = state === Characteristic.RotationDirection.CLOCKWISE;
      this.fanDevice.setNaturalModeEnabled(enableNatural);
      if (this.naturalModeControlService) {
        this.naturalModeControlService.getCharacteristic(Characteristic.On).updateValue(enableNatural);
      }
    } else {
      throw new this.hap.HapStatusError(this.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

  async getMoveFanSwitch() { return false; }

  async setMoveFanSwitch(state, direction) {
    const { Characteristic } = this;
    if (this.fanDevice && this.fanDevice.isFanConnected()) {
      if (direction === 'left') this.fanDevice.moveLeft();
      else if (direction === 'right') this.fanDevice.moveRight();
      else if (direction === 'up') this.fanDevice.moveUp();
      else if (direction === 'down') this.fanDevice.moveDown();
      setTimeout(() => {
        if (this.moveLeftService)  this.moveLeftService.getCharacteristic(Characteristic.On).updateValue(false);
        if (this.moveRightService) this.moveRightService.getCharacteristic(Characteristic.On).updateValue(false);
        if (this.moveUpService)    this.moveUpService.getCharacteristic(Characteristic.On).updateValue(false);
        if (this.moveDownService)  this.moveDownService.getCharacteristic(Characteristic.On).updateValue(false);
      }, BUTTON_RESET_TIMEOUT);
    } else {
      throw new this.hap.HapStatusError(this.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

  async getBuzzer() {
    if (this.fanDevice && this.fanDevice.isFanConnected()) return this.fanDevice.isBuzzerEnabled();
    return false;
  }
  async setBuzzer(state) {
    if (this.fanDevice && this.fanDevice.isFanConnected()) this.fanDevice.setBuzzerEnabled(state);
    else throw new this.hap.HapStatusError(this.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
  }

  async getLed() {
    if (this.fanDevice && this.fanDevice.isFanConnected()) return this.fanDevice.isLedEnabled();
    return false;
  }
  async setLed(state) {
    if (this.fanDevice && this.fanDevice.isFanConnected()) {
      if (state === false || this.fanDevice.isLedEnabled() === false) {
        this.fanDevice.setLedEnabled(state);
      }
    } else throw new this.hap.HapStatusError(this.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
  }

  async getLedBrightness() {
    if (this.fanDevice && this.fanDevice.isFanConnected()) return this.clampPercent(this.fanDevice.getLedBrightness());
    return 0;
  }
  async setLedBrightness(value) {
    if (this.fanDevice && this.fanDevice.isFanConnected()) this.fanDevice.setLedBrightness(value);
    else throw new this.hap.HapStatusError(this.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
  }

  async getNaturalMode() {
    if (this.fanDevice && this.fanDevice.isFanConnected()) return this.fanDevice.isNaturalModeEnabled();
    return false;
  }
  async setNaturalMode(state) {
    if (this.fanDevice && this.fanDevice.isFanConnected()) this.fanDevice.setNaturalModeEnabled(state);
    else throw new this.hap.HapStatusError(this.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
  }

  async getSleepMode() {
    if (this.fanDevice && this.fanDevice.isFanConnected()) return this.fanDevice.isSleepModeEnabled();
    return false;
  }
  async setSleepMode(state) {
    if (this.fanDevice && this.fanDevice.isFanConnected()) this.fanDevice.setSleepModeEnabled(state);
    else throw new this.hap.HapStatusError(this.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
  }

  async getShutdownTimerEnabled() {
    if (this.fanDevice && this.fanDevice.isFanConnected()) return this.fanDevice.isShutdownTimerEnabled();
    return false;
  }
  async setShutdownTimerEnabled(state) {
    if (this.fanDevice && this.fanDevice.isFanConnected()) {
      if (state === false) this.fanDevice.setShutdownTimer(0);
    } else throw new this.hap.HapStatusError(this.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
  }

  async getShutdownTimer() {
    if (this.fanDevice && this.fanDevice.isFanConnected()) return this.clampPercent(this.fanDevice.getShutdownTimer());
    return 0;
  }
  async setShutdownTimer(level) {
    if (this.fanDevice && this.fanDevice.isFanConnected()) this.fanDevice.setShutdownTimer(level);
    else throw new this.hap.HapStatusError(this.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
  }

  async getAngleButtonState(angle) {
    if (this.fanDevice && this.fanDevice.isFanConnected()) {
      if (this.fanDevice.isPowerOn() && this.fanDevice.isSwingModeEnabled()) {
        return this.fanDevice.getAngle() === angle;
      }
    }
    return false;
  }

  async setAngleButtonState(state, angle) {
    if (this.fanDevice && this.fanDevice.isFanConnected()) {
      if (state) {
        if (this.fanDevice.isSwingModeEnabled() === false) this.fanDevice.setSwingModeEnabled(true);
        this.fanDevice.setAngle(angle);
      } else {
        this.fanDevice.setSwingModeEnabled(false);
      }
      this.updateAngleButtonsAndSwingMode(angle, state);
    } else throw new this.hap.HapStatusError(this.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
  }

  async getVerticalAngleButtonState(angle) {
    if (this.fanDevice && this.fanDevice.isFanConnected()) {
      if (this.fanDevice.isPowerOn() && this.fanDevice.isVerticalSwingModeEnabled()) {
        return this.fanDevice.getVerticalAngle() === angle;
      }
    }
    return false;
  }

  async setVerticalAngleButtonState(state, angle) {
    if (this.fanDevice && this.fanDevice.isFanConnected()) {
      if (state) {
        if (this.fanDevice.isVerticalSwingModeEnabled() === false) this.fanDevice.setVerticalSwingModeEnabled(true);
        this.fanDevice.setVerticalAngle(angle);
      } else {
        this.fanDevice.setVerticalSwingModeEnabled(false);
      }
      this.updateVerticalAngleButtonsAndSwingMode(angle, state);
    } else throw new this.hap.HapStatusError(this.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
  }

  async getFanLevelState(level) {
    if (this.fanDevice && this.fanDevice.isFanConnected() && this.fanDevice.isPowerOn()) {
      return this.fanDevice.getFanLevel() === level;
    }
    return false;
  }

  async setFanLevelState(state, level) {
    if (this.fanDevice && this.fanDevice.isFanConnected()) {
      if (state) {
        if (this.fanDevice.isPowerOn() === false) this.fanDevice.setPowerOn(true);
        this.fanDevice.setFanLevel(level);
      }
      setTimeout(() => this.updateFanLevelButtons(), BUTTON_RESET_TIMEOUT);
    } else throw new this.hap.HapStatusError(this.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
  }

  async getIoniserState() {
    if (this.fanDevice && this.fanDevice.isFanConnected()) return this.fanDevice.isIoniserEnabled();
    return false;
  }
  async setIoniserState(state) {
    if (this.fanDevice && this.fanDevice.isFanConnected()) this.fanDevice.setIoniserEnabled(state);
    else throw new this.hap.HapStatusError(this.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
  }

  async getCurrentTemperature() {
    if (this.fanDevice && this.fanDevice.isFanConnected()) return this.fanDevice.getTemperature();
    return 0;
  }
  async getCurrentRelativeHumidity() {
    if (this.fanDevice && this.fanDevice.isFanConnected()) return this.fanDevice.getRelativeHumidity();
    return 0;
  }
  async getBatteryLevel() {
    if (this.fanDevice && this.fanDevice.isFanConnected()) return this.fanDevice.getBatteryLevel();
    return 0;
  }
  async getBatteryLevelStatus() {
    const { Characteristic } = this;
    if (this.fanDevice && this.fanDevice.isFanConnected()) {
      return this.fanDevice.getBatteryLevel() <= BATTERY_LOW_THRESHOLD
        ? Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW
        : Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL;
    }
    return Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL;
  }

  /*----------========== HELPERS ==========----------*/

  updateFanStatus() {
    const { Characteristic } = this;
    if (!this.fanDevice || !this.fanDevice.isFanConnected()) return;
    if (this.fanService) {
      this.fanService.getCharacteristic(Characteristic.Active).updateValue(
        this.applyPowerGrace(this.fanDevice.isPowerOn()) ? Characteristic.Active.ACTIVE : Characteristic.Active.INACTIVE
      );
      if (this.fanDevice.supportsFanSpeed()) {
        this.fanService.getCharacteristic(Characteristic.RotationSpeed)
          .updateValue(this.clampPercent(this.fanDevice.getRotationSpeed()));
      }
      if (this.fanDevice.supportsNaturalMode()) {
        this.fanService.getCharacteristic(Characteristic.RotationDirection)
          .updateValue(this.fanDevice.isNaturalModeEnabled()
            ? Characteristic.RotationDirection.CLOCKWISE
            : Characteristic.RotationDirection.COUNTER_CLOCKWISE);
      }
    }
    if (this.buzzerService) this.buzzerService.getCharacteristic(Characteristic.On).updateValue(this.fanDevice.isBuzzerEnabled());
    if (this.ledService) this.ledService.getCharacteristic(Characteristic.On).updateValue(this.fanDevice.isLedEnabled());
    if (this.ledBrightnessService) {
      this.ledBrightnessService.getCharacteristic(Characteristic.On).updateValue(this.fanDevice.isLedEnabled());
      this.ledBrightnessService.getCharacteristic(Characteristic.Brightness).updateValue(this.clampPercent(this.fanDevice.getLedBrightness()));
    }
    if (this.naturalModeControlService) this.naturalModeControlService.getCharacteristic(Characteristic.On).updateValue(this.fanDevice.isNaturalModeEnabled());
    if (this.sleepModeControlService) this.sleepModeControlService.getCharacteristic(Characteristic.On).updateValue(this.fanDevice.isSleepModeEnabled());
    if (this.shutdownTimerService) {
      this.shutdownTimerService.getCharacteristic(Characteristic.On).updateValue(this.fanDevice.isShutdownTimerEnabled());
      this.shutdownTimerService.getCharacteristic(Characteristic.Brightness).updateValue(this.clampPercent(this.fanDevice.getShutdownTimer()));
    }
    if (this.ioniserControlService) this.ioniserControlService.getCharacteristic(Characteristic.On).updateValue(this.fanDevice.isIoniserEnabled());
    if (this.temperatureService) this.temperatureService.getCharacteristic(Characteristic.CurrentTemperature).updateValue(this.fanDevice.getTemperature());
    if (this.relativeHumidityService) this.relativeHumidityService.getCharacteristic(Characteristic.CurrentRelativeHumidity).updateValue(this.fanDevice.getRelativeHumidity());
    if (this.batteryService) {
      this.batteryService.getCharacteristic(Characteristic.BatteryLevel).updateValue(this.fanDevice.getBatteryLevel());
      this.batteryService.getCharacteristic(Characteristic.StatusLowBattery).updateValue(
        this.fanDevice.getBatteryLevel() <= BATTERY_LOW_THRESHOLD
          ? Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW
          : Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL
      );
    }
    if (this.angleLightbulbService) {
      const swingOn = this.fanDevice.isPowerOn() && this.fanDevice.isSwingModeEnabled();
      this.angleLightbulbService.getCharacteristic(Characteristic.On).updateValue(swingOn);
      this.angleLightbulbService.getCharacteristic(Characteristic.Brightness).updateValue(this.angleToLightbulbBrightness(this.fanDevice.getAngle()));
    }
    this.updateAngleButtonsAndSwingMode(null, this.fanDevice.isSwingModeEnabled());
    this.updateVerticalAngleButtonsAndSwingMode(null, this.fanDevice.isVerticalSwingModeEnabled());
    this.updateFanLevelButtons();
  }

  updateAngleButtonsAndSwingMode(activeAngle, enabled) {
    const { Characteristic } = this;
    if (this.fanService) {
      this.fanService.getCharacteristic(Characteristic.SwingMode).updateValue(
        enabled ? Characteristic.SwingMode.SWING_ENABLED : Characteristic.SwingMode.SWING_DISABLED
      );
    }
    if (this.angleButtonsService) {
      if (enabled === false || this.fanDevice.isPowerOn() === false) activeAngle = 'disabled';
      if (activeAngle === undefined || activeAngle === null) activeAngle = this.fanDevice.getAngle();
      this.angleButtonsService.forEach((btn, i) => {
        btn.getCharacteristic(Characteristic.On).updateValue(activeAngle === this.angleButtons[i]);
      });
    }
  }

  updateVerticalAngleButtonsAndSwingMode(activeAngle, enabled) {
    const { Characteristic } = this;
    if (this.verticalAngleButtonsService) {
      if (enabled === false || this.fanDevice.isPowerOn() === false) activeAngle = 'disabled';
      if (activeAngle === undefined || activeAngle === null) activeAngle = this.fanDevice.getVerticalAngle();
      this.verticalAngleButtonsService.forEach((btn, i) => {
        btn.getCharacteristic(Characteristic.On).updateValue(activeAngle === this.verticalAngleButtons[i]);
      });
    }
  }

  updateFanLevelButtons() {
    const { Characteristic } = this;
    if (this.fanLevelControlService) {
      const currentLevel = this.fanDevice.getFanLevel();
      this.fanLevelControlService.forEach((btn, i) => {
        btn.getCharacteristic(Characteristic.On).updateValue(currentLevel === (i + 1) && this.fanDevice.isPowerOn());
      });
    }
  }

  saveFanInfo() {
    if (this.fanDevice) {
      this.cachedFanInfo.model = this.fanDevice.getFanModel();
      this.cachedFanInfo.deviceId = this.fanDevice.getDeviceId();
      fs.writeFile(this.fanInfoFile, JSON.stringify(this.cachedFanInfo), (err) => {
        if (err) this.logDebug('Error saving fan info: %s', err);
      });
    }
  }

  loadFanInfo() {
    try { this.cachedFanInfo = JSON.parse(fs.readFileSync(this.fanInfoFile)); }
    catch (_) { this.logDebug('Fan info file does not exist yet.'); }
  }

  checkAngleButtonValue(v) {
    if (this.fanDevice.supportsOscillationAngle()) {
      if (!this.fanDevice.checkOscillationAngleWithinRange(v)) {
        this.logWarn(`Angle ${v} not within range ${JSON.stringify(this.fanDevice.oscillationAngleRange())}`);
        return false;
      }
    } else if (this.fanDevice.supportsOscillationLevels()) {
      if (!this.fanDevice.checkOscillationLevelSupported(v)) {
        this.logWarn(`Angle ${v} not in supported levels ${JSON.stringify(this.fanDevice.oscillationLevels())}`);
        return false;
      }
    }
    return true;
  }

  checkVerticalAngleButtonValue(v) {
    if (this.fanDevice.supportsVerticalOscillationAngle()) {
      if (!this.fanDevice.checkVerticalOscillationAngleWithinRange(v)) {
        this.logWarn(`Vertical angle ${v} not within range`);
        return false;
      }
    } else if (this.fanDevice.supportsOscillationVerticalLevels()) {
      if (!this.fanDevice.checkVerticalOscillationLevelSupported(v)) {
        this.logWarn(`Vertical angle ${v} not in supported levels`);
        return false;
      }
    }
    return true;
  }

  clampPercent(v) {
    if (!Number.isFinite(v)) return 0;
    if (v > 100) return 100;
    if (v < 0) return 0;
    return v;
  }

  /*----------========== LOG ==========----------*/

  logInfo(msg, ...a)  { this.log.info(`[${this.name}] ` + msg, ...a); }
  logWarn(msg, ...a)  { this.log.warn(`[${this.name}] ` + msg, ...a); }
  logDebug(msg, ...a) { this.log.debug(`[${this.name}] ` + msg, ...a); }
  logError(msg, ...a) { this.log.error(`[${this.name}] ` + msg, ...a); }
}

module.exports = FanAccessory;

'use strict';

const EventEmitter = require('events');
const FanCapabilities = require('./FanCapabilities.js');

// general constants
const COMMAND_NOT_SUPPORTED_MSG = 'Not supported: The requested command is not supported by this device!';

// DEVICES: http://miot-spec.org/miot-spec-v2/instances?status=all

class BaseFan extends EventEmitter {
  constructor(miioDevice, model, deviceId, name, log) {
    super();

    // config
    this.deviceId = deviceId;
    this.model = model;
    this.name = name;
    this.log = log || console;
    this.deepDebugLog = false;

    //fan info
    this.miioFanDevice = undefined;
    this.fanInfo = {};

    // MiCloud(클라우드) 모드 상태. forceMiCloud 인 기기는 로컬 miio 대신 클라우드로 제어한다.
    this.miCloud = null;
    this.cloudDid = null;
    this.cloudCountry = null;
    this.cloudConnected = false;

    // prepare the variables
    this.capabilities = {};

    // init fan capabilities
    this.initFanCapabilities();

    // if we construct with a miiodevice then we can start with the setup
    if (miioDevice) {
      this.miioFanDevice = miioDevice;
      this.setupFan();
    }
  }

  /*----------========== INIT ==========----------*/

  initFanCapabilities() {
    this.addCapability(FanCapabilities.POWER_CONTROL, true);
  }

  /*----------========== SETUP ==========----------*/

  setupFan() {
    this.logDebug(`Setting up fan!`);

    this.logDebug(`Getting device info.`);
    this.miioFanDevice.management.info().then((info) => {
      this.fanInfo = info;
    }).catch(err => {
      this.logDebug(`Could not retrieve device info: ${err}`);
    });

    if (!this.deviceId) {
      this.deviceId = this.getDeviceId();
      this.logDebug(`Got fan did: ${this.deviceId}.`);
    }

    this.logDebug(`Doing model specific setup.`);
    this.modelSpecificSetup();

    this.logDebug(`Adding properties to fan.`);
    this.addFanProperties();

    this.logDebug(`Doing initial properties fetch.`);
    this.doInitialPropertiesFetch();

    this.logDebug(`Setup finished! Fan can now be controlled!`);
  }

  /*----------========== DEVICE CONTROL ==========----------*/

  disconnectAndDestroyMiioDevice() {
    if (this.miioFanDevice) {
      this.miioFanDevice.destroy();
    }
    this.miioFanDevice = undefined;
  }

  updateMiioDevice(newMiioDevice) {
    // 이전 전송이 남아 있으면 파기한다(소켓 누수 방지). 보통 호출자가 미리 정리하지만,
    // 그 불변식에 의존하지 않도록 방어적으로 한 번 더 닫는다.
    if (this.miioFanDevice && this.miioFanDevice !== newMiioDevice && typeof this.miioFanDevice.destroy === 'function') {
      try { this.miioFanDevice.destroy(); } catch (_) {}
    }
    this.miioFanDevice = newMiioDevice;
    this.setupFan();
  }

  /*----------========== DEVICE LIFECYCLE ==========----------*/

  modelSpecificSetup() { this.logDebug(`Needs to be implemented by devices!`); }
  addFanProperties()    { this.logDebug(`Needs to be implemented by devices!`); }
  doInitialPropertiesFetch() { this.logDebug(`Needs to be implemented by devices!`); }
  async pollProperties() { this.logDebug(`Needs to be implemented by devices!`); }
  getFanProperties()     { this.logDebug(`Needs to be implemented by devices!`); }

  /*----------========== CLOUD SETUP ==========----------*/

  // 클라우드 전송으로 전환한다 (forceMiCloud 또는 하이브리드 폴백).
  // 하이브리드에서 로컬→클라우드로 넘어올 때 기존 로컬 소켓이 남아 있으면 파기한다.
  setupCloud(miCloud, did, country) {
    if (this.miioFanDevice) {
      try { this.miioFanDevice.destroy(); } catch (_) {}
      this.miioFanDevice = undefined;
    }
    this.miCloud = miCloud;
    this.cloudDid = did || this.deviceId;
    this.cloudCountry = country || null;
    this.cloudConnected = true;
    this.logInfo(`MiCloud 모드 - 클라우드를 통해 제어합니다.${country ? ` (지역: ${country})` : ''}`);
    this.modelSpecificSetup();
    this.addFanProperties();
    this.doInitialPropertiesFetch();
  }

  // 하이브리드에서 클라우드→로컬로 복귀할 때 클라우드 전송만 끈다(미Cloud 참조는 다음 폴백을 위해 유지).
  teardownCloud() {
    this.cloudConnected = false;
  }

  /*----------========== INFO ==========----------*/

  isFanConnected() { return this.miioFanDevice !== undefined || this.cloudConnected === true; }

  getFanModel() {
    if (this.miioFanDevice) return this.miioFanDevice.miioModel;
    return this.model;
  }

  isDmakerFan()  { return this.getFanModel().includes('dmaker'); }
  isSmartmiFan() { return this.getFanModel().includes('zhimi'); }
  getFanInfo()   { return this.fanInfo; }

  getProtocolType() { this.logDebug(`Needs to be implemented by devices!`); }
  isMiioDevice() { return this.getProtocolType() === 'miio'; }
  isMiotDevice() { return this.getProtocolType() === 'miot'; }

  getDeviceId() {
    if (this.miioFanDevice) return this.miioFanDevice.id.replace(/^miio:/, '');
    return this.deviceId;
  }

  /*----------========== CAPABILITIES ==========----------*/

  supportsPowerControl()         { return this.capabilities[FanCapabilities.POWER_CONTROL] || true; }
  supportsFanSpeed()             { return this.capabilities[FanCapabilities.FAN_SPEED_CONTROL] || false; }
  supportsFanSpeedRpmReporting() { return this.capabilities[FanCapabilities.FAN_SPEED_RPM_REPORTING] || false; }
  supportsFanLevel()             { return this.capabilities[FanCapabilities.FAN_LEVEL_CONTROL] || false; }
  numberOfFanLevels()            { return this.capabilities[FanCapabilities.NUMBER_OF_FAN_LEVELS] || 0; }
  supportsOscillation()          { return this.capabilities[FanCapabilities.OSCILLATION_CONTROL] || false; }
  supportsOscillationAngle()     { return this.capabilities[FanCapabilities.OSCILLATION_ANGLE_CONTROL] || false; }
  oscillationAngleRange()        { return this.capabilities[FanCapabilities.OSCILLATION_ANGLE_RANGE] || []; }
  supportsOscillationLevels()    { return this.capabilities[FanCapabilities.OSCILLATION_LEVEL_CONTROL] || false; }
  oscillationLevels()            { return this.capabilities[FanCapabilities.OSCILLATION_LEVELS] || []; }

  // 전구(밝기 슬라이더) 방식 각도 제어에 사용할 기본 각도 단계 배열.
  // - 레벨형(OSCILLATION_LEVELS): 정의된 레벨 사용
  // - 각도형(OSCILLATION_ANGLE_RANGE): 30° 간격 단계 생성 (예: [0,120] -> [30,60,90,120])
  // HomeKit 밝기는 0~100 범위이므로 100°를 초과하는 단계는 가장 큰 값 하나만 남긴다.
  //   예) [30,60,90,120,150] -> [30,60,90,150] (120 자동 제외)
  oscillationLightbulbLevels() {
    let levels = [];
    if (this.supportsOscillationLevels() && this.oscillationLevels().length > 0) {
      levels = this.oscillationLevels().slice();
    } else if (this.supportsOscillationAngle() && this.oscillationAngleRange().length === 2) {
      const high = this.oscillationAngleRange()[1];
      for (let a = 30; a <= high; a += 30) levels.push(a);
    }
    levels = Array.from(new Set(levels.map(v => parseInt(v)).filter(v => !isNaN(v) && v > 0))).sort((a, b) => a - b);
    const under = levels.filter(a => a <= 100);
    const over = levels.filter(a => a > 100);
    if (over.length > 0) under.push(Math.max(...over));
    return under;
  }
  supportsVerticalOscillation()  { return this.capabilities[FanCapabilities.OSCILLATION_VERTICAL_CONTROL] || false; }
  supportsVerticalOscillationAngle() { return this.capabilities[FanCapabilities.OSCILLATION_VERTICAL_ANGLE_CONTROL] || false; }
  oscillationVerticalAngleRange()    { return this.capabilities[FanCapabilities.OSCILLATION_VERTICAL_ANGLE_RANGE] || []; }
  supportsOscillationVerticalLevels(){ return this.capabilities[FanCapabilities.OSCILLATION_VERTICAL_LEVEL_CONTROL] || false; }
  oscillationVerticalLevels()        { return this.capabilities[FanCapabilities.OSCILLATION_VERTICAL_LEVELS] || []; }
  supportsLeftRightMove() { return this.capabilities[FanCapabilities.LEFT_RIGHT_MOVE] || false; }
  supportsUpDownMove()    { return this.capabilities[FanCapabilities.UP_DOWN_MOVE] || false; }
  supportsNaturalMode()   { return this.capabilities[FanCapabilities.NATURAL_MODE] || false; }
  supportsSleepMode()     { return this.capabilities[FanCapabilities.SLEEP_MODE] || false; }
  supportsChildLock()     { return this.capabilities[FanCapabilities.CHILD_LOCK] || false; }
  supportsPowerOffTimer() { return this.capabilities[FanCapabilities.POWER_OFF_TIMER] || false; }
  powerOffTimerUnit()     { return this.capabilities[FanCapabilities.POWER_OFF_TIMER_UNIT] || ''; }
  supportsBuzzerControl() { return this.capabilities[FanCapabilities.BUZZER_CONTROL] || false; }
  supportsBuzzerLevelControl() { return this.capabilities[FanCapabilities.BUZZER_LEVEL_CONTROL] || false; }
  buzzerLevels()          { return this.capabilities[FanCapabilities.BUZZER_LEVELS] || []; }
  supportsLedControl()    { return this.capabilities[FanCapabilities.LED_CONTROL] || false; }
  supportsLedLevelControl() { return this.capabilities[FanCapabilities.LED_LEVEL_CONTROL] || false; }
  ledLevels()             { return this.capabilities[FanCapabilities.LED_LEVELS] || []; }
  supportsLedBrightness() { return this.capabilities[FanCapabilities.LED_CONTROL_BRIGHTNESS] || false; }
  supportsUseTimeReporting() { return this.capabilities[FanCapabilities.USE_TIME_REPORTING] || false; }
  supportsIoniser()       { return this.capabilities[FanCapabilities.IONISER_CONTROL] || false; }
  supportsTemperatureReporting() { return this.capabilities[FanCapabilities.TEMPERATURE_REPORTING] || false; }
  supportsRelativeHumidityReporting() { return this.capabilities[FanCapabilities.HUMIDITY_REPORTING] || false; }
  hasBuiltInBattery()     { return this.capabilities[FanCapabilities.BUILT_IN_BATTERY] || false; }
  supportsBatteryStateReporting() { return this.capabilities[FanCapabilities.BATTERY_STATE_REPORTING] || false; }

  /*----------========== CAPABILITY HELPERS ==========----------*/

  adjustOscillationAngleToRange(angle) {
    if (this.supportsOscillationAngle() && this.oscillationAngleRange().length == 2) {
      const [low, high] = this.oscillationAngleRange();
      if (angle > high) angle = high;
      if (angle < low) angle = low;
      return angle;
    }
    return angle;
  }

  checkOscillationAngleWithinRange(angle) {
    if (this.supportsOscillationAngle() && this.oscillationAngleRange().length == 2) {
      const [low, high] = this.oscillationAngleRange();
      return angle >= low && angle <= high;
    }
    return false;
  }

  checkOscillationLevelSupported(angle) {
    return this.supportsOscillationLevels() && this.oscillationLevels().includes(angle);
  }

  adjustVerticalOscillationAngleToRange(angle) {
    if (this.supportsVerticalOscillationAngle() && this.oscillationVerticalAngleRange().length == 2) {
      const [low, high] = this.oscillationVerticalAngleRange();
      if (angle > high) angle = high;
      if (angle < low) angle = low;
      return angle;
    }
    return angle;
  }

  checkVerticalOscillationAngleWithinRange(angle) {
    if (this.supportsVerticalOscillationAngle() && this.oscillationVerticalAngleRange().length == 2) {
      const [low, high] = this.oscillationVerticalAngleRange();
      return angle >= low && angle <= high;
    }
    return false;
  }

  checkVerticalOscillationLevelSupported(angle) {
    return this.supportsOscillationVerticalLevels() && this.oscillationVerticalLevels().includes(angle);
  }

  /*----------========== STATUS ==========----------*/

  isPowerOn() { return false; }
  getRotationSpeed() { return 0; }
  getSpeed() { return 0; }
  getFanLevel() { return 0; }
  isChildLockActive() { return false; }
  isSwingModeEnabled() { return false; }
  isVerticalSwingModeEnabled() { return false; }
  isNaturalModeEnabled() { return false; }
  isSleepModeEnabled() { return false; }
  isBuzzerEnabled() { return false; }
  getBuzzerLevel() { return this.isBuzzerEnabled() ? 1 : 0; }
  isLedEnabled() { return false; }
  getLedLevel() { return 0; }
  getLedBrightness() { return 0; }
  getShutdownTimer() { return 0; }
  isShutdownTimerEnabled() { return this.getShutdownTimer() > 0; }
  getUseTime() { return 0; }
  isIoniserEnabled() { return false; }
  getTemperature() { return 0; }
  getRelativeHumidity() { return 0; }
  getBatteryLevel() { return 0; }

  /*----------========== COMMANDS ==========----------*/

  async setPowerOn(power)              { this.logWarn(COMMAND_NOT_SUPPORTED_MSG); }
  async setRotationSpeed(speed)        { this.logWarn(COMMAND_NOT_SUPPORTED_MSG); }
  async setFanLevel(level)             { this.logWarn(COMMAND_NOT_SUPPORTED_MSG); }
  async setChildLock(active)           { this.logWarn(COMMAND_NOT_SUPPORTED_MSG); }
  async setSwingModeEnabled(enabled)   { this.logWarn(COMMAND_NOT_SUPPORTED_MSG); }
  async setAngle(angle)                { this.logWarn(COMMAND_NOT_SUPPORTED_MSG); }
  async setVerticalSwingModeEnabled(enabled) { this.logWarn(COMMAND_NOT_SUPPORTED_MSG); }
  async setVerticalAngle(angle)        { this.logWarn(COMMAND_NOT_SUPPORTED_MSG); }
  async setNaturalModeEnabled(enabled) { this.logWarn(COMMAND_NOT_SUPPORTED_MSG); }
  async setSleepModeEnabled(enabled)   { this.logWarn(COMMAND_NOT_SUPPORTED_MSG); }
  async moveLeft()                     { this.logWarn(COMMAND_NOT_SUPPORTED_MSG); }
  async moveRight()                    { this.logWarn(COMMAND_NOT_SUPPORTED_MSG); }
  async moveUp()                       { this.logWarn(COMMAND_NOT_SUPPORTED_MSG); }
  async moveDown()                     { this.logWarn(COMMAND_NOT_SUPPORTED_MSG); }
  async setBuzzerEnabled(enabled)      { this.logWarn(COMMAND_NOT_SUPPORTED_MSG); }
  async setBuzzerLevel(level) {
    const enabled = this.getBuzzerLevel() === 0 ? false : true;
    this.setBuzzerEnabled(enabled);
  }
  async setLedEnabled(enabled)         { this.logWarn(COMMAND_NOT_SUPPORTED_MSG); }
  async setLedLevel(level)             { this.logWarn(COMMAND_NOT_SUPPORTED_MSG); }
  async setLedBrightness(brightness)   { this.logWarn(COMMAND_NOT_SUPPORTED_MSG); }
  async setShutdownTimer(minutes)      { this.logWarn(COMMAND_NOT_SUPPORTED_MSG); }
  async setIoniserEnabled(enabled)     { this.logWarn(COMMAND_NOT_SUPPORTED_MSG); }

  /*----------========== HELPERS ==========----------*/

  createErrorPromise(msg) {
    return new Promise((resolve, reject) => { reject(new Error(msg)); })
      .catch(err => this.logDebug(err));
  }

  addCapability(name, value) { this.capabilities[name] = value; }

  getSafePropertyValue(value, safe) {
    return value === undefined ? safe : value;
  }

  /*----------========== LOG ==========----------*/

  logInfo(message, ...args)  { this.log.info((this.name ? `[${this.name}] ` : '') + message, ...args); }
  logWarn(message, ...args)  { this.log.warn((this.name ? `[${this.name}] ` : '') + message, ...args); }
  logDebug(message, ...args) { this.log.debug((this.name ? `[${this.name}] ` : '') + message, ...args); }
  logError(message, ...args) { this.log.error((this.name ? `[${this.name}] ` : '') + message, ...args); }
}

module.exports = BaseFan;

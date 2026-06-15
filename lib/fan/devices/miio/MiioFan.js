'use strict';

const BaseFan = require('../../BaseFan.js');
const Events = require('../../Events.js');
const { withTimeout } = require('../../../common/helpers.js');

const CALL_TIMEOUT_MS = 8000;   // miio 호출이 응답 없이 매달리는 것 방지

class MiioFan extends BaseFan {
  constructor(miioDevice, model, deviceId, name, log) {
    super(miioDevice, model, deviceId, name, log);
  }

  modelSpecificSetup() { /* none */ }

  addFanProperties() { this.logDebug(`Needs to be implemented by devices!`); }

  doInitialPropertiesFetch() {
    withTimeout(this.miioFanDevice._loadProperties(), CALL_TIMEOUT_MS, '_loadProperties').then(() => {
      this.logDebug(`Got initial fan properties: \n ${JSON.stringify(this.getFanProperties(), null, 2)}`);
      if (this.supportsUseTimeReporting()) {
        this.logInfo(`Fan total use time: ${this.getUseTime()} minutes.`);
      }
    }).catch(err => {
      this.logDebug(`Error on initial property request! ${err}`);
    });
  }

  async pollProperties() {
    if (this.isFanConnected()) return this.miioFanDevice.poll();
    return new Promise((_, reject) => reject(new Error('Fan not connected')));
  }

  getFanProperties() {
    if (this.isFanConnected()) return this.miioFanDevice.miioProperties();
    return {};
  }

  getProtocolType() { return 'miio'; }

  getFanLevel() {
    let level = 1;
    const rotSpeed = this.getRotationSpeed();
    if (rotSpeed >= 1 && rotSpeed <= 20)      level = 1;
    else if (rotSpeed > 20 && rotSpeed <= 50) level = 2;
    else if (rotSpeed > 50 && rotSpeed <= 80) level = 3;
    else if (rotSpeed > 80)                   level = 4;
    return level;
  }

  async setFanLevel(level) {
    let rotationSpeed = 1;
    if (level === 1) rotationSpeed = 1;
    else if (level === 2) rotationSpeed = 35;
    else if (level === 3) rotationSpeed = 74;
    else if (level === 4) rotationSpeed = 100;
    return this.setRotationSpeed(rotationSpeed);
  }

  async sendCommand(cmd, value, refresh, refreshDelay = 200) {
    if (this.isFanConnected()) {
      return withTimeout(this.miioFanDevice.call(cmd, [value], { refresh, refreshDelay }), CALL_TIMEOUT_MS, cmd).then(result => {
        this.logDebug(`${cmd}(${JSON.stringify(value)}) → ${JSON.stringify(result)}`);
      }).catch(err => {
        // 디바이스 명령 실패는 사용자에게 보이도록 warn 으로 출력 (기존 debug 에서 상향).
        this.logWarn(`${cmd}(${JSON.stringify(value)}) 실패: ${err && err.message || err}`);
      });
    }
    return this.createErrorPromise(`Cannot execute ${cmd} with value ${value}! Device not connected!`);
  }

  updateProperty(prop, value) {
    if (this.isFanConnected()) {
      this.miioFanDevice.setProperty(prop, value);
      this.emit(Events.FAN_DEVICE_MANUAL_PROPERTIES_UPDATE, []);
    }
  }

  updateFanMode(naturalModeEnabled, speed) {
    this.miioFanDevice.setProperty('natural_level', naturalModeEnabled ? speed : 0);
    this.miioFanDevice.setProperty('speed_level', naturalModeEnabled ? 0 : speed);
    this.emit(Events.FAN_DEVICE_MANUAL_PROPERTIES_UPDATE, []);
  }
}

module.exports = MiioFan;

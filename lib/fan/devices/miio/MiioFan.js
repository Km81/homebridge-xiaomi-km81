'use strict';

const BaseFan = require('../../BaseFan.js');
const Events = require('../../Events.js');
const CloudMiioTransport = require('../../CloudMiioTransport.js');
const { withTimeout } = require('../../../common/helpers.js');

const CALL_TIMEOUT_MS = 8000;   // miio 호출이 응답 없이 매달리는 것 방지

class MiioFan extends BaseFan {
  constructor(miioDevice, model, deviceId, name, log) {
    super(miioDevice, model, deviceId, name, log);
  }

  modelSpecificSetup() { /* none */ }

  /*----------========== CLOUD (레거시 miio 패스스루) ==========----------*/

  // 레거시 선풍기의 클라우드 모드: miioFanDevice 자리에 CloudMiioTransport 를 꽂는다.
  // 그러면 poll/call/miioProperties/setProperty/defineProperty 등 기존 코드가 그대로
  // 클라우드(get_prop/set_xxx 패스스루)로 동작한다 — MiioFan/서브클래스 변경 불필요.
  // (BaseFan.setupCloud 는 miot 전용이라 여기서 오버라이드한다.)
  setupCloud(miCloud, did, country) {
    if (this.miioFanDevice) {
      try { this.miioFanDevice.destroy(); } catch (_) {}
      this.miioFanDevice = undefined;
    }
    this.miCloud = miCloud;
    this.cloudDid = did || this.deviceId;
    this.cloudCountry = country || null;
    this.cloudConnected = true;
    this.miioFanDevice = new CloudMiioTransport(this.miCloud, this.cloudDid, this.getFanModel(), this.cloudCountry, this.log);
    this.logInfo(`MiCloud 모드 - 클라우드(레거시 miio 패스스루)로 제어합니다.${country ? ` (지역: ${country})` : ''}`);
    this.modelSpecificSetup();
    this.addFanProperties();
    this.doInitialPropertiesFetch();
  }

  // 클라우드 → 로컬 복귀 시 클라우드 전송 어댑터를 파기한다(다음 폴백 위해 miCloud 참조는 유지).
  // 이후 FanController.tripToLocal 이 updateMiioDevice(localDevice) 로 로컬 전송을 다시 꽂는다.
  teardownCloud() {
    this.cloudConnected = false;
    if (this.miioFanDevice) {
      try { this.miioFanDevice.destroy(); } catch (_) {}
      this.miioFanDevice = undefined;
    }
  }

  addFanProperties() { this.logDebug(`Needs to be implemented by devices!`); }

  doInitialPropertiesFetch() {
    withTimeout(this.miioFanDevice._loadProperties(), CALL_TIMEOUT_MS, '_loadProperties').then(() => {
      this.logDebug(`Got initial fan properties: \n ${JSON.stringify(this.getFanProperties(), null, 2)}`);
      if (this.supportsUseTimeReporting()) {
        this.logInfo(`총 사용시간 ${this.getUseTime()}분`);
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

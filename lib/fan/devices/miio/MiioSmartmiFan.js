'use strict';

const MiioFan = require('./MiioFan.js');
const FanCapabilities = require('../../FanCapabilities.js');

class MiioSmartmiFan extends MiioFan {
  constructor(miioDevice, model, deviceId, name, log) {
    super(miioDevice, model, deviceId, name, log);
  }

  initFanCapabilities() {
    this.addCapability(FanCapabilities.POWER_CONTROL, true);
    this.addCapability(FanCapabilities.FAN_SPEED_CONTROL, true);
    this.addCapability(FanCapabilities.FAN_LEVEL_CONTROL, true);
    this.addCapability(FanCapabilities.NUMBER_OF_FAN_LEVELS, 4);
    this.addCapability(FanCapabilities.OSCILLATION_CONTROL, true);
    this.addCapability(FanCapabilities.OSCILLATION_ANGLE_CONTROL, true);
    this.addCapability(FanCapabilities.OSCILLATION_ANGLE_RANGE, [0, 120]);
    this.addCapability(FanCapabilities.LEFT_RIGHT_MOVE, true);
    this.addCapability(FanCapabilities.NATURAL_MODE, true);
    this.addCapability(FanCapabilities.CHILD_LOCK, true);
    this.addCapability(FanCapabilities.POWER_OFF_TIMER, true);
    this.addCapability(FanCapabilities.POWER_OFF_TIMER_UNIT, 'seconds');
    this.addCapability(FanCapabilities.BUZZER_CONTROL, true);
    this.addCapability(FanCapabilities.BUZZER_LEVEL_CONTROL, true);
    this.addCapability(FanCapabilities.BUZZER_LEVELS, [0, 1, 2]);
    this.addCapability(FanCapabilities.LED_CONTROL, true);
    this.addCapability(FanCapabilities.LED_LEVEL_CONTROL, true);
    this.addCapability(FanCapabilities.LED_LEVELS, [0, 1, 2]);
    this.addCapability(FanCapabilities.USE_TIME_REPORTING, true);
    this.addCapability(FanCapabilities.BUILT_IN_BATTERY, true);
  }

  addFanProperties() {
    this.miioFanDevice.defineProperty('angle');
    this.miioFanDevice.defineProperty('speed');
    this.miioFanDevice.defineProperty('poweroff_time');
    this.miioFanDevice.defineProperty('power');
    this.miioFanDevice.defineProperty('ac_power');
    this.miioFanDevice.defineProperty('angle_enable');
    this.miioFanDevice.defineProperty('speed_level');
    this.miioFanDevice.defineProperty('natural_level');
    this.miioFanDevice.defineProperty('child_lock');
    this.miioFanDevice.defineProperty('buzzer');
    this.miioFanDevice.defineProperty('led_b');
    this.miioFanDevice.defineProperty('use_time');
  }

  isPowerOn() { return this.getFanProperties().power === 'on'; }

  getRotationSpeed() {
    let rotationValue = this.getFanProperties().speed_level;
    if (this.getFanProperties().natural_level > 0) {
      rotationValue = this.getFanProperties().natural_level;
    }
    return this.getSafePropertyValue(rotationValue, 0);
  }

  getSpeed() { return this.getSafePropertyValue(this.getFanProperties().speed, 0); }

  isChildLockActive() { return this.getFanProperties().child_lock === 'on'; }
  isSwingModeEnabled() { return this.getFanProperties().angle_enable === 'on'; }
  getAngle() { return this.getFanProperties().angle; }
  isNaturalModeEnabled() { return this.getFanProperties().natural_level > 0; }
  getBuzzerLevel() { return this.getFanProperties().buzzer; }
  isBuzzerEnabled() { return this.getBuzzerLevel() > 0; }
  getLedLevel() { return this.getFanProperties().led_b; }
  isLedEnabled() { return this.getLedLevel() === 0 || this.getLedLevel() === 1; }
  getShutdownTimer() { return Math.ceil(this.getFanProperties().poweroff_time / 60); }
  isShutdownTimerEnabled() { return this.getShutdownTimer() > 0; }
  getUseTime() { return this.getFanProperties().use_time; }

  // 자연풍에서 펌웨어가 임의의 1~100 퍼센트 값을 4단계로 반올림하지 않는
  // 구형 Smartmi 모델 목록 (zhimi.fan.za4는 펌웨어가 처리해주므로 제외)
  _needsDiscreteNaturalLevels() {
    const model = this.getFanModel() || this.model || '';
    return (
      model === 'zhimi.fan.v2' ||
      model === 'zhimi.fan.v3' ||
      model === 'zhimi.fan.sa1' ||
      model === 'zhimi.fan.za1' ||
      model === 'zhimi.fan.za3'
    );
  }

  _mapToDiscreteNaturalLevel(percent) {
    if (percent <= 0) return 0;
    if (percent <= 25) return 25;
    if (percent <= 50) return 50;
    if (percent <= 75) return 75;
    return 100;
  }

  async setPowerOn(power) {
    const powerState = power ? 'on' : 'off';
    this.updateProperty('power', powerState);
    // refreshDelay=1000: set_power 직후 빠른 폴링이 펌웨어가 아직
    // 상태 전이 중인 값을 받아서 홈킷 아이콘이 잠깐 OFF로 깜빡이는 것을 방지.
    return this.sendCommand('set_power', powerState, ['power', 'ac_power'], 1000);
  }

  async setRotationSpeed(speed) {
    const setMethod = this.isNaturalModeEnabled() ? 'set_natural_level' : 'set_speed_level';
    let targetSpeed = speed;
    if (this.isNaturalModeEnabled() && this._needsDiscreteNaturalLevels()) {
      targetSpeed = this._mapToDiscreteNaturalLevel(speed);
    }
    this.updateFanMode(this.isNaturalModeEnabled(), targetSpeed);
    return this.sendCommand(setMethod, targetSpeed, ['speed_level', 'natural_level']);
  }

  async setChildLock(active) {
    const state = active ? 'on' : 'off';
    this.updateProperty('child_lock', state);
    return this.sendCommand('set_child_lock', state, ['child_lock']);
  }

  async setSwingModeEnabled(enabled) {
    const state = enabled ? 'on' : 'off';
    this.updateProperty('angle_enable', state);
    return this.sendCommand('set_angle_enable', state, ['angle_enable']);
  }

  async setAngle(angle) {
    angle = this.adjustOscillationAngleToRange(angle);
    this.updateProperty('angle', angle);
    return this.sendCommand('set_angle', angle, ['angle']);
  }

  async setNaturalModeEnabled(enabled) {
    const setMethod = enabled ? 'set_natural_level' : 'set_speed_level';
    let targetSpeed = this.getRotationSpeed();
    if (enabled && this._needsDiscreteNaturalLevels()) {
      targetSpeed = this._mapToDiscreteNaturalLevel(targetSpeed);
      if (targetSpeed === 0) targetSpeed = 25;
    }
    this.updateFanMode(enabled, targetSpeed);
    return this.sendCommand(setMethod, targetSpeed, ['speed_level', 'natural_level']);
  }

  async moveLeft()  { return this.sendCommand('set_move', 'left'); }
  async moveRight() { return this.sendCommand('set_move', 'right'); }

  async setBuzzerEnabled(enabled) {
    const state = enabled ? 2 : 0;
    this.updateProperty('buzzer', state);
    return this.sendCommand('set_buzzer', state, ['buzzer']);
  }

  async setBuzzerLevel(level) {
    if (level > 2) level = 2;
    if (level < 0) level = 0;
    this.updateProperty('buzzer', level);
    return this.sendCommand('set_buzzer', level, ['buzzer']);
  }

  async setLedEnabled(enabled) {
    const level = enabled === true ? 0 : 2;
    this.updateProperty('led_b', level);
    return this.sendCommand('set_led_b', level, ['led_b']);
  }

  async setLedLevel(level) {
    if (level > 2) level = 2;
    if (level < 0) level = 0;
    this.updateProperty('led_b', level);
    return this.sendCommand('set_led_b', level, ['led_b']);
  }

  async setShutdownTimer(minutes) {
    const seconds = minutes * 60;
    this.updateProperty('poweroff_time', seconds);
    return this.sendCommand('set_poweroff_time', seconds, ['poweroff_time']);
  }
}

module.exports = MiioSmartmiFan;

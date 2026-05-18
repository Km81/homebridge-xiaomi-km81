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

  // 자연풍 단계(1~4) ↔ HomeKit 슬라이더 퍼센트(25/50/75/100) 매핑.
  //  - 1단계 ↔ 25%
  //  - 2단계 ↔ 50%
  //  - 3단계 ↔ 75%
  //  - 4단계 ↔ 100%
  _percentToNaturalStage(percent) {
    if (percent <= 0) return 0;
    if (percent <= 25) return 1;
    if (percent <= 50) return 2;
    if (percent <= 75) return 3;
    return 4;
  }

  _naturalStageToPercent(stage) {
    if (stage <= 0) return 0;
    if (stage >= 4) return 100;
    return stage * 25;
  }

  getRotationSpeed() {
    const fp = this.getFanProperties();
    let rotationValue = fp.speed_level;
    if (fp.natural_level > 0) {
      rotationValue = fp.natural_level;
      // 구형 Smartmi 모델: 펌웨어가 자연풍 단계를 1~4 정수로 보고하면 HomeKit
      // 슬라이더 퍼센트(25/50/75/100)로 변환해서 표시. 25~100 범위로 보고하는
      // 펌웨어/버전(레거시 / za4 등)은 그대로 통과시켜 하위 호환을 유지한다.
      if (this._needsDiscreteNaturalLevels() && rotationValue >= 1 && rotationValue <= 4) {
        rotationValue = this._naturalStageToPercent(rotationValue);
      }
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
  // 구형 Smartmi 모델 목록 (zhimi.fan.za4는 펌웨어가 처리해주므로 제외).
  // 이 모델들은 set_natural_level 에 1~4 단계 정수를 직접 보내야 모든 단계가
  // 정상 동작한다 (25/50/75/100 같은 퍼센트 값을 보내면 일부 펌웨어 빌드에서
  // 낮은 단계가 무시되거나 무조건 4단계로 처리되는 현상이 관찰됨).
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
    // 자연풍 + 구형 모델: HomeKit 0~100% 를 펌웨어가 받는 1~4 단계 값으로 변환
    if (this.isNaturalModeEnabled() && this._needsDiscreteNaturalLevels()) {
      targetSpeed = this._percentToNaturalStage(speed);
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
    // getRotationSpeed() 는 자연풍 단계를 25/50/75/100% 로 환산해 돌려주므로
    // 자연풍으로 전환할 때 다시 1~4 단계로 변환.
    let targetSpeed = this.getRotationSpeed();
    if (enabled && this._needsDiscreteNaturalLevels()) {
      targetSpeed = this._percentToNaturalStage(targetSpeed);
      if (targetSpeed === 0) targetSpeed = 1;  // 자연풍 켤 때 최소 1단계로 시작
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

'use strict';

const MiotFan = require('./MiotFan.js');
const FanCapabilities = require('../../FanCapabilities.js');

// based on zhimi.fan.za5 props - fallback for unknown miot fans
class MiotGenericFan extends MiotFan {
  constructor(miioDevice, model, deviceId, name, log) {
    super(miioDevice, model, deviceId, name, log);
  }

  initFanCapabilities() {
    this.addCapability(FanCapabilities.POWER_CONTROL, true);
    this.addCapability(FanCapabilities.FAN_SPEED_CONTROL, true);
    this.addCapability(FanCapabilities.FAN_LEVEL_CONTROL, true);
    this.addCapability(FanCapabilities.NUMBER_OF_FAN_LEVELS, 4);
    this.addCapability(FanCapabilities.OSCILLATION_CONTROL, true);
    this.addCapability(FanCapabilities.NATURAL_MODE, true);
    this.addCapability(FanCapabilities.CHILD_LOCK, true);
    this.addCapability(FanCapabilities.POWER_OFF_TIMER, true);
    this.addCapability(FanCapabilities.POWER_OFF_TIMER_UNIT, 'seconds');
    this.addCapability(FanCapabilities.BUZZER_CONTROL, true);
    this.addCapability(FanCapabilities.LED_CONTROL, true);
  }

  addFanProperties() {
    this.defineProperty('power', 2, 1);
    this.defineProperty('fan_level', 2, 2);
    this.defineProperty('child_lock', 3, 1);
    this.defineProperty('swing_mode', 2, 3);
    this.defineProperty('swing_mode_angle', 2, 5);
    this.defineProperty('mode', 2, 7);
    this.defineProperty('power_off_time', 2, 10);
    this.defineProperty('light', 4, 3);
    this.defineProperty('buzzer', 5, 1);
  }

  // 알 수 없는 miot 팬의 폴백이라 무단계 fan_speed 의 siid/piid 를 알 수 없다.
  // 정의돼 있는 단계형 fan_level(1~4)을 25% 단위로 슬라이더에 매핑한다 (Level 버튼과 동일 속성).
  _percentToStage(p) { if (p <= 0) return 0; if (p <= 25) return 1; if (p <= 50) return 2; if (p <= 75) return 3; return 4; }
  _stageToPercent(s) { if (s <= 0) return 0; if (s >= 4) return 100; return s * 25; }

  isPowerOn() { return this.getFanProperties().power === true; }
  getRotationSpeed() { return this._stageToPercent(this.getSafePropertyValue(this.getFanProperties().fan_level, 0)); }
  getFanLevel() { return this.getFanProperties().fan_level; }
  isChildLockActive() { return this.getFanProperties().child_lock === true; }
  isSwingModeEnabled() { return this.getFanProperties().swing_mode === true; }
  getAngle() { return this.getFanProperties().swing_mode_angle; }
  isNaturalModeEnabled() { return this.getFanProperties().mode === 0; }
  isBuzzerEnabled() { return this.getFanProperties().buzzer === true; }
  isLedEnabled() { return this.getFanProperties().light === true; }
  getShutdownTimer() { return Math.ceil(this.getFanProperties().power_off_time / 60); }
  isShutdownTimerEnabled() { return this.getShutdownTimer() > 0; }

  async setPowerOn(power)            { return this.setProperty('power', power); }
  async setRotationSpeed(speed)      { let s = this._percentToStage(speed); if (s < 1) s = 1; return this.setProperty('fan_level', s); }
  async setFanLevel(level)           { return this.setProperty('fan_level', level); }
  async setChildLock(active)         { return this.setProperty('child_lock', active); }
  async setSwingModeEnabled(enabled) { return this.setProperty('swing_mode', enabled); }
  async setAngle(angle) {
    if (angle > 120) angle = 120;
    if (angle < 0) angle = 0;
    return this.setProperty('swing_mode_angle', angle);
  }
  async setNaturalModeEnabled(enabled) { return this.setProperty('mode', enabled ? 0 : 1); }
  async setBuzzerEnabled(enabled)      { return this.setProperty('buzzer', enabled); }
  async setLedEnabled(enabled)         { return this.setProperty('light', enabled); }
  async setShutdownTimer(minutes)      { return this.setProperty('power_off_time', minutes * 60); }
}

module.exports = MiotGenericFan;

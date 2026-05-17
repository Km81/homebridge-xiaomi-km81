'use strict';

const MiotFan = require('./MiotFan.js');
const FanCapabilities = require('../../FanCapabilities.js');

// dmaker.fan.p9, p10, p11, p15, p18, p30, p33, p220
class MiotDmakerDcFan extends MiotFan {
  constructor(miioDevice, model, deviceId, name, log) {
    super(miioDevice, model, deviceId, name, log);
  }

  initFanCapabilities() {
    this.addCapability(FanCapabilities.POWER_CONTROL, true);
    this.addCapability(FanCapabilities.FAN_SPEED_CONTROL, true);
    this.addCapability(FanCapabilities.FAN_LEVEL_CONTROL, true);
    this.addCapability(FanCapabilities.NUMBER_OF_FAN_LEVELS, 4);
    this.addCapability(FanCapabilities.OSCILLATION_CONTROL, true);
    this.addCapability(FanCapabilities.OSCILLATION_LEVEL_CONTROL, true);
    this.addCapability(FanCapabilities.LEFT_RIGHT_MOVE, true);
    this.addCapability(FanCapabilities.NATURAL_MODE, true);
    this.addCapability(FanCapabilities.CHILD_LOCK, true);
    this.addCapability(FanCapabilities.POWER_OFF_TIMER, true);
    this.addCapability(FanCapabilities.POWER_OFF_TIMER_UNIT, 'minutes');
    this.addCapability(FanCapabilities.BUZZER_CONTROL, true);
    this.addCapability(FanCapabilities.LED_CONTROL, true);

    if (this.model === 'dmaker.fan.p9') {
      this.addCapability(FanCapabilities.SLEEP_MODE, true);
      this.addCapability(FanCapabilities.OSCILLATION_LEVELS, [30, 60, 90, 120, 150]);
    } else {
      this.addCapability(FanCapabilities.OSCILLATION_LEVELS, [30, 60, 90, 120, 140]);
    }
  }

  addFanProperties() {
    this.defineProperty('power', 2, 1);
    this.defineProperty('fan_level', 2, 2);

    const fanModel = this.miioFanDevice.miioModel;

    if (fanModel === 'dmaker.fan.p9') {
      this.defineProperty('child_lock', 3, 1);
      this.defineProperty('fan_speed', 2, 11);
      this.defineProperty('swing_mode', 2, 5);
      this.defineProperty('swing_mode_angle', 2, 6);
      this.defineProperty('power_off_time', 2, 8);
      this.defineProperty('buzzer', 2, 7);
      this.defineProperty('light', 2, 9);
      this.defineProperty('mode', 2, 4);
      this.defineCommand('set_move', 2, 10);
    } else if (fanModel === 'dmaker.fan.p10' || fanModel === 'dmaker.fan.p18' || fanModel === 'dmaker.fan.p30') {
      this.defineProperty('child_lock', 3, 1);
      this.defineProperty('fan_speed', 2, 10);
      this.defineProperty('swing_mode', 2, 4);
      this.defineProperty('swing_mode_angle', 2, 5);
      this.defineProperty('power_off_time', 2, 6);
      this.defineProperty('buzzer', 2, 8);
      this.defineProperty('light', 2, 7);
      this.defineProperty('mode', 2, 3);
      this.defineCommand('set_move', 2, 9);
    } else if (fanModel === 'dmaker.fan.p220') {
      this.defineProperty('child_lock', 7, 1);
      this.defineProperty('fan_speed', 8, 1);
      this.defineProperty('swing_mode', 2, 4);
      this.defineProperty('swing_mode_angle', 2, 5);
      this.defineProperty('power_off_time', 3, 1);
      this.defineProperty('buzzer', 5, 1);
      this.defineProperty('light', 4, 1);
      this.defineProperty('mode', 2, 3);
      this.defineProperty('relative_humidity', 9, 2);
      this.defineProperty('temperature', 9, 1);
      this.defineCommand('set_move', 8, 3);
    } else {
      // p11, p15, p33
      this.defineProperty('child_lock', 7, 1);
      this.defineProperty('fan_speed', 2, 6);
      this.defineProperty('swing_mode', 2, 4);
      this.defineProperty('swing_mode_angle', 2, 5);
      this.defineProperty('power_off_time', 3, 1);
      this.defineProperty('buzzer', 5, 1);
      this.defineProperty('light', 4, 1);
      this.defineProperty('mode', 2, 3);
      this.defineCommand('set_move', 6, 1);
    }
  }

  isPowerOn() { return this.getFanProperties().power === true; }
  getRotationSpeed() { return this.getSafePropertyValue(this.getFanProperties().fan_speed, 0); }
  getFanLevel() { return this.getFanProperties().fan_level; }
  isChildLockActive() { return this.getFanProperties().child_lock === true; }
  isSwingModeEnabled() { return this.getFanProperties().swing_mode === true; }
  getAngle() { return this.getFanProperties().swing_mode_angle; }
  isNaturalModeEnabled() { return this.getFanProperties().mode === 1; }
  isSleepModeEnabled() { return this.getFanProperties().mode === 2; }
  isBuzzerEnabled() { return this.getFanProperties().buzzer === true; }
  isLedEnabled() { return this.getFanProperties().light === true; }
  getShutdownTimer() { return this.getFanProperties().power_off_time; }
  isShutdownTimerEnabled() { return this.getShutdownTimer() > 0; }

  async setPowerOn(power)              { return this.setProperty('power', power); }
  async setRotationSpeed(speed)        { return this.setProperty('fan_speed', speed); }
  async setFanLevel(level)             { return this.setProperty('fan_level', level); }
  async setChildLock(active)           { return this.setProperty('child_lock', active); }
  async setSwingModeEnabled(enabled)   { return this.setProperty('swing_mode', enabled); }
  async setAngle(angle) {
    if (angle > 140) angle = 140;
    if (angle < 0) angle = 0;
    return this.setProperty('swing_mode_angle', angle);
  }
  async setNaturalModeEnabled(enabled) { return this.setProperty('mode', enabled ? 1 : 0); }
  async setSleepModeEnabled(enabled)   { return this.setProperty('mode', enabled ? 2 : 0); }
  async moveLeft()                     { return this.sendCommnd('set_move', 1); }
  async moveRight()                    { return this.sendCommnd('set_move', 2); }
  async setBuzzerEnabled(enabled)      { return this.setProperty('buzzer', enabled); }
  async setLedEnabled(enabled)         { return this.setProperty('light', enabled); }
  async setShutdownTimer(minutes)      { return this.setProperty('power_off_time', minutes); }
}

module.exports = MiotDmakerDcFan;

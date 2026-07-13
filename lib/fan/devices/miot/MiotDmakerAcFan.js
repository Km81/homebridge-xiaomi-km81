'use strict';

const MiotFan = require('./MiotFan.js');
const FanCapabilities = require('../../FanCapabilities.js');

// dmaker.fan.1c, dmaker.fan.p8

class MiotDmakerAcFan extends MiotFan {
  constructor(miioDevice, model, deviceId, name, log) {
    super(miioDevice, model, deviceId, name, log);
  }

  initFanCapabilities() {
    this.addCapability(FanCapabilities.POWER_CONTROL, true);
    this.addCapability(FanCapabilities.FAN_LEVEL_CONTROL, true);
    this.addCapability(FanCapabilities.NUMBER_OF_FAN_LEVELS, 3);
    this.addCapability(FanCapabilities.OSCILLATION_CONTROL, true);
    this.addCapability(FanCapabilities.SLEEP_MODE, true);
    this.addCapability(FanCapabilities.CHILD_LOCK, true);
    this.addCapability(FanCapabilities.POWER_OFF_TIMER, true);
    this.addCapability(FanCapabilities.POWER_OFF_TIMER_UNIT, 'minutes');
    this.addCapability(FanCapabilities.BUZZER_CONTROL, true);
    this.addCapability(FanCapabilities.LED_CONTROL, true);
  }

  addFanProperties() {
    this.defineProperty('power', 2, 1);
    this.defineProperty('fan_level', 2, 2);
    this.defineProperty('child_lock', 3, 1);
    this.defineProperty('swing_mode', 2, 3);
    this.defineProperty('power_off_time', 2, 10);
    this.defineProperty('buzzer', 2, 11);
    this.defineProperty('light', 2, 12);
    this.defineProperty('mode', 2, 7);
  }

  isPowerOn() { return this.getFanProperties().power === true; }
  getFanLevel() { return this.getFanProperties().fan_level; }
  isChildLockActive() { return this.getFanProperties().child_lock === true; }
  isSwingModeEnabled() { return this.getFanProperties().swing_mode === true; }
  isSleepModeEnabled() { return this.getFanProperties().mode === 1; }
  isBuzzerEnabled() { return this.getFanProperties().buzzer === true; }
  isLedEnabled() { return this.getFanProperties().light === true; }
  getShutdownTimer() { return this.getFanProperties().power_off_time; }
  isShutdownTimerEnabled() { return this.getShutdownTimer() > 0; }

  async setPowerOn(power)              { return this.setProperty('power', power); }
  async setFanLevel(level)             { return this.setProperty('fan_level', level); }
  async setChildLock(active)           { return this.setProperty('child_lock', active); }
  async setSwingModeEnabled(enabled)   { return this.setProperty('swing_mode', enabled); }
  async setSleepModeEnabled(enabled)   { return this.setProperty('mode', enabled ? 1 : 0); }
  async setBuzzerEnabled(enabled)      { return this.setProperty('buzzer', enabled); }
  async setLedEnabled(enabled)         { return this.setProperty('light', enabled); }
  async setShutdownTimer(minutes)      { return this.setProperty('power_off_time', minutes); }
}

module.exports = MiotDmakerAcFan;

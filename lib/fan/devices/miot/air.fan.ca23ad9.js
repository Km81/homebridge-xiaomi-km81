'use strict';

const MiotFan = require('./MiotFan.js');
const FanCapabilities = require('../../FanCapabilities.js');

// air.fan.ca23ad9
class AirFanCa23ad9 extends MiotFan {
  constructor(miioDevice, model, deviceId, name, log) {
    super(miioDevice, model, deviceId, name, log);
  }

  initFanCapabilities() {
    this.addCapability(FanCapabilities.POWER_CONTROL, true);
    this.addCapability(FanCapabilities.FAN_LEVEL_CONTROL, true);
    this.addCapability(FanCapabilities.NUMBER_OF_FAN_LEVELS, 4); // 1-32 / 8
    this.addCapability(FanCapabilities.OSCILLATION_CONTROL, true);
    this.addCapability(FanCapabilities.OSCILLATION_VERTICAL_CONTROL, true);
  }

  addFanProperties() {
    this.defineProperty('power', 2, 1);
    this.defineProperty('fan_level', 2, 2);
    this.defineProperty('swing_mode', 2, 3);
    this.defineProperty('swing_mode_vertical', 2, 4);
    this.defineProperty('mode', 2, 5);
  }

  isPowerOn() { return this.getFanProperties().power === true; }
  getFanLevel() { return Math.floor(this.getFanProperties().fan_level / 8); }
  isSwingModeEnabled() { return this.getFanProperties().swing_mode === true; }
  isVerticalSwingModeEnabled() { return this.getFanProperties().swing_mode_vertical === true; }
  // setNaturalModeEnabled 가 자연풍을 mode=1 로 쓰므로 getter 도 1 로 맞춘다 (기존 2 는 setter 와 모순).
  isNaturalModeEnabled() { return this.getFanProperties().mode === 1; }

  async setPowerOn(power)                    { return this.setProperty('power', power); }
  async setFanLevel(level)                   { return this.setProperty('fan_level', level * 8); }
  async setSwingModeEnabled(enabled)         { return this.setProperty('swing_mode', enabled); }
  async setVerticalSwingModeEnabled(enabled) { return this.setProperty('swing_mode_vertical', enabled); }
  async setNaturalModeEnabled(enabled)       { return this.setProperty('mode', enabled ? 1 : 2); }
}

module.exports = AirFanCa23ad9;

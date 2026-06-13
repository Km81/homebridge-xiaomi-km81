'use strict';

const MiotFan = require('./MiotFan.js');
const FanCapabilities = require('../../FanCapabilities.js');

// xiaomi.fan.p45 - Xiaomi Smart Tower Fan 2
// spec: urn:miot-spec-v2:device:fan:0000A005:xiaomi-p45:1
//  - fan (siid 2): on(1), fault(2), mode(3), fan-level/gear(4),
//                  stepless fan-level(5), horizontal-swing(6),
//                  horizontal-swing-included-angle(7)
//  - indicator-light (siid 5): on(1)
//  - alarm (siid 7): alarm(1)
//  - physical-controls-locked (siid 11): locked(1)
//  - delay (siid 12): delay(1), delay-time(2, minutes), delay-remain-time(3)
//  - dm-service (siid 13): start-left(1), start-right(2)  -> 좌/우 이동
class XiaomiFanP45 extends MiotFan {
  constructor(miioDevice, model, deviceId, name, log) {
    super(miioDevice, model, deviceId, name, log);
  }

  initFanCapabilities() {
    this.addCapability(FanCapabilities.POWER_CONTROL, true);
    this.addCapability(FanCapabilities.FAN_SPEED_CONTROL, true);   // stepless 1-100
    this.addCapability(FanCapabilities.FAN_LEVEL_CONTROL, true);   // gear 1-4
    this.addCapability(FanCapabilities.NUMBER_OF_FAN_LEVELS, 4);
    this.addCapability(FanCapabilities.OSCILLATION_CONTROL, true);
    this.addCapability(FanCapabilities.OSCILLATION_LEVEL_CONTROL, true);
    this.addCapability(FanCapabilities.OSCILLATION_LEVELS, [30, 60, 90, 120, 150]);
    this.addCapability(FanCapabilities.LEFT_RIGHT_MOVE, true);
    this.addCapability(FanCapabilities.NATURAL_MODE, true);
    this.addCapability(FanCapabilities.SLEEP_MODE, true);
    this.addCapability(FanCapabilities.CHILD_LOCK, true);
    this.addCapability(FanCapabilities.POWER_OFF_TIMER, true);
    this.addCapability(FanCapabilities.POWER_OFF_TIMER_UNIT, 'minutes');
    this.addCapability(FanCapabilities.BUZZER_CONTROL, true);
    this.addCapability(FanCapabilities.LED_CONTROL, true);
  }

  addFanProperties() {
    this.defineProperty('power', 2, 1);
    this.defineProperty('mode', 2, 3);              // 0: 직풍, 1: 자연풍, 2: 수면
    this.defineProperty('fan_level', 2, 4);         // 단계 풍속 1-4
    this.defineProperty('fan_speed', 2, 5);         // 무단계 풍속 1-100
    this.defineProperty('swing_mode', 2, 6);
    this.defineProperty('swing_mode_angle', 2, 7);  // 30/60/90/120/150
    this.defineProperty('light', 5, 1);
    this.defineProperty('buzzer', 7, 1);
    this.defineProperty('child_lock', 11, 1);
    this.defineProperty('delay_enabled', 12, 1);
    this.defineProperty('power_off_time', 12, 2);   // 분 단위, 0-480
    this.defineCommand('move_left', 13, 1);         // start-left (write bool)
    this.defineCommand('move_right', 13, 2);        // start-right (write bool)
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
  getShutdownTimer() { return this.getSafePropertyValue(this.getFanProperties().power_off_time, 0); }
  isShutdownTimerEnabled() { return this.getShutdownTimer() > 0; }

  async setPowerOn(power)              { return this.setProperty('power', power); }
  async setRotationSpeed(speed)        { return this.setProperty('fan_speed', speed); }
  async setFanLevel(level)             { return this.setProperty('fan_level', level); }
  async setChildLock(active)           { return this.setProperty('child_lock', active); }
  async setSwingModeEnabled(enabled)   { return this.setProperty('swing_mode', enabled); }
  async setAngle(angle) {
    if (angle > 150) angle = 150;
    if (angle < 30) angle = 30;
    return this.setProperty('swing_mode_angle', angle);
  }
  async setNaturalModeEnabled(enabled) { return this.setProperty('mode', enabled ? 1 : 0); }
  async setSleepModeEnabled(enabled)   { return this.setProperty('mode', enabled ? 2 : 0); }
  async moveLeft()                     { return this.sendCommnd('move_left', true); }
  async moveRight()                    { return this.sendCommnd('move_right', true); }
  async setBuzzerEnabled(enabled)      { return this.setProperty('buzzer', enabled); }
  async setLedEnabled(enabled)         { return this.setProperty('light', enabled); }
  async setShutdownTimer(minutes) {
    if (minutes > 480) minutes = 480;
    if (minutes < 0) minutes = 0;
    await this.setProperty('delay_enabled', minutes > 0);
    return this.setProperty('power_off_time', minutes);
  }
}

module.exports = XiaomiFanP45;

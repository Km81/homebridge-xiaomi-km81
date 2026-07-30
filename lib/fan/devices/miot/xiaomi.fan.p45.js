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
    this.addCapability(FanCapabilities.FAN_SPEED_CONTROL, true);   // HomeKit 속도 슬라이더 (직풍=무단계 1~100, 자연풍=4단)
    this.addCapability(FanCapabilities.FAN_LEVEL_CONTROL, true);   // gear 1-4 (Level 1~4 버튼)
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
    this.defineProperty('fan_level', 2, 4);         // 기어 1-4 (Level 버튼 + 자연풍 풍속)
    this.defineProperty('fan_speed', 2, 5);         // 무단계 1-100 (직풍 풍속)
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

  /*
   * ──────────── 풍속 매핑 (모드 연동) ────────────
   * 기존 Smartmi 선풍기와 동일하게 HomeKit 회전속도 슬라이더를 모드에 따라 다르게
   * 다룬다:
   *   - 직풍/수면: 무단계(stepless) 1~100 그대로 (fan-level 2,5)
   *   - 자연풍: 기어 1~4 단계를 25/50/75/100% 로 양방향 매핑 (fan-level 2,4)
   *       HomeKit 0~25% → 1단계, 26~50% → 2단계, 51~75% → 3단계, 76~100% → 4단계
   *       1단계 → 25%, 2단계 → 50%, 3단계 → 75%, 4단계 → 100%
   * (Level 1~4 버튼은 모드와 무관하게 항상 기어 fan-level 을 직접 제어한다.)
   */
  _percentToStage(percent) {
    if (percent <= 0) return 0;
    if (percent <= 25) return 1;
    if (percent <= 50) return 2;
    if (percent <= 75) return 3;
    return 4;
  }

  _stageToPercent(stage) {
    if (stage <= 0) return 0;
    if (stage >= 4) return 100;
    return stage * 25;
  }

  isPowerOn() { return this.getFanProperties().power === true; }
  getRotationSpeed() {
    const fp = this.getFanProperties();
    if (this.isNaturalModeEnabled()) {
      // 자연풍: 기어 1~4 → 25/50/75/100%
      return this._stageToPercent(this.getSafePropertyValue(fp.fan_level, 0));
    }
    // 직풍/수면: 무단계 1~100 그대로
    return this.getSafePropertyValue(fp.fan_speed, 0);
  }
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

  // p45 mode: 0 직풍 / 1 자연풍 / 2 수면 — 명령 info 로그(`모드 → 자연풍`)용 라벨 (v2.2.2)
  _miotValueLabel(prop, value) {
    if (prop === 'mode') return ({ 0: '직풍', 1: '자연풍', 2: '수면' })[value] || null;
    return null;
  }

  async setPowerOn(power)              { return this.setProperty('power', power); }
  async setRotationSpeed(speed) {
    if (this.isNaturalModeEnabled()) {
      // 자연풍: HomeKit % → 기어 1~4 (유효범위 1~4, 0 은 무효)
      let stage = this._percentToStage(speed);
      if (stage < 1) stage = 1;
      return this.setProperty('fan_level', stage);
    }
    // 직풍/수면: 무단계 1~100
    let v = speed;
    if (v > 100) v = 100;
    if (v < 1) v = 1;
    return this.setProperty('fan_speed', v);
  }
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

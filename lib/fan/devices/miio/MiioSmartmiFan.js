'use strict';

const MiioFan = require('./MiioFan.js');
const FanCapabilities = require('../../FanCapabilities.js');

const SET_REFRESH_DELAY_MS = 1500;   // 자연풍/일반풍 set 후 refresh 까지 대기 (펌웨어 적용 시간 확보)
const COMMAND_GRACE_MS = 3000;       // 명령 직후 보호 구간: polling 이 stale 값으로 덮어쓰지 않도록
const DEDUP_WINDOW_MS = 800;         // 같은 명령 중복 전송 차단 window

class MiioSmartmiFan extends MiioFan {
  constructor(miioDevice, model, deviceId, name, log) {
    super(miioDevice, model, deviceId, name, log);
    this._pendingNaturalStage = null;
    this._pendingSpeedLevel = null;
    this._pendingExpire = 0;
    this._lastSentKey = null;
    this._lastSentAt = 0;
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

  /*
   * ──────────── 자연풍 단계 매핑 ────────────
   *
   * 구형 Smartmi 모델(zhimi.fan.v2/v3/sa1/za1/za3)의 펌웨어는 자연풍에서
   * 단계 1~4 를 표현할 때 모델 특유의 비균등 정수값을 사용한다 (실측):
   *
   *     1단계 → natural_level = 25
   *     2단계 → natural_level = 35
   *     3단계 → natural_level = 74
   *     4단계 → natural_level = 100
   *
   * HomeKit 슬라이더와는 다음과 같이 양방향 변환한다:
   *   - HomeKit 0~100% → 단계 1~4 → 펌웨어 값(25/35/74/100) 전송
   *   - 펌웨어가 보고한 값 → 가장 가까운 단계 → HomeKit 25/50/75/100% 표시
   */
  _naturalStageFirmwareValues() {
    return [0, 25, 35, 74, 100];
  }

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

  _stageToFirmwareValue(stage) {
    const values = this._naturalStageFirmwareValues();
    if (stage < 0) return 0;
    if (stage >= values.length) return values[values.length - 1];
    return values[stage];
  }

  _firmwareValueToStage(val) {
    if (val <= 0) return 0;
    const values = this._naturalStageFirmwareValues();
    let best = 1;
    let bestDist = Infinity;
    for (let s = 1; s < values.length; s++) {
      const d = Math.abs(val - values[s]);
      if (d < bestDist) { bestDist = d; best = s; }
    }
    return best;
  }

  getRotationSpeed() {
    const fp = this.getFanProperties();

    // ── 보호 구간 (Command Grace) ──
    // setRotationSpeed 직후 일정 시간(3s) 동안 사용자가 의도한 값을 우선 표시한다.
    // miio refresh / 정규 polling 이 디바이스가 아직 적용 못 한 stale 값을 읽어와
    // 캐시를 덮어써도 슬라이더가 튀지 않도록 한다. 폴링이 목표 단계에 도달한 것을
    // 확인하면 즉시 grace 를 해제하여 평소처럼 동작.
    const now = Date.now();
    if (this._pendingExpire > 0 && now < this._pendingExpire) {
      if (this._pendingNaturalStage != null) {
        const polledStage = (fp.natural_level > 0 && this._needsDiscreteNaturalLevels())
          ? this._firmwareValueToStage(fp.natural_level)
          : 0;
        if (polledStage === this._pendingNaturalStage) {
          this._pendingNaturalStage = null;
          this._pendingExpire = 0;
        } else {
          return this._stageToPercent(this._pendingNaturalStage);
        }
      } else if (this._pendingSpeedLevel != null) {
        if (fp.speed_level === this._pendingSpeedLevel) {
          this._pendingSpeedLevel = null;
          this._pendingExpire = 0;
        } else {
          return this.getSafePropertyValue(this._pendingSpeedLevel, 0);
        }
      }
    } else if (this._pendingExpire > 0) {
      this._pendingNaturalStage = null;
      this._pendingSpeedLevel = null;
      this._pendingExpire = 0;
    }

    let rotationValue = fp.speed_level;
    if (fp.natural_level > 0) {
      if (this._needsDiscreteNaturalLevels()) {
        const stage = this._firmwareValueToStage(fp.natural_level);
        rotationValue = this._stageToPercent(stage);
      } else {
        rotationValue = fp.natural_level;
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
    return this.sendCommand('set_power', powerState, ['power', 'ac_power'], 1000);
  }

  /*
   * setRotationSpeed:
   *  - 자연풍 (구형 모델): HomeKit % → 단계 → 펌웨어값(25/35/74/100) 전송
   *  - 일반풍: HomeKit % 그대로 전송
   *  - Grace period 3s 동안 폴링 stale read 무시
   *  - 같은 값 0.8s 안에 중복 전송 차단 (디바이스 rate-limit 회피)
   *  - refreshDelay 1500ms: 디바이스가 새 값을 적용할 시간 확보 (default 200ms 는 너무 짧음)
   */
  async setRotationSpeed(speed) {
    const isNatural = this.isNaturalModeEnabled();
    const setMethod = isNatural ? 'set_natural_level' : 'set_speed_level';
    let targetSpeed = speed;
    if (isNatural && this._needsDiscreteNaturalLevels()) {
      const stage = this._percentToStage(speed);
      targetSpeed = this._stageToFirmwareValue(stage);
      this.logInfo(`자연풍 풍량 설정: HomeKit ${speed}% → ${stage}단계 → ${setMethod}(${targetSpeed})`);
      this._pendingNaturalStage = stage;
      this._pendingSpeedLevel = null;
      this._pendingExpire = Date.now() + COMMAND_GRACE_MS;
    } else if (isNatural) {
      this.logInfo(`자연풍 풍량 설정 (연속값): ${setMethod}(${targetSpeed})`);
    } else {
      this.logDebug(`일반풍 풍량 설정: ${setMethod}(${targetSpeed})`);
      this._pendingSpeedLevel = targetSpeed;
      this._pendingNaturalStage = null;
      this._pendingExpire = Date.now() + COMMAND_GRACE_MS;
    }

    // 같은 명령 중복 차단
    const key = `${setMethod}:${targetSpeed}`;
    const now = Date.now();
    if (this._lastSentKey === key && (now - this._lastSentAt) < DEDUP_WINDOW_MS) {
      this.logDebug(`${key} 중복 명령 → 생략 (${now - this._lastSentAt}ms 전 동일 명령)`);
      return;
    }
    this._lastSentKey = key;
    this._lastSentAt = now;

    this.updateFanMode(isNatural, targetSpeed);
    return this.sendCommand(setMethod, targetSpeed, ['speed_level', 'natural_level'], SET_REFRESH_DELAY_MS);
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
      let stage = this._percentToStage(targetSpeed);
      if (stage === 0) stage = 1;
      const before = targetSpeed;
      targetSpeed = this._stageToFirmwareValue(stage);
      this.logInfo(`자연풍 ${enabled ? '켜기' : '끄기'}: HomeKit ${before}% → ${stage}단계 → ${setMethod}(${targetSpeed})`);
      this._pendingNaturalStage = stage;
      this._pendingSpeedLevel = null;
      this._pendingExpire = Date.now() + COMMAND_GRACE_MS;
    } else {
      this.logInfo(`자연풍 ${enabled ? '켜기' : '끄기'}: ${setMethod}(${targetSpeed})`);
    }
    this.updateFanMode(enabled, targetSpeed);
    return this.sendCommand(setMethod, targetSpeed, ['speed_level', 'natural_level'], SET_REFRESH_DELAY_MS);
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

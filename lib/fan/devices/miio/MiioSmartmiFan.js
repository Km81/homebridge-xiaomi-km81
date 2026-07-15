'use strict';

const MiioFan = require('./MiioFan.js');
const FanCapabilities = require('../../FanCapabilities.js');

const SET_REFRESH_DELAY_MS = 1500;   // 자연풍/일반풍 set 후 refresh 까지 대기 (펌웨어 적용 시간 확보)
const COMMAND_GRACE_MS = 4000;       // 명령 직후 보호 구간: polling 이 stale 값으로 덮어쓰지 않도록 (전 장비 4초 통일)
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
   * ──────────── 자연풍 단계 매핑 (모델별) ────────────
   *
   * Smartmi 모델 펌웨어는 자연풍 단계 1~4 를 표현할 때 모델 특유의 비균등
   * 정수값을 사용한다. 다음은 실측 기준 (HomeKit % 와 무관하게 디바이스
   * 펌웨어가 저장/전송하는 raw natural_level 값):
   *
   *   zhimi.fan.v2 / v3 / sa1 / za1 / za3
   *     1단계 → 25,  2단계 → 35,  3단계 → 74,  4단계 → 100
   *
   *   zhimi.fan.za4
   *     1단계 → 1,   2단계 → 35,  3단계 → 74,  4단계 → 100
   *     (1단계만 다름; za4 펌웨어는 1-25 어떤 값을 보내도 1단계로 처리하지만
   *      Mi Home 은 정확히 1 을 보내므로 그 값을 사용)
   *
   * HomeKit 슬라이더와는 다음과 같이 양방향 변환한다:
   *   - HomeKit 0~100% → 단계 1~4 → 모델별 펌웨어 값 전송
   *   - 펌웨어가 보고한 값 → 가장 가까운 단계 → HomeKit 25/50/75/100% 표시
   *
   * 다른 펌웨어 빌드가 약간 다른 값을 쓰더라도 nearest-distance 매핑이 가장
   * 가까운 단계로 스냅해 주므로 읽기는 견고하다.
   */
  _naturalStageFirmwareValues() {
    const model = this.getFanModel() || this.model || '';
    if (model === 'zhimi.fan.za4') {
      // za4: 1단계만 1 (다른 모델은 25)
      return [0, 1, 35, 74, 100];
    }
    // v2 / v3 / sa1 / za1 / za3 공통
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

  // 자연풍 단계 매핑을 적용해야 하는 Smartmi 모델 목록.
  // za4 는 펌웨어가 1-100 임의값을 받아도 자체 매핑해 주지만, 사용자가 HomeKit
  // 에서 v3 와 동일하게 25/50/75/100% 스냅을 보길 원해 단계 매핑에 포함시킴.
  _needsDiscreteNaturalLevels() {
    const model = this.getFanModel() || this.model || '';
    return (
      model === 'zhimi.fan.v2' ||
      model === 'zhimi.fan.v3' ||
      model === 'zhimi.fan.sa1' ||
      model === 'zhimi.fan.za1' ||
      model === 'zhimi.fan.za3' ||
      model === 'zhimi.fan.za4'
    );
  }

  async setPowerOn(power) {
    const powerState = power ? 'on' : 'off';
    this.updateProperty('power', powerState);
    return this.sendCommand('set_power', powerState, ['power', 'ac_power'], 1000);
  }

  /*
   * setRotationSpeed:
   *  - 자연풍 (Smartmi 전체): HomeKit % → 단계 → 모델별 펌웨어값 전송
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
      this.logInfo(`자연풍 풍량 → ${speed}% (${stage}/4단계, 기기값 ${targetSpeed})`);
      this.logDebug(`${setMethod}(${targetSpeed})`);
      this._pendingNaturalStage = stage;
      this._pendingSpeedLevel = null;
      this._pendingExpire = Date.now() + COMMAND_GRACE_MS;
    } else if (isNatural) {
      this.logInfo(`자연풍 풍량 → ${targetSpeed}% (연속)`);
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
      this.logInfo(`자연풍 켜기 → ${before}% (${stage}/4단계, 기기값 ${targetSpeed})`);
      this.logDebug(`${setMethod}(${targetSpeed})`);
      this._pendingNaturalStage = stage;
      this._pendingSpeedLevel = null;
      this._pendingExpire = Date.now() + COMMAND_GRACE_MS;
    } else {
      this.logInfo(enabled ? `자연풍 켜기 → 기기값 ${targetSpeed}` : `자연풍 끄기 → 일반풍 복귀 (기기값 ${targetSpeed})`);
      this.logDebug(`${setMethod}(${targetSpeed})`);
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

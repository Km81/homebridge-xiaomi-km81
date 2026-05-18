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

  /*
   * ──────────── 자연풍 단계 매핑 ────────────
   *
   * 구형 Smartmi 모델(zhimi.fan.v2/v3/sa1/za1/za3)의 펌웨어는 자연풍에서
   * 단계 1~4 를 표현할 때 모델 특유의 비균등 정수값을 사용한다 (실측 기준):
   *
   *     1단계 → natural_level = 25
   *     2단계 → natural_level = 35
   *     3단계 → natural_level = 74
   *     4단계 → natural_level = 100
   *
   * 위 값에 정확히 맞춰서 보내야 단계가 바뀌고, 그 외 값(예: 50, 75) 은
   * 무시되거나 가장 가까운 단계로 임의로 처리된다 (이 때문에 이전 25/50/75/100
   * 또는 1/2/3/4 매핑은 일부 단계만 동작했음).
   *
   * 따라서 다음과 같이 양방향 변환한다:
   *   - HomeKit 0~100% 슬라이더 → 단계 1~4 → 펌웨어 값(25/35/74/100) 전송
   *   - 펌웨어가 보고한 값 → 가장 가까운 단계 → HomeKit 25/50/75/100% 표시
   *
   * 다른 펌웨어 빌드가 다른 정수값을 쓰더라도 "가장 가까운 단계로 스냅" 하므로
   * 읽기는 견고하게 동작한다. 쓰기 값은 펌웨어와 정확히 맞아야 하므로 모델별
   * 차이가 발견되면 NATURAL_STAGE_VALUES 를 모델별로 분기하면 된다.
   */
  _naturalStageFirmwareValues() {
    return [0, 25, 35, 74, 100];   // index = 단계 (0=OFF, 1~4)
  }

  // HomeKit 슬라이더 퍼센트 → 단계 (0~4)
  _percentToStage(percent) {
    if (percent <= 0) return 0;
    if (percent <= 25) return 1;
    if (percent <= 50) return 2;
    if (percent <= 75) return 3;
    return 4;
  }

  // 단계 (0~4) → HomeKit 슬라이더 퍼센트 (0/25/50/75/100)
  _stageToPercent(stage) {
    if (stage <= 0) return 0;
    if (stage >= 4) return 100;
    return stage * 25;
  }

  // 단계 (1~4) → 펌웨어가 받는 natural_level 값
  _stageToFirmwareValue(stage) {
    const values = this._naturalStageFirmwareValues();
    if (stage < 0) return 0;
    if (stage >= values.length) return values[values.length - 1];
    return values[stage];
  }

  // 펌웨어가 보고한 natural_level → 가장 가까운 단계 (1~4)
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
    let rotationValue = fp.speed_level;
    if (fp.natural_level > 0) {
      if (this._needsDiscreteNaturalLevels()) {
        // 펌웨어가 25/35/74/100 같은 모델 특유 값을 보고 → 단계로 변환 후
        // HomeKit 슬라이더용 25/50/75/100% 으로 정규화해서 표시.
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

  // 자연풍에서 펌웨어가 임의의 1~100 퍼센트 값을 자체적으로 4단계로 매핑해
  // 주지 않는 구형 Smartmi 모델 목록 (zhimi.fan.za4 는 펌웨어가 처리).
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
    if (this.isNaturalModeEnabled() && this._needsDiscreteNaturalLevels()) {
      // HomeKit 0~100% → 단계 1~4 → 펌웨어 정수값 (25/35/74/100)
      const stage = this._percentToStage(speed);
      targetSpeed = this._stageToFirmwareValue(stage);
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
    // getRotationSpeed() 가 HomeKit 퍼센트(25/50/75/100) 를 돌려주므로
    // 자연풍으로 전환할 때 다시 단계 → 펌웨어 값으로 변환.
    let targetSpeed = this.getRotationSpeed();
    if (enabled && this._needsDiscreteNaturalLevels()) {
      let stage = this._percentToStage(targetSpeed);
      if (stage === 0) stage = 1;            // 자연풍 켤 때 최소 1단계
      targetSpeed = this._stageToFirmwareValue(stage);
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

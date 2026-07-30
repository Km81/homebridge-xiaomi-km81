'use strict';

/*
 * sim_v222_cmdlog.js — v2.2.2 "성공 명령 info 로그" 회귀 검증
 *
 * 검증 항목:
 *  A. CommandLog 사전 단위 검증 (miio / miot / purifier)
 *  B. MiioSmartmiFan 통합 — setter 별로 info 정확히 1줄, 자연풍은 의미 계층 1줄만(중복 0)
 *  C. MiotFan(p45) 통합 — setter info 1줄, mode 는 라벨 있는 클래스만, delay_enabled 침묵
 *  D. 폴링 경로 — 폴링/상태 조회는 새 info 를 한 줄도 만들지 않는다 (로그 총량 보호)
 *  E. AirPurifierAccessory.call — set_* 만 info, get_prop 침묵
 *
 * 실행: node test/sim_v222_cmdlog.js  (전부 통과 시 exit 0)
 * 주의: B~E 는 v2.2.1(수정 전) 코드에서 반드시 실패해야 한다(빈 테스트 방지 — git stash 로 확인).
 */

const assert = require('assert');

const tests = [];
function check(name, fn) { tests.push({ name, fn }); }

function mockLog() {
  const lines = { info: [], warn: [], error: [], debug: [] };
  return {
    lines,
    info: (m) => lines.info.push(String(m)),
    warn: (m) => lines.warn.push(String(m)),
    error: (m) => lines.error.push(String(m)),
    debug: (m) => lines.debug.push(String(m)),
  };
}

/*──────── A. 사전 단위 검증 ────────*/
const { fmtMiio, fmtMiot, fmtPurifier } = require('../lib/common/CommandLog.js');

check('[A] miio set_power on → 전원 → 켜짐', () => assert.strictEqual(fmtMiio('set_power', 'on'), '전원 → 켜짐'));
check('[A] miio set_power off → 전원 → 꺼짐', () => assert.strictEqual(fmtMiio('set_power', 'off'), '전원 → 꺼짐'));
check('[A] miio set_speed_level 60 → 풍량 → 60%', () => assert.strictEqual(fmtMiio('set_speed_level', 60), '풍량 → 60%'));
check('[A] miio set_angle 60 → 회전 각도 → 60°', () => assert.strictEqual(fmtMiio('set_angle', 60), '회전 각도 → 60°'));
check('[A] miio set_move left → 이동 → 왼쪽', () => assert.strictEqual(fmtMiio('set_move', 'left'), '이동 → 왼쪽'));
check('[A] miio set_buzzer 2 → 알림음 → 켜짐 (단계 2)', () => assert.strictEqual(fmtMiio('set_buzzer', 2), '알림음 → 켜짐 (단계 2)'));
check('[A] miio set_buzzer 0 → 알림음 → 꺼짐', () => assert.strictEqual(fmtMiio('set_buzzer', 0), '알림음 → 꺼짐'));
check('[A] miio set_led_b 0/1/2 → 밝게/어둡게/꺼짐', () => {
  assert.strictEqual(fmtMiio('set_led_b', 0), '조명 → 켜짐 (밝게)');
  assert.strictEqual(fmtMiio('set_led_b', 1), '조명 → 켜짐 (어둡게)');
  assert.strictEqual(fmtMiio('set_led_b', 2), '조명 → 꺼짐');
});
check('[A] miio set_poweroff_time 1800(초) → 꺼짐 타이머 → 30분', () => assert.strictEqual(fmtMiio('set_poweroff_time', 1800), '꺼짐 타이머 → 30분'));
check('[A] miio set_poweroff_time 0 → 해제', () => assert.strictEqual(fmtMiio('set_poweroff_time', 0), '꺼짐 타이머 → 해제'));
check('[A] miio P5 s_mode nature → 모드 → 자연풍', () => assert.strictEqual(fmtMiio('s_mode', 'nature'), '모드 → 자연풍'));
check('[A] miio 미등록 명령 → null (info 침묵)', () => assert.strictEqual(fmtMiio('set_unknown_cmd', 1), null));

check('[A] miot power true → 전원 → 켜짐', () => assert.strictEqual(fmtMiot('power', true), '전원 → 켜짐'));
check('[A] miot fan_speed 45 → 풍량 → 45%', () => assert.strictEqual(fmtMiot('fan_speed', 45), '풍량 → 45%'));
check('[A] miot fan_level 3 → 바람 단계 → 3단계', () => assert.strictEqual(fmtMiot('fan_level', 3), '바람 단계 → 3단계'));
check('[A] miot power_off_time 30(분) → 꺼짐 타이머 → 30분', () => assert.strictEqual(fmtMiot('power_off_time', 30), '꺼짐 타이머 → 30분'));
check('[A] miot mode 라벨 없으면 null / 있으면 표기', () => {
  assert.strictEqual(fmtMiot('mode', 1, null), null);
  assert.strictEqual(fmtMiot('mode', 1, '자연풍'), '모드 → 자연풍');
});
check('[A] miot delay_enabled → null (한 동작 두 줄 방지)', () => assert.strictEqual(fmtMiot('delay_enabled', true), null));
check('[A] miot move_left → 이동 → 왼쪽', () => assert.strictEqual(fmtMiot('move_left', true), '이동 → 왼쪽'));

check('[A] purifier 모드 번역 3종 — 자동/취침/수동 (2026-07-30 사용자 확정)', () => {
  assert.strictEqual(fmtPurifier('set_mode', ['auto']), '모드 → 자동');
  assert.strictEqual(fmtPurifier('set_mode', ['silent']), '모드 → 취침');
  assert.strictEqual(fmtPurifier('set_mode', ['favorite']), '모드 → 수동');
});
check('[A] purifier set_level_favorite 12 → 수동 풍량 → 12/16단계', () => assert.strictEqual(fmtPurifier('set_level_favorite', [12]), '수동 풍량 → 12/16단계'));
check('[A] purifier set_power on → 전원 → 켜짐', () => assert.strictEqual(fmtPurifier('set_power', ['on']), '전원 → 켜짐'));
check('[A] purifier get_prop → null (폴링 침묵)', () => assert.strictEqual(fmtPurifier('get_prop', [['power']]), null));

/*──────── B. MiioSmartmiFan 통합 ────────*/
const MiioSmartmiFan = require('../lib/fan/devices/miio/MiioSmartmiFan.js');

function makeSmartmiFan(props) {
  const log = mockLog();
  const fan = Object.create(MiioSmartmiFan.prototype);
  fan.log = log;
  fan.name = '테스트 선풍기';
  fan.model = 'zhimi.fan.v3';
  fan.deviceId = 'test';
  fan._pendingNaturalStage = null;
  fan._pendingSpeedLevel = null;
  fan._pendingExpire = 0;
  fan._lastSentKey = null;
  fan._lastSentAt = 0;
  const store = Object.assign({ power: 'off', natural_level: 0, speed_level: 40 }, props);
  fan.miioFanDevice = {
    calls: [],
    call(cmd, args, opts) { this.calls.push({ cmd, args, opts }); return Promise.resolve(['ok']); },
    setProperty(k, v) { store[k] = v; },
    miioProperties() { return store; },
  };
  return { fan, log, store };
}

check('[B] setPowerOn(true) → info 정확히 [전원 → 켜짐] 1줄', async () => {
  const { fan, log } = makeSmartmiFan();
  await fan.setPowerOn(true);
  assert.deepStrictEqual(log.lines.info, ['[테스트 선풍기] 전원 → 켜짐']);
});
check('[B] setPowerOn(false) → [전원 → 꺼짐]', async () => {
  const { fan, log } = makeSmartmiFan({ power: 'on' });
  await fan.setPowerOn(false);
  assert.deepStrictEqual(log.lines.info, ['[테스트 선풍기] 전원 → 꺼짐']);
});
check('[B] 일반풍 setRotationSpeed(60) → [풍량 → 60%] 1줄', async () => {
  const { fan, log } = makeSmartmiFan({ natural_level: 0 });
  await fan.setRotationSpeed(60);
  assert.deepStrictEqual(log.lines.info, ['[테스트 선풍기] 풍량 → 60%']);
});
check('[B] 자연풍 setRotationSpeed(50) → 의미 계층 1줄만 (전송 계층 중복 0)', async () => {
  const { fan, log } = makeSmartmiFan({ natural_level: 35 }); // 자연풍 켜진 상태
  await fan.setRotationSpeed(50);
  assert.strictEqual(log.lines.info.length, 1, `info ${log.lines.info.length}줄: ${JSON.stringify(log.lines.info)}`);
  assert.ok(/자연풍 풍량 → 50% \(2\/4단계, 기기값 35\)/.test(log.lines.info[0]), log.lines.info[0]);
});
check('[B] 자연풍 켜기 setNaturalModeEnabled(true) → 1줄만', async () => {
  const { fan, log } = makeSmartmiFan({ natural_level: 0, speed_level: 40 });
  await fan.setNaturalModeEnabled(true);
  assert.strictEqual(log.lines.info.length, 1, JSON.stringify(log.lines.info));
  assert.ok(log.lines.info[0].includes('자연풍 켜기'), log.lines.info[0]);
});
check('[B] 일반풍 같은 값 연타(dedup) → 전송 1회 = info 1줄', async () => {
  const { fan, log } = makeSmartmiFan({ natural_level: 0 });
  await fan.setRotationSpeed(60);
  await fan.setRotationSpeed(60); // 0.8s 내 동일 → 전송 생략
  const sends = fan.miioFanDevice.calls.filter(c => c.cmd === 'set_speed_level').length;
  assert.strictEqual(sends, 1, `전송 ${sends}회`);
  assert.strictEqual(log.lines.info.length, 1, JSON.stringify(log.lines.info));
});
check('[B] moveLeft → [이동 → 왼쪽]', async () => {
  const { fan, log } = makeSmartmiFan();
  await fan.moveLeft();
  assert.deepStrictEqual(log.lines.info, ['[테스트 선풍기] 이동 → 왼쪽']);
});
check('[B] setShutdownTimer(30분) → [꺼짐 타이머 → 30분]', async () => {
  const { fan, log } = makeSmartmiFan();
  await fan.setShutdownTimer(30);
  assert.deepStrictEqual(log.lines.info, ['[테스트 선풍기] 꺼짐 타이머 → 30분']);
});
check('[B] setSwingModeEnabled(true) → [회전 → 켜짐]', async () => {
  const { fan, log } = makeSmartmiFan();
  await fan.setSwingModeEnabled(true);
  assert.deepStrictEqual(log.lines.info, ['[테스트 선풍기] 회전 → 켜짐']);
});
check('[B] 명령 실패 시 info(의도) + warn(실패) 짝', async () => {
  const { fan, log } = makeSmartmiFan();
  fan.miioFanDevice.call = () => Promise.reject(new Error('timeout'));
  await fan.setPowerOn(true);
  assert.deepStrictEqual(log.lines.info, ['[테스트 선풍기] 전원 → 켜짐']);
  assert.strictEqual(log.lines.warn.length, 1, JSON.stringify(log.lines.warn));
});

/*──────── C. MiotFan (p45) 통합 ────────*/
const XiaomiFanP45 = require('../lib/fan/devices/miot/xiaomi.fan.p45.js');
const MiotFan = require('../lib/fan/devices/miot/MiotFan.js');

function makeP45(props) {
  const log = mockLog();
  const fan = Object.create(XiaomiFanP45.prototype);
  fan.log = log;
  fan.name = '거실 타워팬';
  fan.model = 'xiaomi.fan.p45';
  fan.deviceId = 'did-test';
  fan.properties = Object.assign({ power: false, mode: 0, fan_level: 1, fan_speed: 40 }, props);
  fan.propertiesDefs = {};
  fan.commandDefs = {};
  fan.addFanProperties(); // defineProperty/defineCommand 채움 (properties 초기값은 위에서 유지)
  Object.assign(fan.properties, { power: false, mode: 0, fan_level: 1, fan_speed: 40 }, props);
  fan.cloudConnected = false;
  fan.miioFanDevice = {
    calls: [],
    call(method, args) { this.calls.push({ method, args }); return Promise.resolve([{ code: 0 }]); },
  };
  return { fan, log };
}

check('[C] p45 setPowerOn(true) → [전원 → 켜짐] 1줄', async () => {
  const { fan, log } = makeP45();
  await fan.setPowerOn(true);
  assert.deepStrictEqual(log.lines.info, ['[거실 타워팬] 전원 → 켜짐']);
});
check('[C] p45 직풍 setRotationSpeed(45) → [풍량 → 45%]', async () => {
  const { fan, log } = makeP45({ mode: 0 });
  await fan.setRotationSpeed(45);
  assert.deepStrictEqual(log.lines.info, ['[거실 타워팬] 풍량 → 45%']);
});
check('[C] p45 자연풍 setRotationSpeed(50) → [바람 단계 → 2단계]', async () => {
  const { fan, log } = makeP45({ mode: 1 });
  await fan.setRotationSpeed(50);
  assert.deepStrictEqual(log.lines.info, ['[거실 타워팬] 바람 단계 → 2단계']);
});
check('[C] p45 setNaturalModeEnabled(true) → [모드 → 자연풍] (라벨 오버라이드)', async () => {
  const { fan, log } = makeP45();
  await fan.setNaturalModeEnabled(true);
  assert.deepStrictEqual(log.lines.info, ['[거실 타워팬] 모드 → 자연풍']);
});
check('[C] p45 setSleepModeEnabled(true) → [모드 → 수면]', async () => {
  const { fan, log } = makeP45();
  await fan.setSleepModeEnabled(true);
  assert.deepStrictEqual(log.lines.info, ['[거실 타워팬] 모드 → 수면']);
});
check('[C] p45 setShutdownTimer(60) → 1줄만 (delay_enabled 침묵)', async () => {
  const { fan, log } = makeP45();
  await fan.setShutdownTimer(60);
  assert.deepStrictEqual(log.lines.info, ['[거실 타워팬] 꺼짐 타이머 → 60분']);
});
check('[C] p45 moveLeft → [이동 → 왼쪽]', async () => {
  const { fan, log } = makeP45();
  await fan.moveLeft();
  assert.deepStrictEqual(log.lines.info, ['[거실 타워팬] 이동 → 왼쪽']);
});
check('[C] 라벨 없는 MiotFan 클래스의 mode 는 info 침묵 (오표기 방지)', async () => {
  const log = mockLog();
  const fan = Object.create(MiotFan.prototype);
  fan.log = log; fan.name = 'X'; fan.deviceId = 'd';
  fan.properties = {}; fan.propertiesDefs = { mode: { did: 'd', siid: 2, piid: 3 } }; fan.commandDefs = {};
  fan.cloudConnected = false;
  fan.miioFanDevice = { call: () => Promise.resolve([{ code: 0 }]) };
  await fan.setProperty('mode', 1);
  assert.deepStrictEqual(log.lines.info, []);
});
check('[C] p45 클라우드 경로도 동일 info (setPropertyCloud 분기 전 입구 로그)', async () => {
  const { fan, log } = makeP45();
  fan.cloudConnected = true;
  fan.cloudDid = 'did-test';
  fan.cloudCountry = 'cn';
  fan.miCloud = { miotSetProps: () => Promise.resolve([{ code: 0 }]) };
  await fan.setPowerOn(true);
  assert.deepStrictEqual(log.lines.info, ['[거실 타워팬] 전원 → 켜짐']);
});

/*──────── D. 폴링 경로 침묵 (로그 총량 보호) ────────*/
check('[D] p45 requestAllProperties 100회 → info 0줄', async () => {
  const { fan, log } = makeP45();
  for (let i = 0; i < 100; i++) await fan.requestAllProperties();
  assert.strictEqual(log.lines.info.length, 0, `폴링이 info ${log.lines.info.length}줄 생성`);
});
check('[D] Smartmi 폴링(pollProperties) 100회 → info 0줄', async () => {
  const { fan, log } = makeSmartmiFan();
  fan.miioFanDevice.poll = () => Promise.resolve([]);
  for (let i = 0; i < 100; i++) await fan.pollProperties();
  assert.strictEqual(log.lines.info.length, 0);
});

/*──────── E. AirPurifierAccessory.call ────────*/
const AirPurifierAccessory = require('../lib/airpurifier/AirPurifierAccessory.js');

function makePurifierThis() {
  const log = mockLog();
  const self = {
    log,
    config: { name: '침실 공기청정기' },
    device: { call: (m) => Promise.resolve(m === 'get_prop' ? [1, 2] : ['ok']) },
    logInfo(m) { log.info(`[${this.config.name}] ${m}`); },
    logWarn(m) { log.warn(`[${this.config.name}] ${m}`); },
    connectWithRetry: () => Promise.resolve(),
    scheduleReconnect: () => {},
  };
  return { self, log };
}

check('[E] purifier set_mode auto → [모드 → 자동] 1줄', async () => {
  const { self, log } = makePurifierThis();
  await AirPurifierAccessory.prototype.call.call(self, 'set_mode', ['auto']);
  assert.deepStrictEqual(log.lines.info, ['[침실 공기청정기] 모드 → 자동']);
});
check('[E] purifier set_power off → [전원 → 꺼짐]', async () => {
  const { self, log } = makePurifierThis();
  await AirPurifierAccessory.prototype.call.call(self, 'set_power', ['off']);
  assert.deepStrictEqual(log.lines.info, ['[침실 공기청정기] 전원 → 꺼짐']);
});
check('[E] purifier get_prop 100회 → info 0줄 (폴링 침묵)', async () => {
  const { self, log } = makePurifierThis();
  for (let i = 0; i < 100; i++) await AirPurifierAccessory.prototype.call.call(self, 'get_prop', [['power']]);
  assert.strictEqual(log.lines.info.length, 0);
});

/*──────── 러너 ────────*/
(async () => {
  let pass = 0, fail = 0;
  for (const t of tests) {
    try {
      await t.fn();
      pass++;
      console.log(`  ✓ ${t.name}`);
    } catch (e) {
      fail++;
      console.log(`  ✗ ${t.name}\n    → ${e.message}`);
    }
  }
  console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
  process.exit(fail ? 1 : 0);
})();

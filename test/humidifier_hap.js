'use strict';
/**
 * humidifier_hap.js — 가습기 홈킷 매핑을 **실제 hap-nodejs 로 생성해서** 잰다 (v2.5.0 신설 · v2.5.2 개편)
 *
 * 무엇을 고정하나:
 *   ① 모드 선택은 **「가습」 고정** — 「자동」을 두면 홈 앱이 목표 습도 슬라이더를 숨긴다(2.5.0~2.5.1 실사용).
 *   ② **스윙 모드 토글 = 자동**: 켬 ↔ 기기 자동 모드, 끔 ↔ 수동 단계(마지막 단계로 복귀).
 *      자동 모드가 없는 모델은 토글을 내지 않고, 캐시에 남은 것은 회수한다.
 *   ③ 회전속도 = 수동 단계만. 자동일 때 0. **0 으로 내리면 끈다**(켜기 직후의 0 은 무시).
 *   ④ 목표 습도 눈금 = 0~100. 기기 범위로 잘라 보내고 슬라이더도 그 값에 선다. **0 은 끈다.**
 *      ⛔되돌림은 쓰기 응답 **뒤에** 나간다(처리기 직후에는 아직 받은 값 그대로).
 *   ⑤ 어린이 잠금은 기본으로 안 나온다 — 회수하고, 폴링 반영이 되살리지 않는다
 *      (`updateCharacteristic` 은 선택 특성을 없으면 만든다).
 *
 * ⛔hap 을 못 찾으면 건너뛰지 않고 실패한다(put_away_hap.js 와 같은 규칙).
 * ⚠️통신은 전부 막는다 — connect 는 아무것도 안 하고, callSet 은 **기록만** 한다.
 */
const assert = require('assert');
const os = require('os');

function loadHap() {
  try { return require('@homebridge/hap-nodejs'); } catch (_) { /* 아래 */ }
  if (process.env.HAP_NODEJS_PATH) return require(process.env.HAP_NODEJS_PATH);
  console.log('FAIL hap-nodejs 를 찾지 못했다 — npm install(devDependencies) 또는 HAP_NODEJS_PATH 필요. 건너뛰지 않는다.');
  process.exit(1);
}
const hap = loadHap();
const S = hap.Service, C = hap.Characteristic;
const TS = C.TargetHumidifierDehumidifierState;
const SW = C.SwingMode;
const TH = C.RelativeHumidityHumidifierThreshold;

const HumidifierAccessory = require('../lib/humidifier/HumidifierAccessory.js');
const { MODELS } = require('../lib/humidifier/models.js');

// ── 통신 차단 + 쓰기 기록 ──
let calls = [];
let failNext = null;   // 다음 callSet 을 실패시킬 prop 키
for (const n of ['connect', 'scheduleReconnect', 'forceReconnect', 'startPollLoop', 'scheduleVerifyBurst']) {
  if (typeof HumidifierAccessory.prototype[n] !== 'function') throw new Error(`HumidifierAccessory.${n} 가 없다 — 코드가 바뀌었으면 시험도 고칠 것`);
  HumidifierAccessory.prototype[n] = function () {};
}
if (typeof HumidifierAccessory.prototype.callSet !== 'function') throw new Error('HumidifierAccessory.callSet 가 없다');
HumidifierAccessory.prototype.callSet = async function (key, value, call) {
  if (failNext === key) { failNext = null; throw new Error('시험 — 기기 거부'); }
  calls.push([key, value, call]);
  return ['ok'];
};

const SNAP = 15;   // 시험용 되돌림 지연(ms) — 실제는 600
let total = 0, failed = 0;
const made = [];
const t = async (name, fn) => {
  total++;
  try { calls = []; failNext = null; await fn(); console.log(`  ok   ${name}`); }
  catch (e) { failed++; console.log(`  FAIL ${name}\n       ${e && e.stack ? e.stack.split('\n').slice(0, 3).join(' / ') : e}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const settle = () => sleep(SNAP * 3 + 40);   // 되돌림 두 번(SNAP · SNAP×3)이 다 지나가게

let ipSeq = 10;
function mkCtx(accessories) {
  const api = {
    hap,
    user: { storagePath: () => os.tmpdir() },
    platformAccessory: function (name, uuid, category) { const a = new hap.Accessory(name, uuid); a.category = category; a.context = {}; return a; },
    registerPlatformAccessories() {}, unregisterPlatformAccessories() {}, updatePlatformAccessories() {},
  };
  const log = { info() {}, warn() {}, error() {}, debug() {} };
  return { api, log, hap, PLUGIN_NAME: 'p', PLATFORM_NAME: 'P', accessories: accessories || new Map(), packageVersion: '9.9.9', miCloud: null };
}
function mk(model, extra, accessories, ip) {
  const cfg = Object.assign({ name: 'Humidifier', ip: ip || `192.168.99.${ipSeq++}`, token: 'a'.repeat(32), model,
    enableTemperatureSensor: false, enableHumiditySensor: false }, extra || {});
  const h = new HumidifierAccessory(mkCtx(accessories), cfg);
  h.snapBackMs = SNAP;
  made.push(h);
  return { h, svc: h.accessory.getService(S.HumidifierDehumidifier) };
}
/** 폴링 결과가 들어온 것처럼 — 캐시에 넣고 화면에 반영 */
function feed(h, obj) { Object.assign(h.cache, obj); h.pushUpdates(); }
const val = (svc, Ch) => svc.getCharacteristic(Ch).value;
const write = (svc, Ch, v) => svc.getCharacteristic(Ch).handleSetRequest(v, undefined);
const tap = async (svc, Ch, v) => { await write(svc, Ch, v); await settle(); };

const CA1 = 'zhimi.humidifier.ca1';
const V1 = 'zhimi.humidifier.v1';
const CA1_ON = { power: 'on', mode: 'auto', humidity: 54, child_lock: 'off', dry: 'on', limit_hum: 50, depth: 85 };
const manual = (m) => Object.assign({}, CA1_ON, { mode: m });

(async () => {
  console.log('── ① 모드 선택: 「가습」 고정 ──');

  await t('★선택지는 「가습」 하나 — 「자동」을 두면 목표 습도 슬라이더가 사라진다', async () => {
    const { h, svc } = mk(CA1);
    assert.deepStrictEqual(svc.getCharacteristic(TS).props.validValues, [TS.HUMIDIFIER]);
    feed(h, CA1_ON);
    assert.strictEqual(val(svc, TS), TS.HUMIDIFIER, '기기가 자동인데 선택기가 「가습」이 아니다');
  });

  await t('★캐시에 「자동」(2.5.0~2.5.1)이 남아 있어도 「가습」으로 되돌린다', async () => {
    const accessories = new Map();
    const ip = '192.168.99.202';
    const a = mk(CA1, {}, accessories, ip);
    const ch = a.svc.getCharacteristic(TS);
    ch.setProps({ validValues: [TS.HUMIDIFIER_OR_DEHUMIDIFIER, TS.HUMIDIFIER] });
    ch.updateValue(TS.HUMIDIFIER_OR_DEHUMIDIFIER);
    const b = mk(CA1, {}, accessories, ip);
    assert.strictEqual(val(b.svc, TS), TS.HUMIDIFIER);
    assert.deepStrictEqual(b.svc.getCharacteristic(TS).props.validValues, [TS.HUMIDIFIER]);
  });

  console.log('── ② 스윙 모드 토글 = 자동 ──');

  await t('기기 자동 → 켬, 수동 단계 → 끔', async () => {
    const { h, svc } = mk(CA1);
    feed(h, CA1_ON);
    assert.strictEqual(val(svc, SW), SW.SWING_ENABLED);
    feed(h, { mode: 'medium' });
    assert.strictEqual(val(svc, SW), SW.SWING_DISABLED);
  });

  await t('켜면 기기를 자동 모드로 — 속도는 0 으로 보인다', async () => {
    const { h, svc } = mk(CA1);
    feed(h, manual('high'));
    await tap(svc, SW, SW.SWING_ENABLED);
    assert.deepStrictEqual(calls, [['mode', 'auto', 'set_mode']]);
    assert.strictEqual(val(svc, C.RotationSpeed), 0);
  });

  await t('★끄면 마지막 수동 단계로 돌아간다(재시작해도 남도록 컨텍스트에 저장)', async () => {
    const { h, svc } = mk(CA1);
    feed(h, manual('medium'));   // 수동 2단을 본 적이 있다
    feed(h, { mode: 'auto' });
    await tap(svc, SW, SW.SWING_DISABLED);
    assert.deepStrictEqual(calls, [['mode', 'medium', 'set_mode']]);
    assert.strictEqual(val(svc, C.RotationSpeed), 2);
    assert.strictEqual(h.accessory.context.humLastManualMode, 'medium', '마지막 단계를 컨텍스트에 남기지 않았다');
  });

  await t('수동 단계를 본 적이 없으면 가장 약한 단계로', async () => {
    const { h, svc } = mk(CA1);
    feed(h, CA1_ON);
    await tap(svc, SW, SW.SWING_DISABLED);
    assert.deepStrictEqual(calls, [['mode', 'silent', 'set_mode']]);
  });

  await t('이미 수동이면 꺼도 단계를 건드리지 않는다', async () => {
    const { h, svc } = mk(CA1);
    feed(h, manual('high'));
    await tap(svc, SW, SW.SWING_DISABLED);
    assert.deepStrictEqual(calls, []);
  });

  await t('기기가 거부하면 원래 모드로 되돌아간다', async () => {
    const { h, svc } = mk(CA1);
    feed(h, manual('high'));
    failNext = 'mode';
    await write(svc, SW, SW.SWING_ENABLED).catch(() => {});
    await settle();
    assert.strictEqual(h.cache.mode, 'high', '실패했는데 캐시가 자동으로 남았다');
  });

  await t('★자동 모드가 없는 모델(v1)은 토글이 없다 — 캐시에 남은 것도 회수, 폴링이 되살리지 않는다', async () => {
    const accessories = new Map();
    const ip = '192.168.99.203';
    const a = mk(V1, {}, accessories, ip);
    a.svc.getCharacteristic(SW);   // 옛 버전이 남긴 특성
    assert.strictEqual(a.svc.testCharacteristic(SW), true, '시험 전제');
    const b = mk(V1, {}, accessories, ip);
    assert.strictEqual(b.svc.testCharacteristic(SW), false, '회수하지 않았다');
    feed(b.h, { power: 'on', mode: 'high', dry: 'on' });
    assert.strictEqual(b.svc.testCharacteristic(SW), false, '폴링 반영이 되살렸다');
    assert.strictEqual(val(b.svc, C.RotationSpeed), 3);
  });

  await t('건조(dry) 값이 바뀌어도 토글은 모드만 따른다', async () => {
    const { h, svc } = mk(CA1);
    feed(h, manual('high'));
    feed(h, { dry: 'on' });
    assert.strictEqual(val(svc, SW), SW.SWING_DISABLED, '건조 값이 토글에 섞였다');
  });

  console.log('── ③ 회전속도: 수동 단계만 ──');

  await t('눈금은 수동 단계 수(3) — 자동 값은 빠진다', async () => {
    const { svc } = mk(CA1);
    const p = svc.getCharacteristic(C.RotationSpeed).props;
    assert.deepStrictEqual([p.minValue, p.maxValue, p.minStep], [0, 3, 1]);
  });

  await t('★자동이면 0, 수동이면 그 단계', async () => {
    const { h, svc } = mk(CA1);
    feed(h, CA1_ON);
    assert.strictEqual(val(svc, C.RotationSpeed), 0);
    for (const [m, n] of [['silent', 1], ['medium', 2], ['high', 3]]) {
      feed(h, { mode: m });
      assert.strictEqual(val(svc, C.RotationSpeed), n, `${m} → ${n} 이어야 한다`);
    }
  });

  await t('단계를 고르면 그 수동 모드로 — 토글이 꺼진다', async () => {
    const { h, svc } = mk(CA1);
    feed(h, CA1_ON);
    await tap(svc, C.RotationSpeed, 3);
    assert.deepStrictEqual(calls, [['mode', 'high', 'set_mode']]);
    assert.strictEqual(val(svc, SW), SW.SWING_DISABLED, '단계를 골랐는데 자동 토글이 켜져 있다');
  });

  await t('★0 으로 내리면 끈다 — 슬라이더는 실제 단계로 되돌아간다', async () => {
    const { h, svc } = mk(CA1);
    feed(h, manual('medium'));
    await tap(svc, C.RotationSpeed, 0);
    assert.deepStrictEqual(calls, [['power', 'off', 'set_power']]);
    assert.strictEqual(val(svc, C.Active), C.Active.INACTIVE);
    assert.strictEqual(val(svc, C.RotationSpeed), 2, '꺼진 뒤 슬라이더가 0 에 남았다(다음에 켜면 단계가 거짓)');
  });

  await t('⛔켜기 직후의 0 은 끄지 않는다(자동일 때 표시값 0 이 되돌아온 경우)', async () => {
    const { h, svc } = mk(CA1);
    feed(h, Object.assign({}, CA1_ON, { power: 'off' }));
    await write(svc, C.Active, C.Active.ACTIVE);
    await write(svc, C.RotationSpeed, 0);
    await settle();
    assert.deepStrictEqual(calls, [['power', 'on', 'set_power']], '켜자마자 껐다');
    assert.strictEqual(h.cache.power, 'on');
  });

  console.log('── ④ 목표 습도: 눈금 0~100, 기기 범위로 잘라 세운다 ──');

  await t('★눈금 = 0~100, 1 단위 (캐시에 옛 눈금이 남아 있어도 되돌린다)', async () => {
    const accessories = new Map();
    const ip = '192.168.99.201';
    const a = mk(CA1, {}, accessories, ip);
    a.svc.getCharacteristic(TH).setProps({ minValue: 0, maxValue: 80, minStep: 1 });   // 2.5.0 이 남긴 눈금
    const b = mk(CA1, {}, accessories, ip);
    const p = b.svc.getCharacteristic(TH).props;
    assert.deepStrictEqual([p.minValue, p.maxValue, p.minStep], [0, 100, 1]);
  });

  await t('★상한 위로 끌면 상한을 보내고 슬라이더도 상한에 선다', async () => {
    const { h, svc } = mk(CA1);
    feed(h, CA1_ON);
    await tap(svc, TH, 95);
    assert.deepStrictEqual(calls[calls.length - 1], ['limit_hum', 80, 'set_limit_hum'], '기기가 거부하는 값을 보냈다');
    assert.strictEqual(val(svc, TH), 80, '슬라이더가 95 에 남았다(기기는 80)');
  });

  await t('★하한 아래로 끌면 하한을 보내고 슬라이더도 하한에 선다', async () => {
    const { h, svc } = mk(CA1);
    feed(h, CA1_ON);
    await tap(svc, TH, 10);
    assert.deepStrictEqual(calls[calls.length - 1], ['limit_hum', 30, 'set_limit_hum'], '기기가 거부하는 값을 보냈다');
    assert.strictEqual(val(svc, TH), 30, '슬라이더가 10 에 남았다(기기는 30)');
  });

  await t('⛔되돌림은 쓰기 응답 뒤에 나간다 — 처리기 직후엔 아직 받은 값, 그 뒤에 한 번 더 강제로 알린다', async () => {
    const { h, svc } = mk(CA1);
    feed(h, CA1_ON);
    const ch = svc.getCharacteristic(TH);
    let forced = 0;
    const orig = ch.sendEventNotification.bind(ch);
    ch.sendEventNotification = (v, c) => { forced++; return orig(v, c); };
    await write(svc, TH, 95);
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(val(svc, TH), 95, '응답 전에 되돌렸다 — 홈 앱이 자기가 쓴 값으로 덮는다');
    await sleep(SNAP + 10);
    assert.strictEqual(val(svc, TH), 80, '응답 뒤에도 되돌리지 않았다');
    assert.strictEqual(forced, 0, '강제 알림이 너무 일찍 나갔다');
    await settle();
    assert.ok(forced >= 1, '두 번째 강제 알림이 없다(값이 같으면 hap 은 알림을 안 보낸다)');
  });

  await t('★0 으로 내리면 끈다 — 목표 습도는 쓰지 않고 슬라이더는 기기 값으로', async () => {
    const { h, svc } = mk(CA1);
    feed(h, CA1_ON);
    await tap(svc, TH, 0);
    assert.deepStrictEqual(calls, [['power', 'off', 'set_power']]);
    assert.strictEqual(val(svc, C.Active), C.Active.INACTIVE);
    assert.strictEqual(val(svc, TH), 50, '슬라이더가 0 에 남았다(기기 목표는 50)');
  });

  await t('기기 값을 그대로 보여 준다', async () => {
    const { h, svc } = mk(CA1);
    for (const v of [80, 30, 45]) {
      feed(h, Object.assign({}, CA1_ON, { limit_hum: v }));
      assert.strictEqual(val(svc, TH), v);
    }
  });

  await t('기본 설정: 바꾸면 자동 모드로 전환한 뒤 목표 습도를 쓴다', async () => {
    const { h, svc } = mk(CA1);
    feed(h, manual('high'));
    await tap(svc, TH, 60);
    assert.deepStrictEqual(calls, [['mode', 'auto', 'set_mode'], ['limit_hum', 60, 'set_limit_hum']]);
    assert.strictEqual(val(svc, SW), SW.SWING_ENABLED, '모드가 자동으로 바뀌었는데 토글이 따라오지 않았다');
    assert.strictEqual(val(svc, C.RotationSpeed), 0);
  });

  await t('★자동 전환을 끈 설정이면 모드는 건드리지 않는다(수동 단계 그대로 목표 습도만)', async () => {
    const { h, svc } = mk(CA1, { autoSwitchToHumidityMode: false });
    feed(h, manual('high'));
    await tap(svc, TH, 60);
    assert.deepStrictEqual(calls, [['limit_hum', 60, 'set_limit_hum']]);
    assert.strictEqual(val(svc, SW), SW.SWING_DISABLED);
    assert.strictEqual(val(svc, C.RotationSpeed), 3);
  });

  console.log('── ⑤ 어린이 잠금: 기본 미노출 + 회수 ──');

  await t('기본 설정이면 LockPhysicalControls 가 없고, 폴링 반영이 되살리지 않는다', async () => {
    const { h, svc } = mk(CA1);
    assert.strictEqual(svc.testCharacteristic(C.LockPhysicalControls), false);
    feed(h, CA1_ON);
    feed(h, { child_lock: 'on' });
    assert.strictEqual(svc.testCharacteristic(C.LockPhysicalControls), false, 'pushUpdates 가 되살렸다');
  });

  await t('★캐시에 남아 있던 잠금을 회수한다 · 옵션을 켜면 나오고 누르면 기기에 쓴다', async () => {
    const accessories = new Map();
    const ip = '192.168.99.200';
    const a = mk(CA1, { enableChildLock: true }, accessories, ip);
    feed(a.h, CA1_ON);
    assert.strictEqual(val(a.svc, C.LockPhysicalControls), C.LockPhysicalControls.CONTROL_LOCK_DISABLED);
    await tap(a.svc, C.LockPhysicalControls, C.LockPhysicalControls.CONTROL_LOCK_ENABLED);
    assert.deepStrictEqual(calls, [['child_lock', 'on', 'set_child_lock']]);
    const b = mk(CA1, {}, accessories, ip);
    assert.strictEqual(b.h.accessory, a.h.accessory, '시험 전제: 같은 액세서리를 재사용해야 한다');
    assert.strictEqual(b.svc.testCharacteristic(C.LockPhysicalControls), false, '회수하지 않았다');
  });

  console.log('── ⑥ 다른 모델 ──');

  await t('목표 습도가 없는 모델(shuii)도 자동 토글이 된다 · 단계 5', async () => {
    const { h, svc } = mk('shuii.humidifier.jsq001');
    assert.strictEqual(svc.getCharacteristic(C.RotationSpeed).props.maxValue, 5);
    feed(h, { power: 1, mode: 0 });
    assert.strictEqual(val(svc, SW), SW.SWING_ENABLED);
    await tap(svc, C.RotationSpeed, 5);
    assert.deepStrictEqual(calls, [['mode', 5, 'set_mode']]);
  });

  await t('★모델 표 전수: auto 값은 values 안에 있고, 목표습도 전환 값과 같다', async () => {
    let n = 0;
    for (const [name, m] of Object.entries(MODELS)) {
      if (m.alias) continue;
      n++;
      if (m.mode.auto !== undefined) assert.ok(m.mode.values.includes(m.mode.auto), `${name}: auto 값이 values 에 없다`);
      const sw = m.targetHumidity && m.targetHumidity.switchToMode;
      if (sw) assert.strictEqual(m.mode.auto, sw.value, `${name}: auto 와 switchToMode 가 다르다 — 목표 습도를 바꿔도 자동 토글이 안 켜진다`);
    }
    assert.ok(n >= 9, `모델을 ${n}개밖에 못 봤다 — 판정 무효`);
  });

  for (const h of made) h.shutdown();   // 남은 되돌림 타이머 정리
  console.log(`\nhumidifier_hap: ${total - failed}/${total} 통과`);
  process.exit(failed ? 1 : 0);
})();

'use strict';
/**
 * humidifier_hap.js — 가습기 홈킷 매핑을 **실제 hap-nodejs 로 생성해서** 잰다 (v2.5.0 신설)
 *
 * 무엇을 고정하나:
 *   ① 건조(SwingMode)·어린이 잠금(LockPhysicalControls)은 **기본으로 안 나온다** — 그리고
 *      캐시에 남아 있던 것을 **회수**한다. ⚠️폴링 반영(pushUpdates)이 회수한 특성을 되살리면 안 된다
 *      (`updateCharacteristic` 은 선택 특성을 없으면 만든다).
 *   ② 모드 선택 = 「자동 / 가습」. 자동 ↔ 기기 자동 모드, 가습 ↔ 수동 단계(마지막 단계로 복귀).
 *   ③ 회전속도 = 수동 단계만. 자동일 때 0.
 *   ④ 목표 습도 눈금 = 0~최대. 기기 하한 아래로 끌면 하한을 보내고 **슬라이더도 하한에 선다**.
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

let total = 0, failed = 0;
const t = async (name, fn) => {
  total++;
  try { calls = []; failNext = null; await fn(); console.log(`  ok   ${name}`); }
  catch (e) { failed++; console.log(`  FAIL ${name}\n       ${e && e.stack ? e.stack.split('\n').slice(0, 3).join(' / ') : e}`); }
};
const flush = async () => { for (let i = 0; i < 3; i++) await new Promise((r) => setImmediate(r)); };

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
  const ctx = mkCtx(accessories);
  const h = new HumidifierAccessory(ctx, cfg);
  return { h, svc: h.accessory.getService(S.HumidifierDehumidifier), ctx, cfg };
}
/** 폴링 결과가 들어온 것처럼 — 캐시에 넣고 화면에 반영 */
function feed(h, obj) { Object.assign(h.cache, obj); h.pushUpdates(); }
const val = (svc, Ch) => svc.getCharacteristic(Ch).value;
const tap = async (svc, Ch, v) => { await svc.getCharacteristic(Ch).handleSetRequest(v, undefined); await flush(); };

const CA1 = 'zhimi.humidifier.ca1';
const CA1_ON = { power: 'on', mode: 'auto', humidity: 54, child_lock: 'off', dry: 'on', limit_hum: 50, depth: 85 };

(async () => {
  console.log('── ① 건조·잠금: 기본 미노출 + 회수 ──');

  await t('기본 설정이면 SwingMode·LockPhysicalControls 가 없다', async () => {
    const { svc } = mk(CA1);
    assert.strictEqual(svc.testCharacteristic(C.SwingMode), false, 'SwingMode 가 있다');
    assert.strictEqual(svc.testCharacteristic(C.LockPhysicalControls), false, 'LockPhysicalControls 가 있다');
  });

  await t('★폴링 반영이 회수한 특성을 되살리지 않는다', async () => {
    const { h, svc } = mk(CA1);
    feed(h, CA1_ON);
    feed(h, { dry: 'off', child_lock: 'on' });
    assert.strictEqual(svc.testCharacteristic(C.SwingMode), false, 'pushUpdates 가 SwingMode 를 되살렸다');
    assert.strictEqual(svc.testCharacteristic(C.LockPhysicalControls), false, 'pushUpdates 가 LockPhysicalControls 를 되살렸다');
  });

  await t('★캐시에 남아 있던 특성을 회수한다(켰다가 끈 경우·옛 버전에서 올라온 경우)', async () => {
    const accessories = new Map();
    const ip = '192.168.99.200';
    const a = mk(CA1, { enableDryModeSwing: true, enableChildLock: true }, accessories, ip);
    assert.strictEqual(a.svc.testCharacteristic(C.SwingMode), true, '대조군: 켰는데 SwingMode 가 없다');
    assert.strictEqual(a.svc.testCharacteristic(C.LockPhysicalControls), true, '대조군: 켰는데 잠금이 없다');
    const b = mk(CA1, {}, accessories, ip);   // 같은 액세서리(캐시 복원)를 옵션 없이 다시
    assert.strictEqual(b.h.accessory, a.h.accessory, '시험 전제: 같은 액세서리를 재사용해야 한다');
    assert.strictEqual(b.svc.testCharacteristic(C.SwingMode), false, 'SwingMode 를 회수하지 않았다');
    assert.strictEqual(b.svc.testCharacteristic(C.LockPhysicalControls), false, '잠금을 회수하지 않았다');
  });

  await t('옵션을 켜면 나오고, 누르면 기기에 쓴다', async () => {
    const { h, svc } = mk(CA1, { enableDryModeSwing: true, enableChildLock: true });
    feed(h, CA1_ON);
    assert.strictEqual(val(svc, C.SwingMode), C.SwingMode.SWING_ENABLED);
    assert.strictEqual(val(svc, C.LockPhysicalControls), C.LockPhysicalControls.CONTROL_LOCK_DISABLED);
    await tap(svc, C.SwingMode, C.SwingMode.SWING_DISABLED);
    await tap(svc, C.LockPhysicalControls, C.LockPhysicalControls.CONTROL_LOCK_ENABLED);
    assert.deepStrictEqual(calls, [['dry', 'off', 'set_dry'], ['child_lock', 'on', 'set_child_lock']]);
  });

  console.log('── ② 모드 선택: 자동 / 가습 ──');

  await t('선택지는 「자동」「가습」 둘이다', async () => {
    const { svc } = mk(CA1);
    assert.deepStrictEqual(svc.getCharacteristic(TS).props.validValues, [TS.HUMIDIFIER_OR_DEHUMIDIFIER, TS.HUMIDIFIER]);
  });

  await t('기기 자동 → 「자동」, 기기 수동 단계 → 「가습」', async () => {
    const { h, svc } = mk(CA1);
    feed(h, CA1_ON);
    assert.strictEqual(val(svc, TS), TS.HUMIDIFIER_OR_DEHUMIDIFIER);
    feed(h, { mode: 'medium' });
    assert.strictEqual(val(svc, TS), TS.HUMIDIFIER);
  });

  await t('「자동」을 고르면 기기를 자동 모드로', async () => {
    const { h, svc } = mk(CA1);
    feed(h, Object.assign({}, CA1_ON, { mode: 'high' }));
    await tap(svc, TS, TS.HUMIDIFIER_OR_DEHUMIDIFIER);
    assert.deepStrictEqual(calls, [['mode', 'auto', 'set_mode']]);
    assert.strictEqual(val(svc, C.RotationSpeed), 0, '자동인데 속도가 0 이 아니다');
  });

  await t('★「가습」을 고르면 마지막 수동 단계로 돌아간다', async () => {
    const { h, svc } = mk(CA1);
    feed(h, Object.assign({}, CA1_ON, { mode: 'medium' }));   // 수동 2단을 본 적이 있다
    feed(h, { mode: 'auto' });
    await tap(svc, TS, TS.HUMIDIFIER);
    assert.deepStrictEqual(calls, [['mode', 'medium', 'set_mode']]);
    assert.strictEqual(val(svc, C.RotationSpeed), 2);
    assert.strictEqual(h.accessory.context.humLastManualMode, 'medium', '마지막 단계를 컨텍스트에 남기지 않았다(재시작하면 잊는다)');
  });

  await t('수동 단계를 본 적이 없으면 가장 약한 단계로', async () => {
    const { h, svc } = mk(CA1);
    feed(h, CA1_ON);
    await tap(svc, TS, TS.HUMIDIFIER);
    assert.deepStrictEqual(calls, [['mode', 'silent', 'set_mode']]);
  });

  await t('이미 수동이면 「가습」을 눌러도 단계를 건드리지 않는다', async () => {
    const { h, svc } = mk(CA1);
    feed(h, Object.assign({}, CA1_ON, { mode: 'high' }));
    await tap(svc, TS, TS.HUMIDIFIER);
    assert.deepStrictEqual(calls, []);
  });

  await t('기기가 거부하면 화면이 원래 모드로 되돌아간다', async () => {
    const { h, svc } = mk(CA1);
    feed(h, Object.assign({}, CA1_ON, { mode: 'high' }));
    failNext = 'mode';
    await svc.getCharacteristic(TS).handleSetRequest(TS.HUMIDIFIER_OR_DEHUMIDIFIER, undefined).catch(() => {});
    await flush();
    assert.strictEqual(h.cache.mode, 'high', '실패했는데 캐시가 자동으로 남았다');
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

  await t('단계를 고르면 그 수동 모드로(자동에서 빠져나온다)', async () => {
    const { h, svc } = mk(CA1);
    feed(h, CA1_ON);
    await tap(svc, C.RotationSpeed, 3);
    assert.deepStrictEqual(calls, [['mode', 'high', 'set_mode']]);
    assert.strictEqual(val(svc, TS), TS.HUMIDIFIER, '단계를 골랐는데 선택기가 「자동」에 남았다');
  });

  await t('0 을 써도 아무것도 보내지 않는다(전원은 Active 가 맡는다)', async () => {
    const { h, svc } = mk(CA1);
    feed(h, CA1_ON);
    await tap(svc, C.RotationSpeed, 0);
    assert.deepStrictEqual(calls, []);
  });

  console.log('── ④ 목표 습도: 눈금 0~최대 ──');

  await t('눈금 = 0~80, 1 단위', async () => {
    const { svc } = mk(CA1);
    const p = svc.getCharacteristic(C.RelativeHumidityHumidifierThreshold).props;
    assert.deepStrictEqual([p.minValue, p.maxValue, p.minStep], [0, 80, 1]);
  });

  await t('기기 값을 그대로 보여 준다(80 = 꽉 참, 30 = 30/80)', async () => {
    const { h, svc } = mk(CA1);
    for (const v of [80, 30, 45]) {
      feed(h, Object.assign({}, CA1_ON, { limit_hum: v }));
      assert.strictEqual(val(svc, C.RelativeHumidityHumidifierThreshold), v);
    }
  });

  await t('바꾸면 자동 모드로 전환한 뒤 목표 습도를 쓴다', async () => {
    const { h, svc } = mk(CA1);
    feed(h, Object.assign({}, CA1_ON, { mode: 'high' }));
    await tap(svc, C.RelativeHumidityHumidifierThreshold, 60);
    assert.deepStrictEqual(calls, [['mode', 'auto', 'set_mode'], ['limit_hum', 60, 'set_limit_hum']]);
    assert.strictEqual(val(svc, TS), TS.HUMIDIFIER_OR_DEHUMIDIFIER, '모드가 자동으로 바뀌었는데 선택기가 따라오지 않았다');
    assert.strictEqual(val(svc, C.RotationSpeed), 0);
  });

  await t('★하한 아래로 끌면 하한을 보내고 슬라이더도 하한에 선다', async () => {
    const { h, svc } = mk(CA1);
    feed(h, CA1_ON);
    await tap(svc, C.RelativeHumidityHumidifierThreshold, 10);
    assert.deepStrictEqual(calls[calls.length - 1], ['limit_hum', 30, 'set_limit_hum'], '기기가 거부하는 값을 보냈다');
    assert.strictEqual(val(svc, C.RelativeHumidityHumidifierThreshold), 30, '슬라이더가 10 에 남았다(기기는 30)');
  });

  await t('자동 전환을 끈 설정이면 모드는 건드리지 않는다', async () => {
    const { h, svc } = mk(CA1, { autoSwitchToHumidityMode: false });
    feed(h, Object.assign({}, CA1_ON, { mode: 'high' }));
    await tap(svc, C.RelativeHumidityHumidifierThreshold, 60);
    assert.deepStrictEqual(calls, [['limit_hum', 60, 'set_limit_hum']]);
  });

  console.log('── ⑤ 다른 모델 ──');

  await t('자동 모드가 없는 모델(v1)은 「가습」 고정 · 단계 3', async () => {
    const { h, svc } = mk('zhimi.humidifier.v1');
    assert.deepStrictEqual(svc.getCharacteristic(TS).props.validValues, [TS.HUMIDIFIER]);
    assert.strictEqual(svc.getCharacteristic(C.RotationSpeed).props.maxValue, 3);
    feed(h, { power: 'on', mode: 'high' });
    assert.strictEqual(val(svc, C.RotationSpeed), 3);
    assert.strictEqual(val(svc, TS), TS.HUMIDIFIER);
  });

  await t('목표 습도가 없는 모델(shuii)도 자동/가습이 된다 · 단계 5', async () => {
    const { h, svc } = mk('shuii.humidifier.jsq001');
    assert.deepStrictEqual(svc.getCharacteristic(TS).props.validValues, [TS.HUMIDIFIER_OR_DEHUMIDIFIER, TS.HUMIDIFIER]);
    assert.strictEqual(svc.getCharacteristic(C.RotationSpeed).props.maxValue, 5);
    feed(h, { power: 1, mode: 0 });
    assert.strictEqual(val(svc, TS), TS.HUMIDIFIER_OR_DEHUMIDIFIER);
    await tap(svc, C.RotationSpeed, 5);
    assert.deepStrictEqual(calls, [['mode', 5, 'set_mode']]);
  });

  await t('★모델 표 전수: auto 값은 values 안에 있고, 목표습도 전환 값과 같다', async () => {
    let n = 0;
    for (const [name, m] of Object.entries(MODELS)) {
      if (m.alias) continue;
      n++;
      if (m.mode.auto !== undefined) {
        assert.ok(m.mode.values.includes(m.mode.auto), `${name}: auto 값이 values 에 없다`);
      }
      const sw = m.targetHumidity && m.targetHumidity.switchToMode;
      if (sw) assert.strictEqual(m.mode.auto, sw.value, `${name}: auto 와 switchToMode 가 다르다 — 목표 습도를 바꿔도 「자동」으로 안 보인다`);
    }
    assert.ok(n >= 9, `모델을 ${n}개밖에 못 봤다 — 판정 무효`);
  });

  console.log(`\nhumidifier_hap: ${total - failed}/${total} 통과`);
  process.exit(failed ? 1 : 0);
})();

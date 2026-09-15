'use strict';
/**
 * put_away_hap.js — 「임시 연결해제」 5종을 **실제 hap-nodejs 로 생성해서** 잰다 (v2.4.1, 2026-09-15 신설)
 *
 * 왜 있나 — 2026-09-15 적대 리뷰(변이 시험)가 2.4.0 회귀의 구멍을 셋 찾았다:
 *   ①선풍기 배선: `FanAccessory` 가 설정값을 컨트롤러에 넘기는 줄을 지워도 25/25 통과
 *     (행동 회귀가 컨트롤러에 값을 **직접** 넣었다 — 배선은 한 번도 안 지났다)
 *   ②나머지 4종: 게이트를 `&& false` 로 끄거나 `return` 을 지워도 통과(구조 검사가 글자만 봤다)
 *     — 공기측정기는 `return` 이 빠지면 실제로 폴링한다
 *   ③공기청정기 자식 타일(별도 액세서리)은 봉인 밖 — 누르면 본체 타일이 0 으로 덮였다
 *   ⇒ 여기서는 **플랫폼과 같은 방식으로 생성자를 부르고**, 통신 진입점마다 계수기를 달고,
 *     홈 앱이 부르는 `handleGetRequest`·`handleSetRequest` 로 모든 타일을 읽고 누른다.
 *
 * ⛔hap 을 못 찾으면 **건너뛰지 않고 실패**한다. CI 는 devDependencies 로 설치한다.
 *   NAS 사본에서는 `HAP_NODEJS_PATH` 로 홈브릿지의 hap 을 가리킨다.
 * ★대조군: putAway 를 끈 같은 설정이 **실제로 통신 진입점을 부르는지** 함께 잰다.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const dgram = require('dgram');
const net = require('net');

function loadHap() {
  try { return require('@homebridge/hap-nodejs'); } catch (_) { /* 아래 */ }
  if (process.env.HAP_NODEJS_PATH) return require(process.env.HAP_NODEJS_PATH);
  console.log('FAIL hap-nodejs 를 찾지 못했다 — npm install(devDependencies) 또는 HAP_NODEJS_PATH 필요. 건너뛰지 않는다.');
  process.exit(1);
}
const hap = loadHap();
const S = hap.Service;
const INFO = S.AccessoryInformation.UUID;

// ── 통신 계수기 — 진입점 메서드 + 소켓 생성(최후 방어선) ──
const hits = [];
const spy = (Cls, names, ret) => {
  for (const n of names) {
    if (typeof Cls.prototype[n] !== 'function') throw new Error(`${Cls.name}.${n} 가 없다 — 코드가 바뀌었으면 계수기도 고칠 것`);
    Cls.prototype[n] = function () { hits.push(`${Cls.name}.${n}`); return ret(n); };
  }
};
const realUdp = dgram.createSocket, realTcp = net.connect;
dgram.createSocket = function (...a) { hits.push('dgram.createSocket'); return realUdp.apply(this, a); };
net.connect = function (...a) { hits.push('net.connect'); return realTcp.apply(this, a); };

const AirPurifierAccessory = require('../lib/airpurifier/AirPurifierAccessory.js');
const PowerStripAccessory = require('../lib/powerstrip/PowerStripAccessory.js');
const HumidifierAccessory = require('../lib/humidifier/HumidifierAccessory.js');
const AirMonitorAccessory = require('../lib/airmonitor/AirMonitorAccessory.js');
const FanAccessory = require('../lib/fan/FanAccessory.js');
const FanController = require('../lib/fan/FanController.js');
const { PUT_AWAY_SEAL_EMPTY } = require('../lib/common/putAway.js');

const noop = () => undefined;
const asyncFalse = () => Promise.resolve(false);
const asyncReject = () => Promise.reject(new Error('시험 — 통신 차단'));
spy(AirPurifierAccessory, ['connectWithRetry', 'refresh'], asyncFalse);
spy(AirPurifierAccessory, ['schedulePolling', 'scheduleReconnect'], noop);
spy(AirPurifierAccessory, ['call'], asyncReject);
spy(PowerStripAccessory, ['connect', 'scheduleReconnect', 'forceReconnect', 'startPollLoop'], noop);
spy(PowerStripAccessory, ['poll', 'miotSet', 'legacySetPower'], asyncReject);
spy(HumidifierAccessory, ['connect', 'scheduleReconnect', 'forceReconnect', 'startPollLoop'], noop);
spy(HumidifierAccessory, ['poll', 'callSet'], asyncReject);
spy(AirMonitorAccessory, ['startPolling'], noop);
spy(AirMonitorAccessory, ['pollOnce'], asyncReject);
spy(FanController, ['startFanDiscovery', 'startCloudMode', '_openConnection'], noop);

let total = 0, failed = 0;
const t = async (name, fn) => {
  total++;
  try { await fn(); console.log(`  ok   ${name}`); }
  catch (e) { failed++; console.log(`  FAIL ${name}\n       ${e && e.stack ? e.stack.split('\n').slice(0, 3).join(' / ') : e}`); }
};
const flush = async () => { for (let i = 0; i < 3; i++) await new Promise((r) => setImmediate(r)); };

function mkCtx() {
  const lines = [];
  const push = (lv) => (...a) => lines.push([lv, a.map(String).join(' ')]);
  const accessories = new Map();
  const api = {
    hap,
    user: { storagePath: () => os.tmpdir() },
    platformAccessory: function (name, uuid, category) { const a = new hap.Accessory(name, uuid); a.category = category; a.context = {}; return a; },
    registerPlatformAccessories() {}, unregisterPlatformAccessories() {}, updatePlatformAccessories() {},
  };
  const log = { info: push('info'), warn: push('warn'), error: push('error'), debug: push('debug') };
  return { ctx: { api, log, hap, PLUGIN_NAME: 'p', PLATFORM_NAME: 'P', accessories, packageVersion: '9.9.9', miCloud: null }, lines };
}

function otherValue(ch) {
  const v = ch.value, p = ch.props;
  if (typeof v === 'boolean') return !v;
  if (Array.isArray(p.validValues) && p.validValues.length > 1) return p.validValues.find((x) => x !== v);
  if (typeof p.minValue === 'number' && typeof p.maxValue === 'number') return v === p.minValue ? p.maxValue : p.minValue;
  return undefined;
}

function charsOf(accs) {
  const out = [];
  for (const a of accs) for (const s of a.services) {
    if (s.UUID === INFO) continue;
    for (const ch of s.characteristics) out.push(ch);
  }
  return out;
}

/** ★봉인 판정 — 전 액세서리: 처리기·리스너 0 · 읽기 = 마지막 값 · 모든 탭 뒤 **모든 값이 그대로** · 통신 0. */
async function assertSealed(accs, label, sensorOnly = false) {
  const chars = charsOf(accs);
  assert.ok(chars.length > 0, `${label}: 특성이 없다 — 판정할 것이 없다`);
  const snap = chars.map((ch) => ch.value);
  let taps = 0;
  for (const ch of chars) {
    const who = `${label} · ${ch.displayName}`;
    assert.strictEqual(ch.getHandler, undefined, `${who}: onGet 이 남았다`);
    assert.strictEqual(ch.listenerCount('get') + ch.listenerCount('set'), 0, `${who}: 옛 리스너가 남았다`);
    if (ch.props.perms.includes('pr') && ch.value !== null) {
      assert.strictEqual(await ch.handleGetRequest(), ch.value, `${who}: 마지막 값으로 답하지 않는다`);
      assert.strictEqual(ch.statusCode, 0, `${who}: statusCode 가 남았다(응답 없음)`);
    }
    if (ch.props.perms.includes('pw') && ch.value !== null) {
      const nv = otherValue(ch);
      if (nv === undefined) continue;
      await ch.handleSetRequest(nv, undefined);
      taps++;
    }
  }
  await flush();
  const after = chars.map((ch) => ch.value);
  chars.forEach((ch, i) => assert.strictEqual(after[i], snap[i],
    `${label} · ${ch.displayName}: 탭 뒤 값이 바뀌었다(${snap[i]} → ${after[i]}) — 거짓 마지막 상태·다른 타일 덮어쓰기`));
  if (!sensorOnly) assert.ok(taps > 0, `${label}: 누를 수 있는 특성을 하나도 못 눌렀다 — 판정 무효`);
  return taps;
}

const IP = () => `10.79.0.${Math.floor(Math.random() * 250) + 1}`;
const TOKEN = '0123456789abcdef0123456789abcdef';

const CASES = [
  {
    name: '공기청정기(자식 타일 5개 포함)', Cls: AirPurifierAccessory, entry: 'AirPurifierAccessory.connectWithRetry',
    cfg: () => ({ name: 'Purifier', ip: IP(), token: TOKEN, type: 'MiAirPurifier2S',
      showTemperature: true, separateTemperatureAccessory: true, showHumidity: true, separateHumidityAccessory: true,
      showAirQuality: true, separateAirQualityAccessory: true, showLED: true, separateLedAccessory: true,
      showBuzzer: true, separateBuzzerAccessory: true }),
    minAccessories: 6,
  },
  { name: '멀티탭', Cls: PowerStripAccessory, entry: 'PowerStripAccessory.connect',
    cfg: () => ({ name: 'Strip', ip: IP(), token: TOKEN, model: 'cuco.plug.v3' }), minAccessories: 1 },
  { name: '가습기', Cls: HumidifierAccessory, entry: 'HumidifierAccessory.connect',
    cfg: () => ({ name: 'Humidifier', ip: IP(), token: TOKEN, model: 'zhimi.humidifier.ca1' }), minAccessories: 1 },
  { name: '공기측정기', Cls: AirMonitorAccessory, entry: 'AirMonitorAccessory.startPolling',
    cfg: () => ({ name: 'Monitor', ip: IP(), token: TOKEN }), minAccessories: 1, sensorOnly: true },
  { name: '선풍기(설정→컨트롤러 배선 포함)', Cls: FanAccessory, entry: 'FanController.startFanDiscovery',
    cfg: () => ({ name: 'Fan', ip: IP(), token: TOKEN, deviceId: '123456789', model: 'zhimi.fan.za4',
      prefsDir: fs.mkdtempSync(path.join(os.tmpdir(), 'km81fan-')) }), minAccessories: 1 },
];

(async () => {
  console.log('put_away_hap — 실제 hap-nodejs 로 임시 연결해제 5종 확인 (xiaomi)');

  for (const c of CASES) {
    await t(`[대조군] ${c.name} — putAway 가 아니면 통신 진입점(${c.entry})을 부른다`, async () => {
      hits.length = 0;
      const { ctx } = mkCtx();
      const h = new c.Cls(ctx, c.cfg());
      await flush();
      assert.ok(hits.includes(c.entry), `진입점이 안 불렸다(${hits.join(',') || '없음'}) — 이 시험은 무의미하다`);
      try { h.shutdown && h.shutdown(); } catch (_) { /* 시험 정리 */ }
    });

    await t(`★★${c.name} — putAway: 통신 0 · 전 액세서리 봉인 · 읽기=마지막 값 · 탭=되돌림`, async () => {
      hits.length = 0;
      const { ctx, lines } = mkCtx();
      const h = new c.Cls(ctx, { ...c.cfg(), putAway: true });
      await flush();
      const accs = [...ctx.accessories.values()];
      assert.ok(accs.length >= c.minAccessories, `액세서리가 ${accs.length}개 — ${c.minAccessories}개 이상이어야 한다`);
      await assertSealed(accs, c.name, !!c.sensorOnly);
      await new Promise((r) => setTimeout(r, 30));
      assert.deepStrictEqual(hits, [], `통신이 나갔다: ${hits.join(',')}`);
      assert.ok(!lines.some(([, l]) => l.indexOf(PUT_AWAY_SEAL_EMPTY) !== -1), '봉인 0건 경고가 나왔다');
      try { h.shutdown && h.shutdown(); } catch (_) { /* 시험 정리 */ }
    });
  }

  console.log(`\n총 ${total}건 · 실패 ${failed}건`);
  process.exit(failed ? 1 : 0);
})();

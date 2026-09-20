'use strict';
/**
 * reconnect_backoff.js — 기기가 오래 끊겼을 때 **재연결이 물러설 줄 아는가** (v2.4.2, 2026-09-20 신설)
 *
 * 왜 있나 — 9/20 로그 분석에서 공기청정기 한 대가 39분 끊긴 동안 **115줄**을 쏟았다.
 *   원인은 바깥 재연결이 `고정 30초` 로 남아 있던 것. 멀티탭·가습기·선풍기는 이미
 *   지수 백오프로 고쳐졌는데 **공기청정기만 미전파**였다(= 이 저장소가 반복해 밟는 유형).
 *   ⇒ 여기서 두 가지를 박는다:
 *     ① 행동 — 백오프 창 안에서는 **다시 시도하지도, 로그를 남기지도 않는다**
 *        (⛔게이트가 `connectWithRetry` **입구**에 있어야 한다. 폴링 루프와 `call()` 이
 *          타이머를 거치지 않고 이 메서드를 직접 부르므로, 타이머에만 달면 무효다)
 *     ② 구조 — 세 종류(청정기·멀티탭·가습기)가 **모두** 지수 백오프를 쓴다(전파 가드)
 *
 * ⛔어휘 계약 — `hb_watch` 는 「연결 실패」로 사망을, 「연결됨」으로 복구를 판정한다.
 *   그래서 **조용히 하려고 실패를 통째로 숨기면 안 된다**(실패 줄이 2시간 끊기면 감시기가
 *   「판단 보류」로 들어가 진짜 사망을 놓친다). 아래 ⑤가 그 상한을 지킨다.
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

// ── miio 를 가짜로 바꾼다(실제 소켓 0) ──────────────────────────────────
let CONNECT_OK = false;
let connectCalls = 0;
class FakeMiio {
  constructor(ip, token, _x, type) { this.ip = ip; this.miioModel = type || 'FakeModel'; }
  connect() {
    connectCalls++;
    return CONNECT_OK ? Promise.resolve(this)
      : Promise.reject(new Error('Could not connect to device, handshake timeout'));
  }
  destroy() {}
  call() { return Promise.reject(new Error('시험 — 통신 차단')); }
}
const lmPath = require.resolve('../lib/common/LocalMiioDevice.js');
require.cache[lmPath] = { id: lmPath, filename: lmPath, loaded: true, exports: FakeMiio };

const AirPurifierAccessory = require('../lib/airpurifier/AirPurifierAccessory.js');
AirPurifierAccessory.prototype.schedulePolling = function () {};   // 시험 결정성 — 15초 루프 정지

// ── 가짜 시계 ───────────────────────────────────────────────────────────
const realNow = Date.now;
let NOW = 1700000000000;
Date.now = () => NOW;

let total = 0, failed = 0;
const t = async (name, fn) => {
  total++;
  try { await fn(); console.log(`  ok   ${name}`); }
  catch (e) { failed++; console.log(`  FAIL ${name}\n       ${e && e.stack ? e.stack.split('\n').slice(0, 3).join(' / ') : e}`); }
};
const flush = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); };

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

const CFG = () => ({ name: 'Purifier', ip: '10.79.0.9', token: '0123456789abcdef0123456789abcdef', type: 'MiAirPurifier2S' });
const count = (lines, s) => lines.filter(([, l]) => l.indexOf(s) !== -1).length;
/**
 * ⛔감시기가 **실제로 읽는** 줄만 센다 — `debug` 는 홈브릿지 로그 파일에 안 남는다.
 *   실패를 debug 로 낮춰 조용하게 만드는 것은 「조용해진 것」이 아니라 **감시기를 눈멀게 하는 것**이다.
 */
const countVisible = (lines, s) => lines.filter(([lv, l]) => l.indexOf(s) !== -1 && (lv === 'warn' || lv === 'error' || lv === 'info')).length;
const unref = (acc) => { if (acc.reconnectTimer && acc.reconnectTimer.unref) acc.reconnectTimer.unref(); };

/**
 * 끊긴 상태에서 한 기기를 ms 만큼 방치한다.
 * ⛔★실제와 같게 **15초마다** 두드린다 — 폴링 루프가 그 주기로 `refresh()` 를 부르고,
 *   `refresh()` 는 device 가 없으면 곧바로 `connectWithRetry()` 로 간다. 백오프 창이
 *   열릴 때만 호출하도록 시험을 짜면 **게이트를 지워도 통과**해 버린다(변이 M1 로 확인).
 */
const POLL_MS = 15000;
async function endure(acc, ms) {
  const end = NOW + ms;
  while (NOW < end) {
    NOW = Math.min(end, NOW + POLL_MS);
    await acc.connectWithRetry();
    await flush();
    unref(acc);
  }
}

(async () => {
  console.log('reconnect_backoff — 오래 끊겼을 때 재연결이 물러서는가 (xiaomi)');

  // ① 한 주기 = 한 번만 두드리고 한 줄만 남긴다 (2.4.1 은 5회/10줄이었다)
  await t('① 연결 실패 한 주기 = 시도 1회 · 로그 2줄', async () => {
    CONNECT_OK = false; connectCalls = 0;
    const { ctx, lines } = mkCtx();
    const acc = new AirPurifierAccessory(ctx, CFG());
    await flush(); unref(acc);
    assert.strictEqual(connectCalls, 1, `한 주기에 ${connectCalls}번 두드렸다 — 1번이어야 한다`);
    assert.strictEqual(count(lines, '연결 시도'), 1, '「연결 시도」가 1줄이 아니다');
    assert.strictEqual(count(lines, '연결 실패'), 1, '「연결 실패」가 1줄이 아니다');
    acc.shutdown();
  });

  // ②★핵심 — 백오프 창 안에서는 다시 두드리지도, 로그를 남기지도 않는다.
  //   (게이트가 타이머에만 있으면 여기서 20번 다 두드린다 = 2.4.1 의 실제 증상)
  await t('②★백오프 창 안에서는 20번 불러도 통신 0 · 로그 0', async () => {
    CONNECT_OK = false; connectCalls = 0;
    const { ctx, lines } = mkCtx();
    const acc = new AirPurifierAccessory(ctx, CFG());
    await flush(); unref(acc);
    const c0 = connectCalls, l0 = lines.length;
    for (let i = 0; i < 20; i++) {
      assert.strictEqual(await acc.connectWithRetry(), false, '백오프 중인데 true 를 냈다');
      assert.strictEqual(await acc.refresh(), undefined, 'refresh 가 백오프를 뚫었다');
    }
    await flush(); unref(acc);
    assert.strictEqual(connectCalls, c0, `백오프 창에서 ${connectCalls - c0}번 더 두드렸다`);
    assert.strictEqual(lines.length, l0, `백오프 창에서 로그가 ${lines.length - l0}줄 늘었다`);
    acc.shutdown();
  });

  // ③ 지연이 두 배씩 늘고 상한에서 멈춘다
  await t('③ 지연 = 1.5초에서 두 배씩 · 상한 10분', async () => {
    CONNECT_OK = false;
    const { ctx } = mkCtx();
    const acc = new AirPurifierAccessory(ctx, CFG());
    await flush(); unref(acc);
    const got = [];
    for (let i = 0; i < 12; i++) {
      got.push(acc._nextConnectAt - NOW);
      NOW = acc._nextConnectAt;
      await acc.connectWithRetry(); await flush(); unref(acc);
    }
    const want = [1500, 3000, 6000, 12000, 24000, 48000, 96000, 192000, 384000, 600000, 600000, 600000];
    assert.deepStrictEqual(got, want, `지연이 ${JSON.stringify(got)} — 두 배씩 늘고 10분에서 멈춰야 한다`);
    acc.shutdown();
  });

  // ④★9/19 재현 — 39분 끊김. 2.4.1 실측 115줄.
  await t('④★39분 끊김에 로그 30줄 이하 (2.4.1 실측 115줄)', async () => {
    CONNECT_OK = false; connectCalls = 0;
    const { ctx, lines } = mkCtx();
    const acc = new AirPurifierAccessory(ctx, CFG());
    await flush(); unref(acc);
    await endure(acc, 39 * 60 * 1000);
    const n = lines.length;
    assert.ok(n <= 30, `39분에 ${n}줄 — 30줄 이하여야 한다(2.4.1 = 115줄)`);
    assert.ok(connectCalls <= 15, `39분에 ${connectCalls}번 두드렸다 — 15번 이하여야 한다`);
    acc.shutdown();
  });

  // ⑤⛔감시기 계약 — 조용해졌다고 침묵하면 안 된다.
  await t('⑤⛔실패 줄이 10분보다 오래 끊기지 않는다 (hb_watch 가 「판단 보류」로 빠진다)', async () => {
    CONNECT_OK = false;
    const { ctx, lines } = mkCtx();
    const acc = new AirPurifierAccessory(ctx, CFG());
    await flush(); unref(acc);
    const stamp = [];
    const seen = () => { while (stamp.length < countVisible(lines, '연결 실패')) stamp.push(NOW); };
    seen();
    await (async () => {
      const end = NOW + 6 * 60 * 60 * 1000;   // 6시간 방치 (실제와 같게 15초마다 두드린다)
      while (NOW < end) {
        NOW = Math.min(end, NOW + POLL_MS);
        await acc.connectWithRetry(); await flush(); unref(acc); seen();
      }
    })();
    let worst = 0;
    for (let i = 1; i < stamp.length; i++) worst = Math.max(worst, stamp[i] - stamp[i - 1]);
    assert.ok(stamp.length >= 30, `6시간에 실패 줄이 ${stamp.length}개뿐 — 감시기가 먹을 것이 없다`);
    assert.ok(worst <= 10 * 60 * 1000 + 30000, `실패 줄이 ${Math.round(worst / 60000)}분 끊겼다 — 10분을 넘으면 안 된다`);
    acc.shutdown();
  });

  // ⑥ 복구 — 「연결됨」 어휘가 남고 백오프가 풀린다
  await t('⑥ 복구하면 「연결됨」이 찍히고 다음 실패는 다시 1.5초부터', async () => {
    CONNECT_OK = false;
    const { ctx, lines } = mkCtx();
    const acc = new AirPurifierAccessory(ctx, CFG());
    await flush(); unref(acc);
    await endure(acc, 20 * 60 * 1000);
    assert.ok(acc._connectAttempt > 3, '실패 횟수가 안 쌓였다 — 이 시험은 무의미하다');
    CONNECT_OK = true;
    NOW = acc._nextConnectAt;
    assert.strictEqual(await acc.connectWithRetry(), true, '연결이 살아났는데 false 를 냈다');
    await flush();
    assert.strictEqual(count(lines, '연결됨'), 1, '「연결됨」이 1줄이 아니다 — hb_watch 의 복구 어휘다');
    assert.strictEqual(acc._connectAttempt, 0, '성공했는데 실패 횟수가 안 풀렸다');
    assert.strictEqual(acc._nextConnectAt, 0, '성공했는데 백오프 창이 안 풀렸다');
    assert.strictEqual(acc.reconnectTimer, null, '성공했는데 재연결 타이머가 남았다');
    CONNECT_OK = false;
    acc.device = null;
    await acc.connectWithRetry(); await flush(); unref(acc);
    assert.strictEqual(acc._nextConnectAt - NOW, 1500, '복구 뒤 첫 지연이 1.5초가 아니다');
    acc.shutdown();
  });

  // ⑦ 구조 — 세 종류 전부 지수 백오프인가 (미전파 가드)
  await t('⑦ 청정기·멀티탭·가습기 전부 지수 백오프 · 고정 간격 상수 없음', async () => {
    const fs = require('fs');
    const path = require('path');
    const strip = (src) => {
      let out = '', i = 0, q = null;
      while (i < src.length) {
        const c = src[i], n = src[i + 1];
        if (q) { out += c; if (c === '\\') { out += n || ''; i += 2; continue; } if (c === q) q = null; i += 1; continue; }
        if (c === '/' && n === '/') { while (i < src.length && src[i] !== '\n') { out += ' '; i += 1; } continue; }
        if (c === '/' && n === '*') { const e = src.indexOf('*/', i + 2), stop = e === -1 ? src.length : e + 2; for (; i < stop; i++) out += src[i] === '\n' ? '\n' : ' '; continue; }
        if (c === '\'' || c === '"' || c === '`') q = c;
        out += c; i += 1;
      }
      return out;
    };
    const files = {
      '공기청정기': 'airpurifier/AirPurifierAccessory.js',
      '멀티탭': 'powerstrip/PowerStripAccessory.js',
      '가습기': 'humidifier/HumidifierAccessory.js',
    };
    for (const [label, rel] of Object.entries(files)) {
      const src = strip(fs.readFileSync(path.join(__dirname, '..', 'lib', rel), 'utf8'));
      assert.ok(/Math\.pow\(2/.test(src), `${label}: 지수 백오프(Math.pow(2 …)가 없다`);
      assert.ok(/Math\.min\(/.test(src), `${label}: 백오프 상한(Math.min)이 없다`);
      assert.ok(!/RECONNECT_INTERVAL_MS/.test(src), `${label}: 고정 간격 상수가 살아 있다 — 이게 9/19 의 원인이었다`);
    }
    const ap = strip(fs.readFileSync(path.join(__dirname, '..', 'lib', files['공기청정기']), 'utf8'));
    assert.ok(/_nextConnectAt\s*&&\s*Date\.now\(\)\s*<\s*this\._nextConnectAt/.test(ap),
      '공기청정기: 백오프 게이트가 connectWithRetry 입구에 없다 — 타이머에만 달면 무효다');
  });

  Date.now = realNow;
  console.log(`\n총 ${total}건 · 실패 ${failed}건`);
  process.exit(failed ? 1 : 0);
})();

'use strict';

/**
 * put_away.js — 「임시 연결해제(putAway)」 토글 회귀 (v2.3.2, 2026-09-14)
 *
 * 왜 이 회귀가 있나:
 *   이 기능의 목적은 **로그를 안 내는 것**이다. 그런데 로그 문구는 NAS 감시기(hb_watch)의
 *   API 라서, 여기서 실수로 감시 어휘를 한 조각이라도 내보내면
 *   **감시에서 빼려고 만든 기능이 감시를 깨우는** 일이 된다.
 *   ★주석으로 적은 규칙은 안 지켜진다 — 그래서 회귀로 박는다.
 *
 * ⚠️이 스위트에는 **대조군이 반드시 있어야 한다.** "통신이 0건이다"는, 애초에 아무것도
 *   실행되지 않아도 참이 된다(잘 도는데 0건). 그래서 putAway 를 끈 같은 컨트롤러가
 *   **실제로 연결을 시도하는지**를 같이 잰다. 대조군이 실패하면 이 스위트 전체가 무의미하다.
 *
 * ⛔★★2.4.0 의 이 스위트는 초록인데 구멍이 셋 있었다(2026-09-15 적대 리뷰 변이 시험) —
 *   선풍기 배선 · 게이트 `&& false`/`return` 삭제 · 주석화된 게이트. 모두 통과했다.
 *   ⇒ 구조 검사는 주석을 벗기고 재고, **실제 hap 으로 5종 생성자를 돌리는 시험**을 `put_away_hap.js` 에 두었다.
 *
 * 실행: node test/put_away.js   (의존 패키지가 필요하다 — miio)
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const { isPutAway, PUT_AWAY_MESSAGE, PUT_AWAY_SEAL_EMPTY, sealForPutAway } = require('../lib/common/putAway.js');
const FanController = require('../lib/fan/FanController.js');

/**
 * ★NAS 감시기 `/volume1/.Script/hb_watch/hb_watch.sh` 가 homebridge.log 에서 찾는 어휘.
 *   2026-09-14 정본에서 그대로 추출했다(🟡 클라우드 / 🔴 폴링 / localdead / offline / OFFFAIL).
 * ⚠️감시기 쪽이 어휘를 늘리면 이 목록도 함께 늘려야 한다 — 어휘는 두 방의 계약이다.
 */
const WATCH_VOCAB = [
  '폴링 실패', '상태 조회 실패', '상태 폴링 오류', '연결 실패', '폴링 중 오류', '상태 조회 오류',
  '사실상 클라우드로 동작 중', '제어되지 않습니다', '폴링 복구', '상태 조회 복구', '연결됨',
  '로컬 복귀', '수신 복귀', '기기 접속됨', '실시간 조회 복구', '사용량 조회 복구', '폴링 회복됨',
  '첫 폴링 성공', '기기 온라인 복귀', '기기 오프라인',
  '로컬 재탐색', '로컬 복구 확인', '클라우드로 폴백', '보안연결 실패',
  '끄기 재시도 실패', '기기가 켜진 채', '켜진 상태로 남았습니다',
];

function vocabHits(lines) {
  const hits = [];
  for (const line of lines) {
    for (const v of WATCH_VOCAB) if (line.indexOf(v) !== -1) hits.push(`${v} :: ${line}`);
  }
  return hits;
}

/** 로그를 받아 적기만 하는 가짜 로거. */
function makeLog() {
  const lines = { info: [], warn: [], error: [], debug: [] };
  const push = (k) => (...a) => lines[k].push(a.map(String).join(' '));
  return {
    lines,
    all: () => [].concat(lines.info, lines.warn, lines.error),   // debug 는 운영 로그에 안 남는다
    info: push('info'), warn: push('warn'), error: push('error'), debug: push('debug'),
  };
}

const CFG = {
  ip: '192.168.1.37',
  token: '0'.repeat(32),
  deviceId: '123456789',
  model: 'zhimi.fan.za4',
  name: '테스트 선풍기',
};

function newController(log) {
  return new FanController(CFG.ip, CFG.token, CFG.deviceId, CFG.model, CFG.name, 5000, log);
}

/* ------------------------------------------------------------------ */

let total = 0, failed = 0;
function check(name, fn) {
  total++;
  try { fn(); console.log(`  ok   ${name}`); }
  catch (e) { failed++; console.log(`  FAIL ${name}\n       ${e && e.message}`); }
}

console.log('put_away — 임시 연결해제 토글 회귀');

/* ---- 1. 설정 해석 ---- */
check('putAway 는 불리언 true 에만 켜진다', () => {
  assert.strictEqual(isPutAway({ putAway: true }), true);
  assert.strictEqual(isPutAway({ putAway: false }), false);
  assert.strictEqual(isPutAway({}), false);
  assert.strictEqual(isPutAway(null), false);
  assert.strictEqual(isPutAway(undefined), false);
  // ⚠️문자열은 받지 않는다 — 조용히 켜지는 것보다 조용히 꺼지는 편(감시가 계속 도는 쪽)이 안전하다
  assert.strictEqual(isPutAway({ putAway: 'true' }), false);
  assert.strictEqual(isPutAway({ putAway: 1 }), false);
});

/* ---- 1-A. ★계측기 자체 시험 ---- */
/* ⚠️「감시 어휘 0건」은 탐지기가 고장나도 참이 된다. 탐지기가 진짜 잡는지 먼저 잰다. */
check('[계측기] 어휘 탐지기가 실제로 잡는다', () => {
  assert.ok(vocabHits(['[민서 선풍기] 폴링 실패 (3회)']).length > 0, '폴링 실패를 못 잡는다');
  assert.ok(vocabHits(['[승준 선풍기] 로컬 재탐색 5회 실패 — 25분째 클라우드로 동작 중입니다']).length > 0,
    '선풍기 경보를 만든 바로 그 문구를 못 잡는다');
  assert.ok(vocabHits(['[정수기] 기기 오프라인']).length > 0, '기기 오프라인을 못 잡는다');
  assert.strictEqual(vocabHits(['[테스트] 아무 일도 없었다']).length, 0, '멀쩡한 줄을 잡는다(오탐)');
  assert.ok(WATCH_VOCAB.length >= 20, `어휘 목록이 ${WATCH_VOCAB.length}개뿐이다 — 감시기 정본과 대조할 것`);
});

/* ---- 2. 안내 문구에 감시 어휘가 없다 ---- */
check('PUT_AWAY_MESSAGE 에 감시 어휘가 하나도 없다', () => {
  const hits = vocabHits([PUT_AWAY_MESSAGE]);
  assert.deepStrictEqual(hits, [], `문구에 감시 어휘가 섞였다:\n${hits.join('\n')}`);
});

/* ---- 3. 임시 연결해제한 기기는 통신을 시작하지 않는다 ---- */
check('putAway=true 면 연결을 한 번도 열지 않는다', () => {
  const log = makeLog();
  const fc = newController(log);
  fc._openConnection = () => { throw new Error('연결이 열렸다 — putAway 가 통신을 막지 못했다'); };
  fc.putAway = true;
  fc.connectToFan();                     // 열렸다면 위 throw 가 여기로 나온다
  assert.strictEqual(fc._shutdown, true, '_shutdown 이 안 세워졌다(재연결이 부활할 수 있다)');
  assert.strictEqual(fc.pollTimer, undefined, '폴링 타이머가 살아 있다');
  assert.strictEqual(fc._retryTimer, undefined, '재연결 타이머가 살아 있다');
  assert.strictEqual(fc._localProbeTimer, undefined, '로컬 재탐색 타이머가 살아 있다');
  fc.shutdown();
});

check('putAway=true 로 남는 로그는 안내 한 줄뿐이고 감시 어휘가 없다', () => {
  const log = makeLog();
  const fc = newController(log);
  fc._openConnection = () => { throw new Error('연결이 열렸다'); };
  fc.putAway = true;
  fc.connectToFan();
  const out = log.all();
  const hits = vocabHits(out);
  assert.deepStrictEqual(hits, [], `감시 어휘가 로그에 나왔다:\n${hits.join('\n')}`);
  assert.strictEqual(log.lines.info.length, 1, `info 가 ${log.lines.info.length}줄이다(1줄이어야 한다): ${out.join(' | ')}`);
  assert.ok(log.lines.info[0].indexOf(PUT_AWAY_MESSAGE) !== -1, '안내 문구가 안 찍혔다');
  assert.ok(log.lines.info[0].indexOf(CFG.name) !== -1, '기기 이름이 안 붙었다(어느 기기인지 알 수 없다)');
  assert.strictEqual(log.lines.warn.length, 0, 'warn 이 찍혔다');
  assert.strictEqual(log.lines.error.length, 0, 'error 가 찍혔다');
  fc.shutdown();
});

check('putAway=true 여도 서비스용 디바이스 객체는 만든다(홈킷 타일 보존)', () => {
  const log = makeLog();
  const fc = newController(log);
  fc._openConnection = () => { throw new Error('연결이 열렸다'); };
  fc.putAway = true;
  fc.connectToFan();
  assert.ok(fc.fanDevice, 'fanDevice 가 없다 — 새 액세서리에 서비스가 안 붙는다');
  // ⛔단 "연결된 것"으로 보이면 안 된다. 게터가 옛 값을 진짜 상태처럼 내보내면 거짓말이 된다.
  assert.strictEqual(fc.fanDevice.isFanConnected(), false, '미연결이어야 한다');
  fc.shutdown();
});

check('model 이 없어도 putAway 면 통신하지 않는다', () => {
  const log = makeLog();
  const fc = new FanController(CFG.ip, CFG.token, CFG.deviceId, '', CFG.name, 5000, log);
  fc._openConnection = () => { throw new Error('연결이 열렸다') ; };
  fc.putAway = true;
  fc.connectToFan();
  assert.strictEqual(fc._shutdown, true);
  assert.deepStrictEqual(vocabHits(log.all()), []);
  fc.shutdown();
});

/* ---- 4. ★대조군 — 이게 실패하면 위 3번은 아무것도 증명하지 않는다 ---- */
check('[대조군] putAway 가 꺼져 있으면 실제로 연결을 시도한다', () => {
  const log = makeLog();
  const fc = newController(log);
  let opened = 0;
  fc._openConnection = () => { opened++; throw new Error('대조군: 연결 차단'); };
  let threw = null;
  try { fc.connectToFan(); } catch (e) { threw = e; }
  assert.strictEqual(opened, 1, `대조군이 연결을 시도하지 않았다(opened=${opened}) — 이 스위트는 아무것도 재지 못한다`);
  assert.ok(threw && /대조군/.test(threw.message), '대조군 경로가 연결 지점까지 가지 않았다');
  fc.shutdown();
});

/* ---- 5. 나머지 4종: 게이트가 통신 시작보다 앞에 있는가 (구조 회귀) ---- */
/* ⚠️이건 동작 시험이 아니라 **구조 시험**이다. 네 종류는 HAP 스텁이 없어 생성자를 돌릴 수 없다.
 *   "게이트가 사라졌다 / 통신 시작 뒤로 밀렸다"를 잡는 것이 목적이고, 그 이상은 주장하지 않는다.
 *   ★실물 확인은 배포 뒤 로그로 한다(우리 회귀는 우리 가정 안에서만 참이다). */
const GATED = [
  ['lib/airpurifier/AirPurifierAccessory.js', 'this.connectWithRetry().then('],
  ['lib/powerstrip/PowerStripAccessory.js', '    this.connect();'],
  ['lib/humidifier/HumidifierAccessory.js', '    this.connect();'],
  ['lib/airmonitor/AirMonitorAccessory.js', 'this.startPolling();'],
];
for (const [rel, startCall] of GATED) {
  check(`${path.basename(rel)} — 게이트가 통신 시작보다 앞에 있다`, () => {
    const src = fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
    const g = src.indexOf('isPutAway(config)');
    const c = src.indexOf(startCall);
    assert.ok(src.indexOf("require('../common/putAway.js')") !== -1, 'putAway.js 를 안 읽는다');
    assert.ok(g !== -1, 'isPutAway(config) 게이트가 없다');
    assert.ok(c !== -1, `통신 시작 지점을 못 찾았다(${startCall}) — 코드가 바뀌었으면 이 회귀도 고칠 것`);
    assert.ok(g < c, '게이트가 통신 시작보다 뒤에 있다 — 한 바퀴는 통신이 나간다');
  });
}

/* ---- 6. 설정 화면에 실제로 보이는가 ---- */
check('config.schema.json 에 putAway 가 있고 장치 탭에 노출된다', () => {
  const d = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.schema.json'), 'utf8'));
  const props = d.schema.properties.devices.items.properties;
  assert.ok(props.putAway, 'schema 에 putAway 가 없다');
  assert.strictEqual(props.putAway.type, 'boolean');
  // ⛔기기별 옵션이어야 한다 — 최상위에 있으면 전체가 꺼진다(fallbackToCloud 전례)
  assert.ok(!d.schema.properties.putAway, 'putAway 가 최상위에 있다 — devices[] 하위여야 한다');
  const tab = d.layout.find(x => x && x.key === 'devices');
  assert.ok(tab, '장치 탭(layout)이 없다');
  const keys = tab.items.map(x => (typeof x === 'string' ? x : x.key));
  assert.ok(keys.indexOf('devices[].putAway') !== -1, 'layout 에 putAway 가 없어 화면에 안 보인다');
  // ⚠️조건부 표시로 감싸면 특정 장치 종류에서 사라진다 — 5종 전부에 필요하다
  const entry = tab.items.find(x => x && x.key === 'devices[].putAway');
  assert.ok(entry === undefined, 'putAway 에 표시 조건이 붙었다 — 모든 장치 종류에서 보여야 한다');
});

/**
 * ★주석을 벗긴 소스(v2.4.1). 2.4.0 은 원문을 그대로 `indexOf` 해서, 게이트를 주석으로 바꿔도
 *   주석 안의 글자를 찾아 **통과**했다(2026-09-15 리뷰 C 변이 실측). 문자열 안의 `//` 는 지키고,
 *   주석은 같은 길이의 공백으로 바꾼다(위치 비교가 흔들리지 않게).
 */
function stripComments(src) {
  let out = '';
  let i = 0;
  let q = null;
  while (i < src.length) {
    const c = src[i], n = src[i + 1];
    if (q) {
      out += c;
      if (c === '\\') { out += n || ''; i += 2; continue; }
      if (c === q) q = null;
      i += 1; continue;
    }
    if (c === '/' && n === '/') {
      while (i < src.length && src[i] !== '\n') { out += ' '; i += 1; }
      continue;
    }
    if (c === '/' && n === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end === -1 ? src.length : end + 2;
      for (; i < stop; i++) out += src[i] === '\n' ? '\n' : ' ';
      continue;
    }
    if (c === '\'' || c === '"' || c === '`') q = c;
    out += c; i += 1;
  }
  return out;
}
const SRC = (rel) => stripComments(fs.readFileSync(path.join(__dirname, '..', rel), 'utf8'));

check('[계측기] stripComments — 주석으로 바꾼 게이트는 찾지 못한다', () => {
  const dead = '// if (isPutAway(config)) {\n/* sealForPutAway(x) */\n  x();';
  assert.strictEqual(stripComments(dead).indexOf('isPutAway('), -1, '주석 안의 코드를 코드로 읽었다 — 2.4.0 의 결함');
  assert.strictEqual(stripComments(dead).indexOf('sealForPutAway('), -1);
  const s = "const u = 'https://x.y'; // 꼬리";
  assert.ok(stripComments(s).indexOf("'https://x.y'") !== -1, '문자열을 주석으로 오인했다');
  assert.strictEqual(stripComments(s).length, s.length);
});

/* ---- 5-B. 게이트 블록이 실제로 끊는가 (주석 제거 후) ---- */
for (const [rel, startCall] of GATED) {
  check(`${path.basename(rel)} — 게이트가 살아 있고(주석·&& false 아님) return 한다`, () => {
    const s = SRC(rel);
    const g = s.indexOf('if (isPutAway(config)) {');
    const c = s.indexOf(startCall);
    assert.ok(g !== -1, '살아 있는 `if (isPutAway(config)) {` 가 없다 — 주석화되었거나 조건이 바뀌었다');
    assert.ok(g < c, '게이트가 통신 시작보다 뒤에 있다');
    const blk = s.slice(g, c);
    assert.ok(/\breturn;/.test(blk), '게이트 안에 return 이 없다 — 공기측정기는 이러면 실제로 폴링한다');
  });
}

/* ── ⑧ ★홈킷 타일은 「정상 연결 + 마지막 상태」여야 한다 ──────────
   Km81 님 지시: 「정상연결로 최종 상태를 가져왔으면 해」.

   ⚠️아래 가짜 특성은 hap-nodejs 2.2.2 `Characteristic.js` 의 규칙을 모형화한다:
     ① 새 처리기(`getHandler`)가 있으면 그것을 부르고, 던지면 `statusCode` 를 남긴다
     ② ⛔새 처리기가 없고 옛 `on('get')` 리스너가 있으면 그 리스너를 부른다(`removeOnGet` 은 리스너를 안 지운다)
     ③ 둘 다 없으면 `statusCode` 가 남아 있으면 던지고, 아니면 현재 값으로 답한다
     ④ 쓰기도 같다 — 새 처리기 → 옛 리스너 → (둘 다 없으면) 지역 값만 바꾼다
     ⑤ `updateValue()` 는 `statusCode` 를 0 으로 되돌린다
   ⛔모형은 모형이다 — 같은 규칙을 **실제 hap 으로** `put_away_hap.js` 가 5종 생성자째 다시 잰다. */
function mkChar(value, perms = ['pr', 'pw', 'ev']) {
  return {
    value,
    statusCode: 0,
    props: { perms },
    getHandler: undefined,
    setHandler: undefined,
    _l: { get: [], set: [] },
    onGet(fn) { this.getHandler = fn; return this; },
    onSet(fn) { this.setHandler = fn; return this; },
    removeOnGet() { this.getHandler = undefined; return this; },
    removeOnSet() { this.setHandler = undefined; return this; },
    on(ev, fn) { this._l[ev].push(fn); return this; },
    listenerCount(ev) { return (this._l[ev] || []).length; },
    removeAllListeners(ev) { this._l[ev] = []; return this; },
    updateValue(v) { this.value = v; this.statusCode = 0; return this; },
    get_() {
      if (this.getHandler) {
        try { return this.getHandler(); }
        catch (e) { this.statusCode = -70402; throw e; }
      }
      if (this._l.get.length) {
        let out; this._l.get[0]((err, v) => { if (err) { this.statusCode = -70402; throw err; } out = v; });
        return out;
      }
      if (this.statusCode) throw this.statusCode;
      return this.value;
    },
    set_(v) {
      if (this.setHandler) { this.setHandler(v); this.value = v; return; }
      if (this._l.set.length) { this._l.set[0](v, () => {}); this.value = v; return; }
      this.value = v;
    },
  };
}

function mkAcc(vals) {
  const chars = vals.map((v) => mkChar(v));
  return { services: [{ UUID: 'X', characteristics: chars }], chars };
}

check('[모형] 게터가 던지면 「응답 없음」이 된다 — 고치려는 증상 자체', () => {
  const a = mkAcc([1]);
  a.chars[0].onGet(() => { throw new Error('통신 실패'); });
  assert.throws(() => a.chars[0].get_(), /통신 실패/);
  assert.strictEqual(a.chars[0].statusCode, -70402, 'statusCode 가 남지 않았다 — 모형이 틀렸다');
});

check('★sealForPutAway 뒤에는 마지막 값으로 답한다', () => {
  const a = mkAcc([1, 26, 24]);
  a.chars.forEach((c) => c.onGet(() => { throw new Error('통신 실패'); }));
  try { a.chars[0].get_(); } catch (e) { /* 눌러붙게 만든다 */ }
  const n = sealForPutAway(a);
  assert.strictEqual(n, 3, `떼어 낸 처리기 수가 ${n} 이다`);
  assert.deepStrictEqual(a.chars.map((c) => c.get_()), [1, 26, 24],
    '마지막 상태로 답하지 않는다 — 홈 앱에 「응답 없음」이 남는다');
});

check('★sealForPutAway 는 옛 on(get/set) 리스너도 뗀다', () => {
  const a = mkAcc([1]);
  let sent = 0;
  a.chars[0].on('get', () => { sent += 1; });
  a.chars[0].on('set', () => { sent += 1; });
  assert.strictEqual(sealForPutAway(a), 2);
  assert.strictEqual(a.chars[0].get_(), 1);
  a.chars[0].set_(0);
  assert.strictEqual(sent, 0, `옛 리스너로 명령이 ${sent}회 나갔다`);
});

check('★sealForPutAway 는 눌러붙은 statusCode 도 지운다', () => {
  const a = mkAcc([1]);
  a.chars[0].onGet(() => { throw new Error('x'); });
  try { a.chars[0].get_(); } catch (e) { /* noop */ }
  assert.strictEqual(a.chars[0].statusCode, -70402);
  sealForPutAway(a);
  assert.strictEqual(a.chars[0].statusCode, 0, 'statusCode 가 남아 있다 — 계속 거부된다');
});

check('⛔쓰기 권한이 없는 특성에는 쓰기 처리기를 달지 않는다', () => {
  const c = mkChar(26, ['pr', 'ev']);
  sealForPutAway({ services: [{ characteristics: [c] }] });
  assert.strictEqual(c.setHandler, undefined);
});

check('⛔값이 없는 특성은 건드리지 않는다 (hap 이 경고를 낸다)', () => {
  const a = mkAcc([null]);
  let touched = 0;
  a.chars[0].updateValue = () => { touched += 1; };
  sealForPutAway(a);
  assert.strictEqual(touched, 0, 'value 가 null 인데 updateValue 를 불렀다');
});

check('⛔기기 정보 서비스(Identify)는 건드리지 않는다', () => {
  const c = mkChar(false);
  c.on('set', () => {});
  assert.strictEqual(sealForPutAway({ services: [{ UUID: '0000003E-0000-1000-8000-0026BB765291', characteristics: [c] }] }), 0);
  assert.strictEqual(c.listenerCount('set'), 1, 'hap 의 식별 리스너를 뗐다');
});

check('★배열을 받아 여러 액세서리를 한 번에 봉하고, 같은 것은 한 번만 센다', () => {
  const a = mkAcc([1]); const b = mkAcc([0]);
  a.chars[0].onGet(() => 1); b.chars[0].onGet(() => 0);
  assert.strictEqual(sealForPutAway([a, b, a, null, undefined]), 2);
});

check('⛔한 특성이 실패해도 나머지를 계속 봉한다', () => {
  const a = mkAcc([1, 1]);
  a.chars[0].removeOnGet = () => { throw new Error('깨진 특성'); };
  a.chars[1].onGet(() => { throw new Error('x'); });
  assert.doesNotThrow(() => sealForPutAway(a));
  assert.strictEqual(a.chars[1].getHandler, undefined, '뒤 특성이 안 봉해졌다');
});

check('⛔액세서리가 없거나 서비스가 없어도 던지지 않는다', () => {
  assert.strictEqual(sealForPutAway(null), 0);
  assert.strictEqual(sealForPutAway({}), 0);
  assert.strictEqual(sealForPutAway({ services: [{}] }), 0);
  assert.strictEqual(sealForPutAway([]), 0);
});

check('봉인 0건 문구에 감시 어휘가 없고 단답형이다', () => {
  assert.deepStrictEqual(vocabHits([PUT_AWAY_SEAL_EMPTY]), []);
  assert.ok(PUT_AWAY_SEAL_EMPTY.length <= 24 && !/[.!?]/.test(PUT_AWAY_SEAL_EMPTY));
});

/* ── ⑨ 구조 회귀 — 게이트가 seal 을 부르는가 (주석 제거 후) ──── */
const SEAL_AT = [
  ['lib/airpurifier/AirPurifierAccessory.js', 'sealForPutAway(owned)', 'this.connectWithRetry()'],
  ['lib/powerstrip/PowerStripAccessory.js', 'sealForPutAway(this.accessory)', 'this.connect();'],
  ['lib/humidifier/HumidifierAccessory.js', 'sealForPutAway(this.accessory)', 'this.connect();'],
  ['lib/airmonitor/AirMonitorAccessory.js', 'sealForPutAway(this.accessory)', 'this.startPolling();'],
];
for (const [rel, seal, comm] of SEAL_AT) {
  check(`${path.basename(rel)} — 게이트가 sealForPutAway 를 부른다`, () => {
    const s = SRC(rel);
    const g = s.indexOf('isPutAway(');
    const k = s.indexOf(seal, g);
    const c = s.indexOf(comm);
    assert.ok(k !== -1, `seal 호출이 없다(${seal}) — 타일이 「응답 없음」이 된다`);
    assert.ok(g < k && k < c, `위치가 틀렸다 (gate=${g}, seal=${k}, comm=${c})`);
  });
}
check('AirPurifierAccessory.js — ★자식 타일(별도 액세서리)까지 봉한다', () => {
  const s = SRC('lib/airpurifier/AirPurifierAccessory.js');
  assert.ok(/const owned = \[this\.accessory, \.\.\.Object\.values\(this\.child\)\.map\(c => c && c\.acc\)\];/.test(s),
    '자식 액세서리를 안 넘긴다 — 자식 스위치 탭이 본체 타일을 0 으로 덮는다');
});

check('FanAccessory.js — 서비스를 만든 뒤에 seal 하고, 설정값이 컨트롤러로 넘어간다', () => {
  const s = SRC('lib/fan/FanAccessory.js');
  const setup = s.indexOf('this.setupAccessoryServices();');
  const seal = s.indexOf('sealForPutAway(this.fanAccesory)');
  assert.ok(setup !== -1 && seal !== -1, 'seal 호출이 없다');
  assert.ok(setup < seal, 'seal 이 서비스 생성보다 앞이다 — 뗄 것이 없다');
  assert.ok(/this\.putAway\s*&&\s*sealForPutAway\(this\.fanAccesory\)/.test(s), 'putAway 조건 없이 항상 seal 한다');
  assert.ok(/this\.putAway\s*=\s*isPutAway\(config\);/.test(s), '설정에서 putAway 를 읽지 않는다');
  assert.ok(/this\.fanController\.putAway\s*=\s*this\.putAway;/.test(s), '컨트롤러로 넘기지 않는다 — 배선 끊김');
});

console.log(`\nput_away: ${total - failed}/${total} 통과`);
if (failed) process.exit(1);

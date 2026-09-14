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
 * 실행: node test/put_away.js   (의존 패키지가 필요하다 — miio)
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const { isPutAway, PUT_AWAY_MESSAGE } = require('../lib/common/putAway.js');
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

console.log(`\nput_away: ${total - failed}/${total} 통과`);
if (failed) process.exit(1);

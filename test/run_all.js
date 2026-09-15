'use strict';

/**
 * run_all.js — 이 저장소의 회귀 스위트를 전부 돌린다. (`npm test`)
 *
 * ⛔★새 스위트를 만들면 **여기에 등재**할 것. 등재 안 된 스위트는 아무도 안 돌린다
 *   (= 있으나 마나, 그리고 「회귀가 있다」는 잘못된 안심을 준다).
 * ⚠️한 스위트가 실패해도 나머지를 계속 돌린다 — 실패를 한 번에 다 보는 편이 빠르다.
 */

const { spawnSync } = require('child_process');
const path = require('path');

const SUITES = [
  'put_away.js',        // 임시 연결해제 토글 (v2.3.0)
  'put_away_hap.js',    // ★실제 hap-nodejs 로 5종 봉인·통신 0 (v2.4.1 — hap 없으면 skip 이 아니라 실패)
  'sim_v222_cmdlog.js', // 명령 로그 문구 (v2.2.2)
];

let failed = 0;
for (const s of SUITES) {
  console.log(`\n=== ${s} ===`);
  const r = spawnSync(process.execPath, [path.join(__dirname, s)], { stdio: 'inherit' });
  if (r.status !== 0) { failed++; console.log(`--- ${s} 실패 (exit ${r.status}) ---`); }
}

console.log(`\n전체: ${SUITES.length - failed}/${SUITES.length} 스위트 통과`);
process.exit(failed ? 1 : 0);

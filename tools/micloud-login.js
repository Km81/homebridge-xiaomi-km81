#!/usr/bin/env node
'use strict';
/*
 * MiCloud 세션 생성 도구 (2FA 계정용).
 *
 * 강제 2FA 가 걸린 Mi 계정은 ID/PW 만으로 자동 로그인이 안 됩니다. 이 도구로 한 번만
 * 2FA 로그인해서 세션을 파일로 저장하면, 플러그인은 그 캐시 세션으로 인증합니다.
 *
 * 사용법 (Homebridge 호스트에서 실행):
 *   node tools/micloud-login.js --out <세션파일경로> [--country sg]
 *   기본 출력 경로: <현재 폴더>/xiaomi-km81-micloud-session.json
 *   이 파일을 Homebridge storage 폴더(예: ~/.homebridge/)에
 *   'xiaomi-km81-micloud-session.json' 이름으로 두면 플러그인이 자동으로 읽습니다.
 *
 * 2FA 흐름:
 *   1) ID/PW 입력 → 2FA 필요하면 인증 URL 이 출력됩니다.
 *   2) 그 URL 을 브라우저에서 열어 SMS/이메일로 인증코드(ticket)를 받습니다.
 *   3) 받은 코드를 입력하면 세션이 저장됩니다.
 */
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const MiCloud = require('../lib/common/MiCloud.js');

function arg(name, def) {
  const i = process.argv.indexOf(name);
  return (i !== -1 && process.argv[i + 1]) ? process.argv[i + 1] : def;
}
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q, hide) => new Promise(res => {
  if (!hide) return rl.question(q, a => res(a.trim()));
  // 비밀번호 숨김 입력
  const stdin = process.stdin;
  process.stdout.write(q);
  const onData = (ch) => { ch = ch + ''; if (ch === '\n' || ch === '\r' || ch === '') { stdin.removeListener('data', onData); } else { process.stdout.clearLine && process.stdout.clearLine(); process.stdout.cursorTo && process.stdout.cursorTo(0); process.stdout.write(q + '*'.repeat(rl.line.length)); } };
  stdin.on('data', onData);
  rl.question('', a => { process.stdout.write('\n'); res(a.trim()); });
});

(async () => {
  const logger = { debug: () => {}, deepDebug: () => {}, info: (...a) => console.log(...a) };
  const mc = new MiCloud(logger);
  const country = (arg('--country', '') || await ask('지역 서버 (cn/sg/de/us/ru/tw/in/i2) [sg]: ')) || 'sg';
  mc.setCountry(country.toLowerCase());
  const username = await ask('Mi 계정 (이메일/아이디): ');
  const password = await ask('Mi 비밀번호: ', true);

  try {
    await mc.login(username, password);
  } catch (e) {
    if (e && e.notificationUrl) {
      console.log('\n=== 2단계 인증 필요 ===');
      console.log('아래 URL 을 브라우저에서 열어 인증코드(SMS/이메일)를 받으세요:\n');
      console.log('  ' + e.notificationUrl + '\n');
      const ticket = await ask('받은 인증코드(ticket) 입력: ');
      await mc.loginTwoFa(e.notificationUrl, ticket);
    } else {
      console.error('로그인 실패:', e && e.message || e);
      rl.close();
      process.exit(1);
    }
  }

  if (!mc.isLoggedIn()) { console.error('로그인에 실패했습니다.'); rl.close(); process.exit(1); }

  const session = mc.getServiceToken();
  const out = path.resolve(arg('--out', 'xiaomi-km81-micloud-session.json'));
  fs.writeFileSync(out, JSON.stringify({ country: mc.country, session }, null, 2) + '\n');
  console.log('\n로그인 성공! 세션을 저장했습니다:', out);
  console.log('이 파일을 Homebridge storage 폴더에 "xiaomi-km81-micloud-session.json" 으로 두면 플러그인이 자동으로 사용합니다.');
  console.log('(또는 config 의 micloud.serviceToken 에 아래 JSON 을 넣어도 됩니다)\n');
  console.log(JSON.stringify(session));
  rl.close();
})();

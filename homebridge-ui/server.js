'use strict';

/*
 * Homebridge Custom UI 서버.
 *
 * 설정 화면에서 터미널 없이 MiCloud 에 로그인(2FA 포함)하고, 성공한 세션을
 * Homebridge storage 폴더의 'xiaomi-km81-micloud-session.json' 으로 저장한다.
 * 플러그인(index.js initMiCloud)은 그 캐시 파일을 자동으로 읽어 인증한다.
 */

const { HomebridgePluginUiServer, RequestError } = require('@homebridge/plugin-ui-utils');
const fs = require('fs');
const path = require('path');
const MiCloud = require('../lib/common/MiCloud.js');

const SESSION_FILENAME = 'xiaomi-km81-micloud-session.json';

class UiServer extends HomebridgePluginUiServer {
  constructor() {
    super();
    // 2FA 진행 중 상태: { miCloud, notificationUrl }
    this.pending = null;

    this.onRequest('/status', this.handleStatus.bind(this));
    this.onRequest('/login', this.handleLogin.bind(this));
    this.onRequest('/submitTicket', this.handleSubmitTicket.bind(this));
    this.onRequest('/clear', this.handleClear.bind(this));

    this.ready();
  }

  _sessionPath() {
    return path.join(this.homebridgeStoragePath, SESSION_FILENAME);
  }

  _quietLogger() {
    return { debug: () => {}, deepDebug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
  }

  _saveSession(miCloud) {
    const session = miCloud.getServiceToken();
    if (!session) throw new Error('세션 토큰을 만들지 못했습니다.');
    const data = { country: miCloud.country, session };
    fs.writeFileSync(this._sessionPath(), JSON.stringify(data, null, 2) + '\n');
    return data;
  }

  async handleStatus() {
    const p = this._sessionPath();
    try {
      if (fs.existsSync(p)) {
        const j = JSON.parse(fs.readFileSync(p, 'utf8'));
        const s = j.session || {};
        return { exists: true, country: j.country || null, userId: s.userId || null, loggedInAt: s.loggedInAt || null, path: p };
      }
    } catch (e) { /* 손상된 파일이면 없는 것으로 처리 */ }
    return { exists: false, path: p };
  }

  async handleLogin(payload) {
    const { username, password, country } = payload || {};
    if (!username || !password) return { ok: false, message: 'Mi 계정 아이디와 비밀번호를 입력하세요.' };

    const miCloud = new MiCloud(this._quietLogger());
    try {
      miCloud.setCountry(String(country || 'cn').toLowerCase());
    } catch (e) {
      return { ok: false, message: `지원하지 않는 지역입니다: ${country}` };
    }

    try {
      await miCloud.login(username, password);
      const data = this._saveSession(miCloud);
      this.pending = null;
      return { ok: true, status: 'saved', country: data.country, userId: data.session.userId, path: this._sessionPath() };
    } catch (e) {
      if (e && e.notificationUrl) {
        this.pending = { miCloud, notificationUrl: e.notificationUrl };
        return { ok: true, status: '2fa', notificationUrl: e.notificationUrl };
      }
      return { ok: false, message: `로그인 실패: ${(e && e.message) || e}` };
    }
  }

  async handleSubmitTicket(payload) {
    const { ticket } = payload || {};
    if (!this.pending) return { ok: false, message: '먼저 로그인을 시도하세요 (2단계 인증 대기 상태가 아닙니다).' };
    if (!ticket) return { ok: false, message: '인증코드(ticket)를 입력하세요.' };

    try {
      await this.pending.miCloud.loginTwoFa(this.pending.notificationUrl, ticket);
      if (!this.pending.miCloud.isLoggedIn()) return { ok: false, message: '인증코드는 처리됐지만 세션을 받지 못했습니다. 코드를 다시 확인하세요.' };
      const data = this._saveSession(this.pending.miCloud);
      const out = { ok: true, status: 'saved', country: data.country, userId: data.session.userId, path: this._sessionPath() };
      this.pending = null;
      return out;
    } catch (e) {
      return { ok: false, message: `2단계 인증 실패: ${(e && e.message) || e}` };
    }
  }

  async handleClear() {
    const p = this._sessionPath();
    try {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    } catch (e) {
      throw new RequestError('세션 파일 삭제 실패', { message: e.message });
    }
    this.pending = null;
    return { ok: true };
  }
}

(() => new UiServer())();

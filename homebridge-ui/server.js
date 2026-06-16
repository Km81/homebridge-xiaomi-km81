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
    this.onRequest('/devices', this.handleDevices.bind(this));

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

    // 로그인은 지역과 무관(Mi 계정은 전역). country 는 캐시에 저장할 기본 지역값일 뿐이며,
    // 실제 기기 제어 지역은 기기별 miCloudCountry 로 지정한다. 그래서 미지정/미지원이어도
    // 로그인을 막지 않고 기본값으로 넘어간다.
    const miCloud = new MiCloud(this._quietLogger());
    try { miCloud.setCountry(String(country || 'cn').toLowerCase()); }
    catch (e) { miCloud.setCountry('cn'); }

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

  _loadSession() {
    try {
      const p = this._sessionPath();
      if (fs.existsSync(p)) {
        const j = JSON.parse(fs.readFileSync(p, 'utf8'));
        if (j && j.session) return j;
      }
    } catch (e) { /* ignore */ }
    return null;
  }

  // 저장된 세션으로 여러 지역 서버를 조회해 계정에 등록된 기기(이름/모델/deviceId/IP/토큰)와
  // 각 기기가 실제로 등록된 지역(서버)을 검출한다. 자동 등록은 하지 않는다(값 확인용).
  async handleDevices(payload) {
    const sess = this._loadSession();
    if (!sess) return { ok: false, message: '먼저 위에서 로그인해 세션을 만드세요.' };

    const miCloud = new MiCloud(this._quietLogger());
    miCloud.setServiceToken(sess.session);
    if (!miCloud.isLoggedIn()) return { ok: false, message: '세션이 유효하지 않습니다. 다시 로그인하세요.' };

    const countries = (payload && Array.isArray(payload.countries) && payload.countries.length)
      ? payload.countries.filter(c => miCloud.availableCountries.includes(c))
      : miCloud.availableCountries;

    const byDid = new Map();
    const errors = [];
    for (const c of countries) {
      try {
        miCloud.setCountry(c);
        const list = await miCloud.getDevices();
        if (Array.isArray(list)) {
          for (const d of list) {
            const did = String(d.did);
            if (byDid.has(did)) continue;   // 기기는 한 지역에만 등록됨 — 먼저 찾은 지역이 실제 서버
            byDid.set(did, {
              name: d.name || '',
              model: d.model || '',
              did,
              ip: d.localip || '',
              token: d.token || '',
              online: !!d.isOnline,
              country: c,
            });
          }
        }
      } catch (e) {
        errors.push(`${c}: ${(e && e.message) || e}`);
      }
    }
    const devices = Array.from(byDid.values())
      .sort((a, b) => (a.country + a.name).localeCompare(b.country + b.name));
    return { ok: true, devices, scanned: countries, errors };
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

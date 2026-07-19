const crypto = require('crypto');
const fetch = require('node-fetch');
const randomstring = require('randomstring');
const querystring = require('querystring');
const Errors = require("./MiCloudErrors.js");
const CustomCryptRC4 = require("./CustomCryptRC4.js");

const DEFAULT_EQUEST_TIMEOUT = 5000;

class MiCloud {
  // v2.2.1 — 자동 재로그인 정책 상수
  static RELOGIN_FAIL_COOLDOWN_MS = 15 * 60 * 1000;    // 일시 실패 쿨다운
  static RELOGIN_2FA_LATCH_MS = 6 * 60 * 60 * 1000;    // 인증코드 요구/연속 실패 장기 래치
  static RELOGIN_SUCCESS_GRACE_MS = 60 * 1000;          // 성공 직후 grace — 재401에 재로그인 금지(폭주 방지)
  static RELOGIN_FAIL_ESCALATE_AFTER = 3;               // 연속 N회 실패 시 장기 래치 승격

  constructor(logger) {
    this.logger = logger;

    this.username = null;
    this.password = null;
    this.ssecurity = null;
    this.userId = null;
    this.serviceToken = null;

    // 자동 재로그인 상태 (v2.2.1)
    this._reloginInFlight = null;
    this._reloginBlockedUntil = 0;
    this._reloginBlockReason = null;
    this._reloginFailCount = 0;
    this._lastReloginOkTs = 0;

    this.loginTimestamp = null;

    this.country = 'cn';
    this.requestTimeout = DEFAULT_EQUEST_TIMEOUT;
    this.useUnencryptedRequests = false;

    this.availableCountries = ['ru', 'us', 'tw', 'sg', 'cn', 'de', 'in', 'i2'];
    this.locale = 'en';

    this._cookieJar = {};

    // constants
    this.AGENT_ID = randomstring.generate({
      length: 13,
      charset: 'ABCDEF',
    });
    this.USERAGENT = this._generateUserAgent();
    this.CLIENT_ID = randomstring.generate({
      length: 6,
      charset: 'alphabetic',
      capitalization: 'uppercase',
    });
  }
  
  _generateUserAgent() {
    return `Android-7.1.1-1.0.0-ONEPLUS A3010-136-${this.AGENT_ID} APP/com.xiaomi.mihome APPV/10.5.201`;
  }

  isLoggedIn() {
    return !!this.serviceToken;
  }

  setCountry(country = 'cn') {
    if (!this.availableCountries.includes(country)) {
      throw new Error(`The country ${country} is not supported, list of supported countries is ${this.availableCountries.join(', ')}`);
    }
    this.country = country;
  }

  setRequestTimeout(timeout = DEFAULT_EQUEST_TIMEOUT) {
    if (!timeout || timeout < 2000) {
      timeout = 2000; // make sure we stay above 2000ms since those requests might take some time
    }
    this.requestTimeout = timeout;
  }

  setUseUnencryptedRequests(unencrypted = false) {
    this.useUnencryptedRequests = unencrypted;
  }


  getServiceToken() {
    if (this.isLoggedIn()) {
      const loggedInAtStr = new Date(this.loginTimestamp).toISOString().slice(0, 19).replace('T', ' ');
      return {
        ssecurity: this.ssecurity,
        userId: this.userId,
        serviceToken: this.serviceToken,
        timestamp: this.loginTimestamp,
        loggedInAt: loggedInAtStr,
        // Include the IDs within the token so they persist across reboot
        agentId: this.AGENT_ID,
        clientId: this.CLIENT_ID
      };
    }
  }

  setServiceToken(tokenJson) {
    if (tokenJson) {
      const {
        ssecurity,
        userId,
        serviceToken,
        agentId,
        clientId
      } = tokenJson;

      if (ssecurity && userId && serviceToken) {
        this.ssecurity = ssecurity;
        this.userId = userId;
        this.serviceToken = serviceToken;

        // Restore cached IDs after restarting host
        if (agentId && clientId) {
          this.AGENT_ID = agentId;
          this.CLIENT_ID = clientId;
          this.USERAGENT = this._generateUserAgent();
        }

        // v2.2.1 — 수동 로그인 등으로 유효 세션이 주입되면 재로그인 래치/실패 이력 해제
        this._reloginBlockedUntil = 0;
        this._reloginBlockReason = null;
        this._reloginFailCount = 0;
      }
    }
  }

  async login(username, password) {
    this.logger.debug(`(MiCloud) Log in to MiCloud with username ${username}. Request timeout: ${this.requestTimeout} milliseconds.`);
    if (this.isLoggedIn()) {
      throw new Error(`You are already logged in with username ${this.username}. Login not required!`);
    }
    // Clear cookie jar to ensure a fresh session for each login attempt
    this._cookieJar = {};
    const {
      sign
    } = await this._loginStep1();
    const {
      ssecurity,
      userId,
      location
    } = await this._loginStep2(username, password, sign);
    const {
      serviceToken
    } = await this._loginStep3(sign.indexOf('http') === -1 ? location : sign);
    this.logger.debug(`(MiCloud) Login successful!`);
    this.username = username;
    this.password = password;
    this.ssecurity = ssecurity;
    this.userId = userId;
    this.serviceToken = serviceToken;
    this.loginTimestamp = Date.now();
  }

  async loginTwoFa(verifyUrl, ticket) {
    this.logger.debug(`(MiCloud) Login using 2FA ticket`);
    // Clear cookie jar to ensure a fresh session for each login attempt
    this._cookieJar = {};

    let locationToFollow = await this._verifyTicket(verifyUrl, ticket);

    this.logger.debug(`(MiCloud) Starting redirect chain by following the ticket location`);

    for (let i = 0; i < 10; i++) {
      this.logger.deepDebug(`-------------------------------------------------------------------`);
      this.logger.deepDebug(`(MiCloud) Redirect loop ${i}: Fetching from URL: ${locationToFollow}`);
      const response = await fetch(locationToFollow, {
        redirect: 'manual',
        timeout: this.requestTimeout,
        headers: {
          'User-Agent': this.USERAGENT,
          'Content-Type': 'application/x-www-form-urlencoded',
          'Cookie': this._cookieHeader(),
        }
      });

      this._storeSetCookies(response);

      this.logger.debug(`(MiCloud) Redirect loop ${i}: Response status: ${response.status}`);
      // v2.2.1 — set-cookie에 serviceToken이 실려 옴 → 로그 공유 시 세션 유출 방지 위해 마스킹
      this.logger.deepDebug(`(MiCloud) Redirect loop ${i}: Response headers:\n${JSON.stringify(Object.fromEntries([...response.headers.entries()].map(([k, v]) => [k, /cookie/i.test(k) ? '(masked)' : v])), null, 2)}`);

      // prefer cookie jar values (but keep old parsing behavior intact)
      this.logger.debug(`(MiCloud) Processing cookie jar`);
      if (!this.serviceToken && this._cookieJar.serviceToken) {
        this.serviceToken = this._cookieJar.serviceToken;
        this.logger.debug(`(MiCloud) Found 'serviceToken' cookie`);
      }
      if (!this.userId && this._cookieJar.userId) {
        this.userId = this._cookieJar.userId;
        this.logger.debug(`(MiCloud) Found 'userId' cookie`);
      }

      // no really needed anymore, as the values are now retrieved by the code above, remowe if no issues will appear...
      // this.logger.debug(`(MiCloud) Processing 'set-cookie' header`);
      // const headers = response.headers.raw();
      // const cookies = headers['set-cookie'];
      // if (cookies && cookies.forEach) {
      //   cookies.forEach(cookieStr => {
      //     const cookie = cookieStr.split('; ')[0];
      //     const idx = cookie.indexOf('=');
      //     const key = cookie.substr(0, idx);
      //     const value = cookie.substr(idx + 1, cookie.length).trim();
      //     if (key === 'serviceToken') {
      //       this.serviceToken = value;
      //       this.logger.debug(`(MiCloud) Found 'serviceToken' cookie`);
      //     } else if (key === 'userId') {
      //       this.userId = value;
      //       this.logger.debug(`(MiCloud) Found 'userId' cookie`);
      //     }
      //   });
      // }

      if (!this.ssecurity && response.headers.has('extension-pragma')) {
        this.logger.debug(`(MiCloud) Processing 'extension-pragma' header`);
        const pragma = response.headers.get('extension-pragma');
        try {
          this.ssecurity = JSON.parse(pragma).ssecurity;
          this.logger.debug(`(MiCloud) Captured 'ssecurity' from extension-pragma header`);
        } catch (e) {
          this.logger.debug('Could not parse extension-pragma header as JSON', pragma);
        }
      }
      if (response.status >= 300 && response.status < 400 && response.headers.has('location')) {
        locationToFollow = new URL(response.headers.get('location'), locationToFollow).toString();
      } else {
        this.logger.debug(`(MiCloud) Redirect loop ${i}: End of redirect chain`);
        break;
      }
    }

    if (this.ssecurity && this.userId && this.serviceToken) {
      this.logger.debug(`(MiCloud) 2FA login successful!`);
      this.loginTimestamp = Date.now();
    } else {
      throw new Error(`2FA login failed! Did not find required data...`);
    }
  }

  logout() {
    if (!this.isLoggedIn()) {
      throw new Error('You are not logged in! Cannot log out!');
    }
    this.logger.debug(`(MiCloud) Logout from MiCloud for username ${this.username}`);
    this.username = null;
    this.password = null;
    this.ssecurity = null;
    this.userId = null;
    this.serviceToken = null;
    this.loginTimestamp = null;
    this._cookieJar = {};
    this.setCountry('cn');
  }

  async refreshServiceToken() {
    this.logger.debug(`(MiCloud) Refreshing MiCloud service token for username ${this.username}`);
    this.ssecurity = null;
    this.userId = null;
    this.serviceToken = null;
    this.loginTimestamp = null;
    return this.login(this.username, this.password);
  }

  async request(path, data, country) {
    // v2.2.1 — 웨지 방지: 직전 재로그인 실패로 로그아웃 상태로 남았으면 요청 전에 재로그인부터.
    // (없으면 'You are not logged in!'(authFailed 아님)만 반복돼 재시도 주체가 영영 없음 — 3중 리뷰 확정 결함)
    // 쿨다운/래치 중엔 _autoRelogin이 HTTP 없이 즉시 throw하므로 폭주하지 않는다.
    if (!this.isLoggedIn() && this.username && this.password) {
      await this._autoRelogin();
    }
    try {
      if (this.useUnencryptedRequests) {
        return await this._requestUnencrypted(path, data, country);
      } else {
        return await this._requestEncrypted(path, data, country);
      }
    } catch (e) {
      // v2.2.0 — 세션 만료(401/403/426) 자동 재로그인: config에 자격증명이 있으면
      // 검증된 deviceId(AGENT_ID/CLIENT_ID 유지)로 조용히 재로그인 후 1회 재시도.
      // (trusted deviceId 재사용 시 인증 코드 없이 통과됨을 실측 검증 — 2026-07-16)
      if (e && e.authFailed && this.username && this.password) {
        // v2.2.1 — 폭주 방지: 재로그인 "성공" 직후 grace 안에 또 만료 응답이 오면(새 토큰
        // 서버 전파 지연·낙오 응답) 재로그인을 반복하지 않고 원 에러를 전파한다.
        // 없으면 폴링 주기마다 풀 로그인 → 위험관리가 trusted deviceId 신뢰를 소각할 수 있음.
        if (this._lastReloginOkTs && (Date.now() - this._lastReloginOkTs) < MiCloud.RELOGIN_SUCCESS_GRACE_MS) {
          throw e;
        }
        await this._autoRelogin();   // 실패 시 throw → 원래 에러 대신 재로그인 실패가 전파됨
        if (this.useUnencryptedRequests) {
          return await this._requestUnencrypted(path, data, country);
        }
        return await this._requestEncrypted(path, data, country);
      }
      throw e;
    }
  }

  // 자동 재로그인 — 단일비행(동시 폴링이 한꺼번에 만료를 맞아도 로그인은 1회) +
  // 실패 쿨다운(위험관리 자극 방지) + 연속 실패 승격 + 2FA 요구 시 장기 래치(수동 개입 필요).
  async _autoRelogin() {
    if (this._reloginInFlight) return this._reloginInFlight;
    const now = Date.now();
    if (this._reloginBlockedUntil && now < this._reloginBlockedUntil) {
      const remainMin = Math.ceil((this._reloginBlockedUntil - now) / 60000);
      const err = new Error(`자동 재로그인 대기 중 — ${this._reloginBlockReason || '직전 실패'} (약 ${remainMin}분 후 재시도)`);
      err.authFailed = true;    // 호출자들의 1회 경고 래치가 정상 발화하도록 (세션 만료 상태는 사실)
      err.autoRelogin = true;   // "수동 로그인하세요" 대신 "자동 복구 대기 중" 안내 분기용
      throw err;
    }
    this._reloginInFlight = (async () => {
      this._logWarn('세션 만료 감지 — 자동 재로그인 시도');
      try {
        await this.refreshServiceToken();
        this._reloginBlockedUntil = 0;
        this._reloginFailCount = 0;
        this._lastReloginOkTs = Date.now();
        this.logger.info('자동 재로그인됨 — 세션 갱신');
        if (typeof this.onSessionRefreshed === 'function') {
          try { this.onSessionRefreshed(this.getServiceToken()); } catch (_) { /* 저장 실패는 치명 아님 */ }
        }
      } catch (e) {
        this._reloginFailCount = (this._reloginFailCount || 0) + 1;
        if (e && e.notificationUrl) {
          // 인증 코드 요구 = trusted deviceId 신뢰가 풀림 — 자동으로는 못 넘음. 6시간 래치.
          this._reloginBlockedUntil = Date.now() + MiCloud.RELOGIN_2FA_LATCH_MS;
          this._reloginBlockReason = '인증 코드 필요';
          this._logWarn('★자동 재로그인에 인증 코드가 필요합니다 — 설정 화면에서 수동 로그인하세요. (6시간 뒤 재시도)');
        } else if (this._reloginFailCount >= MiCloud.RELOGIN_FAIL_ESCALATE_AFTER) {
          // v2.2.1 — 연속 실패 승격: 비번 변경·captcha 등 반복 거부를 15분마다 계속 두드리면
          // 위험관리를 자극해 deviceId 신뢰를 잃을 수 있음 → 3회부터 6시간 래치.
          this._reloginBlockedUntil = Date.now() + MiCloud.RELOGIN_2FA_LATCH_MS;
          this._reloginBlockReason = `연속 ${this._reloginFailCount}회 실패`;
          this._logWarn(`★자동 재로그인 연속 ${this._reloginFailCount}회 실패 — 비밀번호 변경 여부를 확인하세요. (6시간 뒤 재시도): ${(e && e.message) || e}`);
        } else {
          this._reloginBlockedUntil = Date.now() + MiCloud.RELOGIN_FAIL_COOLDOWN_MS;  // 일시 오류
          this._reloginBlockReason = '직전 실패';
          this._logWarn(`자동 재로그인 실패 (15분 뒤 재시도, ${this._reloginFailCount}회째): ${(e && e.message) || e}`);
        }
        if (e && typeof e === 'object') { e.authFailed = true; e.autoRelogin = true; }
        throw e;
      } finally {
        this._reloginInFlight = null;
      }
    })();
    return this._reloginInFlight;
  }

  // 경고 로그 — 로거에 warn이 없으면(도우미 서버·CLI 축소 로거) info로 폴백
  _logWarn(msg) {
    if (this.logger.warn) this.logger.warn(msg);
    else this.logger.info(msg);
  }

  async getDevices(deviceIds) {
    const req = deviceIds ? {
      dids: deviceIds,
    } : {
      getVirtualModel: false,
      getHuamiDevices: 0,
    };
    //  {"getVirtualModel":true,"getHuamiDevices":1,"get_split_device":false,"support_smart_home":true}
    const data = await this.request('/home/device_list', req);

    return data.result.list;
  }

  async getDevice(deviceId) {
    const req = {
      dids: [String(deviceId)]
    };
    const data = await this.request('/home/device_list', req);

    return data.result.list[0];
  }

  // this passes the commands to the device 1:1 (raw miio: get_prop / set_xxx 등)
  // country(선택): 기기가 등록된 지역이 계정 기본 지역과 다를 때 호출별로 덮어쓴다.
  async miioCall(deviceId, method, params, country) {
    const req = {
      method,
      params
    };
    const data = await this.request(`/home/rpc/${deviceId}`, req, country);
    return data.result;
  }

  // the below methods always use miot protocol even for old device which does not support them locally.
  // country(선택): 기기가 등록된 지역이 계정 기본 지역과 다를 때(예: 일부 tw, 일부 cn) 호출별로 덮어쓴다.
  async miotGetProps(params, country) {
    const req = {
      params
    };
    const data = await this.request(`/miotspec/prop/get`, req, country);
    return data.result;
  }

  async miotSetProps(params, country) {
    const req = {
      params
    };
    const data = await this.request(`/miotspec/prop/set`, req, country);
    return data.result;
  }

  async miotAction(params, country) {
    const req = {
      params
    };
    const data = await this.request(`/miotspec/action`, req, country);
    return data.result;
  }

  // --- private stuff ---
  async _requestUnencrypted(path, data, country) {
    if (!this.isLoggedIn()) {
      throw new Error('You are not logged in! Cannot make a request!');
    }
    const url = this._getApiUrl(country || this.country) + path;
    const params = {
      data: JSON.stringify(data),
    };
    const nonce = this._generateNonce();
    const signedNonce = this._signedNonce(this.ssecurity, nonce);
    const signature = this._generateSignature(path, signedNonce, nonce, params);
    const body = {
      _nonce: nonce,
      data: params.data,
      signature,
    };
    this.logger.deepDebug(`(MiCloud) Unencrypted request ${url} - ${JSON.stringify(body)}`);
    const res = await fetch(url, {
      method: 'POST',
      timeout: this.requestTimeout,
      headers: {
        'User-Agent': this.USERAGENT,
        'x-xiaomi-protocal-flag-cli': 'PROTOCAL-HTTP2',
        'Content-Type': 'application/x-www-form-urlencoded',
        Cookie: [
          'sdkVersion=accountsdk-18.8.15',
          `deviceId=${this.CLIENT_ID}`,
          `userId=${this.userId}`,
          `yetAnotherServiceToken=${this.serviceToken}`,
          `serviceToken=${this.serviceToken}`,
          `locale=${this.locale}`,
          'channel=MI_APP_STORE'
        ].join('; '),
      },
      body: querystring.stringify(body),
    });

    if (!res.ok) {
      const reqErr = new Error(`Request error with status ${res.status} ${res.statusText}`);
      // 426: CN 서버가 오래된 세션을 거부할 때의 응답 — 세션 만료로 분류 (2026-07-16 실측: 재로그인으로 해소)
      if (res.status === 401 || res.status === 403 || res.status === 426) reqErr.authFailed = true; // 세션 만료/인증 실패
      throw reqErr;
    }

    const json = await res.json();

    if (json && !json.result && json.message && json.message.length > 0) {
      this.logger.debug(`(MiCloud) No result in response from MiCloud! Message: ${json.message}`);
    }

    return json;
  }

  async _requestEncrypted(path, data, country) {
    if (!this.isLoggedIn()) {
      throw new Error('You are not logged in! Cannot make a request!');
    }
    const url = this._getApiUrl(country || this.country) + path;
    const params = {
      data: JSON.stringify(data),
    };
    const nonce = this._generateNonce();
    const signedNonce = this._signedNonce(this.ssecurity, nonce);
    const body = this._generateRc4Body(url, signedNonce, nonce, params, this.ssecurity);
    this.logger.deepDebug(`(MiCloud) Encrypted request ${url} - ${JSON.stringify(data)}`);
    const res = await fetch(url, {
      method: 'POST',
      timeout: this.requestTimeout,
      headers: {
        'User-Agent': this.USERAGENT,
        'x-xiaomi-protocal-flag-cli': 'PROTOCAL-HTTP2',
        'Accept-Encoding': 'identity',
        'Content-Type': 'application/x-www-form-urlencoded',
        'MIOT-ENCRYPT-ALGORITHM': 'ENCRYPT-RC4',
        Cookie: [
          'sdkVersion=accountsdk-18.8.15',
          `deviceId=${this.CLIENT_ID}`,
          `userId=${this.userId}`,
          `yetAnotherServiceToken=${this.serviceToken}`,
          `serviceToken=${this.serviceToken}`,
          `locale=${this.locale}`,
          'channel=MI_APP_STORE'
        ].join('; '),
      },
      body: querystring.stringify(body)
    });

    if (!res.ok) {
      const reqErr = new Error(`Request error with status ${res.status} ${res.statusText}`);
      // 426: CN 서버가 오래된 세션을 거부할 때의 응답 — 세션 만료로 분류 (2026-07-16 실측: 재로그인으로 해소)
      if (res.status === 401 || res.status === 403 || res.status === 426) reqErr.authFailed = true; // 세션 만료/인증 실패
      throw reqErr;
    }

    const responseText = await res.text();
    const decryptedText = this._decryptRc4(signedNonce, responseText);
    const json = JSON.parse(decryptedText);

    if (json && !json.result && json.message && json.message.length > 0) {
      this.logger.debug(`(MiCloud) No result in response from MiCloud! Message: ${json.message}`);
    }

    return json;
  }

  _getApiUrl(country) {
    country = country.trim().toLowerCase();
    // 기기별 지역 override(miCloudCountry)는 setCountry 검증을 거치지 않으므로 여기서 확인한다.
    // 오타/미지원 지역이면 엉뚱한 호스트로 가 DNS 타임아웃이 나는 대신 기본 지역으로 폴백한다.
    if (!this.availableCountries.includes(country)) {
      this.logger.debug(`(MiCloud) Unsupported country '${country}', falling back to ${this.country}`);
      country = this.country;
    }
    return `https://${country === 'cn' ? '' : `${country}.`}api.io.mi.com/app`;
  }

  _parseJson(str) {
    if (str.indexOf('&&&START&&&') === 0) {
      str = str.replace('&&&START&&&', '');
    }
    return JSON.parse(str);
  }

  _generateSignature(path, _signedNonce, nonce, params) {
    const exps = [];
    exps.push(path);
    exps.push(_signedNonce);
    exps.push(nonce);

    const paramKeys = Object.keys(params);
    paramKeys.sort();
    for (let i = 0, {
        length
      } = paramKeys; i < length; i++) {
      const key = paramKeys[i];
      exps.push(`${key}=${params[key]}`);
    }

    return crypto
      .createHmac('sha256', Buffer.from(_signedNonce, 'base64'))
      .update(exps.join('&'))
      .digest('base64');
  }

  _generateNonce() {
    const buf = Buffer.allocUnsafe(12);
    buf.write(crypto.randomBytes(8).toString('hex'), 0, 'hex');
    buf.writeInt32BE(parseInt(Date.now() / 60000, 10), 8);
    return buf.toString('base64');
  }

  _signedNonce(ssecret, nonce) {
    const s = Buffer.from(ssecret, 'base64');
    const n = Buffer.from(nonce, 'base64');
    return crypto.createHash('sha256').update(s).update(n).digest('base64');
  }

  _generateRc4Body(url, signedNonce, nonce, params, ssecurity) {
    params['rc4_hash__'] = this._generateEncSignature(url, 'POST', signedNonce, params);
    for (const [key, value] of Object.entries(params)) {
      params[key] = this._encryptRc4(signedNonce, value);
    }
    params['signature'] = this._generateEncSignature(url, 'POST', signedNonce, params);
    params['ssecurity'] = ssecurity;
    params['_nonce'] = nonce;
    return params;
  }

  _generateEncSignature(url, method, signedNonce, params) {
    const signatureArr = [];
    signatureArr.push(method.toUpperCase());
    signatureArr.push(url.split('com')[1].replace('/app/', '/'));
    const paramKeys = Object.keys(params);
    paramKeys.sort();
    for (let i = 0, {
        length
      } = paramKeys; i < length; i++) {
      const key = paramKeys[i];
      signatureArr.push(`${key}=${params[key]}`);
    }
    signatureArr.push(signedNonce);
    const signatureStr = signatureArr.join('&');
    return crypto.createHash('sha1').update(signatureStr).digest('base64');
  }

  _encryptRc4(password, payload) {
    let k = Buffer.from(password, 'base64');
    //----------## crypto rc4 ##----------
    //Since nodejs v18.x.x, rc4 seems deaprecated in crypto? due to a new openssl?
    //let cipher = crypto.createCipheriv('rc4', k, '');
    //cipher.update(new Buffer(1024));
    //return cipher.update(payload).toString('base64');
    //----------## crypto end ##----------
    // for now lets use a custom rc4 implementation
    let cipher = CustomCryptRC4.create(k, 1024);
    return cipher.encode(payload);
  }

  _decryptRc4(password, payload) {
    let k = Buffer.from(password, 'base64');
    let p = Buffer.from(payload, 'base64');
    //----------## crypto rc4 ##----------
    //Since nodejs v18.x.x, rc4 seems deaprecated in crypto? due to a new openssl?
    //let decipher = crypto.createDecipheriv('rc4', k, '');
    //decipher.update(new Buffer(1024));
    //return decipher.update(p).toString();
    //----------## crypto end ##----------
    // for now lets use a custom rc4 implementation
    let decipher = CustomCryptRC4.create(k, 1024);
    return decipher.decode(p);
  }

  async _loginStep1() {
    const url = 'https://account.xiaomi.com/pass/serviceLogin?sid=xiaomiio&_json=true';
    const res = await fetch(url, { timeout: this.requestTimeout });

    const content = await res.text();
    const {
      statusText
    } = res;
    this.logger.debug(`(MiCloud) Login step 1`);
    this.logger.deepDebug(`(MiCloud) Login step 1 result: ${statusText} - ${content}`);

    if (!res.ok) {
      throw new Error(`Response step 1 error with status ${statusText}`);
    }

    const data = this._parseJson(content);

    if (!data._sign) {
      throw new Error('Login step 1 failed');
    }

    return {
      sign: data._sign,
    };
  }

  async _loginStep2(username, password, sign) {
    const formData = querystring.stringify({
      hash: crypto
        .createHash('md5')
        .update(password)
        .digest('hex')
        .toUpperCase(),
      _json: 'true',
      sid: 'xiaomiio',
      callback: 'https://sts.api.io.mi.com/sts',
      qs: '%3Fsid%3Dxiaomiio%26_json%3Dtrue',
      _sign: sign,
      user: username,
    });

    const url = 'https://account.xiaomi.com/pass/serviceLoginAuth2';
    const res = await fetch(url, {
      method: 'POST',
      body: formData,
      timeout: this.requestTimeout,
      headers: {
        'User-Agent': this.USERAGENT,
        'Content-Type': 'application/x-www-form-urlencoded',
        Cookie: [
          'sdkVersion=accountsdk-18.8.15',
          `deviceId=${this.CLIENT_ID};`
        ].join('; '),
      },
    });

    const content = await res.text();
    const {
      statusText
    } = res;
    this.logger.debug(`(MiCloud) Login step 2`);
    // v2.2.1 — 응답 본문에 ssecurity·인증 URL이 포함됨 → 필드 존재 여부만 기록(로그 공유 시 유출 방지)
    this.logger.deepDebug(`(MiCloud) Login step 2 result: ${statusText} - (body masked; fields: ${(() => { try { return Object.keys(JSON.parse(content.replace('&&&START&&&', ''))).join(','); } catch (_) { return 'unparsed'; } })()})`);

    if (!res.ok) {
      throw new Error(`Response step 2 error with status ${statusText}`);
    }

    const {
      ssecurity,
      userId,
      location,
      notificationUrl,
    } = this._parseJson(content);

    if (!ssecurity && notificationUrl) {
      throw new Errors.TwoFactorRequired(notificationUrl);
    }

    if (!ssecurity || !userId || !location) {
      throw new Error('Login step 2 failed');
    }

    this.ssecurity = ssecurity; // Buffer.from(data.ssecurity, 'base64').toString('hex');
    this.userId = userId;
    return {
      ssecurity,
      userId,
      location,
    };
  }

  async _loginStep3(location) {
    const url = location;
    const res = await fetch(url, { timeout: this.requestTimeout });

    const content = await res.text();
    const {
      statusText
    } = res;
    this.logger.debug(`(MiCloud) Login step 3`);
    this.logger.deepDebug(`(MiCloud) Login step 3 result: ${statusText} - ${content}`);

    if (!res.ok) {
      throw new Error(`Response step 3 error with status ${statusText}`);
    }

    const headers = res.headers.raw();
    const cookies = headers['set-cookie'];
    let serviceToken;
    cookies.forEach(cookieStr => {
      const cookie = cookieStr.split('; ')[0];
      const idx = cookie.indexOf('=');
      const key = cookie.substr(0, idx);
      const value = cookie.substr(idx + 1, cookie.length).trim();
      if (key === 'serviceToken') {
        serviceToken = value;
      }
    });
    if (!serviceToken) {
      throw new Error('Login step 3 failed');
    }
    return {
      serviceToken,
    };
  }

  async _verifyTicket(verifyUrl, ticket) {
    this.logger.debug(`(MiCloud) Verifying 2FA ticket`);

    const path = 'fe/service/identity/authStart';
    if (!verifyUrl || !verifyUrl.includes(path)) {
      throw new Error('Invalid verify URL');
    }

    if (!ticket) {
      throw new Error('Missing 2FA ticket');
    }

    const listUrl = verifyUrl.replace(path, 'identity/list');
    let listRes = await fetch(listUrl, { timeout: this.requestTimeout });
    const listContent = await listRes.text();

    if (!listRes.ok) {
      const {
        statusText
      } = listRes;
      throw new Error(`Response identity list fetch error with status ${statusText}`);
    }

    this._storeSetCookies(listRes);

    this.logger.debug(`(MiCloud) Fetched 2FA identity list`);

    // Validate that the required identity_session cookie was actually set
    if (Object.keys(this._cookieJar).length === 0 || !Object.hasOwn(this._cookieJar, 'identity_session')) {
      throw new Error('Invalid response. Could not find identity session cookie');
    }

    let listData = this._parseJson(listContent);
    this.logger.deepDebug(`(MiCloud) 2FA fetch identity list result: ${JSON.stringify(listData)}`);

    const apiMap = {
      4: '/identity/auth/verifyPhone',
      8: '/identity/auth/verifyEmail',
    };

    const flag = listData.flag ?? 4;
    const apiPath = apiMap[flag];
    if (!apiPath) {
      throw new Error('Invalid response. Missing or invalid API flag in response');
    }

    this.logger.debug(`(MiCloud) Got 2FA API path: ${apiPath}`);

    const postUrl = new URL(`https://account.xiaomi.com${apiPath}`);
    postUrl.searchParams.set('_dc', String(Date.now()));

    const postData = new URLSearchParams({
      ticket,
      trust: 'true',
      _json: 'true',
      _flag: flag
    });

    const verifyResponse = await fetch(postUrl.toString(), {
      method: 'POST',
      timeout: this.requestTimeout,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'Cookie': this._cookieHeader(),
        'Accept': 'application/json',
        'x-requested-with': 'XMLHttpRequest'
      },
      body: postData.toString(),
    });

    this._storeSetCookies(verifyResponse);

    const verifyContent = await verifyResponse.text();
    this.logger.deepDebug(`(MiCloud) 2FA ticket verification content: ${verifyContent}`);

    const verifyData = this._parseJson(verifyContent);

    if ((verifyData.code === 0) && verifyData.location) {
      this.logger.debug(`(MiCloud) 2FA ticket verification successful`);
      this.logger.deepDebug(`(MiCloud) 2FA ticket verification result: ${verifyData.code} - ${verifyData.location}`);
      return verifyData.location;
    } else {
      const errorDescription = verifyData.desc || verifyData.tips || 'Unknown error';
      throw new Error(`2FA verification failed: ${errorDescription} (Code: ${verifyData.code})`);
    }

  }

  // --- cookie jar helpers ---
  _storeSetCookies(res) {
    try {
      const raw = res.headers && typeof res.headers.raw === 'function' ? res.headers.raw() : {};
      const setCookies = raw && raw['set-cookie'] ? raw['set-cookie'] : [];
      if (!setCookies || !setCookies.length) return;

      setCookies.forEach(cookieStr => {
        const cookie = cookieStr.split(';')[0];
        const idx = cookie.indexOf('=');
        if (idx > 0) {
          const key = cookie.substr(0, idx).trim();
          const value = cookie.substr(idx + 1).trim();
          this._cookieJar[key] = value;
        }
      });
    } catch (e) {
      this.logger.deepDebug(`(MiCloud) Cookie Jar - Error parsing cookie. Reason: ${e.message}`);
    }
  }

  _cookieHeader(extraPairs = []) {
    const parts = [
      'sdkVersion=accountsdk-18.8.15',
      `deviceId=${this.CLIENT_ID}`
    ];

    for (const [k, v] of Object.entries(this._cookieJar)) {
      parts.push(`${k}=${v}`);
    }

    if (extraPairs && extraPairs.length) {
      extraPairs.forEach(p => parts.push(p));
    }

    return parts.join('; ');
  }
  // -------------------------------

}

module.exports = MiCloud;

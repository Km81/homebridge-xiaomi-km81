'use strict';

/**
 * CloudMiioTransport (Task B)
 *
 * 레거시 miio(property) 프로토콜 선풍기를 MiCloud 의 RPC 패스스루(miioCall)로 제어하는 어댑터.
 * MiCloud.miioCall(did, method, params) 는 /home/rpc/{did} 로 raw miio 명령을 1:1 로 전달하므로,
 * 로컬에서 쓰던 get_prop / set_power 등을 그대로 클라우드를 통해 보낼 수 있다.
 *
 * 이로써 레거시 Smartmi 선풍기도 하이브리드(로컬 실패 → 클라우드 자동 전환)가 진짜로 동작한다.
 * MiotFan 의 클라우드(miotGetProps/miotSetProps)와 달리, 레거시는 miot 스펙(siid/piid)이 없으므로
 * 옛 property 프로토콜을 그대로 클라우드로 우회하는 것이 핵심.
 *
 * MiioFan 입장에서는 miioFanDevice 자리에 이 어댑터가 꽂히므로 코드 변경이 전혀 필요 없다.
 */

const LegacyMiioTransport = require('./LegacyMiioTransport.js');
const { withTimeout } = require('../common/helpers.js');

const CALL_TIMEOUT_MS = 8000;   // 클라우드 호출이 응답 없이 매달리는 것 방지

class CloudMiioTransport extends LegacyMiioTransport {
  constructor(miCloud, deviceId, model, country, log) {
    super(model, deviceId, log);
    this.miCloud = miCloud;
    this.country = country || null;
    this._authWarned = false;
    this._emptyWarned = false;
  }

  async connect() { return this; }

  // 클라우드에는 로컬 miIO.info 핸드셰이크가 없으므로 빈 객체를 반환한다(BaseFan.setupFan 안전).
  async info() { return {}; }

  async _rawCall(method, params) {
    if (!this.miCloud || !this._did) {
      throw new Error('CloudMiioTransport: miCloud/deviceId 가 없습니다');
    }
    let result;
    try {
      result = await withTimeout(
        this.miCloud.miioCall(this._did, method, params, this.country),
        CALL_TIMEOUT_MS,
        `cloud ${method}`
      );
    } catch (err) {
      // 401/403 등 인증 실패 = 세션 만료. 한 번만 명확히 안내한다.
      if (err && err.authFailed && !this._authWarned) {
        this._authWarned = true;
        this._warn(`MiCloud 세션이 만료되었거나 인증에 실패했습니다 — 설정 화면(또는 tools/micloud-login.js)에서 다시 로그인하세요.`);
      }
      throw err;
    }
    if (this._authWarned) this._info('(cloud) MiCloud 인증 복구 확인 — 클라우드 제어 재개'); // v2.0.0
    this._authWarned = false;

    // get_prop 응답이 비었으면 보통 지역(country)·deviceId 불일치 또는 기기 오프라인이다.
    if (method === 'get_prop') {
      if (!Array.isArray(result) || result.length === 0) {
        if (!this._emptyWarned) {
          this._emptyWarned = true;
          this._warn(`(cloud) 응답에 기기 데이터가 없습니다. did=${this._did}, 지역=${this.country || '계정기본'} — 지역(miCloudCountry)·deviceId 가 맞는지, 기기가 온라인인지, 세션이 만료되지 않았는지 확인하세요.`);
        }
      } else {
        if (this._emptyWarned) this._info('(cloud) 기기 데이터 수신 재개'); // v2.0.0
        this._emptyWarned = false;
      }
    }
    return result;
  }

  _info(msg) {
    try { this.log.info && this.log.info(msg); } catch (_) {}
  }

  _warn(msg) {
    try { this.log.warn ? this.log.warn(msg) : (this.log.info && this.log.info(msg)); } catch (_) {}
  }
}

module.exports = CloudMiioTransport;

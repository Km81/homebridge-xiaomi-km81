'use strict';

/**
 * LocalMiioTransport (Task A)
 *
 * 레거시 miio(property) 프로토콜 선풍기를 dgram(MiioProtocol) 으로 직접 제어하는 어댑터.
 * 기존엔 aholstenson `miio` 패키지를 썼는데, 그 패키지는 핸드셰이크/server-stamp 를
 * Device 수명 동안 캐시하고 세션이 꼬여도(Mi Home 앱이 로컬 세션을 가져가는 등) 재핸드셰이크
 * 하지 않아, 한 번 "응답 없음"이 나면 프로세스를 재시작해야만 복구됐다(일부 miot 기기에서 재현).
 *
 * 이 어댑터는 FanController 가 재연결할 때마다 새로 생성/파기되고, 그때마다 새 소켓으로
 * 재핸드셰이크하므로 매 재연결이 fresh server-stamp 를 확보한다 → 자동 복구.
 * (신형 miot 선풍기의 LocalMiotTransport 와 동일한 해법을 레거시 선풍기에 적용.)
 */

const LegacyMiioTransport = require('./LegacyMiioTransport.js');
const MiioProtocol = require('../common/MiioProtocol.js');

class LocalMiioTransport extends LegacyMiioTransport {
  constructor(address, token, deviceId, model, log) {
    super(model, deviceId, log);
    this.address = address;
    this.token = token;

    this._protocol = new MiioProtocol(this._makeProtocolLogger());
    const init = { token };
    if (this._did !== undefined) init.did = Number(this._did);
    this._protocol.updateDevice(address, init);
  }

  _makeProtocolLogger() {
    const log = this.log;
    return {
      debug: (m) => { try { log.debug && log.debug(m); } catch (_) {} },
      deepDebug: () => {},
    };
  }

  // 핸드셰이크 한 번으로 server-stamp 와 did 를 확보한다.
  async connect() {
    try {
      await this._protocol.handshake(this.address);
    } catch (e) {
      this.destroy();   // 핸드셰이크 실패 시 소켓 누수 방지(반복 재탐색 실패 시 치명적)
      throw e;
    }
    const device = this._protocol.getDevice(this.address);
    if (device.did && !this._did) {
      this._did = String(device.did);
      this.id = `miio:${this._did}`;
    }
    return this;
  }

  async info() {
    return this._protocol.getInfo(this.address);
  }

  async _rawCall(method, params) {
    return this._protocol.send(this.address, method, params);
  }

  destroy() {
    super.destroy();
    try { this._protocol.destroy(); } catch (_) {}
  }
}

module.exports = LocalMiioTransport;

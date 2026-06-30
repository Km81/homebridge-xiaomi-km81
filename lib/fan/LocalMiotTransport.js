'use strict';

/**
 * LocalMiotTransport
 *
 * aholstenson `miio` 패키지의 Device API 중 miot 선풍기(MiotFan 계열)가 실제로 쓰는
 * 부분만 흉내내는 얇은 어댑터다. 내부적으로는 dgram 기반 MiioProtocol 을 사용한다.
 *
 * 왜 필요한가: aholstenson `miio` 는 핸드셰이크와 server-stamp 를 Device 객체 수명 동안
 * 캐시하고, 실패 시에도(120초 staleness 외에는) 재핸드셰이크하지 않는다. Mi Home 앱이
 * 신형 miot 기기(xiaomi.fan.p45 등)의 단일 로컬 세션을 가져가면 캐시된 stamp 가 죽어
 * 이후 모든 호출이 타임아웃되고, 프로세스를 재시작해야만 복구된다("응답 없음" 증상).
 *
 * 이 어댑터는 FanController 가 재연결할 때마다 새로 생성/파기되고, 그때마다 새 소켓으로
 * 재핸드셰이크하므로 매 재연결이 fresh server-stamp 를 확보한다 → 자동 복구.
 *
 * MiotFan 이 사용하는 표면:
 *   - device.call('get_properties' | 'set_properties' | 'action', params)
 *   - device.miioModel
 *   - device.id            ('miio:<did>')
 *   - device.management.info()
 *   - device.destroy()
 */

const MiioProtocol = require('../common/MiioProtocol.js');

class LocalMiotTransport {
  constructor(address, token, deviceId, model, log) {
    this.address = address;
    this.token = token;
    this.miioModel = model;
    this._did = (deviceId !== undefined && deviceId !== null && `${deviceId}`.length > 0) ? String(deviceId) : undefined;
    this.id = this._did ? `miio:${this._did}` : undefined;
    this.log = log || console;

    // aholstenson miio 호환: device.management.info()
    this.management = { info: () => this.info() };

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

  // 연결: 핸드셰이크 한 번으로 server-stamp 와 did 를 확보한다.
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

  // MiotFan 이 호출하는 유일한 메서드. params 는 miot 속성/액션 배열.
  async call(method, params, options = {}) {
    return this._protocol.send(this.address, method, params, options);
  }

  destroy() {
    try { this._protocol.destroy(); } catch (_) {}
  }
}

module.exports = LocalMiotTransport;

'use strict';

/**
 * LocalMiioDevice
 *
 * aholstenson `miio` 패키지의 miio.device() 를 대체하는 dgram 기반 어댑터.
 * 공기청정기/멀티탭/가습기가 실제로 쓰는 표면만 제공한다:
 *   - device.call(method, params [, options])   ('get_prop' | 'set_power' | 'get_properties' | 'set_properties' | ...)
 *   - device.destroy()
 *   - device.connect()                          (이 어댑터 전용 — 핸드셰이크)
 *   - device.miioModel / device.id / device.management.info()  (호환용, 선택)
 * (accessory 들은 device.init() 를 `typeof === 'function'` 으로만 호출하므로, 여기엔 없어서 자동 생략된다.)
 *
 * 왜 필요한가: aholstenson `miio` 는 network.js 가 모듈 전역 싱글톤이라 UDP 소켓 하나와
 * "주소→기기" 캐시를 프로세스 수명 내내 보관한다. 한 번 연결되면 enrich() 가 단락되어
 * 재연결 시 실제 연결을 검증조차 하지 않고 캐시된 객체를 그대로 돌려준다. 그래서 와이파이가
 * 끊겼다 다시 붙어도 죽은 세션(만료된 server-stamp)을 재사용해 모든 호출이 타임아웃되고,
 * 공유기는 멀쩡한데 홈브릿지만 계속 실패하다가 프로세스(컨테이너) 재시작을 해야만 복구된다.
 *
 * 이 어댑터는 기기마다 독립된 MiioProtocol(자체 소켓 + 소켓 에러/close 시 자동 재생성)을
 * 쓰고, 재연결마다 새 인스턴스로 fresh 핸드셰이크하며, server-stamp 가 오래되면(>120s)
 * 다시 핸드셰이크한다. 따라서 와이파이 flap 에서 재부팅 없이 자동 복구된다.
 * (선풍기 LocalMiotTransport / LocalMiioTransport 와 동일한 해법을 공용으로 일반화.)
 */

const MiioProtocol = require('./MiioProtocol.js');

class LocalMiioDevice {
  constructor(address, token, deviceId, model, log) {
    this.address = address;
    this.token = token;
    this.miioModel = model || null;
    // did 는 보통 핸드셰이크로 학습한다(기존 miio.device() 동작과 동일). 숫자형 did 가 명시되면 힌트로만 사용.
    this._did = (deviceId !== undefined && deviceId !== null && /^\d+$/.test(`${deviceId}`)) ? String(deviceId) : undefined;
    this.id = this._did ? `miio:${this._did}` : undefined;
    this.log = log || console;

    // aholstenson 호환: device.management.info()
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

  // 핸드셰이크 한 번으로 server-stamp 와 did 를 확보한다. 실패하면 reject → accessory 가 재연결 예약.
  async connect() {
    await this._protocol.handshake(this.address);
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

  // miio.device().call 과 동일 표면. method/params 를 그대로 기기에 전달한다.
  async call(method, params = [], options = {}) {
    return this._protocol.send(this.address, method, params, options);
  }

  destroy() {
    try { this._protocol.destroy(); } catch (_) {}
  }
}

module.exports = LocalMiioDevice;

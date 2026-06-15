/**
 * MiioProtocol
 *
 * Low-level miio packet protocol for Xiaomi devices (UDP/AES on port 54321).
 * 본 모듈은 merdok/homebridge-miot 의 MiioProtocol.js (MIT) 를 차용해 단순화한
 * 버전이다. Qingping Air Monitor 와 같이 miio 패키지를 우회해야 하는 기기에서 사용.
 */

'use strict';

const EventEmitter = require('events');
const crypto = require('crypto');
const dgram = require('dgram');

const PORT = 54321;
const HANDSHAKE_TIMEOUT = 5000;
const DEFAULT_TIMEOUT = 4000;
const DEFAULT_RETRIES = 2;
const RECOVERABLE_ERRORS = [-30001, -9999];

class MiioProtocol extends EventEmitter {
  constructor(logger) {
    super();
    this.logger = logger;
    this._devices = new Map();
    this.init();
  }

  init() { this.createSocket(); }
  destroy() { this.destroySocket(); }

  createSocket() {
    this._socket = dgram.createSocket('udp4');
    this._socket.on('listening', () => {
      const address = this._socket.address();
      this.logger.deepDebug(`(Protocol) Server listening ${address.address}:${address.port}`);
    });
    this._socket.on('message', (msg, rinfo) => this._onMessage(rinfo.address, msg));
    this._socket.on('error', error => {
      this.logger.debug(`(Protocol) Socket error: ${error}`);
      // 치명적 소켓 오류는 소켓을 닫으므로, 'close' 핸들러에서 재생성해 send 가 영구 실패하지 않게 한다.
      try { this._socket.close(); } catch (_) {}
    });
    this._socket.on('close', () => {
      if (!this._destroyed) {
        this.logger.debug('(Protocol) Socket closed, recreating');
        this.createSocket();
      }
    });
  }

  destroySocket() {
    this._destroyed = true;
    if (this._socket) { try { this._socket.close(); } catch (_) {} }
  }

  hasDevice(address) { return this._devices.has(address); }

  getDevice(address) {
    if (!this._devices.has(address)) this._devices.set(address, {});
    const device = this._devices.get(address);
    if (!device._lastId) device._lastId = 0;
    if (!device._promises) device._promises = new Map();
    return device;
  }

  setDevice(address, data) {
    const device = { ...data };
    if (device.token) {
      device._token = Buffer.from(device.token, 'hex');
      device._tokenKey = crypto.createHash('md5').update(device._token).digest();
      device._tokenIV = crypto.createHash('md5').update(device._tokenKey).update(device._token).digest();
    }
    this._devices.set(address, device);
  }

  updateDevice(address, data) {
    const device = Object.assign(this.getDevice(address), data);
    this.setDevice(address, device);
  }

  async getDeviceInfo(address) {
    const device = this.getDevice(address);
    if (device) return device.deviceInfo;
  }

  _onMessage(address, msg) {
    try {
      const data = this._decryptMessage(address, msg);
      if (data === null) {
        this.logger.deepDebug(`(Protocol) ${address} -> Handshake reply`);
        this._onHandshake(address);
      } else {
        this.logger.deepDebug(`(Protocol) ${address} -> Data: ${data}`);
        this._onData(address, data);
      }
    } catch (err) {
      this.logger.debug(`(Protocol) ${address} -> Unable to parse packet: ${err}`);
    }
  }

  _decryptMessage(address, msg) {
    const device = this.getDevice(address);
    const deviceId = msg.readUInt32BE(8);
    const stamp = msg.readUInt32BE(12);
    const checksum = msg.slice(16, 32);
    const encrypted = msg.slice(32);

    if (stamp > 0) {
      device._serverStamp = stamp;
      device._serverStampTime = Date.now();
    }

    if (encrypted.length === 0) {
      if (deviceId !== device.did) device.did = deviceId;
      return null;
    }

    if (!device._token) {
      throw new Error(`Missing token of device ${deviceId} - ${address}`);
    }

    const digest = crypto.createHash('md5')
      .update(msg.slice(0, 16)).update(device._token).update(encrypted).digest();
    if (!checksum.equals(digest)) {
      throw new Error(`Invalid packet, checksum was ${checksum} should be ${digest}`);
    }

    const decipher = crypto.createDecipheriv('aes-128-cbc', device._tokenKey, device._tokenIV);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]);
  }

  _encryptMessage(address, data) {
    const device = this.getDevice(address);
    if (!device._token || !device.did) {
      throw new Error(`${address} <- Missing token or deviceId for send command`);
    }
    const header = Buffer.alloc(2 + 2 + 4 + 4 + 4 + 16);
    header.writeInt16BE(0x2131);
    const cipher = crypto.createCipheriv('aes-128-cbc', device._tokenKey, device._tokenIV);
    const encrypted = Buffer.concat([cipher.update(data), cipher.final()]);
    header.writeUInt16BE(32 + encrypted.length, 2);
    header.writeUInt32BE(0x00000000, 4);
    if (device._serverStampTime) {
      const secondsPassed = Math.floor((Date.now() - device._serverStampTime) / 1000);
      header.writeUInt32BE(device._serverStamp + secondsPassed, 12);
    } else {
      header.writeUInt32BE(0xffffffff, 12);
    }
    header.writeUInt32BE(Number(device.did), 8);
    const digest = crypto.createHash('md5')
      .update(header.slice(0, 16)).update(device._token).update(encrypted).digest();
    digest.copy(header, 16);
    return Buffer.concat([header, encrypted]);
  }

  _onHandshake(address) {
    const device = this.getDevice(address);
    if (device._handshakeResolve) device._handshakeResolve();
  }

  _onData(address, msg) {
    if (msg[msg.length - 1] === 0) msg = msg.slice(0, msg.length - 1);
    let str = msg.toString('utf8');
    str = str.replace(/[\x00-\x09\x0B-\x0C\x0E-\x1F\x7F-\x9F]/g, '');
    this.logger.deepDebug(`(Protocol) ${address} -> Message: ${str}`);
    try {
      const data = JSON.parse(str);
      const device = this.getDevice(address);
      device.lastExecTime = data.exe_time;
      const p = device._promises.get(data.id);
      if (!p) return;
      if (typeof data.result !== 'undefined') p.resolve(data.result);
      else p.reject(data.error || new Error('miio device returned no result'));
    } catch (err) {
      this.logger.debug(`(Protocol) ${address} -> Invalid JSON: ${err}`);
    }
  }

  _socketSend(msg, address, port = PORT) {
    return new Promise((resolve, reject) => {
      this._socket.send(msg, 0, msg.length, port, address, err => err ? reject(err) : resolve());
    });
  }

  _handshake(address) {
    const msg = Buffer.from('21310020ffffffffffffffffffffffffffffffffffffffffffffffffffffffff', 'hex');
    return this._socketSend(msg, address);
  }

  _send(address, json) {
    const msg = this._encryptMessage(address, Buffer.from(JSON.stringify(json), 'utf8'));
    return this._socketSend(msg, address);
  }

  async handshake(address) {
    if (!address) throw new Error('Missing address for handshake');
    this.logger.deepDebug(`(Protocol) Start handshake ${address}`);
    const device = this.getDevice(address);
    const needsHandshake = !device._serverStampTime || (Date.now() - device._serverStampTime) > 120000;
    if (!needsHandshake) return Promise.resolve();
    if (device._handshakePromise) return device._handshakePromise;

    device._handshakePromise = new Promise((resolve, reject) => {
      // resolve/reject/timeout 모든 경로에서 동일한 정리를 수행한다.
      // 정리하지 않으면 send 에러나 timeout 후 _handshakePromise 가 영원히
      // rejected 상태로 남아 이후 모든 handshake() 가 깨진 promise 를 반환한다.
      const cleanup = () => {
        clearTimeout(device._handshakeTimeout);
        device._handshakeResolve = null;
        device._handshakeTimeout = null;
        device._handshakePromise = null;
      };
      const fail = (err) => {
        cleanup();
        reject(err);
      };
      this._handshake(address).catch(fail);
      device._handshakeResolve = () => {
        cleanup();
        resolve();
      };
      device._handshakeTimeout = setTimeout(() => {
        const err = new Error('Could not connect to device, handshake timeout');
        err.code = 'timeout';
        fail(err);
      }, HANDSHAKE_TIMEOUT);
    });
    return device._handshakePromise;
  }

  async send(address, method, params = [], options = {}) {
    this.logger.deepDebug(`(Protocol) Call ${address}: ${method} - ${JSON.stringify(params)} - ${JSON.stringify(options)}`);
    const request = { method, params };
    const device = this.getDevice(address);
    const requestTimeout = options.timeout >= 0 ? options.timeout : DEFAULT_TIMEOUT;

    return new Promise((resolve, reject) => {
      let resolved = false;
      let retriesLeft = options.retries >= 0 ? options.retries : DEFAULT_RETRIES;

      const retry = () => {
        if (resolved) return;
        if (retriesLeft-- > 0) send();
        else {
          this.logger.debug(`(Protocol) ${address} <- Reached maximum retries: ${method}`);
          const err = new Error('Call to device timed out');
          err.code = 'timeout';
          promise.reject(err);
        }
      };

      const promise = {
        resolve: res => {
          resolved = true;
          device._promises.delete(request.id);
          resolve(res);
        },
        reject: err => {
          device._promises.delete(request.id);
          if (!(err instanceof Error) && typeof err.code !== 'undefined') {
            const { code, message } = err;
            err = new Error(message);
            err.code = code;
          }
          if (RECOVERABLE_ERRORS.includes(err.code)) {
            this.logger.deepDebug(`(Protocol) ${address} <- Recoverable error (${err.code}) ${err.message}, retries left: ${retriesLeft}`);
            retry();
          } else {
            this.logger.deepDebug(`(Protocol) ${address} <- Error (${err.code}) ${err.message}`);
            resolved = true;
            reject(err);
          }
        },
      };

      const send = () => {
        // 핸드셰이크가 성공했을 때만 요청을 전송한다. 타임아웃이면 retry() 로만 재시도하고
        // 절대 fall-through 하지 않는다 (기존엔 catch 가 값을 반환해 .then 이 그대로 실행돼,
        // 핸드셰이크 안 된 연결로 요청을 보내고 retry 를 이중 예약하던 버그).
        this.handshake(address).then(() => {
          let id;
          if (request.id) {
            id = device._lastId + 100;
            device._promises.delete(request.id);
          } else {
            id = device._lastId + 1;
          }
          if (id >= 10000) id = 1;
          device._lastId = id;
          request.id = id;
          device._promises.set(id, promise);
          this._send(address, request).catch(promise.reject);
          setTimeout(retry, requestTimeout);
        }).catch(err => {
          if (err && err.code === 'timeout') {
            this.logger.debug(`(Protocol) ${address} <- Handshake timed out`);
            retry();
            return;
          }
          promise.reject(err);
        });
      };
      send();
    });
  }

  async getInfo(address, params = { timeout: 5000, retries: 3 }) {
    const device = this.getDevice(address);
    return new Promise((resolve, reject) => {
      this.send(address, 'miIO.info', params).then(result => {
        device.deviceInfo = { ...result };
        resolve(device.deviceInfo);
      }).catch(reject);
    });
  }
}

module.exports = MiioProtocol;

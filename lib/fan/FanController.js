'use strict';

const miio = require('miio');
const EventEmitter = require('events');
const FanDeviceFactory = require('./FanDeviceFactory.js');
const Events = require('./Events.js');

// miio 호출이 reject 없이 무한 대기(hang)하면 재연결이 영영 트리거되지 않아
// "시간이 지나면 응답 없음, 재부팅해야 복구" 증상이 생긴다. 호출에 타임아웃을 걸어
// hang 을 reject 로 전환하고, setTimeout 루프로 폴링 중첩을 막는다.
const CONNECT_TIMEOUT_MS = 8000;    // miio.device() 핸드셰이크 최대 대기
const POLL_TIMEOUT_MS = 8000;       // 단일 폴링 최대 대기
const RECONNECT_BASE_MS = 2000;     // 재연결 실패 시 첫 재시도 지연 (지수 백오프 시작)
const RECONNECT_MAX_MS = 30000;     // 재연결 재시도 지연 상한

class FanController extends EventEmitter {
  constructor(ip, token, deviceId, model, name, pollingInterval, log) {
    super();

    this.ip = ip;
    this.token = token;
    this.deviceId = deviceId;
    this.model = model;
    this.name = name;
    this.pollingInterval = pollingInterval || 5000;
    this.log = log || console;
    this.deepDebugLog = false;

    if (!this.ip) this.logError(`ip required!`);
    if (!this.token) this.logError(`token required!`);

    this.fanDevice = undefined;
    this.pollTimer = undefined;
    this._retryTimer = undefined;
    this._connecting = false;
    this._stopPolling = false;
    this._reconnectAttempt = 0;
  }

  connectToFan() {
    if (this.model && this.model.length > 0) {
      this.logDebug(`Cached fan model ${this.model} found! Creating fan device!`);
      this.createFanDevice(null, this.model);
      this.startFanDiscovery();
    } else {
      this.logDebug(`Fan model unknown! Starting discovery!`);
      this.startFanDiscovery();
    }
  }

  // hang 방어: promise 가 ms 안에 settle 하지 않으면 reject 한다.
  withTimeout(promise, ms, label) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      promise.then(
        (v) => { clearTimeout(t); resolve(v); },
        (e) => { clearTimeout(t); reject(e); }
      );
    });
  }

  startFanDiscovery() {
    if (this._connecting) return;     // 중복 연결 시도 방지
    this._connecting = true;

    this.withTimeout(miio.device({ address: this.ip, token: this.token }), CONNECT_TIMEOUT_MS, 'connect')
      .then(device => {
        this._connecting = false;
        this._reconnectAttempt = 0;   // 연결 성공 → 백오프 리셋
        if (this._retryTimer) { clearTimeout(this._retryTimer); this._retryTimer = undefined; }
        this.logInfo(`Connected to Fan ${device.miioModel}`);
        this.createFanDevice(device, null);
        this.startFanPolling();
        this.emit(Events.FAN_CONNECTED, this.fanDevice);
      })
      .catch(err => {
        this._connecting = false;
        // 지수 백오프: 첫 실패는 2초 뒤 재시도, 계속 실패하면 점점 늘려 최대 30초.
        this._reconnectAttempt++;
        const delay = Math.min(RECONNECT_BASE_MS * Math.pow(2, this._reconnectAttempt - 1), RECONNECT_MAX_MS);
        this.logDebug(`Could not connect to the fan! Retrying in ${Math.round(delay / 1000)} seconds! Error: ${err}`);
        if (err && err.stack) this.logDebug(err.stack);
        if (this.fanDevice) this.fanDevice.disconnectAndDestroyMiioDevice();
        if (this._retryTimer) clearTimeout(this._retryTimer);
        this._retryTimer = setTimeout(() => this.startFanDiscovery(), delay);
      });
  }

  createFanDevice(miioDevice, model) {
    if ((miioDevice || model) && !this.fanDevice) {
      this.fanDevice = FanDeviceFactory.createFanDevice(miioDevice, model, this.deviceId, this.name, this.log, this);
      this.fanDevice.on(Events.FAN_DEVICE_MANUAL_PROPERTIES_UPDATE, (res) => {
        this.emit(Events.FAN_PROPERTIES_UPDATED, res);
      });
      this.emit(Events.FAN_DEVICE_READY, this.fanDevice);
    } else if (this.fanDevice && miioDevice) {
      this.fanDevice.updateMiioDevice(miioDevice);
    }
  }

  // setInterval 대신 setTimeout 루프: 매 폴링이 끝난(또는 타임아웃된) 뒤에야 다음 폴링을
  // 예약하므로 hang 시 폴링이 중첩되지 않고, 한 번 실패하면 즉시 teardown 후 재연결한다.
  startFanPolling() {
    if (this.pollTimer) { clearTimeout(this.pollTimer); this.pollTimer = undefined; }
    this._stopPolling = false;

    const tick = () => {
      if (this._stopPolling || !this.fanDevice) return;
      this.withTimeout(this.fanDevice.pollProperties(), POLL_TIMEOUT_MS, 'poll')
        .then(result => {
          this.emit(Events.FAN_PROPERTIES_UPDATED, result);
          this.logDeepDebug(`Updated properties: \n ${JSON.stringify(this.fanDevice.getFanProperties(), null, 2)}`);
          if (!this._stopPolling) this.pollTimer = setTimeout(tick, this.pollingInterval);
        })
        .catch(err => {
          if (this._stopPolling) return;
          this.logDebug(`Poll failed! No response from Fan! Reconnecting. Error: ${err}`);
          this._stopPolling = true;
          if (this.pollTimer) { clearTimeout(this.pollTimer); this.pollTimer = undefined; }
          this.fanDevice.disconnectAndDestroyMiioDevice();
          this.emit(Events.FAN_DISCONNECTED, null);
          this.startFanDiscovery();
        });
    };

    this.pollTimer = setTimeout(tick, this.pollingInterval);
  }

  shutdown() {
    this._stopPolling = true;
    if (this.pollTimer) { clearTimeout(this.pollTimer); this.pollTimer = undefined; }
    if (this._retryTimer) { clearTimeout(this._retryTimer); this._retryTimer = undefined; }
    if (this.fanDevice) {
      try { this.fanDevice.disconnectAndDestroyMiioDevice(); } catch (_) {}
    }
  }

  /*----------========== LOG ==========----------*/

  setDeepDebugLogEnabled(enabled) { this.deepDebugLog = enabled; }
  isDeepDebugLogEnabled() { return this.deepDebugLog; }

  logInfo(msg, ...a)  { this.log.info((this.name ? `[${this.name}] ` : '') + msg, ...a); }
  logWarn(msg, ...a)  { this.log.warn((this.name ? `[${this.name}] ` : '') + msg, ...a); }
  logDebug(msg, ...a) { this.log.debug((this.name ? `[${this.name}] ` : '') + msg, ...a); }
  logError(msg, ...a) { this.log.error((this.name ? `[${this.name}] ` : '') + msg, ...a); }
  logDeepDebug(msg, ...a) { if (this.deepDebugLog) this.logDebug(msg, ...a); }
}

module.exports = FanController;

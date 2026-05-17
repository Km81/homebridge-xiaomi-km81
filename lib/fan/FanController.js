'use strict';

const miio = require('miio');
const EventEmitter = require('events');
const FanDeviceFactory = require('./FanDeviceFactory.js');
const Events = require('./Events.js');

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
    this.checkFanStatusInterval = undefined;
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

  startFanDiscovery() {
    const checkDelayTime = this.pollingInterval * 6;
    miio.device({ address: this.ip, token: this.token }).then(device => {
      this.logInfo(`Connected to Fan ${device.miioModel}`);
      this.createFanDevice(device, null);
      this.startFanPolling();
      this.emit(Events.FAN_CONNECTED, this.fanDevice);
    }).catch(err => {
      this.logDebug(err);
      if (err && err.stack) this.logDebug(err.stack);
      this.logDebug(`Could not connect to the fan! Retrying in ${checkDelayTime / 1000} seconds!`);
      if (this.fanDevice) this.fanDevice.disconnectAndDestroyMiioDevice();
      this._retryTimer = setTimeout(() => this.startFanDiscovery(), checkDelayTime);
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

  startFanPolling() {
    this.checkFanStatusInterval = setInterval(() => {
      this.fanDevice.pollProperties().then(result => {
        this.emit(Events.FAN_PROPERTIES_UPDATED, result);
        this.logDeepDebug(`Updated properties: \n ${JSON.stringify(this.fanDevice.getFanProperties(), null, 2)}`);
      }).catch(err => {
        if (this.checkFanStatusInterval) {
          this.logDebug(`Poll failed! No response from Fan! Stopping polling! Error: ${err}`);
          clearInterval(this.checkFanStatusInterval);
          this.checkFanStatusInterval = undefined;
          this.fanDevice.disconnectAndDestroyMiioDevice();
          this.emit(Events.FAN_DISCONNECTED, null);
          this.logDebug(`Trying to reconnect`);
          this.startFanDiscovery();
        }
      });
    }, this.pollingInterval);
  }

  shutdown() {
    if (this.checkFanStatusInterval) {
      clearInterval(this.checkFanStatusInterval);
      this.checkFanStatusInterval = undefined;
    }
    if (this._retryTimer) {
      clearTimeout(this._retryTimer);
      this._retryTimer = undefined;
    }
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

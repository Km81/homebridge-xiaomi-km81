'use strict';

const BaseFan = require('../../BaseFan.js');
const Events = require('../../Events.js');
const { withTimeout } = require('../../../common/helpers.js');

const CALL_TIMEOUT_MS = 8000;   // miio 호출이 응답 없이 매달리는 것 방지

class MiotFan extends BaseFan {
  constructor(miioDevice, model, deviceId, name, log) {
    super(miioDevice, model, deviceId, name, log);
  }

  modelSpecificSetup() {
    try {
      if (!this.deviceId) throw new Error(`Could not find deviceId for ${this.name}! deviceId is required for miot devices!`);
    } catch (error) {
      this.logError(error);
      return;
    }
    this.properties = {};
    this.propertiesDefs = {};
    this.commandDefs = {};
  }

  addFanProperties() { this.logDebug(`Needs to be implemented by devices!`); }

  doInitialPropertiesFetch() {
    this.requestAllProperties().then(() => {
      this.logDebug(`Got initial fan properties: \n ${JSON.stringify(this.getFanProperties(), null, 2)}`);
      if (this.supportsUseTimeReporting()) {
        this.logInfo(`Fan total use time: ${this.getUseTime()} minutes.`);
      }
    }).catch(err => {
      this.logDebug(`Error on initial property request! ${err}`);
    });
  }

  async pollProperties() {
    if (this.isFanConnected()) return this.requestAllProperties();
    return new Promise((_, reject) => reject(new Error('Fan not connected')));
  }

  getFanProperties() {
    if (this.isFanConnected()) return this.properties;
    return {};
  }

  getProtocolType() { return 'miot'; }

  defineProperty(prop, siid, piid) {
    if (!prop || !siid || !piid) {
      this.logWarn(`Cannot add property! prop: ${prop}, siid: ${siid}, piid: ${piid}!`);
      return;
    }
    const newProp = { did: this.deviceId, siid, piid };
    this.properties[prop] = 0;
    this.propertiesDefs[prop] = newProp;
  }

  defineCommand(cmd, siid, piid) {
    if (!cmd || !siid || !piid) {
      this.logWarn(`Cannot add command! cmd: ${cmd}, siid: ${siid}, piid: ${piid}!`);
      return;
    }
    this.commandDefs[cmd] = { did: this.deviceId, siid, piid };
  }

  pushProperty(result, name, returnObj) {
    if (returnObj.code === 0) {
      this.properties[name] = returnObj.value;
      result[name] = returnObj.value;
    }
    if (returnObj.code !== 0 || returnObj.value === undefined) {
      this.logDebug(`Error while parsing response for property ${name}. Response: ${JSON.stringify(returnObj)}`);
    }
  }

  async sendCommnd(cmd, value) {
    if (this.cloudConnected && this.miCloud) return this.sendCommandCloud(cmd, value);
    if (this.miioFanDevice) {
      const cmdDef = Object.assign({}, this.commandDefs[cmd]);
      cmdDef.value = value;
      return withTimeout(this.miioFanDevice.call('set_properties', [cmdDef]), CALL_TIMEOUT_MS, `cmd ${cmd}`).then(result => {
        this.logDebug(`Successfully send command ${cmd} with value ${value}! Result: ${JSON.stringify(result)}`);
      }).catch(err => {
        this.logWarn(`Error while executing command ${cmd} with value ${value}! ${err}`);
      });
    }
    return this.createErrorPromise(`Cannot execute command ${cmd} with value ${value}! Device not connected!`);
  }

  async setProperty(prop, value) {
    if (this.cloudConnected && this.miCloud) return this.setPropertyCloud(prop, value);
    if (this.isFanConnected()) {
      const propDef = Object.assign({}, this.propertiesDefs[prop]);
      propDef.value = value;
      return withTimeout(this.miioFanDevice.call('set_properties', [propDef]), CALL_TIMEOUT_MS, `set ${prop}`).then(result => {
        this.logDebug(`Successfully set property ${prop} to value ${value}! Result: ${JSON.stringify(result)}`);
        this.properties[prop] = value;
        this.emit(Events.FAN_DEVICE_MANUAL_PROPERTIES_UPDATE, result);
      }).catch(err => {
        this.logWarn(`Error while setting property ${prop} to value ${value}! ${err}`);
      });
    }
    return this.createErrorPromise(`Cannot set property ${prop} to value ${value}! Device not connected!`);
  }

  async requestAllProperties() {
    if (this.cloudConnected && this.miCloud) return this.requestAllPropertiesCloud();
    if (this.isFanConnected()) {
      const propKeys = Object.keys(this.propertiesDefs);
      const props = propKeys.map(k => this.propertiesDefs[k]);
      return withTimeout(this.miioFanDevice.call('get_properties', props), CALL_TIMEOUT_MS, 'get_properties').then(result => {
        const obj = {};
        if (!Array.isArray(result)) return obj;
        // 응답에 siid/piid 가 있으면 그것으로 매칭 (응답 순서/개수가 달라도 안전).
        // 없으면(구형 라이브러리) 위치 기반으로 폴백.
        const hasIds = result.length && typeof result[0] === 'object' && result[0] && result[0].siid != null;
        if (hasIds) {
          const byKey = {};
          for (const r of result) { if (r && r.siid != null && r.piid != null) byKey[`${r.siid}.${r.piid}`] = r; }
          for (const name of propKeys) {
            const def = this.propertiesDefs[name];
            const r = byKey[`${def.siid}.${def.piid}`];
            if (r) this.pushProperty(obj, name, r);
          }
        } else {
          for (let i = 0; i < result.length && i < propKeys.length; i++) {
            this.pushProperty(obj, propKeys[i], result[i]);
          }
        }
        return obj;
      });
    }
    return this.createErrorPromise(`Cannot poll all properties! Device not connected!`);
  }

  async requestProperty(prop) {
    if (this.isFanConnected()) {
      const propDef = this.propertiesDefs[prop];
      return withTimeout(this.miioFanDevice.call('get_properties', [propDef]), CALL_TIMEOUT_MS, `get ${prop}`).then(result => {
        this.logDebug(`Successfully updated property ${prop}! Result: ${JSON.stringify(result)}`);
        const obj = {};
        this.pushProperty(obj, prop, result[0]);
        this.emit(Events.FAN_DEVICE_MANUAL_PROPERTIES_UPDATE, result);
        return obj;
      }).catch(err => this.logDebug(`Error while requesting property ${prop}! ${err}`));
    }
    return this.createErrorPromise(`Cannot update property ${prop}! Device not connected!`);
  }

  /*----------========== CLOUD (MiCloud) ==========----------*/

  async requestAllPropertiesCloud() {
    const propKeys = Object.keys(this.propertiesDefs);
    const params = propKeys.map(k => ({ did: String(this.cloudDid), siid: this.propertiesDefs[k].siid, piid: this.propertiesDefs[k].piid }));
    const result = await withTimeout(this.miCloud.miotGetProps(params), CALL_TIMEOUT_MS, 'cloud get');
    const obj = {};
    if (Array.isArray(result)) {
      const byKey = {};
      for (const r of result) { if (r && r.siid != null && r.piid != null) byKey[`${r.siid}.${r.piid}`] = r; }
      for (const name of propKeys) {
        const d = this.propertiesDefs[name];
        const r = byKey[`${d.siid}.${d.piid}`];
        if (r) this.pushProperty(obj, name, r);
      }
    }
    return obj;
  }

  async setPropertyCloud(prop, value) {
    const d = this.propertiesDefs[prop];
    if (!d) return;
    try {
      await withTimeout(this.miCloud.miotSetProps([{ did: String(this.cloudDid), siid: d.siid, piid: d.piid, value }]), CALL_TIMEOUT_MS, `cloud set ${prop}`);
      this.properties[prop] = value;
      this.emit(Events.FAN_DEVICE_MANUAL_PROPERTIES_UPDATE, []);
    } catch (err) {
      this.logWarn(`(cloud) set ${prop}=${value} 실패: ${err && err.message || err}`);
    }
  }

  async sendCommandCloud(cmd, value) {
    const d = this.commandDefs[cmd];
    if (!d) return;
    try {
      await withTimeout(this.miCloud.miotSetProps([{ did: String(this.cloudDid), siid: d.siid, piid: d.piid, value }]), CALL_TIMEOUT_MS, `cloud cmd ${cmd}`);
    } catch (err) {
      this.logWarn(`(cloud) command ${cmd}=${value} 실패: ${err && err.message || err}`);
    }
  }
}

module.exports = MiotFan;

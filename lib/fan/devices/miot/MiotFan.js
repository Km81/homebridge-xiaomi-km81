'use strict';

const BaseFan = require('../../BaseFan.js');
const Events = require('../../Events.js');

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
    if (this.miioFanDevice) {
      const cmdDef = Object.assign({}, this.commandDefs[cmd]);
      cmdDef.value = value;
      return this.miioFanDevice.call('set_properties', [cmdDef]).then(result => {
        this.logDebug(`Successfully send command ${cmd} with value ${value}! Result: ${JSON.stringify(result)}`);
      }).catch(err => {
        this.logDebug(`Error while executing command ${cmd} with value ${value}! ${err}`);
      });
    }
    return this.createErrorPromise(`Cannot execute command ${cmd} with value ${value}! Device not connected!`);
  }

  async setProperty(prop, value) {
    if (this.isFanConnected()) {
      const propDef = Object.assign({}, this.propertiesDefs[prop]);
      propDef.value = value;
      return this.miioFanDevice.call('set_properties', [propDef]).then(result => {
        this.logDebug(`Successfully set property ${prop} to value ${value}! Result: ${JSON.stringify(result)}`);
        this.properties[prop] = value;
        this.emit(Events.FAN_DEVICE_MANUAL_PROPERTIES_UPDATE, result);
      }).catch(err => {
        this.logDebug(`Error while setting property ${prop} to value ${value}! ${err}`);
      });
    }
    return this.createErrorPromise(`Cannot set property ${prop} to value ${value}! Device not connected!`);
  }

  async requestAllProperties() {
    if (this.isFanConnected()) {
      const props = Object.keys(this.propertiesDefs).map(k => this.propertiesDefs[k]);
      const propKeys = Object.keys(this.propertiesDefs);
      return this.miioFanDevice.call('get_properties', props).then(result => {
        const obj = {};
        for (let i = 0; i < result.length; i++) {
          this.pushProperty(obj, propKeys[i], result[i]);
        }
        return obj;
      });
    }
    return this.createErrorPromise(`Cannot poll all properties! Device not connected!`);
  }

  async requestProperty(prop) {
    if (this.isFanConnected()) {
      const propDef = this.propertiesDefs[prop];
      return this.miioFanDevice.call('get_properties', [propDef]).then(result => {
        this.logDebug(`Successfully updated property ${prop}! Result: ${JSON.stringify(result)}`);
        const obj = {};
        this.pushProperty(obj, prop, result[0]);
        this.emit(Events.FAN_DEVICE_MANUAL_PROPERTIES_UPDATE, result);
        return obj;
      }).catch(err => this.logDebug(`Error while requesting property ${prop}! ${err}`));
    }
    return this.createErrorPromise(`Cannot update property ${prop}! Device not connected!`);
  }
}

module.exports = MiotFan;

'use strict';

const BaseFan = require('../../BaseFan.js');
const Events = require('../../Events.js');
const { withTimeout } = require('../../../common/helpers.js');

const CALL_TIMEOUT_MS = 8000;   // miio 호출이 응답 없이 매달리는 것 방지
// 기기가 한 번의 get_properties 로 처리 가능한 속성 수에는 한계가 있다(관측상 ~16).
// 안전하게 14개씩 끊어 보낸다. (예: zhimi.fan.za5 는 14개로, 한계에 걸려 응답이 잘리는 것 방지)
const MAX_PROPS_PER_CALL = 14;

class MiotFan extends BaseFan {
  constructor(miioDevice, model, deviceId, name, log) {
    super(miioDevice, model, deviceId, name, log);
  }

  modelSpecificSetup() {
    // 속성 저장소를 먼저 초기화한다. deviceId 가 없어도 addFanProperties 가 undefined 에
    // 쓰다 TypeError 로 죽지 않도록(특히 하이브리드 tripToCloud 의 비동기 경로에서 치명적).
    this.properties = {};
    this.propertiesDefs = {};
    this.commandDefs = {};
    if (!this.deviceId) {
      this.logError(`Could not find deviceId for ${this.name}! 클라우드/ miot 제어에는 deviceId 가 필수입니다.`);
    }
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

  _chunk(arr, size) {
    const out = [];
    for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
    return out;
  }

  // 여러 배치의 get_properties 응답을 하나로 합쳐 속성명 -> 값으로 매핑한다.
  // 응답에 siid/piid 가 있으면 그것으로 매칭(순서/개수가 달라도 안전), 없으면 위치 기반 폴백.
  _mergePropResults(propKeys, results) {
    const obj = {};
    if (!Array.isArray(results)) return obj;
    const hasIds = results.length && typeof results[0] === 'object' && results[0] && results[0].siid != null;
    if (hasIds) {
      const byKey = {};
      for (const r of results) { if (r && r.siid != null && r.piid != null) byKey[`${r.siid}.${r.piid}`] = r; }
      for (const name of propKeys) {
        const def = this.propertiesDefs[name];
        const r = byKey[`${def.siid}.${def.piid}`];
        if (r) this.pushProperty(obj, name, r);
      }
    } else {
      for (let i = 0; i < results.length && i < propKeys.length; i++) {
        this.pushProperty(obj, propKeys[i], results[i]);
      }
    }
    return obj;
  }

  async requestAllProperties() {
    if (this.cloudConnected && this.miCloud) return this.requestAllPropertiesCloud();
    if (this.isFanConnected()) {
      const propKeys = Object.keys(this.propertiesDefs);
      const props = propKeys.map(k => this.propertiesDefs[k]);
      const batches = this._chunk(props, MAX_PROPS_PER_CALL);
      const results = await Promise.all(batches.map(b =>
        withTimeout(this.miioFanDevice.call('get_properties', b), CALL_TIMEOUT_MS, 'get_properties')
      ));
      const flat = [].concat(...results.map(r => Array.isArray(r) ? r : []));
      return this._mergePropResults(propKeys, flat);
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
    const batches = this._chunk(params, MAX_PROPS_PER_CALL);
    let results;
    try {
      results = await Promise.all(batches.map(b =>
        withTimeout(this.miCloud.miotGetProps(b, this.cloudCountry), CALL_TIMEOUT_MS, 'cloud get')
      ));
    } catch (err) {
      // 401/403 등 인증 실패 = 세션 만료. 지역/deviceId 문제로 오인하지 않게 명확히 안내.
      if (err && err.authFailed && !this._cloudAuthWarned) {
        this._cloudAuthWarned = true;
        this.logWarn(`MiCloud 세션이 만료되었거나 인증에 실패했습니다 — 설정 화면(또는 tools/micloud-login.js)에서 다시 로그인하세요.`);
      }
      throw err;
    }
    this._cloudAuthWarned = false;
    const flat = [].concat(...results.map(r => Array.isArray(r) ? r : []));
    // 응답이 비었으면 보통 지역(miCloudCountry/계정 지역)·deviceId 불일치 또는 세션 만료다.
    // 예전엔 조용히 0/꺼짐으로만 보여 진단이 어려웠으므로 한 번 명확히 경고한다.
    if (flat.length === 0) {
      if (!this._cloudEmptyWarned) {
        this._cloudEmptyWarned = true;
        this.logWarn(`(cloud) 응답에 기기 데이터가 없습니다. did=${this.cloudDid}, 지역=${this.cloudCountry || '계정기본'} — 지역(miCloudCountry)·deviceId 가 맞는지, 또는 세션이 만료되지 않았는지(설정에서 재로그인) 확인하세요.`);
      }
    } else {
      this._cloudEmptyWarned = false;
    }
    return this._mergePropResults(propKeys, flat);
  }

  async setPropertyCloud(prop, value) {
    const d = this.propertiesDefs[prop];
    if (!d) return;
    try {
      await withTimeout(this.miCloud.miotSetProps([{ did: String(this.cloudDid), siid: d.siid, piid: d.piid, value }], this.cloudCountry), CALL_TIMEOUT_MS, `cloud set ${prop}`);
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
      await withTimeout(this.miCloud.miotSetProps([{ did: String(this.cloudDid), siid: d.siid, piid: d.piid, value }], this.cloudCountry), CALL_TIMEOUT_MS, `cloud cmd ${cmd}`);
    } catch (err) {
      this.logWarn(`(cloud) command ${cmd}=${value} 실패: ${err && err.message || err}`);
    }
  }
}

module.exports = MiotFan;

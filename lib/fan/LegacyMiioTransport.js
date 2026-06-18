'use strict';

/**
 * LegacyMiioTransport (base)
 *
 * 레거시 miio(property) 프로토콜 선풍기(zhimi.fan.v2/v3/sa1/za1/za3/za4, dmaker.fan.p5)가
 * 쓰는 aholstenson `miio` Device API 표면만 흉내내는 얇은 어댑터의 공통 베이스다.
 *
 * MiioFan / 서브클래스(MiioSmartmiFan, MiioDmakerFanP5)가 실제로 호출하는 표면:
 *   - device.defineProperty(name)          (addFanProperties)
 *   - device._loadProperties()             (doInitialPropertiesFetch)
 *   - device.poll()                        (pollProperties)
 *   - device.miioProperties()              (getFanProperties)
 *   - device.setProperty(name, value)      (updateProperty, 낙관적 갱신)
 *   - device.call(method, [args], {refresh, refreshDelay})  (sendCommand)
 *   - device.management.info()             (BaseFan.setupFan)
 *   - device.id ('miio:<did>') / device.miioModel
 *   - device.destroy()
 *
 * 속성 읽기/refresh 로직은 로컬(dgram)·클라우드(miioCall)가 동일하므로 여기에 모으고,
 * 실제 전송(get_prop/set_xxx 호출)만 서브클래스의 _rawCall() 로 위임한다.
 *
 * 레거시 프로토콜은 get_prop ['power','speed',...] → ['on', 45, ...] 처럼 정의 순서대로
 * 값을 위치 매칭으로 돌려준다. 디바이스 코드(MiioSmartmiFan 등)가 raw 값을 그대로
 * 읽으므로(power==='on', buzzer 숫자 등) 별도 변환 없이 그대로 캐시한다.
 */

class LegacyMiioTransport {
  constructor(model, deviceId, log) {
    this.miioModel = model;
    this._did = (deviceId !== undefined && deviceId !== null && `${deviceId}`.length > 0) ? String(deviceId) : undefined;
    this.id = this._did ? `miio:${this._did}` : undefined;
    this.log = log || console;
    this._destroyed = false;

    this._props = {};       // name -> value (캐시)
    this._propNames = [];    // defineProperty 순서 (get_prop 위치 매칭용)

    // aholstenson miio 호환: device.management.info()
    this.management = { info: () => this.info() };
  }

  /*----------========== aholstenson miio 표면 ==========----------*/

  defineProperty(name) {
    if (!name) return;
    if (!this._propNames.includes(name)) {
      this._propNames.push(name);
      if (!(name in this._props)) this._props[name] = undefined;
    }
  }

  miioProperties() { return this._props; }

  setProperty(name, value) { this._props[name] = value; }

  async _loadProperties() { return this.poll(); }

  // 정의된 모든 속성을 get_prop 한 번으로 읽어 캐시를 갱신한다(위치 매칭).
  async poll() {
    if (this._propNames.length === 0) return this._props;
    const names = this._propNames.slice();
    const values = await this._rawCall('get_prop', names);
    this._applyValues(names, values);
    return this._props;
  }

  // 명령 전송. aholstenson 과 동일하게 refresh 옵션이 있으면 잠시 뒤 해당 속성을 다시 읽는다.
  async call(method, params = [], options = {}) {
    const result = await this._rawCall(method, params);
    if (options && options.refresh && !this._destroyed) {
      const delay = options.refreshDelay > 0 ? options.refreshDelay : 200;
      const names = Array.isArray(options.refresh) ? options.refresh : this._propNames.slice();
      setTimeout(() => { this._refresh(names).catch(() => {}); }, delay);
    }
    return result;
  }

  async _refresh(names) {
    if (this._destroyed) return;
    const list = (names || []).filter(n => this._propNames.includes(n));
    if (list.length === 0) return;
    const values = await this._rawCall('get_prop', list);
    this._applyValues(list, values);
  }

  _applyValues(names, values) {
    if (!Array.isArray(values)) return;
    for (let i = 0; i < names.length && i < values.length; i++) {
      this._props[names[i]] = values[i];
    }
  }

  /*----------========== 서브클래스 구현 지점 ==========----------*/

  // 핸드셰이크/세션 준비. 기본은 no-op. (LocalMiioTransport 가 dgram 핸드셰이크를 한다)
  async connect() { return this; }

  // 디바이스 info. 기본은 빈 객체. (LocalMiioTransport 가 miIO.info 를 읽는다)
  async info() { return {}; }

  // 실제 전송. 반드시 서브클래스에서 구현. Promise<result> 를 반환한다.
  // method: 'get_prop' | 'set_power' | ... , params: 배열
  async _rawCall(method, params) {
    throw new Error('LegacyMiioTransport._rawCall must be implemented by subclass');
  }

  destroy() { this._destroyed = true; }
}

module.exports = LegacyMiioTransport;

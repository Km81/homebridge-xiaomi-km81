/**
 * QingpingMonitor — cgllc.airm.cgs2 (Qingping Air Monitor 2) miot wrapper.
 */

'use strict';

const MiioProtocol = require('../common/MiioProtocol.js');

// cgllc.airm.cgs2 miot-spec
const PROPERTIES = [
  { key: 'humidity',      siid: 3, piid: 1 },
  { key: 'pm25',          siid: 3, piid: 4 },
  { key: 'pm10',          siid: 3, piid: 5 },
  { key: 'temperature',   siid: 3, piid: 7 },
  { key: 'co2',           siid: 3, piid: 8 },
  { key: 'tvocIndex',     siid: 3, piid: 9 },
  { key: 'batteryLevel',  siid: 4, piid: 1 },
  { key: 'chargingState', siid: 4, piid: 2 },
];

class QingpingMonitor {
  constructor(ip, token, deviceId, log) {
    this.ip = ip;
    this.token = token;
    this.deviceId = deviceId;
    this.log = log;

    const protocolLogger = {
      debug: (msg) => log.debug(msg),
      deepDebug: (_msg) => { /* silenced */ },
      info: (msg) => log.info(msg),
      warn: (msg) => log.warn(msg),
      error: (msg) => log.error(msg),
    };

    this.protocol = new MiioProtocol(protocolLogger);

    const deviceData = { token };
    if (deviceId) deviceData.did = parseInt(deviceId);
    this.protocol.setDevice(ip, deviceData);

    this.connected = false;
  }

  async readAllProperties() {
    const params = PROPERTIES.map(p => ({ siid: p.siid, piid: p.piid }));
    const results = await this.protocol.send(this.ip, 'get_properties', params, { timeout: 5000, retries: 2 });
    if (!Array.isArray(results)) throw new Error('잘못된 get_properties 응답 형식');

    // 응답에 siid/piid 가 있으면 그것으로 매칭(순서/누락에 안전), 없으면 위치 기반 폴백.
    const byKey = {};
    const hasIds = results.length && results[0] && results[0].siid != null;
    if (hasIds) for (const r of results) { if (r && r.siid != null && r.piid != null) byKey[`${r.siid}.${r.piid}`] = r; }

    const values = {};
    for (let i = 0; i < PROPERTIES.length; i++) {
      const prop = PROPERTIES[i];
      const r = hasIds ? byKey[`${prop.siid}.${prop.piid}`] : results[i];
      if (r && r.code === 0 && r.value !== undefined && r.value !== null) {
        const num = Number(r.value);
        if (Number.isFinite(num)) values[prop.key] = num;
        else this.log.debug(`[QingpingMonitor] ${prop.key} 값을 숫자로 변환 실패: ${JSON.stringify(r.value)}`);
      } else if (r && r.code !== 0) {
        this.log.debug(`[QingpingMonitor] ${prop.key} 읽기 실패 (code=${r.code})`);
      }
    }

    // VOC index → μg/m³ 변환 (Sensirion VOC Index 가이드 / WELL Building Standard)
    if (values.tvocIndex !== undefined) {
      const idx = Math.max(0, Math.min(500, values.tvocIndex));
      let tvoc = (Math.log(501 - idx) - 6.24) * (-996.94);
      if (!isFinite(tvoc) || tvoc < 0) tvoc = 0;
      if (tvoc > 5000) tvoc = 5000;
      values.tvoc = tvoc;
    }

    this.connected = true;
    return values;
  }

  async getDeviceInfo() {
    try { return await this.protocol.getInfo(this.ip); }
    catch (err) {
      this.log.debug(`[QingpingMonitor] getInfo 실패: ${err.message}`);
      return null;
    }
  }

  destroy() {
    if (this.protocol) {
      this.protocol.destroy();
      this.protocol = null;
    }
  }
}

module.exports = QingpingMonitor;

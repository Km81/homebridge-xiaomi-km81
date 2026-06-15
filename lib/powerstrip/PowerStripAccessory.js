/**
 * PowerStripAccessory
 *
 * Xiaomi Mi Power Strip / Mi Smart Plug. 단일 Switch 서비스로 노출한다.
 *
 * 기존 powerstrip 플러그인의 핵심 결함과 통합 시 적용한 개선점:
 *
 *  - poll() 호출 시 device가 null이면 조용히 return 하던 코드를 제거. → 폴링이 영원히
 *    실패해도 재연결이 트리거되지 않아 "잘 되다가 안 되다가" 하던 원인.
 *
 *  - setInterval → setTimeout 루프로 변경. setInterval은 try/catch 실패 후에도 동일
 *    주기로 계속 fire되며, 백오프나 재연결 흐름과 충돌해 미들웨어가 race 상태를 만듦.
 *
 *  - 연속 폴링 실패 카운터(`consecutiveFailures`) 추가. 임계치 도달 시 device를
 *    파괴하고 처음부터 재핸드셰이크.
 *
 *  - 첫 연결 실패도 지수 백오프로 재시도 (기존: 고정 30초). 네트워크 깜빡임 회복 가속.
 *
 *  - shutdown 핸들러에서 burst 타이머/poll 타이머/reconnect 타이머 모두 정리.
 *
 *  - 보호 구간(`command grace`)은 기존 로직 유지하되 burst 폴링 실패 시 silent.
 *
 *  - prefix/디버그 로그 일관성.
 */

'use strict';

const miio = require('miio');
const { withTimeout, requireValidIpAndToken } = require('../common/helpers.js');

// MIoT 기본 매핑 (가능하면 사용)
const PROP_SWITCH  = { siid: 2, piid: 1 }; // switch:on
const PROP_POWER_W = { siid: 3, piid: 1 }; // power-consumption:surge-power

// 튜닝 파라미터
const COMMAND_GRACE_MS = 4000;   // set 직후 보호 구간 (전 장비 4초 통일)
const CALL_TIMEOUT_MS = 8000;
const CONNECT_TIMEOUT_MS = 8000;
const VERIFY_BURST_DELAYS = [300, 800, 1500];
const MIN_POLLING_MS = 3000;
const DEFAULT_POLLING_MS = 15000;

// 재연결/재시도 정책
const CONNECT_RETRY_BASE_MS = 1500;
const CONNECT_RETRY_MAX_DELAY_MS = 60_000;
const POLL_FAIL_THRESHOLD = 3;     // 연속 실패 시 device 파괴 후 재연결

class PowerStripAccessory {
  constructor(ctx, config) {
    this.ctx = ctx;
    this.api = ctx.api;
    this.log = ctx.log;
    this.hap = ctx.hap;
    this.Service = this.hap.Service;
    this.Characteristic = this.hap.Characteristic;
    this.PLUGIN_NAME = ctx.PLUGIN_NAME;
    this.PLATFORM_NAME = ctx.PLATFORM_NAME;

    this.cfg = {
      name: (config.name || 'Xiaomi Power Strip').toString(),
      ip: (config.ip || '').toString(),
      token: (config.token || '').toString(),
      model: config.model,
      serialNumber: config.serialNumber || config.deviceId,
      protocolMode: (config.protocolMode || 'auto').toLowerCase(),
      debug: !!config.debug,
      pollingInterval: Math.max(MIN_POLLING_MS, Number(config.pollingInterval) || DEFAULT_POLLING_MS),
    };
    requireValidIpAndToken(this.cfg, `PowerStrip '${this.cfg.name}'`);

    // 모드/상태
    this.mode = this.cfg.protocolMode; // 'auto' | 'miot' | 'legacy'
    this.device = null;
    this.state = { on: false, powerW: undefined };
    this.pending = null;  // command grace
    this.burstTimers = [];
    this.pollTimer = null;
    this.reconnectTimer = null;
    this.connectingAttempt = 0;
    this.consecutiveFailures = 0;
    this.connecting = false;

    // UUID & 액세서리
    this.UUID = this.hap.uuid.generate(`xiaomi-km81:powerstrip:${this.cfg.ip}`);
    let accessory = this.ctx.accessories.get(this.UUID);
    if (!accessory) {
      accessory = new this.api.platformAccessory(this.cfg.name, this.UUID);
      accessory.context.device = this.cfg;
      this.api.registerPlatformAccessories(this.PLUGIN_NAME, this.PLATFORM_NAME, [accessory]);
      this.ctx.accessories.set(this.UUID, accessory);
      this.logInfo('새 액세서리 등록');
    } else {
      this.logInfo('캐시 액세서리 복원');
      accessory.context.device = this.cfg;
    }
    this.accessory = accessory;

    this.setupInformation();
    this.setupSwitchService();

    // 연결 시작 (실패해도 throw 없이 백오프로 재시도)
    this.connect();
  }

  getAccessoryUUIDs() { return [this.UUID]; }

  shutdown() {
    this._shutdown = true;
    if (this.pollTimer) { clearTimeout(this.pollTimer); this.pollTimer = null; }
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    this.clearBurst();
    if (this.device && this.device.destroy) {
      try { this.device.destroy(); } catch (_) {}
    }
    this.device = null;
  }

  /*============================================================
   *                  SETUP
   *============================================================*/

  setupInformation() {
    const { Service, Characteristic } = this;
    let info = this.accessory.getService(Service.AccessoryInformation);
    if (!info) info = this.accessory.addService(Service.AccessoryInformation);
    info.setCharacteristic(Characteristic.Manufacturer, 'Xiaomi')
      .setCharacteristic(Characteristic.Model, this.cfg.model || 'PowerStrip')
      .setCharacteristic(Characteristic.SerialNumber, this.cfg.serialNumber || this.cfg.ip)
      .setCharacteristic(Characteristic.FirmwareRevision, this.ctx.packageVersion);
  }

  setupSwitchService() {
    const { Service, Characteristic } = this;
    this.switchService = this.accessory.getService(Service.Switch)
      || this.accessory.addService(Service.Switch, this.cfg.name);

    this.switchService.getCharacteristic(Characteristic.On).onSet(async (value) => {
      const boolVal = !!value;
      try {
        // 1) 낙관적 UI 업데이트
        this.state.on = boolVal;
        this.switchService.updateCharacteristic(Characteristic.On, boolVal);

        // 2) 보호 구간 시작
        this.pending = { target: boolVal, expire: Date.now() + COMMAND_GRACE_MS };
        this.clearBurst();
        this.scheduleVerifyBurst();

        // 3) 실제 제어
        //    아직 프로토콜이 확정되지 않은(auto) 상태에서 MIoT 제어가 실패하면
        //    legacy 로 1회 폴백한다. 폴링이 먼저 모드를 확정하는 게 보통이지만,
        //    기동 직후 첫 동작이 제어인 경우(씬/자동화)에도 안전하도록 한다.
        if (this.mode === 'legacy') {
          await this.legacySetPower(boolVal);
        } else {
          try {
            await this.miotSet(PROP_SWITCH, boolVal);
          } catch (e) {
            if (this.mode === 'auto') {
              this.dlog('MIoT 제어 실패 → Legacy 폴백 시도:', e.message || e);
              await this.legacySetPower(boolVal);
              this.mode = 'legacy';
              this.logWarn('MIoT 제어 미지원 → Legacy 모드로 전환');
            } else {
              throw e;
            }
          }
        }
      } catch (e) {
        this.logError(`전원 설정 실패: ${e.message || e}`);
        this.pending = null;
        this.clearBurst();
        // 실제 상태 재동기화
        setTimeout(() => this.safePoll(), 300);
        throw e;
      }
    });
  }

  /*============================================================
   *                  CONNECT (with exponential backoff)
   *============================================================*/

  async connect() {
    if (this._shutdown || this.connecting || this.device) return;
    this.connecting = true;
    this.connectingAttempt++;

    try {
      this.logInfo(`연결 시도 ${this.connectingAttempt}... (${this.cfg.ip})`);
      this.device = await withTimeout(miio.device({
        address: this.cfg.ip,
        token: this.cfg.token,
        model: this.cfg.model,
      }), CONNECT_TIMEOUT_MS, 'connect');
      if (typeof this.device.init === 'function') {
        try { await withTimeout(this.device.init(), CONNECT_TIMEOUT_MS, 'init'); } catch (_) {}
      }
      this.logInfo('연결 성공');
      this.connectingAttempt = 0;
      this.consecutiveFailures = 0;

      // 즉시 1회 폴링 후 정규 폴링 시작
      await this.safePoll();
      this.startPollLoop();
    } catch (e) {
      const delay = Math.min(CONNECT_RETRY_BASE_MS * Math.pow(2, this.connectingAttempt - 1), CONNECT_RETRY_MAX_DELAY_MS);
      this.logError(`연결 실패 (${Math.round(delay / 1000)}초 후 재시도): ${e.message || e}`);
      this.scheduleReconnect(delay);
    } finally {
      this.connecting = false;
    }
  }

  scheduleReconnect(delayMs = 5000) {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => { this.reconnectTimer = null; if (this._shutdown) return; this.connect(); }, delayMs);
  }

  // device를 파괴하고 처음부터 재연결한다
  forceReconnect(reason) {
    this.logWarn(`강제 재연결: ${reason}`);
    if (this.pollTimer) { clearTimeout(this.pollTimer); this.pollTimer = null; }
    if (this.device && this.device.destroy) {
      try { this.device.destroy(); } catch (_) {}
    }
    this.device = null;
    this.consecutiveFailures = 0;
    this.connectingAttempt = 0;
    this.connecting = false;
    this.scheduleReconnect(1000);
  }

  /*============================================================
   *                  POLLING LOOP (setTimeout-based)
   *============================================================*/

  startPollLoop() {
    if (this._shutdown) return;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    const tick = async () => {
      try {
        await this.poll();
      } catch (e) {
        // poll 내부에서 모두 처리되지만 안전망
        this.logDebug(`폴링 예외: ${e.message || e}`);
      } finally {
        if (!this._shutdown) {
          this.pollTimer = setTimeout(tick, this.cfg.pollingInterval);
        }
      }
    };
    this.pollTimer = setTimeout(tick, this.cfg.pollingInterval);
  }

  async safePoll() {
    try { await this.poll(); } catch (e) { this.logDebug(`안전 폴링 예외: ${e.message || e}`); }
  }

  async poll(isBurst = false) {
    // 핵심 fix: device가 null이면 폴링이 트리거한 재연결로 자가 회복
    if (!this.device) {
      this.logDebug('device 없음 → 재연결 트리거');
      if (!this.connecting && !this.reconnectTimer) this.scheduleReconnect(500);
      return;
    }

    let success = false;
    try {
      if (this.mode === 'legacy') {
        await this.legacyPoll(isBurst);
      } else if (this.mode === 'miot') {
        await this.miotPoll(isBurst);
      } else {
        // auto: MIoT 를 먼저 시도하고 성공하면 miot 모드로 확정.
        // 실패하면 에러 종류와 무관하게 legacy 를 1회 시도한다.
        // 구형 기기(예: zimi.powerstrip.v2 / qmi.powerstrip.v1)는 get_properties 에
        // -32601 같은 에러 대신 무응답(timeout)으로 답하는 경우가 많아, 기존의 메시지
        // 정규식 매칭만으로는 폴백이 안 돼 auto 모드에서 영영 안 켜질 수 있었다.
        // legacy 가 실제로 성공할 때만 legacy 로 확정하므로, 기기 오프라인 등으로 둘 다
        // 실패하면 legacy 로 잘못 고정되지 않고 일반 실패(재연결)로 처리된다.
        try {
          await this.miotPoll(isBurst);
          if (this.mode === 'auto') this.mode = 'miot';
        } catch (e) {
          const msg = `${e && e.message ? e.message : e}`;
          this.dlog('MIoT 폴링 오류 → Legacy 폴백 시도:', msg);
          await this.legacyPoll(isBurst);   // 실패 시 throw → 바깥 catch 가 실패 카운트 처리
          this.mode = 'legacy';
          this.logWarn('MIoT 응답 없음/미지원 → Legacy 모드로 전환');
        }
      }
      success = true;
    } catch (e) {
      this.consecutiveFailures++;
      this.logError(`폴링 실패 (${this.consecutiveFailures}/${POLL_FAIL_THRESHOLD}): ${e.message || e}`);
      if (this.consecutiveFailures >= POLL_FAIL_THRESHOLD) {
        this.forceReconnect(`연속 ${this.consecutiveFailures}회 폴링 실패`);
      }
    }
    if (success) this.consecutiveFailures = 0;
  }

  /*============================================================
   *                  MIoT
   *============================================================*/

  async miotPoll(isBurst) {
    const req = [
      { siid: PROP_SWITCH.siid,  piid: PROP_SWITCH.piid },
      { siid: PROP_POWER_W.siid, piid: PROP_POWER_W.piid }
    ];
    this.dlog('MIoT get_properties:', this.safeJSON(req));
    const res = await withTimeout(this.device.call('get_properties', req), CALL_TIMEOUT_MS, 'get_properties');
    this.dlog('MIoT 응답:', this.safeJSON(res));

    const map = {};
    if (Array.isArray(res) && res.length && typeof res[0] === 'object') {
      res.forEach(r => { map[`${r.siid}.${r.piid}`] = r.value; });
    } else {
      res.forEach((v, i) => { map[`${req[i].siid}.${req[i].piid}`] = v; });
    }

    let onVal = map[`${PROP_SWITCH.siid}.${PROP_SWITCH.piid}`];
    const powerW = map[`${PROP_POWER_W.siid}.${PROP_POWER_W.piid}`];
    let on = (typeof onVal !== 'undefined') ? !!onVal : this.state.on;

    on = this.applyCommandGrace(on);
    this.state.on = on;
    if (typeof powerW === 'number') this.state.powerW = powerW;
    try { this.switchService.updateCharacteristic(this.Characteristic.On, on); } catch (_) {}
  }

  async miotSet(prop, value) {
    if (!this.device) throw new Error('Device not connected');
    const payload = [{ siid: prop.siid, piid: prop.piid, value }];
    this.dlog('MIoT set_properties:', this.safeJSON(payload));
    const res = await withTimeout(this.device.call('set_properties', payload), CALL_TIMEOUT_MS, 'set_properties');
    this.dlog('MIoT set 응답:', this.safeJSON(res));
    if (Array.isArray(res)) {
      const ok = res.every(r => (typeof r === 'string' && r === 'ok') || (typeof r === 'object' && r.code === 0));
      if (!ok) throw new Error(`기기 응답 오류: ${this.safeJSON(res)}`);
    } else if (res !== 'ok') {
      throw new Error(`기기 응답 오류: ${String(res)}`);
    }
  }

  /*============================================================
   *                  Legacy
   *============================================================*/

  get legacyKeyCombos() {
    return [
      { method: 'get_prop', keys: ['power', 'power_consume_rate'] },
      { method: 'get_prop', keys: ['relay_status', 'power_consume_rate'] },
      { method: 'get_prop', keys: ['switch', 'power_consume_rate'] },
      { method: 'get_prop', keys: ['state', 'power_consume_rate'] },
      { method: 'get_prop', keys: ['enable', 'power_consume_rate'] },
      { method: 'get_prop', keys: ['plug_status', 'power_consume_rate'] },
      { method: 'get_prop', keys: ['plug_state', 'power_consume_rate'] },
      { method: 'get_prop', keys: ['switch_status', 'power_consume_rate'] },
      { method: 'get_prop', keys: ['on', 'power_consume_rate'] },
      { method: 'get_status', keys: [] },
      { method: 'get_power', keys: [] }
    ];
  }

  normalizeBool(v) {
    if (typeof v === 'boolean') return v;
    if (typeof v === 'number') return v !== 0;
    if (typeof v === 'string') {
      const s = v.trim().toLowerCase();
      if (s === 'on' || s === 'true' || s === '1') return true;
      if (s === 'off' || s === 'false' || s === '0') return false;
    }
    return undefined;
  }

  async legacyPoll(isBurst) {
    let on, powerW = this.state.powerW, lastErr = null;

    // 가장 흔한 조합 먼저
    try {
      this.dlog('Legacy 우선: get_prop ["power","power_consume_rate"]');
      const resp = await withTimeout(this.device.call('get_prop', ['power', 'power_consume_rate']), CALL_TIMEOUT_MS, 'get_prop');
      this.dlog('Legacy 응답(우선):', this.safeJSON(resp));
      if (Array.isArray(resp)) {
        const b = this.normalizeBool(resp[0]);
        if (typeof b !== 'undefined') on = b;
        const n = Number(resp[1]);
        if (Number.isFinite(n)) powerW = n;
      }
    } catch (e) { lastErr = e; }

    if (typeof on === 'undefined') {
      for (const combo of this.legacyKeyCombos) {
        if (combo.method === 'get_prop' && combo.keys.length === 2 && combo.keys[0] === 'power') continue;
        try {
          this.dlog('Legacy 요청:', combo.method, combo.keys);
          const resp = await withTimeout(this.device.call(combo.method, combo.keys), CALL_TIMEOUT_MS, combo.method);
          this.dlog('Legacy 응답:', this.safeJSON(resp));

          if (Array.isArray(resp)) {
            let useful = false;
            combo.keys.forEach((k, idx) => {
              const val = resp[idx];
              if (['power', 'on', 'relay_status', 'switch', 'state', 'enable', 'plug_status', 'plug_state', 'switch_status'].includes(k)) {
                const b = this.normalizeBool(val);
                if (typeof b !== 'undefined') { on = b; useful = true; }
              }
              if (k === 'power_consume_rate' && val != null) {
                const n = Number(val);
                if (Number.isFinite(n)) { powerW = n; useful = true; }
              }
            });
            if (useful && typeof on !== 'undefined') break;
            continue;
          }

          if (typeof resp === 'object' && resp !== null) {
            const cand = resp.power || resp.on || resp.relay_status || resp.switch || resp.state ||
                         resp.enable || resp.plug_status || resp.plug_state || resp.switch_status;
            const b = this.normalizeBool(cand);
            if (typeof b !== 'undefined') on = b;
            const pw = resp.power_consume_rate || resp.load_power || resp.all_power;
            if (typeof pw !== 'undefined') {
              const n = Number(pw);
              if (Number.isFinite(n)) powerW = n;
            }
            if (typeof on !== 'undefined') break;
            continue;
          }

          const b = this.normalizeBool(resp);
          if (typeof b !== 'undefined') { on = b; break; }
        } catch (e) { lastErr = e; }
      }
    }

    if (typeof on === 'undefined') {
      if (lastErr) throw lastErr;
      on = this.state.on;
    }

    on = this.applyCommandGrace(on);
    this.state.on = !!on;
    this.state.powerW = powerW;
    try { this.switchService.updateCharacteristic(this.Characteristic.On, !!on); } catch (_) {}
  }

  async legacySetPower(value) {
    const arg = value ? 'on' : 'off';
    try {
      this.dlog('Legacy set_power:', arg);
      const res = await withTimeout(this.device.call('set_power', [arg]), CALL_TIMEOUT_MS, 'set_power');
      this.dlog('Legacy set_power 응답:', this.safeJSON(res));
      if (res === 'ok' || (Array.isArray(res) && res[0] === 'ok')) return;
    } catch (e) { this.dlog('set_power 오류:', e.message || e); }

    try {
      this.dlog('Legacy set_on:', value);
      const res2 = await withTimeout(this.device.call('set_on', [!!value]), CALL_TIMEOUT_MS, 'set_on');
      this.dlog('Legacy set_on 응답:', this.safeJSON(res2));
      if (res2 === 'ok' || (Array.isArray(res2) && res2[0] === 'ok')) return;
    } catch (e) { this.dlog('set_on 오류:', e.message || e); }

    if (value) {
      try {
        this.dlog('Legacy toggle_plug');
        const res3 = await withTimeout(this.device.call('toggle_plug', []), CALL_TIMEOUT_MS, 'toggle_plug');
        this.dlog('Legacy toggle_plug 응답:', this.safeJSON(res3));
        if (res3 === 'ok' || (Array.isArray(res3) && res3[0] === 'ok')) return;
      } catch (e) { this.dlog('toggle_plug 오류:', e.message || e); }
    }

    throw new Error('set_power / set_on / toggle_plug 모두 실패');
  }

  /*============================================================
   *                  COMMAND GRACE
   *============================================================*/

  applyCommandGrace(polledOn) {
    if (!this.pending) return polledOn;
    const now = Date.now();
    if (now >= this.pending.expire) {
      this.pending = null;
      this.clearBurst();
      return polledOn;
    }
    if (typeof polledOn === 'boolean' && polledOn === this.pending.target) {
      this.pending = null;
      this.clearBurst();
      return polledOn;
    }
    this.dlog(`보호 구간 적용: 폴링값=${polledOn} → 목표값으로 유지=${this.pending.target}`);
    return this.pending.target;
  }

  scheduleVerifyBurst() {
    VERIFY_BURST_DELAYS.forEach(d => {
      const t = setTimeout(() => this.safePoll(), d);
      this.burstTimers.push(t);
    });
  }

  clearBurst() {
    this.burstTimers.forEach(t => clearTimeout(t));
    this.burstTimers = [];
  }

  /*============================================================
   *                  LOG / UTILS
   *============================================================*/

  safeJSON(o) { try { return JSON.stringify(o); } catch (_) { return String(o); } }

  logInfo(m, ...a)  { this.log.info(`[${this.cfg.name}] ${m}`, ...a); }
  logWarn(m, ...a)  { this.log.warn(`[${this.cfg.name}] ${m}`, ...a); }
  logDebug(m, ...a) { this.log.debug(`[${this.cfg.name}] ${m}`, ...a); }
  logError(m, ...a) { this.log.error(`[${this.cfg.name}] ${m}`, ...a); }
  dlog(...a)        { if (this.cfg.debug) this.log.info(`[${this.cfg.name}] [DEBUG]`, ...a); }
}

module.exports = PowerStripAccessory;

'use strict';

const miio = require('miio');
const EventEmitter = require('events');
const FanDeviceFactory = require('./FanDeviceFactory.js');
const LocalMiotTransport = require('./LocalMiotTransport.js');
const LocalMiioTransport = require('./LocalMiioTransport.js');
const Events = require('./Events.js');

// miio 호출이 reject 없이 무한 대기(hang)하면 재연결이 영영 트리거되지 않아
// "시간이 지나면 응답 없음, 재부팅해야 복구" 증상이 생긴다. 호출에 타임아웃을 걸어
// hang 을 reject 로 전환하고, setTimeout 루프로 폴링 중첩을 막는다.
const CONNECT_TIMEOUT_MS = 10000;   // miio.device() 핸드셰이크 최대 대기 (느린 기기 여유)
const POLL_TIMEOUT_MS = 8000;       // 단일 폴링 최대 대기
const RECONNECT_BASE_MS = 2000;     // 재연결 실패 시 첫 재시도 지연 (지수 백오프 시작)
const RECONNECT_MAX_MS = 30000;     // 재연결 재시도 지연 상한
// 로컬 세션이 꼬여 재연결이 반복 실패하면(예: xiaomi.fan.p45), 짧은 재시도를 계속해도
// 기기가 점유된 로컬 세션을 못 푼다. 일정 횟수 이상 연속 실패하면 더 긴 "정지 구간"을
// 두어 기기가 세션을 스스로 정리(프로세스 재시작의 조용한 구간을 흉내)하도록 한다.
const STUCK_AFTER_ATTEMPTS = 6;     // 이 횟수 이상 연속 실패 시 stuck 으로 간주
const STUCK_COOLDOWN_MS = 90000;    // stuck 상태에서의 재시도 간격 (긴 정지 구간)
// 하이브리드(cloudFallback): 로컬이 연속 실패하면 그 기기만 클라우드로 자동 전환하고,
// 백그라운드로 로컬을 주기적으로 재탐색해 복구되면 다시 로컬로 돌아온다.
const CLOUD_FALLBACK_AFTER_ATTEMPTS = 3;  // 로컬 연속 실패 N회 → 클라우드 폴백 (~15~30초)
const CLOUD_LOCAL_PROBE_MS = 300000;      // 클라우드 동작 중 로컬 재탐색 주기 (5분)
const CLOUD_MIN_DWELL_MS = 120000;        // 클라우드 최소 체류 (2분) — 잦은 왕복(flapping) 방지

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
    this._shutdown = false;
    this._reconnectAttempt = 0;

    // 외부(FanAccessory)에서 주입되는 클라우드 옵션:
    //   this.miCloud, this.forceMiCloud, this.cloudFallback, this.miCloudCountry
    this._mode = 'local';             // 'local' | 'cloud' (현재 활성 전송)
    this._cloudSince = 0;             // 클라우드로 전환한 시각 (최소 체류 판정용)
    this._localProbeTimer = undefined;
    this._pollGen = 0;                // 폴링 루프 세대 — 전환 시 옛 루프가 재무장 못 하게 막음
  }

  // 클라우드 폴백/전용을 쓸 수 있는 조건: 세션과 model 이 있어야 한다.
  //  - miot 신형 선풍기: MiotFan 이 miotGetProps/miotSetProps 로 클라우드 제어
  //  - 레거시 miio 선풍기(zhimi.fan.v3/za4, dmaker.fan.p5): MiioFan 이 CloudMiioTransport
  //    (miioCall 패스스루)로 클라우드 제어 — 둘 다 지원한다.
  // model 이 없으면(자동탐지 모드) 클라우드용 디바이스 클래스를 고를 수 없으므로 제외한다.
  _canUseCloud() { return !!(this.miCloud && this.model && this.model.length > 0); }

  // 하이브리드 전환 가능 조건: 위 + 클라우드가 실제 로그인된 상태여야 한다.
  // 로그인 전이면 클라우드로 넘어가도 빈 데이터만 보이므로, 로컬 재시도를 유지하는 편이 낫다.
  _cloudReady() {
    return this._canUseCloud() && typeof this.miCloud.isLoggedIn === 'function' && this.miCloud.isLoggedIn();
  }

  connectToFan() {
    // forceMiCloud: 로컬을 아예 쓰지 않고 클라우드로만 제어한다 (클라우드 전용 모드).
    if (this.forceMiCloud && this._canUseCloud()) {
      this.logInfo(`MiCloud(클라우드) 전용 모드로 동작합니다: ${this.model}${this.miCloudCountry ? ` (지역: ${this.miCloudCountry})` : ''}`);
      this.startCloudMode();
      return;
    }
    if (this.forceMiCloud && this.miCloud) {
      this.logError(`MiCloud 전용 모드 조건이 안 맞습니다(model/miot 확인). 로컬로 폴백합니다.`);
    }
    // 로컬 우선. cloudFallback 이면 로컬이 연속 실패할 때 클라우드로 자동 전환한다.
    if (this.cloudFallback && this._canUseCloud()) {
      this.logInfo(`하이브리드 모드: 로컬 우선, 실패 시 클라우드 자동 전환 (${this.model}${this.miCloudCountry ? `, 지역 ${this.miCloudCountry}` : ''})`);
    }
    if (this.model && this.model.length > 0) {
      this.logDebug(`Cached fan model ${this.model} found! Creating fan device!`);
      this.createFanDevice(null, this.model);
      this.startFanDiscovery();
    } else {
      this.logDebug(`Fan model unknown! Starting discovery!`);
      this.startFanDiscovery();
    }
  }

  // 클라우드 전용 모드 (forceMiCloud): 로컬 핸드셰이크 없이 클라우드로 폴링/제어한다.
  startCloudMode() {
    if (this._shutdown) return;
    this._mode = 'cloud';
    this.createFanDevice(null, this.model);
    if (this.fanDevice && typeof this.fanDevice.setupCloud === 'function') {
      this.fanDevice.setupCloud(this.miCloud, this.deviceId, this.miCloudCountry);
    }
    this.emit(Events.FAN_CONNECTED, this.fanDevice);
    this.startCloudPollLoop();
  }

  // 하이브리드: 로컬이 연속 실패해 클라우드로 전환한다. 동시에 로컬 재탐색 루프를 돌린다.
  tripToCloud() {
    if (this._shutdown) return;
    this.logWarn(`로컬 연결 ${this._reconnectAttempt}회 실패 → 클라우드로 전환합니다.${this.miCloudCountry ? ` (지역: ${this.miCloudCountry})` : ''}`);
    this._mode = 'cloud';
    this._cloudSince = Date.now();
    if (this._retryTimer) { clearTimeout(this._retryTimer); this._retryTimer = undefined; }
    if (this.pollTimer) { clearTimeout(this.pollTimer); this.pollTimer = undefined; }
    this.createFanDevice(null, this.model);   // 이미 있으면 no-op
    if (this.fanDevice && typeof this.fanDevice.setupCloud === 'function') {
      this.fanDevice.setupCloud(this.miCloud, this.deviceId, this.miCloudCountry);
    }
    this.emit(Events.FAN_CONNECTED, this.fanDevice);
    this.startCloudPollLoop();
    this.startLocalProbeLoop();
  }

  startCloudPollLoop() {
    if (this._shutdown) return;
    if (this.pollTimer) { clearTimeout(this.pollTimer); this.pollTimer = undefined; }
    this._stopPolling = false;
    const myGen = ++this._pollGen;
    const tick = () => {
      if (this._stopPolling || this._pollGen !== myGen || !this.fanDevice) return;
      this.withTimeout(this.fanDevice.pollProperties(), POLL_TIMEOUT_MS, 'cloud poll')
        .then(result => { this.emit(Events.FAN_PROPERTIES_UPDATED, result); })
        .catch(err => { this.logDebug(`Cloud poll failed (로그인 전이거나 일시 오류일 수 있음): ${err}`); })
        .then(() => { if (!this._stopPolling && this._pollGen === myGen) this.pollTimer = setTimeout(tick, this.pollingInterval); });
    };
    this.pollTimer = setTimeout(tick, 200);
  }

  // 클라우드 동작 중 주기적으로 로컬을 1회만 조용히 재탐색한다. 성공하면 로컬로 복귀.
  startLocalProbeLoop() {
    if (this._localProbeTimer) { clearTimeout(this._localProbeTimer); this._localProbeTimer = undefined; }
    const probe = () => {
      if (this._shutdown || this._mode !== 'cloud') return;
      this.probeLocal()
        .catch(() => {})
        .then(() => {
          if (!this._shutdown && this._mode === 'cloud') {
            this._localProbeTimer = setTimeout(probe, CLOUD_LOCAL_PROBE_MS);
          }
        });
    };
    this._localProbeTimer = setTimeout(probe, CLOUD_LOCAL_PROBE_MS);
  }

  async probeLocal() {
    if (this._shutdown || this._mode !== 'cloud') return;
    if (Date.now() - this._cloudSince < CLOUD_MIN_DWELL_MS) return;  // 최소 체류 전이면 보류
    let device;
    try {
      device = await this.withTimeout(this._openConnection(), CONNECT_TIMEOUT_MS, 'local probe');
    } catch (e) {
      this.logDebug(`로컬 재탐색 실패 — 클라우드 유지: ${e}`);
      return;
    }
    if (this._shutdown || this._mode !== 'cloud') {
      try { device && device.destroy && device.destroy(); } catch (_) {}
      return;
    }
    this.tripToLocal(device);
  }

  // 하이브리드: 로컬 복구 확인 → 로컬 제어로 복귀한다.
  tripToLocal(device) {
    this.logInfo(`로컬 복구 확인 → 로컬 제어로 복귀합니다. (${(device && device.miioModel) || this.model})`);
    this._mode = 'local';
    this._reconnectAttempt = 0;
    if (this._localProbeTimer) { clearTimeout(this._localProbeTimer); this._localProbeTimer = undefined; }
    if (this.pollTimer) { clearTimeout(this.pollTimer); this.pollTimer = undefined; }
    this._stopPolling = true;             // 진행 중인 클라우드 루프 재무장 차단(+_pollGen)
    if (this.fanDevice && typeof this.fanDevice.teardownCloud === 'function') this.fanDevice.teardownCloud();
    this.createFanDevice(device, null);   // updateMiioDevice → setupFan(로컬)
    this.startFanPolling();
    this.emit(Events.FAN_CONNECTED, this.fanDevice);
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

  // 연결 전송 선택 (모두 dgram 기반 — 매 연결마다 재핸드셰이크 → 세션 꼬임에서 자동 복구):
  //  - 알려진 miot 모델: LocalMiotTransport (get/set_properties). 신형 기기(xiaomi.fan.p45)의
  //    "응답 없음" 근본 해결.
  //  - 알려진 레거시 miio 모델(zhimi.fan.v3/za4, dmaker.fan.p5): LocalMiioTransport
  //    (get_prop/set_xxx). 레거시 선풍기도 동일하게 자동 복구되도록 dgram 으로 직접 제어한다.
  //  - 모델 미상(자동탐지): aholstenson miio 그대로(모델/프로토콜을 자동 판별해야 하므로).
  _openConnection() {
    if (FanDeviceFactory.isMiotModel(this.model)) {
      const transport = new LocalMiotTransport(this.ip, this.token, this.deviceId, this.model, this.log);
      return transport.connect();
    }
    if (FanDeviceFactory.isMiioProtocolModel(this.model)) {
      const transport = new LocalMiioTransport(this.ip, this.token, this.deviceId, this.model, this.log);
      return transport.connect();
    }
    return miio.device({ address: this.ip, token: this.token });
  }

  startFanDiscovery() {
    if (this._shutdown) return;       // 종료 후에는 새 연결을 시작하지 않는다
    if (this._connecting) return;     // 중복 연결 시도 방지
    this._connecting = true;

    this.withTimeout(this._openConnection(), CONNECT_TIMEOUT_MS, 'connect')
      .then(device => {
        this._connecting = false;
        // 연결 대기 중 shutdown 이 발생했다면, 방금 만든 살아있는 연결을 파기하고 빠져나간다
        // (그대로 두면 UDP 소켓이 누수되고 폴링 루프가 부활한다).
        // 주의: 여기서 _stopPolling 을 함께 보면 안 된다. 폴 실패 후 재연결 경로는
        // catch 에서 _stopPolling=true 로 둔 채 startFanDiscovery 를 호출하는데, 그 재연결이
        // 성공해도 _stopPolling 이 true 라 여기서 연결을 버리고 폴링을 재개하지 못해
        // "폴 실패 1번 → 선풍기 영구 정지(재부팅 전까지)" 가 됐다. 종료는 _shutdown 으로 충분하다
        // (startFanPolling 도 진입 시 _stopPolling=false 로 되돌리고 _shutdown 을 다시 확인한다).
        if (this._shutdown) {
          try { device && device.destroy && device.destroy(); } catch (_) {}
          return;
        }
        this._reconnectAttempt = 0;   // 연결 성공 → 백오프 리셋
        if (this._retryTimer) { clearTimeout(this._retryTimer); this._retryTimer = undefined; }
        this.logInfo(`Connected to Fan ${device.miioModel}`);
        this.createFanDevice(device, null);
        this.startFanPolling();
        this.emit(Events.FAN_CONNECTED, this.fanDevice);
      })
      .catch(err => {
        this._connecting = false;
        if (this._shutdown) return;   // 종료 중이면 재연결을 예약하지 않는다
        this._reconnectAttempt++;
        // 매 실패마다 이전 연결을 완전히 파기해 다음 시도가 깨끗한 소켓으로 핸드셰이크하도록 한다.
        if (this.fanDevice) this.fanDevice.disconnectAndDestroyMiioDevice();
        // 하이브리드: 로컬이 연속 실패하면 그 기기를 클라우드로 전환한다(홈킷이 ~30초 안에 회복).
        // 단, 클라우드가 로그인된 경우에만 — 아니면 로컬 재시도를 계속한다(빈 클라우드로 가지 않음).
        if (this.cloudFallback && this._cloudReady() && this._mode === 'local'
            && this._reconnectAttempt >= CLOUD_FALLBACK_AFTER_ATTEMPTS) {
          this.tripToCloud();
          return;
        }
        // 지수 백오프(2→4→8→16→30초). 단, 연속 실패가 임계치를 넘으면(로컬 세션이 꼬인 것으로
        // 보고) 긴 정지 구간으로 전환해 기기가 세션을 스스로 정리할 시간을 준다.
        let delay;
        if (this._reconnectAttempt >= STUCK_AFTER_ATTEMPTS) {
          delay = STUCK_COOLDOWN_MS;
          this.logWarn(`재연결 ${this._reconnectAttempt}회 연속 실패 — 로컬 세션이 꼬인 듯합니다. ${Math.round(delay / 1000)}초 정지 후 재시도합니다. (앱은 되는데 홈브릿지만 안 되면, 기기 전원 리셋이 가장 확실합니다)`);
        } else {
          delay = Math.min(RECONNECT_BASE_MS * Math.pow(2, this._reconnectAttempt - 1), RECONNECT_MAX_MS);
          this.logDebug(`Could not connect to the fan! Retrying in ${Math.round(delay / 1000)} seconds! Error: ${err}`);
        }
        if (err && err.stack) this.logDebug(err.stack);
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
    if (this._shutdown) return;       // 종료 후에는 폴링을 재개하지 않는다(부활 방지)
    if (this.pollTimer) { clearTimeout(this.pollTimer); this.pollTimer = undefined; }
    this._stopPolling = false;
    const myGen = ++this._pollGen;

    const tick = () => {
      if (this._stopPolling || this._pollGen !== myGen || !this.fanDevice) return;
      this.withTimeout(this.fanDevice.pollProperties(), POLL_TIMEOUT_MS, 'poll')
        .then(result => {
          this.emit(Events.FAN_PROPERTIES_UPDATED, result);
          this.logDeepDebug(`Updated properties: \n ${JSON.stringify(this.fanDevice.getFanProperties(), null, 2)}`);
          if (!this._stopPolling && this._pollGen === myGen) this.pollTimer = setTimeout(tick, this.pollingInterval);
        })
        .catch(err => {
          if (this._stopPolling || this._pollGen !== myGen) return;
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
    this._shutdown = true;
    this._stopPolling = true;
    this._pollGen++;   // 진행 중인 폴링 루프 무효화
    if (this.pollTimer) { clearTimeout(this.pollTimer); this.pollTimer = undefined; }
    if (this._retryTimer) { clearTimeout(this._retryTimer); this._retryTimer = undefined; }
    if (this._localProbeTimer) { clearTimeout(this._localProbeTimer); this._localProbeTimer = undefined; }
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

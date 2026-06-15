/**
 * homebridge-xiaomi-km81
 *
 * Unified Homebridge plugin for Xiaomi devices:
 *   - Fan (Smartmi / Mija / Dmaker)
 *   - Air Purifier (2S / Pro)
 *   - Power Strip (Mi Power Strip, miot/legacy autodetect)
 *   - Air Monitor (Qingping cgllc.airm.cgs2)
 *   - Humidifier (Zhimi / Deerma / Shuii series)
 *
 * 한 platform 항목 하나로 위 5개 기기를 모두 관리한다. 각 기기 유형별로
 * config의 fans / airPurifiers / powerStrips / airMonitors / humidifiers 배열에
 * 장치를 등록하면 해당 헬퍼 클래스가 dynamic platform accessory를 만들어준다.
 *
 * Homebridge 2.0 호환을 위해
 *  - dynamic platform 패턴 (registerPlatformAccessories / unregisterPlatformAccessories)
 *  - Service.Battery (BatteryService deprecated)
 *  - ConfiguredName characteristic
 * 을 사용한다.
 */

'use strict';

const packageJson = require('./package.json');

const FanAccessory = require('./lib/fan/FanAccessory.js');
const AirPurifierAccessory = require('./lib/airpurifier/AirPurifierAccessory.js');
const PowerStripAccessory = require('./lib/powerstrip/PowerStripAccessory.js');
const AirMonitorAccessory = require('./lib/airmonitor/AirMonitorAccessory.js');
const HumidifierAccessory = require('./lib/humidifier/HumidifierAccessory.js');
const MiCloud = require('./lib/common/MiCloud.js');

const PLUGIN_NAME = packageJson.name;          // homebridge-xiaomi-km81
const PLATFORM_NAME = 'XiaomiKm81';            // pluginAlias in config.schema.json

// deviceType 별 권장 폴링 간격 (초). config 에 pollingInterval 이 비어 있으면 이 값을 사용.
//  - fan         : 5초  — 물리 버튼/리모컨 변경을 빠르게 반영해야 함
//  - airPurifier : 10초 — 모드/풍량 변동 빈도가 낮음
//  - powerStrip  : 10초 — 콘센트 상태 변동 빈도가 낮음
//  - airMonitor  : 30초 — PM2.5/온도/습도/CO2 는 분 단위로 천천히 변함
//  - humidifier  : 10초 — 습도/모드는 천천히 변하지만 물탱크 상태는 빠르게 알고 싶음
const RECOMMENDED_POLL_SEC = {
  fan: 5,
  airPurifier: 10,
  powerStrip: 10,
  airMonitor: 30,
  humidifier: 10,
};

let Homebridge;

module.exports = (homebridge) => {
  Homebridge = homebridge;
  homebridge.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, XiaomiKm81Platform, true /* dynamic */);
};

/**
 * 통합 Platform.
 * - configureAccessory : Homebridge가 캐시 액세서리를 복원할 때 호출
 * - didFinishLaunching : 모든 캐시 복원이 끝난 뒤 호출 → 여기서 신규 액세서리 등록
 *
 * 각 액세서리는 PLATFORM_NAME 하나만 사용한다 (Homebridge 2.0에서 단일 등록 권장).
 */
class XiaomiKm81Platform {
  constructor(log, config, api) {
    this.log = log;
    this.api = api;
    this.config = config || {};

    // UUID -> PlatformAccessory (캐시 + 신규 모두 포함)
    this.accessories = new Map();
    // UUID -> 디바이스 헬퍼 인스턴스 (라이프사이클 관리용)
    this.deviceHelpers = new Map();

    // 디바이스 카테고리별 설정 정규화
    this.deviceLists = {
      fans: [], airPurifiers: [], powerStrips: [], airMonitors: [], humidifiers: [],
    };

    // 1) 신규 통합 형식: `devices` 배열에서 deviceType 별로 분류 (SmartThings 패턴)
    //    Homebridge UI 의 드롭다운에서 선택하면 해당 종류의 항목만 노출되도록 schema 가
    //    조건부로 표시한다. 여기서는 deviceType 으로 분류해 각 헬퍼에 맞는 형식으로 매핑.
    const unified = this.normalizeArray(this.config.devices);
    for (const d of unified) {
      if (!d || !d.deviceType) {
        this.log.warn(`[XiaomiKm81] devices[]: deviceType 누락 항목 건너뜀 (name=${d && d.name})`);
        continue;
      }
      const bucket = this.bucketForType(d.deviceType);
      if (!bucket) {
        this.log.warn(`[XiaomiKm81] devices[]: 알 수 없는 deviceType '${d.deviceType}' (name=${d.name})`);
        continue;
      }
      const mapped = this.mapUnifiedDevice(d);
      if (mapped) this.deviceLists[bucket].push(mapped);
    }

    // 2) 레거시 형식 호환: 카테고리별 배열(`fans`/`airPurifiers`/...)도 함께 지원.
    //    구버전 설정으로도 동작하도록 추가로 누적한다.
    this.deviceLists.fans.push(...this.normalizeArray(this.config.fans));
    this.deviceLists.airPurifiers.push(...this.normalizeArray(this.config.airPurifiers));
    this.deviceLists.powerStrips.push(...this.normalizeArray(this.config.powerStrips));
    this.deviceLists.airMonitors.push(...this.normalizeArray(this.config.airMonitors));
    this.deviceLists.humidifiers.push(...this.normalizeArray(this.config.humidifiers));

    const total =
      this.deviceLists.fans.length +
      this.deviceLists.airPurifiers.length +
      this.deviceLists.powerStrips.length +
      this.deviceLists.airMonitors.length +
      this.deviceLists.humidifiers.length;

    if (total === 0) {
      this.log.warn(
        '[XiaomiKm81] 설정된 장치가 없습니다. Homebridge UI에서 장치를 추가하거나, ' +
        'config.json의 platform 항목에 devices 배열(각 항목에 deviceType 지정)을 추가하세요. ' +
        '(레거시 형식인 fans / airPurifiers / powerStrips / airMonitors / humidifiers 배열도 지원됩니다.)'
      );
    } else {
      this.log.info(
        `[XiaomiKm81] v${packageJson.version} - ` +
        `Fan ${this.deviceLists.fans.length}, ` +
        `AirPurifier ${this.deviceLists.airPurifiers.length}, ` +
        `PowerStrip ${this.deviceLists.powerStrips.length}, ` +
        `AirMonitor ${this.deviceLists.airMonitors.length}, ` +
        `Humidifier ${this.deviceLists.humidifiers.length}`
      );
    }

    if (this.api) {
      this.api.on('didFinishLaunching', () => this.initDevices());
    }
  }

  /**
   * Homebridge가 캐시된 액세서리를 복원할 때 호출됨.
   * 액세서리에 어떤 종류의 디바이스가 매칭되는지는 didFinishLaunching에서 결정한다.
   */
  configureAccessory(accessory) {
    this.log.debug(`[XiaomiKm81] 캐시 액세서리 복원: ${accessory.displayName}`);
    this.accessories.set(accessory.UUID, accessory);
  }

  // MiCloud(클라우드) 세션 초기화.
  // - 강제 2FA 계정: tools/micloud-login.js 로 만든 세션 캐시 파일(storage 폴더의
  //   xiaomi-km81-micloud-session.json) 또는 config 의 micloud.serviceToken 으로 인증.
  // - 비2FA 계정: username/password 로 로그인하고 성공 시 세션을 캐시 파일에 저장.
  initMiCloud() {
    const fs = require('fs');
    const path = require('path');
    const mc = this.config.micloud || null;
    this.miCloud = null;

    let sessionFile = null;
    try { sessionFile = path.join(this.api.user.storagePath(), 'xiaomi-km81-micloud-session.json'); } catch (_) {}

    let cached = null;
    if (sessionFile) {
      try { if (fs.existsSync(sessionFile)) cached = JSON.parse(fs.readFileSync(sessionFile, 'utf8')); }
      catch (e) { this.log.warn(`[XiaomiKm81] MiCloud 세션 캐시 읽기 실패: ${e.message || e}`); }
    }
    const cfgToken = (mc && mc.serviceToken && typeof mc.serviceToken === 'object') ? mc.serviceToken : null;
    const hasCreds = !!(mc && mc.username && mc.password);
    if (!hasCreds && !cached && !cfgToken) return;   // micloud 미사용

    try {
      const logger = {
        debug: (...a) => this.log.debug('[MiCloud]', ...a),
        deepDebug: (...a) => { if (mc && mc.debug) this.log.debug('[MiCloud]', ...a); },
        info: (...a) => this.log.info('[MiCloud]', ...a),
      };
      const miCloud = new MiCloud(logger);
      const country = (cfgToken && mc && mc.country) || (cached && cached.country) || (mc && mc.country) || 'cn';
      miCloud.setCountry(String(country).toLowerCase());
      // 우선순위: config serviceToken > 캐시 파일 세션
      if (cfgToken) miCloud.setServiceToken(cfgToken);
      else if (cached && cached.session) miCloud.setServiceToken(cached.session);
      this.miCloud = miCloud;

      if (miCloud.isLoggedIn()) {
        this.log.info('[XiaomiKm81] MiCloud 캐시 세션 사용 중');
      } else if (hasCreds) {
        miCloud.login(mc.username, mc.password)
          .then(() => {
            this.log.info('[XiaomiKm81] MiCloud 로그인 성공');
            if (sessionFile) {
              try {
                fs.writeFileSync(sessionFile, JSON.stringify({ country: miCloud.country, session: miCloud.getServiceToken() }, null, 2) + '\n');
                this.log.info('[XiaomiKm81] MiCloud 세션을 캐시에 저장했습니다');
              } catch (_) {}
            }
          })
          .catch(err => {
            if (err && err.notificationUrl) {
              this.log.error('[XiaomiKm81] MiCloud 2단계 인증(2FA)이 필요합니다. tools/micloud-login.js 를 한 번 실행해 세션을 만든 뒤 ' +
                `'${sessionFile || 'storage'}' 위치에 두세요. ` + err.message);
            } else {
              this.log.error(`[XiaomiKm81] MiCloud 로그인 실패: ${err && err.message || err}`);
            }
          });
      } else {
        this.log.warn('[XiaomiKm81] MiCloud 세션이 없습니다. tools/micloud-login.js 로 세션을 만들어 storage 폴더에 두세요.');
      }
    } catch (e) {
      this.log.error(`[XiaomiKm81] MiCloud 초기화 실패: ${e.message || e}`);
      this.miCloud = null;
    }
  }

  initDevices() {
    const usedUUIDs = new Set();

    this.initMiCloud();

    // 각 유형별 액세서리 초기화. 헬퍼 클래스는 항상 동일한 ctx 형태를 받는다.
    // ctx = { platform, api, log, hap, PLUGIN_NAME, PLATFORM_NAME, accessoriesMap, miCloud }
    const ctx = {
      api: this.api,
      log: this.log,
      hap: this.api.hap,
      PLUGIN_NAME,
      PLATFORM_NAME,
      accessories: this.accessories,
      packageVersion: packageJson.version,
      miCloud: this.miCloud,
    };

    // 같은 기기를 레거시 배열과 통합 devices 배열에(혹은 한 배열에 두 번) 중복 등록하면
    // 동일 기기에 대해 폴링 루프가 둘 돌아 트래픽/낙관적 UI 충돌이 생긴다. 기기당 IP 는
    // 유일하므로 IP 기준으로 중복 항목을 한 번만 남긴다.
    const seenIps = new Set();
    const dedupe = (list, label) => (Array.isArray(list) ? list : []).filter(cfg => {
      const ip = cfg && cfg.ip;
      if (!ip) return true;
      const key = String(ip).trim().toLowerCase();
      if (seenIps.has(key)) {
        this.log.warn(`[XiaomiKm81] ${label} '${(cfg && cfg.name) || ip}' 는 IP ${ip} 가 이미 등록되어 건너뜁니다 (중복).`);
        return false;
      }
      seenIps.add(key);
      return true;
    });
    this.deviceLists.fans = dedupe(this.deviceLists.fans, 'Fan');
    this.deviceLists.airPurifiers = dedupe(this.deviceLists.airPurifiers, 'AirPurifier');
    this.deviceLists.powerStrips = dedupe(this.deviceLists.powerStrips, 'PowerStrip');
    this.deviceLists.airMonitors = dedupe(this.deviceLists.airMonitors, 'AirMonitor');
    this.deviceLists.humidifiers = dedupe(this.deviceLists.humidifiers, 'Humidifier');

    for (const cfg of this.deviceLists.fans) {
      this.tryInit('Fan', cfg, () => {
        const uuid = FanAccessory.computeUUID(this.api.hap, cfg);
        if (!uuid) return null;
        const helper = new FanAccessory(ctx, cfg);
        this.deviceHelpers.set(uuid, helper);
        return helper.getAccessoryUUIDs();
      }, usedUUIDs);
    }

    for (const cfg of this.deviceLists.airPurifiers) {
      this.tryInit('AirPurifier', cfg, () => {
        const helper = new AirPurifierAccessory(ctx, cfg);
        const uuids = helper.getAccessoryUUIDs();
        if (uuids && uuids.length) {
          uuids.forEach(u => this.deviceHelpers.set(u, helper));
        }
        return uuids;
      }, usedUUIDs);
    }

    for (const cfg of this.deviceLists.powerStrips) {
      this.tryInit('PowerStrip', cfg, () => {
        const helper = new PowerStripAccessory(ctx, cfg);
        const uuids = helper.getAccessoryUUIDs();
        if (uuids && uuids.length) {
          uuids.forEach(u => this.deviceHelpers.set(u, helper));
        }
        return uuids;
      }, usedUUIDs);
    }

    for (const cfg of this.deviceLists.airMonitors) {
      this.tryInit('AirMonitor', cfg, () => {
        const helper = new AirMonitorAccessory(ctx, cfg);
        const uuids = helper.getAccessoryUUIDs();
        if (uuids && uuids.length) {
          uuids.forEach(u => this.deviceHelpers.set(u, helper));
        }
        return uuids;
      }, usedUUIDs);
    }

    for (const cfg of this.deviceLists.humidifiers) {
      this.tryInit('Humidifier', cfg, () => {
        const helper = new HumidifierAccessory(ctx, cfg);
        const uuids = helper.getAccessoryUUIDs();
        if (uuids && uuids.length) {
          uuids.forEach(u => this.deviceHelpers.set(u, helper));
        }
        return uuids;
      }, usedUUIDs);
    }

    // 사용되지 않은 캐시 액세서리 정리 (설정에서 제거된 디바이스)
    const orphans = [];
    for (const [uuid, accessory] of this.accessories) {
      if (!usedUUIDs.has(uuid)) {
        orphans.push(accessory);
      }
    }
    if (orphans.length > 0) {
      this.log.info(`[XiaomiKm81] 설정에 없는 캐시 액세서리 ${orphans.length}개 정리`);
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, orphans);
      orphans.forEach(a => this.accessories.delete(a.UUID));
    }

    // Shutdown 이벤트 → 모든 헬퍼에게 cleanup 기회 제공
    this.api.on('shutdown', () => {
      for (const helper of this.deviceHelpers.values()) {
        try { helper.shutdown && helper.shutdown(); } catch (_) {}
      }
    });
  }

  /* ---------------- helpers ---------------- */

  /**
   * deviceType (신규 schema 값) → deviceLists 키 매핑.
   */
  bucketForType(t) {
    switch (t) {
      case 'fan':         return 'fans';
      case 'airPurifier': return 'airPurifiers';
      case 'powerStrip':  return 'powerStrips';
      case 'airMonitor':  return 'airMonitors';
      case 'humidifier':  return 'humidifiers';
      default:            return null;
    }
  }

  /**
   * 신규 통합 schema (devices[].*) → 각 헬퍼가 기대하는 cfg 형식으로 변환.
   *
   *  - 폴링 간격이 비어 있거나 0 이하이면 deviceType 별 권장값(RECOMMENDED_POLL_SEC)으로 채움.
   *  - airPurifier: `airPurifierType` → `type` (헬퍼는 cfg.type 로 모델을 받음)
   *  - humidifier:  `humidifierModel` → `model` (헬퍼는 cfg.model 로 모델을 받음)
   *  - airPurifier/powerStrip 의 pollingInterval 은 헬퍼가 ms 단위를 기대하므로
   *    신규 schema 의 초 단위 입력을 ms 로 환산. 1000 이상은 사용자가 ms 로 입력한
   *    것으로 간주해 그대로 둔다 (방어 코드, 레거시 호환).
   */
  mapUnifiedDevice(d) {
    const out = Object.assign({}, d);
    delete out.deviceType;

    // 폴링 간격: UI/config 에서 문자열("10")로 들어올 수 있으므로 숫자로 정규화한다.
    // 비었거나 유효하지 않으면 deviceType 별 권장 기본값으로 채움 (초 단위).
    const pi = Number(out.pollingInterval);
    out.pollingInterval = (Number.isFinite(pi) && pi > 0) ? pi : undefined;
    if (out.pollingInterval === undefined) {
      const def = RECOMMENDED_POLL_SEC[d.deviceType];
      if (def) out.pollingInterval = def;
    }

    switch (d.deviceType) {
      case 'fan':
        return out;
      case 'airPurifier': {
        out.type = d.airPurifierType || d.type || 'MiAirPurifier2S';
        if (Number.isFinite(out.pollingInterval) && out.pollingInterval > 0 && out.pollingInterval < 1000) {
          out.pollingInterval = out.pollingInterval * 1000;
        }
        return out;
      }
      case 'powerStrip': {
        if (Number.isFinite(out.pollingInterval) && out.pollingInterval > 0 && out.pollingInterval < 1000) {
          out.pollingInterval = out.pollingInterval * 1000;
        }
        return out;
      }
      case 'airMonitor':
        return out;
      case 'humidifier': {
        out.model = d.humidifierModel || d.model;
        return out;
      }
      default:
        return null;
    }
  }

  normalizeArray(v) {
    if (!v) return [];
    if (Array.isArray(v)) return v.filter(x => x && typeof x === 'object');
    if (typeof v === 'object') return [v];
    return [];
  }

  tryInit(label, cfg, factory, usedUUIDs) {
    try {
      const uuids = factory();
      if (uuids && Array.isArray(uuids)) {
        uuids.forEach(u => usedUUIDs.add(u));
      } else if (uuids) {
        usedUUIDs.add(uuids);
      }
    } catch (err) {
      const name = (cfg && (cfg.name || cfg.ip)) || '(unnamed)';
      this.log.error(`[XiaomiKm81] ${label} '${name}' 초기화 실패: ${err.message}`);
      if (err.stack) this.log.debug(err.stack);
    }
  }
}

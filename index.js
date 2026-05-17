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

const PLUGIN_NAME = packageJson.name;          // homebridge-xiaomi-km81
const PLATFORM_NAME = 'XiaomiKm81';            // pluginAlias in config.schema.json

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
      fans:         this.normalizeArray(this.config.fans),
      airPurifiers: this.normalizeArray(this.config.airPurifiers),
      powerStrips:  this.normalizeArray(this.config.powerStrips),
      airMonitors:  this.normalizeArray(this.config.airMonitors),
      humidifiers:  this.normalizeArray(this.config.humidifiers),
    };

    const total =
      this.deviceLists.fans.length +
      this.deviceLists.airPurifiers.length +
      this.deviceLists.powerStrips.length +
      this.deviceLists.airMonitors.length +
      this.deviceLists.humidifiers.length;

    if (total === 0) {
      this.log.warn(
        '[XiaomiKm81] 설정된 장치가 없습니다. config.json의 platform 항목에 ' +
        'fans / airPurifiers / powerStrips / airMonitors / humidifiers 배열을 추가하세요.'
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

  initDevices() {
    const usedUUIDs = new Set();

    // 각 유형별 액세서리 초기화. 헬퍼 클래스는 항상 동일한 ctx 형태를 받는다.
    // ctx = { platform, api, log, hap, PLUGIN_NAME, PLATFORM_NAME, accessoriesMap }
    const ctx = {
      api: this.api,
      log: this.log,
      hap: this.api.hap,
      PLUGIN_NAME,
      PLATFORM_NAME,
      accessories: this.accessories,
      packageVersion: packageJson.version,
    };

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

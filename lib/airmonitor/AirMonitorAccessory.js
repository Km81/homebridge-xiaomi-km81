/**
 * AirMonitorAccessory - Qingping Air Monitor 2 (cgllc.airm.cgs2)
 *
 * 기존 homebridge-qingping-air-monitor2-km81 코드를 거의 그대로 가져오되,
 * Homebridge / Service / Characteristic / Accessory 전역 참조 대신 ctx 객체를
 * 통해 주입받도록 적응시켰다. 사용자가 "잘 작동 중" 이라고 한 모듈이므로
 * 동작 자체는 변경하지 않는다.
 */

'use strict';

const QingpingMonitor = require('./QingpingMonitor.js');
const { clamp, isFiniteNumber, applyServiceName } = require('../common/helpers.js');

const DEFAULT_POLLING_INTERVAL_SEC = 30;
const DEFAULT_CO2_DETECT_THRESHOLD = 1000;
const DEFAULT_CO2_CLEAR_THRESHOLD  = 900;
const DEFAULT_PM25_BREAKPOINTS = [7, 15, 30, 55];
const LOW_BATTERY_THRESHOLD = 20;

const DEFAULT_NAMES = {
  airQuality:  '공기질',
  temperature: '온도',
  humidity:    '습도',
  co2:         '이산화탄소',
  battery:     '배터리',
};

const SUBTYPES = {
  airQuality:  'airQualityService',
  temperature: 'temperatureService',
  humidity:    'humidityService',
  co2:         'co2Service',
  battery:     'batteryService',
};

function fmtNum(v, d = 0) {
  return (typeof v === 'number' && Number.isFinite(v)) ? v.toFixed(d) : '?';
}

class AirMonitorAccessory {
  constructor(ctx, config) {
    this.ctx = ctx;
    this.api = ctx.api;
    this.log = ctx.log;
    this.hap = ctx.hap;
    this.Service = this.hap.Service;
    this.Characteristic = this.hap.Characteristic;
    this.PLUGIN_NAME = ctx.PLUGIN_NAME;
    this.PLATFORM_NAME = ctx.PLATFORM_NAME;

    this.name = config.name || 'Qingping Air Monitor 2';
    this.ip = config.ip;
    this.token = config.token;
    this.deviceId = config.deviceId;

    if (!this.ip || !this.token) {
      throw new Error(`AirMonitor '${this.name}': ip 또는 token이 없습니다`);
    }

    const pollSec = clamp(Number(config.pollingInterval), 5, 600, DEFAULT_POLLING_INTERVAL_SEC);
    this.pollingIntervalMs = (Number.isFinite(pollSec) ? pollSec : DEFAULT_POLLING_INTERVAL_SEC) * 1000;

    this.enableTemperature = config.enableTemperatureSensor !== false;
    this.enableHumidity = config.enableHumiditySensor !== false;
    this.enableAirQuality = config.enableAirQualitySensor !== false;
    this.enableCo2 = config.enableCarbonDioxideSensor !== false;

    this.sensorNames = {
      airQuality:  (config.airQualitySensorName  || '').trim() || DEFAULT_NAMES.airQuality,
      temperature: (config.temperatureSensorName || '').trim() || DEFAULT_NAMES.temperature,
      humidity:    (config.humiditySensorName    || '').trim() || DEFAULT_NAMES.humidity,
      co2:         (config.co2SensorName         || '').trim() || DEFAULT_NAMES.co2,
      battery:     DEFAULT_NAMES.battery,
    };

    this.pm25Breakpoints = this.resolvePm25Breakpoints(config);

    let co2Detect = config.co2DetectThreshold;
    let co2Clear = config.co2ClearThreshold;
    if (co2Detect === undefined && config.co2AbnormalThreshold !== undefined) {
      co2Detect = config.co2AbnormalThreshold;
      this.log.info(`[${this.name}] 'co2AbnormalThreshold'는 deprecated. 'co2DetectThreshold' 사용 권장.`);
    }
    const detectN = Number(co2Detect);
    this.co2DetectThreshold = (Number.isFinite(detectN) ? clamp(detectN, 400, 5000) : DEFAULT_CO2_DETECT_THRESHOLD);
    if (co2Clear !== undefined) {
      const clearN = Number(co2Clear);
      this.co2ClearThreshold = Number.isFinite(clearN) ? clamp(clearN, 400, 5000) : Math.round(this.co2DetectThreshold * 0.9);
    } else {
      this.co2ClearThreshold = Math.round(this.co2DetectThreshold * 0.9);
    }
    if (this.co2ClearThreshold >= this.co2DetectThreshold) {
      this.log.warn(`[${this.name}] co2ClearThreshold(${this.co2ClearThreshold}) ≥ co2DetectThreshold(${this.co2DetectThreshold}). 기본값으로 보정.`);
      this.co2DetectThreshold = DEFAULT_CO2_DETECT_THRESHOLD;
      this.co2ClearThreshold = DEFAULT_CO2_CLEAR_THRESHOLD;
    }

    this.UUID = this.hap.uuid.generate(`xiaomi-km81:airmonitor:${this.token}:${this.ip}`);

    this.lastValues = { humidity: 0, pm25: 0, pm10: 0, temperature: 0, co2: 400, tvoc: 0, batteryLevel: 100, chargingState: 2 };
    this.co2DetectedState = false;

    this.initAccessory();
    this.monitor = new QingpingMonitor(this.ip, this.token, this.deviceId, this.log);
    this.startPolling();

    this.log.info(`[${this.name}] 활성화된 센서: ` +
      `${this.enableAirQuality ? `${this.sensorNames.airQuality} ` : ''}` +
      `${this.enableTemperature ? `${this.sensorNames.temperature} ` : ''}` +
      `${this.enableHumidity ? `${this.sensorNames.humidity} ` : ''}` +
      `${this.enableCo2 ? `${this.sensorNames.co2} ` : ''}${this.sensorNames.battery}`);
  }

  getAccessoryUUIDs() { return [this.UUID]; }

  shutdown() {
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
    if (this.monitor) { try { this.monitor.destroy(); } catch (_) {} this.monitor = null; }
  }

  resolvePm25Breakpoints(config) {
    const fromIndividual = [
      config.pm25LimitExcellent, config.pm25LimitGood, config.pm25LimitFair, config.pm25LimitInferior
    ];
    if (fromIndividual.every(v => Number.isFinite(Number(v)))) {
      return fromIndividual.map(v => clamp(Number(v), 0, 500)).sort((a, b) => a - b);
    }
    if (Array.isArray(config.pm25Breakpoints) && config.pm25Breakpoints.length === 4) {
      return [...config.pm25Breakpoints].map(v => clamp(Number(v), 0, 500)).sort((a, b) => a - b);
    }
    return [...DEFAULT_PM25_BREAKPOINTS];
  }

  initAccessory() {
    let accessory = this.ctx.accessories.get(this.UUID);
    if (!accessory) {
      accessory = new this.api.platformAccessory(this.name, this.UUID, this.hap.Categories.SENSOR);
      this.api.registerPlatformAccessories(this.PLUGIN_NAME, this.PLATFORM_NAME, [accessory]);
      this.ctx.accessories.set(this.UUID, accessory);
      this.log.info(`[${this.name}] 새 액세서리 등록 (UUID=${this.UUID.substring(0, 8)}…)`);
    } else {
      this.log.info(`[${this.name}] 캐시된 액세서리 재사용 (UUID=${this.UUID.substring(0, 8)}…)`);
    }
    this.accessory = accessory;

    if (!this.accessory.context.serviceNames) this.accessory.context.serviceNames = {};

    this.setupInformationService();

    if (this.enableAirQuality) this.setupAirQualityService();
    else this.removeServiceBySubtype(this.Service.AirQualitySensor, SUBTYPES.airQuality, this.sensorNames.airQuality);

    if (this.enableTemperature) this.setupTemperatureService();
    else this.removeServiceBySubtype(this.Service.TemperatureSensor, SUBTYPES.temperature, this.sensorNames.temperature);

    if (this.enableHumidity) this.setupHumidityService();
    else this.removeServiceBySubtype(this.Service.HumiditySensor, SUBTYPES.humidity, this.sensorNames.humidity);

    if (this.enableCo2) this.setupCarbonDioxideService();
    else this.removeServiceBySubtype(this.Service.CarbonDioxideSensor, SUBTYPES.co2, this.sensorNames.co2);

    this.setupBatteryService();
  }

  removeServiceBySubtype(ServiceClass, subType, label) {
    const service = this.accessory.getServiceById(ServiceClass, subType);
    if (service) {
      this.accessory.removeService(service);
      this.log.info(`[${this.name}] ${label} 센서 비활성화 → 액세서리에서 제거됨`);
    }
    if (this.accessory.context.serviceNames) delete this.accessory.context.serviceNames[subType];
  }

  getOrCreateService(ServiceClass, displayName, subType) {
    const { Characteristic } = this;
    let service = this.accessory.getServiceById(ServiceClass, subType);
    if (!service) {
      service = new ServiceClass(displayName, subType);
      this.accessory.addService(service);
    }
    service.setCharacteristic(Characteristic.Name, displayName);

    const ctx = this.accessory.context.serviceNames;
    const lastConfigName = ctx[subType];
    const configChanged = (lastConfigName !== undefined && lastConfigName !== displayName);

    if (!service.testCharacteristic(Characteristic.ConfiguredName)) {
      service.addCharacteristic(Characteristic.ConfiguredName);
      service.setCharacteristic(Characteristic.ConfiguredName, displayName);
    } else if (configChanged) {
      service.setCharacteristic(Characteristic.ConfiguredName, displayName);
      this.log.info(`[${this.name}] ${subType} 이름이 config에서 변경: ${lastConfigName} → ${displayName}`);
    }
    ctx[subType] = displayName;
    return service;
  }

  setupInformationService() {
    const { Service, Characteristic } = this;
    let info = this.accessory.getService(Service.AccessoryInformation);
    if (!info) info = this.accessory.addService(Service.AccessoryInformation);
    info
      .setCharacteristic(Characteristic.Manufacturer, 'Qingping')
      .setCharacteristic(Characteristic.Model, 'Air Monitor 2 (cgllc.airm.cgs2)')
      .setCharacteristic(Characteristic.SerialNumber, this.deviceId || (this.token ? this.token.substring(0, 16) : 'Unknown'))
      .setCharacteristic(Characteristic.FirmwareRevision, this.ctx.packageVersion);
  }

  setupAirQualityService() {
    const { Service, Characteristic } = this;
    this.airQualityService = this.getOrCreateService(Service.AirQualitySensor, this.sensorNames.airQuality, SUBTYPES.airQuality);
    this.airQualityService.getCharacteristic(Characteristic.AirQuality)
      .onGet(() => this.calcAirQuality(this.lastValues.pm25));
    this.ensureCharacteristic(this.airQualityService, Characteristic.PM2_5Density)
      .onGet(() => clamp(this.lastValues.pm25, 0, 1000));
    this.ensureCharacteristic(this.airQualityService, Characteristic.PM10Density)
      .onGet(() => clamp(this.lastValues.pm10, 0, 1000));
    this.ensureCharacteristic(this.airQualityService, Characteristic.VOCDensity)
      .onGet(() => clamp(this.lastValues.tvoc, 0, 5000));
  }

  setupTemperatureService() {
    const { Service, Characteristic } = this;
    this.temperatureService = this.getOrCreateService(Service.TemperatureSensor, this.sensorNames.temperature, SUBTYPES.temperature);
    this.temperatureService.getCharacteristic(Characteristic.CurrentTemperature)
      .onGet(() => clamp(this.lastValues.temperature, -40, 100));
  }

  setupHumidityService() {
    const { Service, Characteristic } = this;
    this.humidityService = this.getOrCreateService(Service.HumiditySensor, this.sensorNames.humidity, SUBTYPES.humidity);
    this.humidityService.getCharacteristic(Characteristic.CurrentRelativeHumidity)
      .onGet(() => clamp(this.lastValues.humidity, 0, 100));
  }

  setupCarbonDioxideService() {
    const { Service, Characteristic } = this;
    this.co2Service = this.getOrCreateService(Service.CarbonDioxideSensor, this.sensorNames.co2, SUBTYPES.co2);
    this.co2Service.getCharacteristic(Characteristic.CarbonDioxideDetected)
      .onGet(() => this.co2DetectedState
        ? Characteristic.CarbonDioxideDetected.CO2_LEVELS_ABNORMAL
        : Characteristic.CarbonDioxideDetected.CO2_LEVELS_NORMAL);
    this.ensureCharacteristic(this.co2Service, Characteristic.CarbonDioxideLevel)
      .onGet(() => clamp(this.lastValues.co2, 0, 100000));
  }

  setupBatteryService() {
    const { Service, Characteristic } = this;
    const BatteryClass = Service.Battery || Service.BatteryService;
    this.batteryService = this.getOrCreateService(BatteryClass, this.sensorNames.battery, SUBTYPES.battery);
    this.batteryService.getCharacteristic(Characteristic.BatteryLevel)
      .onGet(() => clamp(this.lastValues.batteryLevel, 0, 100));
    this.batteryService.getCharacteristic(Characteristic.ChargingState)
      .onGet(() => this.mapChargingState(this.lastValues.chargingState));
    this.batteryService.getCharacteristic(Characteristic.StatusLowBattery)
      .onGet(() => this.lastValues.batteryLevel < LOW_BATTERY_THRESHOLD
        ? Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW
        : Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL);
  }

  ensureCharacteristic(service, charClass) {
    if (!service.testCharacteristic(charClass)) service.addCharacteristic(charClass);
    return service.getCharacteristic(charClass);
  }

  startPolling() {
    this.pollOnce();
    this.pollTimer = setInterval(() => this.pollOnce(), this.pollingIntervalMs);
  }

  async pollOnce() {
    try {
      const values = await this.monitor.readAllProperties();
      this.lastValues = { ...this.lastValues, ...values };
      this.evaluateCo2Hysteresis();
      this.pushUpdates();

      const log = `T=${fmtNum(values.temperature, 1)}°C, RH=${fmtNum(values.humidity, 0)}%, PM2.5=${fmtNum(values.pm25, 0)}μg/m³, CO2=${fmtNum(values.co2, 0)}ppm, Bat=${fmtNum(values.batteryLevel, 0)}%`;

      if (!this.firstPollOK) {
        this.firstPollOK = true;
        this.firstPollFailLogged = false;
        this.log.info(`[${this.name}] 첫 폴링 성공 ✓  ${log}`);
      } else {
        this.log.debug(`[${this.name}] 폴링 OK: ${log} (감지=${this.co2DetectedState})`);
      }
    } catch (err) {
      if (!this.firstPollFailLogged) {
        this.firstPollFailLogged = true;
        this.log.warn(`[${this.name}] 폴링 실패: ${err.message} (이후 동일 에러는 디버그 로그로만 출력됨)`);
      } else {
        this.log.debug(`[${this.name}] 폴링 실패 (반복): ${err.message}`);
      }
    }
  }

  evaluateCo2Hysteresis() {
    const ppm = this.lastValues.co2;
    if (!isFiniteNumber(ppm)) return;
    if (!this.co2DetectedState && ppm >= this.co2DetectThreshold) {
      this.co2DetectedState = true;
      this.log.info(`[${this.name}] CO2 감지: ${fmtNum(ppm, 0)}ppm ≥ ${this.co2DetectThreshold}ppm`);
    } else if (this.co2DetectedState && ppm <= this.co2ClearThreshold) {
      this.co2DetectedState = false;
      this.log.info(`[${this.name}] CO2 해제: ${fmtNum(ppm, 0)}ppm ≤ ${this.co2ClearThreshold}ppm`);
    }
  }

  pushUpdates() {
    const { Characteristic } = this;
    try {
      const v = this.lastValues;
      if (this.airQualityService) {
        this.airQualityService.getCharacteristic(Characteristic.AirQuality).updateValue(this.calcAirQuality(v.pm25));
        this.airQualityService.getCharacteristic(Characteristic.PM2_5Density).updateValue(clamp(v.pm25, 0, 1000));
        this.airQualityService.getCharacteristic(Characteristic.PM10Density).updateValue(clamp(v.pm10, 0, 1000));
        this.airQualityService.getCharacteristic(Characteristic.VOCDensity).updateValue(clamp(v.tvoc, 0, 5000));
      }
      if (this.temperatureService) {
        this.temperatureService.getCharacteristic(Characteristic.CurrentTemperature).updateValue(clamp(v.temperature, -40, 100));
      }
      if (this.humidityService) {
        this.humidityService.getCharacteristic(Characteristic.CurrentRelativeHumidity).updateValue(clamp(v.humidity, 0, 100));
      }
      if (this.co2Service) {
        this.co2Service.getCharacteristic(Characteristic.CarbonDioxideDetected).updateValue(
          this.co2DetectedState
            ? Characteristic.CarbonDioxideDetected.CO2_LEVELS_ABNORMAL
            : Characteristic.CarbonDioxideDetected.CO2_LEVELS_NORMAL
        );
        this.co2Service.getCharacteristic(Characteristic.CarbonDioxideLevel).updateValue(clamp(v.co2, 0, 100000));
      }
      if (this.batteryService) {
        this.batteryService.getCharacteristic(Characteristic.BatteryLevel).updateValue(clamp(v.batteryLevel, 0, 100));
        this.batteryService.getCharacteristic(Characteristic.ChargingState).updateValue(this.mapChargingState(v.chargingState));
        this.batteryService.getCharacteristic(Characteristic.StatusLowBattery).updateValue(
          v.batteryLevel < LOW_BATTERY_THRESHOLD
            ? Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW
            : Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL
        );
      }
    } catch (err) {
      this.log.debug(`[${this.name}] characteristic 업데이트 예외: ${err.message}`);
    }
  }

  calcAirQuality(pm25) {
    const { Characteristic } = this;
    if (pm25 === undefined || pm25 === null || isNaN(pm25)) return Characteristic.AirQuality.UNKNOWN;
    const [a, b, c, d] = this.pm25Breakpoints;
    if (pm25 < a) return Characteristic.AirQuality.EXCELLENT;
    if (pm25 < b) return Characteristic.AirQuality.GOOD;
    if (pm25 < c) return Characteristic.AirQuality.FAIR;
    if (pm25 < d) return Characteristic.AirQuality.INFERIOR;
    return Characteristic.AirQuality.POOR;
  }

  mapChargingState(v) {
    const { Characteristic } = this;
    switch (v) {
      case 1: return Characteristic.ChargingState.CHARGING;
      case 3: return Characteristic.ChargingState.NOT_CHARGEABLE;
      case 2:
      default: return Characteristic.ChargingState.NOT_CHARGING;
    }
  }
}

module.exports = AirMonitorAccessory;

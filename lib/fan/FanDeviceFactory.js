'use strict';

const MiioSmartmiFan = require('./devices/miio/MiioSmartmiFan.js');
const MiioDmakerFanP5 = require('./devices/miio/MiioDmakerFanP5.js');
const MiotDmakerAcFan = require('./devices/miot/MiotDmakerAcFan.js');
const MiotDmakerDcFan = require('./devices/miot/MiotDmakerDcFan.js');
const MiotSmartmiDcFan = require('./devices/miot/MiotSmartmiDcFan.js');
const ZhimiFanFa1 = require('./devices/miot/zhimi.fan.fa1.js');
const ZhimiFanFb1 = require('./devices/miot/zhimi.fan.fb1.js');
const AirFanCa23ad9 = require('./devices/miot/air.fan.ca23ad9.js');
const XiaomiFanP45 = require('./devices/miot/xiaomi.fan.p45.js');
const MiotGenericFan = require('./devices/miot/MiotGenericFan.js');

const SMARTMI_MIIO_DEVICES = ['zhimi.fan.v2', 'zhimi.fan.v3', 'zhimi.fan.sa1', 'zhimi.fan.za1', 'zhimi.fan.za3', 'zhimi.fan.za4'];
const DMAKER_MIIO_DEVICES = ['dmaker.fan.p5'];
const DMAKER_AC_MIOT_DEVICES = ['dmaker.fan.1c', 'dmaker.fan.p8'];
const DMAKER_DC_MIOT_DEVICES = ['dmaker.fan.p9', 'dmaker.fan.p10', 'dmaker.fan.p11', 'dmaker.fan.p15', 'dmaker.fan.p18', 'dmaker.fan.p30', 'dmaker.fan.p33'];
const SMARTMI_DC_MIOT_DEVICES = ['zhimi.fan.za5'];
const ZHIMI_FAN_FA1 = ['zhimi.fan.fa1'];
const ZHIMI_FAN_FB1 = ['zhimi.fan.fb1'];
const AIR_FAN_CA23AD9 = ['air.fan.ca23ad9'];
const XIAOMI_FAN_P45 = ['xiaomi.fan.p45'];

class FanDeviceFactory {

  static createFanDevice(miioDevice, model, deviceId, name, log, fanController) {
    let fanDevice = null;

    if (miioDevice || model) {
      const fanModel = miioDevice ? miioDevice.miioModel : model;

      if (SMARTMI_MIIO_DEVICES.includes(fanModel)) {
        fanController.logDebug(`Creating SmartmiFan device!`);
        fanDevice = new MiioSmartmiFan(miioDevice, fanModel, deviceId, name, log);
      } else if (DMAKER_MIIO_DEVICES.includes(fanModel)) {
        fanController.logDebug(`Creating DmakerFan device!`);
        fanDevice = new MiioDmakerFanP5(miioDevice, fanModel, deviceId, name, log);
      } else if (DMAKER_AC_MIOT_DEVICES.includes(fanModel)) {
        fanController.logDebug(`Creating MiotDmakerAcFan device!`);
        fanDevice = new MiotDmakerAcFan(miioDevice, fanModel, deviceId, name, log);
      } else if (DMAKER_DC_MIOT_DEVICES.includes(fanModel)) {
        fanController.logDebug(`Creating MiotDmakerDcFan device!`);
        fanDevice = new MiotDmakerDcFan(miioDevice, fanModel, deviceId, name, log);
      } else if (SMARTMI_DC_MIOT_DEVICES.includes(fanModel)) {
        fanController.logDebug(`Creating MiotSmartmiDcFan device!`);
        fanDevice = new MiotSmartmiDcFan(miioDevice, fanModel, deviceId, name, log);
      } else if (ZHIMI_FAN_FA1.includes(fanModel)) {
        fanController.logDebug(`Creating zhimi.fan.fa1 device!`);
        fanDevice = new ZhimiFanFa1(miioDevice, fanModel, deviceId, name, log);
      } else if (ZHIMI_FAN_FB1.includes(fanModel)) {
        fanController.logDebug(`Creating zhimi.fan.fb1 device!`);
        fanDevice = new ZhimiFanFb1(miioDevice, fanModel, deviceId, name, log);
      } else if (AIR_FAN_CA23AD9.includes(fanModel)) {
        fanController.logDebug(`Creating air.fan.ca23ad9 device!`);
        fanDevice = new AirFanCa23ad9(miioDevice, fanModel, deviceId, name, log);
      } else if (XIAOMI_FAN_P45.includes(fanModel)) {
        fanController.logDebug(`Creating xiaomi.fan.p45 device!`);
        fanDevice = new XiaomiFanP45(miioDevice, fanModel, deviceId, name, log);
      } else {
        fanController.logDebug(`Creating MiotGenericFan device!`);
        fanDevice = new MiotGenericFan(miioDevice, fanModel, deviceId, name, log);
      }
    }

    return fanDevice;
  }
}

module.exports = FanDeviceFactory;

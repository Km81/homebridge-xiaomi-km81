'use strict';

const ZhimiFanFa1 = require('./zhimi.fan.fa1.js');

// zhimi.fan.fb1 - same MIoT spec as fa1, inherit unchanged
class ZhimiFanFb1 extends ZhimiFanFa1 {
  constructor(miioDevice, model, deviceId, name, log) {
    super(miioDevice, model, deviceId, name, log);
  }
}

module.exports = ZhimiFanFb1;

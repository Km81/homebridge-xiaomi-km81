'use strict';
// MiCloud 관련 에러 (merdok/homebridge-miot 의 정의 일부 포팅).

class TwoFactorRequired extends Error {
  constructor(notificationUrl) {
    super('2단계 인증(2FA)이 필요합니다. 다음 URL 로 인증 후 다시 시도하세요: ' + notificationUrl);
    this.notificationUrl = notificationUrl;
  }
}

class MissingDeviceId extends Error {
  constructor(name) {
    super(`'${name}' 의 deviceId 가 없습니다! 클라우드 제어에는 deviceId 가 필요합니다. config.json 에 deviceId 를 지정하세요.`);
  }
}

class MissingMiCloudCredentials extends Error {
  constructor() {
    super('MiCloud 연결 정보가 없습니다! micloud.username 과 micloud.password 를 지정하세요.');
  }
}

module.exports = { TwoFactorRequired, MissingDeviceId, MissingMiCloudCredentials };

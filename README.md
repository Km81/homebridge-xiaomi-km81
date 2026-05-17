# homebridge-xiaomi-km81

Xiaomi 5종(선풍기 / 공기청정기 / 멀티탭 / 공기측정기 / 가습기)을 하나의 Homebridge platform 으로 통합한 플러그인입니다. Homebridge 2.0 호환.

| 카테고리       | 지원 디바이스                                              |
|----------------|------------------------------------------------------------|
| Fan            | Smartmi / Mija / Dmaker 시리즈 (zhimi.fan.*, dmaker.fan.*) |
| Air Purifier   | Mi Air Purifier 2S, Pro                                    |
| Power Strip    | Mi Power Strip / Smart Plug (miot · legacy 자동 감지)      |
| Air Monitor    | Qingping Air Monitor 2 (cgllc.airm.cgs2)                   |
| Humidifier     | Zhimi / Deerma / Shuii 시리즈 (12종 모델)                  |

## 설치

```bash
npm i -g homebridge-xiaomi-km81
```

또는 Homebridge UI 에서 `homebridge-xiaomi-km81` 검색.

## 설정

`config.json` 의 `platforms` 배열에 다음과 같이 추가합니다. 모든 배열은 선택사항이며, 사용하는 카테고리만 채워주세요.

```jsonc
{
  "platforms": [
    {
      "platform": "XiaomiKm81",

      "fans": [
        {
          "name": "거실 선풍기",
          "ip": "192.168.1.50",
          "token": "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
          "model": "dmaker.fan.p11",
          "deviceId": "123456789"
        }
      ],

      "airPurifiers": [
        {
          "name": "안방 공기청정기",
          "ip": "192.168.1.51",
          "token": "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
          "type": "MiAirPurifier2S",
          "showTemperature": true,
          "showHumidity": true,
          "showAirQuality": true
        }
      ],

      "powerStrips": [
        {
          "name": "거실 멀티탭",
          "ip": "192.168.1.52",
          "token": "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
          "protocolMode": "auto"
        }
      ],

      "airMonitors": [
        {
          "name": "거실 공기측정기",
          "ip": "192.168.1.53",
          "token": "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
          "deviceId": "123456789"
        }
      ],

      "humidifiers": [
        {
          "name": "침실 가습기",
          "ip": "192.168.1.54",
          "token": "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
          "model": "zhimi.humidifier.ca4",
          "enableTemperatureSensor": true,
          "enableBuzzerSwitch": true
        }
      ]
    }
  ]
}
```

자세한 옵션은 Homebridge UI 의 설정 화면(`config.schema.json`) 또는 [config 예시](#설정-필드-요약) 를 참고하세요.

## 토큰 추출

각 디바이스의 32자리 hex 토큰이 필요합니다. 다음 도구 중 하나를 사용하세요.

- [Xiaomi Cloud Tokens Extractor](https://github.com/PiotrMachowski/Xiaomi-cloud-tokens-extractor)
- [homebridge-miot](https://github.com/merdok/homebridge-miot) (자동 탐지)

## 주요 개선점 (개별 플러그인 대비)

본 통합 플러그인은 기존에 분리되어 있던 5개의 별도 플러그인을 합치면서 다음과 같은 안정성 개선을 적용했습니다.

### Air Purifier
- **Command grace period** 도입. `set_power` 직후 폴링이 펌웨어가 아직 상태 전이가 끝나지 않은 값을 받아 홈킷 아이콘이 "켜짐 → 잠깐 꺼짐 → 다시 켜짐" 으로 깜빡이던 race condition을 제거했습니다. 선풍기에 적용했던 `refreshDelay 1000ms` 와 유사한 사상이지만, 폴링값과 목표값을 짧은 보호 구간 동안 비교하는 방식으로 일반화했습니다.
- 보호 구간 중 300/900/1700ms 시점에 burst 폴링을 수행해, 실제 상태가 목표에 도달하는 즉시 보호 구간을 해제합니다.

### Power Strip
- 폴링 시 `device === null` 이면 조용히 종료하던 버그를 수정. 기존엔 한 번 연결이 끊기면 폴링이 자가 회복하지 못해 "되다가 안 되다가" 현상이 발생했습니다.
- `setInterval` → `setTimeout` 루프로 변경. setInterval 은 try/catch 실패 후에도 동일 주기로 계속 발화돼 백오프 및 재연결 흐름과 충돌하지만, setTimeout 루프는 매 tick 의 결과에 따라 다음 시점을 다시 잡습니다.
- 연속 폴링 실패 카운터(`POLL_FAIL_THRESHOLD = 3`). 임계치 도달 시 device 인스턴스를 파괴하고 처음부터 재핸드셰이크합니다.
- 첫 연결 실패도 지수 백오프(1.5s → 60s) 로 재시도. 기존 30초 고정에 비해 깜빡임 회복이 빠릅니다.
- `shutdown` 핸들러에서 burst / poll / reconnect 타이머를 모두 정리.

### Humidifier
- nt0xa/homebridge-mi-humidifier 의 모델 정의(zhimi/deerma/shuii 12종) 를 JS 로 포팅.
- 다른 카테고리와 동일한 `miio` 패키지 사용 (원본은 `miio-api`).
- Air Purifier 와 동일한 낙관적 UI 업데이트 + Command Grace 패턴 적용.
- 자동 재연결 (지수 백오프, 연속 실패 임계치), `setTimeout` 폴링 루프.
- `enableXxx` 옵션으로 부저/LED/온도/별도 습도/청소 모드 스위치 노출 가능.

### Fan / Air Monitor
- 동작은 기존과 동일. 단지 통합 플랫폼 안에서 동일 패턴으로 캐시 액세서리를 관리합니다.

## NPM 자동 publish (GitHub Actions)

`main` 브랜치 보호와 무관하게 NPM 으로 새 버전을 publish 하려면:

1. Repository → Settings → Secrets and variables → Actions 에 `NPM_TOKEN` 추가 (Automation 또는 Publish 토큰).
2. GitHub Actions 탭 → **Publish to npm** 워크플로 선택 → **Run workflow** 클릭 → patch / minor / major 선택.
   - 워크플로가 자동으로 `npm version <type>` 으로 `package.json` 버전을 올리고, `vX.Y.Z` 태그를 만들어 push 한 뒤 `npm publish` 합니다.
3. 또는 로컬에서 `npm version patch && git push --follow-tags` 만 해도, tag push 트리거로 자동 publish 됩니다.

## 라이선스

MIT. 본 플러그인은 다음의 코드를 일부 차용/참고하고 있습니다:
- `homebridge-xiaomi-fan` (MIT)
- `homebridge-miot` (MIT) — miio low-level 프로토콜
- `homebridge-mi-humidifier` (MIT) — 가습기 모델 정의

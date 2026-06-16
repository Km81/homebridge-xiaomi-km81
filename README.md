# homebridge-xiaomi-km81

Xiaomi 5종(선풍기 / 공기청정기 / 멀티탭 / 공기측정기 / 가습기)을 하나의 Homebridge platform 으로 통합한 플러그인입니다. Homebridge 2.0 호환.

| 카테고리       | 지원 디바이스                                              |
|----------------|------------------------------------------------------------|
| Fan            | Smartmi / Mija / Dmaker 시리즈 (zhimi.fan.*, dmaker.fan.*), Xiaomi Smart Tower Fan 2 (xiaomi.fan.p45) |
| Air Purifier   | Mi Air Purifier 2S, Pro                                    |
| Power Strip    | Mi Power Strip / Smart Plug (miot · legacy 자동 감지, 구형 zimi/qmi 멀티탭은 Legacy 권장) |
| Air Monitor    | Qingping Air Monitor 2 (cgllc.airm.cgs2)                   |
| Humidifier     | Zhimi / Deerma / Shuii 시리즈 (12종 모델)                  |

## 설치

```bash
npm i -g homebridge-xiaomi-km81
```

또는 Homebridge UI 에서 `homebridge-xiaomi-km81` 검색.

## 설정

### 권장: Homebridge UI

1. Homebridge UI → Plugins → `homebridge-xiaomi-km81` → **Settings**
2. **장치 추가** 버튼 클릭
3. **장치 종류** 드롭다운에서 선풍기 / 공기청정기 / 멀티탭 / 공기측정기 / 가습기 중 선택
4. 선택한 종류에 맞는 설정 항목만 동적으로 표시됩니다 (예: 가습기를 고르면 12개 모델 enum + 가습기 전용 옵션만 노출)
5. 이름 / IP / 토큰 입력 후 저장

### config.json 직접 편집 (v1.1+ 통합 형식 권장)

`platforms` 배열에 다음과 같이 단일 `devices` 배열을 추가합니다. `deviceType` 으로 종류를 구분합니다.

```jsonc
{
  "platforms": [
    {
      "platform": "XiaomiKm81",
      "name": "Xiaomi KM81",
      "devices": [
        {
          "deviceType": "fan",
          "name": "거실 선풍기",
          "ip": "192.168.1.50",
          "token": "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
          "model": "dmaker.fan.p11",
          "deviceId": "123456789"
        },
        {
          "deviceType": "airPurifier",
          "name": "안방 공기청정기",
          "ip": "192.168.1.51",
          "token": "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
          "airPurifierType": "MiAirPurifier2S",
          "showTemperature": true,
          "showHumidity": true,
          "showAirQuality": true
        },
        {
          "deviceType": "powerStrip",
          "name": "거실 멀티탭",
          "ip": "192.168.1.52",
          "token": "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
          "protocolMode": "auto"
        },
        {
          "deviceType": "airMonitor",
          "name": "거실 공기측정기",
          "ip": "192.168.1.53",
          "token": "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
          "deviceId": "123456789"
        },
        {
          "deviceType": "humidifier",
          "name": "침실 가습기",
          "ip": "192.168.1.54",
          "token": "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
          "humidifierModel": "zhimi.humidifier.ca4",
          "enableTemperatureSensor": true,
          "enableBuzzerSwitch": true
        }
      ]
    }
  ]
}
```

### 레거시 형식 (v1.0 호환)

기존 `fans`/`airPurifiers`/`powerStrips`/`airMonitors`/`humidifiers` 배열 형식도 그대로 지원합니다. 통합 `devices` 배열과 함께 사용해도 OK.

### 선풍기 회전 각도 전구 (angleLightbulb)

선풍기 회전 각도를 **전구(밝기 슬라이더) 하나**로 제어할 수 있습니다. 선풍기 항목에 `"angleLightbulb": true` 를 추가하세요.

- 전구 On/Off = 회전(스윙) On/Off, 밝기(1~100%) = 회전 각도
- 밝기는 모델이 지원하는 각도 단계로 자동 스냅 (예: 1~30→30°, 31~60→60°, 61~90→90°, 91~100→최대각)
- HomeKit 밝기는 0~100 범위라 100°를 넘는 각도(120/150°)는 밝기 100%로 표시됩니다
- `angleLightbulbLevels` 로 사용할 각도 단계를 직접 지정 가능 (미지정 시 모델 기본값). 100°를 넘는 단계가 여러 개면 가장 큰 값 하나만 사용됩니다 (예: 30/60/90/120/150 → 30/60/90/150)
- 기존 각도 버튼(`angleButtons`)과 동시에 사용 가능

### 신형 miot 기기 로컬 연결 자동 복구 (xiaomi.fan.p45 등)

`xiaomi.fan.p45`(스마트 타워팬2) 같은 신형 기기에서 "응답 없음"이 뜨던 근본 원인은 aholstenson `miio` 패키지가 핸드셰이크/server-stamp 를 객체 수명 동안 캐시하기 때문이었습니다. Mi Home 앱이 기기의 단일 로컬 세션을 가져가면 캐시된 stamp 가 죽어 이후 모든 호출이 타임아웃되고, **Homebridge 프로세스를 재시작해야만** 복구되었습니다.

v1.2+ 부터 miot 선풍기는 `miio` 패키지 대신 **dgram 기반 로컬 프로토콜**(공기측정기와 동일)로 제어합니다. 재연결할 때마다 새 소켓으로 재핸드셰이크하므로, 세션이 꼬여도 폴링 한 번 실패 후 **자동으로 재연결·복구**됩니다(프로세스 재시작 불필요). 레거시 miio 프로토콜 선풍기(zhimi.fan.v2/v3/sa1/za1/za3/za4, dmaker.fan.p5)는 기존 `miio` 패키지를 그대로 사용합니다.

> 따라서 대부분의 경우 아래 MiCloud(클라우드) 설정 없이 **로컬로 안정적으로** 동작합니다. 클라우드는 로컬이 원천적으로 차단된 환경에서의 선택적 폴백입니다.

### MiCloud (클라우드 제어) — 로컬이 불안정한 기기용 (선택)

일부 신형 기기는 로컬 세션을 한 번에 하나만 허용해, 기기의 클라우드 링크나 Mi Home 앱이 그 세션을 가져가면 홈브릿지가 수 분~십수 분간 끊깁니다(앱·클라우드는 정상). 이런 기기는 **클라우드로 제어**하면 로컬 세션 경합의 영향을 받지 않습니다.

선풍기는 **세 가지 모드** 중 선택할 수 있습니다 (기기별):

| 모드 | 설정 | 동작 |
|------|------|------|
| 로컬 전용 (기본) | (없음) | 항상 로컬. 가장 빠름 |
| **하이브리드** (권장) | `"cloudFallback": true` | 로컬 우선, 로컬이 연속 실패하면 그 기기만 자동으로 클라우드로 전환하고(약 15~30초) 복구되면 다시 로컬로 복귀. 속도와 안정성을 모두 확보 |
| 클라우드 전용 | `"forceMiCloud": true` | 항상 클라우드. 로컬을 아예 쓰지 않음 |

설정 방법:

1. 최상위(platform)에 `micloud` 계정 정보를 추가:
   ```jsonc
   "micloud": { "username": "Mi 계정", "password": "비밀번호", "country": "cn" }
   ```
   - `country`: 계정 기본 지역. 한국 사용자는 보통 `cn` 또는 `sg`.
2. 해당 선풍기 항목에 `"cloudFallback": true`(권장) 또는 `"forceMiCloud": true` 와 `model`·`deviceId` 지정.
3. **기기마다 지역이 다르면** 그 기기 항목에 `"miCloudCountry": "tw"` 처럼 지역을 따로 지정하세요. (예: 대부분 기기는 `cn`인데 타워팬만 `tw`인 경우.) 지원 지역: `cn, sg, de, us, ru, tw, in, i2`. 비우면 위 기본 지역 사용.
   ```jsonc
   {
     "deviceType": "fan", "name": "거실 타워팬",
     "model": "xiaomi.fan.p45", "deviceId": "1234567890",
     "ip": "192.168.1.105", "token": "....",
     "cloudFallback": true, "miCloudCountry": "tw"
   }
   ```

주의:
- **2단계 인증(2FA)이 켜진 계정**(샤오미가 일부 지역에 강제 적용)은 config 의 ID/PW만으로 로그인이 안 됩니다. 가장 쉬운 방법은 **Homebridge UI 설정 화면**입니다 — 플러그인 **Settings** 를 열면 상단에 **"MiCloud 클라우드 세션 (2단계 인증)"** 패널이 있습니다. **계정·비밀번호**만 넣고 **로그인**(로그인은 지역과 무관합니다) → 2FA가 필요하면 인증 URL이 표시되니 브라우저에서 열어 코드를 받고 **인증코드 제출** 하면 세션이 자동 저장됩니다(비밀번호는 저장되지 않음). 저장 후 **Homebridge 재시작**하면 적용됩니다. 기기별 지역은 같은 화면의 **"기기 검출"** 로 확인해 각 기기의 `miCloudCountry` 에 지정하세요.
- 로그인 후, 같은 화면의 **"등록된 기기 검출"** 패널에서 계정에 등록된 기기들의 **IP·토큰·모델·Device ID 와 등록된 지역(서버)**을 한 번에 찾을 수 있습니다(여러 지역을 조회). 자동 등록은 하지 않으며, 값을 복사해 장치 설정에 직접 넣으면 됩니다 — `miCloudCountry` 에 넣을 지역도 여기서 확인됩니다.
- 터미널을 선호하면 동일한 (로그인) 작업을 CLI 로도 할 수 있습니다 (Homebridge 호스트에서):
  ```bash
  node tools/micloud-login.js --country tw --out <storage>/xiaomi-km81-micloud-session.json
  ```
  세션 파일(`xiaomi-km81-micloud-session.json`)을 Homebridge storage 폴더에 두면 플러그인이 자동으로 읽습니다(재시작해도 유지). 세션 만료 시 다시 만드세요. (또는 출력된 JSON을 config 의 `micloud.serviceToken` 에 넣어도 됩니다.)
- 비2FA 계정은 config 의 username/password 로 로그인하며, 성공한 세션을 자동으로 위 캐시 파일에 저장합니다.
- 비밀번호가 config.json에 평문 저장되니 유의하세요.
- 로컬이 안정적인 기기는 켤 필요 없습니다(로컬이 더 빠름).

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

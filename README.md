# homebridge-xiaomi-km81

Xiaomi 5종(선풍기 / 공기청정기 / 멀티탭 / 공기측정기 / 가습기)을 하나의 Homebridge 플랫폼으로 통합한 플러그인. Homebridge 2.0 호환.

## 특징

- **로컬 제어 우선** — 모든 기기를 로컬(UDP miio/miot)로 제어. 클라우드는 선택적 폴백.
- **자동 복구** — dgram 기반 전송 계층으로 Wi-Fi 순단·세션 꼬임에서 프로세스 재시작 없이 자동 재연결.
- **명령 grace + verify burst** — 명령 직후 UI 깜빡임 없음 (낙관 업데이트 + 반영 확인 폴링).
- **슬라이더 디바운스** — 속도 슬라이더는 손을 뗀 마지막 값만 기기로 전송.
- 선풍기 **하이브리드 모드** — 로컬 연속 실패 시 그 기기만 클라우드로 자동 전환, 복구되면 로컬 복귀.
- 공기청정기 **keepFavoriteMode**(선택) — 기기·타 앱이 자동/수면으로 바꿔도 선호(favorite) 모드로 자동 복귀.

## 지원 기기

| 카테고리 | 지원 디바이스 |
|---|---|
| Fan | Smartmi / Mija / Dmaker 시리즈 (zhimi.fan.*, dmaker.fan.*), Xiaomi Smart Tower Fan 2 (xiaomi.fan.p45) |
| Air Purifier | Mi Air Purifier 2S, Pro |
| Power Strip | Mi Power Strip / Smart Plug (miot·legacy 자동 감지, 구형 zimi/qmi는 legacy 권장) |
| Air Monitor | Qingping Air Monitor 2 (cgllc.airm.cgs2) |
| Humidifier | Zhimi / Deerma / Shuii 시리즈 (12종 모델) |

## 설치

```bash
npm i -g homebridge-xiaomi-km81
```

또는 Homebridge UI에서 `homebridge-xiaomi-km81` 검색.

## 설정

### 권장: Homebridge UI

1. Homebridge UI → Plugins → `homebridge-xiaomi-km81` → **Settings**
2. **장치 추가** → **장치 종류** 선택 (선풍기/공기청정기/멀티탭/공기측정기/가습기)
3. 선택한 종류에 맞는 설정 항목만 동적으로 표시됩니다
4. 이름 / IP / 토큰 입력 후 저장

### config.json 직접 편집

`platforms` 배열에 단일 `devices` 배열을 추가하고 `deviceType`으로 종류를 구분합니다.

```jsonc
{
  "platforms": [
    {
      "platform": "XiaomiKm81",
      "name": "Xiaomi KM81",
      "devices": [
        { "deviceType": "fan",         "name": "선풍기",     "ip": "192.168.0.10", "token": "<32자리 hex>", "model": "dmaker.fan.p11", "deviceId": "123456789" },
        { "deviceType": "airPurifier", "name": "공기청정기", "ip": "192.168.0.11", "token": "<32자리 hex>", "showTemperature": true, "showHumidity": true, "showAirQuality": true },
        { "deviceType": "powerStrip",  "name": "멀티탭",     "ip": "192.168.0.12", "token": "<32자리 hex>", "protocolMode": "auto" },
        { "deviceType": "airMonitor",  "name": "공기측정기", "ip": "192.168.0.13", "token": "<32자리 hex>", "deviceId": "123456789" },
        { "deviceType": "humidifier",  "name": "가습기",     "ip": "192.168.0.14", "token": "<32자리 hex>", "humidifierModel": "zhimi.humidifier.ca4" }
      ]
    }
  ]
}
```

레거시 형식(`fans`/`airPurifiers`/… 배열, v1.0)도 그대로 지원하며 통합 `devices` 배열과 함께 써도 됩니다.

## 카테고리별 주요 옵션

### 선풍기

- `angleButtons` / `verticalAngleButtons` — 회전 각도 버튼
- `angleLightbulb` — 회전 각도를 **전구(밝기 슬라이더) 하나**로 제어: On/Off=회전 On/Off, 밝기=각도(모델 단계로 자동 스냅, 100° 초과 단계는 밝기 100%로 표시). `angleLightbulbLevels`로 단계 직접 지정 가능. 각도 버튼과 병행 가능
- `cloudFallback`(하이브리드) / `forceMiCloud`(클라우드 전용) / `miCloudCountry`(기기별 지역)
- 기타: `buzzerControl`, `ledControl`, `naturalModeControl`, `sleepModeControl`, `moveControl`, `shutdownTimer`, `ioniserControl`, `fanLevelControl`, `deepDebugLog`

### 공기청정기

- 센서 표시: `showTemperature` / `showHumidity` / `showAirQuality` (+`separate…Accessory`, `…Name`)
- 스위치: `showLED` / `showBuzzer` / `showAutoModeSwitch` / `showSleepModeSwitch` / `showFavoriteModeSwitch`
- AQI 임계: `aqExcellent` / `aqGood` / `aqFair` / `aqInferior` (기본 5/15/35/55 μg/m³)
- `keepFavoriteMode` — 기기 내장 로직(공기질 개선 시 자동 모드 복귀)·타 앱이 모드를 바꿔도 폴링에서 감지해 선호 모드로 자동 복귀. 홈 앱에서 직접 바꾼 모드는 존중하며, 전원을 켤 때 iOS가 동반 전송하는 자동 전환 요청은 차단
- 속도 표시: 선호 모드 = 실제 단수 %, 자동 모드 = 표시용 40%, 그 외 = 0%

### 멀티탭 / 가습기 / 공기측정기

- 멀티탭: `protocolMode`(auto/miot/legacy — auto는 legacy가 실제 성공할 때만 확정)
- 가습기: 모델별 부저/LED/온습도 센서 옵션 (`enable…`)
- 공기측정기: 센서별 노출 옵션 (`enableAirQualitySensor` / `enableTemperatureSensor` / `enableHumiditySensor` / `enableCarbonDioxideSensor`)

## MiCloud (클라우드 제어) — 선택

일부 신형 기기는 로컬 세션을 하나만 허용해, Mi Home 앱이 세션을 가져가면 로컬 제어가 수 분간 끊길 수 있습니다. 이런 기기만 클라우드/하이브리드를 켜세요. 로컬이 안정적인 기기는 켤 필요 없습니다(로컬이 더 빠름).

| 모드 | 설정 | 동작 |
|---|---|---|
| 로컬 전용 (기본) | (없음) | 항상 로컬 — 가장 빠름 |
| 하이브리드 (권장) | `"cloudFallback": true` | 로컬 우선, 연속 실패 시 그 기기만 클라우드 전환 후 자동 복귀 |
| 클라우드 전용 | `"forceMiCloud": true` | 항상 클라우드 |

1. 플랫폼에 `micloud` 계정 추가: `"micloud": { "username": "...", "password": "...", "country": "cn" }`
2. 해당 기기 항목에 `cloudFallback`(또는 `forceMiCloud`) + `model`·`deviceId` 지정
3. 기기마다 등록 지역이 다르면 기기 항목에 `"miCloudCountry": "sg"` 처럼 개별 지정 (지원: cn, sg, de, us, ru, tw, in, i2 — 비우면 계정 기본 지역)

**2FA 계정**: config의 ID/PW만으로는 로그인되지 않습니다. Homebridge UI → 플러그인 **Settings** 상단 **MiCloud 클라우드 세션** 패널에서 로그인 → 2FA 인증 → 세션 자동 저장(비밀번호 미저장) → Homebridge 재시작. 같은 화면의 **등록된 기기 검출** 패널에서 계정에 등록된 기기들의 IP·토큰·모델·Device ID·지역을 한 번에 확인할 수 있습니다.

CLI 대안: `node tools/micloud-login.js --country <cc> --out <storage>/xiaomi-km81-micloud-session.json` — 세션 파일을 Homebridge storage 폴더에 두면 자동 인식.

> 비밀번호를 config.json에 넣는 경우 평문 저장에 유의하세요.

## 토큰 추출

각 기기의 32자리 hex 토큰이 필요합니다:
- [Xiaomi Cloud Tokens Extractor](https://github.com/PiotrMachowski/Xiaomi-cloud-tokens-extractor)
- 또는 위 MiCloud 로그인 후 **등록된 기기 검출** 패널 사용

## 동작 방식 (기술 노트)

- **dgram 전송 계층**: aholstenson `miio`는 전역 싱글톤 소켓·기기 캐시가 죽은 세션(만료된 server-stamp)을 재사용해, Wi-Fi가 복구돼도 프로세스 재시작 전까지 제어가 안 되는 문제가 있었습니다. 본 플러그인은 기기마다 독립 소켓 + 재연결마다 새 핸드셰이크로 이를 해결했습니다 (miot 선풍기·공기청정기·멀티탭·가습기 적용, 레거시 miio 선풍기는 기존 패키지 유지).
- **폴링 루프**: `setInterval`이 아닌 `setTimeout` 루프 + `finally` 재무장 — 실패해도 루프가 죽지 않고 백오프·재연결 흐름과 충돌하지 않습니다.
- **명령 grace**: set 직후 짧은 보호 구간 동안 낙관값을 유지하고 300/900/1700ms 버스트 폴링으로 실제 반영을 확인 — 전원/모드 아이콘이 "켜짐→잠깐 꺼짐→켜짐"으로 깜빡이는 race를 제거했습니다.
- 선풍기 하이브리드: 로컬 3연속 실패 → 클라우드 전환 → 5분마다 로컬 재탐색 → 복구 시 로컬 복귀. 로컬·클라우드 모두 장시간 실패할 때만 전체 재초기화(백스톱).

## 릴리스 (개발자용)

`.github/workflows/publish.yml` — `v*` 태그 push 또는 workflow_dispatch로 npm 배포(`NPM_TOKEN` 시크릿 필요).
**`package.json`의 version이 곧 배포 버전** — 버전을 올리지 않고 publish하면 403(중복)으로 실패합니다.
변경 이력은 GitHub 커밋/태그를 참조하세요.

## 라이선스

MIT. 다음 프로젝트의 코드를 일부 차용/참고했습니다:
- `homebridge-xiaomi-fan` (MIT)
- `homebridge-miot` (MIT) — miio low-level 프로토콜
- `homebridge-mi-humidifier` (MIT) — 가습기 모델 정의

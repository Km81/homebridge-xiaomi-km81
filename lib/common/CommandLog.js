'use strict';

/*
 * CommandLog — 명령 실행 info 로그의 한국어 표기 사전 (v2.2.2)
 *
 * 배경: v2.2.1까지 성공한 명령은 debug 로만 남아 기본 로그 레벨에서 아무것도 안 보였다
 * (실패만 warn). 스마트싱스 플러그인 v2.1.x가 확립한 스타일(`[기기] 전원 → 꺼짐`)과
 * 맞추기 위해, 각 전송 지점이 이 사전으로 한국어 한 줄을 만들어 info 로 남긴다.
 *
 * 규약 (Projects/homebridge-공통-로그스타일.md):
 *  - 반환값이 문자열이면 호출부가 `[기기명] <문자열>` 로 info 출력.
 *  - 반환값이 null 이면 "표기 모름" → 호출부는 기존 debug 만 유지한다.
 *    (영문 식별자·원시값을 info 에 노출하지 않기 위한 안전장치 — 모르는 명령은 침묵)
 *  - 불리언은 켜짐/꺼짐, 방향 화살표는 전각 →, 상세는 괄호.
 */

const onOff = (v) => (v === true || v === 'on' || v === 1 ? '켜짐' : '꺼짐');

// ── miio 원시 명령 → 표기. Smartmi(zhimi.fan.*) + Dmaker P5(s_*/m_*) 겸용. ──
const MIIO = {
  // Smartmi (MiioSmartmiFan)
  set_power:         (v) => `전원 → ${onOff(v)}`,
  set_speed_level:   (v) => `풍량 → ${v}%`,
  set_natural_level: (v) => `자연풍 풍량 → 기기값 ${v}`, // 보통 상위 계층이 미리 로그(quietInfo) — 안전망 표기
  set_child_lock:    (v) => `물리 잠금 → ${onOff(v)}`,
  set_angle_enable:  (v) => `회전 → ${onOff(v)}`,
  set_angle:         (v) => `회전 각도 → ${v}°`,
  set_move:          (v) => `이동 → ${v === 'left' ? '왼쪽' : '오른쪽'}`,
  set_buzzer:        (v) => (Number(v) > 0 ? `알림음 → 켜짐 (단계 ${v})` : '알림음 → 꺼짐'),
  set_led_b:         (v) => (Number(v) >= 2 ? '조명 → 꺼짐' : (Number(v) === 1 ? '조명 → 켜짐 (어둡게)' : '조명 → 켜짐 (밝게)')),
  set_poweroff_time: (v) => (Number(v) > 0 ? `꺼짐 타이머 → ${Math.round(Number(v) / 60)}분` : '꺼짐 타이머 → 해제'), // 값은 초 단위
  // Dmaker P5 (MiioDmakerFanP5)
  s_power: (v) => `전원 → ${onOff(v)}`,
  s_speed: (v) => `풍량 → ${v}%`,
  s_lock:  (v) => `물리 잠금 → ${onOff(v)}`,
  s_roll:  (v) => `회전 → ${onOff(v)}`,
  s_angle: (v) => `회전 각도 → ${v}°`,
  s_mode:  (v) => `모드 → ${v === 'nature' ? '자연풍' : '일반풍'}`,
  m_roll:  (v) => `이동 → ${v === 'left' ? '왼쪽' : '오른쪽'}`,
  s_sound: (v) => `알림음 → ${onOff(v)}`,
  s_light: (v) => `조명 → ${onOff(v)}`,
};

// ── miot 속성/명령 → 표기 (fan 계열 공통 이름) ──
const MIOT = {
  power:               (v) => `전원 → ${onOff(v)}`,
  fan_speed:           (v) => `풍량 → ${v}%`,
  fan_level:           (v) => `바람 단계 → ${v}단계`,
  swing_mode:          (v) => `회전 → ${onOff(v)}`,
  swing_mode_angle:    (v) => `회전 각도 → ${v}°`,
  swing_mode_vertical: (v) => `상하 회전 → ${onOff(v)}`,
  child_lock:          (v) => `물리 잠금 → ${onOff(v)}`,
  buzzer:              (v) => `알림음 → ${onOff(v)}`,
  light:               (v) => `조명 → ${onOff(v)}`,
  power_off_time:      (v) => (Number(v) > 0 ? `꺼짐 타이머 → ${v}분` : '꺼짐 타이머 → 해제'), // 값은 분 단위
  move_left:           () => '이동 → 왼쪽',
  move_right:          () => '이동 → 오른쪽',
  // delay_enabled: 의도적 미등록 — p45 setShutdownTimer 가 power_off_time 과 한 동작에서
  //                두 번 setProperty 하므로, 등록하면 같은 동작에 info 두 줄이 찍힌다.
  // mode: 의도적 미등록 — 값의 의미가 모델마다 다르다(p45: 0직풍/1자연풍/2수면, Dmaker AC: 0일반/1수면 …).
  //       기기 클래스가 _miotValueLabel(prop, value) 로 한국어 라벨을 제공할 때만 info 로 표기.
};

function fmtMiio(cmd, value) {
  const f = MIIO[cmd];
  return f ? f(value) : null;
}

function fmtMiot(prop, value, valueLabel) {
  if (prop === 'mode') return valueLabel ? `모드 → ${valueLabel}` : null;
  const f = MIOT[prop];
  return f ? f(value) : null;
}

// ── 공기청정기(miio) — call('set_xxx', [args]) 형태 ──
// 모드 번역(2026-07-30 사용자 확정): auto=자동 / silent=취침 / favorite=수동.
// favorite 는 프로토콜 원어일 뿐 실동작이 "사용자 지정 고정 풍량" = 수동 모드다.
const PURIFIER_MODE = { auto: '자동', silent: '취침', favorite: '수동', idle: '대기', low: '약', medium: '중', high: '강' };

function purifierModeLabel(v) { return PURIFIER_MODE[v] || null; }

function fmtPurifier(method, args) {
  const v = Array.isArray(args) ? args[0] : args;
  switch (method) {
    case 'set_power':          return `전원 → ${onOff(v)}`;
    case 'set_mode':           return `모드 → ${PURIFIER_MODE[v] || v}`;
    case 'set_level_favorite': return `수동 풍량 → ${v}/16단계`;
    case 'set_led':            return `조명 → ${onOff(v)}`;
    case 'set_led_b':          return MIIO.set_led_b(v);
    case 'set_buzzer':         return `알림음 → ${onOff(v)}`;
    default:                   return null; // get_* 및 미등록 set 명령은 침묵(기존 debug 유지)
  }
}

module.exports = { fmtMiio, fmtMiot, fmtPurifier, purifierModeLabel, onOff };

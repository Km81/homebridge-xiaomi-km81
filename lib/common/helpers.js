/**
 * 공통 헬퍼 함수.
 */

'use strict';

function clamp(n, lo, hi, dflt) {
  const v = Number(n);
  if (!Number.isFinite(v)) return (dflt !== undefined) ? dflt : lo;
  if (v < lo) return lo;
  if (v > hi) return hi;
  return v;
}

function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// promise 가 ms 안에 settle 하지 않으면 reject 한다. miio 호출이 reject 없이 무한
// 대기(hang)하면 폴링/재연결 루프가 영영 멈춰 "재부팅해야 복구" 증상이 생기므로,
// 모든 네트워크 호출을 이 래퍼로 감싸 hang 을 reject 로 전환한다.
function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout: ${label || 'operation'} (${ms}ms)`)), ms);
    promise.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); }
    );
  });
}

function capitalize(s) {
  const t = String(s || '');
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/**
 * 서비스의 Name / ConfiguredName characteristic을 안전하게 설정한다.
 * - Name : 매번 plugin 기본값으로 설정 (HomeKit fallback)
 * - ConfiguredName : 처음 한 번만 기본값으로 설정 (사용자 변경값 보존)
 *
 * Homebridge 2.0에서 testCharacteristic / addCharacteristic 호출 시
 * 일부 서비스 타입에서 워닝이 발생할 수 있어 try/catch로 감싼다.
 */
function applyServiceName(Characteristic, service, displayName) {
  try {
    service.setCharacteristic(Characteristic.Name, displayName);
  } catch (_) {}
  try {
    if (typeof service.testCharacteristic === 'function' &&
        !service.testCharacteristic(Characteristic.ConfiguredName)) {
      service.addCharacteristic(Characteristic.ConfiguredName);
      service.setCharacteristic(Characteristic.ConfiguredName, displayName);
    }
  } catch (_) {}
}

/**
 * '24fa...32hex' 형식 토큰인지 검증 (32자리 hex).
 */
function isValidToken(token) {
  return typeof token === 'string' && /^[A-Fa-f0-9]{32}$/.test(token);
}

/**
 * IPv4 형식 검증 (간단한 검증).
 */
function isValidIp(ip) {
  if (typeof ip !== 'string') return false;
  const parts = ip.split('.');
  if (parts.length !== 4) return false;
  return parts.every(p => /^\d+$/.test(p) && Number(p) >= 0 && Number(p) <= 255);
}

/**
 * config에서 ip/token 검증. 실패 시 에러 throw.
 */
function requireValidIpAndToken(cfg, label) {
  if (!cfg.ip || !isValidIp(cfg.ip)) {
    throw new Error(`${label}: ip가 누락되었거나 유효하지 않습니다: '${cfg.ip}'`);
  }
  if (!cfg.token || !isValidToken(cfg.token)) {
    throw new Error(`${label}: token이 누락되었거나 유효하지 않습니다 (32자리 hex)`);
  }
}

module.exports = {
  clamp,
  isFiniteNumber,
  sleep,
  withTimeout,
  capitalize,
  applyServiceName,
  isValidToken,
  isValidIp,
  requireValidIpAndToken,
};

/**
 * Humidifier 모델별 설정 (nt0xa/homebridge-mi-humidifier 참고).
 *
 * 각 모델은 다음 정보를 가진다:
 *   protocol           : 'miio' 또는 'miot'
 *   propsMiot          : { propKey: { siid, piid } } - miot 모델 전용
 *   propsMiio          : [propKey,...]              - miio 모델 전용 (get_prop 응답 순서)
 *   setCalls           : 각 propKey 별 set 함수명 (miot은 모두 'set_properties')
 *   power              : { onValue, offValue, key }
 *   mode               : { key, values:[low/medium/high/auto 순] }    // 회전속도용
 *   humidity           : { key }                                       // 현재 습도
 *   temperature        : { key, scale }                                // °C 환산 계수 (1 또는 0.1)
 *   targetHumidity     : { key, call, min, max, switchToMode? }
 *   waterLevel         : { key, mapFn } - 옵션
 *   childLock          : { key, on, off, call }
 *   buzzer             : { key, on, off, call }                       // 부저 스위치
 *   led                : { key, levels, on, off, call }                // LED Lightbulb 또는 Switch
 *   dry                : { key, on, off, call }                       // SwingMode 토글
 *   clean              : { key, on, off, call }                       // Clean Mode 스위치
 *
 * mode.values 배열은 HomeKit 회전속도 1..N 에 매핑된다 (1=가장 약함, N=가장 강함).
 */

'use strict';

// ========================= 모델 정의 =========================

const MODELS = {
  // ----- Zhimi (Smartmi) -----
  'zhimi.humidifier.v1': {
    protocol: 'miio',
    propsMiio: ['power', 'mode', 'humidity', 'child_lock', 'led_b', 'buzzer', 'temp_dec', 'limit_hum'],
    setCalls: {
      power: 'set_power', mode: 'set_mode', child_lock: 'set_child_lock',
      led_b: 'set_led_b', buzzer: 'set_buzzer', limit_hum: 'set_limit_hum',
    },
    power: { key: 'power', on: 'on', off: 'off', call: 'set_power' },
    mode:  { key: 'mode', values: ['silent', 'medium', 'high'], call: 'set_mode' },
    humidity: { key: 'humidity' },
    temperature: { key: 'temp_dec', scale: 0.1 },
    targetHumidity: { key: 'limit_hum', call: 'set_limit_hum', min: 30, max: 80 },
    childLock: { key: 'child_lock', on: 'on', off: 'off', call: 'set_child_lock' },
    buzzer:    { key: 'buzzer', on: 'on', off: 'off', call: 'set_buzzer' },
    // led_b 값: 0=Bright, 1=Dim, 2=Off
    led: { key: 'led_b', levels: [2, 1, 0], on: 1, off: 2, call: 'set_led_b', toString: true },
  },

  'zhimi.humidifier.ca1': {
    protocol: 'miio',
    propsMiio: ['power', 'mode', 'humidity', 'child_lock', 'led_b', 'buzzer', 'depth', 'dry', 'temp_dec', 'limit_hum'],
    setCalls: {
      power: 'set_power', mode: 'set_mode', child_lock: 'set_child_lock',
      led_b: 'set_led_b', buzzer: 'set_buzzer', dry: 'set_dry', limit_hum: 'set_limit_hum',
    },
    power: { key: 'power', on: 'on', off: 'off', call: 'set_power' },
    mode:  { key: 'mode', values: ['silent', 'medium', 'high', 'auto'], call: 'set_mode' },
    humidity: { key: 'humidity' },
    temperature: { key: 'temp_dec', scale: 0.1 },
    targetHumidity: { key: 'limit_hum', call: 'set_limit_hum', min: 30, max: 80,
      switchToMode: { key: 'mode', call: 'set_mode', value: 'auto' } },
    waterLevel: { key: 'depth', mapFn: (v) => Math.min(v / 1.2, 100) },
    childLock: { key: 'child_lock', on: 'on', off: 'off', call: 'set_child_lock' },
    buzzer:    { key: 'buzzer', on: 'on', off: 'off', call: 'set_buzzer' },
    dry:       { key: 'dry', on: 'on', off: 'off', call: 'set_dry' },
    led: { key: 'led_b', levels: [2, 1, 0], on: 1, off: 2, call: 'set_led_b', toString: true },
  },

  'zhimi.humidifier.cb1': {
    protocol: 'miio',
    propsMiio: ['power', 'mode', 'humidity', 'child_lock', 'led_b', 'buzzer', 'depth', 'dry', 'temperature', 'limit_hum'],
    setCalls: {
      power: 'set_power', mode: 'set_mode', child_lock: 'set_child_lock',
      led_b: 'set_led_b', buzzer: 'set_buzzer', dry: 'set_dry', limit_hum: 'set_limit_hum',
    },
    power: { key: 'power', on: 'on', off: 'off', call: 'set_power' },
    mode:  { key: 'mode', values: ['silent', 'medium', 'high', 'auto'], call: 'set_mode' },
    humidity: { key: 'humidity' },
    temperature: { key: 'temperature', scale: 1 },
    targetHumidity: { key: 'limit_hum', call: 'set_limit_hum', min: 30, max: 80,
      switchToMode: { key: 'mode', call: 'set_mode', value: 'auto' } },
    waterLevel: { key: 'depth', mapFn: (v) => Math.min(v / 1.2, 100) },
    childLock: { key: 'child_lock', on: 'on', off: 'off', call: 'set_child_lock' },
    buzzer:    { key: 'buzzer', on: 'on', off: 'off', call: 'set_buzzer' },
    dry:       { key: 'dry', on: 'on', off: 'off', call: 'set_dry' },
    led: { key: 'led_b', levels: [2, 1, 0], on: 1, off: 2, call: 'set_led_b', toString: true },
  },

  'zhimi.humidifier.ca4': {
    protocol: 'miot',
    propsMiot: {
      power:           { siid: 2, piid: 1 },
      mode:            { siid: 2, piid: 5 },
      target_humidity: { siid: 2, piid: 6 },
      water_level:     { siid: 2, piid: 7 },
      dry:             { siid: 2, piid: 8 },
      humidity:        { siid: 3, piid: 9 },
      child_lock:      { siid: 6, piid: 1 },
      led_brightness:  { siid: 5, piid: 2 },
      buzzer:          { siid: 4, piid: 1 },
      temperature:     { siid: 3, piid: 7 },
      clean_mode:      { siid: 7, piid: 5 },
    },
    // Mode: 0=Auto, 1=Low, 2=Medium, 3=High
    power: { key: 'power', on: true, off: false },
    mode:  { key: 'mode', values: [1, 2, 3, 0] },  // 1..3 = Low/Med/High, 0 = Auto
    humidity: { key: 'humidity' },
    temperature: { key: 'temperature', scale: 1 },
    targetHumidity: { key: 'target_humidity', min: 30, max: 80,
      switchToMode: { key: 'mode', value: 0 } },
    waterLevel: { key: 'water_level', mapFn: (v) => Math.min(v / 1.2, 100) },
    childLock: { key: 'child_lock', on: true, off: false },
    buzzer:    { key: 'buzzer', on: true, off: false },
    dry:       { key: 'dry', on: true, off: false },
    clean:     { key: 'clean_mode', on: true, off: false },
    led: { key: 'led_brightness', levels: [0, 1, 2], on: 1, off: 0 }, // 0=Off,1=Dim,2=Bright
  },

  // ----- Deerma -----
  'deerma.humidifier.mjjsq': {
    protocol: 'miio',
    propsMiio: ['OnOff_State','TemperatureValue','Humidity_Value','HumiSet_Value','Humidifier_Gear','Led_State','TipSound_State','waterstatus','watertankstatus'],
    propsMaxBatch: 1, // 본 펌웨어는 한 번에 1개 prop만 받음
    setCalls: {
      OnOff_State: 'Set_OnOff', Humidifier_Gear: 'Set_HumidifierGears',
      HumiSet_Value: 'Set_HumiValue', Led_State: 'SetLedState',
      TipSound_State: 'SetTipSound_Status',
    },
    power: { key: 'OnOff_State', on: 1, off: 0, call: 'Set_OnOff' },
    // Gear: 1=Low, 2=Med, 3=High, 4=Humidity
    mode:  { key: 'Humidifier_Gear', values: [1, 2, 3, 4], call: 'Set_HumidifierGears' },
    humidity: { key: 'Humidity_Value' },
    temperature: { key: 'TemperatureValue', scale: 1 },
    targetHumidity: { key: 'HumiSet_Value', call: 'Set_HumiValue', min: 40, max: 70,
      switchToMode: { key: 'Humidifier_Gear', call: 'Set_HumidifierGears', value: 4 } },
    waterLevel: { key: 'waterstatus', mapFn: (v) => v * 100 },
    buzzer:    { key: 'TipSound_State', on: 1, off: 0, call: 'SetTipSound_Status' },
    led: { key: 'Led_State', levels: [0, 1], on: 1, off: 0, call: 'SetLedState' },
  },
  'deerma.humidifier.jsq1': { alias: 'deerma.humidifier.mjjsq' },

  'deerma.humidifier.jsq2w': {
    protocol: 'miot',
    propsMiot: {
      power:             { siid: 2, piid: 1 },
      fan_level:         { siid: 2, piid: 5 },
      target_humidity:   { siid: 2, piid: 6 },
      relative_humidity: { siid: 3, piid: 1 },
      temperature:       { siid: 3, piid: 7 },
      buzzer:            { siid: 5, piid: 1 },
      switch_status:     { siid: 6, piid: 1 },
    },
    power: { key: 'power', on: true, off: false },
    mode:  { key: 'fan_level', values: [1, 2, 3, 4] },   // 1/2/3 = Low/Med/High, 4 = Humidity
    humidity: { key: 'relative_humidity' },
    temperature: { key: 'temperature', scale: 1 },
    targetHumidity: { key: 'target_humidity', min: 40, max: 70,
      switchToMode: { key: 'fan_level', value: 4 } },
    buzzer:    { key: 'buzzer', on: true, off: false },
    led: { key: 'switch_status', levels: [false, true], on: true, off: false },
  },

  'deerma.humidifier.jsq4': {
    protocol: 'miot',
    propsMiot: {
      power:             { siid: 2, piid: 1 },
      fan_level:         { siid: 2, piid: 5 },
      target_humidity:   { siid: 2, piid: 6 },
      water_level:       { siid: 7, piid: 1 },
      relative_humidity: { siid: 3, piid: 1 },
      temperature:       { siid: 3, piid: 7 },
      buzzer:            { siid: 5, piid: 1 },
      switch_status:     { siid: 6, piid: 1 },
    },
    power: { key: 'power', on: true, off: false },
    mode:  { key: 'fan_level', values: [1, 2, 3] },   // 1/2 = Low/Med, 3 = Humidity
    humidity: { key: 'relative_humidity' },
    temperature: { key: 'temperature', scale: 1 },
    targetHumidity: { key: 'target_humidity', min: 40, max: 80,
      switchToMode: { key: 'fan_level', value: 3 } },
    // water_level(7,1) = water-shortage-fault (bool, true=물부족). 부족이면 0%(빈탱크 경고), 아니면 100%.
    waterLevel: { key: 'water_level', mapFn: (v) => (v === true || v === 1) ? 0 : 100 },
    buzzer:    { key: 'buzzer', on: true, off: false },
    led: { key: 'switch_status', levels: [false, true], on: true, off: false },
  },

  // jsq3 / jsq5 / jsqs 는 jsq4 와 거의 같음 (mode values 가 4단)
  'deerma.humidifier.jsq5': {
    protocol: 'miot',
    propsMiot: {
      power:             { siid: 2, piid: 1 },
      fan_level:         { siid: 2, piid: 5 },
      target_humidity:   { siid: 2, piid: 6 },
      water_level:       { siid: 7, piid: 1 },
      relative_humidity: { siid: 3, piid: 1 },
      temperature:       { siid: 3, piid: 7 },
      buzzer:            { siid: 5, piid: 1 },
      switch_status:     { siid: 6, piid: 1 },
    },
    power: { key: 'power', on: true, off: false },
    mode:  { key: 'fan_level', values: [1, 2, 3, 4] },
    humidity: { key: 'relative_humidity' },
    temperature: { key: 'temperature', scale: 1 },
    targetHumidity: { key: 'target_humidity', min: 40, max: 80,
      switchToMode: { key: 'fan_level', value: 4 } },
    // water_level(7,1) = water-shortage-fault (bool, true=물부족). jsq4 와 동일 구조.
    waterLevel: { key: 'water_level', mapFn: (v) => (v === true || v === 1) ? 0 : 100 },
    buzzer:    { key: 'buzzer', on: true, off: false },
    led: { key: 'switch_status', levels: [false, true], on: true, off: false },
  },
  'deerma.humidifier.jsq3': { alias: 'deerma.humidifier.jsq5' },
  'deerma.humidifier.jsqs': { alias: 'deerma.humidifier.jsq5' },

  // ----- Shuii -----
  'shuii.humidifier.jsq001': {
    protocol: 'miio',
    // get_props 는 빈 args, 응답은 고정 순서로 모든 prop을 돌려준다
    propsMiio: ['temperature', 'humidity', 'mode', 'buzzer', 'child_lock', 'led_brightness', 'power', 'no_water'],
    getCall: 'get_props',
    getArgsEmpty: true,
    setCalls: {
      power: 'set_start', mode: 'set_mode', buzzer: 'set_buzzer',
      child_lock: 'set_lock', led_brightness: 'set_brightness',
    },
    power: { key: 'power', on: 1, off: 0, call: 'set_start' },
    // mode: 1..5, 0=Intelligent → HomeKit 회전속도 6단
    mode:  { key: 'mode', values: [1, 2, 3, 4, 5, 0], call: 'set_mode' },
    humidity: { key: 'humidity' },
    temperature: { key: 'temperature', scale: 1 },
    waterLevel: { key: 'no_water', mapFn: (v) => v * 100 }, // 0=Enough, 1=AddWater
    childLock: { key: 'child_lock', on: 1, off: 0, call: 'set_lock' },
    buzzer:    { key: 'buzzer', on: 1, off: 0, call: 'set_buzzer' },
    led: { key: 'led_brightness', levels: [0, 1, 2], on: 1, off: 0, call: 'set_brightness' },
  },
};

// alias 해소
function resolveModel(modelName) {
  if (!modelName) return null;
  let m = MODELS[modelName];
  if (!m) return null;
  if (m.alias) m = MODELS[m.alias];
  return m;
}

function listSupportedModels() {
  return Object.keys(MODELS);
}

module.exports = { resolveModel, listSupportedModels, MODELS };

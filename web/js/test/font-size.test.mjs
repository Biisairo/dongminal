import assert from 'node:assert/strict';
import { test } from 'node:test';

import { load } from './harness.mjs';

/**
 * `core/settings-schema.js` — 글자 크기 두 키의 값 판정
 * (FONT_SIZE_SETTING_SRS V-FSS-4 · FR-FSS-19).
 *
 * **손이 둘이고 뜻이 다르다.** 이 검사가 재는 것의 절반은 그 차이다:
 *
 *   `settingValue`  서버가 준 값을 해석한다. 범위 밖은 **기본값으로 떨어진다** —
 *                   손으로 고친 `settings.json` 하나가 화면을 못 쓰게 만들지
 *                   않아야 한다 (FR-CFG-3).
 *   `clampSetting`  사용자가 치는 값을 받는다. 범위 밖은 **자른다** — 숫자
 *                   입력은 타이핑 도중 잠깐 범위 밖이 되고, 그때마다 기본값으로
 *                   튕기면 입력 자체가 불가능해진다 (FR-TBW-4 의 선례).
 *
 * 둘을 한 파일에서 재는 이유는 **바꿔 쓰는 실패**가 조용하기 때문이다. `clamp`
 * 자리에 `settingValue` 를 쓰면 `19` 를 치려고 `1` 을 친 순간 100 으로 튄다.
 */
const ctx = () => load(['core/settings-schema.js'], {
  expose: ['SETTINGS_BY_KEY', 'settingValue', 'clampSetting'],
});

test('V-FSS-4a: 표가 두 키의 범위와 기본값을 갖는다 (FR-FSS-2·12)', () => {
  const { SETTINGS_BY_KEY: by } = ctx();
  assert.deepEqual(
    { type: by.uiFontSize.type, min: by.uiFontSize.min, max: by.uiFontSize.max, def: by.uiFontSize.def },
    { type: 'int', min: 8, max: 32, def: 14 });
  assert.deepEqual(
    { type: by.termFontSize.type, min: by.termFontSize.min, max: by.termFontSize.max, def: by.termFontSize.def },
    { type: 'int', min: 8, max: 32, def: 14 });
});

test('V-FSS-4b: 기본값은 종전 화면을 낸다 (FR-FSS-23)', () => {
  const { SETTINGS_BY_KEY: by } = ctx();
  // FR-FSS-2a·2b: 둘 다 px 이고 기본이 14 다 — UI 14 는 `--fs-lg` 의 기준 px 이므로
  // `--fs-scale` 이 1 이 되어 종전 100% 와 같은 화면을 낸다.
  assert.equal(by.uiFontSize.def, 14);
  assert.equal(by.termFontSize.def, 14);
});

test('V-FSS-4c: clampSetting 은 경계를 지키고 범위 밖을 자른다 (FR-FSS-19)', () => {
  const { clampSetting: clamp } = ctx();
  // 경계는 그대로 통과한다.
  assert.equal(clamp('uiFontSize', 8), 8);
  assert.equal(clamp('uiFontSize', 32), 32);
  assert.equal(clamp('termFontSize', 8), 8);
  assert.equal(clamp('termFontSize', 32), 32);
  // 한 눈금 밖은 **기본값이 아니라 경계로** 잘린다.
  assert.equal(clamp('uiFontSize', 7), 8);
  assert.equal(clamp('uiFontSize', 33), 32);
  assert.equal(clamp('termFontSize', 7), 8);
  assert.equal(clamp('termFontSize', 33), 32);
  // 크게 벗어나도 마찬가지다.
  assert.equal(clamp('uiFontSize', 0), 8);
  assert.equal(clamp('termFontSize', 9999), 32);
});

test('V-FSS-4d: clampSetting 은 문자열 입력을 받는다 — 입력란이 주는 것이 문자열이다', () => {
  const { clampSetting: clamp } = ctx();
  assert.equal(clamp('uiFontSize', '20'), 20);
  assert.equal(clamp('termFontSize', '20'), 20);
  // 소수는 반올림한다 (`clampTabWidth` 와 같은 규약).
  assert.equal(clamp('uiFontSize', '20.4'), 20);
  assert.equal(clamp('uiFontSize', '20.6'), 21);
});

test('V-FSS-4e: 숫자가 아니면 기본값이다 — 빈 입력란이 0 이 되지 않는다', () => {
  const { clampSetting: clamp } = ctx();
  // 입력란을 비우면 값은 `''` 다. `Number('')` 는 0 이고 그것을 자르면 최솟값이
  // 되는데, 그러면 지우고 다시 치는 동안 화면이 8px 로 줄었다 편다.
  assert.equal(clamp('uiFontSize', ''), 14);
  assert.equal(clamp('uiFontSize', 'abc'), 14);
  assert.equal(clamp('termFontSize', ''), 14);
  assert.equal(clamp('termFontSize', null), 14);
  assert.equal(clamp('termFontSize', undefined), 14);
});

test('V-FSS-4f: 모르는 키는 값을 그대로 돌려준다 — 부르는 쪽을 깨뜨리지 않는다', () => {
  const { clampSetting: clamp } = ctx();
  assert.equal(clamp('noSuchKey', 7), 7);
});

test('V-FSS-4g: settingValue 는 범위 밖을 기본값으로 떨어뜨린다 (FR-CFG-3 · clamp 와 다르다)', () => {
  const { SETTINGS_BY_KEY: by, settingValue: sv } = ctx();
  // 같은 입력(33)에 두 손이 **다르게** 답한다: 저장값 해석은 기본값 14, 입력 clamp 는 32.
  assert.equal(sv(33, by.uiFontSize), 14);
  assert.equal(sv(33, by.termFontSize), 14);
  assert.equal(sv(20, by.uiFontSize), 20);
  assert.equal(sv(20, by.termFontSize), 20);
});

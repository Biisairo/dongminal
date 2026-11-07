import assert from 'node:assert/strict';
import { test } from 'node:test';

import { load } from './harness.mjs';

/**
 * SERVER_DRIVEN_ACTIONS_SRS F-4 (FR-SDA-54) — 이름의 길이 상한은 **서버가** 정한다.
 * 화면은 `GET /api/meta` 의 `entityNameMax` 로 자르고, 받기 전에는 자르지 않는다.
 */
function fresh() {
  return load(['core/i18n.js', 'i18n/ko.js', 'core/constants.js'], { expose: ['clampEntityName', 'applyServerMeta'] });
}

test('받기 전에는 자르지 않는다 — 화면이 상한을 지어내지 않는다', () => {
  const { clampEntityName } = fresh();
  const long = 'x'.repeat(100);
  assert.equal(clampEntityName(long), long);
  assert.equal(clampEntityName(null), '');
});

test('서버의 상한으로 자른다', () => {
  const { clampEntityName, applyServerMeta } = fresh();
  applyServerMeta({ entityNameMax: 5 });
  assert.equal(clampEntityName('abcdefgh'), 'abcde');
  assert.equal(clampEntityName('abc'), 'abc');
});

test('모르는 값은 무시한다', () => {
  const { clampEntityName, applyServerMeta } = fresh();
  applyServerMeta({ entityNameMax: 5 });
  applyServerMeta({});
  applyServerMeta(null);
  assert.equal(clampEntityName('abcdefgh'), 'abcde');
});

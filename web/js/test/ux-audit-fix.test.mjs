import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CONSTANTS, HELPERS, load } from './harness.mjs';

// UX_AUDIT_FIX_SRS TC-UXF-2 (FR-UXF-3): 상태바 기본 항목은 연결·cwd·인코딩이다.
test('TC-UXF-2: 상태바 기본값 — 지연·위치·메모리는 꺼짐, 연결·cwd·인코딩은 켜짐', () => {
  const ctx = load(['core/i18n.js', 'i18n/ko.js', 'core/settings-schema.js', 'core/settings-defaults.js',
    ...CONSTANTS, ...HELPERS], { expose: ['STATUS_ITEMS'] });
  const def = (k) => ctx.STATUS_ITEMS[k].def;
  for (const k of ['latency', 'location', 'memory']) assert.equal(def(k), false, k);
  for (const k of ['connection', 'cwd', 'encoding']) assert.equal(def(k), true, k);
});

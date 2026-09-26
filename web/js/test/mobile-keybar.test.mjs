import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { load, plain } from './harness.mjs';

/**
 * OPTIMIZE_REFACTOR_SRS FR-OPT-11-2 (FEC-34): 모바일 키바의 키 표는 상수다. 보내는 바이트는
 * 종전과 같고, 소스에는 눈에 보이지 않는 제어 문자가 없다 (이스케이프로 적는다).
 */
const JS = join(dirname(fileURLToPath(import.meta.url)), '..');
const CTRL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;

const ctx = () => load(['core/i18n.js', 'i18n/ko.js', 'core/constants.js'], { expose: ['MKB_KEYS', 'MKB_FULL_NAMES'] });

test('키 표가 보내는 바이트는 종전과 같다', () => {
  const keys = plain(ctx().MKB_KEYS);
  assert.deepEqual(keys, [
    { label: '⌨', act: 'kb' },
    { label: 'Esc', send: '\x1b' },
    { label: 'Tab', send: '\t' },
    { label: '⏎', send: '\r' },
    { label: 'Ctrl', mod: 'ctrl' },
    { label: '^C', raw: '\x03' },
    { label: 'Alt', mod: 'alt' },
    { label: '↑', send: '\x1b[A' },
    { label: '↓', send: '\x1b[B' },
    { label: '←', send: '\x1b[D' },
    { label: '→', send: '\x1b[C' },
    { label: '|', send: '|' },
    { label: '~', send: '~' },
    { label: '/', send: '/' },
    { label: '-', send: '-' },
    { label: 'Home', send: '\x1b[H' },
    { label: 'End', send: '\x1b[F' },
    { label: 'PgUp', send: '\x1b[5~' },
    { label: 'PgDn', send: '\x1b[6~' },
  ]);
});

test('모든 키에 전체 이름이 있다', () => {
  const c = ctx();
  for (const k of c.MKB_KEYS) assert.ok(c.MKB_FULL_NAMES[k.label], k.label);
});

test('소스에 날 제어 문자가 없다', () => {
  for (const f of ['core/constants.js', 'core/app-mobile.js']) {
    const lines = readFileSync(join(JS, f), 'utf8').split('\n');
    const bad = lines.map((l, i) => [i + 1, l]).filter(([, l]) => CTRL.test(l)).map(([n]) => n);
    assert.deepEqual(bad, [], f + ' 의 줄 ' + bad.join(','));
  }
});

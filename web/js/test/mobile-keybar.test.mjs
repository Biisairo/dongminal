import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { CONSTANTS, load, plain } from './harness.mjs';

/**
 * OPTIMIZE_REFACTOR_SRS FR-OPT-11-2 (FEC-34): 모바일 키바의 키 표는 상수다. 보내는 바이트는
 * 종전과 같고, 소스에는 눈에 보이지 않는 제어 문자가 없다 (이스케이프로 적는다).
 */
const JS = join(dirname(fileURLToPath(import.meta.url)), '..');
const CTRL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;

const ctx = () => load(['core/i18n.js', 'i18n/ko.js', ...CONSTANTS], { expose: ['MKB_KEYS', 'MKB_FULL_NAMES'] });

test('키 표가 보내는 바이트는 종전과 같다', () => {
  const keys = plain(ctx().MKB_KEYS);
  assert.deepEqual(keys, [
    { label: '⌨', act: 'kb', icon: 'keyboard' },   // UX_AUDIT_FIX_SRS FR-UXF-7: 아이콘으로 그린다
    { id: 'esc', label: 'Esc', send: '\x1b' },
    { id: 'tab', label: 'Tab', send: '\t' },
    { id: 'enter', label: '⏎', send: '\r' },
    { id: 'ctrl', label: 'Ctrl', mod: 'ctrl' },
    { id: 'ctrlc', label: '^C', raw: '\x03' },
    { id: 'alt', label: 'Alt', mod: 'alt' },
    { id: 'up', label: '↑', send: '\x1b[A' },
    { id: 'down', label: '↓', send: '\x1b[B' },
    { id: 'left', label: '←', send: '\x1b[D' },
    { id: 'right', label: '→', send: '\x1b[C' },
    { id: 'pipe', label: '|', send: '|' },
    { id: 'tilde', label: '~', send: '~' },
    { id: 'slash', label: '/', send: '/' },
    { id: 'hyphen', label: '-', send: '-' },
    { id: 'home', label: 'Home', send: '\x1b[H' },
    { id: 'end', label: 'End', send: '\x1b[F' },
    { id: 'pgup', label: 'PgUp', send: '\x1b[5~' },
    { id: 'pgdn', label: 'PgDn', send: '\x1b[6~' },
  ]);
});

test('모든 키에 전체 이름이 있다', () => {
  const c = ctx();
  for (const k of c.MKB_KEYS) assert.ok(c.MKB_FULL_NAMES[k.label], k.label);
});

test('소스에 날 제어 문자가 없다', () => {
  for (const f of [...CONSTANTS, 'core/mobile-controller.js']) {
    const lines = readFileSync(join(JS, f), 'utf8').split('\n');
    const bad = lines.map((l, i) => [i + 1, l]).filter(([, l]) => CTRL.test(l)).map(([n]) => n);
    assert.deepEqual(bad, [], f + ' 의 줄 ' + bad.join(','));
  }
});

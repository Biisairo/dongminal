import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { load } from './harness.mjs';

/**
 * OTTERMINAL_RENAME_SRS FR-MIG-10 — 브라우저 저장소의 옛 키(`dm.*`)를 새 키(`otter.*`)로 옮긴다.
 */

const JS_ROOT = new URL('..', import.meta.url).pathname;
const REPO = join(JS_ROOT, '..', '..');

function storage(init = {}) {
  const m = new Map(Object.entries(init));
  return {
    get length() { return m.size },
    key: (i) => [...m.keys()][i] ?? null,
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)) },
    removeItem: (k) => { m.delete(k) },
    dump: () => Object.fromEntries(m),
  };
}

const ctx = load(['core/storage-rename.js']);

test('옛 키만 있으면 새 키로 옮기고 옛 키를 지운다 — 접미가 붙은 키 포함', () => {
  const st = storage({
    'dm.locale': 'en',
    'dm.themeVars.dark': '{"--a":"1"}',
    'dm.sbx.recent': '[]',
    sidebarWidth: '200',
  });
  ctx.storageRenameLegacy(st);
  assert.deepEqual(st.dump(), {
    'otter.locale': 'en',
    'otter.themeVars.dark': '{"--a":"1"}',
    'otter.sbx.recent': '[]',
    sidebarWidth: '200',
  });
});

test('새 키가 이미 있으면 새 값을 지키고 옛 키만 지운다', () => {
  const st = storage({ 'dm.locale': 'en', 'otter.locale': 'ko' });
  ctx.storageRenameLegacy(st);
  assert.deepEqual(st.dump(), { 'otter.locale': 'ko' });
});

test('옛 키가 없으면 아무것도 바꾸지 않는다', () => {
  const st = storage({ 'otter.locale': 'ko', admin: 'x', 'dmx.y': 'z' });
  ctx.storageRenameLegacy(st);
  assert.deepEqual(st.dump(), { 'otter.locale': 'ko', admin: 'x', 'dmx.y': 'z' });
});

test('저장소를 쓸 수 없어도(사생활 모드) 던지지 않는다', () => {
  const broken = { get length() { throw new Error('denied') } };
  assert.doesNotThrow(() => ctx.storageRenameLegacy(broken));
});

test('index.html 이 이것을 server-move.js 뒤, 테마·언어 머리 스크립트 앞에서 싣는다', () => {
  const html = readFileSync(join(REPO, 'web/index.html'), 'utf8');
  const mv = html.indexOf('js/core/server-move.js');
  const rn = html.indexOf('js/core/storage-rename.js');
  const theme = html.indexOf("'otter.themeVars'");
  assert.ok(mv > 0 && mv < rn && rn < theme, `${mv} < ${rn} < ${theme}`);
});

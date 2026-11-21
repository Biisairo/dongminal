import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { load } from './harness.mjs';

/**
 * REFACTOR3_FE_REST3_SRS FR-FR3-10·11 (FC-12, TC-FR3-34) — 테마 미리보기는 값이 마크업에 섞이지 않는다.
 * 골격은 보간 없는 고정 문자열이고, 색은 `themePreviewVars` 의 변수로만 들어간다.
 */
const CSS = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../style.css'), 'utf8');

const ctx = load(['core/settings-theme.js'], {
  expose: ['THEME_PREVIEW_HTML'],
  globals: { SettingsSection: class {} },
});

const U = { bg: 'u-bg', sidebarBg: 'u-sb', border: 'u-border', accent: 'u-accent', accentBorder: 'u-ab', text: 'u-text',
  textBright: 'u-tb', textMuted: 'u-tm', textDim: 'u-td', danger: 'u-danger' };
const ANSI = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white', 'brightBlack', 'brightRed', 'brightGreen',
  'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite'];
const C = { background: 't-bg', foreground: 't-fg', selectionBackground: 't-sb', selectionForeground: 't-sf', cursor: 't-c',
  cursorAccent: 't-ca', ...Object.fromEntries(ANSI.map((k) => [k, 't-' + k])) };

test('TC-FR3-34: 골격에는 인라인 style 도 보간도 없다', () => {
  const html = ctx.THEME_PREVIEW_HTML;
  assert.equal(typeof html, 'string');
  assert.doesNotMatch(html, /style=/);
  assert.doesNotMatch(html, /\$\{/);
  // 견본의 title 은 색 이름 그대로다 (16색)
  for (const k of ANSI) assert.match(html, new RegExp('title="' + k + '"'), k);
});

test('TC-FR3-34: themePreviewVars 는 받은 팔레트 값을 이름마다 그대로 싣는다', () => {
  const v = ctx.themePreviewVars(U, C, 'hl');
  const vals = new Set(Object.values(v));
  for (const x of [...Object.values(U), ...Object.values(C), 'hl']) assert.ok(vals.has(x), x + ' 가 실리지 않았다');
  assert.equal(v['--pv-accent-hl'], 'hl');
  assert.equal(v['--pv-t-bright-black'], 't-brightBlack');
  for (const k of Object.keys(v)) assert.match(k, /^--pv-[a-z-]+$/, k);
});

test('TC-FR3-34: CSS 가 읽는 색 변수(--pv-* 중 눈금 밖)는 전부 맵이 세운다', () => {
  const v = ctx.themePreviewVars(U, C, 'hl');
  const read = new Set([...CSS.matchAll(/var\((--pv-[a-z0-9-]+)\)/g)].map((m) => m[1]));
  const scale = new Set(['--pv-fs-2xs', '--pv-fs-xs', '--pv-fs-sm', '--pv-fs-md', '--pv-radius']);
  const colors = [...read].filter((n) => !scale.has(n));
  assert.ok(colors.length >= 30, '읽는 색 변수가 ' + colors.length + '개뿐이다');
  for (const n of colors) assert.ok(n in v, n + ' 를 세우지 않는다');
});

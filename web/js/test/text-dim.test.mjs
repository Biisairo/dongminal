import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { load } from './harness.mjs';

/**
 * `--text-dim` 은 팔레트의 dim 을 글자 쪽으로 끌어올린 파생값이다 (EDITOR_LINK_LSP_SRS FR-ELS-57).
 *
 * 팔레트 dim 은 많은 테마에서 `--border` 와 같아 스크롤바 손잡이가 보이지 않았다.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const ctx = load(['core/contrast.js', 'ui/themes.js', 'core/theme-vars.js'], {
  globals: { TOPTS: {} },
  expose: ['THEMES', 'themeVarsOf', 'mixHex', 'TEXT_DIM_LIFT'],
});

test('FR-ELS-57: 54종 모두 --text-dim 이 팔레트 dim 을 text 쪽으로 TEXT_DIM_LIFT 만큼 옮긴 값이다', () => {
  assert.equal(ctx.TEXT_DIM_LIFT, 0.3);
  const names = Object.keys(ctx.THEMES);
  assert.ok(names.length >= 54);
  for (const n of names) {
    const t = ctx.THEMES[n];
    const want = ctx.mixHex(t.ui.textDim, t.ui.text, ctx.TEXT_DIM_LIFT);
    assert.equal(ctx.themeVarsOf(t)['--text-dim'], want, n);
    assert.notEqual(want.toLowerCase(), t.ui.border.toLowerCase(), n + ': 경계와 같아 보이지 않는다');
  }
});

test('FR-ELS-57: style.css 의 첫 페인트 값은 기본 테마의 파생값이다', () => {
  const css = readFileSync(join(ROOT, 'web/style.css'), 'utf8');
  const m = css.match(/--text-dim:(#[0-9a-fA-F]{6})/);
  const tokyo = Object.values(ctx.THEMES).find((t) => t.ui.bg === '#1a1b26' && t.ui.textDim === '#414868');
  assert.ok(m && tokyo);
  assert.equal(m[1].toLowerCase(), ctx.themeVarsOf(tokyo)['--text-dim']);
});

test('FR-ELS-55: 스크롤바 thumb · 미니맵 슬라이더는 옛 엔진과 같은 중립 회색 + 투명도다 (테마 색을 섞지 않는다)', () => {
  const dark = Object.values(ctx.THEMES).find((t) => t.mode !== 'light');
  const light = Object.values(ctx.THEMES).find((t) => t.mode === 'light');
  const d = ctx.themeVarsOf(dark);
  const l = ctx.themeVarsOf(light);
  assert.deepEqual(
    ['--ed-thumb', '--ed-thumb-hover', '--ed-thumb-active', '--ed-slider', '--ed-slider-hover', '--ed-slider-active'].map((k) => d[k]),
    ['rgba(121,121,121,0.4)', 'rgba(100,100,100,0.7)', 'rgba(191,191,191,0.4)', 'rgba(121,121,121,0.3)', 'rgba(100,100,100,0.45)', 'rgba(191,191,191,0.3)']);
  assert.deepEqual(
    ['--ed-thumb', '--ed-thumb-hover', '--ed-thumb-active', '--ed-slider', '--ed-slider-hover', '--ed-slider-active'].map((k) => l[k]),
    ['rgba(100,100,100,0.4)', 'rgba(100,100,100,0.7)', 'rgba(0,0,0,0.6)', 'rgba(100,100,100,0.3)', 'rgba(100,100,100,0.45)', 'rgba(0,0,0,0.4)']);
});

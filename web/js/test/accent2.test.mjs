import assert from 'node:assert/strict';
import { test } from 'node:test';

import { load } from './harness.mjs';

/**
 * UX_AUDIT_FIX_SRS FR-UXF-124·126·127 (D-42): 실행 중 색 `--accent2`.
 */
const ctx = load(['core/contrast.js', 'ui/themes.js', 'core/theme-vars.js'], {
  globals: { TOPTS: {}, t: (k) => k },
  expose: ['THEMES', 'themeVarsOf', 'pickAccent2', 'pickAttnColor', 'colorDistance'],
});

const BG = '#1a1b26';
const theme = (ui, terminal) => ({
  mode: 'dark',
  ui: { bg: BG, sidebarBg: BG, border: '#292e42', accent: '#7aa2f7', text: '#a9b1d6', textMuted: '#565f89',
    textBright: '#c0caf5', textDim: '#414868', danger: '#f7768e', accentBorder: '#3d59a1', ...ui },
  terminal: { background: BG, foreground: '#a9b1d6', ...terminal },
});

test('TC-UXF-126: colorDistance 는 redmean 가중 RGB 거리다', () => {
  assert.equal(ctx.colorDistance('#000000', '#000000'), 0);
  assert.equal(Math.round(ctx.colorDistance('#000000', '#ffffff')), 765);
  assert.equal(ctx.colorDistance('#7aa2f7', '#9ece6a'), ctx.colorDistance('#9ece6a', '#7aa2f7'));
});

test('TC-UXF-126: 후보 중 accent·알림색·danger 와의 최소 거리가 가장 큰 색을 고른다', () => {
  const t = theme({}, { blue: '#7aa2f7', magenta: '#bb9af7', cyan: '#7dcfff', green: '#9ece6a', yellow: '#e0af68' });
  const want = ['#7aa2f7', '#bb9af7', '#7dcfff', '#9ece6a', '#e0af68']
    .map((c) => [c, Math.min(...[t.ui.accent, ctx.pickAttnColor(t), t.ui.danger].map((x) => ctx.colorDistance(c, x)))])
    .sort((a, b) => b[1] - a[1])[0][0];
  assert.equal(ctx.pickAccent2(t), want);
});

test('TC-UXF-126: bright 열 색도 후보다', () => {
  // brightBlue 는 알림색 후보가 아니다 — 알림색은 accent 로 떨어지고, 같은 색인 blue 는 거리 0 이다
  const t = theme({}, { blue: '#7aa2f7', brightBlue: '#a0f0ff' });
  assert.equal(ctx.pickAccent2(t), '#a0f0ff');
});

test('TC-UXF-126: 배경 대비 3:1 미만 후보는 대비를 넘는 후보가 있으면 빠진다', () => {
  // 짙은 녹색은 accent 에서 가장 멀지만 배경과 대비가 낮다
  const t = theme({}, { blue: '#7aa2f7', green: '#0a3a0a', magenta: '#ff79c6' });
  assert.equal(ctx.pickAccent2(t), '#ff79c6');
});

// FR-UXF-126 개정(THEME_SEED_COLOR_SRS FR-SEED-14 실측)
//   이전 동작: 모든 후보가 대비 미달이면 대비 조건 없이 고른 색 그대로
//   새  동작: 그 색을 3:1 까지 끌어올린다 / 이유: Everforest Light 메인색 변환에서 링이 보이지 않았다
test('TC-UXF-126: 모든 후보가 대비 미달이면 거리로 고른 색을 3:1 까지 끌어올린다', () => {
  const t = theme({}, { green: '#0a3a0a', blue: '#20243a' });
  const raw = ['#0a3a0a', '#20243a']
    .map((c) => [c, Math.min(...[t.ui.accent, ctx.pickAttnColor(t), t.ui.danger].map((x) => ctx.colorDistance(c, x)))])
    .sort((a, b) => b[1] - a[1])[0][0];
  const got = ctx.pickAccent2(t);
  assert.notEqual(got, raw);
  assert.ok(ctx.contrastRatio(got, BG) >= 3, `${got} ${ctx.contrastRatio(got, BG)}`);
  assert.equal(got, ctx.liftContrast(raw, ctx.pickContrastAnchor(t.ui, t.mode), [BG, BG], 3).color);
});

test('TC-UXF-126: 후보가 없으면 accent 다', () => {
  assert.equal(ctx.pickAccent2(theme({}, {})), '#7aa2f7');
  assert.equal(ctx.pickAccent2({ mode: 'dark', ui: theme({}, {}).ui }), '#7aa2f7');
});

test('TC-UXF-124: ui.accent2 가 있으면 --accent2 는 그 값이다 — 대비를 끌어올리지 않는다', () => {
  const low = '#20222e';
  const t = theme({ accent2: low }, { green: '#9ece6a' });
  assert.equal(ctx.themeVarsOf(t)['--accent2'], low);
});

test('TC-UXF-124·127: ui.accent2 가 없으면 --accent2 는 pickAccent2 값이다', () => {
  const t = theme({}, { blue: '#7aa2f7', green: '#9ece6a', magenta: '#bb9af7' });
  assert.equal(ctx.themeVarsOf(t)['--accent2'], ctx.pickAccent2(t));
});

test('TC-UXF-124: 내장 54종 모두 --accent2 가 명시값이다', () => {
  const names = Object.keys(ctx.THEMES);
  assert.ok(names.length >= 54);
  for (const n of names) {
    const a2 = ctx.THEMES[n].ui.accent2;
    assert.match(a2 || '', /^#[0-9a-f]{6}$/i, n);
    assert.equal(ctx.themeVarsOf(ctx.THEMES[n])['--accent2'], a2, n);
  }
});

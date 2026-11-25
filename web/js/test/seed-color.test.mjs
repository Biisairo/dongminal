import assert from 'node:assert/strict';
import { test } from 'node:test';

import { load } from './harness.mjs';

/**
 * THEME_SEED_COLOR_SRS: 메인색 하나로 테마 전체를 그 방향으로 계산한다.
 */
const ctx = load(['core/contrast.js', 'ui/themes.js', 'ui/themes-catalog.js', 'core/theme-vars.js'], {
  globals: { TOPTS: {}, t: (k) => k },
  expose: ['THEMES', 'SEED_MIN_CHROMA', 'SEED_HARMONY_MAX', 'SEED_THEME_UI_KEYS', 'SEED_THEME_TERM_KEYS',
    'SEED_MEANING_TERM_KEYS'],
});
const { THEMES, oklchOf, hexOfOklch, seedTheme, themeVarsOf, pickAccent2 } = ctx;

const clone = (o) => JSON.parse(JSON.stringify(o));
/** -180~180 으로 정규화한 b-a. */
const hueDelta = (a, b) => ((b - a + 540) % 360) - 180;
const TOKYO = THEMES['Tokyo Night'];
const RED = '#e03030';

test('oklchOf·hexOfOklch: 왕복이 같은 색이다', () => {
  for (const hex of ['#7aa2f7', '#1a1b26', '#ffffff', '#000000', '#e0af68', '#ff00ff']) {
    const { L, C, h } = oklchOf(hex);
    assert.equal(hexOfOklch(L, C, h), hex, hex);
  }
  const g = oklchOf('#808080');
  assert.ok(g.C < 0.001);
});

test('hexOfOklch: sRGB 밖이면 L·h 를 두고 C 를 줄인다 (TC-SEED-6)', () => {
  const out = hexOfOklch(0.9, 0.4, 140);
  assert.match(out, /^#[0-9a-f]{6}$/);
  const o = oklchOf(out);
  assert.ok(Math.abs(o.L - 0.9) < 0.01, `L ${o.L}`);
  assert.ok(Math.abs(hueDelta(140, o.h)) < 2, `h ${o.h}`);
  assert.ok(o.C < 0.4);
});

test('TC-SEED-1: 끔·형식 밖·회색이면 원본과 같은 값의 사본이고 원본은 바뀌지 않는다', () => {
  const before = clone(TOKYO);
  for (const seed of ['', null, undefined, 'red', '#12', '#808080']) {
    const out = seedTheme(TOKYO, seed);
    assert.notEqual(out, TOKYO);
    // vm 컨텍스트의 객체라 원형이 다르다 — 값으로 비교한다
    assert.equal(JSON.stringify(out), JSON.stringify(before), String(seed));
  }
  seedTheme(TOKYO, RED);
  assert.equal(JSON.stringify(TOKYO), JSON.stringify(before));
});

test('TC-SEED-2: 새 accent 는 메인색의 색상과 원래 accent 의 밝기·채도다', () => {
  const out = seedTheme(TOKYO, RED);
  const a0 = oklchOf(TOKYO.ui.accent), a = oklchOf(out.ui.accent), s = oklchOf(RED);
  assert.ok(Math.abs(hueDelta(s.h, a.h)) <= 1, `h ${a.h} vs ${s.h}`);
  assert.ok(Math.abs(a.L - a0.L) <= 0.01);
  assert.ok(Math.abs(a.C - a0.C) <= 0.01);
});

test('TC-SEED-3: 테마색은 Δ 만큼 돌고 밝기가 유지된다. 무채색은 그대로다', () => {
  const out = seedTheme(TOKYO, RED);
  const D = hueDelta(oklchOf(TOKYO.ui.accent).h, oklchOf(RED).h);
  let checked = 0;
  for (const [sec, keys] of [['ui', ctx.SEED_THEME_UI_KEYS], ['terminal', ctx.SEED_THEME_TERM_KEYS]]) {
    for (const k of keys) {
      const raw = TOKYO[sec][k];
      if (k === 'accent' || !/^#[0-9a-f]{6}$/i.test(raw || '')) continue;
      const o0 = oklchOf(raw), o = oklchOf(out[sec][k]);
      assert.ok(Math.abs(o.L - o0.L) <= 0.01, `${sec}.${k} L`);
      if (o0.C < ctx.SEED_MIN_CHROMA) { assert.equal(out[sec][k], raw, `${sec}.${k} 무채색`); continue }
      // 색역 맞춤으로 채도가 줄 수는 있어도 색상은 Δ 를 따른다. 채도가 낮으면 8비트 반올림이 색상을 더 흔든다
      assert.ok(Math.abs(hueDelta(o0.h + D, o.h)) <= (o0.C < 0.05 ? 6 : 2), `${sec}.${k} h ${o0.h}+${D} → ${o.h}`);
      checked++;
    }
  }
  assert.ok(checked >= 8, `잰 색 ${checked}개`);
  assert.ok(ctx.SEED_THEME_UI_KEYS.includes('bg') && ctx.SEED_THEME_TERM_KEYS.includes('background'));
});

test('TC-SEED-4: 의미색은 새 accent 쪽으로 min(차/2, 15°) 만 옮긴다', () => {
  assert.equal(ctx.SEED_HARMONY_MAX, 15);
  const out = seedTheme(TOKYO, RED);
  const ah = oklchOf(out.ui.accent).h;
  const keys = [['ui', 'danger'], ...ctx.SEED_MEANING_TERM_KEYS.map((k) => ['terminal', k])];
  assert.ok(keys.length === 17);
  let moved = 0;
  for (const [sec, k] of keys) {
    const raw = TOKYO[sec][k];
    const o0 = oklchOf(raw), o = oklchOf(out[sec][k]);
    if (o0.C < ctx.SEED_MIN_CHROMA) { assert.equal(out[sec][k], raw, k); continue }
    const d = hueDelta(o0.h, ah);
    const want = Math.sign(d) * Math.min(Math.abs(d) / 2, 15);
    assert.ok(Math.abs(hueDelta(o0.h + want, o.h)) <= 2, `${k}: ${o0.h} → ${o.h}, 기대 ${o0.h + want}`);
    assert.ok(Math.abs(o.L - o0.L) <= 0.01, `${k} L`);
    if (Math.abs(want) > 3) moved++;
  }
  assert.ok(moved >= 4);
});

test('TC-SEED-5: 변환된 테마는 accent2 명시값이 없고 --accent2 는 변환 팔레트에서 고른다', () => {
  const out = seedTheme(TOKYO, RED);
  assert.equal(out.ui.accent2, undefined);
  assert.equal(themeVarsOf(out)['--accent2'], pickAccent2(out));
});

test('TC-SEED-6: 알파가 붙은 값은 알파를 보존하고, 읽지 못하는 값은 그대로다', () => {
  const t = clone(TOKYO);
  t.terminal.selectionBackground = '#33467c80';
  t.terminal.cursorAccent = 'transparent';
  const out = seedTheme(t, RED);
  assert.match(out.terminal.selectionBackground, /^#[0-9a-f]{6}80$/);
  assert.notEqual(out.terminal.selectionBackground, '#33467c80');
  assert.equal(out.terminal.cursorAccent, 'transparent');
});

test('TC-SEED-6: 54종 × 8 색상 결과가 모두 #rrggbb(aa) 이다', () => {
  for (const [n, th] of Object.entries(THEMES)) {
    for (let h = 0; h < 360; h += 45) {
      const out = seedTheme(th, hexOfOklch(0.65, 0.15, h));
      for (const sec of ['ui', 'terminal']) {
        for (const [k, v] of Object.entries(out[sec])) {
          if (/^#/.test(th[sec][k] || '')) assert.match(v, /^#[0-9a-f]{6}([0-9a-f]{2})?$/i, `${n} ${h} ${sec}.${k}`);
        }
      }
    }
  }
});

test('TC-SEED-11: 변환 시간 기록 (실패 조건 아님)', () => {
  const names = Object.keys(THEMES);
  const t0 = performance.now();
  for (const n of names) seedTheme(THEMES[n], RED);
  const per = (performance.now() - t0) / names.length;
  console.log(`seedTheme 평균 ${per.toFixed(3)}ms/테마`);
});

// REFACTOR3_FE_REST1_SRS FR-FR1-3 (FC-03): 메인색 변환 결과의 알림색·실행 중 색도 redmean 거리로 고른다.
//   이전 동작: Nord 를 색상 135° 로 돌리면 알림색 #ddd18c, 실행 중 색 #ba8da3
//   새  동작: 알림색 #ba8da3, 실행 중 색 #79a4bd / 이유: 거리 한 벌(SRS §7 부록의 한 줄)
test('TC-FR1-2: 메인색 변환 결과의 알림색·실행 중 색은 redmean 거리로 고른다', () => {
  const nord = THEMES.Nord;
  const a0 = oklchOf(nord.ui.accent);
  const out = seedTheme(nord, hexOfOklch(a0.L, Math.max(a0.C, 0.1), 135));
  assert.equal(ctx.pickAttnColor(out), '#ba8da3');
  assert.equal(pickAccent2(out), '#79a4bd');
});

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { BASE, MOBILE, PANELS, load } from './harness.mjs';

/**
 * REFACTOR3_DEFECTS_SRS 묶음 A·I (프론트).
 */
const theme = () => load(['core/contrast.js', 'ui/themes.js', 'ui/themes-catalog.js', 'core/theme-vars.js'], {
  globals: { TOPTS: {}, t: (k) => k },
  expose: ['THEMES', 'sanitizeCustomTheme'],
});

test('TC-RD3-1: 색이 아닌 값은 기본 테마 값이 된다', () => {
  const c = theme();
  const base = c.THEMES['Tokyo Night'];
  const got = c.sanitizeCustomTheme({
    mode: 'light',
    ui: { bg: '#112233', sidebarBg: '#000" onmouseover="x', border: 'url(evil)', accent: 7, text: { a: 1 } },
    terminal: { background: '#AABBCCDD', foreground: '"><img src=x>' },
  });
  assert.equal(got.mode, 'light');
  assert.equal(got.ui.bg, '#112233');
  assert.equal(got.ui.sidebarBg, base.ui.sidebarBg);
  assert.equal(got.ui.border, base.ui.border);
  assert.equal(got.ui.accent, base.ui.accent);
  assert.equal(got.ui.text, base.ui.text);
  assert.equal(got.terminal.background, '#AABBCCDD');
  assert.equal(got.terminal.foreground, base.terminal.foreground);
  for (const sec of ['ui', 'terminal']) {
    for (const v of Object.values(got[sec])) assert.match(v, /^#[0-9a-f]{6}([0-9a-f]{2})?$/i);
  }
});

test('TC-RD3-1: 객체가 아니면 null, mode 가 이상하면 dark, 모르는 칸은 싣지 않는다', () => {
  const c = theme();
  assert.equal(c.sanitizeCustomTheme(null), null);
  assert.equal(c.sanitizeCustomTheme('x'), null);
  assert.equal(c.sanitizeCustomTheme([1]), null);
  const got = c.sanitizeCustomTheme({ mode: '<b>', ui: 'nope', extra: { a: '#000000' } });
  assert.equal(got.mode, 'dark');
  assert.equal(got.extra, undefined);
  assert.equal(JSON.stringify(got.ui), JSON.stringify(c.THEMES['Tokyo Night'].ui));
});

test('TC-RD3-2: 내장 테마 54종은 그대로 통과한다', () => {
  const c = theme();
  const names = Object.keys(c.THEMES);
  assert.equal(names.length, 54);
  for (const n of names) {
    const t = c.THEMES[n];
    const got = c.sanitizeCustomTheme(JSON.parse(JSON.stringify(t)));
    assert.equal(got.mode, t.mode, n);
    for (const sec of ['ui', 'terminal']) {
      for (const [k, v] of Object.entries(t[sec])) assert.equal(got[sec][k], v, n + ' ' + sec + '.' + k);
    }
  }
});

test('TC-RD3-80: 서랍을 닫으면 상단바를 다시 그린다', () => {
  const cls = { toggle() {}, remove() {}, contains: () => false };
  // REFACTOR3_FE_BASE_SRS FR-FEB-25 로 개정: 이전 — 열림은 필드 `drawerOpen` 이었다 / 지금 — `#sidebar.open` 하나이고 필드는 따라온다 /
  // 이유 — 서랍 상태가 세 자리에서 따로 바뀌었다(FC-02). 그래서 열린 서랍은 `#sidebar` 의 표식으로 준다.
  const open = new Set(['open']);
  const sidebar = { classList: { contains: (k) => open.has(k), toggle: (k, on) => { if (on) open.add(k); else open.delete(k) } } };
  const c = load([...BASE, ...PANELS, ...MOBILE], {
    globals: {
      App: class {}, TIMERS: { disposeOwner() {} },
      document: { body: { classList: cls }, getElementById: (id) => (id === 'sidebar' ? sidebar : null) },
    },
    expose: ['App', 'MobileController'],
  });
  let drawn = 0;
  const app = Object.assign(Object.create(c.App.prototype), {
    isMobile: true, drawerOpen: true, renderer: { _rTopbar: () => { drawn++ } },
  });
  app.mobile = new c.MobileController(app);   // REFACTOR3_FE_APPCTL_SRS 9c
  app.mobile.sheets.mobileChromeSync = () => {};
  app.mobile._toggleDrawer(false);
  assert.equal(app.drawerOpen, false);
  assert.equal(drawn, 1);
});

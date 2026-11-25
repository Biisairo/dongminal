import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { BASE, SETTINGS, load } from './harness.mjs';

const JS_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * PERF 3.4.12.6 — 테마 카탈로그 분할 (M3_BOOT_SCOPE §3·§6).
 *   부팅 표는 기본 두 테마(Tokyo Night·GitHub Light)뿐이고 나머지는 `themes` 묶음이다. `_settingsApply` 는 적용할
 *   이름이 부팅 표에 없으면 묶음을 실은 뒤 얹는다. 설정 창(`settings`)은 `needs:['themes']` 다.
 */
const TN = { mode: 'dark', ui: { bg: '#1a1b26' }, terminal: {} };
const GL = { mode: 'light', ui: { bg: '#ffffff' }, terminal: {} };
const DR = { mode: 'dark', ui: { bg: '#282a36' }, terminal: {} };

function fakeScreens() {
  const S = {
    regs: new Map(), calls: [], _ready: new Set(), pending: null,
    register(name, opt = {}) { S.regs.set(name, opt) },
    ready(name) { return S._ready.has(name) },
    load(name) {
      S.calls.push(name);
      if (!S.pending) {
        let res, rej;
        const p = new Promise((a, b) => { res = a; rej = b });
        S.pending = { p, res, rej };
      }
      return S.pending.p;
    },
  };
  return S;
}

function setup() {
  const S = fakeScreens();
  const state = { n: 1 };
  const applied = [];
  const errors = [];
  const ctx = load([...BASE, ...SETTINGS], {
    expose: ['SettingsController'],
    globals: { App: function App() {}, TIMERS: { disposeOwner() {}, refreshChanged() {} }, Screens: S },
  });
  Object.assign(ctx, {
    migrateUiFontScale() {},
    SETTINGS_SCHEMA: [{ key: 'n' }, { key: 'themeNameDark' }],
    SETTINGS_ACCESS: {
      n: { set(v) { state.n = v } },
      themeNameDark: { set(v) { if (ctx.THEMES[v]) ctx.themeNameDark = v } },
    },
    settingValue: (v) => v,
    THEMES: { 'Tokyo Night': TN, 'GitHub Light': GL },
    currentThemeName: 'Tokyo Night', customTheme: null, themeFollowSystem: false,
    themeNameDark: 'Tokyo Night', themeNameLight: 'GitHub Light',
    applyThemeObj(t) { applied.push(t) },
    I18N: { applyShortcuts() {} },
    ErrorLog: { push(...a) { errors.push(a) } },
  });
  const app = { gitPanel: null, mobile: { _mkbRender() {}, mkbRefresh() {} } };
  const c = new ctx.SettingsController(app);
  app.settings = c;
  c.paint = () => {};
  /** 묶음이 실렸다 — 카탈로그가 THEMES 를 늘리고 등록부가 실림을 기억한다. */
  const arrive = async () => {
    ctx.THEMES.Dracula = DR;
    S._ready.add('themes');
    S.pending.res();
    await new Promise((r) => setImmediate(r));
  };
  const fail = async () => {
    S.pending.rej(new Error('net'));
    S.pending = null;
    await new Promise((r) => setImmediate(r));
  };
  return { ctx, c, S, state, applied, errors, arrive, fail };
}

test('부팅 표에 있는 이름이면 묶음을 싣지 않고 그 자리에서 얹는다', () => {
  const { ctx, c, S, state, applied } = setup();
  c.apply._settingsApply({ n: 2, themeName: 'GitHub Light' }, { boot: true });
  assert.deepEqual(S.calls, []);
  assert.equal(state.n, 2);
  assert.equal(ctx.currentThemeName, 'GitHub Light');
  assert.equal(applied.at(-1), GL);
});

test('부팅 표에 없는 이름이면 themes 를 실은 뒤에 얹는다 — 그 전에는 아무것도 얹지 않는다', async () => {
  const { ctx, c, S, state, applied, arrive } = setup();
  const r = c.apply._settingsApply({ n: 2, themeName: 'Dracula' }, { boot: true });
  assert.deepEqual(S.calls, ['themes']);
  assert.ok(r && typeof r.then === 'function', '부팅이 기다릴 수 있게 프로미스를 돌려준다');
  assert.equal(state.n, 1, '실리기 전에 값을 얹지 않는다');
  assert.deepEqual(applied, [], '실리기 전에 기본 테마를 칠하지 않는다(번쩍임)');
  await arrive();
  await r;
  assert.equal(state.n, 2);
  assert.equal(ctx.currentThemeName, 'Dracula');
  assert.equal(applied.at(-1), DR);
});

test('슬롯 이름이 부팅 표에 없어도 싣는다 — 실리기 전에 얹으면 슬롯이 기본값으로 되돌아간다', async () => {
  const { ctx, c, S, arrive } = setup();
  const r = c.apply._settingsApply({ themeNameDark: 'Dracula' });
  assert.deepEqual(S.calls, ['themes']);
  await arrive();
  await r;
  assert.equal(ctx.themeNameDark, 'Dracula');
});

test('싣기가 실패해도 나머지 설정은 얹는다 — 모르는 이름은 버리고 다시 싣지 않는다', async () => {
  const { ctx, c, S, state, errors, fail } = setup();
  const r = c.apply._settingsApply({ n: 3, themeName: 'Dracula' });
  await fail();
  await r;
  assert.deepEqual(S.calls, ['themes'], '같은 적용 안에서 다시 싣지 않는다');
  assert.equal(state.n, 3);
  assert.equal(ctx.currentThemeName, 'Tokyo Night');
  assert.equal(errors.length, 1);
});

test('싣는 동안 온 적용은 앞의 적용 뒤에 차례대로 얹는다', async () => {
  const { c, state, arrive } = setup();
  c.apply._settingsApply({ n: 2, themeName: 'Dracula' });
  c.apply._settingsApply({ n: 5, themeName: 'Tokyo Night' });
  assert.equal(state.n, 1, '뒤의 적용이 앞지르지 않는다');
  await arrive();
  assert.equal(state.n, 5);
});

test('설정 창은 themes 를 needs 로 갖고, themes 는 탭 없는 라이브러리 묶음으로 등록된다', () => {
  const { S } = setup();
  assert.ok(S.regs.has('themes'));
  assert.ok(!S.regs.get('themes').tab);
  assert.ok((S.regs.get('settings').needs || []).includes('themes'));
});

test('부팅 표는 기본 두 테마뿐이고, 카탈로그를 더하면 54종이 한 번씩 선다', () => {
  const boot = load(['ui/themes.js'], { globals: { TOPTS: {} }, expose: ['THEMES'] });
  assert.deepEqual(Object.keys(boot.THEMES), ['Tokyo Night', 'GitHub Light']);
  const full = load(['ui/themes.js', 'ui/themes-catalog.js'], { globals: { TOPTS: {} }, expose: ['THEMES'] });
  const names = Object.keys(full.THEMES);
  assert.equal(names.length, 54);
  assert.equal(new Set(names).size, 54);
  const src = readFileSync(join(JS_ROOT, 'ui/themes-catalog.js'), 'utf8');
  assert.match(src, /^Object\.assign\(THEMES,\{/m, '카탈로그는 부팅 표를 늘린다');
  assert.ok(!/'Tokyo Night':|'GitHub Light':/.test(src), '기본 두 테마는 카탈로그에 두 벌로 두지 않는다');
});

test('설정 기본값의 슬롯 이름은 부팅 표에 있다 — 기본 사용자는 묶음을 받지 않는다', () => {
  const schema = readFileSync(join(JS_ROOT, 'core/settings-schema.js'), 'utf8');
  const boot = load(['ui/themes.js'], { globals: { TOPTS: {} }, expose: ['THEMES'] });
  for (const k of ['themeNameDark', 'themeNameLight']) {
    const m = schema.match(new RegExp('"key":"' + k + '","type":"string","def":"([^"]+)"'));
    assert.ok(m && boot.THEMES[m[1]], k);
  }
});

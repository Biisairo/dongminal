import assert from 'node:assert/strict';
import { test } from 'node:test';

import { BASE, SETTINGS, load, plain } from './harness.mjs';

/**
 * REFACTOR3_FE_SETTINGS_SRS — 설정 탭 하나 = `SettingsSection` 하위 하나, 단순한 행 = `FormRow`.
 *   TC-FES-1 섹션 기반 · TC-FES-2 FormRow · TC-FES-3 옮긴 섹션의 계층과 App 에서 사라진 `_init*`
 *
 * 하위 단계마다 `MOVED` 에 한 줄을 더한다.
 */

/** 이벤트를 손으로 쏘는 최소 원소. */
function elem(id, extra) {
  const ls = {};
  return {
    id, value: '', checked: false, parentNode: null, style: { setProperty() {} }, dataset: {}, attrs: {},
    listeners: ls,
    addEventListener(t, fn) { (ls[t] ||= []).push(fn) },
    removeEventListener(t, fn) { ls[t] = (ls[t] || []).filter((f) => f !== fn) },
    fire(t) { for (const fn of ls[t] || []) fn({ target: this }) },
    setAttribute(k, v) { this.attrs[k] = String(v) },
    querySelector: () => null,
    ...extra,
  };
}

/** 기반·행·섹션을 싣는다. 값의 길(`SETTINGS_ACCESS`)은 시험이 준다. */
function setup(access, els) {
  const doc = { activeElement: null, getElementById: (id) => els[id] || null };
  const ctx = load([...BASE, ...SETTINGS], {
    expose: ['SettingsSection', 'FormRow', 'View', 'DisplaySection', 'TerminalSection', 'CodeSection'],
    globals: {
      TIMERS: { disposeOwner() {} },
      SETTINGS_ACCESS: access,
      SETTINGS_BY_KEY: { n: { def: 7 }, w: { def: 160 }, c: { def: false } },
      clampSetting: (_k, v) => Math.min(20, Math.max(1, Number(v) || 7)),
    },
  });
  ctx.document = doc;
  return { ctx, doc };
}

/** 부른 순서를 남기는 가짜 앱. */
function fakeApp(log) {
  return {
    saveSettings: () => log.push('save'),
    _saveSettingsSoon: (k) => log.push('soon:' + k),
    _saveSettingsNow: (k) => log.push('now:' + k),
  };
}

// ── TC-FES-1 SettingsSection ─────────────────────────────────────────────

test('TC-FES-1: SettingsSection 은 View 하위이고 #panel-<tab> 을 adopt 하며 dispose 가 떼지 않는다', () => {
  const panel = elem('panel-display', { parentNode: { removeChild() { throw new Error('떼었다') } } });
  const { ctx } = setup({}, { 'panel-display': panel });
  const app = fakeApp([]);
  const s = new ctx.SettingsSection(app, 'display');
  assert.ok(s instanceof ctx.View);
  assert.equal(s.app, app);
  assert.equal(s.tab, 'display');
  assert.equal(s.el, panel);
  for (const hook of ['init', 'onOpen', 'onTab', 'paint']) assert.equal(s[hook](), undefined, hook);
  s.dispose();
  assert.equal(s.disposed, true);
});

test('TC-FES-1: 섹션은 앱별로 등록되고 of·all 로 찾는다 (8e 전까지의 자리)', () => {
  const { ctx } = setup({}, {});
  const a = fakeApp([]), b = fakeApp([]);
  const s = ctx.SettingsSection.start(a, new ctx.SettingsSection(a, 'display'));
  assert.equal(ctx.SettingsSection.of(a, 'display'), s);
  assert.equal(ctx.SettingsSection.of(b, 'display'), null);
  assert.deepEqual(plain(ctx.SettingsSection.all(a).map((x) => x.tab)), ['display']);
  assert.equal(ctx.SettingsSection.all(b).length, 0);
});

// ── TC-FES-2 FormRow ─────────────────────────────────────────────────────

test('TC-FES-2: check 행은 바꾸면 set(this=app) → after → 곧바로 저장', () => {
  const log = [];
  const cb = elem('ds-c');
  let self = null;
  const access = { c: { get: () => true, set(v) { self = this; log.push('set:' + v) } } };
  const { ctx } = setup(access, { 'ds-c': cb });
  const app = fakeApp(log);
  const s = new ctx.SettingsSection(app, 'x');
  new ctx.FormRow({ key: 'c', id: 'ds-c', kind: 'check', after() { log.push('after') } }).bind(s);
  cb.checked = true;
  cb.fire('change');
  assert.deepEqual(log, ['set:true', 'after', 'save']);
  assert.equal(self, app);
});

test('TC-FES-2: number 행은 input 에 자른 값으로 set → after → 미룬 저장, blur 에 쓰이는 값으로 고치고 곧바로 저장', () => {
  const log = [];
  const num = elem('ds-n');
  let cur = 7;
  const access = { n: { get: () => cur, set(v) { cur = v; log.push('set:' + v) } } };
  const { ctx } = setup(access, { 'ds-n': num });
  const s = new ctx.SettingsSection(fakeApp(log), 'x');
  new ctx.FormRow({ key: 'n', id: 'ds-n', kind: 'number', after() { log.push('after') } }).bind(s);
  num.value = '99';
  num.fire('input');
  assert.equal(num.value, '99', '입력 중에는 입력란의 글자를 고치지 않는다');
  num.fire('blur');
  assert.equal(num.value, '20');
  assert.deepEqual(log, ['set:20', 'after', 'soon:ds-n', 'now:ds-n']);
});

test('TC-FES-2: paint 는 get 값(없으면 기본값)을 칠하고, guard 행만 포커스를 쥔 입력란을 건너뛴다', () => {
  const cb = elem('ds-c'), num = elem('ds-n'), w = elem('ds-w');
  let n;
  const access = { c: { get: () => 1 }, n: { get: () => n }, w: { get: () => 300 } };
  const { ctx, doc } = setup(access, { 'ds-c': cb, 'ds-n': num, 'ds-w': w });
  const s = new ctx.SettingsSection(fakeApp([]), 'x');
  const rows = [
    new ctx.FormRow({ key: 'c', id: 'ds-c', kind: 'check' }).bind(s),
    new ctx.FormRow({ key: 'n', id: 'ds-n', kind: 'number' }).bind(s),
    new ctx.FormRow({ key: 'w', id: 'ds-w', kind: 'number', guard: true }).bind(s),
  ];
  for (const r of rows) r.paint();
  assert.equal(cb.checked, true);
  assert.equal(num.value, '7', 'get 이 undefined 면 표의 기본값');
  assert.equal(w.value, '300');
  n = 12; w.value = '9'; num.value = '9';
  doc.activeElement = w;
  for (const r of rows) r.paint();
  assert.equal(w.value, '9', 'guard 행은 치는 중인 글자를 덮지 않는다');
  doc.activeElement = num;
  for (const r of rows) r.paint();
  assert.equal(num.value, '12', 'guard 가 없는 행은 지금처럼 덮는다 (D-FES-2)');
});

test('TC-FES-2: 행의 리스너는 섹션이 주인이다 — dispose 가 뗀다', () => {
  const cb = elem('ds-c'), num = elem('ds-n');
  const access = { c: { get: () => 0, set() {} }, n: { get: () => 1, set() {} } };
  const { ctx } = setup(access, { 'ds-c': cb, 'ds-n': num });
  const s = new ctx.SettingsSection(fakeApp([]), 'x');
  s.bindRows([{ key: 'c', id: 'ds-c', kind: 'check' }, { key: 'n', id: 'ds-n', kind: 'number' }, { key: 'c', id: 'ds-none', kind: 'check' }]);
  assert.equal(s.rows.length, 3);
  assert.equal(cb.listeners.change.length, 1);
  assert.equal(num.listeners.input.length + num.listeners.blur.length, 2);
  s.dispose();
  assert.equal(cb.listeners.change.length, 0);
  assert.equal(num.listeners.input.length + num.listeners.blur.length, 0);
});

// ── TC-FES-3 옮긴 섹션 ───────────────────────────────────────────────────

/** 하위 단계마다 한 줄. cls: 섹션 클래스 · tab · gone: App 원형에서 사라진 이름 · rows: FormRow 선언 [key, id, kind] */
const MOVED = [
  { cls: 'DisplaySection', tab: 'display',
    gone: ['_initTabWidth', '_initUiFontScale', '_initFgNames', '_initConfirmLeave', '_initLocale', '_initPanelLayout',
      '_initNumSetting', '_paintNumSettings'],
    rows: [['tabFixedWidth', 'ds-tabfix', 'check'], ['tabWidthPx', 'ds-tabw', 'number'], ['uiFontSize', 'ds-uifs', 'number'],
      ['fgTabNames', 'ds-fgnames', 'check'], ['confirmLeave', 'ds-confirmleave', 'check']] },
  { cls: 'TerminalSection', tab: 'terminal',
    gone: ['_initClaudeFullscreen', '_initTermGpu', '_initTermFontSize', '_initClaudeScrollSpeed', '_initMigrationSettings'],
    rows: [['claudeFullscreen', 'ds-claudefs', 'check'], ['termFontSize', 'ds-termfs', 'number'],
      ['claudeScrollSpeed', 'ds-scrollspeed', 'number'], ['migrationHook', 'ds-mighook', 'check'],
      ['migrationHookCtxPct', 'ds-mighookpct', 'number'], ['issueTreeMigration', 'ds-treemig', 'check'],
      ['issueTreeCtxPct', 'ds-treemigpct', 'number']] },
  { cls: 'CodeSection', tab: 'code', gone: ['_initWordWrap', '_initMinimap', '_initLSP'],
    rows: [['editorWordWrap', 'ds-wordwrap', 'check'], ['editorMinimap', 'ds-minimap', 'check']] },
];

/** FR-FES-9 의 위임자 가운데 이 단계까지 옮긴 파일에 있는 것. */
const DELEGATES = ['saveSettings', '_settingsApply', '_settingsRestore', '_onSettingsChanged', '_openSettings',
  '_saveSettingsSoon', '_saveSettingsNow', '_paintSettingControls', '_edApplyWordWrap', '_edApplyMinimap',
  '_edApplyFontSize', '_termApplyFontSize'];

function appProto() {
  const ctx = load(['core/app-settings.js', 'core/app-settings-init.js', 'core/app-dock.js', 'core/app-lsp.js',
    'core/lsp-client.js'], { globals: { App: function App() {} }, expose: ['LspClient'] });
  return ctx;
}

test('TC-FES-3: 옮긴 섹션의 원형 사슬에 SettingsSection·View 가 있고 탭 이름이 맞다', () => {
  const els = {};
  const { ctx } = setup({}, els);
  for (const m of MOVED) {
    const C = ctx[m.cls];
    assert.ok(C.prototype instanceof ctx.SettingsSection, m.cls);
    assert.ok(C.prototype instanceof ctx.View, m.cls);
    els['panel-' + m.tab] = elem('panel-' + m.tab);
    const s = new C(fakeApp([]));
    assert.equal(s.tab, m.tab);
    assert.equal(s.el, els['panel-' + m.tab]);
  }
});

test('TC-FES-3: 섹션이 init 에서 선언한 행이 표와 같다', () => {
  const els = {};
  const access = new Proxy({}, { get: () => ({ get: () => 0, set() {} }) });
  const { ctx } = setup(access, els);
  ctx.TermGpu = { enabled: () => false, setEnabled() {} };
  ctx.I18N = { locale: 'ko', resolve: (v) => v };
  ctx.applyTabWidth = () => {};
  ctx.applyUiFontScale = () => {};
  for (const m of MOVED) {
    const s = new ctx[m.cls]({ ...fakeApp([]), _slotDirPaint() {}, displayMode: 'auto', mobileBreakpoint: 768 });
    s.init();
    assert.deepEqual(plain(s.rows.map((r) => [r.decl.key, r.decl.id, r.decl.kind])), m.rows, m.cls);
  }
});

test('TC-FES-3: 옮긴 _init* 가 App 원형에 없고 위임자는 남는다', () => {
  const ctx = appProto();
  for (const m of MOVED) for (const n of m.gone) assert.equal(ctx.App.prototype[n], undefined, n);
  assert.equal(ctx.LspClient.prototype._initLSP, undefined, 'LspClient._initLSP');
  for (const n of DELEGATES) assert.equal(typeof ctx.App.prototype[n], 'function', n);
});

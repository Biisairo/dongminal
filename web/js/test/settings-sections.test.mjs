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
    expose: ['SettingsSection', 'FormRow', 'View', 'DisplaySection', 'TerminalSection', 'CodeSection', 'PollingSection',
      'StatusbarSection', 'NotifySection'],
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

/** 부른 순서를 남기는 가짜 앱. 섹션이 주인인 타이머는 `app.timers` 로 간다. */
function fakeApp(log) {
  return {
    saveSettings: () => log.push('save'),
    _saveSettingsSoon: (k) => log.push('soon:' + k),
    _saveSettingsNow: (k) => log.push('now:' + k),
    _attnSecurityNotice: () => log.push('tls'),
    timers: { after: (ms) => { log.push('after:' + ms); return { stop: () => log.push('stop') } }, disposeOwner() {} },
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
      '_initNumSetting', '_paintNumSettings',
      // 8b
      '_initFocusEdge', '_initAttnEdge', '_focusEdgePaintRow', '_attnEdgePaintRow', '_focusEdgePreview', '_attnEdgePreview'],
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
  // 8b — 특이 행은 섹션 메서드다(FR-FES-4). `initPollingSettings` 는 8e 까지 섹션을 세우는 입구로 남는다.
  { cls: 'PollingSection', tab: 'polling', gone: ['_pollPaintRows'], rows: [] },
  { cls: 'StatusbarSection', tab: 'statusbar', gone: ['_renderStatusBarSettings'], rows: [] },
  { cls: 'NotifySection', tab: 'notify', gone: ['initUpdateSettings'], rows: [] },
];

/** FR-FES-9 의 위임자 가운데 이 단계까지 옮긴 파일에 있는 것. */
const DELEGATES = ['saveSettings', '_settingsApply', '_settingsRestore', '_onSettingsChanged', '_openSettings',
  '_saveSettingsSoon', '_saveSettingsNow', '_paintSettingControls', '_edApplyWordWrap', '_edApplyMinimap',
  '_edApplyFontSize', '_termApplyFontSize'];

function appProto() {
  const ctx = load(['core/app-settings.js', 'core/app-settings-init.js', 'core/app-dock.js', 'core/app-lsp.js',
    'core/lsp-client.js', 'core/app-polling.js', 'core/app-statusbar.js', 'core/app-update.js', 'core/app-attn.js'],
  { globals: { App: function App() {}, t: (k) => k, tn: (k) => k }, expose: ['LspClient'] });
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
  Object.assign(ctx, { focusEdgeLevel: 0, attnEdgeLevel: 0, UFE_LEVEL_MAX: 10, ATTN_EDGE_LEVEL_MAX: 10 });
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

// ── 8b 특이 행 (FR-FES-4) ────────────────────────────────────────────────

/** `documentElement` 의 클래스를 세는 대역. */
function rootClasses() {
  const on = new Set();
  return { on, classList: { add: (c) => on.add(c), remove: (c) => on.delete(c) } };
}

function edgeSetup() {
  const fill = {};
  const range = (id) => elem(id, { style: { setProperty: (k, v) => { fill[id] = v } } });
  const els = { 'ds-focusedge': range('ds-focusedge'), 'ds-focusedge-val': elem('ds-focusedge-val'),
    'ds-attnedge': range('ds-attnedge'), 'ds-attnedge-val': elem('ds-attnedge-val') };
  const { ctx, doc } = setup({}, els);
  doc.documentElement = rootClasses();
  Object.assign(ctx, { focusEdgeLevel: 0, attnEdgeLevel: 4, UFE_LEVEL_MAX: 10, ATTN_EDGE_LEVEL_MAX: 10,
    UFE_LEVEL_OFF_LABEL: 'off', UFE_PREVIEW_CLASS: 'ufe-p', ATTN_EDGE_PREVIEW_CLASS: 'ae-p', UFE_PREVIEW_MS: 900,
    ATTN_EDGE_PREVIEW_MS: 800 });
  return { ctx, doc, els, fill };
}

test('TC-FES-2(범위): 레인지 두 행은 값·채움·라벨을 칠하고 0 은 「끔」 이다', () => {
  const { ctx, els, fill } = edgeSetup();
  const s = new ctx.DisplaySection(fakeApp([]));
  s.paint();
  assert.equal(els['ds-focusedge'].value, 0);
  assert.equal(fill['ds-focusedge'], '0%');
  assert.equal(els['ds-focusedge-val'].textContent, 'off');
  assert.equal(els['ds-attnedge'].value, 4);
  assert.equal(fill['ds-attnedge'], '40%');
  assert.equal(els['ds-attnedge-val'].textContent, '4');
});

test('TC-FES-2(범위): 포커스 가장자리 input 은 값·두 행·화면·미리보기·미룬 저장, change 는 곧바로 저장', () => {
  const { ctx, doc, els } = edgeSetup();
  const log = [];
  const app = { ...fakeApp(log), _paintFocusEdge: () => log.push('paintFocus') };
  const s = new ctx.DisplaySection(app);
  s._initFocusEdge();
  assert.equal(els['ds-focusedge'].max, 10);
  els['ds-focusedge'].value = '3';
  els['ds-focusedge'].fire('input');
  assert.equal(ctx.focusEdgeLevel, 3);
  assert.equal(els['ds-focusedge-val'].textContent, '3');
  assert.equal(els['ds-attnedge-val'].textContent, '4', '주의 행도 함께 칠한다');
  assert.ok(doc.documentElement.on.has('ufe-p'));
  els['ds-focusedge'].fire('change');
  assert.deepEqual(log, ['paintFocus', 'after:900', 'soon:ufe', 'now:ufe']);
});

test('TC-FES-2(범위): 주의 가장자리 input 은 화면·미리보기·주의 다시 보기·미룬 저장, 0 이면 미리보기를 끈다', () => {
  const { ctx, doc, els } = edgeSetup();
  const log = [];
  const app = { ...fakeApp(log), _paintAttnEdge: () => log.push('paintAttn'), _attnRefresh: () => log.push('refresh') };
  const s = new ctx.DisplaySection(app);
  s._initAttnEdge();
  els['ds-attnedge'].value = '6';
  els['ds-attnedge'].fire('input');
  assert.equal(ctx.attnEdgeLevel, 6);
  assert.ok(doc.documentElement.on.has('ae-p'));
  els['ds-attnedge'].value = '0';
  els['ds-attnedge'].fire('input');
  assert.equal(els['ds-attnedge-val'].textContent, 'off');
  assert.ok(!doc.documentElement.on.has('ae-p'));
  els['ds-attnedge'].fire('change');
  assert.deepEqual(log, ['paintAttn', 'after:800', 'refresh', 'soon:ae', 'paintAttn', 'stop', 'refresh', 'soon:ae', 'now:ae']);
});

test('8b: PollingSection 은 표에서 행을 한 번 만들고, 고르면 값·저장·타이머 재무장, paint 는 표의 값을 칠한다', () => {
  const box = elem('poll-settings');
  const made = [];
  box.appendChild = (c) => { made.push(c); return c };
  const { ctx } = setup({}, { 'poll-settings': box });
  let v = 2000;
  const log = [];
  ctx.POLL_SETTINGS = [{ key: 'k', id: 'pi-k', label: 'L', hint: 'H', get: () => v, set: (x) => { v = x; log.push('set:' + x) },
    opts: [[1000, 'a'], [2000, 'b']] }];
  ctx.SETTINGS_BY_KEY.k = { def: 2000 };
  ctx.settingValue = (raw) => raw;
  ctx.TIMERS = { disposeOwner() {}, refreshChanged: () => log.push('refresh') };
  ctx.document.createElement = (tag) => elem('', { tag, children: [], appendChild(c) { this.children.push(c); return c } });
  const els = {};
  ctx.document.getElementById = (id) => (id === 'poll-settings' ? box : els[id] || null);
  const s = new ctx.PollingSection(fakeApp(log));
  s.init();
  const sel = made[0].children[1];
  els['pi-k'] = sel;
  assert.equal(sel.id, 'pi-k');
  assert.equal(sel.children.length, 2);
  assert.equal(box.dataset.built, '1');
  s.init();
  assert.equal(made.length, 2, '두 번 만들지 않는다 (행 + 안내)');
  s.paint();
  assert.equal(sel.value, '2000');
  sel.value = '1000';
  sel.fire('change');
  assert.deepEqual(log, ['set:1000', 'save', 'refresh']);
});

test('8b: NotifySection 은 데스크톱·소리 토글과 판 확인을 배선하고 TLS 안내를 그 사이에 부른다', () => {
  const dt = elem('attn-desktop'), sd = elem('attn-sound'), up = elem('ds-update-check');
  const { ctx } = setup({}, { 'attn-desktop': dt, 'attn-sound': sd, 'ds-update-check': up });
  const log = [];
  const app = { ...fakeApp(log), attnDesktop: true, attnSound: false };
  const s = new ctx.NotifySection(app);
  s.init();
  assert.equal(dt.checked, true);
  assert.equal(sd.checked, false);
  assert.deepEqual(log, ['tls']);
  sd.checked = true;
  sd.fire('change');
  assert.equal(app.attnSound, true);
  ctx.Notification = { permission: 'granted' };
  dt.checked = false;
  dt.fire('change');
  assert.equal(app.attnDesktop, false);
  assert.equal(up.listeners.change.length, 1);
});

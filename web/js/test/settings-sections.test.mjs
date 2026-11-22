import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
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
  const doc = { activeElement: null, getElementById: (id) => els[id] || null, querySelector: () => null };
  const ctx = load([...BASE, ...SETTINGS], {
    expose: ['SettingsSection', 'FormRow', 'View', 'DisplaySection', 'TerminalSection', 'CodeSection', 'PollingSection',
      'StatusbarSection', 'NotifySection', 'ProfileSection', 'ServerSection', 'SandboxSection', 'TelegramSection',
      'AccessSection', 'EdgesSection', 'ClaudeSection', 'ThemeSection', 'ShortcutsSection', 'PresetsSection', 'BackupSection',
      'SettingsController'],
    globals: {
      App: function App() {}, TIMERS: { disposeOwner() {} },
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
    // 저장의 껍데기는 `settings.apply` 에 있다 (REFACTOR3_FE_DELEG_SRS).
    settings: {
      apply: {
        saveSettings: () => log.push('save'),
        _saveSettingsSoon: (k) => log.push('soon:' + k),
        _saveSettingsNow: (k) => log.push('now:' + k),
      },
      paint: () => log.push('paint'),
    },
    timers: { after: (ms) => { log.push('after:' + ms); return { stop: () => log.push('stop') } }, disposeOwner() {} }, attn: { _attnSecurityNotice: () => log.push('tls') },
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

test('TC-FES-1: 섹션은 컨트롤러가 든다 — start 가 등록하고 init 을 부르며 section·all 로 찾는다 (8e)', () => {
  const { ctx } = setup({}, {});
  const a = fakeApp([]);
  const ca = new ctx.SettingsController(a), cb = new ctx.SettingsController(fakeApp([]));
  const sec = new ctx.SettingsSection(a, 'display');
  let inits = 0;
  sec.init = () => { inits++ };
  assert.equal(ca.start(sec), sec);
  assert.equal(inits, 1);
  assert.equal(ca.section('display'), sec);
  assert.equal(cb.section('display'), null);
  assert.deepEqual(plain(ca.all().map((x) => x.tab)), ['display']);
  assert.equal(cb.all().length, 0);
  assert.equal(ctx.SettingsSection.start, undefined, '정적 등록부가 남았다');
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
    gone: ['_initClaudeFullscreen', '_initTermGpu', '_initTermFontSize', '_initClaudeScrollSpeed', '_initMigrationSettings',
      // 8d — 모바일 키바 구역
      '_initKeybarSettings', '_keybarDraft', '_keybarSet', '_keybarPaint'],
    rows: [['claudeFullscreen', 'ds-claudefs', 'check'], ['termFontSize', 'ds-termfs', 'number'],
      ['claudeScrollSpeed', 'ds-scrollspeed', 'number'], ['migrationHook', 'ds-mighook', 'check'],
      ['migrationHookCtxPct', 'ds-mighookpct', 'number'], ['issueTreeMigration', 'ds-treemig', 'check'],
      ['issueTreeCtxPct', 'ds-treemigpct', 'number']] },
  { cls: 'CodeSection', tab: 'code', gone: ['_initWordWrap', '_initMinimap', '_initLSP'],
    rows: [['editorWordWrap', 'ds-wordwrap', 'check'], ['editorMinimap', 'ds-minimap', 'check']] },
  // 8b — 특이 행은 섹션 메서드다(FR-FES-4). 섹션을 세우던 입구(`initPollingSettings` 등)는 8e 에서 컨트롤러로 갔다(TC-FES-4).
  { cls: 'PollingSection', tab: 'polling', gone: ['_pollPaintRows'], rows: [] },
  { cls: 'StatusbarSection', tab: 'statusbar', gone: ['_renderStatusBarSettings'], rows: [] },
  { cls: 'NotifySection', tab: 'notify', gone: ['initUpdateSettings'], rows: [] },
  // 8c — 서버 자원 패널. 설정 밖·저장 단추 판정이 부르는 이름은 섹션에서 부른다(`ROUTES`).
  { cls: 'ProfileSection', tab: 'profile', rows: [],
    gone: ['_pfPaint', '_pfApply', '_loadProfilePanel', '_profileSave', '_initProfilePanel', '_profileOnSettingsOpen'] },
  { cls: 'ServerSection', tab: 'server', rows: [],
    gone: ['_srvPaint', '_loadServerPanel', '_srvChanges', '_srvApply', '_serverMoveTo', '_initServerPanel'] },
  { cls: 'SandboxSection', tab: 'sandbox', rows: [], gone: ['_sbxMountRow', '_loadSandboxPanel', '_initSandboxPanel'] },
  { cls: 'TelegramSection', tab: 'telegram', rows: [],
    gone: ['_tgPaint', '_tgPairPaint', '_tgApply', '_tgPairShown', '_initTelegramPanel'] },
  { cls: 'AccessSection', tab: 'access', rows: [],
    gone: ['_aclRow', '_aclRowsIn', '_aclHostRow', '_loadAccessPanel', '_aclSave', '_initAccessPanel'] },
  { cls: 'EdgesSection', tab: 'edges', rows: [],
    gone: ['_egKeepEditing', '_egInvitePaint', '_egEdgesPaint', '_egEdgeRow', '_egRemoveConfirm', '_egRemove',
      '_loadEdgesPanel', '_egInviteShown', '_initEdgesPanel'] },
  { cls: 'ClaudeSection', tab: 'claude', rows: [],
    gone: ['_cacctOnSettingsOpen', '_cacctEditing', '_cacctWireEditing', '_loadClaudePanel', '_cacctDo', '_cacctAdd',
      '_cacctItem', '_cacctAsk', '_cacctAccountRow', '_cacctAutoEl', '_cacctFoldersEl', '_cacctUnclaimedEl',
      '_cacctHistoryEl', '_cacctPaint'] },
  // 8d — 테마·단축키·프리셋·백업. 키바는 `TerminalSection` 이다(위). `init: false` 는 그 탭의 요소가 없으면 init 이 설 수 없는 섹션이다.
  { cls: 'ThemeSection', tab: 'theme', rows: [],
    gone: ['_initThemeFollow', '_renderSeedRow', '_seedChanged', '_paintSeedHint', '_renderThemePanel', '_renderPreview',
      '_colorInput'] },
  { cls: 'ShortcutsSection', tab: 'shortcuts', rows: [], gone: ['_renderShortcutList', '_cancelRecording'] },
  { cls: 'PresetsSection', tab: 'presets', rows: [], init: false,
    gone: ['_presetSource', '_deletePreset', '_renamePreset', '_describeLayout', '_presetMsg'] },
  { cls: 'BackupSection', tab: 'backup', rows: [],
    gone: ['_bkStore', '_bkCollect', '_bkFileName', '_bkMsg', '_bkExport', '_bkParse', '_bkPreview', '_bkCancel', '_bkApply',
      '_bkReset', '_bkRevList', '_bkRevert', '_initBackup'] },
];

/** 위임자를 걷은 이름 — App 원형에 없다 (REFACTOR3_FE_DELEG_SRS §2.3). */
const DELEGATES_DONE = ['saveSettings', '_settingsApply', '_settingsRestore', '_onSettingsChanged', '_openSettings',
  '_saveSettingsSoon', '_saveSettingsNow', '_paintSettingControls', '_edApplyWordWrap', '_edApplyMinimap',
  '_edApplyFontSize', '_termApplyFontSize', '_onAccessChanged', '_onSandboxChanged', '_onServerMoving', '_edgesPaint',
  '_egNodePaint', '_egMeshPaint', '_egInvitesPaint', '_egNotify', '_cacctPanelShown', '_cacctRefreshSoft',
  '_loadTelegramPanel', '_tgRead', '_pfCollect', '_pfFollow', '_sbxCollect', '_aclCollect', '_egNodeCollect',
  'themeSlots', 'setThemeSlots', '_showCustomEditor', '_hideCustomEditor', '_renderPresets', '_savePreset',
  '_applyThemeChoice', '_keybarApply', 'initModal'];

/** 8c 의 위임자 → 섹션 탭과 섹션 메서드. 위임자는 인자를 그대로 넘기고 답을 그대로 돌려준다. */
const ROUTES = [
  ['_onAccessChanged', 'access', '_onAccessChanged'], ['_onSandboxChanged', 'sandbox', '_onSandboxChanged'],
  ['_onServerMoving', 'server', '_onServerMoving'], ['_edgesPaint', 'edges', '_edgesPaint'],
  ['_egNodePaint', 'edges', '_egNodePaint'], ['_egNodeCollect', 'edges', '_egNodeCollect'],
  ['_cacctPanelShown', 'claude', '_cacctPanelShown'], ['_cacctRefreshSoft', 'claude', '_cacctRefreshSoft'],
  ['_loadTelegramPanel', 'telegram', '_loadTelegramPanel'], ['_tgRead', 'telegram', '_tgRead'],
  ['_pfCollect', 'profile', '_pfCollect'], ['_pfFollow', 'profile', '_pfFollow'], ['_sbxCollect', 'sandbox', '_sbxCollect'],
  ['_aclCollect', 'access', '_aclCollect'],
  // 8d
  ['themeSlots', 'theme', 'themeSlots'], ['setThemeSlots', 'theme', 'setThemeSlots'],
  ['_showCustomEditor', 'theme', '_showCustomEditor'], ['_hideCustomEditor', 'theme', '_hideCustomEditor'],
  ['_renderPresets', 'presets', '_renderPresets'], ['_savePreset', 'presets', '_savePreset'],
];

const JS_ROOT = new URL('..', import.meta.url).pathname;

/**
 * App 원형에 메서드를 얹는 파일들(`Object.assign(App.prototype`)에서 정의된 이름과 위임자 표(`Controller.delegate(App`,
 * 섹션 위임자 표 `SETTINGS_SECTION_DELEGATES` — REFACTOR3_FE_APPCTL_SRS 9a)의 이름. 섹션 파일은 클래스라 빠진다.
 */
function appMixinNames() {
  const out = new Set();
  const walk = (d) => {
    for (const n of readdirSync(d)) {
      const f = join(d, n);
      if (statSync(f).isDirectory()) { if (n !== 'test' && n !== 'vendor') walk(f); continue }
      if (!n.endsWith('.js')) continue;
      const src = readFileSync(f, 'utf8');
      for (const t of src.matchAll(/Controller\.delegate\(App,[\s\S]*?\[([\s\S]*?)\]\);/g)) {
        for (const m of t[1].matchAll(/'([^']+)'/g)) out.add(m[1]);
      }
      const sec = src.match(/const SETTINGS_SECTION_DELEGATES=\{([\s\S]*?)\};/);
      if (sec) for (const m of sec[1].matchAll(/'([^']+)'/g)) out.add(m[1]);
      if (!src.includes('Object.assign(App.prototype')) continue;
      for (const m of src.matchAll(/^ {2}(?:async\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/gm)) out.add(m[1]);
    }
  };
  walk(JS_ROOT);
  return out;
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
    if (m.init !== false) s.init();
    assert.deepEqual(plain(s.rows.map((r) => [r.decl.key, r.decl.id, r.decl.kind])), m.rows, m.cls);
  }
});

test('TC-FES-3: 옮긴 _init* 와 위임자가 App 원형에 없다 (REFACTOR3_FE_DELEG_SRS)', () => {
  const names = appMixinNames();
  for (const m of MOVED) for (const n of m.gone) assert.ok(!names.has(n), 'App 원형에 남았다: ' + n);
  assert.doesNotMatch(readFileSync(join(JS_ROOT, 'core/lsp-client.js'), 'utf8'), /^ {2}_initLSP\(/m, 'LspClient._initLSP');
  for (const n of DELEGATES_DONE) assert.ok(!names.has(n), '위임자가 남았다: ' + n);
});

test('TC-FES-3(8c): 위임자는 그 탭의 섹션에 인자와 답을 그대로 잇고, 섹션이 없으면 아무것도 하지 않는다', () => {
  const ctx = load([...BASE, ...SETTINGS], {
    globals: { App: function App() {}, TIMERS: { disposeOwner() {} } },
    expose: ['SettingsController'],
  });
  // REFACTOR3_FE_APPCTL_SRS 9a: 컨트롤러는 App 생성자가 만든다 — 섹션을 세우기(`initModal`) 전이 「섹션이 없음」 이다.
  // REFACTOR3_FE_DELEG_SRS D-DLG-4: 부르는 쪽은 `settings.section(tab)?.X()` 로 부른다 — 섹션이 없으면 아무것도 하지 않는다.
  const bare = new ctx.App();
  bare.settings = new ctx.SettingsController(bare);
  for (const [, tab, meth] of ROUTES) assert.equal(bare.settings.section(tab)?.[meth]('x'), undefined, meth);
  for (const [, tab, meth] of ROUTES) assert.equal(bare.settings._sectionCall(tab, meth, ['x']), undefined, meth);
  const app = new ctx.App();
  const seen = [];
  const tabs = new Map();
  for (const [, tab, meth] of ROUTES) {
    if (!tabs.has(tab)) tabs.set(tab, { tab, init() {} });
    tabs.get(tab)[meth] = (...a) => { seen.push([meth, ...a]); return meth + ':ok' };
  }
  app.settings = new ctx.SettingsController(app);
  for (const sec of tabs.values()) app.settings.start(sec);
  for (const [name, tab, meth] of ROUTES) assert.equal(app.settings.section(tab)?.[meth]('a', 2), meth + ':ok', name);
  for (const [name, tab, meth] of ROUTES) assert.equal(app.settings._sectionCall(tab, meth, ['b', 3]), meth + ':ok', name);
  assert.deepEqual(plain(seen), [...ROUTES.map(([, , meth]) => [meth, 'a', 2]), ...ROUTES.map(([, , meth]) => [meth, 'b', 3])]);
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
  const app = { ...fakeApp(log), _paintAttnEdge: () => log.push('paintAttn'), attn: { _attnRefresh: () => log.push('refresh') } };
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

// ── 8d 테마·단축키·키바·프리셋·백업 (FR-FES-4) ────────────────────────────

test('8d: ThemeSection 의 init 은 시스템 모드 구독을 걸고, 섹션이 그 주인이다', () => {
  const { ctx } = setup({}, {});
  const mq = elem('mq');
  ctx.matchMedia = (q) => { assert.equal(q, '(prefers-color-scheme: dark)'); return mq };
  const s = new ctx.ThemeSection(fakeApp([]));
  s.init();
  assert.equal(mq.listeners.change.length, 1);
  s.dispose();
  assert.equal(mq.listeners.change.length, 0);
});

test('8d: 키바 구역의 손짓은 구성을 바꾸고 설정 적용(this=settings.apply)과 저장을 부른다', () => {
  const { ctx } = setup({}, {});
  const log = [];
  const app = fakeApp(log);
  app.settings.apply._keybarApply = function () { log.push('apply:' + (this === app.settings.apply)) };
  ctx.keybarCfg = { order: ['a'] };
  const s = new ctx.TerminalSection(app);
  const next = { order: ['b'] };
  s._keybarSet(next);
  assert.equal(ctx.keybarCfg, next);
  assert.deepEqual(log, ['apply:true', 'save']);
});

test('8d: 프리셋의 원본 창은 App 의 창 목록을 그때 묻는다 — e2e 가 갈아 끼운 `plainWindows` 가 닿는다', () => {
  const { ctx } = setup({}, {});
  const w1 = { id: 'w1' }, w2 = { id: 'w2' }, ed = { id: 'e' };
  const app = { ...fakeApp([]), git: { isKindWin: (w) => w === ed, plainWindows: () => [w1, w2] }, _lastPlainWindow: 'w2', tool: { life: { aw: () => ed } } };
  const s = new ctx.PresetsSection(app);
  assert.equal(s._presetSource(), w2);
  app.git.plainWindows = () => [];
  assert.equal(s._presetSource(), null);
  app.tool.life.aw = () => w1;
  assert.equal(s._presetSource(), w1, '활성 창이 일반 창이면 그 창이다');
  assert.equal(s._describeLayout(null), '');
});

test('8d: BackupSection — 파일 이름·저장된 키만 담기·봉투 검사', () => {
  const { ctx } = setup({}, {});
  const store = { local: { attnSound: '1' }, session: { slotDir: 'h' } };
  ctx.PrefStore = {
    local: { get: (k) => store.local[k] ?? null }, session: { get: (k) => store.session[k] ?? null },
  };
  ctx.t = (k) => k;
  const s = new ctx.BackupSection(fakeApp([]));
  assert.equal(s._bkFileName(new Date(2026, 0, 2, 3, 4, 5)), 'dongminal-settings-20260102-030405.json');
  assert.deepEqual(plain(s._bkCollect()), { local: { attnSound: '1' }, session: { slotDir: 'h' } });
  assert.equal(s._bkParse('{').err, 'backup.not_json');
  assert.equal(s._bkParse('{"kind":"x","version":1,"server":{}}').err, 'backup.not_ours');
  assert.equal(s._bkParse('{"kind":"dongminal-settings","version":9,"server":{}}').err, 'backup.newer_version');
  assert.deepEqual(plain(s._bkParse('{"kind":"dongminal-settings","version":1,"server":{"a":1}}').env.server), { a: 1 });
});

// ── TC-FES-4 SettingsController (8e) ─────────────────────────────────────

/**
 * 옛 부팅 배선의 순서 (df15f347). `initModal` 의 나열 다음에 `ui/input-binding.js` 21~30행이 돌았다.
 *
 *   initModal            _initThemeFollow · SettingsModal · _bindSettingsSearch · [shortcuts: 8d 에 init 없이 등록] ·
 *                        display · terminal(+ 키바 구역, 옛 `_initKeybarSettings`) · code · _paintSettingControls ·
 *                        _initBackup · sandbox · access · edges · profile · telegram · server · claude
 *   input-binding.js     initSaveButtons · initStatusBar(끝에서 statusbar) · initPresets(presets) · initMobile ·
 *                        initMobileKeybar · initAttn(안에서 notify) · initPollingSettings(polling)
 *
 * notify 는 `initAttn` 의 배지·바깥 클릭 리스너 뒤, 권한 묻기·해제 입구 리스너 앞이었다. 그 넷은 `document`·배지에
 * 걸리고 notify 는 자기 스위치 셋에 건다 — 같은 대상이 없어 `initAttn` 뒤로 옮겨도 도는 순서가 바뀌지 않는다.
 */
const BOOT_ORDER = ['theme', 'modal', 'search', 'shortcuts', 'display', 'terminal', 'code', 'paint', 'backup',
  'sandbox', 'access', 'edges', 'profile', 'telegram', 'server', 'claude', 'initSaveButtons', 'initStatusBar',
  'statusbar', 'presets', 'initMobile', 'initMobileKeybar', 'initAttn', 'notify', 'polling'];

const SECTION_CLASSES = ['ThemeSection', 'ShortcutsSection', 'DisplaySection', 'TerminalSection', 'CodeSection',
  'BackupSection', 'SandboxSection', 'AccessSection', 'EdgesSection', 'ProfileSection', 'TelegramSection',
  'ServerSection', 'ClaudeSection', 'StatusbarSection', 'PresetsSection', 'NotifySection', 'PollingSection'];

function loadController() {
  return load([...BASE, ...SETTINGS], {
    expose: ['SettingsController', 'SettingsSection', 'Controller', ...SECTION_CLASSES],
    globals: { App: function App() {}, TIMERS: { disposeOwner() {} } },
  });
}

test('TC-FES-4: SettingsController 는 Controller 하위이고 옛 부팅 순서대로 섹션과 그 사이의 init 을 세운다', () => {
  const ctx = loadController();
  const log = [];
  for (const c of SECTION_CLASSES) ctx[c].prototype.init = function () { log.push(this.tab) };
  ctx.SettingsModal = class { constructor(h) { this.h = h } init() { log.push('modal'); return this } };
  ctx.document = { getElementById: (id) => (id === 'modal' ? { id } : null) };
  // REFACTOR3_FE_DELEG_SRS FR-DLG-3: 사이의 init 은 앱에서 주인까지의 점 경로로 부른다.
  const app = {};
  const c = new ctx.SettingsController(app);
  app.settings = c;
  c.paint = () => log.push('paint');
  const at = (path) => { const ks = path.split('.'); const n = ks.pop(); return [ks.reduce((o, k) => (o[k] = o[k] || {}), app), n] };
  for (const p of ['settings.saveState.initSaveButtons', 'statusbar.initStatusBar', 'mobile.initMobile', 'mobile.initMobileKeybar',
    'attn.initAttn']) { const [o, n] = at(p); o[n] = () => log.push(n) }
  // REFACTOR3_FE_APPCTL_SRS 9a: 검색 배선은 컨트롤러의 것이다.
  c._bindSettingsSearch = (m) => log.push(m.id === 'modal' ? 'search' : 'search?');
  assert.ok(c instanceof ctx.Controller);
  assert.equal(c.init(), c);
  assert.deepEqual(log, BOOT_ORDER);
  assert.deepEqual(plain(c.all().map((s) => s.tab)), BOOT_ORDER.filter((x) => c.section(x)));
  assert.ok(c.section('theme') instanceof ctx.ThemeSection);
  assert.ok(c.section('theme') instanceof ctx.SettingsSection);
  assert.equal(c.section('nope'), null);
  assert.equal(typeof c.modal.h.onOpen, 'function');
});

test('TC-FES-4: initModal 은 컨트롤러의 init 하나이고 _init 호출이 없다 — 설정 init 은 input-binding 에 하나뿐이다', () => {
  // REFACTOR3_FE_APPCTL_SRS 9a: 컨트롤러는 App 생성자가 만든다. REFACTOR3_FE_DELEG_SRS: 옛 위임자 `initModal` 은 걷었고
  // 부르는 쪽이 `settings.init()` 을 부른다.
  const src = readFileSync(join(JS_ROOT, 'core/settings-controller.js'), 'utf8');
  assert.doesNotMatch(src, /Controller\.delegate\(/);
  assert.match(readFileSync(join(JS_ROOT, 'core/app.js'), 'utf8'), /^ {4}this\.settings=new SettingsController\(this\);$/m);
  const bind = readFileSync(join(JS_ROOT, 'ui/input-binding.js'), 'utf8');
  for (const n of ['initSaveButtons', 'initStatusBar', 'initPresets', 'initMobile', 'initMobileKeybar', 'initAttn', 'initPollingSettings']) {
    assert.ok(!new RegExp('this\\.app\\.' + n + '\\(').test(bind), 'input-binding 이 직접 부른다: ' + n);
  }
  assert.match(bind, /this\.app\.settings\.init\(\)/);
  const names = appMixinNames();
  for (const n of ['_settingsOnOpen', '_settingsOnTab', 'initPresets', 'initPollingSettings']) assert.ok(!names.has(n), 'App 원형에 남았다: ' + n);
});

test('TC-FES-4: 열 때는 theme → shortcuts → presets → display → 칠하기 → 라벨 → claude → 서랍 → 검색 비우기 → profile → 모바일, 다른 섹션은 부르지 않는다', () => {
  const ctx = loadController();
  const log = [];
  const app = {
    isMobile: true, drawerOpen: true,
    mobile: { _toggleDrawer: (v) => log.push('drawer:' + v), sheets: { _settingsMobileOnOpen: (m) => log.push('mobile:' + m) } },
  };
  const c = new ctx.SettingsController(app);
  c.paint = () => log.push('paint');
  // REFACTOR3_FE_APPCTL_SRS 9a: 라벨과 검색 비우기는 컨트롤러의 것이다.
  c._labelSettingsRows = () => log.push('label');
  c._settingsSearchReset = () => log.push('search');
  for (const tab of ['code', 'profile', 'claude', 'display', 'presets', 'shortcuts', 'theme', 'sandbox']) {
    c.start({ tab, init() {}, onOpen: () => log.push(tab), onTab: () => log.push('tab:' + tab) });
  }
  c.onOpen('M');
  assert.deepEqual(log, ['theme', 'shortcuts', 'presets', 'display', 'paint', 'label', 'claude', 'drawer:false', 'search',
    'profile', 'mobile:M']);
  log.length = 0;
  c.onTab('sandbox');
  c.onTab('nope');
  assert.deepEqual(log, ['tab:sandbox']);
});

// ── REFACTOR3_FE_FIX_SRS FX-2 ─────────────────────────────────────────────

test('TC-FFX-4: StatusbarSection.paint 는 스위치를 지금 statusBar 로 칠한다 — 열 때·방송 뒤의 칠하기 길이다', () => {
  const host = elem('sb-settings', { innerHTML: '', kids: [], appendChild(c) { this.kids.push(c); return c } });
  const { ctx, doc } = setup({}, { 'sb-settings': host });
  doc.createElement = () => elem('', { kids: [], appendChild(c) { this.kids.push(c); return c } });
  ctx.STATUS_ITEMS = { connection: { label: 'c' }, hostname: { label: 'h' } };
  ctx.statusBar = { connection: true, hostname: false };
  const s = new ctx.StatusbarSection(fakeApp([]));
  s.init();
  const sw = (k) => host.kids.find((r) => r.dataset.item === k).kids[1];
  assert.equal(sw('connection').checked, true);
  assert.equal(sw('hostname').checked, false);
  ctx.statusBar.connection = false; ctx.statusBar.hostname = true;
  s.paint();
  assert.equal(sw('connection').checked, false);
  assert.equal(sw('hostname').checked, true);
});

test('TC-FFX-4: 숫자 행 다섯과 탭 폭 행은 포커스 가드를 갖는다 (FR-FFX-7)', () => {
  const access = new Proxy({}, { get: () => ({ get: () => 0, set() {} }) });
  const { ctx } = setup(access, {});
  ctx.TermGpu = { enabled: () => false, setEnabled() {} };
  ctx.I18N = { locale: 'ko', resolve: (v) => v };
  ctx.applyTabWidth = () => {};
  ctx.applyUiFontScale = () => {};
  Object.assign(ctx, { focusEdgeLevel: 0, attnEdgeLevel: 0, UFE_LEVEL_MAX: 10, ATTN_EDGE_LEVEL_MAX: 10 });
  const app = { ...fakeApp([]), _slotDirPaint() {}, displayMode: 'auto', mobileBreakpoint: 768 };
  const rows = [];
  for (const cls of ['DisplaySection', 'TerminalSection']) {
    const s = new ctx[cls](app);
    s.init();
    rows.push(...s.rows);
  }
  const guarded = rows.filter((r) => r.decl.kind === 'number').map((r) => [r.decl.key, !!r.decl.guard]);
  assert.deepEqual(plain(guarded.sort()), [
    ['claudeScrollSpeed', true], ['issueTreeCtxPct', true], ['migrationHookCtxPct', true],
    ['tabWidthPx', true], ['termFontSize', true], ['uiFontSize', true]]);
});

// ── REFACTOR3_FE_FIX_SRS FX-3 ─────────────────────────────────────────────

/** 열기 순서의 나머지는 TC-FES-4 가 본다 — 여기는 다시 읽기만. */
function rereadSetup(active, dirty) {
  const ctx = loadController();
  ctx.settingsPanelDirty = (_app, panel) => dirty.has(panel);
  const app = { isMobile: false, mobile: { sheets: { _settingsMobileOnOpen() {} } } };
  const c = new ctx.SettingsController(app);
  c.paint = () => {};
  c._labelSettingsRows = () => {};
  c.modal = { current: () => active.tab };
  const reads = [];
  const pending = {};
  for (const tab of ['access', 'sandbox', 'edges', 'telegram', 'server', 'profile', 'display']) {
    c.start({ tab, init() {}, onOpen() {}, onTab: () => { reads.push(tab); return new Promise((r) => { pending[tab] = r }) } });
  }
  return { c, reads, pending };
}

test('TC-FFX-7: 열 때 고른 탭이 다섯 서버 패널 가운데 하나이고 수정이 없으면 그 섹션만 다시 읽는다', () => {
  for (const tab of ['access', 'sandbox', 'edges', 'telegram', 'server']) {
    const { c, reads } = rereadSetup({ tab }, new Set());
    c.onOpen('M');
    assert.deepEqual(reads, [tab], tab);
  }
  for (const tab of ['display', 'profile', null]) {
    const { c, reads } = rereadSetup({ tab }, new Set());
    c.onOpen('M');
    assert.deepEqual(reads, [], String(tab));
  }
});

test('TC-FFX-7: 저장하지 않은 수정이 있으면 열 때 다시 읽지 않는다 (FR-FFX-10)', () => {
  const { c, reads } = rereadSetup({ tab: 'access' }, new Set(['panel-access']));
  c.onOpen('M');
  assert.deepEqual(reads, []);
});

test('TC-FFX-7: 읽기는 섹션마다 하나만 난다 — 비행 중의 열기·탭 누르기는 같은 약속이고, 끝나면 새로 읽는다 (FR-FFX-11)', async () => {
  const { c, reads, pending } = rereadSetup({ tab: 'edges' }, new Set());
  c.onOpen('M');
  const p1 = c.onTab('edges');
  c.onOpen('M');
  const p2 = c.onTab('edges');
  assert.equal(p1, p2);
  assert.deepEqual(reads, ['edges']);
  c.onTab('access');
  assert.deepEqual(reads, ['edges', 'access'], '다른 섹션은 따로 난다');
  pending.edges();
  await p1;
  c.onTab('edges');
  assert.deepEqual(reads, ['edges', 'access', 'edges']);
  c.onTab('display');
  assert.deepEqual(reads, ['edges', 'access', 'edges', 'display'], '다섯 밖의 탭은 지금처럼 onTab 이다');
});

// ── QUALITY_FIX_SRS QF-7 — 부팅 적용과 설정창 세우기의 순서 ─────────────────────

/**
 * 적용(`SettingsApply._settingsApply`)과 컨트롤러를 진짜로 싣고, 섹션 하나는 규약(`init` 이 `paint` 를 부른다)만 갖춘
 * 가짜다. 값은 `state` 에 얹히고, 칠한 값과 모바일 키바에 그린 값을 남긴다.
 */
function orderSetup() {
  const state = { n: 1, kb: 'default' };
  const ctx = loadController();
  Object.assign(ctx, {
    migrateUiFontScale() {},
    SETTINGS_SCHEMA: [{ key: 'n' }, { key: 'keybar' }],
    SETTINGS_ACCESS: {
      n: { set(v) { state.n = v } },
      keybar: { set(v) { state.kb = v; this.settings.apply._keybarApply() } },
    },
    settingValue: (v) => v,
    THEMES: { x: {} }, currentThemeName: 'x', customTheme: null, themeFollowSystem: false, applyThemeObj() {},
    I18N: { applyShortcuts() {} },
    TIMERS: { refreshChanged() {}, disposeOwner() {} },
    PrefStore: { local: { get: () => null } }, STORE_KEYS: { legacyAgentsPollMs: 'x' },
  });
  const drawn = [];
  const app = { gitPanel: null, mobile: { _mkbRender: () => drawn.push(state.kb), mkbRefresh() {} } };
  const c = new ctx.SettingsController(app);
  app.settings = c;
  const section = () => ({ tab: 'terminal', painted: null, init() { this.paint() }, paint() { this.painted = { ...state } } });
  return { c, state, drawn, section };
}

test('TC-QFX-7: 부팅 적용이 설정창보다 먼저여도 뒤여도 칠한 값·모바일 키바가 같다 (FR-QFX-9·10·12)', () => {
  const saved = { n: 5, keybar: 'K' };
  // 적용 → 세우기: 섹션이 없을 때 적용이 왔다. 서는 섹션이 지금 상태로 칠한다.
  const a = orderSetup();
  a.c.apply._settingsApply(saved, { boot: true });
  const sa = a.c.start(a.section());
  // 세우기 → 적용: 선 섹션을 적용이 칠한다.
  const b = orderSetup();
  const sb = b.c.start(b.section());
  b.c.apply._settingsApply(saved, { boot: true });
  assert.deepEqual(plain(sa.painted), { n: 5, kb: 'K' });
  assert.deepEqual(plain(sb.painted), plain(sa.painted));
  // 모바일 키바도 두 순서에서 같은 구성으로 그려진다 — 키바가 서기 전(`modKbd` 없음)에도 그린다.
  assert.equal(a.drawn.at(-1), 'K');
  assert.equal(b.drawn.at(-1), 'K');
});

test('TC-QFX-7: 칠하기는 적용의 맨 끝, 이사 뒤다 — 이사가 섹션을 따로 칠하지 않는다 (FR-QFX-11)', () => {
  const { c } = orderSetup();
  const log = [];
  c.apply._pollMigrateAgents = () => log.push('migrate');
  c.app.settings.paint = () => log.push('paint');
  c.apply._settingsApply({ n: 2 }, { boot: true });
  assert.deepEqual(log, ['migrate', 'paint']);
  log.length = 0;
  c.apply._settingsApply({ n: 3 });
  assert.deepEqual(log, ['paint'], '이사는 부팅에서만');
});

test('TC-QFX-7: 적용 길은 섹션을 직접 부르지 않고, 키바 얹기에 modKbd 가드가 없다 (FR-QFX-9·10)', () => {
  const src = readFileSync(join(JS_ROOT, 'core/settings-apply.js'), 'utf8');
  assert.ok(!/_sectionCall\(/.test(src), 'settings-apply.js 가 _sectionCall 을 부른다');
  const body = src.slice(src.indexOf('  _keybarApply(){'), src.indexOf('\n  }\n', src.indexOf('  _keybarApply(){')));
  assert.ok(!/modKbd/.test(body), '_keybarApply 가 modKbd 로 가른다');
});

test('TC-QFX-7: TerminalSection.paint 가 행과 키바 구성 목록을 칠하고, 사용자가 고친 구성도 목록을 칠한다 (FR-QFX-10)', () => {
  const { ctx } = setup({}, {});
  const log = [];
  const app = fakeApp(log);
  app.settings.apply._keybarApply = () => log.push('apply');
  ctx.keybarCfg = { order: ['a'] };
  const s = new ctx.TerminalSection(app);
  s._keybarPaint = () => log.push('kbc');
  s.rows = [{ paint: () => log.push('row') }];
  s.paint();
  assert.deepEqual(log, ['row', 'kbc']);
  log.length = 0;
  s._keybarSet({ order: ['b'] });
  assert.deepEqual(log, ['apply', 'kbc', 'save']);
});

import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { BASE, SETTINGS, load, plain } from './harness.mjs';

/**
 * REFACTOR3_FE_APPCTL_SRS — App mixin 을 주제별 `Controller` 로 (단계 9).
 *   TC-FEA-1 컨트롤러는 `Controller`·`Component` 하위이고 App 이 든다. 위임자는 같은 인자로 부르고 값을 돌려준다
 *   TC-FEA-2 e2e·단위가 App 인스턴스에 갈아 끼운 이름을 컨트롤러 경로도 부른다
 *   TC-FEA-3 옮긴 mixin 파일이 없고 `Object.assign(App.prototype` 의 수가 준다. 계약 이름이 App 에서 읽힌다
 *
 * 하위 이슈마다 `ISSUES` 에 한 줄을 더한다.
 */

const JS_ROOT = new URL('..', import.meta.url).pathname;
const REPO = join(JS_ROOT, '..', '..');
const read = (rel) => readFileSync(join(JS_ROOT, rel), 'utf8');

function walk(dir, ok, out = []) {
  for (const n of readdirSync(dir)) {
    const f = join(dir, n);
    if (statSync(f).isDirectory()) { if (!/node_modules|vendor|test-results|playwright-report/.test(n)) walk(f, ok, out); continue }
    if (ok(n)) out.push(f);
  }
  return out;
}

/** e2e·단위 시험이 `app.X =` 로 갈아 끼우는 이름 (FR-FEA-3 의 덮어쓰기 대상). */
function overridden() {
  const out = new Set();
  const files = [...walk(join(REPO, 'e2e'), (n) => /\.(ts|js|mjs)$/.test(n)), ...walk(join(JS_ROOT, 'test'), (n) => n.endsWith('.mjs'))];
  for (const f of files) for (const m of readFileSync(f, 'utf8').matchAll(/\bapp\.([A-Za-z_$][\w$]*)\s*=(?!=)/g)) out.add(m[1]);
  return out;
}

/** 계약 `app-testing.js` 의 이름. */
function contractNames() {
  const src = read('core/app-testing.js');
  const list = src.match(/const APP_TESTING_NAMES = \[([\s\S]*?)\];/)[1];
  return new Set([...list.matchAll(/'([^']+)'/g)].map((m) => m[1]));
}

/** 하위 이슈별 표. `ctl` 은 컨트롤러 파일, `gone` 은 없어진 mixin, `plainNow` 는 mixin 을 벗은 파일. */
const ISSUES = {
  '9a': {
    ctl: ['core/edges-controller.js', 'core/update-controller.js', 'core/settings-apply.js', 'core/settings-live.js',
      'core/settings-save-state.js', 'core/settings-controller.js'],
    gone: ['core/app-edges.js', 'core/app-edges-mesh.js', 'core/app-polling.js', 'core/app-update.js', 'core/app-settings.js',
      'core/app-settings-init.js', 'core/app-lsp.js', 'core/app-runs.js'],
    plainNow: ['core/settings-live.js', 'core/settings-save-state.js'],
    mixins: 47,
  },
  '9b': {
    ctl: ['core/attn-controller.js', 'core/attn-center.js', 'core/attn-claim.js', 'core/claude-accounts-controller.js',
      'core/claude-maps.js', 'core/statusbar-controller.js', 'core/statusbar-enc.js'],
    gone: ['core/app-attn.js', 'core/app-attn-center.js', 'core/app-attn-claim.js', 'core/app-claude-accounts.js',
      'core/app-claude-accounts-map.js', 'core/app-statusbar.js', 'core/app-statusbar-enc.js'],
    plainNow: [],
    mixins: 40,
  },
};

// ── 9a: 간선 · 업데이트 · 설정 잔여(폴링 포함) · 얇은 셸(LSP·Run) ──────────────────────

const CLASSES_9A = ['EdgesController', 'UpdateController', 'SettingsController', 'SettingsApply', 'SettingsLive', 'SettingsSaveState'];

/** 위임자 → 컨트롤러의 자리. `settings` 의 부품은 `settings.<부품>` 이다. */
const DELEGATES_9A = {
  edges: ['_edgesRestore', '_onEdgesChanged', '_egMeshPaint', '_egInvitesPaint', '_egInviteSend', '_egNotify'],
  update: ['_updateRestore', '_updateRender'],
  'settings.apply': ['_applyPageTitle', '_saveSettingsSoon', '_saveSettingsNow', '_localeMirror', '_edApplyWordWrap',
    '_edApplyMinimap', '_edApplyFontSize', '_termApplyFontSize', '_applyThemeChoice', '_keybarApply', 'saveSettings',
    '_onSettingsChanged', '_settingsBody', '_settingsLocalPending', '_settingsApply', '_settingsRestore'],
  'settings.live': ['_liveMark', '_liveOpts', '_liveOpen', '_liveChanged', '_liveStale', '_liveNotice'],
  'settings.saveState': ['_saveBtnsPaint', 'initSaveButtons'],
  settings: ['_openSettings'],
};

/** 섹션 위임자 → 탭 (REFACTOR3_FE_SETTINGS_SRS FR-FES-9). `SettingsController._sectionCall` 을 지난다. */
const SECTION_DELEGATES_9A = {
  _onAccessChanged: 'access', _onSandboxChanged: 'sandbox', _onServerMoving: 'server', _edgesPaint: 'edges',
  _egNodePaint: 'edges', _egNodeCollect: 'edges', _cacctPanelShown: 'claude', _cacctRefreshSoft: 'claude',
  _loadTelegramPanel: 'telegram', _tgRead: 'telegram', _pfCollect: 'profile', _pfFollow: 'profile', _sbxCollect: 'sandbox',
  _aclCollect: 'access', themeSlots: 'theme', setThemeSlots: 'theme', _showCustomEditor: 'theme', _hideCustomEditor: 'theme',
  _renderPresets: 'presets', _savePreset: 'presets',
};

/** 옮기지 않은 채 같은 이름으로 남는 App 의 이름 (본체가 컨트롤러 밖이다). */
const LSP_DELEGATES = ['_lspRefresh', '_lspGotoDef', '_lspFindRefs', '_lspRootOfPath', 'lspClickDef', 'lspExtFor', 'lspOfferFor',
  'lspOfferInstall', 'lspOfferPending', 'lspOfferReopen'];
const RUNS_DELEGATES = ['_runsModalToggle', '_findRunTab', 'runViewEl', '_runDisposeView', '_onRunChanged', '_runPaint'];

function load9a(globals = {}) {
  return load([...BASE, 'core/state-registry.js', 'core/edges-controller.js', 'core/edges-mesh.js', 'core/update-controller.js',
    'core/poll-settings.js', 'core/settings-table.js', ...SETTINGS], {
    expose: [...CLASSES_9A, 'Controller', 'Component'],
    globals: {
      App: function App() {}, TIMERS: { disposeOwner() {}, refreshChanged() {} }, t: (k) => k, tn: (k) => k,
      document: { getElementById: () => null, querySelector: () => null },
      ...globals,
    },
  });
}

/** `this.app` 이 아닌 `this.X` 로 읽는 이름. */
function thisNames(src) {
  const out = new Set();
  for (const m of src.matchAll(/(?<![\w$.])this\.([A-Za-z_$][\w$]*)/g)) out.add(m[1]);
  return out;
}

test('TC-FEA-1(9a): 컨트롤러는 Controller·Component 하위이고 app 을 든다', () => {
  const ctx = load9a();
  const app = new ctx.App();
  for (const c of CLASSES_9A) {
    const o = new ctx[c](app);
    assert.ok(o instanceof ctx.Controller, c);
    assert.ok(o instanceof ctx.Component, c);
    assert.equal(o.app, app, c);
  }
  const s = new ctx.SettingsController(app);
  assert.ok(s.apply instanceof ctx.SettingsApply);
  assert.ok(s.live instanceof ctx.SettingsLive);
  assert.ok(s.saveState instanceof ctx.SettingsSaveState);
});

test('TC-FEA-1(9a): App 생성자가 컨트롤러를 만든다 — 부팅의 _settingsApply 가 설정창보다 먼저 와도 선다', () => {
  const src = read('core/app.js');
  const ctor = src.slice(src.indexOf('  constructor(){'), src.indexOf('\n  }\n', src.indexOf('  constructor(){')));
  for (const line of ['this.settings=new SettingsController(this);', 'this.edges=new EdgesController(this);',
    'this.update=new UpdateController(this);']) assert.ok(ctor.includes(line), line);
});

test('TC-FEA-1: Controller.delegate 는 이름마다 같은 인자로 부르고 답을 돌려주는 메서드를 둔다', () => {
  const ctx = load(BASE, { expose: ['Controller'], globals: { TIMERS: { disposeOwner() {} } } });
  class Host {}
  ctx.Controller.delegate(Host, 'a.b', ['f']);
  ctx.Controller.delegate(Host, (self, name, args) => [name, ...args, self.k], ['g']);
  const h = new Host();
  h.k = 'k';
  h.a = { b: { f: (...x) => ['f', ...x] } };
  assert.deepEqual(plain(h.f(1, 'x')), ['f', 1, 'x']);
  assert.deepEqual(plain(h.g(2)), ['g', 2, 'k']);
});

test('TC-FEA-1(9a): 위임자는 컨트롤러 메서드를 같은 인자로 부르고 값을 돌려준다', () => {
  const ctx = load9a();
  const app = new ctx.App();
  app.edges = {};
  app.update = {};
  app.settings = { apply: {}, live: {}, saveState: {} };
  const seen = [];
  for (const [path, names] of Object.entries(DELEGATES_9A)) {
    const target = path.split('.').reduce((o, k) => o[k], app);
    for (const n of names) target[n] = (...a) => { seen.push([n, ...a]); return 'r:' + n };
  }
  for (const names of Object.values(DELEGATES_9A)) for (const n of names) assert.equal(app[n](1, 'x'), 'r:' + n, n);
  assert.deepEqual(plain(seen), Object.values(DELEGATES_9A).flat().map((n) => [n, 1, 'x']));
  // 이름이 다른 위임자 둘과 섹션 위임자.
  const log = [];
  app.settings.init = () => { log.push('init'); return app.settings };
  app.settings.paint = () => log.push('paint');
  app.settings._sectionCall = (tab, name, args) => { log.push([tab, name, ...args]); return tab + ':' + name };
  assert.equal(app.initModal(), undefined);
  app._paintSettingControls();
  for (const [n, tab] of Object.entries(SECTION_DELEGATES_9A)) assert.equal(app[n]('a', 2), tab + ':' + n, n);
  assert.deepEqual(plain(log), ['init', 'paint', ...Object.entries(SECTION_DELEGATES_9A).map(([n, tab]) => [tab, n, 'a', 2])]);
});

test('TC-FEA-1(9a): LSP·Run 위임자는 App 본문에 있고 지연 생성한 본체에 잇는다', () => {
  const ctx = load([...BASE, 'core/app.js'], { expose: ['App'], globals: { TIMERS: { disposeOwner() {} } } });
  const app = Object.create(ctx.App.prototype);
  const seen = [];
  const body = (tag) => new Proxy({}, { get: (_, n) => (...a) => { seen.push([tag, n, ...a]); return tag + ':' + String(n) } });
  app._lsp = body('lsp');
  app._runs = body('runs');
  for (const n of LSP_DELEGATES) assert.equal(app[n](1), 'lsp:' + n, n);
  for (const n of RUNS_DELEGATES) assert.equal(app[n](1), 'runs:' + n, n);
  assert.equal(app._runsListRestore(), 'runs:_runsRefresh');
  assert.equal(app._lspClient(), app._lsp);
  assert.equal(app._runsPanel(), app._runs);
  assert.equal(seen.length, LSP_DELEGATES.length + RUNS_DELEGATES.length + 1);
});

test('TC-FEA-2(9a): 컨트롤러는 덮어쓰기 대상·계약 이름을 this.app 으로 부른다', () => {
  const force = new Set([...overridden(), ...contractNames()]);
  for (const f of ISSUES['9a'].ctl) {
    const bad = [...thisNames(read(f))].filter((n) => force.has(n));
    assert.deepEqual(bad, [], f);
  }
});

test('TC-FEA-2(9a): 갈아 끼운 _edgesRestore·_restore*·_liveOpen·_liveNotice·_runsPanel 을 컨트롤러 경로가 부른다', async () => {
  const ctx = load9a({ apiGet: async () => ({ ok: true, data: { node: null } }), profileName: '', Toast: { show() {} } });
  const app = new ctx.App();
  app.edges = new ctx.EdgesController(app);
  app.update = new ctx.UpdateController(app);
  const log = [];
  app._edgesRestore = () => { log.push('edgesRestore'); return 'R' };
  assert.equal(app.edges._onEdgesChanged({}), 'R');
  delete app._edgesRestore;
  app._restoreBegin = (k) => { log.push('begin:' + k); return 7 };
  app._restoreLive = (k, f) => { log.push('live:' + k + f); return true };
  app._restoreEnd = (k, f) => log.push('end:' + k + f);
  app._edgesPaint = () => log.push('edgesPaint');
  app._liveOpen = () => { log.push('liveOpen'); return false };
  app._pfFollow = () => log.push('pfFollow');
  await app.edges._edgesRestore();
  await app.update._updateRestore();
  assert.deepEqual(log, ['edgesRestore', 'begin:edges', 'live:edges7', 'pfFollow', 'edgesPaint', 'liveOpen', 'end:edges7',
    'begin:update', 'live:update7', 'end:update7']);

  const live = new ctx.SettingsLive(app);
  const seen = [];
  app._liveOpen = () => true;
  app._liveNotice = (k, r) => seen.push([k, typeof r]);
  live._liveChanged('access', null, { a: 1 }, () => seen.push('reload'));
  assert.deepEqual(plain(seen), [['access', 'function']], '수정이 있으면 갈아 끼운 _liveNotice 로 알린다');
});

test('TC-FEA-2(9a): Run 위임자는 갈아 끼운 _runsPanel 을 부른다', () => {
  const ctx = load([...BASE, 'core/app.js'], { expose: ['App'], globals: { TIMERS: { disposeOwner() {} } } });
  const app = Object.create(ctx.App.prototype);
  app._runsPanel = () => ({ _runsModalToggle: (o) => 'swapped:' + o });
  assert.equal(app._runsModalToggle(true), 'swapped:true');
});

test('TC-FEA-3(9a): 옮긴 mixin 파일이 없고 Object.assign(App.prototype 의 수가 준다', () => {
  const issue = ISSUES['9a'];
  for (const f of issue.gone) assert.ok(!existsSync(join(JS_ROOT, f)), '남았다: ' + f);
  for (const f of issue.plainNow) assert.doesNotMatch(read(f), /Object\.assign\(App\.prototype/, f);
  const html = readFileSync(join(REPO, 'web/index.html'), 'utf8');
  for (const f of issue.gone) assert.ok(!html.includes('js/' + f + '"') && !html.includes('js/' + f + '?'), 'index.html 이 싣는다: ' + f);
  const mixins = walk(JS_ROOT, (n) => n.endsWith('.js')).filter((f) => !f.includes('/test/'))
    .filter((f) => readFileSync(f, 'utf8').includes('Object.assign(App.prototype'));
  assert.ok(mixins.length <= issue.mixins, 'mixin 파일 ' + mixins.length + ' > ' + issue.mixins);
});

test('TC-FEA-3(9a): 옮긴 묶음의 계약 이름이 App 원형에서 함수로 읽힌다', () => {
  const ctx = load9a();
  const contract = contractNames();
  const names = ['_savePreset', '_renderPresets', 'saveSettings', '_settingsApply', '_onSettingsChanged', '_applyPageTitle',
    '_openSettings', 'themeSlots', 'setThemeSlots'];
  for (const n of names) {
    assert.ok(contract.has(n), '계약에 없다: ' + n);
    assert.equal(typeof ctx.App.prototype[n], 'function', n);
  }
  const app = load([...BASE, 'core/app.js'], { expose: ['App'], globals: { TIMERS: { disposeOwner() {} } } }).App;
  for (const n of ['_runsPanel', '_onRunChanged', '_lspRootOfPath']) {
    assert.ok(contract.has(n), '계약에 없다: ' + n);
    assert.equal(typeof app.prototype[n], 'function', n);
  }
});

// ── 9b: 알림(attn) · Claude 계정 · 상태바 ──────────────────────────────────────────────

const CLASSES_9B = ['AttnController', 'AttnCenter', 'AttnClaim', 'ClaudeAccountsController', 'ClaudeMaps', 'StatusBarController',
  'StatusBarEnc'];

const DELEGATES_9B = {
  attn: ['attnHas', '_agFocusedTool', '_isToolFocusedActive', '_onToolAttention', 'attnUserIsWatching', '_onToolAttentionClear',
    '_attnRestore', '_attnDrop', '_attnClear', 'windowHasAttn', '_attnNoteInteraction', 'jumpToTool', '_attnRefresh',
    '_attnSecurityNotice', '_attnDetail', '_attnBeep', 'initAttn'],
  claude: ['_claudeAcctRestore', '_onClaudeAccountsChanged', '_onClaudeAccountAlert', '_claudeAcctFold', '_claudeAcctSmartMenu',
    '_claudeAcctHistory', '_claudeAcctEl'],
  'claude.maps': ['claudeTabTint', 'claudeOnCwd', 'claudeRepoChip', 'claudeFolderChip', 'claudeTabMenuItem', 'claudeFolderMenu'],
  statusbar: ['initStatusBar', '_startStatsPoll', '_pollStats', 'updateStatusBar', '_bgModalToggle', '_bgPanelPaint', '_bgRow',
    '_shortCwd', '_fmtMemSize', 'updateCwd'],
};

function load9b(globals = {}) {
  return load([...BASE, 'core/state-registry.js', 'core/attn-controller.js', 'core/attn-center.js', 'core/attn-claim.js',
    'core/claude-accounts-controller.js', 'core/claude-maps.js', 'core/statusbar-controller.js', 'core/statusbar-enc.js'], {
    expose: [...CLASSES_9B, 'Controller', 'Component'],
    globals: {
      App: function App() {}, TIMERS: { disposeOwner() {} }, t: (k) => k, tn: (k) => k,
      document: { getElementById: () => null, querySelector: () => null },
      ...globals,
    },
  });
}

test('TC-FEA-1(9b): 컨트롤러와 부품은 Controller·Component 하위이고 app 을 든다', () => {
  const ctx = load9b();
  const app = new ctx.App();
  for (const c of CLASSES_9B) {
    const o = new ctx[c](app);
    assert.ok(o instanceof ctx.Controller, c);
    assert.ok(o instanceof ctx.Component, c);
    assert.equal(o.app, app, c);
  }
  const attn = new ctx.AttnController(app);
  assert.ok(attn.center instanceof ctx.AttnCenter);
  assert.ok(attn.claim instanceof ctx.AttnClaim);
  assert.ok(new ctx.ClaudeAccountsController(app).maps instanceof ctx.ClaudeMaps);
  assert.ok(new ctx.StatusBarController(app).enc instanceof ctx.StatusBarEnc);
});

test('TC-FEA-1(9b): App 생성자가 컨트롤러를 만든다', () => {
  const src = read('core/app.js');
  const ctor = src.slice(src.indexOf('  constructor(){'), src.indexOf('\n  }\n', src.indexOf('  constructor(){')));
  for (const line of ['this.attn=new AttnController(this);', 'this.claude=new ClaudeAccountsController(this);',
    'this.statusbar=new StatusBarController(this);']) assert.ok(ctor.includes(line), line);
  assert.ok(!ctor.includes('this._attnNotifs='), '알림 창 표는 AttnController 가 든다');
});

test('TC-FEA-1(9b): 위임자는 컨트롤러 메서드를 같은 인자로 부르고 값을 돌려준다', () => {
  const ctx = load9b();
  const app = new ctx.App();
  app.attn = {};
  app.claude = { maps: {} };
  app.statusbar = {};
  const seen = [];
  for (const [path, names] of Object.entries(DELEGATES_9B)) {
    const target = path.split('.').reduce((o, k) => o[k], app);
    for (const n of names) target[n] = (...a) => { seen.push([n, ...a]); return 'r:' + n };
  }
  for (const names of Object.values(DELEGATES_9B)) for (const n of names) assert.equal(app[n](1, 'x'), 'r:' + n, n);
  assert.deepEqual(plain(seen), Object.values(DELEGATES_9B).flat().map((n) => [n, 1, 'x']));
});

test('TC-FEA-2(9b): 컨트롤러는 덮어쓰기 대상·계약 이름을 this.app 으로 부른다', () => {
  const force = new Set([...overridden(), ...contractNames()]);
  for (const f of ISSUES['9b'].ctl) {
    const bad = [...thisNames(read(f))].filter((n) => force.has(n));
    assert.deepEqual(bad, [], f);
  }
});

test('TC-FEA-2(9b): 갈아 끼운 _attnClear·_claudeAcctRestore·updateStatusBar 를 컨트롤러 경로가 부른다', () => {
  const ctx = load9b({ statusBar: { cwd: true } });
  const app = new ctx.App();
  app.attn = new ctx.AttnController(app);
  app.claude = new ctx.ClaudeAccountsController(app);
  app.statusbar = new ctx.StatusBarController(app);
  app._attn = new Map([['t1', { reason: 'x' }]]);
  const log = [];
  app._attnClear = (id, typed) => log.push('clear:' + id + ':' + typed);
  const tab = { dataset: { toolid: 't1' } };
  const pane = { querySelector: () => tab };
  app.attn._attnNoteInteraction({ type: 'pointerdown', target: { closest: () => pane } });
  app._claudeAcctRestore = () => { log.push('acctRestore'); return 'R' };
  assert.equal(app.claude._onClaudeAccountsChanged(), 'R');
  app.focusedTerminal = () => ({ id: 'p1', _cwd: '/w' });
  app.updateStatusBar = () => log.push('status');
  app.statusbar.updateCwd();
  assert.deepEqual(log, ['clear:t1:false', 'acctRestore', 'status']);
});

test('TC-FEA-3(9b): 옮긴 mixin 파일이 없고 Object.assign(App.prototype 의 수가 준다', () => {
  const issue = ISSUES['9b'];
  for (const f of issue.gone) assert.ok(!existsSync(join(JS_ROOT, f)), '남았다: ' + f);
  const html = readFileSync(join(REPO, 'web/index.html'), 'utf8');
  for (const f of issue.gone) assert.ok(!html.includes('js/' + f + '"') && !html.includes('js/' + f + '?'), 'index.html 이 싣는다: ' + f);
  for (const f of issue.ctl) assert.doesNotMatch(read(f), /Object\.assign\(App\.prototype/, f);
  const mixins = walk(JS_ROOT, (n) => n.endsWith('.js')).filter((f) => !f.includes('/test/'))
    .filter((f) => readFileSync(f, 'utf8').includes('Object.assign(App.prototype'));
  assert.ok(mixins.length <= issue.mixins, 'mixin 파일 ' + mixins.length + ' > ' + issue.mixins);
});

test('TC-FEA-3(9b): 옮긴 묶음의 계약 이름이 App 원형에서 함수로 읽힌다', () => {
  const ctx = load9b();
  const contract = contractNames();
  const names = ['_isToolFocusedActive', '_onToolAttention', '_attnRestore', '_attnClear', 'jumpToTool', '_attnRefresh', '_attnBeep',
    '_onClaudeAccountsChanged', 'updateStatusBar'];
  for (const n of names) {
    assert.ok(contract.has(n), '계약에 없다: ' + n);
    assert.equal(typeof ctx.App.prototype[n], 'function', n);
  }
});

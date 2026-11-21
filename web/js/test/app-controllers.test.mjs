import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { BASE, FOCUS, GIT, PANELS, SETTINGS, SLOTS, WS_SYNC, controllers, load, plain } from './harness.mjs';

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
  '9c': {
    ctl: ['core/chat-controller.js', 'core/chat-window.js', 'core/chat-human.js', 'core/chat-views.js', 'core/agents-controller.js',
      'core/agents-sub.js', 'core/activity-list.js', 'core/mobile-controller.js', 'core/mobile-nav.js', 'core/mobile-sheets.js'],
    gone: ['core/app-chat.js', 'core/app-chat-window.js', 'ui/chat-view.js', 'core/app-agents.js', 'core/app-agents-sub.js',
      'core/app-activity.js', 'core/app-mobile.js', 'core/app-mobile-nav.js', 'core/app-mobile-sheets.js'],
    plainNow: ['core/chat-human.js'],
    mixins: 30,
  },
  '9d': {
    ctl: ['core/git-controller.js', 'core/git-surfaces.js', 'core/git-sync.js'],
    gone: ['core/app-git.js'],
    plainNow: [],
    mixins: 29,
  },
  '9f': {
    ctl: ['core/ws-sync-controller.js', 'core/soft-reload.js'],
    gone: ['core/app-ws-sync.js', 'core/app-reload.js'],
    plainNow: [],
    mixins: 27,
  },
  '9g': {
    ctl: ['core/focus-controller.js', 'core/focus-highlight.js', 'core/focus-owner.js'],
    gone: ['core/app-focus.js', 'core/app-focus-hl.js', 'core/app-focus-owner.js'],
    plainNow: [],
    mixins: 24,
  },
  '9h': {
    ctl: ['core/slots-controller.js', 'core/slot-ops.js'],
    gone: ['core/app-slots.js'],
    plainNow: [],
    mixins: 23,
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

// ── 9c: 채팅 · 활동·에이전트 · 모바일 ───────────────────────────────────────────────────

const CLASSES_9C = ['ChatController', 'ChatWindow', 'ChatHuman', 'ChatViews', 'AgentsController', 'AgentsSub', 'ActivityList',
  'MobileController', 'MobileNav', 'MobileSheets'];

const DELEGATES_9C = {
  chat: ['_chatRestore', '_onChatChanged', '_onChatMessage', 'chatUnreadTotal', '_chatItems', '_addChatTab'],
  'chat.window': ['chatWindowOpen', '_chatNormalize', '_chatRepaint', 'chatPanelRender'],
  'chat.views': ['chatViewEl', '_chatViewsPaint'],
  agents: ['_onToolActivity', '_activityRestore', 'agentsToggle', 'setAgentsPanelOpen', 'agentsPanelOpen', '_agentsPanelShown',
    'reorderAgents', '_pruneAgentOrder', '_agentOrderSync', 'agentsRender', '_agWindowItems', '_agFolded'],
  'agents.sub': ['_onToolSubagentActivity'],
  'agents.list': ['actPanel', '_actTabSelect', 'actPanelOpen', '_actRefresh', '_actBgRows', '_actCellsEl', '_actUsageWinEl',
    '_actRunsRows'],
  mobile: ['applyMobileMode', '_toggleDrawer', 'mobileSideSlots', 'mobileOnSide', 'mobileShowPane', 'mobilePaneCount', 'initMobile',
    'initMobileKeybar', 'mTopPaint', '_mkbRender', '_scheduleFit', '_scheduleMobileFit', '_mobileVvApply', '_kbSuppressAll',
    'mkbRefresh'],
  'mobile.nav': ['actSheetLeave', 'mobileActSync', 'mobileRepoSegSync'],
  'mobile.sheets': ['mobileChromeSync', '_settingsMobileOnOpen'],
};

const FILES_9C = ['core/chat-store.js', 'core/chat-controller.js', 'core/chat-views.js', 'core/chat-human.js', 'core/chat-window.js',
  'core/agents-controller.js', 'core/agents-sub.js', 'core/activity-list.js', 'core/mobile-controller.js', 'core/mobile-sheets.js',
  'core/mobile-nav.js'];

function load9c(globals = {}) {
  return load([...BASE, ...PANELS, ...FILES_9C], {
    expose: [...CLASSES_9C, 'Controller', 'Component'],
    globals: {
      App: function App() {}, TIMERS: { disposeOwner() {} }, t: (k) => k, tn: (k) => k,
      document: { getElementById: () => null, querySelector: () => null },
      ...globals,
    },
  });
}

test('TC-FEA-1(9c): 컨트롤러와 부품은 Controller·Component 하위이고 app 을 든다', () => {
  const ctx = load9c();
  const app = new ctx.App();
  for (const c of CLASSES_9C) {
    const o = new ctx[c](app);
    assert.ok(o instanceof ctx.Controller, c);
    assert.ok(o instanceof ctx.Component, c);
    assert.equal(o.app, app, c);
  }
  const chat = new ctx.ChatController(app);
  assert.ok(chat.window instanceof ctx.ChatWindow);
  assert.ok(chat.human instanceof ctx.ChatHuman);
  assert.ok(chat.views instanceof ctx.ChatViews);
  const agents = new ctx.AgentsController(app);
  assert.ok(agents.sub instanceof ctx.AgentsSub);
  assert.ok(agents.list instanceof ctx.ActivityList);
  const mobile = new ctx.MobileController(app);
  assert.ok(mobile.nav instanceof ctx.MobileNav);
  assert.ok(mobile.sheets instanceof ctx.MobileSheets);
});

test('TC-FEA-1(9c): App 생성자가 컨트롤러를 만든다', () => {
  const src = read('core/app.js');
  const ctor = src.slice(src.indexOf('  constructor(){'), src.indexOf('\n  }\n', src.indexOf('  constructor(){')));
  for (const line of ['this.chat=new ChatController(this);', 'this.agents=new AgentsController(this);',
    'this.mobile=new MobileController(this);']) assert.ok(ctor.includes(line), line);
});

test('TC-FEA-1(9c): 위임자는 컨트롤러 메서드를 같은 인자로 부르고 값을 돌려준다', () => {
  const ctx = load9c();
  const app = new ctx.App();
  app.chat = { window: {}, views: {} };
  app.agents = { sub: {}, list: {} };
  app.mobile = { nav: {}, sheets: {} };
  const seen = [];
  for (const [path, names] of Object.entries(DELEGATES_9C)) {
    const target = path.split('.').reduce((o, k) => o[k], app);
    for (const n of names) target[n] = (...a) => { seen.push([n, ...a]); return 'r:' + n };
  }
  for (const names of Object.values(DELEGATES_9C)) for (const n of names) assert.equal(app[n](1, 'x'), 'r:' + n, n);
  assert.deepEqual(plain(seen), Object.values(DELEGATES_9C).flat().map((n) => [n, 1, 'x']));
});

test('TC-FEA-2(9c): 컨트롤러는 덮어쓰기 대상·계약 이름을 this.app 으로 부른다', () => {
  const force = new Set([...overridden(), ...contractNames()]);
  for (const f of ISSUES['9c'].ctl) {
    const bad = [...thisNames(read(f))].filter((n) => force.has(n));
    assert.deepEqual(bad, [], f);
  }
});

test('TC-FEA-2(9c): 갈아 끼운 _chatRepaint·_chatViewsPaint·_runsPanel·_activityRestore·mobileChromeSync 를 컨트롤러 경로가 부른다', () => {
  const ctx = load9c();
  const app = new ctx.App();
  app.chat = new ctx.ChatController(app);
  app.agents = new ctx.AgentsController(app);
  app.mobile = new ctx.MobileController(app);
  const log = [];
  app.chat._chatS = () => ({ add: () => true });
  app.chat.views._chatRoomShown = () => false;
  app._chatRepaint = () => log.push('chatRepaint');
  app._chatViewsPaint = (room) => log.push('views:' + room);
  app.chat._onChatMessage({ msg: { room: 'r1' } });
  app._bgRefresh = () => log.push('bg');
  app._runsPanel = () => ({ _runsRefresh: () => log.push('runs') });
  app._activityRestore = () => log.push('activity');
  app.agents.list._actRefresh();
  Object.defineProperty(app, 'isMobile', { value: false });
  app.mobile.drawerSheet = () => ({ close: () => false });
  app.mobileChromeSync = () => log.push('chrome');
  app.mobile._toggleDrawer();
  assert.deepEqual(log, ['chatRepaint', 'views:r1', 'bg', 'runs', 'activity', 'chrome']);
});

test('TC-FEA-3(9c): 옮긴 mixin 파일이 없고 Object.assign(App.prototype 의 수가 준다', () => {
  const issue = ISSUES['9c'];
  for (const f of issue.gone) assert.ok(!existsSync(join(JS_ROOT, f)), '남았다: ' + f);
  const html = readFileSync(join(REPO, 'web/index.html'), 'utf8');
  for (const f of issue.gone) assert.ok(!html.includes('js/' + f + '"') && !html.includes('js/' + f + '?'), 'index.html 이 싣는다: ' + f);
  for (const f of issue.ctl) assert.doesNotMatch(read(f), /Object\.assign\(App\.prototype/, f);
  const mixins = walk(JS_ROOT, (n) => n.endsWith('.js')).filter((f) => !f.includes('/test/'))
    .filter((f) => readFileSync(f, 'utf8').includes('Object.assign(App.prototype'));
  assert.ok(mixins.length <= issue.mixins, 'mixin 파일 ' + mixins.length + ' > ' + issue.mixins);
});

test('TC-FEA-3(9c): 옮긴 묶음의 계약 이름이 App 원형에서 함수로 읽힌다', () => {
  const ctx = load9c();
  const contract = contractNames();
  const names = ['_onToolActivity', '_activityRestore', 'agentsToggle', '_scheduleMobileFit', '_mobileVvApply'];
  for (const n of names) {
    assert.ok(contract.has(n), '계약에 없다: ' + n);
    assert.equal(typeof ctx.App.prototype[n], 'function', n);
  }
});

// ── 9d: git ──────────────────────────────────────────────────────────────────────

const CLASSES_9D = ['GitController', 'GitSurfaces', 'GitSync'];

const DELEGATES_9D = {
  git: ['gitWindow', 'isGitWin', 'isChatWin', 'isKindWin', 'plainWindows', 'gitBackTarget', '_migrateGitWindow', 'openGitWindow',
    '_initGitSection', 'gitSignal', 'gitStatusHub', 'gitOpenFile', 'gitOpenFileHead', 'gitOpenTerminal', 'gitBadgeFor', 'gitPinEntry',
    '_gitTermToolId'],
  'git.surfaces': ['gitObs', '_gitRescheduleAll', 'gitWatchdogAll', '_gitNotifyPinsAll', 'gitPanelAt', '_gitDropView',
    '_gitViewDirty', '_gitDiffDocPaths', '_gitViewSave', 'gitSurfaceOn', '_gitPanelKey', '_gitPanelRoot', '_gitPanelReap',
    '_gitRootOfActive'],
  'git.sync': ['gitReposKick', '_gitObserveOk', '_onGitChanged', '_gitObserveRestore', 'gitReposRefresh', 'gitPin', 'gitUnpin',
    '_gitPinsApply', '_pollGitJobs', '_gitJobsBegin', '_gitJobsSettle'],
};

function load9d(globals = {}) {
  return load([...BASE, ...GIT], {
    expose: [...CLASSES_9D, 'Controller', 'Component'],
    globals: {
      App: function App() {}, TIMERS: { disposeOwner() {} }, t: (k) => k, tn: (k) => k,
      document: { getElementById: () => null, querySelector: () => null },
      ...globals,
    },
  });
}

test('TC-FEA-1(9d): 컨트롤러와 부품은 Controller·Component 하위이고 app 을 든다', () => {
  const ctx = load9d();
  const app = new ctx.App();
  for (const c of CLASSES_9D) {
    const o = new ctx[c](app);
    assert.ok(o instanceof ctx.Controller, c);
    assert.ok(o instanceof ctx.Component, c);
    assert.equal(o.app, app, c);
  }
  const git = new ctx.GitController(app);
  assert.ok(git.surfaces instanceof ctx.GitSurfaces);
  assert.ok(git.sync instanceof ctx.GitSync);
});

test('TC-FEA-1(9d): App 생성자가 컨트롤러를 만든다', () => {
  const src = read('core/app.js');
  const ctor = src.slice(src.indexOf('  constructor(){'), src.indexOf('\n  }\n', src.indexOf('  constructor(){')));
  assert.ok(ctor.includes('this.git=new GitController(this);'));
});

test('TC-FEA-1(9d): 위임자는 컨트롤러 메서드를 같은 인자로 부르고 값을 돌려준다', () => {
  const ctx = load9d();
  const app = new ctx.App();
  app.git = { surfaces: {}, sync: {} };
  const seen = [];
  for (const [path, names] of Object.entries(DELEGATES_9D)) {
    const target = path.split('.').reduce((o, k) => o[k], app);
    for (const n of names) target[n] = (...a) => { seen.push([n, ...a]); return 'r:' + n };
  }
  for (const names of Object.values(DELEGATES_9D)) for (const n of names) assert.equal(app[n](1, 'x'), 'r:' + n, n);
  assert.deepEqual(plain(seen), Object.values(DELEGATES_9D).flat().map((n) => [n, 1, 'x']));
});

test('TC-FEA-1(9d): gitPanel 접근자는 App 에 남아 포커스 칸의 지금 표면 패널을 준다', () => {
  const ctx = load9d();
  const app = new ctx.App();
  app.git = { surfaces: { _gitRootOfActive: () => '/r', gitPanelAt: (root, slot) => 'p:' + root + ':' + slot } };
  app.slotFocused = () => 2;
  assert.equal(app.gitPanel, 'p:/r:2');
});

test('TC-FEA-2(9d): 컨트롤러는 덮어쓰기 대상·계약 이름을 this.app 으로 부른다', () => {
  const force = new Set([...overridden(), ...contractNames()]);
  for (const f of ISSUES['9d'].ctl) {
    const bad = [...thisNames(read(f))].filter((n) => force.has(n));
    assert.deepEqual(bad, [], f);
  }
});

test('TC-FEA-2(9d): 갈아 끼운 plainWindows·gitReposRefresh·gitSignal·_gitObservers 를 컨트롤러 경로가 부른다', async () => {
  const ctx = load9d();
  const app = new ctx.App();
  app.git = new ctx.GitController(app);
  const log = [];
  app._lastPlainWindow = 'w2';
  app.plainWindows = () => { log.push('plain'); return [{ id: 'w1' }, { id: 'w2' }] };
  assert.equal(app.git.gitBackTarget().id, 'w2');
  app.gitReposRefresh = async () => { log.push('refresh') };
  app.sbTab = 'repo';
  app.gitReposKick();
  await new Promise((r) => setImmediate(r));
  app.gitSignal = (k) => log.push('signal:' + k);
  app.gitPanels = new Map();
  app.git._gitLifecycle('focus');
  app._gitObservers = new Map([['/r', { any: () => ({ collect: () => log.push('collect') }) }]]);
  app._gitOff = true;
  app.git.sync._gitObserveRestore();
  assert.deepEqual(log, ['plain', 'refresh', 'signal:focus', 'collect']);
});

test('FR-FEA-5(9d): gitSignal 은 허브 무효화 → 포커스 패널 신호 → 편집기 후속 순서다 — 로드 시점 감싸기가 없다', () => {
  const ctx = load9d();
  const app = new ctx.App();
  app.git = new ctx.GitController(app);
  const log = [];
  app.git._gitHub = { invalidate: () => log.push('invalidate') };
  Object.defineProperty(app, 'gitPanel', { value: { signal: (k) => log.push('panel:' + k) } });
  app._edAfterGitSignal = (k) => log.push('editor:' + k);
  app.gitSignal('write');
  assert.deepEqual(log, ['invalidate', 'panel:write', 'editor:write']);
  assert.doesNotMatch(read('core/app-editor-pane.js'), /App\.prototype\.gitSignal/);
});

test('FR-FEA-5(9d): 편집기 후속은 활성 트리를 즉시 묻고 열린 문서의 기준을 다시 받는다', () => {
  const ctx = load([...BASE, ...GIT, 'core/app-editor-pane.js'], {
    globals: { App: function App() {}, TIMERS: { disposeOwner() {} } },
  });
  const app = controllers(ctx, new ctx.App());
  const log = [];
  app.git._gitHub = { invalidate: () => log.push('invalidate') };
  Object.defineProperty(app, 'gitPanel', { value: null });
  app.edActiveTree = () => ({ pollGit: (o) => log.push('tree:' + o.now) });
  app._edDocs = new Map([['a', { dd: { refresh: () => log.push('dd') } }], ['b', {}]]);
  app.gitSignal('save');
  assert.deepEqual(log, ['invalidate', 'tree:true', 'dd']);
});

test('TC-FEA-3(9d): 옮긴 mixin 파일이 없고 Object.assign(App.prototype 의 수가 준다', () => {
  const issue = ISSUES['9d'];
  for (const f of issue.gone) assert.ok(!existsSync(join(JS_ROOT, f)), '남았다: ' + f);
  const html = readFileSync(join(REPO, 'web/index.html'), 'utf8');
  for (const f of issue.gone) assert.ok(!html.includes('js/' + f + '"') && !html.includes('js/' + f + '?'), 'index.html 이 싣는다: ' + f);
  for (const f of issue.ctl) assert.doesNotMatch(read(f), /Object\.assign\(App\.prototype/, f);
  const mixins = walk(JS_ROOT, (n) => n.endsWith('.js')).filter((f) => !f.includes('/test/'))
    .filter((f) => readFileSync(f, 'utf8').includes('Object.assign(App.prototype'));
  assert.ok(mixins.length <= issue.mixins, 'mixin 파일 ' + mixins.length + ' > ' + issue.mixins);
});

test('TC-FEA-3(9d): 옮긴 묶음의 계약 이름이 App 원형에서 함수로 읽힌다', () => {
  const ctx = load9d();
  const contract = contractNames();
  for (const n of Object.values(DELEGATES_9D).flat().filter((x) => contract.has(x)))
    assert.equal(typeof ctx.App.prototype[n], 'function', n);
  for (const n of ['gitPanelAt', 'gitSignal', 'gitPin', 'gitUnpin', 'gitReposRefresh', '_onGitChanged', 'plainWindows'])
    assert.ok(contract.has(n), '계약에 없다: ' + n);
});

// ── 9f: 상태 동기화·재로드 ─────────────────────────────────────────────────────────

const CLASSES_9F = ['WsSyncController', 'SoftReload'];

const DELEGATES_9F = {
  wsSync: ['_restoreBegin', '_restoreLive', '_restoreNote', '_restoreVoid', '_restoreEnd', '_subscribeCommands',
    '_onWorkspaceChanged', '_onToolForeground', '_fgMap', '_fgApply', '_fgRepaint', '_applyRemoteWorkspace'],
  'wsSync.reload': ['softReload', '_initSoftReload'],
};

function load9f(globals = {}) {
  return load([...BASE, ...WS_SYNC], {
    expose: [...CLASSES_9F, 'Controller', 'Component'],
    globals: {
      App: function App() {}, TIMERS: { disposeOwner() {} }, t: (k) => k, tn: (k) => k,
      document: { getElementById: () => null, querySelector: () => null },
      BootScreen: { show() {}, done() {} }, BOOT_STEP_RELOAD: 'reload', RELOAD_BTN_ID: 'reload-btn',
      RELOAD_TITLE: 'r', RELOAD_BUSY_TITLE: 'b',
      ...globals,
    },
  });
}

test('TC-FEA-1(9f): 컨트롤러와 부품은 Controller·Component 하위이고 app 을 든다', () => {
  const ctx = load9f();
  const app = new ctx.App();
  for (const c of CLASSES_9F) {
    const o = new ctx[c](app);
    assert.ok(o instanceof ctx.Controller, c);
    assert.ok(o instanceof ctx.Component, c);
    assert.equal(o.app, app, c);
  }
  assert.ok(new ctx.WsSyncController(app).reload instanceof ctx.SoftReload);
});

test('TC-FEA-1(9f): App 생성자가 컨트롤러를 만든다', () => {
  const src = read('core/app.js');
  const ctor = src.slice(src.indexOf('  constructor(){'), src.indexOf('\n  }\n', src.indexOf('  constructor(){')));
  assert.ok(ctor.includes('this.wsSync=new WsSyncController(this);'));
});

test('TC-FEA-1(9f): 위임자는 컨트롤러 메서드를 같은 인자로 부르고 값을 돌려준다', () => {
  const ctx = load9f();
  const app = new ctx.App();
  app.wsSync = { reload: {} };
  const seen = [];
  for (const [path, names] of Object.entries(DELEGATES_9F)) {
    const target = path.split('.').reduce((o, k) => o[k], app);
    for (const n of names) target[n] = (...a) => { seen.push([n, ...a]); return 'r:' + n };
  }
  for (const names of Object.values(DELEGATES_9F)) for (const n of names) assert.equal(app[n](1, 'x'), 'r:' + n, n);
  assert.deepEqual(plain(seen), Object.values(DELEGATES_9F).flat().map((n) => [n, 1, 'x']));
});

test('TC-FEA-1(9f): _sse 접근자 넷은 App 원형에 남아 버스를 읽고 _sseSeen 은 버스에 쓴다', () => {
  const ctx = load9f();
  const app = new ctx.App();
  assert.equal(app._sse, null);
  assert.equal(app._sseGen, 0);
  app.bus = { _es: 'es', gen: () => 3, lastSeen: () => 7, _seen: 0 };
  assert.equal(app._sse, 'es');
  assert.equal(app._cmdES, 'es');
  assert.equal(app._sseGen, 3);
  assert.equal(app._sseSeen, 7);
  app._sseSeen = 9;
  assert.equal(app.bus._seen, 9);
});

test('TC-FEA-1(9f): 저장 경로가 함께 쓰는 필드는 App 에 남는다 — 저장 중 알림의 유예가 App 에 적힌다', async () => {
  const ctx = load9f();
  const app = controllers(ctx, new ctx.App());
  app._saveInflight = true;
  await app._onWorkspaceChanged(5);
  assert.equal(app._wsApplyPending, true);
  assert.equal(app._wsDeferRev, 5);
  assert.equal(Object.hasOwn(app.wsSync, '_wsApplyPending'), false);
  assert.doesNotMatch(read('core/ws-sync-controller.js'), /(?<![\w$.])this\.(wsETag|_wsDeferRev|_wsApplyPending|_saveInflight|_wsApplyInflight|_sseKick|fgNames)\b/);
});

test('TC-FEA-2(9f): 컨트롤러는 덮어쓰기 대상·계약 이름을 this.app 으로 부른다', () => {
  const force = new Set([...overridden(), ...contractNames()]);
  for (const f of ISSUES['9f'].ctl) {
    const bad = [...thisNames(read(f))].filter((n) => force.has(n));
    assert.deepEqual(bad, [], f);
  }
});

test('TC-FEA-2(9f): 갈아 끼운 _onWorkspaceChanged·gitReposRefresh·render·softReload·_fgMap·_restore* 를 컨트롤러 경로가 부른다', async () => {
  let click = null;
  const ctx = load9f({
    document: {
      getElementById: (id) => (id === 'reload-btn' ? { classList: { toggle() {} }, addEventListener: (t, fn) => { click = fn } } : null),
      querySelector: () => null,
    },
  });
  const app = controllers(ctx, new ctx.App());
  const log = [];
  app.bus = { publish: () => log.push('publish') };
  app._onWorkspaceChanged = async () => { log.push('ws') };
  app.gitReposRefresh = () => log.push('repos');
  app.render = () => log.push('render');
  assert.equal(await app.wsSync.reload.softReload(), true);
  app.softReload = () => log.push('soft');
  app._initSoftReload();
  click();
  const map = new Map();
  app._fgMap = () => map;
  app._restoreNote = (k, id) => log.push('note:' + k + ':' + id);
  app.ws = { windows: [] };
  app.renderer = { _rPaintTitles() {} };
  app.wsSync._onToolForeground({ toolId: 't1', name: 'vim' });
  assert.equal(map.get('t1'), 'vim');
  assert.deepEqual(log, ['ws', 'publish', 'repos', 'render', 'soft', 'note:fg:t1']);
});

test('TC-FEA-3(9f): 옮긴 mixin 파일이 없고 Object.assign(App.prototype 의 수가 준다', () => {
  const issue = ISSUES['9f'];
  for (const f of issue.gone) assert.ok(!existsSync(join(JS_ROOT, f)), '남았다: ' + f);
  const html = readFileSync(join(REPO, 'web/index.html'), 'utf8');
  for (const f of issue.gone) assert.ok(!html.includes('js/' + f + '"') && !html.includes('js/' + f + '?'), 'index.html 이 싣는다: ' + f);
  for (const f of issue.ctl) assert.doesNotMatch(read(f), /Object\.assign\(App\.prototype/, f);
  const mixins = walk(JS_ROOT, (n) => n.endsWith('.js')).filter((f) => !f.includes('/test/'))
    .filter((f) => readFileSync(f, 'utf8').includes('Object.assign(App.prototype'));
  assert.ok(mixins.length <= issue.mixins, 'mixin 파일 ' + mixins.length + ' > ' + issue.mixins);
});

test('TC-FEA-3(9f): 옮긴 묶음의 계약 이름이 App 원형에서 함수로 읽힌다', () => {
  const ctx = load9f();
  const contract = contractNames();
  for (const n of Object.values(DELEGATES_9F).flat().filter((x) => contract.has(x)))
    assert.equal(typeof ctx.App.prototype[n], 'function', n);
  for (const n of ['_onWorkspaceChanged', '_applyRemoteWorkspace', '_subscribeCommands', '_fgApply', '_restoreBegin'])
    assert.ok(contract.has(n), '계약에 없다: ' + n);
});

// ── 9g: 포커스·창 소유 ──────────────────────────────────────────────────────────

const CLASSES_9G = ['FocusController', 'FocusHighlight', 'FocusOwner'];

const DELEGATES_9G = {
  focus: ['setFocusState', 'focusClear', '_navPlace', '_navNote', 'navJump', '_navRetab', 'navCan', 'navBack', 'navForward',
    '_navCounts', 'setFocus', '_initFocusSync', '_paintFocusEdge', '_paintAttnEdge'],
  'focus.hl': ['attnFocusSync', 'focusHighlightSync'],
  'focus.owner': ['_focusWindow', '_onWindowFocus', '_focusRestore', 'resizeCheck', 'applyFocusOverlay', 'resendWindowSizes'],
};

function load9g(globals = {}) {
  return load([...BASE, ...FOCUS], {
    expose: [...CLASSES_9G, 'Controller', 'Component'],
    globals: {
      App: function App() {}, TIMERS: { disposeOwner() {} }, t: (k) => k, tn: (k) => k, apiPost: () => {},
      document: { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [] },
      ...globals,
    },
  });
}

test('TC-FEA-1(9g): 컨트롤러와 부품은 Controller·Component 하위이고 app 을 든다', () => {
  const ctx = load9g();
  const app = new ctx.App();
  for (const c of CLASSES_9G) {
    const o = new ctx[c](app);
    assert.ok(o instanceof ctx.Controller, c);
    assert.ok(o instanceof ctx.Component, c);
    assert.equal(o.app, app, c);
  }
  const focus = new ctx.FocusController(app);
  assert.ok(focus.hl instanceof ctx.FocusHighlight);
  assert.ok(focus.owner instanceof ctx.FocusOwner);
});

test('TC-FEA-1(9g): App 생성자가 컨트롤러를 만든다', () => {
  const src = read('core/app.js');
  const ctor = src.slice(src.indexOf('  constructor(){'), src.indexOf('\n  }\n', src.indexOf('  constructor(){')));
  assert.ok(ctor.includes('this.focus=new FocusController(this);'));
});

test('TC-FEA-1(9g): 위임자는 컨트롤러 메서드를 같은 인자로 부르고 값을 돌려준다', () => {
  const ctx = load9g();
  const app = new ctx.App();
  app.focus = { hl: {}, owner: {} };
  const seen = [];
  for (const [path, names] of Object.entries(DELEGATES_9G)) {
    const target = path.split('.').reduce((o, k) => o[k], app);
    for (const n of names) target[n] = (...a) => { seen.push([n, ...a]); return 'r:' + n };
  }
  for (const names of Object.values(DELEGATES_9G)) for (const n of names) assert.equal(app[n](1, 'x'), 'r:' + n, n);
  assert.deepEqual(plain(seen), Object.values(DELEGATES_9G).flat().map((n) => [n, 1, 'x']));
});

test('TC-FEA-1(9g): focused 의 쓰기는 포커스 묶음 하나다 — 레이아웃의 null 대입은 focusClear 를 부른다 (§2.2 SH-2)', () => {
  const ctx = load9g();
  const app = controllers(ctx, new ctx.App());
  app.focused = 'p1';
  app.focusClear();
  assert.equal(app.focused, null);
  assert.equal(Object.hasOwn(app.focus, 'focused'), false);
  const layout = read('core/app-layout.js');
  assert.doesNotMatch(layout, /this\.focused\s*=(?!=)/);
  assert.equal(layout.match(/this\.focusClear\(\)/g).length, 2);
  for (const f of walk(JS_ROOT, (n) => n.endsWith('.js')).filter((x) => !x.includes('/test/') && !x.endsWith('/core/app.js')
    && !x.endsWith('/core/focus-controller.js')))
    assert.doesNotMatch(readFileSync(f, 'utf8'), /\b(?:this|app|this\.app)\.focused\s*=(?!=)/, f);
});

test('TC-FEA-2(9g): 컨트롤러는 덮어쓰기 대상·계약 이름을 this.app 으로 부른다', () => {
  const force = new Set([...overridden(), ...contractNames()]);
  for (const f of ISSUES['9g'].ctl) {
    const bad = [...thisNames(read(f))].filter((n) => force.has(n));
    assert.deepEqual(bad, [], f);
  }
});

test('TC-FEA-2(9g): 갈아 끼운 setFocusState·updateStatusBar·save·_agFocusedTool·_attnClear·slotFocused 를 컨트롤러 경로가 부른다', () => {
  const ctx = load9g();
  const app = controllers(ctx, new ctx.App());
  const log = [];
  app.ws = { activeWindow: 'w1', windows: [] };
  app._windowFocusOwner = {};
  app._slotIdentity = () => 'me';
  for (const n of ['clearAllSearchDecorations', 'researchIfOpen', 'updateCwd', '_gitTermToolId']) app[n] = () => {};
  app.renderer = { _rPaintTitles() {} };
  app.setFocusState = (rid) => log.push('state:' + rid);
  app.updateStatusBar = () => log.push('status');
  app.save = () => log.push('save');
  app.slotFocused = () => { log.push('slot'); return 0 };
  app.setFocus('p2');
  assert.equal(app.prevFocus, 'p2');
  app._attn = new Map([['b', {}]]);
  let cur = 'a';
  app._agFocusedTool = () => cur;
  app._attnClear = (id) => log.push('clear:' + id);
  app.attnFocusSync();
  cur = 'b';
  app.attnFocusSync();
  assert.deepEqual(log, ['slot', 'state:p2', 'status', 'save', 'clear:b']);
});

test('TC-FEA-3(9g): 옮긴 mixin 파일이 없고 Object.assign(App.prototype 의 수가 준다', () => {
  const issue = ISSUES['9g'];
  for (const f of issue.gone) assert.ok(!existsSync(join(JS_ROOT, f)), '남았다: ' + f);
  const html = readFileSync(join(REPO, 'web/index.html'), 'utf8');
  for (const f of issue.gone) assert.ok(!html.includes('js/' + f + '"') && !html.includes('js/' + f + '?'), 'index.html 이 싣는다: ' + f);
  for (const f of issue.ctl) assert.doesNotMatch(read(f), /Object\.assign\(App\.prototype/, f);
  const mixins = walk(JS_ROOT, (n) => n.endsWith('.js')).filter((f) => !f.includes('/test/'))
    .filter((f) => readFileSync(f, 'utf8').includes('Object.assign(App.prototype'));
  assert.ok(mixins.length <= issue.mixins, 'mixin 파일 ' + mixins.length + ' > ' + issue.mixins);
});

test('TC-FEA-3(9g): 옮긴 묶음의 계약 이름이 App 원형에서 함수로 읽힌다', () => {
  const ctx = load9g();
  const contract = contractNames();
  for (const n of Object.values(DELEGATES_9G).flat().filter((x) => contract.has(x)))
    assert.equal(typeof ctx.App.prototype[n], 'function', n);
  for (const n of ['_navPlace', '_navCounts', 'resizeCheck'])
    assert.ok(contract.has(n), '계약에 없다: ' + n);
});

// ── 9h: 슬롯 ────────────────────────────────────────────────────────────────────

const CLASSES_9H = ['SlotsController', 'SlotOps'];

const DELEGATES_9H = {
  slot: ['slotCount', 'slotFocused', 'slotKey', 'slotKeysOf', 'editorsOf', 'editorAny', 'editorsDrop', '_slotOf', 'slotBase',
    'paneTab', 'paneTabSet', '_slotTabsToWs', 'slotWindow', 'windowVisible', '_slotIdentity', '_slotsRestore'],
  'slot.ops': ['slotAdd', 'slotRemove', 'slotFocusTo', 'slotNav', 'slotRenderFlush', 'slotOpen', '_slotClaimAll', '_slotOnSwitch',
    '_slotOnWindowGone', 'slotNavigate', '_initSlots', '_slotDirPaint', 'slotHandleBind', 'slotApplySizes'],
};

function load9h(globals = {}) {
  return load([...BASE, ...SLOTS], {
    expose: [...CLASSES_9H, 'Controller', 'Component'],
    globals: {
      App: function App() {}, TIMERS: { disposeOwner() {} }, t: (k) => k, tn: (k) => k,
      document: { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [] },
      ...globals,
    },
  });
}

test('TC-FEA-1(9h): 컨트롤러와 부품은 Controller·Component 하위이고 app 을 든다', () => {
  const ctx = load9h();
  const app = new ctx.App();
  for (const c of CLASSES_9H) {
    const o = new ctx[c](app);
    assert.ok(o instanceof ctx.Controller, c);
    assert.ok(o instanceof ctx.Component, c);
    assert.equal(o.app, app, c);
  }
  const slot = new ctx.SlotsController(app);
  assert.ok(slot.ops instanceof ctx.SlotOps);
  assert.deepEqual(plain(slot._slotIds), []);
  assert.deepEqual(plain(slot._slotSse), []);
});

test('TC-FEA-1(9h): App 생성자가 컨트롤러를 만들고 칸 신원·구독은 App 에서 빠진다 (§2.2 C/9h)', () => {
  const src = read('core/app.js');
  const ctor = src.slice(src.indexOf('  constructor(){'), src.indexOf('\n  }\n', src.indexOf('  constructor(){')));
  assert.ok(ctor.includes('this.slot=new SlotsController(this);'));
  assert.doesNotMatch(ctor, /this\._slotIds=|this\._slotSse=/);
  assert.ok(ctor.includes('this._slots=null;'));
});

test('TC-FEA-1(9h): 위임자는 컨트롤러 메서드를 같은 인자로 부르고 값을 돌려준다', () => {
  const ctx = load9h();
  const app = new ctx.App();
  app.slot = { ops: {} };
  const seen = [];
  for (const [path, names] of Object.entries(DELEGATES_9H)) {
    const target = path.split('.').reduce((o, k) => o[k], app);
    for (const n of names) target[n] = (...a) => { seen.push([n, ...a]); return 'r:' + n };
  }
  for (const names of Object.values(DELEGATES_9H)) for (const n of names) assert.equal(app[n](1, 'x'), 'r:' + n, n);
  assert.deepEqual(plain(seen), Object.values(DELEGATES_9H).flat().map((n) => [n, 1, 'x']));
});

test('TC-FEA-1(9h): 접근자 slots·slotDir 는 App 원형에 남는다 — slotDir 를 쓰면 App 의 render 가 돈다', () => {
  const store = new Map();
  const ctx = load9h({ PrefStore: { session: { get: (k) => store.get(k), set: (k, v) => store.set(k, v) } } });
  const app = new ctx.App();
  assert.equal(app.slots, null);
  app._slots = { windows: ['a'], focused: 0 };
  assert.equal(app.slots, app._slots);
  assert.equal(app.slotDir, 'horizontal');
  let n = 0;
  app.render = () => n++;
  app.slotDir = 'vertical';
  assert.equal(app.slotDir, 'vertical');
  assert.equal(n, 1);
});

test('TC-FEA-2(9h): 컨트롤러는 덮어쓰기 대상·계약 이름을 this.app 으로 부른다', () => {
  const force = new Set([...overridden(), ...contractNames()]);
  for (const f of ISSUES['9h'].ctl) {
    const bad = [...thisNames(read(f))].filter((n) => force.has(n));
    assert.deepEqual(bad, [], f);
  }
});

test('TC-FEA-2(9h): 갈아 끼운 slotFocused·_slotIdentity·slotWindow·slotRenderFlush 를 컨트롤러 경로가 부른다', () => {
  let up = null;
  const ctx = load9h({ addEventListener: (t, fn) => { up = fn } });
  const app = controllers(ctx, new ctx.App());
  const log = [];
  app._slots = { windows: ['w1', 'w2'], focused: 1, tabs: [{}, {}] };
  app.fileEditors = new Map([['t@1', 'e1'], ['t', 'e0']]);
  app.slotFocused = () => { log.push('focused'); return 1 };
  assert.equal(app.editorAny('t'), 'e1');
  app._slotIdentity = (i) => { log.push('id:' + i); return 'c' + i };
  assert.deepEqual(plain(app.slot._slotIdentities()), ['c0', 'c1']);
  app.slotWindow = (i) => { log.push('win:' + i); return null };
  assert.equal(app._slotTabsToWs(), false);
  app.timers = { defer: (fn) => fn() };
  app.slotRenderFlush = () => log.push('flush');
  app.slot.ops._slotRenderArm();
  up();
  assert.deepEqual(log, ['focused', 'id:0', 'id:1', 'focused', 'win:1', 'flush']);
});

test('TC-FEA-3(9h): 옮긴 mixin 파일이 없고 Object.assign(App.prototype 의 수가 준다', () => {
  const issue = ISSUES['9h'];
  for (const f of issue.gone) assert.ok(!existsSync(join(JS_ROOT, f)), '남았다: ' + f);
  const html = readFileSync(join(REPO, 'web/index.html'), 'utf8');
  for (const f of issue.gone) assert.ok(!html.includes('js/' + f + '"') && !html.includes('js/' + f + '?'), 'index.html 이 싣는다: ' + f);
  for (const f of issue.ctl) assert.doesNotMatch(read(f), /Object\.assign\(App\.prototype/, f);
  const mixins = walk(JS_ROOT, (n) => n.endsWith('.js')).filter((f) => !f.includes('/test/'))
    .filter((f) => readFileSync(f, 'utf8').includes('Object.assign(App.prototype'));
  assert.ok(mixins.length <= issue.mixins, 'mixin 파일 ' + mixins.length + ' > ' + issue.mixins);
});

test('TC-FEA-3(9h): 옮긴 묶음의 계약 이름이 App 원형에서 함수로 읽힌다', () => {
  const ctx = load9h();
  const contract = contractNames();
  const names = Object.values(DELEGATES_9H).flat().filter((x) => contract.has(x));
  assert.ok(names.length > 0);
  for (const n of names) assert.equal(typeof ctx.App.prototype[n], 'function', n);
});

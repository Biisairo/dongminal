import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { BASE, EDITOR, FOCUS, GIT, LAYOUT, PANELS, SETTINGS, SLOTS, TOOL, WS_SYNC, controllers, load, plain } from './harness.mjs';

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
  '9i-1': {
    ctl: ['core/layout-controller.js', 'core/layout-tab-add.js', 'core/layout-tab-ops.js'],
    gone: ['core/app-layout.js'],
    plainNow: [],
    mixins: 22,
  },
  '9i-2': {
    ctl: ['core/layout-dock.js', 'core/layout-dnd.js', 'core/layout-groups.js', 'core/layout-window-state.js', 'core/layout-tab-reopen.js'],
    gone: ['core/app-dock.js', 'core/app-dnd.js', 'core/app-groups.js', 'core/app-window-state.js', 'core/app-presets.js',
      'core/app-tab-reopen.js'],
    plainNow: [],
    mixins: 16,
  },
  '9j': {
    ctl: ['core/tool-controller.js', 'core/tool-life.js', 'core/tool-cmd.js', 'core/tool-work.js', 'core/tool-search.js'],
    gone: ['core/app-tool.js', 'core/app-cmd.js', 'core/app-work.js', 'core/app-search.js'],
    plainNow: [],
    mixins: 12,
  },
  '9k-1': {
    ctl: ['core/editor-controller.js', 'core/editor-open.js', 'core/editor-pane.js', 'core/editor-section.js', 'core/editor-sync.js',
      'core/editor-watch.js'],
    gone: ['core/app-editor.js', 'core/app-editor-open.js', 'core/app-editor-pane.js', 'core/app-editor-section.js',
      'core/app-editor-sync.js', 'core/app-editor-watch.js'],
    plainNow: [],
    mixins: 6,
  },
  '9k-2': {
    ctl: ['core/editor-doc.js', 'core/editor-file.js', 'core/editor-search.js', 'core/editor-doc-render.js'],
    gone: ['core/app-editor-doc.js', 'core/app-editor-file.js', 'core/app-edsearch.js', 'core/app-docrender.js'],
    plainNow: [],
    mixins: 2,
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
  for (const f of EDITOR) assert.doesNotMatch(read(f), /App\.prototype\.gitSignal/, f);
});

test('FR-FEA-5(9d): 편집기 후속은 활성 트리를 즉시 묻고 열린 문서의 기준을 다시 받는다', () => {
  const ctx = load([...BASE, ...GIT, ...EDITOR], {
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
  const layout = read('core/layout-controller.js');
  assert.doesNotMatch(layout, /this\.(?:app\.)?focused\s*=(?!=)/);
  assert.equal(layout.match(/this\.app\.focusClear\(\)/g).length, 2);
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

// ── 9i-1: 레이아웃 — 창 · 탭 더하기 · 탭 닫기와 전환 ─────────────────────────────────────

const CLASSES_9I1 = ['LayoutController', 'LayoutTabAdd', 'LayoutTabOps'];

const DELEGATES_9I1 = {
  layout: ['_restoreReturn', '_tabToManual', '_tabToAuto', 'renameTab', '_mkWindow', 'addWindow', 'delWindow', 'switchWindow'],
  'layout.tabAdd': ['findGitViewTab', '_findEditorTab', 'addTab', '_revealTab', '_pushTab'],
  'layout.tabOps': ['closeTab', 'switchTab', 'split', 'switchTabPrev', 'switchTabNext', 'switchWindowPrev', 'switchWindowNext',
    'paneNavigate', 'addTabFocused', 'closeTabFocused', 'closeWindowActive', 'sidebarCollapsed', 'setSidebarCollapsed', 'sbPanel',
    '_toggleSidebar', 'sbRail', 'termIn'],
};

function load9i1(globals = {}) {
  return load([...BASE, ...LAYOUT], {
    expose: [...CLASSES_9I1, 'Controller', 'Component'],
    globals: {
      App: function App() {}, TIMERS: { disposeOwner() {} }, t: (k) => k, tn: (k) => k,
      TAB_TYPE_TERMINAL: 'terminal', TAB_TYPE_EDITOR: 'editor', TAB_TYPE_RUN: 'run', TAB_TYPE_CHAT: 'chat', TAB_TYPE_GIT: 'git',
      RETURN_WINDOW_KEY: { plain: 'rp', editor: 're' }, PrefStore: { session: { get: () => null, set() {} } },
      findPane: (layout, id) => (layout && layout.id === id ? layout : null),
      firstPane: (layout) => layout || null, findPath: () => null,
      ...globals,
    },
  });
}

test('TC-FEA-1(9i-1): 컨트롤러와 부품은 Controller·Component 하위이고 app 을 든다', () => {
  const ctx = load9i1();
  const app = new ctx.App();
  for (const c of CLASSES_9I1) {
    const o = new ctx[c](app);
    assert.ok(o instanceof ctx.Controller, c);
    assert.ok(o instanceof ctx.Component, c);
    assert.equal(o.app, app, c);
  }
  const layout = new ctx.LayoutController(app);
  assert.ok(layout.tabAdd instanceof ctx.LayoutTabAdd);
  assert.ok(layout.tabOps instanceof ctx.LayoutTabOps);
  assert.equal(layout._winUndo, null);
});

test('TC-FEA-1(9i-1): App 생성자가 컨트롤러를 만들고 창 닫기 유예는 App 에서 빠진다 (§2.2 C/9i)', () => {
  const src = read('core/app.js');
  const ctor = src.slice(src.indexOf('  constructor(){'), src.indexOf('\n  }\n', src.indexOf('  constructor(){')));
  assert.ok(ctor.includes('this.layout=new LayoutController(this);'));
  assert.doesNotMatch(ctor, /this\._winUndo=/);
  assert.ok(ctor.includes('this._lastPlainWindow=null;'));
});

test('TC-FEA-1(9i-1): 위임자는 컨트롤러 메서드를 같은 인자로 부르고 값을 돌려준다', () => {
  const ctx = load9i1();
  const app = new ctx.App();
  app.layout = { tabAdd: {}, tabOps: {} };
  const seen = [];
  for (const [path, names] of Object.entries(DELEGATES_9I1)) {
    const target = path.split('.').reduce((o, k) => o[k], app);
    for (const n of names) target[n] = (...a) => { seen.push([n, ...a]); return 'r:' + n };
  }
  for (const names of Object.values(DELEGATES_9I1)) for (const n of names) assert.equal(app[n](1, 'x'), 'r:' + n, n);
  assert.deepEqual(plain(seen), Object.values(DELEGATES_9I1).flat().map((n) => [n, 1, 'x']));
});

test('TC-FEA-2(9i-1): 컨트롤러는 덮어쓰기 대상·계약 이름을 this.app 으로 부른다', () => {
  const force = new Set([...overridden(), ...contractNames()]);
  for (const f of ISSUES['9i-1'].ctl) {
    const bad = [...thisNames(read(f))].filter((n) => force.has(n));
    assert.deepEqual(bad, [], f);
  }
});

test('TC-FEA-2(9i-1): 갈아 끼운 aw·setFocusState·render·save·slotFocused·paneTabSet·_revealTab 을 컨트롤러 경로가 부른다', () => {
  const ctx = load9i1();
  const app = controllers(ctx, new ctx.App());
  const log = [];
  const pane = { type: 'pane', id: 'p1', tabs: [{ id: 't1', type: 'terminal' }, { id: 't2', type: 'terminal' }], activeTab: 't1' };
  const w1 = { id: 'w1', layout: pane };
  const w2 = { id: 'w2', layout: { type: 'pane', id: 'p2', tabs: [], activeTab: null } };
  app.ws = { activeWindow: 'w1', windows: [w1, w2] };
  app.focused = 'p1';
  Object.assign(app, {
    paneTab: (pn) => pn.activeTab, isKindWin: () => false, isEditorWin: () => false, isGitWin: () => false, isChatWin: () => false,
    edOn: () => true, _activateWindow: (id) => { app.ws.activeWindow = id }, _slotOnSwitch: () => {}, focusClear: () => {},
    _focusWindow: () => {}, _gitRescheduleAll: () => {}, _findRunTab: () => ({ win: w1, pane, tab: pane.tabs[0] }),
    slotNavigate: (d) => log.push('nav:' + d),
  });
  app.aw = () => { log.push('aw'); return app.ws.windows.find((w) => w.id === app.ws.activeWindow) };
  app.slotFocused = () => { log.push('slot'); return 0 };
  app.paneTabSet = (pn, id) => { log.push('tab:' + id); pn.activeTab = id };
  app.setFocusState = (id) => log.push('focus:' + id);
  app.render = () => log.push('render');
  app.save = () => log.push('save');
  app._revealTab = (f) => log.push('reveal:' + f.tab.id);
  app.switchTab('p1', 't2');
  assert.deepEqual(log.splice(0), ['slot', 'aw', 'tab:t2', 'focus:p1', 'save', 'render']);
  app.addTab('p1', 'run', { runId: 'r' });
  assert.deepEqual(log.splice(0), ['aw', 'reveal:t1', 'render', 'save']);
  app.switchWindow('w2');
  assert.deepEqual(log.splice(0), ['aw', 'aw', 'aw', 'focus:p2', 'save', 'render']);
  app.focused = null;
  app.paneNavigate('left');
  assert.deepEqual(log.splice(0), ['aw', 'nav:left']);
});

test('TC-FEA-3(9i-1): 옮긴 mixin 파일이 없고 Object.assign(App.prototype 의 수가 준다', () => {
  const issue = ISSUES['9i-1'];
  for (const f of issue.gone) assert.ok(!existsSync(join(JS_ROOT, f)), '남았다: ' + f);
  const html = readFileSync(join(REPO, 'web/index.html'), 'utf8');
  for (const f of issue.gone) assert.ok(!html.includes('js/' + f + '"') && !html.includes('js/' + f + '?'), 'index.html 이 싣는다: ' + f);
  for (const f of issue.ctl) assert.doesNotMatch(read(f), /Object\.assign\(App\.prototype/, f);
  const mixins = walk(JS_ROOT, (n) => n.endsWith('.js')).filter((f) => !f.includes('/test/'))
    .filter((f) => readFileSync(f, 'utf8').includes('Object.assign(App.prototype'));
  assert.ok(mixins.length <= issue.mixins, 'mixin 파일 ' + mixins.length + ' > ' + issue.mixins);
});

test('TC-FEA-3(9i-1): 옮긴 묶음의 계약 이름이 App 원형에서 함수로 읽힌다', () => {
  const ctx = load9i1();
  const contract = contractNames();
  const names = Object.values(DELEGATES_9I1).flat().filter((x) => contract.has(x));
  assert.ok(names.length > 0);
  for (const n of names) assert.equal(typeof ctx.App.prototype[n], 'function', n);
});

// ── 9i-2: 레이아웃 나머지 — 도킹 · 끌어 놓기 · 창 그룹 · 창 상태와 프리셋 · 닫은 탭 다시 열기 ──────────────

const CLASSES_9I2 = ['LayoutDock', 'LayoutDnd', 'LayoutGroups', 'LayoutWindowState', 'LayoutTabReopen'];
const PARTS_9I2 = { dock: 'LayoutDock', dnd: 'LayoutDnd', groups: 'LayoutGroups', winState: 'LayoutWindowState', reopen: 'LayoutTabReopen' };

const DELEGATES_9I2 = {
  'layout.dock': ['panelDock', 'setPanelDock', 'applyPanelDock', 'sbCollapsePaint', 'repoSideDock', 'setRepoSideDock', 'saveLayout',
    'resetLayout'],
  'layout.dnd': ['getDragZone', 'showBodyDropIndicator', 'clearBodyDropIndicator', 'moveTabToPane', 'moveTabToWindow', 'splitPaneWithTab'],
  'layout.groups': ['windowGroups', 'newGroup', 'deleteGroup', 'moveWindowTo', 'moveTabTo', 'wgFoldToggle', 'sidebarWindowEntries',
    'sidebarReorder', 'wgEdgeGroup', 'addGroupInteractive', 'groupHasAttn', '_remoteNewGroup', '_remoteRenameGroup', '_remoteDeleteGroup',
    '_remoteMoveWindow', '_remoteMoveGroup', '_remoteMoveTab'],
  'layout.winState': ['_normalizeIncomingWorkspace', '_fallbackActiveWindow', '_stripDeviceKeys', '_activateWindow', '_persistActiveWindow',
    '_loadPreset', '_presetButtonPaint'],
  'layout.reopen': ['tabReopen', 'tabReopenCan', 'tabReopenAt'],
};

function load9i2(globals = {}) {
  const store = new Map();
  return load9i1({
    PrefStore: { session: { get: (k) => store.get(k), set: (k, v) => store.set(k, v), remove: (k) => store.delete(k) } },
    STORE_KEYS: { activeWindow: 'activeWindow' }, ACTIVE_EDITOR_ROOT_KEY: 'activeEditorRoot', TAB_REOPEN_MAX: 20,
    newEntityId: (() => { let n = 0; return () => 'id' + (++n) })(), clampEntityName: (s) => s,
    doRemove: () => null,
    findPane: function find(node, id) {
      if (!node) return null;
      if (node.type === 'pane') return node.id === id ? node : null;
      for (const c of node.children || []) { const r = find(c, id); if (r) return r }
      return null;
    },
    ...globals,
  });
}

test('TC-FEA-1(9i-2): 부품은 Controller·Component 하위이고 app 을 들며, 뿌리가 부품 다섯을 든다', () => {
  const ctx = load9i2();
  const app = new ctx.App();
  for (const c of CLASSES_9I2) {
    const o = partOf(ctx, c, app);
    assert.ok(o instanceof ctx.Controller, c);
    assert.ok(o instanceof ctx.Component, c);
    assert.equal(o.app, app, c);
  }
  const layout = new ctx.LayoutController(app);
  for (const [field, cls] of Object.entries(PARTS_9I2)) assert.equal(layout[field].constructor.name, cls, field);
});

/** 부품 클래스는 `expose` 하지 않는다 — 렉시컬 이름을 컨텍스트에서 읽는다. */
function partOf(ctx, cls, app) {
  const layout = new ctx.LayoutController(app);
  const field = Object.keys(PARTS_9I2).find((k) => PARTS_9I2[k] === cls);
  return layout[field];
}

test('TC-FEA-1(9i-2): 위임자는 부품 메서드를 같은 인자로 부르고 값을 돌려준다', () => {
  const ctx = load9i2();
  const app = new ctx.App();
  app.layout = { dock: {}, dnd: {}, groups: {}, winState: {}, reopen: {} };
  const seen = [];
  for (const [path, names] of Object.entries(DELEGATES_9I2)) {
    const target = path.split('.').reduce((o, k) => o[k], app);
    for (const n of names) target[n] = (...a) => { seen.push([n, ...a]); return 'r:' + n };
  }
  for (const names of Object.values(DELEGATES_9I2)) for (const n of names) assert.equal(app[n](1, 'x'), 'r:' + n, n);
  assert.deepEqual(plain(seen), Object.values(DELEGATES_9I2).flat().map((n) => [n, 1, 'x']));
});

test('TC-FEA-1(9i-2): 묶음 하나만 닿는 필드는 부품이 든다 — 닫은 탭 목록·도킹·그룹 접기 (§2.2 SH-4)', () => {
  const ctx = load9i2();
  const app = controllers(ctx, new ctx.App());
  Object.assign(app, { isEditorWin: () => true, editorAny: () => null });
  const tab = { id: 't1', type: 'editor', filePath: '/a' };
  app.layout.reopen._tabReopenNote({ id: 'w' }, { id: 'p', tabs: [tab] }, tab);
  assert.equal(app.layout.reopen._tabClosed.length, 1);
  for (const f of ['_tabClosed', '_dockShown', '_wgFold', '_wgSeenActive']) assert.equal(f in app, false, f);
  const src = read('core/app.js');
  for (const f of ['_tabClosed', '_dockShown', '_wgFold', '_wgSeenActive']) assert.doesNotMatch(src, new RegExp('this\\.' + f + '\\b'), f);
});

test('TC-FEA-1(9i-2): 탭 닫기는 닫은 탭 목록을 부품 경로로 적는다', () => {
  const src = read('core/layout-tab-ops.js');
  assert.match(src, /this\.app\.layout\.reopen\._tabReopenNote\(/);
  assert.match(read('core/layout-controller.js'), /this\.groups\._groupsNormalizeWs\(/);
});

test('TC-FEA-2(9i-2): 컨트롤러는 덮어쓰기 대상·계약 이름을 this.app 으로 부른다', () => {
  const force = new Set([...overridden(), ...contractNames()]);
  for (const f of ISSUES['9i-2'].ctl) {
    const bad = [...thisNames(read(f))].filter((n) => force.has(n));
    assert.deepEqual(bad, [], f);
  }
});

test('TC-FEA-2(9i-2): 갈아 끼운 aw·focused·setFocusState·paneTabSet·save·render·tools·slotFocused·gitPanels 를 부품 경로가 부른다', () => {
  const ctx = load9i2();
  const app = controllers(ctx, new ctx.App());
  const log = [];
  const p1 = { type: 'pane', id: 'p1', tabs: [{ id: 't1' }, { id: 't2' }], activeTab: 't1' };
  const p2 = { type: 'pane', id: 'p2', tabs: [{ id: 't3' }], activeTab: 't3' };
  const w1 = { id: 'w1', layout: { type: 'split', children: [p1, p2] } };
  const w2 = { id: 'w2', layout: { type: 'pane', id: 'p9', tabs: [], activeTab: null } };
  app.ws = { activeWindow: 'w1', windows: [w1, w2] };
  app.focused = 'p1';
  Object.assign(app, { isGitWin: () => false, isEditorWin: () => false, isChatWin: () => false, _gitDiffPanelOf: () => null });
  app.aw = () => { log.push('aw'); return app.ws.windows.find((w) => w.id === app.ws.activeWindow) };
  app.setFocusState = (id) => log.push('focus:' + id);
  app.paneTabSet = (pn, id) => log.push('tab:' + id);
  app.save = () => log.push('save');
  app.render = () => log.push('render');
  app.moveTabToPane('p1', 't1', 'p2');
  assert.deepEqual(plain(p2.tabs.map((x) => x.id)), ['t3', 't1']);
  assert.deepEqual(log.splice(0), ['tab:t1', 'focus:p2', 'save', 'render']);
  assert.deepEqual(plain(app.newGroup('G')), { id: 'id1' });
  assert.deepEqual(log.splice(0), ['save', 'render']);
  app._activateWindow('w2', { rememberFocus: true });
  assert.equal(w1.focusedPane, 'p1');
  assert.equal(app.ws.activeWindow, 'w2');
  assert.deepEqual(log.splice(0), ['aw']);
  app.tools = new Map([['k', { el: { classList: { contains: () => true } }, doFit: () => log.push('fit') }]]);
  app.layout.dock._dockRefit();
  assert.deepEqual(log.splice(0), ['fit']);
  const panel = { diffTabId: 'd1' };
  app.gitPanels = new Map([['x', panel]]);
  app.slotFocused = () => { log.push('slot'); return 0 };
  assert.equal(app.layout.reopen._gitDiffPanelAny('d1'), panel);
  assert.deepEqual(log.splice(0), ['slot']);
});

test('TC-FEA-3(9i-2): 옮긴 mixin 파일이 없고 Object.assign(App.prototype 의 수가 준다', () => {
  const issue = ISSUES['9i-2'];
  for (const f of issue.gone) assert.ok(!existsSync(join(JS_ROOT, f)), '남았다: ' + f);
  const html = readFileSync(join(REPO, 'web/index.html'), 'utf8');
  for (const f of issue.gone) assert.ok(!html.includes('js/' + f + '"') && !html.includes('js/' + f + '?'), 'index.html 이 싣는다: ' + f);
  for (const f of issue.ctl) assert.doesNotMatch(read(f), /Object\.assign\(App\.prototype/, f);
  const mixins = walk(JS_ROOT, (n) => n.endsWith('.js')).filter((f) => !f.includes('/test/'))
    .filter((f) => readFileSync(f, 'utf8').includes('Object.assign(App.prototype'));
  assert.ok(mixins.length <= issue.mixins, 'mixin 파일 ' + mixins.length + ' > ' + issue.mixins);
});

test('TC-FEA-3(9i-2): 옮긴 묶음의 계약 이름이 App 원형에서 함수로 읽힌다', () => {
  const ctx = load9i2();
  const contract = contractNames();
  const names = Object.values(DELEGATES_9I2).flat().filter((x) => contract.has(x));
  assert.ok(names.length > 0);
  for (const n of names) assert.equal(typeof ctx.App.prototype[n], 'function', n);
});

// ── 9j: 도구 · 수명 · 원격 커맨드 · 작업 중 표식 · 검색 ─────────────────────────────────────

const CLASSES_9J = ['ToolController', 'ToolLife', 'ToolCmd', 'ToolWork', 'ToolSearch'];
const PARTS_9J = { life: 'ToolLife', cmd: 'ToolCmd', work: 'ToolWork', search: 'ToolSearch' };

const DELEGATES_9J = {
  tool: ['_isToolBusy', '_toolsBusy', '_notify', '_sbxProgress', '_sbxRuntime', '_sbxRuntimeModal', '_sbxRemember', '_pickSandbox',
    '_confirmClose'],
  'tool.life': ['_setToolBackground', '_bgRefresh', '_restoreTool', '_newTool', '_focusedCwd', '_kill', '_killTool', 'aw', '_toolName',
    'findToolLocation'],
  'tool.cmd': ['_echoResult', '_execRemote', '_findTabById'],
  'tool.work': ['workingToolIds', 'tabWorkDot', 'windowWorkDot', '_workSync', '_workRefresh'],
  'tool.search': ['toggleSearch', 'closeSearch', 'clearAllSearchDecorations', 'researchIfOpen', 'focusedTerminal', 'doSearch'],
};

function load9j(globals = {}) {
  return load([...BASE, ...TOOL], {
    expose: ['ToolController', 'Controller', 'Component', 'REMOTE_ACTIONS'],
    globals: {
      App: function App() {}, TIMERS: { disposeOwner() {} }, t: (k) => k, tn: (k) => k,
      ACTIVITY_STATE: { WORKING: 'working' }, TAB_TYPE_TERMINAL: 'terminal',
      document: { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [] },
      ...globals,
    },
  });
}

test('TC-FEA-1(9j): 컨트롤러와 부품은 Controller·Component 하위이고 app 을 든다', () => {
  const ctx = load9j();
  const app = new ctx.App();
  const tool = new ctx.ToolController(app);
  const all = [tool, ...Object.keys(PARTS_9J).map((k) => tool[k])];
  assert.deepEqual(all.map((o) => o.constructor.name), CLASSES_9J);
  for (const o of all) {
    assert.ok(o instanceof ctx.Controller, o.constructor.name);
    assert.ok(o instanceof ctx.Component, o.constructor.name);
    assert.equal(o.app, app, o.constructor.name);
  }
});

test('TC-FEA-1(9j): App 생성자가 컨트롤러를 만든다 — 백그라운드 목록은 App 에 남는다 (§2.2 A/9j)', () => {
  const src = read('core/app.js');
  const ctor = src.slice(src.indexOf('  constructor(){'), src.indexOf('\n  }\n', src.indexOf('  constructor(){')));
  assert.ok(ctor.includes('this.tool=new ToolController(this);'));
  assert.ok(ctor.includes('this._bg=[];'));
  const life = read('core/tool-life.js');
  assert.match(life, /this\.app\._bg=/);
  assert.doesNotMatch(life, /(?<![\w$.])this\._bg\b/);
});

test('TC-FEA-1(9j): 위임자는 컨트롤러 메서드를 같은 인자로 부르고 값을 돌려준다', () => {
  const ctx = load9j();
  const app = new ctx.App();
  app.tool = { life: {}, cmd: {}, work: {}, search: {} };
  const seen = [];
  for (const [path, names] of Object.entries(DELEGATES_9J)) {
    const target = path.split('.').reduce((o, k) => o[k], app);
    for (const n of names) target[n] = (...a) => { seen.push([n, ...a]); return 'r:' + n };
  }
  for (const names of Object.values(DELEGATES_9J)) for (const n of names) assert.equal(app[n](1, 'x'), 'r:' + n, n);
  assert.deepEqual(plain(seen), Object.values(DELEGATES_9J).flat().map((n) => [n, 1, 'x']));
});

test('TC-FEA-1(9j): 원격 명령 표는 App 을 받아 부품의 처리기를 부른다 — 작업 중 표식의 서명은 부품이 든다 (§2.2 SH-4)', () => {
  const ctx = load9j();
  const app = controllers(ctx, new ctx.App());
  const seen = [];
  app.tool.cmd._remoteViaAction = (action, a) => seen.push(action, a.n);
  app._execRemote('tabNext', { n: 1 });
  app._execRemote('nope', { n: 2 });
  assert.deepEqual(seen, ['tabNext', 1, 'nope', 2]);
  app._activity = new Map();
  app._workSync();
  assert.equal(app.tool.work._workSig, '');
  assert.equal('_workSig' in app, false);
});

test('TC-FEA-2(9j): 컨트롤러는 덮어쓰기 대상·계약 이름을 this.app 으로 부른다', () => {
  const force = new Set([...overridden(), ...contractNames()]);
  for (const f of ISSUES['9j'].ctl) {
    const bad = [...thisNames(read(f))].filter((n) => force.has(n));
    assert.deepEqual(bad, [], f);
  }
});

test('TC-FEA-2(9j): 갈아 끼운 findToolLocation·aw·executeAction·tools·focused 를 부품 경로가 부른다', () => {
  const ctx = load9j();
  const app = controllers(ctx, new ctx.App());
  const log = [];
  app._activity = new Map([['a', { state: 'working' }], ['b', { state: 'done' }]]);
  app.findToolLocation = (id) => { log.push('loc:' + id); return {} };
  assert.deepEqual([...app.workingToolIds()], ['a']);
  app.aw = () => { log.push('aw'); return null };
  assert.equal(app.tool.life._isToolInActiveWindow('k'), false);
  app.executeAction = (a) => { log.push('exec:' + a) };
  app._execRemote('nope', {});
  app.tools = new Map([['k', { search: { clearDecorations: () => log.push('clear') } }]]);
  app.clearAllSearchDecorations();
  app.focused = 'p';
  assert.equal(app.focusedTerminal(), null);
  assert.deepEqual(log, ['loc:a', 'aw', 'exec:nope', 'clear', 'aw']);
});

test('TC-FEA-3(9j): 옮긴 mixin 파일이 없고 Object.assign(App.prototype 의 수가 준다', () => {
  const issue = ISSUES['9j'];
  for (const f of issue.gone) assert.ok(!existsSync(join(JS_ROOT, f)), '남았다: ' + f);
  const html = readFileSync(join(REPO, 'web/index.html'), 'utf8');
  for (const f of issue.gone) assert.ok(!html.includes('js/' + f + '"') && !html.includes('js/' + f + '?'), 'index.html 이 싣는다: ' + f);
  for (const f of issue.ctl) assert.doesNotMatch(read(f), /Object\.assign\(App\.prototype/, f);
  const mixins = walk(JS_ROOT, (n) => n.endsWith('.js')).filter((f) => !f.includes('/test/'))
    .filter((f) => readFileSync(f, 'utf8').includes('Object.assign(App.prototype'));
  assert.ok(mixins.length <= issue.mixins, 'mixin 파일 ' + mixins.length + ' > ' + issue.mixins);
});

test('TC-FEA-3(9j): 옮긴 묶음의 계약 이름이 App 원형에서 함수로 읽힌다', () => {
  const ctx = load9j();
  const contract = contractNames();
  const names = Object.values(DELEGATES_9J).flat().filter((x) => contract.has(x));
  assert.ok(names.length > 0);
  for (const n of names) assert.equal(typeof ctx.App.prototype[n], 'function', n);
});

// ── 9k-1: 편집기 — 창의 정체 · 열기 · 칸과 사이드 · 섹션 · 서버 동기 · 감시 ─────────────────────────────

const CLASSES_9K1 = ['EditorController', 'EditorOpen', 'EditorPane', 'EditorSection', 'EditorSync', 'EditorWatch'];
const PARTS_9K1 = { open: 'EditorOpen', pane: 'EditorPane', section: 'EditorSection', sync: 'EditorSync', watch: 'EditorWatch' };

const DELEGATES_9K1 = {
  editor: ['isEditorWin', 'edWindows', 'edRootOf', 'edWindowFor', 'edOn', '_edHome', 'edNotes', 'edBase', 'edName', 'edEntries', 'edFixed',
    'edRoots', 'edFocusHandoff'],
  'editor.open': ['_migrateEditorTabs', 'edActivateTarget', 'edOpenWindow', 'edDoc', 'tabDirty', 'edDocDrop', 'edDirtyDiff',
    'edDirtyDiffRepaint', 'edPollDocStamps', '_edOnGitChanged', 'edStore', 'edTree', '_edTreeFor', 'edActiveTree', 'edRefreshTreesFor',
    '_edVisibleTrees'],
  'editor.pane': ['_edKeepActive', 'edPinTabFor', 'edSideTabs', 'edSideOf', 'edSetSide', 'edSideWidth', 'edSetSideWidth',
    '_edMigrateSideWidth', 'edEnsurePane', 'edDirtyUnder', 'edRetargetTabs', 'edCloseTabsUnder', '_edAfterGitSignal',
    '_edGitHold'],
  'editor.section': ['_initEditorSection', '_edTermCwd', '_edPathCandidates', 'edRemove', 'edReorder', 'edMutate', 'edRefresh'],
  'editor.sync': ['_edLoad', '_edPatchList', 'edMirror', '_edApplyLinked', '_edReconcile', '_edWinDirty', 'edAnyDirty', '_edWinSaveDirty',
    '_edSaveAll'],
  'editor.watch': ['edWatchSync', '_edWatchRestore', '_onFsChanged'],
};

/** 편집기 묶음이 부르는 다른 묶음의 이름 — App 원형의 대역이다(시험 파일에 `app.X =` 를 늘리지 않는다). */
class App9k {
  slotKey(id, slot) { return slot ? id + '@' + slot : id }
  slotBase(key) { return String(key).split('@')[0] }
  _gitRescheduleAll() {}
  _findEditorTab() { return null }
  mobileShowPane() {}
}

function load9k1(globals = {}) {
  return load([...BASE, ...EDITOR], {
    expose: ['EditorController', 'Controller', 'Component'],
    globals: {
      App: class App extends App9k {}, TIMERS: { disposeOwner() {}, frame() {}, after() { return { stop() {} } } },
      WINDOW_TYPE_EDITOR: 'editor', TAB_TYPE_EDITOR: 'editor', TAB_TYPE_TERMINAL: 'terminal',
      REPO_SIDE_EXPLORER: 'explorer', REPO_SIDE_DEFAULT: 'explorer', REPO_SIDE_TABS: [{ id: 'explorer' }, { id: 'git' }],
      panesOf: (l) => (l ? [l] : []),
      document: { hidden: false, getElementById: () => null, querySelector: () => null, querySelectorAll: () => [] },
      ...globals,
    },
  });
}

test('TC-FEA-1(9k-1): 컨트롤러와 부품은 Controller·Component 하위이고 app 을 든다', () => {
  const ctx = load9k1();
  const app = new ctx.App();
  const editor = new ctx.EditorController(app);
  const all = [editor, ...Object.keys(PARTS_9K1).map((k) => editor[k])];
  assert.deepEqual(all.map((o) => o.constructor.name), CLASSES_9K1);
  for (const o of all) {
    assert.ok(o instanceof ctx.Controller, o.constructor.name);
    assert.ok(o instanceof ctx.Component, o.constructor.name);
    assert.equal(o.app, app, o.constructor.name);
  }
});

test('TC-FEA-1(9k-1): App 생성자가 컨트롤러를 만든다 — 목록·끔·돌아갈 창은 App 에 남는다 (§2.2 A/9k)', () => {
  const src = read('core/app.js');
  const ctor = src.slice(src.indexOf('  constructor(){'), src.indexOf('\n  }\n', src.indexOf('  constructor(){')));
  assert.ok(ctor.includes('this.editor=new EditorController(this);'));
  for (const f of ['this.editors=null;', 'this._edOff=false;', 'this._lastEditorWindow=null;']) assert.ok(ctor.includes(f), f);
});

test('TC-FEA-1(9k-1): 위임자는 컨트롤러 메서드를 같은 인자로 부르고 값을 돌려준다', () => {
  const ctx = load9k1();
  const app = new ctx.App();
  app.editor = { open: {}, pane: {}, section: {}, sync: {}, watch: {} };
  const seen = [];
  for (const [path, names] of Object.entries(DELEGATES_9K1)) {
    const target = path.split('.').reduce((o, k) => o[k], app);
    for (const n of names) target[n] = (...a) => { seen.push([n, ...a]); return 'r:' + n };
  }
  for (const names of Object.values(DELEGATES_9K1)) for (const n of names) assert.equal(app[n](1, 'x'), 'r:' + n, n);
  assert.deepEqual(plain(seen), Object.values(DELEGATES_9K1).flat().map((n) => [n, 1, 'x']));
});

test('TC-FEA-1(9k-1): 묶음 하나만 닿는 필드는 부품이 든다 — 감시·문서 스탬프·알림 키 (§2.2 SH-4)', async () => {
  const puts = [];
  const ctx = load9k1({ apiPut: async (path, body) => { puts.push(body.dirs); return { ok: true, status: 200 } },
    FS_WATCH_API: '/w', serverMeta: {}, capToServer: (l) => l, EDITOR_HELD_DIRTY: 'held %s' });
  const app = controllers(ctx, new ctx.App());
  app.editor.open._edVisibleDocPaths = () => new Set(['/r/a.txt']);
  await app._edWatchRestore();
  assert.deepEqual(plain(puts), [['/r']]);
  assert.equal(app.editor.watch._edWatchLive, true);
  assert.equal(app.editor.watch._edWatchKey, '/r');
  app.editor.open._edDocStampsEnd([], { ok: false, status: 404 });
  assert.equal(app.editor.open._edStampsOff, true);
  assert.equal(app.editor.open._edStampsBusy, false);
  const notes = [];
  ctx.App.prototype._notify = (m) => notes.push(m);
  app.editor.sync._edNotifyHeld([{ name: 'a' }]);
  app.editor.sync._edNotifyHeld([{ name: 'a' }]);
  assert.deepEqual(notes, ['held a']);
  assert.equal(app.editor.sync._edHeldKey, 'a');
  for (const k of ['_edWatchLive', '_edWatchKey', '_edWatchBusy', '_edStampsOff', '_edStampsBusy', '_edHeldKey']) assert.equal(k in app, false, k);
  for (const f of walk(join(JS_ROOT, 'core'), (n) => n.endsWith('.js'))) {
    if (f.endsWith('/editor-open.js')) continue;
    assert.doesNotMatch(readFileSync(f, 'utf8'), /(?<![\w$.])this\._edReveal\b/, f);
  }
});

test('TC-FEA-1(9k-1): 숨은 동안의 git 방송은 편집기 칸 부품이 쌓고 복귀 틱이 갚는다 (§2.2 M/9k _edGitHeld)', () => {
  const ctx = load9k1();
  const app = controllers(ctx, new ctx.App());
  const log = [];
  app.editor.open._edOnGitChanged = (repo, mark) => log.push(repo + ':' + mark);
  app.editor.open._edVisibleTrees = () => [];
  app.editor.open.edStampTick = () => log.push('stamp');
  app.editor.watch.edWatchSync = () => log.push('watch');
  app._edGitHold('/r', 'm1');
  app._edGitHold('/r', 'm2');
  assert.equal(app.editor.pane._edGitHeld.get('/r'), 'm2');
  assert.equal('_edGitHeld' in app, false);
  app.editor.pane._edTick();
  app.editor.pane._edTick();
  assert.deepEqual(log, ['/r:m2', 'stamp', 'watch', 'stamp', 'watch']);
  const sync = read('core/git-sync.js');
  assert.doesNotMatch(sync, /_edGitHeld/);
  assert.match(sync, /this\.app\._edGitHold\(repo,a\.mark\|\|''\)/);
});

test('TC-FEA-1(9k-1): focusHandoff 의 쓰기는 편집기 뿌리 메서드 하나다 (§2.2 SH-2)', () => {
  const ctx = load9k1();
  const app = controllers(ctx, new ctx.App());
  app.focusHandoff = false;
  app.edFocusHandoff();
  assert.equal(app.focusHandoff, true);
  const writers = walk(join(JS_ROOT, 'core'), (n) => n.endsWith('.js'))
    .filter((f) => /\bfocusHandoff\s*=(?!=)/.test(readFileSync(f, 'utf8'))).map((f) => f.slice(JS_ROOT.length));
  assert.deepEqual(writers, ['core/editor-controller.js']);
});

test('TC-FEA-2(9k-1): 컨트롤러는 덮어쓰기 대상·계약 이름을 this.app 으로 부른다', () => {
  const force = new Set([...overridden(), ...contractNames()]);
  for (const f of ISSUES['9k-1'].ctl) {
    const bad = [...thisNames(read(f))].filter((n) => force.has(n));
    assert.deepEqual(bad, [], f);
  }
});

test('TC-FEA-2(9k-1): 갈아 끼운 aw·slotFocused·render·save·edActiveTree·_edDocs·plainWindows·toolIds·fileEditors·ws 를 부품 경로가 부른다', async () => {
  const ctx = load9k1({ apiGet: async () => ({ ok: true, data: { source: 'tool', cwd: '/c' } }), GIT_CWD_SOURCE_TOOL: 'tool',
    PATH_SUGGEST_TERM_MAX: 4, CWD_API: '/api/cwd' });
  const app = controllers(ctx, new ctx.App());
  const log = [];
  app.aw = () => { log.push('aw'); return { id: 'w', type: 'editor', editor: { side: 'explorer' } } };
  app.slotFocused = () => { log.push('slot'); return 0 };
  const tree = { pollGit: (o) => log.push('poll:' + o.now), pollStamp() {} };
  app._edTrees = new Map([['w', tree]]);
  assert.equal(app.edActiveTree(), tree);
  app.render = () => log.push('render');
  app.save = () => log.push('save');
  app.edSetSide({ id: 'w', type: 'editor', editor: { side: 'git' } }, 'explorer');
  app.edActiveTree = () => { log.push('tree'); return null };
  app._edDocs = new Map([['a', { dd: { refresh: () => log.push('dd') } }]]);
  app._edAfterGitSignal();
  app.plainWindows = () => { log.push('plain'); return [{ layout: { tabs: [{ type: 'terminal', toolId: 't' }] } }] };
  app.toolIds = new Set(['t']);
  assert.deepEqual(plain(await app.editor.section._edTermCwds('/h')), ['/h', '/c']);
  app._edDocs = null;
  app.fileEditors = new Map([['x', { _dirty: true }]]);
  assert.equal(app.edAnyDirty(), true);
  app.ws = { windows: [{ editor: { explorerWidth: 1 } }], repoSideWidth: 2 };
  assert.equal(app._edMigrateSideWidth(), true);
  assert.deepEqual(plain(app.ws), { windows: [{ editor: {} }] });
  assert.deepEqual(log, ['aw', 'slot', 'render', 'slot', 'poll:true', 'save', 'tree', 'dd', 'plain']);
});

test('TC-FEA-3(9k-1): 옮긴 mixin 파일이 없고 Object.assign(App.prototype 의 수가 준다', () => {
  const issue = ISSUES['9k-1'];
  for (const f of issue.gone) assert.ok(!existsSync(join(JS_ROOT, f)), '남았다: ' + f);
  const html = readFileSync(join(REPO, 'web/index.html'), 'utf8');
  for (const f of issue.gone) assert.ok(!html.includes('js/' + f + '"') && !html.includes('js/' + f + '?'), 'index.html 이 싣는다: ' + f);
  for (const f of issue.ctl) assert.doesNotMatch(read(f), /Object\.assign\(App\.prototype/, f);
  const mixins = walk(JS_ROOT, (n) => n.endsWith('.js')).filter((f) => !f.includes('/test/'))
    .filter((f) => readFileSync(f, 'utf8').includes('Object.assign(App.prototype'));
  assert.ok(mixins.length <= issue.mixins, 'mixin 파일 ' + mixins.length + ' > ' + issue.mixins);
});

test('TC-FEA-3(9k-1): 옮긴 묶음의 계약 이름이 App 원형에서 함수로 읽힌다', () => {
  const ctx = load9k1();
  const contract = contractNames();
  const names = Object.values(DELEGATES_9K1).flat().filter((x) => contract.has(x));
  assert.ok(names.length > 0);
  for (const n of names) assert.equal(typeof ctx.App.prototype[n], 'function', n);
  for (const n of ['_edAfterGitSignal', '_edOnGitChanged', '_edMigrateSideWidth', '_edGitHold'])
    assert.equal(typeof ctx.App.prototype[n], 'function', n);
});

// ── 9k-2: 편집기 — 문서 · 파일 조작 · 찾기 · 문서 렌더 배선 ─────────────────────────────────────

const CLASSES_9K2 = ['EditorDoc', 'EditorFile', 'EditorDocRender', 'EditorSearch'];
const PARTS_9K2 = { doc: 'EditorDoc', file: 'EditorFile', docRender: 'EditorDocRender', search: 'EditorSearch' };

const DELEGATES_9K2 = {
  'editor.doc': ['edDocAt', 'edDocLoad', 'edDocRefresh', 'edDocDirtySync', 'edDocReopen', 'edDocConvertUtf8', 'edDocSave', 'edDocWrite',
    'edConfirmConflict', 'edDocLeaveConfirm', 'edDocMove'],
  'editor.file': ['edOpenFile', 'edClipSet', 'edClipGet', 'edFs', 'edFsActions', '_edConfirm', 'edConfirmDelete'],
  'editor.search': ['_edSearchRoot', '_edActiveDiff', '_edQuickOpen', '_edSearchOpen', '_edFindInFile', '_edGotoLine', '_edActiveEditor',
    'edTrySearchKey'],
  'editor.docRender': ['docRenderMount', 'docRenderRootOf', '_docRenderOpen', 'docRenderToSource'],
};

test('TC-FEA-1(9k-2): 부품은 Controller·Component 하위이고 app 을 들며, 편집기 뿌리가 부품 아홉을 든다', () => {
  const ctx = load9k1();
  const app = new ctx.App();
  const editor = new ctx.EditorController(app);
  const parts = Object.keys(PARTS_9K2).map((k) => editor[k]);
  assert.deepEqual(parts.map((o) => o.constructor.name), CLASSES_9K2);
  for (const o of parts) {
    assert.ok(o instanceof ctx.Controller, o.constructor.name);
    assert.equal(o.app, app, o.constructor.name);
  }
  assert.deepEqual(Object.keys(editor).filter((k) => editor[k] instanceof ctx.Controller),
    ['sync', 'open', 'pane', 'watch', 'section', 'doc', 'file', 'docRender', 'search']);
});

test('TC-FEA-1(9k-2): 위임자는 부품 메서드를 같은 인자로 부르고 값을 돌려준다 — 파일 열기만 부르던 _edLinkedWindow 는 걷었다', () => {
  const ctx = load9k1();
  const app = new ctx.App();
  app.editor = { doc: {}, file: {}, search: {}, docRender: {} };
  const seen = [];
  for (const [path, names] of Object.entries(DELEGATES_9K2)) {
    const target = path.split('.').reduce((o, k) => o[k], app);
    for (const n of names) target[n] = (...a) => { seen.push([n, ...a]); return 'r:' + n };
  }
  for (const names of Object.values(DELEGATES_9K2)) for (const n of names) assert.equal(app[n](1, 'x'), 'r:' + n, n);
  assert.deepEqual(plain(seen), Object.values(DELEGATES_9K2).flat().map((n) => [n, 1, 'x']));
  assert.equal(ctx.App.prototype._edLinkedWindow, undefined);
});

test('TC-FEA-1(9k-2): 묶음 하나만 닿는 필드는 부품이 든다 — 클립보드·찾기 패널 (§2.2 SH-4)', () => {
  const ctx = load9k1();
  const app = controllers(ctx, new ctx.App());
  app.edClipSet('/r', ['/r/a'], true);
  assert.deepEqual(plain(app.edClipGet()), { root: '/r', paths: ['/r/a'], move: true });
  assert.equal(app.editor.file._edClip, app.edClipGet());
  assert.equal('_edClip' in app, false);
  assert.match(read('core/editor-search.js'), /this\._edPanelEl=p;/);
  assert.match(read('core/editor-file.js'), /this\.app\.editor\.open\._edReveal/);
  assert.match(read('core/editor-file.js'), /this\.app\.edFocusHandoff\(\)/);
});

test('TC-FEA-1(9k-2): 편집기 키는 App 의 이름으로 부른다 — 다른 부품(저장 전부)에 닿는다', () => {
  const ctx = load9k1({ ED_APP_ACTIONS: { edSaveAll: '_edSaveAll' }, ED_LSP_ACTIONS: {}, shortcuts: { edSaveAll: 's' },
    matchShortcut: (e, k) => e.key === k });
  const app = controllers(ctx, new ctx.App());
  const log = [];
  app.aw = () => ({ type: 'editor' });
  app.editor.sync._edSaveAll = () => log.push('saveAll');
  const e = { key: 's', preventDefault: () => log.push('pd'), stopImmediatePropagation: () => {} };
  assert.equal(app.edTrySearchKey(e), true);
  assert.deepEqual(log, ['pd', 'saveAll']);
});

test('TC-FEA-2(9k-2): 컨트롤러는 덮어쓰기 대상·계약 이름을 this.app 으로 부른다', () => {
  const force = new Set([...overridden(), ...contractNames()]);
  for (const f of ISSUES['9k-2'].ctl) {
    const bad = [...thisNames(read(f))].filter((n) => force.has(n));
    assert.deepEqual(bad, [], f);
  }
});

test('TC-FEA-2(9k-2): 갈아 끼운 _edDocs·aw·paneTabSet·setFocusState·render·save·edOpenFile·fileEditors·ws·_edConfirm 를 부품 경로가 부른다', () => {
  const ctx = load9k1({ findTabWhere: (wins, fn) => {
    for (const w of wins) for (const t of w.tabs) if (fn(t)) return { win: w, pane: w, tab: t };
    return null;
  }, pathUnder: (r, p) => p.startsWith(r + '/'), pathBase: (p) => p.split('/').pop(), josa: (x) => x,
  EDITOR_DEL_FILE: 'del %s', EDITOR_DEL_PERMANENT: 'perm', EDITOR_DEL_OK: 'ok' });
  const app = controllers(ctx, new ctx.App());
  const log = [];
  app._edDocs = new Map([['/a/x', { views: new Set() }]]);
  assert.deepEqual(plain(app.edDocMove('/a', '/b').moved), [['/a/x', '/b/x']]);
  assert.ok(app._edDocs.has('/b/x'));
  const pane = { id: 'p', tabs: [{ id: 't', render: true, filePath: '/f' }] };
  app.ws = { windows: [pane], activeWindow: 'w' };
  app.aw = () => { log.push('aw'); return { id: 'w', layout: pane } };
  app.paneTabSet = (p, id) => log.push('tab:' + id);
  app.setFocusState = (id) => log.push('focus:' + id);
  app.render = () => log.push('render');
  app.save = () => log.push('save');
  app._docRenderOpen('/f');
  app.edOpenFile = (p) => log.push('open:' + p);
  app.docRenderToSource({ filePath: '/f' });
  app.fileEditors = new Map([['x', { render: true, filePath: '/f', onDocBuf: (b) => log.push('buf:' + b) }]]);
  app.editor.docRender._docRenderNotifyBuf('/f', 'B');
  app.ws = { windows: [{ id: 'w', type: 'editor', editor: { root: '/r' } }], activeWindow: 'w' };
  assert.equal(app._edSearchRoot(), '/r');
  app._edConfirm = (lines) => { log.push('confirm:' + lines.join('|')); return 'asked' };
  assert.equal(app.edConfirmDelete('/r/a.txt', false, 0, [], ''), 'asked');
  assert.deepEqual(log, ['aw', 'tab:t', 'focus:p', 'render', 'save', 'open:/f', 'buf:B', 'confirm:del a.txt|perm']);
});

test('TC-FEA-3(9k-2): 옮긴 mixin 파일이 없고 Object.assign(App.prototype 의 수가 준다', () => {
  const issue = ISSUES['9k-2'];
  for (const f of issue.gone) assert.ok(!existsSync(join(JS_ROOT, f)), '남았다: ' + f);
  const html = readFileSync(join(REPO, 'web/index.html'), 'utf8');
  for (const f of issue.gone) assert.ok(!html.includes('js/' + f + '"') && !html.includes('js/' + f + '?'), 'index.html 이 싣는다: ' + f);
  for (const f of issue.ctl) assert.doesNotMatch(read(f), /Object\.assign\(App\.prototype/, f);
  const mixins = walk(JS_ROOT, (n) => n.endsWith('.js')).filter((f) => !f.includes('/test/'))
    .filter((f) => readFileSync(f, 'utf8').includes('Object.assign(App.prototype'));
  assert.ok(mixins.length <= issue.mixins, 'mixin 파일 ' + mixins.length + ' > ' + issue.mixins);
});

test('TC-FEA-3(9k-2): 옮긴 묶음의 계약 이름이 App 원형에서 함수로 읽힌다', () => {
  const ctx = load9k1();
  const contract = contractNames();
  const names = Object.values(DELEGATES_9K2).flat().filter((x) => contract.has(x));
  assert.ok(names.length > 0);
  for (const n of names) assert.equal(typeof ctx.App.prototype[n], 'function', n);
});

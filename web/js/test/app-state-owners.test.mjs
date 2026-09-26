import assert from 'node:assert/strict';
import { test } from 'node:test';

import { load } from './harness.mjs';

/**
 * APP_STATE_EXTRACT_SRS 묶음 E (FR-OPT-16-1) — App 필드 가족을 소유 클래스로 옮긴다.
 *
 * 재는 것은 §2.3a 의 계약이다:
 *   TC-ASE-5  소유 클래스의 메서드 집합이 옮기기 전과 같고, App 에 남은 그 가족의 이름이
 *             정확히 껍데기·접근자 목록이다
 *   TC-ASE-6  접근자는 accessor 서술자다 — 읽기가 소유자를 만들지 않고 쓰기가 소유자에 닿는다
 *   TC-ASE-7  e2e 가 app 에 갈아 끼운 메서드를 가족 안의 호출이 부른다 (A-6)
 */
const ownNames = (proto) => Object.getOwnPropertyNames(proto).filter((n) => n !== 'constructor').sort();

// ── FR-ASE-7 · LSP ──

const LSP_METHODS = ['_initLSP', '_lspAsk', '_lspCanBack', '_lspDismissed', '_lspExtOf', '_lspFindRefs',
  '_lspGo', '_lspGotoDef', '_lspHover', '_lspHoverWhere', '_lspInstall', '_lspInstallOnce', '_lspJump',
  '_lspList', '_lspNavBack', '_lspOnDiagnostics', '_lspOpenerRegister', '_lspPaint', '_lspPathOfModel',
  '_lspPathPut', '_lspPathRows', '_lspPathsBind', '_lspPathsLoad', '_lspProvideDef', '_lspPush',
  '_lspRefresh', '_lspRel', '_lspRootOfPath', '_lspSetDiag', '_lspStatusCached', '_lspStatusInvalidate',
  '_lspUriPathOf', '_lspVersionOf', '_lspWhere', 'lspClearDiagnostics', 'lspClickDef', 'lspDismiss',
  'lspDocClosed', 'lspHoverRegister', 'lspOfferFor', 'lspOfferInstall'];
const LSP_SHELLS = ['_initLSP', '_lspRefresh', '_lspGotoDef', '_lspFindRefs', '_lspNavBack', '_lspCanBack',
  '_lspOnDiagnostics', '_lspRootOfPath', 'lspClickDef', 'lspDocClosed', 'lspClearDiagnostics',
  'lspHoverRegister', 'lspOfferFor', 'lspOfferInstall', 'lspDismiss'];
const LSP_ACCESSORS = ['_lspHoverLangs', '_lspDefLangs'];

function loadLsp() {
  const store = { bool: (_k, d) => d, remove() {}, json: () => null, setJson() {}, setBool() {} };
  return load(['core/lsp-client.js', 'core/lsp-paths.js', 'core/app-lsp.js'], {
    expose: ['LspClient'],
    globals: { App: class {}, PrefStore: { local: store }, LSP_DIAG_KEY: 'k', STORE_KEYS: {}, LSP_BACK_MAX: 50 },
  });
}

test('FR-ASE-7: LspClient 가 LSP 메서드 41개를 갖고 App 에는 껍데기·접근자만 남는다', () => {
  const ctx = loadLsp();
  assert.deepEqual(ownNames(ctx.LspClient.prototype), [...LSP_METHODS].sort());
  assert.deepEqual(ownNames(ctx.App.prototype), [...LSP_SHELLS, ...LSP_ACCESSORS, '_lspClient'].sort());
});

test('FR-ASE-7: 접근자는 accessor 서술자이고 읽기가 LspClient 를 만들지 않는다', () => {
  const ctx = loadLsp();
  for (const n of LSP_ACCESSORS) {
    const d = Object.getOwnPropertyDescriptor(ctx.App.prototype, n);
    assert.equal(typeof d.get, 'function', n + ' 에 게터가 없다 — Object.assign 이 값으로 복사했다');
    assert.equal(typeof d.set, 'function', n);
  }
  const app = new ctx.App();
  assert.equal(app._lspHoverLangs, undefined);
  assert.equal(app._lsp, undefined, '읽기가 소유자를 만들었다');
  const s = new Set(['go']);
  app._lspHoverLangs = s;
  assert.equal(app._lsp._lspHoverLangs, s);
  assert.equal(app._lspHoverLangs, s);
});

test('FR-ASE-7: 껍데기는 같은 LspClient 에 위임한다', () => {
  const ctx = loadLsp();
  const app = new ctx.App();
  assert.equal(app._lspCanBack(), false);
  app._lspClient()._lspPush({ path: '/r/a.go', line: 1, col: 1 });
  assert.equal(app._lspCanBack(), true);
  assert.equal(app._lspClient(), app._lsp);
  assert.equal(app._lsp.app, app);
});

// ── FR-ASE-8 · Repo 목록 ──

const REPOS_METHODS = ['_startGitReposPoll', 'gitReposKick', '_gitReposOnChanged', 'gitReposRefresh', '_gitReposSigOf'];
const REPOS_SHELLS = ['_startGitReposPoll', 'gitReposKick', '_gitReposOnChanged', 'gitReposRefresh', '_gitReposList'];

function loadRepos(globals = {}) {
  return load(['core/constants-api.js', 'core/git-repos-list.js', 'core/app-git.js'], {
    expose: ['GitReposList'],
    globals: { App: class {}, visiblePoll: () => ({ stop() {} }), gitStatusInterval: 30000, ...globals },
  });
}

test('FR-ASE-8: GitReposList 가 목록 갱신 메서드 다섯을 갖고 App 에는 껍데기 넷과 지연 생성이 남는다', () => {
  const ctx = loadRepos();
  assert.deepEqual(ownNames(ctx.GitReposList.prototype), [...REPOS_METHODS].sort());
  const left = ownNames(ctx.App.prototype).filter((n) => /Repos/.test(n));
  assert.deepEqual(left, [...REPOS_SHELLS].sort());
  assert.equal(ctx.App.prototype._gitReposSigOf, undefined, '내부 계산이 App 에 남았다');
});

test('FR-ASE-8 · A-6: app 에 갈아 끼운 gitReposRefresh 를 가족 안의 gitReposKick 이 부른다', async () => {
  const ctx = loadRepos();
  const a = new ctx.App();
  let n = 0;
  a.gitReposRefresh = async () => { n++ };
  a.gitReposKick();
  await new Promise((r) => setImmediate(r));
  assert.equal(n, 1);
  assert.equal(a._reposList.app, a);
});

// ── FR-ASE-9 · 설정 저장 ──

const SYNC_METHODS = ['saveSettings', '_settingsLocalPending', '_saveSettingsSoon', '_saveSettingsNow', '_settingsAcceptRemote'];
const SYNC_SHELLS = ['saveSettings', '_settingsLocalPending', '_saveSettingsSoon', '_saveSettingsNow', '_settingsSync'];

function loadSync() {
  const puts = [];
  const ctx = load(['core/state-registry.js', 'core/settings-sync.js', 'core/app-settings.js', 'core/app-settings-init.js'], {
    expose: ['SettingsSync'],
    globals: {
      App: function App() {}, SETTINGS_SCHEMA: [], SETTINGS_SAVE_FAIL: 'fail',
      apiPut: async (path, body) => { puts.push(body); return { ok: true } },
    },
  });
  return { ctx, puts };
}

test('FR-ASE-9: SettingsSync 가 저장 파이프라인을 갖고 App 에는 껍데기 넷과 지연 생성이 남는다', () => {
  const { ctx } = loadSync();
  assert.deepEqual(ownNames(ctx.SettingsSync.prototype), [...SYNC_METHODS].sort());
  for (const n of SYNC_SHELLS) assert.equal(typeof ctx.App.prototype[n], 'function', n);
  assert.equal(ctx.App.prototype._settingsAcceptRemote, undefined, '에코 판정이 App 에 남았다');
});

test('FR-ASE-9 · A-6: 에코 판정은 app 에 갈아 끼운 _settingsApply 를 부르고 보낸 본문은 얹지 않는다', async () => {
  const { ctx, puts } = loadSync();
  const app = new ctx.App();
  app.clientId = 'c';
  const applied = [];
  app._settingsApply = (d) => applied.push(d);
  await app.saveSettings();
  const sync = app._settingsSync();
  assert.equal(sync.app, app);
  sync._settingsAcceptRemote({ ok: true, text: puts[0], data: {} });
  assert.equal(applied.length, 0, '자기 에코를 얹었다');
  sync._settingsAcceptRemote({ ok: true, text: '{"x":1}', data: { x: 1 } });
  assert.equal(applied.length, 1);
});

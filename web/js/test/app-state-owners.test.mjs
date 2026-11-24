import assert from 'node:assert/strict';
import { test } from 'node:test';

import { BASE, GIT, controllers, load } from './harness.mjs';

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

const LSP_METHODS = ['_lspConn', '_lspConnNote', '_lspConnOf', '_lspDismissed',
  '_lspDisplay', '_lspExtOf', '_lspFindRefs', '_lspGotoDef', '_lspInstall', '_lspInstallOnce', '_lspLinkAt', '_lspPaint',
  '_lspPathPut', '_lspPathRows', '_lspPathsBind', '_lspPathsLoad',
  '_lspRefresh', '_lspRootOfPath', '_lspRun', '_lspRunOn', '_lspSetDiag', '_lspStatusCached', '_lspStatusInvalidate',
  'lspClickDef', 'lspDismiss', 'lspExtFor', 'lspOfferFor', 'lspOfferInstall', 'lspOfferPending', 'lspOfferReopen'];
// UX_AUDIT_FIX_SRS FR-UXF-82·83 로 개정: 이전 껍데기 `lspDismiss`(띠의 `다시 보지 않기`) / 지금 기록은 띠가 설 때
// LspClient 안에서 남고, 상태바 표식이 `lspOfferPending`·`lspOfferReopen` 을 부른다 / 이유 진단 D15.
const LSP_SHELLS = ['_lspRefresh', '_lspGotoDef', '_lspFindRefs',
  '_lspRootOfPath', 'lspClickDef', 'lspExtFor', 'lspOfferFor', 'lspOfferInstall', 'lspOfferPending', 'lspOfferReopen'];

// REFACTOR3_FE_APPCTL_SRS 9a: 껍데기와 지연 생성은 `app.js` 본문이다(옛 `app-lsp.js`). 생성자는 돌리지 않는다.
function loadLsp() {
  const store = { bool: (_k, d) => d, remove() {}, json: () => null, setJson() {}, setBool() {} };
  return load([...BASE, 'core/app.js', 'core/lsp-client.js', 'core/lsp-paths.js'], {
    expose: ['LspClient', 'App'],
    globals: { PrefStore: { local: store }, LSP_DIAG_KEY: 'k', STORE_KEYS: {}, TIMERS: { disposeOwner() {} } },
  });
}

test('FR-ASE-7: LspClient 가 LSP 메서드 30개를 갖고 App 에는 지연 생성 접근자만 남는다', () => {
  const ctx = loadLsp();
  assert.deepEqual(ownNames(ctx.LspClient.prototype), [...LSP_METHODS].sort());
  // REFACTOR3_FE_DELEG_SRS: App 의 껍데기(위임자) 열은 걷었다 — 부르는 쪽이 `app.lspClient().X()` 를 부른다.
  const left = ownNames(ctx.App.prototype).filter((n) => /lsp/i.test(n));
  assert.deepEqual(left, ['lspClient']);
  for (const n of LSP_SHELLS) assert.equal(typeof ctx.LspClient.prototype[n], 'function', n);
});

test('FR-ASE-7: 지연 생성한 LspClient 는 하나이고 거기 갈아 끼운 것을 부른다', () => {
  const ctx = loadLsp();
  const app = Object.create(ctx.App.prototype);
  const seen = [];
  app.lspClient()._lspRootOfPath = (p) => { seen.push(p); return '/r' };
  assert.equal(app.lspClient()._lspRootOfPath('/r/a.go'), '/r');
  assert.deepEqual(seen, ['/r/a.go']);
  assert.equal(app.lspClient(), app._lsp);
  assert.equal(app._lsp.app, app);
});

// ── FR-ASE-8 · Repo 목록 ──

const REPOS_METHODS = ['_gitPinsWatchSync', 'gitReposKick', '_gitReposOnChanged', 'gitReposRefresh', '_gitReposSigOf'];
// REFACTOR3_FE_APPCTL_SRS 9d: 껍데기와 지연 생성은 `GitSync`(`git.sync`)로 옮겼다.
const REPOS_SHELLS = ['gitReposKick', '_gitReposOnChanged', 'gitReposRefresh', '_gitReposList'];

function loadRepos(globals = {}) {
  return load([...BASE, 'core/constants-api.js', ...GIT], {
    expose: ['GitReposList', 'GitSync'],
    globals: { App: class {}, TIMERS: { disposeOwner() {} }, visiblePoll: () => ({ stop() {} }), gitStatusInterval: 30000, ...globals },
  });
}

test('FR-ASE-8: GitReposList 가 목록 갱신 메서드 다섯을 갖고 GitSync 에 껍데기 넷과 지연 생성이 있으며 App 에는 없다', () => {
  const ctx = loadRepos();
  assert.deepEqual(ownNames(ctx.GitReposList.prototype), [...REPOS_METHODS].sort());
  assert.deepEqual(ownNames(ctx.GitSync.prototype).filter((n) => /Repos/.test(n)), [...REPOS_SHELLS].sort());
  // REFACTOR3_FE_DELEG_SRS: App 의 위임자 둘(`gitReposKick`·`gitReposRefresh`)은 걷었다 — 부르는 쪽이 `git.sync` 를 부른다.
  assert.deepEqual(ownNames(ctx.App.prototype).filter((n) => /Repos/.test(n)), []);
  assert.equal(ctx.App.prototype._gitReposSigOf, undefined, '내부 계산이 App 에 남았다');
});

test('FR-ASE-8 · A-6: app 에 갈아 끼운 gitReposRefresh 를 가족 안의 gitReposKick 이 부른다', async () => {
  const ctx = loadRepos();
  const a = controllers(ctx, new ctx.App());
  let n = 0;
  a.git.sync.gitReposRefresh = async () => { n++ };
  a.git.sync.gitReposKick();
  await new Promise((r) => setImmediate(r));
  assert.equal(n, 1);
  assert.equal(a.git.sync._reposList.app, a);
});

// ── FR-ASE-9 · 설정 저장 ──

const SYNC_METHODS = ['saveSettings', '_settingsLocalPending', '_saveSettingsSoon', '_saveSettingsNow', '_settingsAcceptRemote'];
// REFACTOR3_FE_APPCTL_SRS 9a: 지연 생성 `_settingsSync` 는 `SettingsApply`(`settings.apply`) 로 옮겼다.
const SYNC_SHELLS = ['saveSettings', '_settingsLocalPending', '_saveSettingsSoon', '_saveSettingsNow'];

function loadSync() {
  const puts = [];
  const ctx = load([...BASE, 'core/state-registry.js', 'core/settings-sync.js', 'core/settings-apply.js'], {
    expose: ['SettingsSync', 'SettingsApply'],
    globals: {
      App: function App() {}, SETTINGS_SCHEMA: [], SETTINGS_SAVE_FAIL: 'fail', TIMERS: { disposeOwner() {} },
      apiPut: async (path, body) => { puts.push(body); return { ok: true } },
    },
  });
  return { ctx, puts };
}

test('FR-ASE-9: SettingsSync 가 저장 파이프라인을 갖고 SettingsApply 에는 껍데기 넷과 지연 생성이 남는다', () => {
  const { ctx } = loadSync();
  assert.deepEqual(ownNames(ctx.SettingsSync.prototype), [...SYNC_METHODS].sort());
  // REFACTOR3_FE_DELEG_SRS: 껍데기는 `settings.apply` 에 있고 App 원형의 위임자는 걷었다.
  for (const n of SYNC_SHELLS) {
    assert.equal(typeof ctx.SettingsApply.prototype[n], 'function', n);
    assert.equal(ctx.App.prototype[n], undefined, '위임자가 남았다: ' + n);
  }
  assert.equal(ctx.App.prototype._settingsAcceptRemote, undefined, '에코 판정이 App 에 남았다');
});

test('FR-ASE-9 · A-6: 에코 판정은 app 에 갈아 끼운 _settingsApply 를 부르고 보낸 본문은 얹지 않는다', async () => {
  const { ctx, puts } = loadSync();
  const app = new ctx.App();
  app.settings = { apply: new ctx.SettingsApply(app) };
  app.clientId = 'c';
  const applied = [];
  app.settings.apply._settingsApply = (d) => applied.push(d);
  await app.settings.apply.saveSettings();
  const sync = app.settings.apply._settingsSync();
  assert.equal(sync.app, app);
  sync._settingsAcceptRemote({ ok: true, text: puts[0], data: {} });
  assert.equal(applied.length, 0, '자기 에코를 얹었다');
  sync._settingsAcceptRemote({ ok: true, text: '{"x":1}', data: { x: 1 } });
  assert.equal(applied.length, 1);
});

test('D-OPT-7 · C2b: 비행 중에 온 자기 에코(보낸 본문과 같음)는 놓친 방송이 아니다 — 비행 뒤 GET 이 없다', async () => {
  const { ctx } = loadSync();
  const app = new ctx.App();
  app.settings = { apply: new ctx.SettingsApply(app) };
  app.clientId = 'c';
  let restores = 0;
  app.settings.apply._settingsRestore = () => { restores++ };
  const sync = app.settings.apply._settingsSync();
  let release;
  ctx.apiPut = (path, body) => new Promise((r) => { release = () => r({ ok: true }) });
  const own = sync.saveSettings();
  sync._settingsAcceptRemote({ ok: true, text: sync._settingsLastSent, data: {} });
  release();
  await own;
  assert.equal(restores, 0, '자기 에코를 놓친 방송으로 보고 다시 받았다');

  const other = sync.saveSettings();
  sync._settingsAcceptRemote({ ok: true, text: '{"other":1}', data: { other: 1 } });
  release();
  await other;
  assert.equal(restores, 1, '비행 중의 남의 저장을 다시 보지 않았다');
});

// ── REFACTOR3_FE_APPCTL_SRS TC-FEA-3 · 계약 이름 ──

/**
 * 계약(`app-testing.js`)의 이름은 App 인스턴스에서 그대로 읽힌다 — mixin 을 컨트롤러로 옮겨도 App 에 메서드
 * (본문·mixin·위임자 표)나 필드(`this.X=`)로 남는다.
 */
test('TC-FEA-3: 계약의 이름은 모두 App 의 메서드·필드이거나 경로 끝 주인의 메서드다', async () => {
  const { readFileSync, readdirSync } = await import('node:fs');
  const { join } = await import('node:path');
  const root = new URL('..', import.meta.url).pathname;
  const read = (rel) => readFileSync(join(root, rel), 'utf8');
  const contract = [...read('core/app-testing.js').match(/const APP_TESTING_NAMES = \[([\s\S]*?)\];/)[1].matchAll(/'([^']+)'/g)]
    .map((m) => m[1]);
  assert.equal(contract.length, 145);
  const appFiles = ['core/app.js', ...readdirSync(join(root, 'core')).map((n) => 'core/' + n),
    ...readdirSync(join(root, 'ui')).map((n) => 'ui/' + n)]
    .filter((f) => f.endsWith('.js') && (f === 'core/app.js' || /Object\.(assign|defineProperties)\(App\.prototype/.test(read(f))));
  const names = new Set();
  for (const f of appFiles) {
    const src = read(f);
    for (const m of src.matchAll(/^ {2}(?:async\s+|get\s+|set\s+)?([A-Za-z_$][\w$]*)\s*\(/gm)) names.add(m[1]);
    for (const m of src.matchAll(/\bthis\.([A-Za-z_$][\w$]*)\s*=(?!=)/g)) names.add(m[1]);
    for (const m of src.matchAll(/^ {2}([A-Za-z_$][\w$]*)\s*:\s*\{/gm)) names.add(m[1]);   // `Object.defineProperties` 접근자
  }
  // 컨트롤러가 App 에 쓰는 필드 — 컨트롤러 파일마다 본다(위임자 표는 REFACTOR3_FE_DELEG_SRS 로 없어졌다).
  for (const f of readdirSync(join(root, 'core')).filter((n) => n.endsWith('.js')).map((n) => 'core/' + n)) {
    const src = read(f);
    for (const m of src.matchAll(/\bthis\.app\.([A-Za-z_$][\w$]*)\s*=(?!=)/g)) names.add(m[1]);   // 컨트롤러가 App 에 쓰는 필드
  }
  // REFACTOR3_FE_DELEG_SRS FR-DLG-4: 위임자였던 이름은 앱에서 주인까지의 점 경로로 적힌다 — 마지막 이름이 그 주인 클래스의
  // 메서드다. 주인은 생성자의 `this.<k>=new <C>(` 를 app.js 에서부터 따라 찾는다.
  const classFile = (c) => appFiles.concat(readdirSync(join(root, 'core')).map((n) => 'core/' + n), readdirSync(join(root, 'ui'))
    .map((n) => 'ui/' + n)).find((f) => f.endsWith('.js') && new RegExp('^class ' + c + '\\b', 'm').test(read(f)));
  const LAZY = { 'lspClient()': 'LspClient', 'runsPanel()': 'RunsPanel' };
  const owned = (entry) => {
    const keys = entry.split('.');
    const n = keys.pop();
    let file = 'core/app.js';
    for (const k of keys) {
      const sec = /^section\((\w+)\)$/.exec(k);
      if (sec) { file = 'core/settings-' + sec[1] + '.js'; continue }
      const m = read(file).match(new RegExp('this\\.' + k + '=new ([A-Z][A-Za-z]+)\\('));
      file = classFile(LAZY[k] || (m && m[1]));
      if (!file) return false;
    }
    return new RegExp('^ {2}(?:async\\s+)?' + n.replace(/\$/g, '\\$') + '\\(', 'm').test(read(file));
  };
  // REFACTOR3_FE_FIX_SRS FR-FFX-15: 계약의 모든 이름이 App 에 있다 — 알려진 예외(`_gitJobChip`·`_focusCh`)를 걷었다.
  assert.deepEqual(contract.filter((n) => (n.includes('.') ? !owned(n) : !names.has(n))), []);
  // 둘은 되살아나지 않는다 — 상태바의 원격 작업 chip(U-19 ①)과 BroadcastChannel 포커스 경로(FR-XDF-5).
  for (const gone of ['_gitJobChip', '_focusCh']) assert.ok(!names.has(gone) && !contract.includes(gone), gone);
});

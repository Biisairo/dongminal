/**
 * PERF 3.4.12.7 (D-44) — CM 공용 층·lsp-client·lsp-paths 를 `cm` 묶음으로 옮긴 뒤 부팅 쪽 진입점의 계약.
 *
 * - 등록: `cm` 은 `needs:['mdlib']`, `editor`·`git` 은 `needs:['cm']`.
 * - `EditorOpen.edDirtyDiff`: cm 이 실리기 전에는 `null` 이다(전역이 우연히 있어도 묻지 않는다).
 * - `App.lspClient()`: cm 이 실리기 전에는 만들지 않고 `null` 을 준다.
 * - 설정 ▸ Code: 탭을 고르면 cm 을 실은 뒤 언어 서버 상태를 읽는다.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { BASE, EDITOR, GIT, SCREENS_LOADED, SETTINGS, load, plain } from './harness.mjs';

const DOC = { hidden: false, getElementById: () => null, querySelector: () => null, querySelectorAll: () => [] };

function loadEditor(globals = {}) {
  return load([...BASE, ...EDITOR], {
    expose: ['EditorController', 'Screens'],
    globals: {
      App: class App { constructor() { this.layout = { tabAdd: { _findEditorTab: () => null } } } },
      TIMERS: { disposeOwner() {}, frame() {}, after() { return { stop() {} } } },
      WINDOW_TYPE_EDITOR: 'editor', TAB_TYPE_EDITOR: 'editor', TAB_TYPE_TERMINAL: 'terminal',
      REPO_SIDE_EXPLORER: 'explorer', REPO_SIDE_DEFAULT: 'explorer', REPO_SIDE_TABS: [{ id: 'explorer' }],
      panesOf: (l) => (l ? [l] : []), document: DOC,
      ...globals,
    },
  });
}

test('TC-CMB-U1: cm 은 mdlib 를, editor 는 cm 을 needs 로 등록한다', () => {
  const ctx = loadEditor();
  assert.deepEqual(plain(ctx.Screens._defs.get('cm').needs), ['mdlib']);
  assert.equal(ctx.Screens._defs.get('cm').tab, null);
  assert.deepEqual(plain(ctx.Screens._defs.get('editor').needs), ['cm']);
});

test('TC-CMB-U2: git 은 cm 을 needs 로 등록한다', () => {
  const ctx = load([...BASE, ...GIT], {
    expose: ['Screens'],
    globals: { App: function App() {}, TIMERS: { disposeOwner() {} }, t: (k) => k, tn: (k) => k, document: DOC },
  });
  assert.deepEqual(plain(ctx.Screens._defs.get('git').needs), ['cm']);
});

test('TC-CMB-U3: edDirtyDiff 는 cm 이 실리기 전에는 null 이고, 실린 뒤 문서마다 하나를 만든다', () => {
  let made = 0;
  const ctx = loadEditor({ EdDirtyDiff: class { constructor() { made++ } } });
  const app = new ctx.App();
  const editor = new ctx.EditorController(app);
  const doc = {};
  editor.open.edDoc = () => doc;
  assert.equal(editor.open.edDirtyDiff('/r/a.txt'), null);
  assert.equal(made, 0);
  ctx.Screens._ready.add('cm');
  const dd = editor.open.edDirtyDiff('/r/a.txt');
  assert.ok(dd);
  assert.equal(editor.open.edDirtyDiff('/r/a.txt'), dd);
  assert.equal(made, 1);
});

test('TC-CMB-U4: lspClient() 는 cm 이 실리기 전에는 null 이고, 실린 뒤 하나를 만들어 다시 준다', () => {
  let made = 0;
  const ctx = load([...BASE, 'core/screens.js', 'core/app.js'], {
    expose: ['App', 'Screens'],
    globals: { TIMERS: { disposeOwner() {} }, LspClient: class { constructor(app) { made++; this.app = app } } },
  });
  const app = {};
  assert.equal(ctx.App.prototype.lspClient.call(app), null);
  assert.equal(made, 0);
  ctx.Screens._ready.add('cm');
  const c = ctx.App.prototype.lspClient.call(app);
  assert.equal(c.app, app);
  assert.equal(ctx.App.prototype.lspClient.call(app), c);
  assert.equal(made, 1);
});

test('TC-CMB-U5: 설정 ▸ Code 탭은 cm 을 실은 뒤 언어 서버 상태를 읽는다', async () => {
  const ctx = load([...BASE, ...SETTINGS], {
    expose: ['CodeSection'],
    globals: { App: function App() {}, TIMERS: { disposeOwner() {} }, Screens: { ...SCREENS_LOADED }, document: DOC },
  });
  const loads = [];
  let release;
  ctx.Screens.load = (n) => { loads.push(n); return new Promise((r) => { release = r }) };
  let refreshed = 0;
  const app = { lspClient: () => ({ _lspRefresh() { refreshed++ } }) };
  const s = new ctx.CodeSection(app);
  s.onTab();
  assert.deepEqual(loads, ['cm']);
  assert.equal(refreshed, 0);
  release();
  await new Promise((r) => setImmediate(r));
  assert.equal(refreshed, 1);
});

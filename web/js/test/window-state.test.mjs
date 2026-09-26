import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { load, plain, HELPERS } from './harness.mjs';

/**
 * OPTIMIZE_REFACTOR_SRS FR-OPT-11-1 — 워크스페이스 정규화 한 벌(FEC-17) · 활성 창
 * 전환 한 메서드(FEC-18) · 레이아웃 트리 순회 한 헬퍼(FEC-21).
 */
const JS = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(JS, rel), 'utf8');
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');

function memStore() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)) },
    removeItem: (k) => { m.delete(k) },
    _m: m,
  };
}

function world() {
  const sessionStorage = memStore();
  const ctx = load(['core/pref-store.js', 'core/i18n.js', 'i18n/ko.js', 'core/constants.js',
    ...HELPERS, 'core/app-window-state.js'], {
    globals: {
      App: function App() {}, sessionStorage, ACTIVE_EDITOR_ROOT_KEY: 'activeEditorRoot',
      ErrorLog: { push() {} },
    },
    expose: ['findTabWhere'],
  });
  const a = new ctx.App();
  a.isEditorWin = (s) => !!(s && s.editor);
  a.edRootOf = (s) => (s && s.editor && s.editor.root) || '';
  a._migrateGitWindow = () => 0;
  a._migrateEditorTabs = () => 0;
  a._edMigrateSideWidth = () => false;
  return { ctx, a, sessionStorage };
}

const pane = (id, tabs) => ({ type: 'pane', id, tabs, activeTab: tabs[0] && tabs[0].id });
const term = (id, toolId) => ({ id, type: 'terminal', toolId });

// ── FEC-17 ──────────────────────────────────────────────────────────────

test('FEC-17: 활성 창 폴백은 Editor 가 아닌 첫 창이고, 없으면 첫 창·null 이다', () => {
  const { a } = world();
  const ws = { activeWindow: 'gone', windows: [{ id: 'E', editor: { root: '/r' } }, { id: 'P' }] };
  a._fallbackActiveWindow(ws);
  assert.equal(ws.activeWindow, 'P');
  ws.activeWindow = 'E';
  a._fallbackActiveWindow(ws);
  assert.equal(ws.activeWindow, 'E', '살아 있는 활성 창은 그대로 둔다');
  const only = { activeWindow: null, windows: [{ id: 'E', editor: { root: '/r' } }] };
  a._fallbackActiveWindow(only);
  assert.equal(only.activeWindow, 'E');
  const none = { activeWindow: 'x', windows: [] };
  a._fallbackActiveWindow(none);
  assert.equal(none.activeWindow, null);
});

test('FEC-17: 정규화는 죽은 도구 탭을 걷고, layout 이 빈 일반 창만 지운다', () => {
  const { a } = world();
  const sv = { windows: [
    { id: 'A', layout: pane('p1', [term('t1', 'live'), term('t2', 'dead')]) },
    { id: 'B', layout: pane('p2', [term('t3', 'dead')]) },
    { id: 'E', editor: { root: '/r' } },
    null,
  ] };
  const changed = a._normalizeIncomingWorkspace(sv, new Set(['live']));
  assert.equal(changed, false);
  assert.deepEqual(plain(sv.windows.map((s) => s.id)), ['A', 'E']);
  assert.deepEqual(plain(sv.windows[0].layout.tabs.map((t) => t.id)), ['t1']);
});

test('FEC-17: 편집기 탭 마이그레이션이 옮겼으면 다시 거르고 바뀜을 알린다', () => {
  const { a } = world();
  const seen = [];
  a._migrateGitWindow = (list) => { seen.push(['git', list]); return 0 };
  a._migrateEditorTabs = (list) => { seen.push(['ed', list]); list[0].layout = null; return 1 };
  const sv = { windows: [{ id: 'A', layout: pane('p1', [term('t1', 'x')]) }, { id: 'B', layout: pane('p2', [term('t2', 'x')]) }] };
  const changed = a._normalizeIncomingWorkspace(sv, new Set(['x']));
  assert.equal(changed, true);
  assert.deepEqual(plain(sv.windows.map((s) => s.id)), ['B']);
  assert.equal(seen[0][0], 'git');
  assert.equal(seen[1][0], 'ed');
});

test('FEC-17: 기기 키를 걷어내고 폭을 옮겼는지 알린다', () => {
  const { a } = world();
  a.ws = { windows: [], displayMode: 'mobile', mobileBreakpoint: 900, sidebarWidth: 200 };
  assert.equal(a._stripDeviceKeys(), true);
  assert.deepEqual(Object.keys(a.ws), ['windows']);
  assert.equal(a._stripDeviceKeys(), false);
  a._edMigrateSideWidth = () => true;
  assert.equal(a._stripDeviceKeys(), true, 'Repo 사이드 폭의 이사도 바뀜이다');
});

test('FEC-17: 두 로드 경로가 같은 정규화·폴백을 지난다 (두 벌 금지)', () => {
  const init = code(read('core/app.js'));
  const remote = code(read('core/app-cmd.js'));
  for (const [name, src] of [['app.js', init], ['app-cmd.js', remote]]) {
    assert.match(src, /_normalizeIncomingWorkspace\(/, name + ' 가 정규화를 부르지 않는다');
    assert.match(src, /_fallbackActiveWindow\(/, name + ' 가 폴백을 부르지 않는다');
    assert.match(src, /_stripDeviceKeys\(/, name + ' 가 기기 키 정리를 부르지 않는다');
    assert.doesNotMatch(src, /find\(s=>!this\.isEditorWin\(s\)\)/, name + ' 에 폴백 식이 남아 있다');
    assert.doesNotMatch(src, /s\.layout=clean\(/, name + ' 에 정규화 루프가 남아 있다');
  }
});

// ── FEC-18 ──────────────────────────────────────────────────────────────

test('FEC-18: _activateWindow 는 모델과 탭별 기억(창 id·Repo 루트)을 함께 적는다', () => {
  const { a, sessionStorage } = world();
  a.ws = { activeWindow: 'P', windows: [{ id: 'P' }, { id: 'E', editor: { root: '/repo' } }] };
  a.aw = function () { return this.ws.windows.find((s) => s.id === this.ws.activeWindow) };
  a.focused = 'pane-1';
  a._activateWindow('E', { rememberFocus: true });
  assert.equal(a.ws.activeWindow, 'E');
  assert.equal(a.ws.windows[0].focusedPane, 'pane-1', '떠나는 창의 포커스를 적는다');
  assert.equal(sessionStorage.getItem('activeWindow'), 'E');
  assert.equal(sessionStorage.getItem('activeEditorRoot'), '/repo');
  a.focused = 'pane-9';
  a._activateWindow('E', { rememberFocus: true });
  assert.equal(a.ws.windows[1].focusedPane, undefined, '같은 창이면 떠나는 것이 아니다');
  a._activateWindow('P');
  assert.equal(sessionStorage.getItem('activeWindow'), 'P');
  assert.equal(sessionStorage.getItem('activeEditorRoot'), null, '일반 창이면 루트 기억을 지운다');
});

function jsFiles(dir, out = []) {
  for (const e of readdirSync(join(JS, dir), { withFileTypes: true })) {
    const rel = dir + '/' + e.name;
    if (e.isDirectory()) { if (!['test', 'i18n'].includes(e.name)) jsFiles(rel, out); continue; }
    if (e.name.endsWith('.js')) out.push(rel);
  }
  return out;
}

test('FEC-18: 활성 창의 탭별 기억을 쓰는 자리는 _persistActiveWindow 하나다', () => {
  for (const rel of [...jsFiles('core'), ...jsFiles('ui'), ...jsFiles('git')]) {
    if (rel === 'core/app-window-state.js') continue;
    const src = code(read(rel));
    assert.doesNotMatch(src, /setItem\(\s*'activeWindow'/, rel + ' 가 activeWindow 를 직접 적는다');
    assert.doesNotMatch(src, /(setItem|removeItem)\(\s*ACTIVE_EDITOR_ROOT_KEY/, rel + ' 가 Repo 루트를 직접 적는다');
    assert.doesNotMatch(src, /this\.ws\.activeWindow\s*=(?!=)/, rel + ' 가 활성 창을 직접 바꾼다');
  }
});

// ── FEC-21 ──────────────────────────────────────────────────────────────

test('FEC-21: findTabWhere 는 창 순서·칸 순서(L→R)대로 첫 탭의 자리를 준다', () => {
  const { ctx } = world();
  const w1 = { id: 'W1', layout: { type: 'split', children: [pane('a', [term('t1')]), pane('b', [term('t2'), term('t3')])] } };
  const w2 = { id: 'W2', layout: pane('c', [term('t3')]) };
  const r = ctx.findTabWhere([null, { id: 'X' }, w1, w2], (t) => t.id === 't3');
  assert.equal(r.win.id, 'W1');
  assert.equal(r.pane.id, 'b');
  assert.equal(r.tab.id, 't3');
  assert.equal(ctx.findTabWhere([w1, w2], (t) => t.id === 'none'), null);
  assert.equal(ctx.findTabWhere(undefined, () => true), null);
});

test('FEC-21: 트리 순회는 panesOf 한 벌이다 — 손으로 쓴 walk 가 없다', () => {
  const app = code(read('core/app.js'));
  assert.match(app, /flattenPanes\([^)]*\)\{\s*return panesOf\(/, 'flattenPanes 가 panesOf 에 위임하지 않는다');
  assert.match(app, /_collectPanes\([^)]*\)\{\s*out\.push\(\.\.\.panesOf\(/, '_collectPanes 가 panesOf 에 위임하지 않는다');
  for (const rel of ['core/app.js', 'core/app-layout.js', 'core/app-cmd.js', 'core/app-docrender.js',
    'core/app-statusbar.js', 'core/app-tool.js', 'core/app-editor-open.js', 'ui/runs-panel.js', 'ui/renderer-layout.js']) {
    const src = code(read(rel));
    assert.doesNotMatch(src, /const walk\s*=/, rel + ' 에 손으로 쓴 트리 순회가 남아 있다');
    assert.doesNotMatch(src, /this\._collectPanes\(/, rel + ' 가 _collectPanes 를 부른다 (panesOf 를 쓴다)');
  }
});

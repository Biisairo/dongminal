import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { BASE, GITVIEW, LIST, load } from './harness.mjs';

/**
 * REFACTOR3_FE_GITVIEW_SRS — Git 탭 기반 클래스 `GitView`.
 *   TC-FEV-1 수명 · TC-FEV-2 저장소 교체 · TC-FEV-3 세대 가드 · TC-FEV-4 gitLoadList
 *   TC-FEV-5 일곱 뷰의 계층과 옛 가드 이름 · TC-FEV-6 GitListTab 의 행 부품
 */
const JS = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => readFileSync(join(JS, f), 'utf8');

function el(tag) {
  const e = {
    tagName: tag, children: [], parentNode: null, dataset: {}, listeners: {},
    appendChild(c) { return this.insertBefore(c, null) },
    insertBefore(c, at) {
      if (c.parentNode) c.parentNode.removeChild(c);
      const i = at ? this.children.indexOf(at) : -1;
      if (i < 0) this.children.push(c); else this.children.splice(i, 0, c);
      c.parentNode = this;
      return c;
    },
    removeChild(c) { this.children.splice(this.children.indexOf(c), 1); c.parentNode = null; return c },
    addEventListener(t, fn) { this.listeners[t] = fn },
    removeEventListener(t, fn) { if (this.listeners[t] === fn) delete this.listeners[t] },
    querySelector: () => ({ addEventListener() {} }),
  };
  return e;
}

function setup(extra = [], expose = [], globals = {}) {
  return load([...BASE, 'ui/repaint.js', ...LIST, ...GITVIEW, ...extra], {
    expose: ['GitView', 'ListView', 'View', 'RPT_SEP', ...expose],
    globals: { TIMERS: { disposeOwner() {} }, document: { createElement: el }, AbortController, ...globals },
  });
}

/** 패널 대역. `bump()` 가 패널 세대(저장소 교체)를 올린다. */
function fakePanel(repo = '/r') {
  let gen = 1;
  return {
    app: { name: 'app' }, repo,
    token: () => gen,
    isStale: (t) => t !== gen,
    bump() { gen++ },
  };
}

test('TC-FEV-1 GitView 수명 — 받은 칸이 루트이고 dispose 는 그 칸을 떼지 않는다', () => {
  const ctx = setup();
  assert.ok(ctx.GitView.prototype instanceof ctx.View);
  let built = 0, got = null;
  class T extends ctx.GitView { _build(e) { built++; got = e } }
  const panel = fakePanel();
  const v = new T(panel);
  assert.equal(v.panel, panel);
  assert.equal(v.app, panel.app);
  assert.equal(v._repo, undefined, '처음 값은 "아직 받지 않음" 이다');
  v.mount(null);
  assert.equal(v.el, null);
  assert.equal(built, 0, '칸이 없으면 골격을 세우지 않는다');
  const host = el('div');
  const parent = el('div');
  parent.appendChild(host);
  v._repo = '/old';
  v.mount(host);
  assert.equal(v.el, host);
  assert.equal(got, host);
  assert.equal(built, 1);
  assert.equal(v._repo, undefined, '골격을 새로 세우면 다음 칠하기가 저장소를 다시 채운다');
  v._repo = '/r';
  v.unmount();
  assert.equal(v.el, null);
  assert.equal(v._repo, undefined);
  v.mount(host);
  v.dispose();
  assert.equal(host.parentNode, parent, '받은 칸을 뗐다');
});

test('TC-FEV-2 _syncRepo — 같으면 그대로, 다르면 _adopt → reset → (저장소가 있으면) _load', () => {
  const ctx = setup();
  const log = [];
  class T extends ctx.GitView {
    reset() { log.push('reset:' + this._repo) }
    _load() { log.push('load:' + this._repo) }
  }
  const panel = fakePanel('/r');
  const v = new T(panel);
  v.mount(el('div'));
  assert.equal(v._syncRepo(), true);
  assert.deepEqual(log, ['reset:/r', 'load:/r']);
  log.length = 0;
  assert.equal(v._syncRepo(), true);
  assert.deepEqual(log, [], '저장소가 같으면 다시 받지 않는다');
  panel.repo = null;
  assert.equal(v._syncRepo(), true);
  assert.deepEqual(log, ['reset:null'], '저장소가 없으면 받지 않는다');
  log.length = 0;
  v.reload();
  assert.deepEqual(log, ['load:null'], 'reload 의 기본은 _load 다');
  // 비우는 중에 칸을 놓았으면 붙어 있지 않다고 답한다.
  v.reset = function () { this.el = null };
  panel.repo = '/s';
  assert.equal(v._syncRepo(), false);
});

test('TC-FEV-3 세대 가드 — 채널은 뒤 표가 이기고, 패널 세대는 모든 표를 낡게 한다', () => {
  const ctx = setup();
  const panel = fakePanel();
  const v = new ctx.GitView(panel);
  const a = v.ticket('x');
  assert.equal(a.ch, 'x');
  assert.equal(a.tok, panel.token());
  assert.equal(v.superseded(a), false);
  assert.equal(v.stale(a), false);
  const b = v.ticket('x');
  assert.equal(v.superseded(a), true);
  assert.equal(v.stale(a), true);
  assert.equal(a.signal.aborted, true, '앞선 신호를 끊지 않았다');
  assert.equal(b.signal.aborted, false);
  assert.equal(v.superseded(b), false);
  const c = v.ticket('y');
  assert.equal(v.superseded(b), false, '채널이 다르면 서로 이기지 않는다');
  assert.equal(v.superseded(c), false);
  const n = v.ticket();
  const n2 = v.ticket();
  assert.equal(v.superseded(n), false, '채널 없는 표는 밀리지 않는다');
  assert.equal(v.superseded(n2), false);
  assert.equal(v.stale(n), false);
  panel.bump();
  for (const t of [b, c, n, n2]) assert.equal(v.stale(t), true, '패널 세대가 바뀌면 낡았다');
  assert.equal(v.superseded(b), false, '패널 세대는 밀림이 아니다');
  const d = v.ticket('x');
  v.dropTicket('x');
  assert.equal(v.superseded(d), true, 'dropTicket 뒤 앞 표는 밀렸다');
  assert.equal(d.signal.aborted, true);
  assert.equal(v.superseded(c), false, '다른 채널은 그대로다');
});

function loadView(extraGlobals = {}) {
  const calls = [];
  const ctx = setup(['git/view-util.js'], [], {
    gitFetch: (url, params, opts) => new Promise((resolve) => calls.push({ url, params, opts, resolve })),
    ...extraGlobals,
  });
  const panel = fakePanel('/r');
  let painted = 0;
  class T extends ctx.GitView { paint() { painted++ } }
  const v = new T(panel);
  v._repo = '/r';
  v._list = ['old'];
  v._err = null;
  v._loading = false;
  v.el = {};
  return { ctx, v, panel, calls, painted: () => painted };
}

const SPEC = { url: '/api/x', key: 'items', failMsg: 'fail' };

test('TC-FEV-4 gitLoadList — 밀린 응답은 잠금을 건드리지 않고, 낡은 응답은 잠금을 놓은 뒤 버린다', async () => {
  const { ctx, v, panel, calls, painted } = loadView();
  assert.equal(typeof ctx.gitLoadTicket, 'undefined');
  assert.equal(typeof ctx.gitLoadTaken, 'undefined');
  assert.equal(typeof ctx.gitViewMounted, 'undefined');
  const p1 = ctx.gitLoadList(v, SPEC);
  const p2 = ctx.gitLoadList(v, SPEC);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].opts.signal.aborted, true, '앞선 조회를 끊지 않았다');
  calls[0].resolve({ ok: true, data: { items: ['a'] } });
  await p1;
  assert.equal(v._loading, true, '밀린 응답이 살아 있는 조회의 잠금을 풀었다');
  assert.deepEqual([...v._list], ['old']);
  // 낡은 응답(저장소 교체): 잠금은 풀고 값은 쓰지 않는다.
  panel.bump();
  assert.equal(calls[1].opts.stale(), true, 'stale 판정이 패널 세대를 보지 않는다');
  calls[1].resolve({ stale: true });
  await p2;
  assert.equal(v._loading, false);
  assert.deepEqual([...v._list], ['old']);
  assert.equal(painted(), 0);
  // 성공은 목록을 채우고 붙어 있으면 칠한다.
  const p3 = ctx.gitLoadList(v, SPEC);
  assert.equal(calls[2].opts.stale(), false);
  assert.deepEqual({ ...calls[2].opts.echo }, { repo: '/r' });
  calls[2].resolve({ ok: true, data: { items: ['x', 'y'] } });
  await p3;
  assert.deepEqual([...v._list], ['x', 'y']);
  assert.equal(painted(), 1);
  // 실패는 사유를 두고, 떨어진 뷰는 칠하지 않는다.
  v.el = null;
  const p4 = ctx.gitLoadList(v, SPEC);
  calls[3].resolve({ ok: false });
  await p4;
  assert.equal(v._err, 'fail');
  assert.deepEqual([...v._list], ['x', 'y']);
  assert.equal(painted(), 1, '떨어진 뷰를 칠했다');
});

const VIEW_FILES = ['git/stash.js', 'git/branches.js', 'git/branches-tree.js', 'git/history.js',
  'git/history-refs.js', 'git/history-rows.js', 'git/history-detail.js', 'git/history-load.js',
  'git/console.js', 'git/commit.js', 'git/commit-draft.js', 'git/remote-list.js',
  'git/git-list-tab.js', 'git/worktrees.js', 'git/submodules.js'];
const VIEWS = ['GitStash', 'GitBranches', 'GitHistory', 'GitConsole', 'GitCommit', 'GitRemoteList', 'GitListTab'];

test('TC-FEV-5 일곱 뷰는 GitView 하위이고 옛 루트·가드 이름이 남지 않는다', () => {
  const ctx = setup(['git/view-util.js', ...VIEW_FILES], VIEWS);
  for (const n of VIEWS) {
    assert.ok(ctx[n].prototype instanceof ctx.GitView, n);
    assert.ok(ctx[n].prototype instanceof ctx.View, n);
  }
  for (const f of VIEW_FILES) {
    assert.doesNotMatch(read(f), /_el\b|_seq\b|_askSeq|panel\.token\(|panel\.isStale\(|gitLoadTicket/, f);
  }
  assert.doesNotMatch(read('git/history.js'), /h\._el\b/);
  for (const f of ['git/remote.js', 'git/remote-view.js', 'git/remote-opts.js', 'git/remote-list.js', 'git/remote-add.js']) {
    assert.equal([...read(f).matchAll(/^class\s/gm)].length, 1, f + ' 의 클래스가 하나가 아니다');
  }
});

test('TC-FEV-6 GitListTab 은 GitView 하위이고 행 그리기는 ListView 부품이 한다', () => {
  const ctx = setup(['git/view-util.js', 'git/git-list-tab.js', 'git/worktrees.js', 'git/submodules.js'],
    ['GitListTab', 'GitWorktrees', 'GitSubmodules'], { GIT_NOTE_CLOSE: 'x', GIT_TIP_NOTE_CLOSE: 'x' });
  for (const C of [ctx.GitListTab, ctx.GitWorktrees, ctx.GitSubmodules]) {
    assert.ok(C === ctx.GitListTab || C.prototype instanceof ctx.GitListTab, C.name);
    assert.ok(C.prototype instanceof ctx.GitView, C.name);
    assert.ok(!(C.prototype instanceof ctx.ListView), C.name + ' 가 아직 ListView 를 상속한다');
  }
  let built = 0;
  class T extends ctx.GitListTab {
    key(e) { return e.id }
    sigParts(e) { return [e.id, e.v, 0] }
    buildRow(e) { built++; const r = el('div'); r.v = e.v; return r }
  }
  const t = new T(fakePanel(), 'p');
  assert.ok(t.rows instanceof ctx.ListView);
  const e = { id: 'a', v: 'b' };
  assert.equal(t.rows.key(e), 'a');
  assert.equal(t.rows.sig(e), ['a', 'b', 0].join(ctx.RPT_SEP), '서명 바이트가 바뀌었다');
  const box = el('div');
  t.rows.reconcile(box, [e]);
  assert.equal(built, 1);
  assert.equal(box.children[0].v, 'b');
  // 부품의 수명은 탭의 수명에 쌓인다.
  t.dispose();
  assert.equal(t.rows.disposed, true);
  // 서명은 하위 훅 그대로다 — Worktrees 의 서명이 부품을 지나도 같은 바이트다.
  const w = new ctx.GitWorktrees(fakePanel());
  const wt = { path: '/w', branch: 'b', head: 'h' };
  assert.equal(w.rows.sig(wt), w.sigParts(wt).join(ctx.RPT_SEP));
});

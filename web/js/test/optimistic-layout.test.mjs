import assert from 'node:assert/strict';
import test from 'node:test';

import { load, plain } from './harness.mjs';

/**
 * 낙관적 레이아웃 보호 (`OPTIMISTIC_LAYOUT_SRS` §5 · V-OPL-3~8).
 *
 * 병합은 **순수 함수**다 — 창 배열 둘과 "원격이 아는 것" 집합 둘만 본다.
 * 그래서 브라우저 없이 잰다. 이 자리가 없으면 "닫은 창이 되살아나지 않는가"
 * 같은 불변식을 e2e 의 경주로 재게 되고, 그것이 이 저장소가 이미 겪은 낭비다.
 */

const h = () => load(['core/constants.js', 'core/helpers.js'], {
  expose: ['mergeUnseenLayout', 'WINDOW_TYPE_EDITOR'],
});

/** 탭 하나를 든 칸. */
const pane = (id, tabs, active) => ({
  type: 'pane', id, tabs, activeTab: active === undefined ? (tabs[0] && tabs[0].id) || null : active,
});
const tab = (id, name) => ({ id, name: name || id, type: 'git', gitView: name || id });
const win = (id, layout, extra) => Object.assign({ id, name: id, layout }, extra || {});
const seen = (windows, tabs) => ({ windows: new Set(windows || []), tabs: new Set(tabs || []) });

// ── 창 (FR-OPL-4) ──────────────────────────────────────────────────────────

test('V-OPL-4a: 원격이 본 적 없는 로컬 창은 채택이 지우지 않는다', () => {
  const c = h();
  const local = [win('w1', pane('p1', [tab('t1')]))];
  const remote = [];
  const n = c.mergeUnseenLayout(local, remote, seen([], []));
  assert.equal(n, 1);
  assert.equal(remote.length, 1);
  assert.equal(remote[0].id, 'w1');
});

test('V-OPL-4: 원격이 알았다가 없앤 창은 되살아나지 않는다', () => {
  const c = h();
  const local = [win('w1', pane('p1', [tab('t1')]))];
  const remote = [];
  const n = c.mergeUnseenLayout(local, remote, seen(['w1'], ['t1']));
  assert.equal(n, 0);
  assert.equal(remote.length, 0);
});

// ── 탭 (FR-OPL-5·6·7·8) ────────────────────────────────────────────────────

test('V-OPL-3a: 원격이 본 적 없는 로컬 탭은 대응 창에 되얹힌다', () => {
  const c = h();
  const local = [win('w1', pane('p1', [tab('t1'), tab('t2')], 't2'))];
  const remote = [win('w1', pane('p1', [tab('t1')]))];
  const n = c.mergeUnseenLayout(local, remote, seen(['w1'], ['t1']));
  assert.equal(n, 1);
  assert.deepEqual(plain(remote[0].layout.tabs).map((t) => t.id), ['t1', 't2']);
});

test('V-OPL-3: 원격이 알았다가 닫은 탭은 되살아나지 않는다', () => {
  const c = h();
  const local = [win('w1', pane('p1', [tab('t1'), tab('t2')]))];
  const remote = [win('w1', pane('p1', [tab('t1')]))];
  const n = c.mergeUnseenLayout(local, remote, seen(['w1'], ['t1', 't2']));
  assert.equal(n, 0);
  assert.deepEqual(plain(remote[0].layout.tabs).map((t) => t.id), ['t1']);
});

test('V-OPL-5: 분할된 창에서 되얹은 탭이 같은 칸으로 돌아간다', () => {
  const c = h();
  const split = (a, b) => ({ type: 'split', direction: 'row', children: [a, b] });
  const local = [win('w1', split(pane('p1', [tab('t1')]), pane('p2', [tab('t2'), tab('t3')])))];
  const remote = [win('w1', split(pane('p1', [tab('t1')]), pane('p2', [tab('t2')])))];
  const n = c.mergeUnseenLayout(local, remote, seen(['w1'], ['t1', 't2']));
  assert.equal(n, 1);
  assert.deepEqual(plain(remote[0].layout.children[0].tabs).map((t) => t.id), ['t1']);
  assert.deepEqual(plain(remote[0].layout.children[1].tabs).map((t) => t.id), ['t2', 't3']);
});

test('V-OPL-7: 로컬 활성 탭이 미관측 탭이면 채택 뒤에도 활성이다', () => {
  const c = h();
  const local = [win('w1', pane('p1', [tab('t1'), tab('t2')], 't2'))];
  const remote = [win('w1', pane('p1', [tab('t1')], 't1'))];
  c.mergeUnseenLayout(local, remote, seen(['w1'], ['t1']));
  assert.equal(remote[0].layout.activeTab, 't2');
});

test('V-OPL-8: 탭 순서가 로컬의 상대 순서를 유지한다', () => {
  const c = h();
  // 로컬:  a b c d   (b·d 가 미관측)
  // 원격:  x a c     (원격이 앞에 x 를 더했다)
  const local = [win('w1', pane('p1', [tab('a'), tab('b'), tab('c'), tab('d')]))];
  const remote = [win('w1', pane('p1', [tab('x'), tab('a'), tab('c')]))];
  const n = c.mergeUnseenLayout(local, remote, seen(['w1'], ['a', 'c', 'x']));
  assert.equal(n, 2);
  assert.deepEqual(plain(remote[0].layout.tabs).map((t) => t.id), ['x', 'a', 'b', 'c', 'd']);
});

// ── 창 신원 (FR-OPL-4(2) · D-OPL-4) ────────────────────────────────────────

test('V-OPL-6: 재조정이 Repo 창 id 를 바꿔도 탭이 산다', () => {
  const c = h();
  const ed = (id, root, layout) => win(id, layout, { type: c.WINDOW_TYPE_EDITOR, editor: { root } });
  const local = [ed('wOLD', '/r', pane('p1', [tab('t1'), tab('t2')]))];
  const remote = [ed('wNEW', '/r', pane('p9', [tab('t1')]))];
  const n = c.mergeUnseenLayout(local, remote, seen(['wOLD', 'wNEW'], ['t1']));
  assert.equal(n, 1);
  assert.equal(remote.length, 1, '창이 둘로 늘면 안 된다');
  assert.deepEqual(plain(remote[0].layout.tabs).map((t) => t.id), ['t1', 't2']);
});

test('V-OPL-6a: 칸이 없는 대응 창에는 로컬 칸을 그대로 옮긴다', () => {
  const c = h();
  const ed = (id, root, layout) => win(id, layout, { type: c.WINDOW_TYPE_EDITOR, editor: { root } });
  // `_edMkWindow` 는 `layout:null` 로 태어나고(FR-EDT-55) 첫 탭이 칸을 만든다.
  const local = [ed('w1', '/r', pane('p1', [tab('t1'), tab('t2')], 't2'))];
  const remote = [ed('w1', '/r', null)];
  const n = c.mergeUnseenLayout(local, remote, seen(['w1'], []));
  assert.equal(n, 1);
  assert.equal(remote[0].layout.id, 'p1');
  assert.deepEqual(plain(remote[0].layout.tabs).map((t) => t.id), ['t1', 't2']);
});

// ── 경계 ───────────────────────────────────────────────────────────────────

test('V-OPL-9: 병합할 것이 없으면 0 이고 원격을 건드리지 않는다', () => {
  const c = h();
  const local = [win('w1', pane('p1', [tab('t1')]))];
  const remote = [win('w1', pane('p1', [tab('t1')]))];
  const before = plain(remote);
  assert.equal(c.mergeUnseenLayout(local, remote, seen(['w1'], ['t1'])), 0);
  assert.deepEqual(plain(remote), before);
});

test('V-OPL-10: 탭이 다른 창으로 옮겨간 뒤에도 두 곳에 생기지 않는다', () => {
  const c = h();
  // 원격이 t2 를 w2 로 옮겼다. 로컬은 아직 w1 에 두고 있다. **`seen` 에 t2 를
  // 넣지 않는다** — 판정이 대응 창 안만 보면 여기서 t2 가 둘이 된다 (D-OPL-2).
  const local = [win('w1', pane('p1', [tab('t1'), tab('t2')])), win('w2', pane('p2', [tab('t3')]))];
  const remote = [win('w1', pane('p1', [tab('t1')])), win('w2', pane('p2', [tab('t3'), tab('t2')]))];
  const n = c.mergeUnseenLayout(local, remote, seen(['w1', 'w2'], ['t1', 't3']));
  assert.equal(n, 0);
  assert.deepEqual(plain(remote[0].layout.tabs).map((t) => t.id), ['t1']);
  assert.deepEqual(plain(remote[1].layout.tabs).map((t) => t.id), ['t3', 't2']);
});

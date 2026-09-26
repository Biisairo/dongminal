import assert from 'node:assert/strict';
import { test } from 'node:test';

import { load } from './harness.mjs';

/**
 * BROWSER_TAB_SRS TC-BRT-30·31·32 — 브라우저 탭을 놓을 자리 (FR-BRT-32·33).
 *
 * 순수 함수라 브라우저 없이 잰다. 창 경계를 넘지 않는 것(옆 창 슬롯으로 가지 않음)은
 * 이 함수가 창 하나의 트리만 받는다는 사실이 보증한다.
 */
function ctx() {
  return load(['core/layout-tree.js', 'core/browser-place.js'], {
    globals: { TAB_TYPE_TERMINAL: 'terminal', TAB_TYPE_EDITOR: 'editor', TAB_TYPE_RUN: 'run', TAB_TYPE_GIT: 'git',
      newUUID: () => 'u' },
  });
}
const pane = (id, tabs = ['t']) => ({ type: 'pane', id, tabs: tabs.map((t) => ({ id: id + t, type: 'terminal' })) });
const hsplit = (...children) => ({ type: 'split', direction: 'horizontal', children });
const vsplit = (...children) => ({ type: 'split', direction: 'vertical', children });
// vm 의 객체는 다른 realm 이다 — 모양으로 견준다.
const plain = (v) => JSON.parse(JSON.stringify(v));
const place = (c, ...a) => plain(c.browserPlace(...a));

test('split: 오른쪽 칸이 있으면 그 칸에 새 탭 (그 칸의 탭 종류 무관)', () => {
  const c = ctx();
  const right = pane('B');
  right.tabs = [{ id: 'e', type: 'editor' }];
  assert.deepEqual(place(c, hsplit(pane('A'), right), 'A', 'right'), { pane: 'B' });
});

test('split: 오른쪽 칸이 없으면 호출 칸을 오른쪽으로 나눈다', () => {
  const c = ctx();
  assert.deepEqual(place(c, pane('A'), 'A', 'right'), { split: { target: 'A', dir: 'right' } });
  // 호출 칸이 창의 오른쪽 끝이다 — 옆 창 슬롯으로 넘어가지 않고 나눈다.
  assert.deepEqual(place(c, hsplit(pane('A'), pane('B')), 'B', 'right'), { split: { target: 'B', dir: 'right' } });
});

test('split: 오른쪽이 위아래로 나뉘어 있으면 그 첫 칸이다 (firstPane)', () => {
  const c = ctx();
  assert.deepEqual(place(c, hsplit(pane('A'), vsplit(pane('B'), pane('C'))), 'A', 'right'), { pane: 'B' });
});

test('split: 가로 분할을 거슬러 올라간다 (paneNavigate 규칙)', () => {
  const c = ctx();
  // A 는 왼쪽 열의 아래 칸이다. 오른쪽은 부모의 부모에서 찾는다.
  const tree = hsplit(vsplit(pane('X'), pane('A')), pane('R'));
  assert.deepEqual(place(c, tree, 'A', 'right'), { pane: 'R' });
});

test('down: 아래 칸 또는 아래로 나눈다', () => {
  const c = ctx();
  assert.deepEqual(place(c, vsplit(pane('A'), pane('B')), 'A', 'down'), { pane: 'B' });
  assert.deepEqual(place(c, pane('A'), 'A', 'down'), { split: { target: 'A', dir: 'down' } });
});

test('tab(none): 호출 칸에 새 탭', () => {
  const c = ctx();
  assert.deepEqual(place(c, hsplit(pane('A'), pane('B')), 'A', 'none'), { pane: 'A' });
});

test('호출 칸이 없으면 주어진 대체 칸(포커스 칸)을 쓴다', () => {
  const c = ctx();
  assert.deepEqual(place(c, hsplit(pane('A'), pane('B')), null, 'right', 'B'), { split: { target: 'B', dir: 'right' } });
  assert.deepEqual(place(c, hsplit(pane('A'), pane('B')), 'gone', 'none', null), { pane: 'A' });
});

test('TC-BRT-32: 페이지가 연 탭은 연 탭의 칸, 바로 뒤다', () => {
  const c = ctx();
  const p = pane('A', ['1', '2', '3']);
  const tab = { id: 'N', type: 'browser' };
  c.browserInsertAfter(p, 'A1', tab);
  assert.deepEqual(plain(p.tabs.map((t) => t.id)), ['A1', 'N', 'A2', 'A3']);
  c.browserInsertAfter(p, 'nope', { id: 'M' });
  assert.equal(p.tabs[p.tabs.length - 1].id, 'M');
});

test('나눌 때 새 칸이 오른쪽/아래에 선다', () => {
  const c = ctx();
  const root = hsplit(pane('A'), pane('B'));
  const out = c.browserSplitInsert(root, 'B', 'right', { type: 'pane', id: 'N', tabs: [] });
  assert.equal(out.type, 'split');
  const b = out.children[1];
  assert.equal(b.type, 'split');
  assert.equal(b.direction, 'horizontal');
  assert.deepEqual(plain(b.children.map((x) => x.id)), ['B', 'N']);
  const out2 = c.browserSplitInsert(pane('A'), 'A', 'down', { type: 'pane', id: 'N', tabs: [] });
  assert.equal(out2.direction, 'vertical');
  assert.deepEqual(plain(out2.children.map((x) => x.id)), ['A', 'N']);
});

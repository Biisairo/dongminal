import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { load, plain } from './harness.mjs';

/**
 * ISSUE_AGENT_TREE_SRS 묶음 G·O — window 그룹의 불변식과 위치 해석 (TC-WGR-1 · TC-ORD-1).
 *
 * window 순서의 출처는 `ws.windows` 하나다(D-IAT-11). 같은 그룹의 window 는 늘 붙어
 * 있고, 그룹의 자리는 그 첫 window 의 자리다. 빈 그룹은 최상위 목록의 끝이다.
 */
const ctx = load(['core/window-order.js'], {
  expose: ['winOrderNormalize', 'winOrderItems', 'winOrderMoveWindow', 'winOrderMoveGroup', 'winOrderMoveInList'],
});

const W = (id, groupId, type) => Object.assign({ id }, groupId ? { groupId } : {}, type ? { type } : {});
const ids = (ws) => plain(ws.map((w) => w.id));
const items = (wins, groups) => plain(ctx.winOrderItems(wins, groups).map((it) =>
  it.kind === 'group' ? 'G:' + it.id + '[' + it.windows.join(',') + ']' : it.id));

test('TC-WGR-1 normalize: 흩어진 그룹 window 를 첫 자리 뒤로 모은다', () => {
  const wins = [W('a', 'g'), W('b'), W('c', 'g'), W('d')];
  const out = ctx.winOrderNormalize(wins, [{ id: 'g', name: 'G' }]);
  assert.deepEqual(ids(out), ['a', 'c', 'b', 'd']);
});

test('TC-WGR-1 normalize: 없는 그룹을 가리키는 groupId 는 지운다', () => {
  const out = ctx.winOrderNormalize([W('a', 'ghost'), W('b')], []);
  assert.equal(out[0].groupId, undefined);
});

test('normalize: 고칠 것이 없는 window 는 같은 객체다 — 화면이 쥔 참조가 낡지 않는다', () => {
  // 사이드바 행은 window 객체를 쥐고 이름을 고친다. 정규화가 객체를 새로 만들면 그
  // 고침이 워크스페이스에 닿지 않는다 (그룹이 있을 때 창 이름이 확정되지 않던 결함).
  const wins = [W('a', 'g'), W('b'), W('c', 'g')];
  const out = ctx.winOrderNormalize(wins, [{ id: 'g', name: 'G' }]);
  for (const w of wins) assert.ok(out.includes(w), w.id + ' 가 새 객체로 바뀌었다');
});

test('TC-WGR-1 normalize: git·editor window 는 그룹에 들지 않고 자리를 지킨다', () => {
  const wins = [W('a', 'g'), W('git', 'g', 'git'), W('b'), W('c', 'g')];
  const out = ctx.winOrderNormalize(wins, [{ id: 'g', name: 'G' }]);
  assert.deepEqual(ids(out), ['a', 'git', 'c', 'b']);
  assert.equal(out[1].groupId, undefined);
});

test('TC-WGR-1 items: 그룹은 덩어리 하나, 빈 그룹은 끝', () => {
  const wins = [W('a'), W('b', 'g1'), W('c', 'g1'), W('d')];
  const groups = [{ id: 'g0', name: 'empty' }, { id: 'g1', name: 'G1' }];
  assert.deepEqual(items(wins, groups), ['a', 'G:g1[b,c]', 'd', 'G:g0[]']);
});

test('TC-ORD-1 move-window: --index 는 1부터, 범위 밖은 오류', () => {
  const wins = [W('a'), W('b'), W('c')];
  let r = ctx.winOrderMoveWindow(wins, [], 'c', { index: 1 });
  assert.equal(r.ok, true);
  assert.deepEqual(ids(r.windows), ['c', 'a', 'b']);
  assert.deepEqual(plain(r.position), { container: 'top', index: 1, count: 3 });
  r = ctx.winOrderMoveWindow(wins, [], 'c', { index: 4 });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'out_of_range');
  r = ctx.winOrderMoveWindow(wins, [], 'c', { index: 0 });
  assert.equal(r.error, 'out_of_range');
});

test('TC-ORD-1 move-window: --prev/--next 는 한 칸, 끝에서는 오류', () => {
  const wins = [W('a'), W('b'), W('c')];
  let r = ctx.winOrderMoveWindow(wins, [], 'b', { next: true });
  assert.deepEqual(ids(r.windows), ['a', 'c', 'b']);
  r = ctx.winOrderMoveWindow(wins, [], 'a', { prev: true });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'at_edge');
});

test('TC-ORD-1 move-window: 최상위에서 그룹은 한 칸으로 센다', () => {
  const wins = [W('a'), W('b', 'g'), W('c', 'g'), W('d')];
  const groups = [{ id: 'g', name: 'G' }];
  const r = ctx.winOrderMoveWindow(wins, groups, 'd', { prev: true });
  assert.deepEqual(ids(r.windows), ['a', 'd', 'b', 'c']);
  assert.deepEqual(plain(r.position), { container: 'top', index: 2, count: 3 });
});

test('TC-ORD-1 move-window: 그룹 안의 window 는 그룹 안에서 움직인다', () => {
  const wins = [W('a'), W('b', 'g'), W('c', 'g'), W('d')];
  const r = ctx.winOrderMoveWindow(wins, [{ id: 'g', name: 'G' }], 'c', { index: 1 });
  assert.deepEqual(ids(r.windows), ['a', 'c', 'b', 'd']);
  assert.deepEqual(plain(r.position), { container: 'g', index: 1, count: 2 });
  const edge = ctx.winOrderMoveWindow(wins, [{ id: 'g', name: 'G' }], 'b', { prev: true });
  assert.equal(edge.error, 'at_edge');
});

test('TC-ORD-1 move-window: --before 기준이 그룹 안 window 면 그 그룹에 들어간다', () => {
  const wins = [W('a'), W('b', 'g'), W('c', 'g')];
  const r = ctx.winOrderMoveWindow(wins, [{ id: 'g', name: 'G' }], 'a', { after: 'b' });
  assert.deepEqual(ids(r.windows), ['b', 'a', 'c']);
  assert.equal(r.windows[1].groupId, 'g');
  assert.deepEqual(plain(r.position), { container: 'g', index: 2, count: 3 });
});

test('TC-ORD-1 move-window: --after 기준이 그룹이면 그룹 뒤 최상위에 놓인다', () => {
  const wins = [W('a'), W('b', 'g'), W('c', 'g'), W('d', 'g2')];
  const groups = [{ id: 'g', name: 'G' }, { id: 'g2', name: 'G2' }];
  const r = ctx.winOrderMoveWindow(wins, groups, 'd', { after: 'g' });
  assert.deepEqual(ids(r.windows), ['a', 'b', 'c', 'd']);
  assert.equal(r.windows[3].groupId, undefined);
  assert.deepEqual(plain(r.position), { container: 'top', index: 3, count: 3 });
});

test('TC-ORD-1 move-window: --to 그룹은 그 그룹의 끝, --to + --index 는 그 그룹 안 자리', () => {
  const wins = [W('a'), W('b', 'g'), W('c', 'g')];
  const groups = [{ id: 'g', name: 'G' }];
  let r = ctx.winOrderMoveWindow(wins, groups, 'a', { to: 'g' });
  assert.deepEqual(ids(r.windows), ['b', 'c', 'a']);
  assert.deepEqual(plain(r.position), { container: 'g', index: 3, count: 3 });
  r = ctx.winOrderMoveWindow(wins, groups, 'a', { to: 'g', index: 1 });
  assert.deepEqual(ids(r.windows), ['a', 'b', 'c']);
  assert.equal(r.windows[0].groupId, 'g');
});

test('TC-ORD-1 move-window: 빈 그룹으로 --to 하면 그 window 자리가 그룹 자리', () => {
  const wins = [W('a'), W('b')];
  const groups = [{ id: 'g', name: 'G' }];
  const r = ctx.winOrderMoveWindow(wins, groups, 'a', { to: 'g' });
  assert.deepEqual(items(r.windows, groups), ['G:g[a]', 'b']);
});

test('TC-ORD-1 move-window: --to top 은 그룹에서 빼고 최상위 끝', () => {
  const wins = [W('b', 'g'), W('c', 'g'), W('d')];
  const r = ctx.winOrderMoveWindow(wins, [{ id: 'g', name: 'G' }], 'b', { to: 'top' });
  assert.deepEqual(ids(r.windows), ['c', 'd', 'b']);
  assert.equal(r.windows[2].groupId, undefined);
});

test('TC-ORD-1 move-window: 제자리 이동은 성공, 순서 그대로', () => {
  const wins = [W('a'), W('b')];
  const r = ctx.winOrderMoveWindow(wins, [], 'a', { index: 1 });
  assert.equal(r.ok, true);
  assert.deepEqual(ids(r.windows), ['a', 'b']);
});

test('TC-ORD-1 move-window: 위치 지정이 없거나 둘이면 bad_spec, 없는 id 는 not_found', () => {
  const wins = [W('a'), W('b')];
  assert.equal(ctx.winOrderMoveWindow(wins, [], 'a', {}).error, 'bad_spec');
  assert.equal(ctx.winOrderMoveWindow(wins, [], 'a', { index: 1, next: true }).error, 'bad_spec');
  assert.equal(ctx.winOrderMoveWindow(wins, [], 'zz', { index: 1 }).error, 'not_found');
  assert.equal(ctx.winOrderMoveWindow(wins, [], 'a', { before: 'zz' }).error, 'not_found');
  assert.equal(ctx.winOrderMoveWindow(wins, [], 'a', { to: 'top', next: true }).error, 'bad_spec');
});

test('TC-ORD-1 move-window: 원본 배열을 고치지 않는다', () => {
  const wins = [W('a'), W('b', 'g')];
  ctx.winOrderMoveWindow(wins, [{ id: 'g', name: 'G' }], 'a', { to: 'g' });
  assert.equal(wins[0].groupId, undefined);
  assert.deepEqual(ids(wins), ['a', 'b']);
});

test('TC-ORD-1 move-group: 그룹은 통째로 움직인다', () => {
  const wins = [W('a'), W('b', 'g'), W('c', 'g'), W('d')];
  const groups = [{ id: 'g', name: 'G' }];
  let r = ctx.winOrderMoveGroup(wins, groups, 'g', { index: 1 });
  assert.deepEqual(ids(r.windows), ['b', 'c', 'a', 'd']);
  assert.deepEqual(plain(r.position), { container: 'top', index: 1, count: 3 });
  r = ctx.winOrderMoveGroup(wins, groups, 'g', { after: 'd' });
  assert.deepEqual(ids(r.windows), ['a', 'd', 'b', 'c']);
  r = ctx.winOrderMoveGroup(wins, groups, 'g', { next: true });
  assert.deepEqual(ids(r.windows), ['a', 'd', 'b', 'c']);
});

test('TC-ORD-1 move-group: 기준이 다른 그룹 안 window 면 그 그룹을 기준으로 삼는다', () => {
  const wins = [W('a', 'g1'), W('b', 'g1'), W('c', 'g2')];
  const groups = [{ id: 'g1', name: '1' }, { id: 'g2', name: '2' }];
  const r = ctx.winOrderMoveGroup(wins, groups, 'g2', { before: 'b' });
  assert.deepEqual(ids(r.windows), ['c', 'a', 'b']);
});

test('TC-ORD-1 move-group: 빈 그룹은 옮길 수 없다', () => {
  const r = ctx.winOrderMoveGroup([W('a')], [{ id: 'g', name: 'G' }], 'g', { index: 1 });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'empty_group');
});

test('TC-ORD-1 move-in-list: 탭 같은 평면 목록의 위치 해석', () => {
  const tabs = ['t1', 't2', 't3'];
  let r = ctx.winOrderMoveInList(tabs, 't1', { after: 't3' });
  assert.deepEqual(plain(r.list), ['t2', 't3', 't1']);
  assert.deepEqual(plain(r.position), { index: 3, count: 3 });
  r = ctx.winOrderMoveInList(tabs, 't3', { prev: true });
  assert.deepEqual(plain(r.list), ['t1', 't3', 't2']);
  r = ctx.winOrderMoveInList(tabs, 't3', { next: true });
  assert.equal(r.error, 'at_edge');
  r = ctx.winOrderMoveInList(tabs, 't2', { index: 9 });
  assert.equal(r.error, 'out_of_range');
});

/**
 * REFACTOR PROD2 §7: window 순서 규칙의 골든. Go `windowPositions`(dmctl_listworkspace.go)가
 * 같은 표본을 읽는다. 위치는 Go 와 같은 방식으로 센다 — 빈 그룹은 칸이 아니다.
 */
const VECTORS = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)),
  '../../../internal/helper/runtimebin/testdata/window_order_vectors.json'), 'utf8'));

test('골든: window 위치가 Go windowPositions 와 같다', () => {
  assert.ok(VECTORS.cases.length > 0);
  for (const c of VECTORS.cases) {
    const its = ctx.winOrderItems(c.windows, c.groups).filter((it) => it.kind === 'window' || it.windows.length);
    const got = {};
    its.forEach((it, i) => {
      if (it.kind === 'window') got[it.id] = ['top', i + 1, its.length];
      else it.windows.forEach((id, j) => { got[id] = [it.id, j + 1, it.windows.length] });
    });
    assert.deepEqual(plain(got), c.want, c.name);
  }
});

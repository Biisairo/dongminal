import assert from 'node:assert/strict';
import { test } from 'node:test';

import { load } from './harness.mjs';

/**
 * PANEL_DOCK_SRS — 패널 좌우 도킹의 순수 계산 (NFR-PDK-1).
 */
const ctx = load(['core/panel-dock.js'], {
  expose: ['dockDefault', 'dockNormalize', 'dockMove', 'dockSideOf', 'dockOrders', 'dockDropTarget',
    'dockIndicatorX', 'dockEqual', 'repoSideNormalize', 'repoSideDropTarget', 'REPO_SIDE_DOCK_DEFAULT'],
});
const plain = (v) => JSON.parse(JSON.stringify(v));

test('FR-PDK-2: 기본값은 지금 화면과 같다', () => {
  assert.deepEqual(plain(ctx.dockDefault()), { left: ['sidebar'], right: ['activity'] });
});

test('FR-PDK-2: 기본값은 매번 새 객체다', () => {
  const a = ctx.dockDefault();
  a.left.push('x');
  assert.deepEqual(plain(ctx.dockDefault()), { left: ['sidebar'], right: ['activity'] });
});

test('FR-PDK-1: 올바른 배치는 그대로 받는다', () => {
  for (const s of [
    { left: ['sidebar', 'activity'], right: [] },
    { left: [], right: ['activity', 'sidebar'] },
    { left: ['activity'], right: ['sidebar'] },
  ]) assert.deepEqual(plain(ctx.dockNormalize(s)), s);
});

test('FR-PDK-4: 잘못된 값은 기본값이 된다', () => {
  const def = { left: ['sidebar'], right: ['activity'] };
  for (const bad of [
    null, undefined, '', 'not json', 42, [], {},
    { left: ['sidebar'] },
    { left: ['sidebar', 'sidebar'], right: [] },
    { left: ['sidebar'], right: [] },
    { left: ['sidebar', 'activity', 'x'], right: [] },
    { left: 'sidebar', right: ['activity'] },
    { left: ['sidebar'], right: ['activity', 'activity'] },
  ]) assert.deepEqual(plain(ctx.dockNormalize(bad)), def, JSON.stringify(bad));
});

test('FR-PDK-5: Repo 사이드 위치는 left/right 이고 나머지는 left', () => {
  assert.equal(ctx.REPO_SIDE_DOCK_DEFAULT, 'left');
  assert.equal(ctx.repoSideNormalize('right'), 'right');
  assert.equal(ctx.repoSideNormalize('left'), 'left');
  for (const bad of [null, undefined, '', 'top', 1]) assert.equal(ctx.repoSideNormalize(bad), 'left');
});

test('dockSideOf: 패널의 쪽을 낸다', () => {
  const s = { left: ['activity'], right: ['sidebar'] };
  assert.equal(ctx.dockSideOf(s, 'activity'), 'left');
  assert.equal(ctx.dockSideOf(s, 'sidebar'), 'right');
});

test('dockMove: 옮긴 결과는 새 객체이고 원본은 그대로다', () => {
  const s = ctx.dockDefault();
  const n = ctx.dockMove(s, 'sidebar', 'right', 0);
  assert.deepEqual(plain(n), { left: [], right: ['sidebar', 'activity'] });
  assert.deepEqual(plain(s), { left: ['sidebar'], right: ['activity'] });
});

test('dockMove: 안쪽 자리와 범위 밖 index 는 끝으로 붙는다', () => {
  const s = ctx.dockDefault();
  assert.deepEqual(plain(ctx.dockMove(s, 'sidebar', 'right', 1)), { left: [], right: ['activity', 'sidebar'] });
  assert.deepEqual(plain(ctx.dockMove(s, 'sidebar', 'right', 9)), { left: [], right: ['activity', 'sidebar'] });
  assert.deepEqual(plain(ctx.dockMove(s, 'activity', 'left', -3)), { left: ['activity', 'sidebar'], right: [] });
});

test('dockMove: 모르는 패널·쪽은 원래 배치를 낸다', () => {
  const s = ctx.dockDefault();
  assert.deepEqual(plain(ctx.dockMove(s, 'x', 'left', 0)), plain(s));
  assert.deepEqual(plain(ctx.dockMove(s, 'sidebar', 'top', 0)), plain(s));
});

test('dockEqual', () => {
  assert.equal(ctx.dockEqual(ctx.dockDefault(), ctx.dockDefault()), true);
  assert.equal(ctx.dockEqual(ctx.dockDefault(), { left: ['activity'], right: ['sidebar'] }), false);
  assert.equal(ctx.dockEqual({ left: ['sidebar', 'activity'], right: [] }, { left: ['activity', 'sidebar'], right: [] }), false);
});

/** order 들을 화면 순서(왼→오) 이름 배열로 바꾼다. content 는 0 이다. */
function screen(orders) {
  const items = [['content', 0]];
  for (const [p, o] of Object.entries(orders)) items.push([p, o.panel], [p + '|h', o.handle]);
  return items.sort((a, b) => a[1] - b[1]).map((x) => x[0]);
}

test('FR-PDK-10·11: 기본 배치의 화면 순서', () => {
  assert.deepEqual(screen(ctx.dockOrders(ctx.dockDefault())),
    ['sidebar', 'sidebar|h', 'content', 'activity|h', 'activity']);
});

test('FR-PDK-10·11: 모든 배치의 화면 순서', () => {
  const cases = [
    [{ left: ['activity'], right: ['sidebar'] }, ['activity', 'activity|h', 'content', 'sidebar|h', 'sidebar']],
    [{ left: ['sidebar', 'activity'], right: [] }, ['sidebar', 'sidebar|h', 'activity', 'activity|h', 'content']],
    [{ left: ['activity', 'sidebar'], right: [] }, ['activity', 'activity|h', 'sidebar', 'sidebar|h', 'content']],
    [{ left: [], right: ['sidebar', 'activity'] }, ['content', 'activity|h', 'activity', 'sidebar|h', 'sidebar']],
    [{ left: [], right: ['activity', 'sidebar'] }, ['content', 'sidebar|h', 'sidebar', 'activity|h', 'activity']],
  ];
  for (const [s, want] of cases) assert.deepEqual(screen(ctx.dockOrders(s)), want, JSON.stringify(s));
});

// 화면: #app 0..1000. 다른 패널의 자리(rect)는 left·width 다.
const APP = { left: 0, width: 1000 };

test('FR-PDK-31: 가로 중앙 왼쪽은 left, 중앙부터 right', () => {
  const s = ctx.dockDefault();
  const rects = { sidebar: { left: 0, width: 200 }, activity: { left: 740, width: 260 } };
  assert.deepEqual(plain(ctx.dockDropTarget(s, 'sidebar', 499, APP, rects)), { side: 'left', index: 0 });
  assert.deepEqual(plain(ctx.dockDropTarget(s, 'sidebar', 500, APP, rects)).side, 'right');
});

test('FR-PDK-32: 다른 패널 중앙보다 가장자리 쪽이면 바깥, 아니면 안쪽 (오른쪽)', () => {
  const s = ctx.dockDefault();
  const rects = { sidebar: { left: 0, width: 200 }, activity: { left: 740, width: 260 } };
  // activity 중앙은 870 이다.
  assert.deepEqual(plain(ctx.dockDropTarget(s, 'sidebar', 900, APP, rects)), { side: 'right', index: 0 });
  assert.deepEqual(plain(ctx.dockDropTarget(s, 'sidebar', 870, APP, rects)), { side: 'right', index: 1 });
  assert.deepEqual(plain(ctx.dockDropTarget(s, 'sidebar', 600, APP, rects)), { side: 'right', index: 1 });
});

test('FR-PDK-32: 다른 패널 중앙보다 가장자리 쪽이면 바깥, 아니면 안쪽 (왼쪽)', () => {
  const s = ctx.dockDefault();
  const rects = { sidebar: { left: 0, width: 200 }, activity: { left: 740, width: 260 } };
  // sidebar 중앙은 100 이다.
  assert.deepEqual(plain(ctx.dockDropTarget(s, 'activity', 50, APP, rects)), { side: 'left', index: 0 });
  assert.deepEqual(plain(ctx.dockDropTarget(s, 'activity', 100, APP, rects)), { side: 'left', index: 1 });
});

test('FR-PDK-32: 자기 자신은 순서 계산에서 빠진다', () => {
  const s = { left: ['sidebar', 'activity'], right: [] };
  const rects = { sidebar: { left: 0, width: 200 }, activity: { left: 203, width: 260 } };
  assert.deepEqual(plain(ctx.dockDropTarget(s, 'activity', 50, APP, rects)), { side: 'left', index: 0 });
  assert.deepEqual(plain(ctx.dockDropTarget(s, 'activity', 300, APP, rects)), { side: 'left', index: 1 });
});

test('FR-PDK-32: 숨은 패널(폭 0)은 순서를 정하지 않는다', () => {
  const s = ctx.dockDefault();
  const rects = { sidebar: { left: 0, width: 200 }, activity: { left: 1000, width: 0 } };
  assert.deepEqual(plain(ctx.dockDropTarget(s, 'sidebar', 990, APP, rects)), { side: 'right', index: 1 });
});

test('FR-PDK-33: 막대는 들어갈 경계에 선다', () => {
  const rects = { sidebar: { left: 0, width: 200 }, activity: { left: 740, width: 260 } };
  const s = ctx.dockDefault();
  assert.equal(ctx.dockIndicatorX(s, 'sidebar', { side: 'right', index: 0 }, APP, rects), 1000);
  assert.equal(ctx.dockIndicatorX(s, 'sidebar', { side: 'right', index: 1 }, APP, rects), 740);
  assert.equal(ctx.dockIndicatorX(s, 'activity', { side: 'left', index: 0 }, APP, rects), 0);
  assert.equal(ctx.dockIndicatorX(s, 'activity', { side: 'left', index: 1 }, APP, rects), 200);
  assert.equal(ctx.dockIndicatorX(s, 'sidebar', { side: 'left', index: 0 }, APP, rects), 0);
});

test('FR-PDK-34: Repo 사이드는 창 가로 중앙으로 좌우를 가른다', () => {
  const r = { left: 100, width: 400 };
  assert.equal(ctx.repoSideDropTarget(299, r), 'left');
  assert.equal(ctx.repoSideDropTarget(300, r), 'right');
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { load } from './harness.mjs';

/**
 * ISSUE_TREE_OPS_SRS TC-ITC-4 (FR-ITC-10): 이슈 트리 다이어그램의 배치.
 * 노드 목록(깊이 우선)만으로 정해지고, 잎은 가로 칸을 하나씩 받고, 부모는 자식의 가운데에 선다.
 */
const ctx = load(['ui/runs-panel.js', 'ui/run-tree.js'], {
  globals: { t: (k) => k, panesOf: () => [] },
  expose: ['runTreeLayout', 'runTreeClip', 'RUN_TREE_NODE_W', 'RUN_TREE_NODE_H'],
});
const { runTreeLayout, runTreeClip, RUN_TREE_NODE_W: W, RUN_TREE_NODE_H: H } = ctx;

const n = (role, parent = '') => ({ id: role, role, parent });

test('빈 목록은 노드도 선도 없다', () => {
  const l = runTreeLayout([]);
  assert.equal(l.pos.length, 0);
  assert.equal(l.edges.length, 0);
});

test('루트 하나는 깊이 0 이고 그림 안에 든다', () => {
  const l = runTreeLayout([n('a')]);
  assert.equal(l.pos[0].depth, 0);
  assert.ok(l.pos[0].x - W / 2 >= 0 && l.pos[0].x + W / 2 <= l.w);
  assert.ok(l.pos[0].y >= 0 && l.pos[0].y + H <= l.h);
});

test('사슬은 깊이마다 한 줄 아래로 내려가고 같은 x 에 선다', () => {
  const l = runTreeLayout([n('a'), n('a›b', 'a'), n('a›b›c', 'a›b')]);
  assert.deepEqual([...l.pos.map((p) => p.depth)], [0, 1, 2]);
  assert.ok(l.pos[0].y < l.pos[1].y && l.pos[1].y < l.pos[2].y);
  assert.ok(l.pos[1].y - l.pos[0].y >= H);
  assert.equal(l.pos[0].x, l.pos[1].x);
  assert.equal(l.pos[1].x, l.pos[2].x);
  assert.deepEqual(JSON.parse(JSON.stringify(l.edges)), [[0, 1], [1, 2]]);
});

test('부모는 첫 자식과 끝 자식의 가운데에 선다', () => {
  const l = runTreeLayout([n('r'), n('r›a', 'r'), n('r›a›x', 'r›a'), n('r›a›y', 'r›a'), n('r›b', 'r')]);
  const [r, a, x, y, b] = l.pos;
  assert.equal(a.x, (x.x + y.x) / 2);
  assert.equal(r.x, (a.x + b.x) / 2);
  assert.deepEqual(JSON.parse(JSON.stringify(l.edges)), [[0, 1], [1, 2], [1, 3], [0, 4]]);
});

test('같은 줄의 상자는 겹치지 않고 깊이 우선 순서대로 왼쪽부터 선다', () => {
  const l = runTreeLayout([n('r'), n('r›a', 'r'), n('r›a›x', 'r›a'), n('r›a›y', 'r›a'), n('r›b', 'r')]);
  const rows = new Map();
  l.pos.forEach((p) => rows.set(p.depth, [...(rows.get(p.depth) || []), p.x]));
  for (const xs of rows.values()) {
    for (let i = 1; i < xs.length; i++) assert.ok(xs[i] - xs[i - 1] >= W, JSON.stringify(xs));
  }
});

test('부모가 목록에 없는 노드는 루트로 선다', () => {
  const l = runTreeLayout([n('a'), n('z›q', 'z')]);
  assert.equal(l.pos[1].depth, 0);
  assert.equal(l.edges.length, 0);
  assert.ok(Math.abs(l.pos[1].x - l.pos[0].x) >= W);
});

test('같은 입력은 같은 배치다', () => {
  const nodes = [n('r'), n('r›a', 'r'), n('r›b', 'r')];
  assert.deepEqual(JSON.parse(JSON.stringify(runTreeLayout(nodes))), JSON.parse(JSON.stringify(runTreeLayout(nodes))));
});

test('짧은 제목은 그대로, 긴 제목은 줄여 끝에 … 를 붙인다', () => {
  assert.equal(runTreeClip('루트 이슈', 20), '루트 이슈');
  assert.equal(runTreeClip('', 20), '');
  const long = runTreeClip('아주 긴 한국어 제목이 상자를 넘어선다', 12);
  assert.ok(long.endsWith('…'), long);
  // 한글은 두 칸으로 센다 — 12칸이면 글자 수는 그보다 적다.
  assert.ok(long.length <= 12, long);
  assert.equal(runTreeClip('abcdefghijklmnop', 8), 'abcdefg…');
});

/**
 * RUN_INACTIVE_NODE_SRS — 비활성 노드(끝남·잃음)의 판정과 크기.
 */
const ix = load(['ui/runs-panel.js', 'ui/run-tree.js'], {
  globals: { t: (k) => k, panesOf: () => [] },
  expose: ['runNodeKind', 'runCardsShown', 'runTreeLayout', 'runTreeEdgePath', 'RUN_TREE_NODE_H', 'RUN_TREE_NODE_H_ENDED',
    'RUN_TREE_NODE_W', 'RUN_TREE_NODE_W_ENDED'],
});

test('TC-RIN-1·2: 상태마다 노드의 종류가 갈린다', () => {
  for (const s of ['done', 'failed', 'released']) assert.equal(ix.runNodeKind(s), 'ended', s);
  assert.equal(ix.runNodeKind('lost'), 'lost');
  for (const s of ['working', 'waiting', 'ready', 'starting', 'waiting-children', '', undefined]) {
    assert.equal(ix.runNodeKind(s), 'active', String(s));
  }
});

test('TC-RIN-1·4: 끝난 노드는 작은 상자이고, 선은 상자의 실제 아래 끝에서 나간다', () => {
  assert.ok(ix.RUN_TREE_NODE_H_ENDED < ix.RUN_TREE_NODE_H);
  const l = ix.runTreeLayout([
    { id: 'a', role: 'a', parent: '', state: 'done' },
    { id: 'b', role: 'a›b', parent: 'a', state: 'working' },
  ]);
  assert.equal(l.pos[0].h, ix.RUN_TREE_NODE_H_ENDED);
  assert.equal(l.pos[1].h, ix.RUN_TREE_NODE_H);
  const d = ix.runTreeEdgePath(l.pos[0], l.pos[1]);
  assert.ok(d.startsWith(`M${l.pos[0].x},${l.pos[0].y + ix.RUN_TREE_NODE_H_ENDED} `), d);
});

/** 같은 줄 상자들의 [왼쪽, 오른쪽] 구간이 서로 겹치지 않는지 본다. */
function assertNoOverlap(l) {
  const rows = new Map();
  l.pos.forEach((p) => rows.set(p.depth, [...(rows.get(p.depth) || []), [p.x - p.w / 2, p.x + p.w / 2]]));
  for (const spans of rows.values()) {
    spans.sort((a, b) => a[0] - b[0]);
    for (let i = 1; i < spans.length; i++) assert.ok(spans[i][0] >= spans[i - 1][1], JSON.stringify(spans));
  }
  for (const p of l.pos) assert.ok(p.x - p.w / 2 >= 0 && p.x + p.w / 2 <= l.w, JSON.stringify(p));
}

test('TC-RIN-5: 끝난 노드는 폭도 좁고, 가로 칸을 그 폭만큼만 받는다', () => {
  const W = ix.RUN_TREE_NODE_W, WE = ix.RUN_TREE_NODE_W_ENDED;
  assert.ok(WE < W);
  const s = (role, parent, state) => ({ id: role, role, parent, state });
  const nodes = [s('r', '', 'working'), s('r›a', 'r', 'done'), s('r›b', 'r', 'done'), s('r›c', 'r', 'working')];
  const l = ix.runTreeLayout(nodes);
  assert.deepEqual([...l.pos.map((p) => p.w)], [W, WE, WE, W]);
  assertNoOverlap(l);
  const all = ix.runTreeLayout(nodes.map((n) => ({ ...n, state: 'working' })));
  assert.ok(l.w < all.w, `${l.w} < ${all.w}`);
});

test('TC-RIN-5: 부모가 자식들보다 넓으면 가지를 밀어 같은 줄이 겹치지 않는다', () => {
  const s = (role, parent, state) => ({ id: role, role, parent, state });
  // 보통 폭 부모 아래 끝난 자식 하나, 그 옆에 보통 폭 형제 — 부모 상자가 형제와 겹치기 쉽다.
  const l = ix.runTreeLayout([
    s('r', '', 'working'), s('r›a', 'r', 'working'), s('r›a›x', 'r›a', 'done'),
    s('r›b', 'r', 'working'), s('r›b›y', 'r›b', 'working'),
  ]);
  assertNoOverlap(l);
  // 부모는 자식 하나의 가운데에 그대로 선다.
  assert.equal(l.pos[1].x, l.pos[2].x);
});

test('TC-RIN-3: 카드 목록은 끝난 멤버를 빼고 잃은 멤버는 남긴다', () => {
  const ms = ['working', 'done', 'lost', 'failed', 'released', 'ready'].map((state, i) => ({ id: String(i), state }));
  assert.deepEqual([...ix.runCardsShown(ms).map((m) => m.state)], ['working', 'lost', 'ready']);
});

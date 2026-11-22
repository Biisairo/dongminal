import assert from 'node:assert/strict';
import { test } from 'node:test';

import { BASE, load } from './harness.mjs';

/**
 * EDGE_MESH_SRS FR-EGM-50~56 — Edges 의 망 그림·간선 줄 표시·받은 초대의 화면 쪽 규칙 (TC-EGM-14).
 *
 *   FR-EGM-51 나는 가운데에 고정되고, 같은 망은 늘 같은 그림이다. 노드는 그림 안에 있다.
 *   FR-EGM-52 간선 상대의 알림 대기·옛 판을 노드 아래에 적는다.
 *   FR-EGM-53 망 이웃(온라인·간선 아님)은 초대 보내기, 간선 상대는 알리기다. 나와 끊긴 이웃은 할 일이 없다.
 *   FR-EGM-55 받은 초대의 맺기·거절은 id 로 보낸다. invited 방송은 알림을 띄운다.
 *   FR-EGM-56 개인채팅 상대 노드가 온라인이고 간선이 아니면 초대를 보낼 수 있다.
 */
function setup() {
  const shown = [];
  const posts = [];
  let next = { ok: true, status: 200, data: { edges: [] } };
  let postResult = { ok: true, status: 200, data: {} };
  const ctx = load([...BASE, 'core/state-registry.js', 'core/settings-live.js', 'core/edges-controller.js', 'core/edges-mesh.js'], {
    expose: ['meshLayout', 'meshNodeAction', 'meshNodeMarks', 'meshDirectPeer', 'MESH_W', 'MESH_H', 'EdgesController', 'SettingsLive'],
    globals: {
      App: function App() {},
      t: (k, p) => k + (p ? JSON.stringify(p) : ''),
      apiGet: async () => next,
      apiPost: async (path, body) => { posts.push([path, body]); return postResult },
      statusRun: async (_el, _opts, fn) => fn(),
      document: { getElementById: () => null },
      profileName: '',
      Toast: { show(text, kind, ms) { shown.push({ text, kind, ms }); return {} } },
    },
  });
  const app = new ctx.App();
  // REFACTOR3_FE_APPCTL_SRS 9a: 간선 읽기·망 그림·초대는 `EdgesController` 다.
  app.edges = new ctx.EdgesController(app);
  // 섹션은 탭 이름으로 찾는다 (REFACTOR3_FE_DELEG_SRS D-DLG-4). 이 시험은 간선 섹션만 세운다.
  const sections = { edges: { _edgesPaint() {} } };
  app.settings = { live: new ctx.SettingsLive(app), apply: {}, section: (t) => sections[t] || null };
  app.settings.live._liveOpen = () => false;
  app._restoreBegin = () => 1;
  app._restoreLive = () => true;
  app._restoreEnd = () => {};
  app.settings.apply._applyPageTitle = () => {};
  return { ctx, app, shown, posts, setNext: (v) => { next = v }, setPost: (v) => { postResult = v } };
}

const fp = (c) => c.repeat(64);
const ME = fp('0'), A = fp('a'), B = fp('b'), C = fp('c');

const NODES = [
  { fp: ME, name: 'me', tag: '0001', online: true, self: true, edge: false },
  { fp: A, name: 'a', tag: '0002', online: true, self: false, edge: true },
  { fp: B, name: 'b', tag: '0003', online: true, self: false, edge: false },
  { fp: C, name: 'c', tag: '0004', online: false, self: false, edge: false },
];
const LINKS = [[ME, A], [A, B], [B, C]];

test('나는 가운데에 고정되고 같은 망은 같은 그림이다 (FR-EGM-51)', () => {
  const { ctx } = setup();
  const p1 = ctx.meshLayout(NODES, LINKS, ctx.MESH_W, ctx.MESH_H);
  const p2 = ctx.meshLayout([...NODES].reverse(), LINKS, ctx.MESH_W, ctx.MESH_H);
  assert.equal(JSON.stringify(p1.get(ME)), JSON.stringify({ x: ctx.MESH_W / 2, y: ctx.MESH_H / 2 }));
  for (const n of NODES) assert.equal(JSON.stringify(p1.get(n.fp)), JSON.stringify(p2.get(n.fp)), '입력 순서가 그림을 바꿨다');
  for (const n of NODES) {
    const { x, y } = p1.get(n.fp);
    assert.ok(x >= 0 && x <= ctx.MESH_W && y >= 0 && y <= ctx.MESH_H, '그림 밖의 노드');
  }
  const [a, b] = [p1.get(A), p1.get(B)];
  assert.ok(Math.hypot(a.x - b.x, a.y - b.y) > 20, '노드가 겹쳤다');
});

test('노드 하나·둘인 망도 그린다', () => {
  const { ctx } = setup();
  assert.equal(JSON.stringify(ctx.meshLayout([NODES[0]], [], 100, 80).get(ME)), JSON.stringify({ x: 50, y: 40 }));
  const two = ctx.meshLayout(NODES.slice(0, 2), [[ME, A]], 100, 80);
  assert.notEqual(JSON.stringify(two.get(A)), JSON.stringify(two.get(ME)));
});

test('노드별 할 일 (FR-EGM-53)', () => {
  const { ctx } = setup();
  assert.equal(ctx.meshNodeAction(NODES[0]), '');
  assert.equal(ctx.meshNodeAction(NODES[1]), 'notify');
  assert.equal(ctx.meshNodeAction(NODES[2]), 'invite');
  assert.equal(ctx.meshNodeAction(NODES[3]), '', '끊긴 이웃에게는 초대를 보낼 수 없다');
  assert.equal(ctx.meshNodeAction({ ...NODES[1], online: false }), 'notify', '끊긴 간선 상대에게도 알릴 수 있다');
});

test('간선 상대의 알림 대기·옛 판 표시 (FR-EGM-52·54)', () => {
  const { ctx } = setup();
  assert.equal(JSON.stringify(ctx.meshNodeMarks({ pending: true, outdated: true })), JSON.stringify(['edge.pending', 'edge.outdated']));
  assert.equal(ctx.meshNodeMarks({ pending: false }).length, 0);
  assert.equal(ctx.meshNodeMarks(undefined).length, 0);
});

test('알리기는 지문으로 보내고 다시 읽는다 (FR-EGM-54)', async () => {
  const { app, posts, setPost } = setup();
  let reads = 0;
  app.edges._edgesRestore = async () => { reads++ };
  setPost({ ok: true, status: 200, data: { notified: true } });
  await app.edges._egNotify({ fp: A, name: 'a', tag: '0002' });
  assert.equal(JSON.stringify(posts), JSON.stringify([['/api/edges/notify', { fp: A }]]));
  assert.equal(reads, 1);
});

test('초대 보내기·맺기·거절 (FR-EGM-53·55)', async () => {
  const { app, posts } = setup();
  app.edges._edgesRestore = async () => {};
  await app.edges._egInviteSend({ fp: B, name: 'b', tag: '0003' });
  await app.edges._egInviteAccept({ id: 'i1', from: B, name: 'b', tag: '0003' });
  await app.edges._egInviteReject({ id: 'i2', from: C, name: 'c', tag: '0004' });
  assert.equal(JSON.stringify(posts), JSON.stringify([
    ['/api/edges/invite/send', { to: B }],
    ['/api/edges/invite/accept', { id: 'i1' }],
    ['/api/edges/invite/reject', { id: 'i2' }],
  ]));
});

test('invited 방송은 보낸 노드의 핸들로 알림을 띄운다 (FR-EGM-55)', async () => {
  const { app, shown } = setup();
  app.settings.section('edges')._edgesPaint = () => {};
  await app.edges._onEdgesChanged({ invited: { fp: B, name: 'b', tag: '0003' } });
  assert.equal(shown.length, 1);
  assert.match(shown[0].text, /^edge\.invited_notice/);
  assert.match(shown[0].text, /"name":"b#0003"/);
});

test('개인채팅 상대 노드에 초대를 보낼 수 있는가 (FR-EGM-56)', () => {
  const { ctx } = setup();
  const mesh = { nodes: NODES, links: LINKS };
  const room = (peerNode) => ({ kind: 'direct', people: [{ id: ME + '-me' }, { id: peerNode + '-x' }] });
  assert.equal(ctx.meshDirectPeer(room(B), ME + '-me', mesh).fp, B);
  assert.equal(ctx.meshDirectPeer(room(A), ME + '-me', mesh), null, '이미 간선');
  assert.equal(ctx.meshDirectPeer(room(C), ME + '-me', mesh), null, '연결 끊김');
  assert.equal(ctx.meshDirectPeer({ kind: 'group', people: [] }, ME + '-me', mesh), null);
  assert.equal(ctx.meshDirectPeer(room(B), ME + '-me', null), null, '망 정보가 없다');
});

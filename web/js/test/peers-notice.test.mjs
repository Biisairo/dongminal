import assert from 'node:assert/strict';
import { test } from 'node:test';

import { load } from './harness.mjs';

/**
 * PEER_NETWORK_SRS FR-PNW-80~82 — 짝 상태의 화면 쪽 규칙.
 *
 *   FR-PNW-81 승인 대기가 **새로** 생기면 주의 알림을 띄우고, 누르면 Peers 탭을 연다.
 *             같은 대기로 다시 띄우지 않는다. 대기가 없어지면 알림을 거둔다.
 *   FR-PNW-82 방송의 `paired` 가 오면 "<이름> 등록됨" 알림이 남는다 (스스로 사라지지 않는다).
 *   FR-PNW-80 지문은 앞 16자, 초대는 남은 시간으로 보인다.
 */
function setup() {
  const shown = [];
  let next = { ok: true, status: 200, data: { pending: [] } };
  const ctx = load(['core/state-registry.js', 'core/settings-live.js', 'core/app-peers.js'], {
    expose: ['peerFp16', 'peerRemain'],
    globals: {
      App: function App() {},
      t: (k, p) => k + (p ? JSON.stringify(p) : ''),
      apiGet: async () => next,
      Toast: {
        show(text, kind, ms, opts) {
          const h = { text, kind, ms, opts, closed: false, el: { isConnected: true } };
          h.close = () => { h.closed = true; h.el.isConnected = false };
          h.update = (msg) => { h.text = msg };
          shown.push(h);
          return h;
        },
      },
    },
  });
  const app = new ctx.App();
  app._liveOpen = () => false; // 설정 패널이 열려 있지 않다 (UX_BATCH12 FR-LIV-4)
  app.timers = { after: () => ({ stop() {} }), cancel() {} };
  app._restoreBegin = () => 1;
  app._restoreLive = () => true;
  app._restoreEnd = () => {};
  app._peersPaint = () => {};
  app.opened = [];
  app._openSettings = (tab) => app.opened.push(tab);
  const pend = (...ids) => { next = { ok: true, status: 200, data: { pending: ids.map((id) => ({ id, name: 'n-' + id })) } } };
  return { ctx, app, shown, pend, fail: () => { next = { ok: false, status: 503, data: null } } };
}

test('지문은 앞 16자다', () => {
  const { ctx } = setup();
  assert.equal(ctx.peerFp16('0123456789abcdef0123'), '0123456789abcdef');
  assert.equal(ctx.peerFp16(undefined), '');
});

test('남은 시간은 m:ss 이고, 지났으면 빈 값이다', () => {
  const { ctx } = setup();
  const now = Date.parse('2026-11-10T00:00:00Z');
  assert.equal(ctx.peerRemain('2026-11-10T00:02:05Z', now), '2:05');
  assert.equal(ctx.peerRemain('2026-11-10T00:00:00.400Z', now), '0:01');
  assert.equal(ctx.peerRemain('2026-11-10T00:00:00Z', now), '');
  assert.equal(ctx.peerRemain('bad', now), '');
});

test('새 승인 대기가 오면 알림 하나, 같은 대기로는 다시 띄우지 않는다', async () => {
  const { app, shown, pend } = setup();
  pend('p1');
  await app._peersRestore();
  assert.equal(shown.length, 1);
  assert.equal(shown[0].ms, 0, '주의 알림은 스스로 사라지지 않는다');
  assert.equal(shown[0].opts.actions.length, 1);
  await app._peersRestore();
  assert.equal(shown.length, 1, '같은 대기로 알림을 다시 띄웠다');
  pend('p1', 'p2');
  await app._peersRestore();
  assert.equal(shown.length, 1, '살아 있는 알림을 두고 하나 더 띄웠다');
  assert.match(shown[0].text, /"n":2/);
});

test('알림을 누르면 Peers 탭이 열리고 알림은 닫힌다', async () => {
  const { app, shown, pend } = setup();
  pend('p1');
  await app._peersRestore();
  shown[0].opts.actions[0].onClick();
  assert.deepEqual(app.opened, ['peers']);
  assert.equal(shown[0].closed, true);
  pend('p1', 'p3');
  await app._peersRestore();
  assert.equal(shown.length, 2, '닫은 뒤 새 대기가 오면 다시 띄워야 한다');
});

test('대기가 없어지면 알림을 거둔다. 읽기 실패로는 거두지 않는다', async () => {
  const { app, shown, pend, fail } = setup();
  pend('p1');
  await app._peersRestore();
  fail();
  await app._peersRestore();
  assert.equal(shown[0].closed, false);
  pend();
  await app._peersRestore();
  assert.equal(shown[0].closed, true);
});

test('paired 방송은 "등록됨" 알림을 남긴다', async () => {
  const { app, shown, pend } = setup();
  pend();
  await app._onPeersChanged({ paired: 'node-a' });
  const ok = shown.filter((h) => h.kind === 'ok');
  assert.equal(ok.length, 1);
  assert.match(ok[0].text, /node-a/);
  assert.equal(ok[0].ms, 0, '등록 알림은 남아야 한다');
  await app._onPeersChanged({});
  assert.equal(shown.filter((h) => h.kind === 'ok').length, 1);
});

/**
 * C6: 탭을 여는 읽기가 방송의 다시 읽기에 밀려도(세대가 지나도) 노드 설정 칸은 그 읽기의
 * 값으로 채운다. 비어 남은 칸을 저장하면 400 이다.
 */
test('탭을 여는 읽기가 밀려도 노드 칸은 그 값으로 채운다', async () => {
  const data = { node: { name: 'office', port: 58147 }, pending: [{ id: 'p1' }], peers: [{ name: 'b' }] };
  const ctx = load(['core/state-registry.js', 'core/settings-live.js', 'core/app-peers.js', 'core/app-settings-peers.js'], {
    globals: {
      App: function App() {},
      t: (k) => k,
      apiGet: async () => ({ ok: true, status: 200, data }),
      statusRun: async (_el, _opts, fn) => fn(),
      document: { getElementById: () => null },
      Toast: { show: () => ({ close() {}, update() {}, el: { isConnected: true } }) },
    },
  });
  const app = new ctx.App();
  app.timers = { after: () => ({ stop() {} }), cancel() {} };
  app._restoreBegin = () => 1;
  app._restoreLive = () => false; // 방송의 다시 읽기가 뒤에 시작했다
  app._restoreEnd = () => {};
  const painted = {};
  app._pnNodePaint = (v) => { painted.node = v };
  app._pnPendingPaint = (p, force) => { painted.pending = [p, force] };
  app._pnPeersPaint = (p, force) => { painted.peers = [p, force] };
  app._pnNodeCollect = () => ({}); // 폼 DOM 은 이 시험의 대상이 아니다 (UX_BATCH12 FR-LIV-6 의 기준값)
  await app._loadPeersPanel();
  assert.equal(painted.node, data);
  assert.deepEqual(painted.pending, [data.pending, true]);
  assert.deepEqual(painted.peers, [data.peers, true]);
});

/**
 * C6: 승인 대기는 시간으로 만료돼도 방송이 없다. 가장 이른 만료 뒤에 한 번 다시 읽어
 * 알림을 거둔다. 주기 조회가 아니다 — 대기가 없으면 타이머도 없다.
 */
test('승인 대기가 만료되는 때에 한 번 다시 읽는다', async () => {
  const timers = [];
  const cleared = [];
  const now = Date.parse('2026-11-10T00:00:00Z');
  let next = { ok: true, status: 200, data: { pending: [
    { id: 'p1', expires: '2026-11-10T00:05:00Z' }, { id: 'p2', expires: '2026-11-10T00:02:00Z' }] } };
  const ctx = load(['core/state-registry.js', 'core/settings-live.js', 'core/app-peers.js'], {
    globals: {
      App: function App() {},
      t: (k) => k,
      apiGet: async () => next,
      Date: { now: () => now, parse: Date.parse },
      Toast: { show: () => { const h = { el: { isConnected: true } }; h.close = () => { h.el.isConnected = false }; h.update = () => {}; return h } },
    },
  });
  const app = new ctx.App();
  app._liveOpen = () => false; // 설정 패널이 열려 있지 않다 (UX_BATCH12 FR-LIV-4)
  app.timers = {
    after: (ms, fn) => { const h = { ms, fn, stop: () => cleared.push(h) }; timers.push(h); return h },
    cancel: (h) => { if (h) h.stop() },
  };
  app._restoreBegin = () => 1;
  app._restoreLive = () => true;
  app._restoreEnd = () => {};
  app._peersPaint = () => {};
  await app._peersRestore();
  assert.equal(timers.length, 1);
  assert.ok(timers[0].ms >= 120000 && timers[0].ms <= 125000, `타이머 ${timers[0].ms}`);
  next = { ok: true, status: 200, data: { pending: [] } };
  await timers[0].fn();
  assert.deepEqual(cleared, [timers[0]], '앞 타이머를 거두지 않았다');
  assert.equal(timers.length, 1, '대기가 없는데 타이머를 걸었다');
  assert.equal(app._peerToast, null, '알림을 거두지 않았다');
});

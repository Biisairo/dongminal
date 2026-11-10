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
  const ctx = load(['core/state-registry.js', 'core/app-peers.js'], {
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

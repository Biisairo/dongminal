import assert from 'node:assert/strict';
import { test } from 'node:test';

import { load, fakeClock, plain } from './harness.mjs';

/**
 * `web/js/core/channel.js` — 브라우저 탭당 WebSocket 하나 (PERF_OPTIMIZATION_SRS FR-CON ·
 * `perf/CHANNEL_PROTOCOL.md` §10.1 C1, TC-CH1-8~12).
 */
function chan({ pingMs = 3000, protocol = 'http:' } = {}) {
  const clock = fakeClock();
  const opened = [];
  class FakeWS {
    constructor(url) { this.url = url; this.readyState = 0; this.closed = 0; this.sent = []; opened.push(this) }
    send(m) { this.sent.push(m) }
    close() { this.closed++; this.readyState = 3 }
  }
  const ctx = load(['core/i18n.js', 'i18n/ko.js', 'core/constants.js', 'core/timer-hub.js', 'core/channel.js'], {
    clock,
    globals: { WebSocket: FakeWS, location: { protocol, host: 'h:1' } },
    expose: ['Channel', 'chanApply', 'TIMERS', 'CHAN_PING_HIDDEN_MS', 'CHAN_SILENCE_GRACE_MS', 'CHAN_RETRY_MIN_MS', 'CHAN_RETRY_MAX_MS'],
  });
  const pub = [];
  const bus = { publish: (t, a) => { pub.push([t, a]) } };
  const timers = { after: (ms, fn, o) => ctx.TIMERS.after(ms, fn, o) };
  const opts = { pingMs: () => pingMs };
  const c = new ctx.Channel(bus, timers, opts);
  return { ctx, c, clock, opened, pub, opts };
}

const sent = (ws) => ws.sent.map((m) => JSON.parse(m));
const open = (ws) => { ws.readyState = 1; ws.onopen() };
const recv = (ws, v) => ws.onmessage({ data: JSON.stringify(v) });
const drop = (ws) => { ws.readyState = 3; if (ws.onclose) ws.onclose() };

test('TC-CH1-8: /channel?v=1 로 열고, 열리면 hello{slots} 를 보낸다', () => {
  const { c, opened } = chan();
  c.connect();
  assert.equal(opened.length, 1);
  assert.equal(opened[0].url, 'ws://h:1/channel?v=1');
  open(opened[0]);
  assert.deepEqual(sent(opened[0]), [{ t: 'hello', slots: [] }]);
});

test('TC-CH1-8: https 면 wss 다', () => {
  const { c, opened } = chan({ protocol: 'https:' });
  c.connect();
  assert.equal(opened[0].url, 'wss://h:1/channel?v=1');
});

test('TC-CH1-9: setSlots — 열려 있으면 hello 를 다시, 닫혀 있으면 다음 연결에 싣는다', () => {
  const { c, opened } = chan();
  c.setSlots(['s1']);
  c.connect();
  open(opened[0]);
  assert.deepEqual(sent(opened[0]), [{ t: 'hello', slots: ['s1'] }]);
  c.setSlots(['s1', 's2']);
  assert.deepEqual(sent(opened[0]).at(-1), { t: 'hello', slots: ['s1', 's2'] });
  assert.equal(sent(opened[0]).length, 2);
});

test('TC-CH1-9: 연결 중(readyState 0)의 setSlots 는 보내지 않고 열릴 때 싣는다', () => {
  const { c, opened } = chan();
  c.connect();
  c.setSlots(['s9']);
  assert.equal(opened[0].sent.length, 0);
  open(opened[0]);
  assert.deepEqual(sent(opened[0]), [{ t: 'hello', slots: ['s9'] }]);
});

test('TC-CH1-10: 보일 때 statsInterval 주기로 ping 하고 pong 왕복이 latency 다', async () => {
  const { c, opened, clock } = chan({ pingMs: 3000 });
  c.connect();
  const ws = opened[0];
  open(ws);
  recv(ws, { t: 'hello', epoch: 'e1', server: {} });
  assert.equal(c.latency(), null);
  const pings = sent(ws).filter((m) => m.t === 'ping');
  assert.equal(pings.length, 1, '서버 hello 에 곧바로 ping 하지 않았다');
  await clock.advance(40);
  recv(ws, { t: 'pong', n: pings[0].n });
  assert.equal(c.latency(), 40);
  await clock.advance(3000 - 41);
  assert.equal(sent(ws).filter((m) => m.t === 'ping').length, 1);
  await clock.advance(1);
  assert.equal(sent(ws).filter((m) => m.t === 'ping').length, 2);
});

test('TC-CH1-10b: pong 마다 chan:pong{latency} 를 발행한다 — 부팅 직후의 연결 표시가 한 주기를 기다리지 않는다', async () => {
  const { c, opened, clock, pub } = chan({ pingMs: 3000 });
  c.connect();
  const ws = opened[0];
  open(ws);
  recv(ws, { t: 'hello', epoch: 'e1', server: {} });
  const n = sent(ws).filter((m) => m.t === 'ping')[0].n;
  await clock.advance(7);
  recv(ws, { t: 'pong', n });
  assert.deepEqual(plain(pub.filter(([t]) => t === 'chan:pong')), [['chan:pong', { latency: 7 }]]);
});

test('TC-CH1-10: 숨었을 때는 CHAN_PING_HIDDEN_MS 주기다', async () => {
  const { c, opened, clock, ctx } = chan({ pingMs: 3000 });
  ctx.document.hidden = true;
  c.connect();
  const ws = opened[0];
  open(ws);
  recv(ws, { t: 'hello', epoch: 'e1', server: {} });
  assert.equal(sent(ws).filter((m) => m.t === 'ping').length, 1);
  await clock.advance(ctx.CHAN_PING_HIDDEN_MS - 1);
  assert.equal(sent(ws).filter((m) => m.t === 'ping').length, 1);
  await clock.advance(1);
  assert.equal(sent(ws).filter((m) => m.t === 'ping').length, 2);
});

test('TC-CH1-10: 다른 n 의 pong 은 지연으로 읽지 않는다', async () => {
  const { c, opened, clock } = chan();
  c.connect();
  const ws = opened[0];
  open(ws);
  await clock.advance(3000);
  recv(ws, { t: 'pong', n: -5 });
  assert.equal(c.latency(), null);
});

test('TC-CH1-11: 주기×2+유예 동안 아무것도 오지 않으면 닫고 다시 연결한다', async () => {
  const { c, opened, clock, ctx } = chan({ pingMs: 3000 });
  c.connect();
  const ws = opened[0];
  open(ws);
  recv(ws, { t: 'hello', epoch: 'e1', server: {} });
  const limit = 3000 * 2 + ctx.CHAN_SILENCE_GRACE_MS;
  await clock.advance(limit - 1);
  assert.equal(opened.length, 1, '상한 전에 끊었다');
  assert.equal(ws.closed, 0);
  await clock.advance(3000 + 1);
  assert.ok(ws.closed >= 1, '침묵한 소켓을 닫지 않았다');
  assert.equal(opened.length, 2, '다시 연결하지 않았다');
});

test('TC-CH1-11: 프레임이 계속 오면 끊지 않는다', async () => {
  const { c, opened, clock } = chan({ pingMs: 3000 });
  c.connect();
  const ws = opened[0];
  open(ws);
  for (let i = 0; i < 20; i++) {
    await clock.advance(3000);
    const p = sent(ws).filter((m) => m.t === 'ping').at(-1);
    recv(ws, { t: 'pong', n: p.n });
  }
  assert.equal(opened.length, 1);
  assert.equal(ws.closed, 0);
});

test('TC-CH1-12: 끊기면 500 → ×2 → 10초 상한 백오프로 다시 연결한다', async () => {
  const { c, opened, clock, ctx } = chan();
  c.connect();
  const waits = [];
  for (let i = 0; i < 7; i++) {
    const before = opened.length;
    drop(opened.at(-1));
    let w = 0;
    while (opened.length === before) { await clock.advance(100); w += 100 }
    waits.push(w);
  }
  assert.equal(ctx.CHAN_RETRY_MIN_MS, 500);
  assert.equal(ctx.CHAN_RETRY_MAX_MS, 10000);
  assert.deepEqual(waits, [500, 1000, 2000, 4000, 8000, 10000, 10000]);
});

test('TC-CH1-12: 서버 hello 가 백오프를 되돌리고 chan:open{gen,epoch} 를 발행한다', async () => {
  const { c, opened, clock, pub } = chan();
  c.connect();
  drop(opened[0]);
  await clock.advance(500);
  drop(opened[1]);
  await clock.advance(1000);
  const ws = opened[2];
  open(ws);
  recv(ws, { t: 'hello', epoch: 'e7', server: { assetVersion: 'v' } });
  const opens = pub.filter(([t]) => t === 'chan:open').map(([, a]) => plain(a));
  assert.deepEqual(opens, [{ gen: 3, epoch: 'e7', server: { assetVersion: 'v' } }]);
  drop(ws);
  await clock.advance(499);
  assert.equal(opened.length, 3);
  await clock.advance(1);
  assert.equal(opened.length, 4, 'hello 뒤 백오프가 되돌려지지 않았다');
});

test('TC-CH1-12: 옛 소켓의 늦은 close 는 지금 연결을 건드리지 않는다', async () => {
  const { c, opened, clock } = chan({ pingMs: 3000 });
  c.connect();
  const old = opened[0];
  open(old);
  await clock.advance(3000 * 2 + 5000 + 3000);
  assert.equal(opened.length, 2);
  const now = opened[1];
  drop(old);
  await clock.advance(20000);
  assert.equal(opened.length, 2, '옛 소켓의 close 가 재연결을 걸었다');
  assert.equal(now.closed, 0);
});

test('close() 뒤에는 다시 연결하지 않는다', async () => {
  const { c, opened, clock } = chan();
  c.connect();
  open(opened[0]);
  c.close();
  await clock.advance(60000);
  assert.equal(opened.length, 1);
});

test('TC-CH1-11: 숨은 동안 건 주기가 보일 때 끝나도 침묵으로 읽지 않는다', async () => {
  const { c, opened, clock, ctx } = chan({ pingMs: 3000 });
  ctx.document.hidden = true;
  c.connect();
  const ws = opened[0];
  open(ws);
  recv(ws, { t: 'hello', epoch: 'e1', server: {} });
  ctx.document.hidden = false;
  await clock.advance(ctx.CHAN_PING_HIDDEN_MS);
  assert.equal(opened.length, 1, '살아 있는 연결을 침묵으로 끊었다');
  assert.equal(sent(ws).filter((m) => m.t === 'ping').length, 2, '인사 직후 하나 + 숨은 주기 하나');
});

// ── 토픽 기반 (CHANNEL_PROTOCOL §11.2 · §5.1) ─────────────────────────────

/** 열고 서버 hello 까지 받은 채널. */
function ready(epoch = 'e1') {
  const h = chan();
  h.c.connect();
  const ws = h.opened[0];
  open(ws);
  recv(ws, { t: 'hello', epoch, server: {} });
  return { ...h, ws };
}
const subs = (ws) => sent(ws).filter((m) => m.t === 'sub' || m.t === 'unsub');

test('sub: 첫 구독자만 서버 sub 를, 마지막 해지만 unsub 를 보낸다', () => {
  const { c, ws } = ready();
  const a = c.sub('workspace', () => {});
  const b = c.sub('workspace', () => {});
  assert.deepEqual(subs(ws), [{ t: 'sub', topic: 'workspace' }]);
  a.stop();
  assert.equal(subs(ws).length, 1, '구독자가 남았는데 unsub 했다');
  b.stop();
  assert.deepEqual(subs(ws).at(-1), { t: 'unsub', topic: 'workspace' });
  b.stop();
  assert.equal(subs(ws).length, 2, '두 번 해지가 unsub 를 두 번 보냈다');
});

test('sub: full·delta·event·reset 을 구독자 모두에게 전한다', () => {
  const { c, ws } = ready();
  const got = [], got2 = [];
  c.sub('activity', (m) => got.push(plain(m)));
  c.sub('activity', (m) => got2.push(m.kind));
  c.sub('fs', (m) => got.push(plain(m)));
  recv(ws, { t: 'full', topic: 'activity', seq: 1, data: { t1: { state: 'idle' } } });
  recv(ws, { t: 'delta', topic: 'activity', seq: 2, ops: [{ op: 'del', id: 't1' }] });
  recv(ws, { t: 'reset', topic: 'fs' });
  recv(ws, { t: 'event', topic: 'fs', seq: 9, data: { p: '/a' } });
  recv(ws, { t: 'full', topic: 'nobody', seq: 1, data: {} });
  assert.deepEqual(got, [
    { kind: 'full', data: { t1: { state: 'idle' } }, seq: 1 },
    { kind: 'delta', ops: [{ op: 'del', id: 't1' }], seq: 2 },
    { kind: 'reset' },
    { kind: 'event', data: { p: '/a' }, seq: 9 },
  ]);
  assert.deepEqual(got2, ['full', 'delta']);
});

test('순번 빈틈: sub{topic,seq,epoch} 를 다시 보내고 그 사이 프레임은 버린다', () => {
  const { c, ws } = ready('e1');
  const got = [];
  c.sub('runs', (m) => got.push(m.seq));
  recv(ws, { t: 'full', topic: 'runs', seq: 4, data: {} });
  recv(ws, { t: 'delta', topic: 'runs', seq: 5, ops: [] });
  recv(ws, { t: 'delta', topic: 'runs', seq: 7, ops: [] });
  assert.deepEqual(subs(ws).at(-1), { t: 'sub', topic: 'runs', seq: 5, epoch: 'e1' });
  recv(ws, { t: 'delta', topic: 'runs', seq: 8, ops: [] });
  assert.equal(subs(ws).filter((m) => m.t === 'sub').length, 2, '재구독 대기 중에 또 보냈다');
  recv(ws, { t: 'delta', topic: 'runs', seq: 6, ops: [] });
  recv(ws, { t: 'delta', topic: 'runs', seq: 7, ops: [] });
  assert.deepEqual(got, [4, 5, 6, 7]);
});

test('순번: 이미 받은 순번(중복)은 버리고 재구독하지 않는다', () => {
  const { c, ws } = ready();
  const got = [];
  c.sub('runs', (m) => got.push(m.seq));
  recv(ws, { t: 'full', topic: 'runs', seq: 3, data: {} });
  recv(ws, { t: 'delta', topic: 'runs', seq: 3, ops: [] });
  assert.deepEqual(got, [3]);
  assert.equal(subs(ws).length, 1);
});

test('재연결: 서버 hello 뒤에 구독 중인 토픽 전부를 seq·epoch 와 함께 다시 보낸다', async () => {
  const { c, ws, opened, clock } = ready('e1');
  c.sub('runs', () => {});
  c.sub('settings', () => {});
  recv(ws, { t: 'full', topic: 'runs', seq: 12, data: {} });
  drop(ws);
  await clock.advance(500);
  const ws2 = opened[1];
  open(ws2);
  assert.deepEqual(subs(ws2), [], '서버 hello 전에 sub 를 보냈다');
  recv(ws2, { t: 'hello', epoch: 'e2', server: {} });
  assert.deepEqual(subs(ws2), [
    { t: 'sub', topic: 'runs', seq: 12, epoch: 'e1' },
    { t: 'sub', topic: 'settings' },
  ]);
});

test('연결 전 sub 은 서버 hello 뒤에 보낸다', () => {
  const { c, opened } = chan();
  c.sub('workspace', () => {});
  c.connect();
  const ws = opened[0];
  open(ws);
  assert.deepEqual(subs(ws), []);
  recv(ws, { t: 'hello', epoch: 'e1', server: {} });
  assert.deepEqual(subs(ws), [{ t: 'sub', topic: 'workspace' }]);
});

test('chanApply: put 은 넣거나 바꾸고 del 은 지운다', () => {
  const { ctx } = chan();
  const m = new Map([['a', 1], ['b', 2]]);
  const r = ctx.chanApply(m, [{ op: 'put', id: 'a', v: 9 }, { op: 'del', id: 'b' }, { op: 'put', id: 'c', v: 3 }]);
  assert.equal(r, m);
  assert.deepEqual([...m.entries()], [['a', 9], ['c', 3]]);
});

test('on: 토픽이 아닌 종류(cmd)를 받는다, stop 뒤에는 받지 않는다', () => {
  const { c, ws } = ready();
  const got = [];
  const h = c.on('cmd', (m) => got.push(m.action));
  recv(ws, { t: 'cmd', action: 'focus', args: {} });
  h.stop();
  recv(ws, { t: 'cmd', action: 'x', args: {} });
  assert.deepEqual(got, ['focus']);
});

test('onBinary: ArrayBuffer 를 Uint8Array 로 넘긴다', () => {
  const { c, ws } = ready();
  const got = [];
  c.onBinary((u8) => got.push(u8));
  ws.onmessage({ data: new Uint8Array([0, 0, 0, 0, 7, 65]).buffer });
  assert.equal(got.length, 1);
  assert.equal(got[0].constructor.name, 'Uint8Array');
  assert.deepEqual([...got[0]], [0, 0, 0, 0, 7, 65]);
});

test('send·sendBinary: 열려 있으면 보내고 true, 닫혀 있으면 false', () => {
  const { c, opened } = chan();
  assert.equal(c.send({ t: 'x' }), false);
  c.connect();
  const ws = opened[0];
  assert.equal(c.sendBinary(new Uint8Array([1])), false);
  open(ws);
  assert.equal(c.send({ t: 'x' }), true);
  const b = new Uint8Array([1, 2]);
  assert.equal(c.sendBinary(b), true);
  assert.equal(ws.sent.at(-1), b);
});

test('disposeOwner: 그 owner 의 구독과 수신을 걷고 빈 토픽은 unsub 한다', () => {
  const { c, ws } = ready();
  const got = [];
  c.sub('runs', () => got.push('mine'), { owner: 'p' });
  c.sub('settings', () => got.push('mine'), { owner: 'p' });
  c.sub('settings', () => got.push('other'));
  c.on('cmd', () => got.push('cmd'), { owner: 'p' });
  assert.equal(c.disposeOwner('p'), 3);
  assert.deepEqual(subs(ws).slice(2), [{ t: 'unsub', topic: 'runs' }]);
  recv(ws, { t: 'full', topic: 'settings', seq: 1, data: {} });
  recv(ws, { t: 'cmd', action: 'a' });
  assert.deepEqual(got, ['other']);
  assert.equal(c.disposeOwner(null), 0);
});

test('stats: 구독 중인 토픽마다 구독자 수·마지막 순번·받은 epoch 를 준다 (진단, FR-BUS-9)', () => {
  const { c, ws } = ready();
  c.sub('settings', () => {});
  c.sub('settings', () => {});
  c.sub('chat', () => {});
  recv(ws, { t: 'full', topic: 'settings', seq: 3, data: {} });
  assert.deepEqual(plain(c.stats()), [
    { topic: 'chat', subs: 1, seq: null, epoch: null, waiting: false },
    { topic: 'settings', subs: 2, seq: 3, epoch: 'e1', waiting: false },
  ]);
});

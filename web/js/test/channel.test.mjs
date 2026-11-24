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
    expose: ['Channel', 'TIMERS', 'CHAN_PING_HIDDEN_MS', 'CHAN_SILENCE_GRACE_MS', 'CHAN_RETRY_MIN_MS', 'CHAN_RETRY_MAX_MS'],
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
  await clock.advance(3000);
  const pings = sent(ws).filter((m) => m.t === 'ping');
  assert.equal(pings.length, 1);
  await clock.advance(40);
  recv(ws, { t: 'pong', n: pings[0].n });
  assert.equal(c.latency(), 40);
  await clock.advance(3000);
  assert.equal(sent(ws).filter((m) => m.t === 'ping').length, 2);
});

test('TC-CH1-10: 숨었을 때는 CHAN_PING_HIDDEN_MS 주기다', async () => {
  const { c, opened, clock, ctx } = chan({ pingMs: 3000 });
  ctx.document.hidden = true;
  c.connect();
  const ws = opened[0];
  open(ws);
  recv(ws, { t: 'hello', epoch: 'e1', server: {} });
  await clock.advance(ctx.CHAN_PING_HIDDEN_MS - 1);
  assert.equal(sent(ws).filter((m) => m.t === 'ping').length, 0);
  await clock.advance(1);
  assert.equal(sent(ws).filter((m) => m.t === 'ping').length, 1);
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
  assert.deepEqual(opens, [{ gen: 3, epoch: 'e7' }]);
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
  assert.equal(sent(ws).filter((m) => m.t === 'ping').length, 1);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { BASE, SLOTS, TOOL, controllers, load, fakeClock, plain } from './harness.mjs';

/**
 * 명령·사건 스트림을 채널로 (`perf/CHANNEL_PROTOCOL.md` §10.2 C2a, TC-CH2A-8~13).
 */
function chan({ client = 'cli1' } = {}) {
  const clock = fakeClock();
  const opened = [];
  class FakeWS {
    constructor(url) { this.url = url; this.readyState = 0; this.sent = []; opened.push(this) }
    send(m) { this.sent.push(m) }
    close() { this.readyState = 3 }
  }
  const ctx = load(['core/i18n.js', 'i18n/ko.js', 'core/constants.js', 'core/timer-hub.js', 'core/channel.js'], {
    clock,
    globals: { WebSocket: FakeWS, location: { protocol: 'http:', host: 'h:1' } },
    expose: ['Channel', 'TIMERS', 'CHAN_RETRY_MIN_MS', 'CHAN_RETRY_MAX_MS', 'CHAN_SILENCE_GRACE_MS'],
  });
  const pub = [];
  const bus = { publish: (t, a) => { pub.push(plain([t, a])) } };
  const timers = { after: (ms, fn, o) => ctx.TIMERS.after(ms, fn, o) };
  const c = new ctx.Channel(bus, timers, { pingMs: () => 3000, client: () => client });
  return { ctx, c, clock, opened, pub };
}

const sent = (ws) => ws.sent.map((m) => JSON.parse(m));
const open = (ws) => { ws.readyState = 1; ws.onopen() };
const recv = (ws, v) => ws.onmessage({ data: JSON.stringify(v) });
const drop = (ws) => { ws.readyState = 3; if (ws.onclose) ws.onclose() };

test('TC-CH2A-8: hello 에 client 를 싣는다', () => {
  const { c, opened } = chan();
  c.setSlots(['s1']);
  c.connect();
  open(opened[0]);
  assert.deepEqual(sent(opened[0]), [{ t: 'hello', client: 'cli1', slots: ['s1'] }]);
});

test('TC-CH2A-9·13: 서버 hello 는 연결마다 처음 한 번만 재구독과 chan:open{gen,epoch,server} 를 낸다', () => {
  const { c, opened, pub } = chan();
  c.sub('t1', () => {});
  c.connect();
  const ws = opened[0];
  open(ws);
  recv(ws, { t: 'hello', epoch: 'e1', server: { assetVersion: 'v9' } });
  assert.deepEqual(pub, [['chan:open', { gen: 1, epoch: 'e1', server: { assetVersion: 'v9' } }]]);
  const subs = () => sent(ws).filter((m) => m.t === 'sub').length;
  assert.equal(subs(), 1);
  c.setSlots(['s2']);
  recv(ws, { t: 'hello', epoch: 'e1', server: { assetVersion: 'v9' } });
  assert.equal(pub.length, 1, '칸 수가 바뀐 인사가 chan:open 을 다시 냈다');
  assert.equal(subs(), 1, '칸 수가 바뀐 인사가 다시 구독했다');
});

test('TC-CH2A-12: kick — 닫혀 있으면 백오프를 무시하고 곧바로 연결한다', async () => {
  const { c, opened, clock } = chan();
  c.connect();
  open(opened[0]);
  drop(opened[0]);
  await clock.advance(1);
  assert.equal(opened.length, 1, '백오프 전에 다시 열렸다');
  c.kick();
  assert.equal(opened.length, 2, 'kick 이 곧바로 열지 않았다');
  await clock.advance(60_000);
  assert.equal(opened.length, 2, '걸려 있던 백오프가 한 번 더 열었다');
});

test('TC-CH2A-12: kick — 열려 있으면 침묵일 때만 다시 연결한다', async () => {
  const { c, opened, clock, ctx } = chan();
  c.connect();
  const ws = opened[0];
  open(ws);
  recv(ws, { t: 'hello', epoch: 'e1', server: {} });
  c.kick();
  assert.equal(opened.length, 1, '살아 있는 연결을 kick 이 끊었다');
  // 주기 감시를 걷고 시계만 흘려 침묵을 만든다 — kick 혼자의 판정을 잰다.
  c._tickT.stop(); c._tickT = null;
  await clock.advance(3000 * 2 + ctx.CHAN_SILENCE_GRACE_MS + 1);
  assert.equal(opened.length, 1);
  c.kick();
  assert.equal(opened.length, 2, '침묵인 연결을 kick 이 되살리지 않았다');
});

function busWorld() {
  const ctx = load(['core/event-bus.js'], { expose: ['EventBus'] });
  const app = { clientId: 'me' };
  const bus = new ctx.EventBus(app, {});
  const seen = [];
  bus.setFallback((action, args) => seen.push(plain(['fallback', action, args])));
  return { bus, seen };
}

test('TC-CH2A-10: cmd — 구독자가 있는 action 은 지명과 상관없이 발행한다', () => {
  const { bus, seen } = busWorld();
  const got = [];
  bus.subscribe('workspace_changed', (a) => got.push(plain(a)));
  bus.route({ t: 'cmd', action: 'workspace_changed', args: { rev: 3 }, execClientId: 'other' });
  assert.deepEqual(got, [{ rev: 3 }]);
  assert.deepEqual(seen, []);
});

test('TC-CH2A-10: cmd — 구독자가 없으면 지명 검사 뒤 대체 처리기, reqId 를 싣는다', () => {
  const { bus, seen } = busWorld();
  bus.route({ t: 'cmd', action: 'newTab', args: { name: 'x' }, reqId: 'r1', execClientId: 'other' });
  assert.deepEqual(seen, [], '다른 클라이언트에 지명된 명령을 실행했다');
  bus.route({ t: 'cmd', action: 'newTab', args: { name: 'x' }, reqId: 'r1', execClientId: 'me' });
  bus.route({ t: 'cmd', action: 'focusBack' });
  assert.deepEqual(seen, [
    ['fallback', 'newTab', { name: 'x', reqId: 'r1' }],
    ['fallback', 'focusBack', {}],
  ]);
});

/**
 * PERF 4.3: 칸 [1] 이상이 포커스를 주장하면 서버가 그 칸의 신원을 실행자로 지명한다(FR-SXE-4).
 * 칸 신원은 서버 눈에 별개 클라이언트지만(FR-WSL-10 · D-3) 채널은 브라우저 창 하나에 하나라
 * 명령은 한 번만 닿는다. 그 창의 모든 칸 신원(`SlotsController._slotIdentities`)을 자기 것으로 본다.
 */
function slotBusWorld(nSlots) {
  const ctx = load([...BASE, 'core/layout-tree.js', ...SLOTS, 'core/event-bus.js'], {
    expose: ['EventBus', 'SlotsController', 'App'],
    globals: { App: class App {}, crypto: globalThis.crypto },
  });
  const app = new ctx.App();
  app.clientId = 'me';
  app._slots = nSlots ? { windows: Array.from({ length: nSlots }, (_, i) => 'w' + i), sizes: [], tabs: [], focused: 1 } : null;
  app.slot = new ctx.SlotsController(app);
  const bus = new ctx.EventBus(app, {});
  const seen = [];
  bus.setFallback((action, args) => seen.push(plain([action, args])));
  return { app, bus, seen };
}

test('PF-4.3: 지명된 실행자가 이 창의 칸 [1] 신원이면 한 번 실행한다', () => {
  const { app, bus, seen } = slotBusWorld(2);
  const s1 = app.slot._slotIdentities()[1];
  assert.ok(s1 && s1 !== 'me');
  for (const action of ['newTab', 'newWindow', 'closeTab']) {
    bus.route({ t: 'cmd', action, args: {}, reqId: 'r-' + action, execClientId: s1 });
  }
  assert.deepEqual(seen, [
    ['newTab', { reqId: 'r-newTab' }],
    ['newWindow', { reqId: 'r-newWindow' }],
    ['closeTab', { reqId: 'r-closeTab' }],
  ], '칸 [1] 에 지명된 명령을 버렸거나 두 번 실행했다');
});

test('PF-4.3: 칸 [0](app.clientId) 지명은 그대로 한 번 실행한다', () => {
  const { bus, seen } = slotBusWorld(3);
  bus.route({ t: 'cmd', action: 'newTab', args: {}, reqId: 'r1', execClientId: 'me' });
  assert.deepEqual(seen, [['newTab', { reqId: 'r1' }]]);
});

test('PF-4.3: 다른 기기·닫힌 칸의 신원은 실행하지 않는다', () => {
  const { app, bus, seen } = slotBusWorld(3);
  const gone = app.slot._slotIdentities()[2];
  app._slots.windows.pop();               // 칸 [2] 제거 — 그 신원은 더 이상 이 창의 것이 아니다
  bus.route({ t: 'cmd', action: 'newTab', args: {}, execClientId: 'other-device' });
  bus.route({ t: 'cmd', action: 'newTab', args: {}, execClientId: gone });
  assert.deepEqual(seen, [], '이 창의 것이 아닌 신원에 지명된 명령을 실행했다');
});

test('PF-4.3: 단일 칸 모드는 app.clientId 만 자기 것이다', () => {
  const { bus, seen } = slotBusWorld(0);
  bus.route({ t: 'cmd', action: 'newTab', args: {}, execClientId: 'other' });
  bus.route({ t: 'cmd', action: 'newTab', args: {}, execClientId: 'me' });
  assert.deepEqual(seen, [['newTab', {}]]);
});

test('TC-CH2A-11: 생성 명령의 결과는 채널 cmd.result 로 보낸다', () => {
  const ctx = load([...BASE, ...TOOL], {
    globals: { App: function App() {}, TIMERS: { disposeOwner() {} }, OpenUrl: { handle() {} }, TAB_TYPE_TERMINAL: 'terminal' },
  });
  const a = controllers(ctx, new ctx.App());
  const out = [];
  a.channel = { send: (v) => { out.push(plain(v)); return true } };
  a.tool.cmd._echoResult('r1', { newTabs: [{ uuid: 't', toolId: '1' }], error: 'x' });
  assert.deepEqual(out, [{ t: 'cmd.result', reqId: 'r1', newWindows: [], newPanes: [], newTabs: [{ uuid: 't', toolId: '1' }], error: 'x' }]);
});

test('FR-RCS-6: 연속 실패 25회 뒤에도 계속 다시 연결한다 (옛 sse-resilience V-RCS-7)', async () => {
  const { c, opened, clock, ctx } = chan();
  c.connect();
  for (let i = 0; i < 25; i++) {
    drop(opened.at(-1));
    await clock.advance(ctx.CHAN_RETRY_MAX_MS);
  }
  assert.equal(opened.length, 26, '재시도를 포기했다');
});

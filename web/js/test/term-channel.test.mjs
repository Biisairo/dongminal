import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { CONSTANTS, load, fakeClock, plain, TERM_PANE } from './harness.mjs';

/**
 * `web/js/ui/term-channel.js` — 터미널 한 칸의 채널 배선 (PERF_OPTIMIZATION_SRS M1 C5 · TC-CH5-14~18,
 * 옛 `term-socket.js` 시험의 자리 — OPTIMIZE_REFACTOR_SRS FR-OPT-12-1 · FEU-14 · IPC-16 · FEU-15).
 *
 * 재는 것: ① 백오프 수열은 종전과 같고 기다리는 시간에만 ±20% 지터가 얹힌다 ② 채널이 준비됐을 때만
 * `term.open` 을 보내고 자기 sid 의 프레임만 받는다 ③ 송신 큐 상한과 보류 입력, 다시 붙기가 종전과 같다.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = (rel) => readFileSync(join(HERE, '..', rel), 'utf8');

class FakeChannel {
  constructor() { this.isReady = false; this.sent = []; this.bins = []; this.raw = new Map(); this.binFns = [] }
  ready() { return this.isReady }
  send(v) { if (!this.isReady) return false; this.sent.push(v); return true }
  sendBinary(u8) { if (!this.isReady) return false; this.bins.push(Array.from(u8)); return true }
  on(t, fn) { if (!this.raw.has(t)) this.raw.set(t, []); this.raw.get(t).push(fn); return { stop() {} } }
  onBinary(fn) { this.binFns.push(fn); return { stop() {} } }
  fire(t, m = {}) { for (const fn of this.raw.get(t) || []) fn(Object.assign({ t }, m)) }
  hello() { this.isReady = true; this.fire('hello') }
  lose() { this.isReady = false; this.fire('lost') }
  frame(op, sid, payload = []) {
    const b = new Uint8Array(5 + payload.length);
    b[0] = op; new DataView(b.buffer).setUint32(1, sid, false); b.set(payload, 5);
    for (const fn of this.binFns) fn(b);
  }
}

function pane(rnd = 0.5) {
  const clock = fakeClock();
  const ctx = load(['core/i18n.js', 'i18n/ko.js', ...CONSTANTS, 'core/timer-hub.js', 'ui/clipboard.js', 'ui/term-clipboard.js', ...TERM_PANE], {
    clock,
    // 지터의 난수를 쥔다 — 기다리는 시간이 결정적이어야 잴 수 있다.
    globals: { location: { protocol: 'http:', host: 'h' }, Math: Object.assign(Object.create(Math), { random: () => rnd }) },
    expose: ['TerminalTool', 'TIMERS', 'OP', 'TERM_MUX', 'termNextRetryDelay', 'termRetryWait', 'TERM_SEND_QUEUE_MAX', 'TERM_KEY_SEQ', 'TERM_OVERLAY_HIDE_MS'],
  });
  ctx.app = { resizeCheck: () => false, isMobile: false };
  const ch = new FakeChannel();
  ctx.TERM_MUX.attach(ch);
  const p = new ctx.TerminalTool('t1', 'tool');
  p.overlays = [];
  p._showOverlay = (title) => { p.overlays.push(title) };
  p._hideOverlay = () => { p.overlays.push('-') };
  return { ctx, p, clock, ch };
}

const opens = (ch) => ch.sent.filter((m) => m.t === 'term.open');
const closes = (ch) => ch.sent.filter((m) => m.t === 'term.close');

test('백오프 수열은 종전과 같다 — 0 → 200 → 500 → 1000 → ×1.2 … 10 s 상한', () => {
  const { ctx } = pane();
  const seq = [0];
  for (let i = 0; i < 20; i++) seq.push(ctx.termNextRetryDelay(seq.at(-1)));
  assert.deepEqual(seq.slice(0, 6), [0, 200, 500, 1000, 1200, 1440]);
  assert.equal(seq.at(-1), 10000);
  for (let i = 1; i < seq.length; i++) assert.ok(seq[i] >= seq[i - 1]);
});

test('지터는 기다리는 시간에만 ±20% 로 얹힌다 — 첫 시도(0)는 즉시다', () => {
  const { ctx } = pane();
  assert.equal(ctx.termRetryWait(0, 0), 0);
  assert.equal(ctx.termRetryWait(0, 0.99), 0);
  assert.equal(ctx.termRetryWait(1000, 0), 800);
  assert.equal(ctx.termRetryWait(1000, 0.5), 1000);
  assert.equal(ctx.termRetryWait(1000, 1), 1200);
});

test('키 매핑은 표에서 온다 — 수식키가 섞이면 매핑하지 않는다', () => {
  const { ctx, p } = pane();
  const k = (key, m = {}) => p._mappedKey(Object.assign({ key, metaKey: false, altKey: false, ctrlKey: false }, m));
  assert.equal(k('ArrowLeft', { metaKey: true }), 'lineStart');
  assert.equal(k('ArrowRight', { metaKey: true }), 'lineEnd');
  assert.equal(k('ArrowLeft', { altKey: true }), 'wordBack');
  assert.equal(k('ArrowRight', { altKey: true }), 'wordFwd');
  assert.equal(k('ArrowLeft', { metaKey: true, ctrlKey: true }), null);
  assert.equal(k('ArrowLeft'), null);
  assert.deepEqual([...ctx.TERM_KEY_SEQ.wordFwd], [0x1b, 0x66]);
});

test('재접속은 지터가 얹힌 시간 뒤에 연다 — 저장된 다음 지연은 지터 없이 자란다 (TC-CH5-17)', async () => {
  const { p, clock, ch } = pane(1);
  ch.hello();
  p.connect();
  assert.equal(opens(ch).length, 1);
  p.ws.close();                  // 첫 재시도: 지연 0
  assert.equal(closes(ch).length, 1, '손잡이의 close 가 term.close 를 보내지 않았다');
  await clock.advance(0);
  assert.equal(opens(ch).length, 2);
  assert.equal(p._retryDelay, 200);
  ch.fire('term.lost', { sid: opens(ch)[0].sid });   // 두 번째: 200 × 1.2 = 240
  await clock.advance(239);
  assert.equal(opens(ch).length, 2, '지터 없이 200 에 열었다');
  await clock.advance(1);
  assert.equal(opens(ch).length, 3);
  assert.equal(p._retryDelay, 500);
});

test('TC-CH5-14: 채널이 준비되기 전에는 보내지 않고, 서버 hello 에 term.open{sid,tool,cols,rows,snap} 를 보낸다', () => {
  const { p, ch } = pane();
  p.connect();
  assert.equal(ch.sent.length, 0);
  assert.equal(p.ws.readyState, 0, '붙는 중이다');
  ch.hello();
  assert.deepEqual(plain(opens(ch)), [{ t: 'term.open', sid: opens(ch)[0].sid, tool: 't1', cols: 120, rows: 40, snap: true }]);
  assert.equal(p.ws.readyState, 1);
});

test('TC-CH5-14: 좌표를 알면 since 를 싣는다', () => {
  const { p, ch } = pane();
  ch.hello();
  p._seq = 1234;
  p.connect();
  assert.equal(opens(ch)[0].since, 1234);
});

test('TC-CH5-14: 자기 sid 의 프레임만 앞 5바이트를 뗀 꼴로 _onOp 에 간다', () => {
  const { p, ch } = pane();
  ch.hello();
  p.connect();
  const got = [];
  p._onOp = (d) => got.push(Array.from(d));
  const sid = opens(ch)[0].sid;
  ch.frame(0, sid, [104, 105]);
  ch.frame(0, sid + 100, [120]);
  assert.deepEqual(got, [[0, 104, 105]]);
});

test('TC-CH5-15: send 는 [op][sid] 머리를 붙인다 — 붙는 중이면 큐에 담고 열리면 비운다', () => {
  const { ctx, p, ch } = pane();
  p.connect();
  for (let i = 0; i < ctx.TERM_SEND_QUEUE_MAX + 6; i++) p._send(new Uint8Array([1, i]));
  assert.equal(p._sendQueue.length, ctx.TERM_SEND_QUEUE_MAX);
  assert.equal(p._sendQueueMax, ctx.TERM_SEND_QUEUE_MAX);
  assert.equal(p._sendDropCount, 6);
  assert.equal(p._sendQueue[0][1], 6);
  ch.hello();
  const sid = opens(ch)[0].sid;
  assert.equal(p._sendQueue.length, 0, '열렸는데 큐가 남았다');
  assert.deepEqual(ch.bins[0], [1, 0, 0, 0, sid, 6]);
  p._send(new Uint8Array([0, 120]));
  assert.deepEqual(ch.bins.at(-1), [0, 0, 0, 0, sid, 120]);
});

test('TC-CH5-15: 재시도를 기다리는 동안의 송신은 버리고 센다', () => {
  const { p, ch } = pane();
  ch.hello();
  p.connect();
  ch.lose();
  const before = p._sendDropCount;
  p._sendQueue = [];
  p._send(new Uint8Array([1, 0, 80, 0, 24]));
  assert.equal(p._sendQueue.length, 0);
  assert.equal(p._sendDropCount - before, 1);
});

test('TC-CH5-16: 채널이 끊기면 _wsLost, 백오프 뒤 다시 붙으면 since 로 다시 열고 오버레이를 걷는다', async () => {
  const { ctx, p, clock, ch } = pane();
  ch.hello();
  p.connect();
  p._seq = 77;
  ch.lose();
  assert.ok(p.overlays.length > 0 && p.overlays[0] !== '-', '끊김 오버레이가 없다');
  await clock.advance(0);
  assert.equal(opens(ch).length, 1, '채널이 없는데 열었다');
  ch.hello();
  assert.equal(opens(ch).length, 2);
  assert.equal(opens(ch)[1].since, 77);
  await clock.advance(ctx.TERM_OVERLAY_HIDE_MS);
  assert.equal(p.overlays.filter((x) => x === '-').length, 1);
});

test('TC-CH5-17: reconnectNow 는 붙음을 떼고 곧바로 다시 연다', () => {
  const { p, ch } = pane();
  ch.hello();
  p.connect();
  p.reconnectNow({ quiet: true });
  assert.equal(closes(ch).length, 1);
  assert.equal(opens(ch).length, 2);
  assert.equal(p.ws.readyState, 1);
});

test('TC-CH5-18: 한 번 열린 뒤 끊긴 동안은 입력을 붙잡는다', () => {
  const { p, ch } = pane();
  assert.equal(p._sock.holding(), false, '열린 적 없으면 붙잡지 않는다');
  ch.hello();
  p.connect();
  assert.equal(p._sock.holding(), false);
  ch.lose();
  assert.equal(p._sock.holding(), true);
});

test('destroy 뒤에는 그 sid 의 프레임을 받지 않고 다시 붙지 않는다', async () => {
  const { p, clock, ch } = pane();
  ch.hello();
  p.connect();
  const sid = opens(ch)[0].sid;
  const got = [];
  p._onOp = (d) => got.push(d);
  p.el.remove = () => {};
  p.destroy();
  assert.equal(closes(ch).length, 1);
  ch.frame(0, sid, [1]);
  ch.lose(); ch.hello();
  await clock.advance(20000);
  assert.equal(got.length, 0);
  assert.equal(opens(ch).length, 1);
});

test('배선은 채널 하나다 — 터미널이 WebSocket 을 열지 않는다', () => {
  const src = TERM_PANE.map(SRC).join('\n');
  assert.equal((src.match(/new WebSocket\(/g) || []).length, 0);
  assert.equal((src.match(/TIMERS\.after\(\s*300\b/g) || []).length, 0, '300ms 리터럴이 남았다');
});

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CONSTANTS, load, fakeClock, TERM_PANE } from './harness.mjs';

/**
 * PERF M2 §2.5 깨움·잠듦 (FR-TRM-3·4, D-15·D-16·D-19) — `TerminalTool.wake()`·`sleep()`.
 *
 * 재는 것: ① 한 번도 깨지 않은 터미널은 붙지 않는다 ② 깨면 `term.open{snap}` 을 보낸다 ③ 잠들면 `term.close` 를 보내고
 * 그 sid 의 프레임을 받지 않으며 xterm 버퍼를 비운다 — 채널이 다시 붙어도 다시 열지 않는다 ④ 스냅숏 `SEQ` 에는 넛지가
 * 없고, 꼬리의 cwd 를 받는다.
 */
class FakeChannel {
  constructor() { this.isReady = false; this.sent = []; this.raw = new Map(); this.binFns = [] }
  ready() { return this.isReady }
  send(v) { if (!this.isReady) return false; this.sent.push(v); return true }
  sendBinary() { return this.isReady }
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

function pane() {
  const clock = fakeClock();
  const ctx = load(['core/i18n.js', 'i18n/ko.js', ...CONSTANTS, 'core/timer-hub.js', 'ui/clipboard.js', 'ui/term-clipboard.js', ...TERM_PANE], {
    clock,
    globals: { location: { protocol: 'http:', host: 'h' } },
    expose: ['TerminalTool', 'TIMERS', 'OP', 'TERM_MUX', 'SEQ_FLAG_FULL', 'SEQ_FLAG_ALT', 'SEQ_FLAG_SNAP'],
  });
  const unmounted = [];
  ctx.app = {
    isMobile: false,
    focus: { owner: { resizeCheck: () => true } },
    renderer: { life: { unmount: (o) => unmounted.push(o) } },
  };
  const ch = new FakeChannel();
  ctx.TERM_MUX.attach(ch);
  const p = new ctx.TerminalTool('t1', 'tool');
  p._showOverlay = () => {};
  p._hideOverlay = () => {};
  p.resets = 0;
  p.term = { cols: 100, rows: 30, write() {}, scrollToBottom() {}, focus() {}, dispose() {}, reset() { p.resets++ } };
  return { ctx, p, clock, ch, unmounted };
}

const opens = (ch) => ch.sent.filter((m) => m.t === 'term.open');
const closes = (ch) => ch.sent.filter((m) => m.t === 'term.close');

/** 스냅숏 뒤의 `SEQ` — 오프셋 + 깃발 + 첫 기록 줄 번호 + cwd. */
function snapSeq(ctx, offset, { alt = false, firstLine = 0, cwd = '' } = {}) {
  const tail = new TextEncoder().encode(cwd);
  const d = new Uint8Array(1 + 9 + 8 + tail.length);
  d[0] = ctx.OP.SEQ;
  const dv = new DataView(d.buffer);
  dv.setUint32(1, Math.floor(offset / 4294967296), false);
  dv.setUint32(5, offset >>> 0, false);
  d[9] = ctx.SEQ_FLAG_FULL | ctx.SEQ_FLAG_SNAP | (alt ? ctx.SEQ_FLAG_ALT : 0);
  dv.setUint32(10, Math.floor(firstLine / 4294967296), false);
  dv.setUint32(14, firstLine >>> 0, false);
  d.set(tail, 18);
  return d;
}

test('한 번도 깨지 않은 터미널은 채널이 준비돼도 붙지 않는다', () => {
  const { ch } = pane();
  ch.hello();
  assert.equal(opens(ch).length, 0);
});

test('깨면 term.open{snap} 을 보낸다 — since 는 싣지 않는다', () => {
  const { p, ch } = pane();
  ch.hello();
  p.wake();
  assert.equal(opens(ch).length, 1);
  assert.equal(opens(ch)[0].snap, true);
  assert.equal(opens(ch)[0].since, undefined);
});

test('잠들면 term.close 를 보내고 그 sid 의 프레임을 받지 않으며 버퍼를 비운다', () => {
  const { ctx, p, ch } = pane();
  ch.hello();
  p.wake();
  const sid = opens(ch)[0].sid;
  p._onOp(snapSeq(ctx, 500));
  p._buf.push('x');
  const got = [];
  const orig = p._onOp.bind(p);
  p._onOp = (d) => { got.push(d); orig(d) };
  p.sleep();
  assert.equal(closes(ch).length, 1);
  assert.equal(closes(ch)[0].sid, sid);
  assert.equal(p.resets, 1, 'xterm 버퍼를 비우지 않았다');
  assert.equal(p._buf.length, 0);
  assert.equal(p._seq, -1, '잠든 뒤 좌표가 남았다');
  ch.frame(ctx.OP.OUTPUT, sid, [65]);
  assert.equal(got.length, 0, '잠든 sid 의 프레임을 받았다');
});

test('잠든 터미널은 채널이 다시 붙어도·재시도 시간이 지나도 다시 열지 않는다', async () => {
  const { p, clock, ch } = pane();
  ch.hello();
  p.wake();
  ch.lose();               // 재시도가 걸린다
  p.sleep();
  await clock.advance(20000);
  ch.hello();
  await clock.advance(20000);
  assert.equal(opens(ch).length, 1);
  assert.equal(p.reconnectNow(), false, '잠든 터미널을 다시 붙였다');
  assert.equal(opens(ch).length, 1);
});

test('잠든 뒤 깨면 좌표를 알던 터미널도 term.open{snap} 이다', () => {
  const { ctx, p, ch } = pane();
  ch.hello();
  p.wake();
  p._onOp(snapSeq(ctx, 900));
  p.sleep();
  p.wake();
  assert.equal(opens(ch).length, 2);
  assert.equal(opens(ch)[1].snap, true);
  assert.equal(opens(ch)[1].since, undefined);
});

test('스냅숏 SEQ 에는 대체 화면이어도 넛지를 걸지 않는다', async () => {
  const { ctx, p, clock, ch } = pane();
  const sent = [];
  ch.hello();
  p.wake();
  p._send = (m) => sent.push(m);
  p._onOp(snapSeq(ctx, 0, { alt: true }));
  await clock.advance(100);
  assert.equal(sent.filter((m) => m[0] === ctx.OP.RESIZE).length, 0);
  assert.equal(p._seq, 0);
  assert.equal(p._srvAlt, true);
});

test('스냅숏 SEQ 꼬리의 cwd 를 받는다 — 같으면 다시 알리지 않는다', () => {
  const { ctx, p, ch } = pane();
  ch.hello();
  p.wake();
  const seen = [];
  p.output._onCwd = (c) => { seen.push(c); p._cwd = c };
  p._onOp(snapSeq(ctx, 10, { firstLine: 3, cwd: '/tmp/깨움' }));
  p._onOp(snapSeq(ctx, 20, { cwd: '/tmp/깨움' }));
  p._onOp(snapSeq(ctx, 30));
  assert.deepEqual(seen, ['/tmp/깨움']);
});

test('파괴하면 생명주기에서 뗀다', () => {
  const { p, unmounted } = pane();
  p.el.remove = () => {};
  p.destroy();
  assert.deepEqual(unmounted, [p]);
});

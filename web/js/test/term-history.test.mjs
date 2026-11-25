import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CONSTANTS, load, fakeClock, TERM_PANE } from './harness.mjs';

/**
 * PERF M2 §2.7 위로 스크롤 받기 (FR-TRM-5, D-20) — `TermHistory`.
 *
 * 재는 것: ① 스냅숏 `SEQ` 의 첫 기록 줄 번호로 버퍼 맨 윗줄 번호를 세고, 맨 위에서 더 올리면 그 줄까지 `term.history`
 * 로 묻는다 ② 답의 마지막 줄이 맨 윗줄과 같으면 그 줄을 빼고 기록 보기를 연다 ③ 기록 보기 맨 위에 닿으면 다음 구간을
 * 묻고 위에 붙인다 — 저장소 맨 위(`top`)에 닿으면 더 묻지 않는다 ④ 글자가 어긋나거나 번호를 모르면 한 번 다시 깨워
 * 스냅숏으로 번호를 세운 뒤 다시 묻는다 ⑤ Esc 는 닫고 삼키고, 다른 키는 닫고 터미널로 보낸다 ⑥ 묻는 동안 입력은 간다.
 */
class FakeChannel {
  constructor() { this.isReady = false; this.sent = []; this.bin = []; this.raw = new Map(); this.binFns = [] }
  ready() { return this.isReady }
  send(v) { if (!this.isReady) return false; this.sent.push(v); return true }
  sendBinary(b) { if (!this.isReady) return false; this.bin.push(b); return true }
  on(t, fn) { if (!this.raw.has(t)) this.raw.set(t, []); this.raw.get(t).push(fn); return { stop() {} } }
  onBinary(fn) { this.binFns.push(fn); return { stop() {} } }
  fire(t, m = {}) { for (const fn of this.raw.get(t) || []) fn(Object.assign({ t }, m)) }
  hello() { this.isReady = true; this.fire('hello') }
}

/** 행 `rows`(글자·감쌈)를 든 실시간 xterm 흉내. 표지는 버퍼 행에 붙는다. */
function fakeTerm(rows) {
  const buf = {
    type: 'normal', cursorY: 0, viewportY: 0,
    get baseY() { return Math.max(0, rows.length - 2) },
    get length() { return rows.length },
    getLine(i) { const r = rows[i]; return r && { isWrapped: !!r.w, translateToString: () => r.s } },
  };
  return {
    cols: 80, rows: 2, buffer: { active: buf }, options: { theme: {} }, scrolled: 0,
    write(_d, cb) { if (cb) cb() },
    registerMarker(off) { return { line: buf.baseY + buf.cursorY + off, onDispose() {}, dispose() {} } },
    scrollToBottom() { this.scrolled++ }, focus() {}, reset() {}, dispose() {},
  };
}

function fakeView() {
  const b = { length: 0, viewportY: 0, baseY: 0 };
  return {
    buffer: { active: b }, writes: [],
    onScroll(f) { this.sf = f },
    reset() {},
    write(d, cb) { this.writes.push(d); b.length = d.split('\r\n').length; if (cb) cb() },
    scrollToLine(y) { this.line = y }, scrollToBottom() {},
    dispose() { this.disposed = true },
  };
}

function pane(rows) {
  const ctx = load(['core/i18n.js', 'i18n/ko.js', ...CONSTANTS, 'core/timer-hub.js', 'ui/clipboard.js', 'ui/term-clipboard.js', ...TERM_PANE], {
    clock: fakeClock(),
    globals: { location: { protocol: 'http:', host: 'h' } },
    expose: ['TerminalTool', 'OP', 'TERM_MUX', 'SEQ_FLAG_FULL', 'SEQ_FLAG_SNAP', 'TERM_HISTORY_CHUNK'],
  });
  ctx.app = { isMobile: false, focus: { owner: { resizeCheck: () => true } }, renderer: { life: { unmount() {} } } };
  const ch = new FakeChannel();
  ctx.TERM_MUX.attach(ch);
  const p = new ctx.TerminalTool('t1', 'tool');
  p._showOverlay = () => {}; p._hideOverlay = () => {};
  p.term = fakeTerm(rows);
  const views = [];
  p.history._makeView = () => { const v = fakeView(); views.push(v); return v };
  ch.hello();
  p.wake();
  return { ctx, p, ch, views };
}

function snapSeq(ctx, firstLine) {
  const d = new Uint8Array(1 + 9 + 8);
  d[0] = ctx.OP.SEQ;
  const dv = new DataView(d.buffer);
  d[9] = ctx.SEQ_FLAG_FULL | ctx.SEQ_FLAG_SNAP;
  dv.setUint32(10, Math.floor(firstLine / 4294967296), false);
  dv.setUint32(14, firstLine >>> 0, false);
  return d;
}

const asks = (ch) => ch.sent.filter((m) => m.t === 'term.history');
const answer = (ch, p, m) => ch.fire('term.history', Object.assign({ sid: p._sock.sid }, m));
const rows = (...ss) => ss.map((s) => (typeof s === 'string' ? { s } : s));

test('맨 위에서 더 올리면 맨 윗줄까지 묻고, 맞으면 그 줄을 빼고 기록 보기를 연다', () => {
  const { ctx, p, ch, views } = pane(rows('L100', 'L101', 'L102', '$ '));
  p._onOp(snapSeq(ctx, 100));
  p.history.onUp();
  assert.deepEqual(asks(ch).map((m) => [m.before, m.count]), [[101, ctx.TERM_HISTORY_CHUNK + 1]]);
  answer(ch, p, { from: 98, top: 0, lines: ['L98', 'L99', '\x1b[1mL100\x1b[0m'] });
  assert.equal(views.length, 1);
  assert.ok(views[0].writes[0].endsWith('L98\r\nL99'));
  assert.equal(p.history.isOpen, true);
});

test('감싼 행은 한 줄로 센다 — 표지 위 논리 줄 수만큼 뺀다', () => {
  const { ctx, p, ch } = pane(rows('aaaa', { s: 'bb', w: true }, 'c', 'd', '$ '));
  p._onOp(snapSeq(ctx, 7));
  p.history.track();
  assert.equal(p.history.topNo(), 7);
  p.history.onUp();
  assert.equal(asks(ch)[0].before, 8);
});

test('기록 보기 맨 위에 닿으면 다음 구간을 묻고 위에 붙인다 — 저장소 맨 위에서는 멈춘다', () => {
  const { ctx, p, ch, views } = pane(rows('L50', '$ '));
  p._onOp(snapSeq(ctx, 50));
  p.history.onUp();
  answer(ch, p, { from: 40, top: 30, lines: ['L40', 'L41', 'L42', 'L43', 'L44', 'L45', 'L46', 'L47', 'L48', 'L49', 'L50'] });
  const v = views[0];
  v.sf(0);
  assert.deepEqual([asks(ch)[1].before, asks(ch)[1].count], [40, ctx.TERM_HISTORY_CHUNK]);
  v.sf(0);
  assert.equal(asks(ch).length, 2, '답을 기다리는 동안 두 번 물었다');
  answer(ch, p, { from: 30, top: 30, lines: ['L30', 'L31', 'L32', 'L33', 'L34', 'L35', 'L36', 'L37', 'L38', 'L39'] });
  assert.ok(v.writes[1].startsWith('\x1b[?25lL30\r\n'));
  assert.equal(v.line, 10, '보던 자리를 지키지 않았다');
  v.sf(0);
  assert.equal(asks(ch).length, 2, '저장소 맨 위인데 또 물었다');
});

test('글자가 어긋나면 한 번 다시 깨워 스냅숏으로 번호를 세운 뒤 다시 묻는다', () => {
  const { ctx, p, ch, views } = pane(rows('L100', '$ '));
  p._onOp(snapSeq(ctx, 100));
  p.history.onUp();
  const opens = () => ch.sent.filter((m) => m.t === 'term.open').length;
  const n = opens();
  answer(ch, p, { from: 90, top: 0, lines: ['x', 'L99'] });
  assert.equal(views.length, 0);
  assert.ok(ch.sent.some((m) => m.t === 'term.close'), '다시 깨우지 않았다');
  assert.equal(opens(), n + 1);
  p._onOp(snapSeq(ctx, 95));
  assert.equal(asks(ch).length, 2);
  assert.equal(asks(ch)[1].before, 96);
  answer(ch, p, { from: 90, top: 0, lines: ['y', 'z'] });
  assert.equal(views.length, 1, '두 번째도 어긋나면 받은 것을 쓴다');
});

test('번호를 모르면(스냅숏 전) 다시 깨운 뒤 묻는다', () => {
  const { ctx, p, ch } = pane(rows('L5', '$ '));
  p.history.onUp();
  assert.equal(asks(ch).length, 0);
  assert.ok(ch.sent.some((m) => m.t === 'term.close'));
  p._onOp(snapSeq(ctx, 5));
  assert.deepEqual(asks(ch).map((m) => m.before), [6]);
});

test('Esc 는 닫고 삼킨다. 다른 키는 닫고 터미널로 보낸다. 수식 키는 닫지 않는다', () => {
  const { ctx, p, ch, views } = pane(rows('L9', '$ '));
  const openView = () => { p._onOp(snapSeq(ctx, 9)); p.history.onUp(); answer(ch, p, { from: 8, top: 0, lines: ['L8', 'L9'] }) };
  openView();
  assert.equal(p.history.onKey({ type: 'keydown', key: 'Shift' }), false);
  assert.equal(p.history.isOpen, true);
  assert.equal(p.history.onKey({ type: 'keydown', key: 'Escape' }), true);
  assert.equal(p.history.isOpen, false);
  assert.equal(views[0].disposed, true);
  openView();
  assert.equal(p.history.onKey({ type: 'keydown', key: 'a' }), false);
  assert.equal(p.history.isOpen, false);
});

test('답을 기다리는 동안에도 입력은 서버로 간다', () => {
  const { ctx, p, ch } = pane(rows('L9', '$ '));
  p._onOp(snapSeq(ctx, 9));
  p.history.onUp();
  const n = ch.bin.length;
  p._send(new Uint8Array([ctx.OP.INPUT, 0x61]));
  assert.equal(ch.bin.length, n + 1);
});

test('답을 기다리는 동안 입력하면 답이 와도 열지 않는다', () => {
  const { ctx, p, ch, views } = pane(rows('L9', '$ '));
  p._onOp(snapSeq(ctx, 9));
  p.history.onUp();
  assert.equal(p.history.onKey({ type: 'keydown', key: 'e' }), false);
  answer(ch, p, { from: 8, top: 0, lines: ['L8', 'L9'] });
  assert.equal(views.length, 0);
});

test('번호를 크게 셌으면 받은 줄에서 맨 윗줄을 찾아 그 앞까지만 쓴다 — 다시 깨우지 않는다', () => {
  const { ctx, p, ch, views } = pane(rows('L100', '$ '));
  p._onOp(snapSeq(ctx, 103));
  p.history.onUp();
  answer(ch, p, { from: 98, top: 0, lines: ['L98', 'L99', 'L100', 'L101', 'L102', 'L103'] });
  assert.equal(views.length, 1);
  assert.ok(views[0].writes[0].endsWith('L98\r\nL99'));
  assert.ok(!ch.sent.some((m) => m.t === 'term.close'));
});

test('openHistoryAt(줄 번호): 그 줄이 가운데쯤 오게, 실시간 맨 윗줄 앞까지만 묻는다', () => {
  const { ctx, p, ch, views } = pane(rows('L100', '$ '));
  p._onOp(snapSeq(ctx, 100));
  p.openHistoryAt(40);
  assert.deepEqual([asks(ch)[0].before, asks(ch)[0].count], [42, ctx.TERM_HISTORY_CHUNK]);
  answer(ch, p, { from: 0, top: 0, lines: ['a', 'b'] });
  assert.equal(views.length, 1);
  p.history.close();
  p.openHistoryAt(99);
  assert.equal(asks(ch)[1].before, 100);
});

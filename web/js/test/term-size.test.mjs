import assert from 'node:assert/strict';
import { test } from 'node:test';

import { load, fakeClock } from './harness.mjs';

/**
 * `web/js/ui/term-pane.js` — PTY 크기 통보 (M9_SRS FR-M9-3).
 *
 * 재는 사실은 하나다: **크기의 주인이 아닌 창이 PTY 를 따르는가.** 따르지 않으면
 * 그 창은 같은 바이트를 자기 폭으로 해석하고, 증상은 접수한 것과 같아진다 —
 * 위쪽 글이 깨지거나 앞 몇 줄이 사라진다 (SRS §2.3 M9-B3).
 *
 * 브라우저를 띄우지 않는다. 판정은 순수하고, 필요한 것은 xterm 흉내 하나다.
 */
function pane(opts = {}) {
  const clock = fakeClock();
  const ctx = load(['core/i18n.js', 'i18n/ko.js', 'core/constants.js', 'core/timer-hub.js', 'ui/clipboard.js', 'ui/term-clipboard.js', 'ui/term-pane.js'], {
    clock,
    expose: ['OP', 'TerminalTool', 'TIMERS'],
  });
  // `resizeCheck` 가 크기의 주인을 가른다 (FR-WSL-14). 검사가 그 답을 쥔다.
  ctx.app = { resizeCheck: () => opts.owner !== false, isMobile: false };
  const p = new ctx.TerminalTool('t1', 'tool');
  p.sent = [];
  p._send = (m) => { p.sent.push(m) };
  // xterm 흉내. `resize` 는 실제 xterm 과 같이 **자기 값을 바꾼다**.
  p.fitCalls = 0;
  p.term = {
    cols: 151, rows: 42,
    resize(c, r) { this.cols = c; this.rows = r },
    write() {}, scrollToBottom() {}, focus() {},
  };
  p.fit = { fit: () => { p.fitCalls++; p.term.cols = 151; p.term.rows = 42 } };
  return { ctx, p, clock, OP: ctx.OP };
}

/** 서버가 보내는 `OpSize` 한 벌 — cols 2 + rows 2, 빅엔디언. */
function sizeFrame(OP, cols, rows) {
  const d = new Uint8Array(5);
  d[0] = OP.SIZE;
  const dv = new DataView(d.buffer);
  dv.setUint16(1, cols, false);
  dv.setUint16(3, rows, false);
  return d;
}

// ── FR-M9-3: 비소유자는 따른다 ────────────────────────────────────────────

test('비소유자는 통보받은 PTY 크기로 선다', () => {
  const { p, OP } = pane({ owner: false });
  p._onOp(sizeFrame(OP, 44, 20));
  assert.equal(p.term.cols, 44);
  assert.equal(p.term.rows, 20);
});

test('비소유자는 크기를 PTY 에 되보내지 않는다 — 주인이 흔들리면 안 된다', () => {
  const { p, OP } = pane({ owner: false });
  p._onOp(sizeFrame(OP, 44, 20));
  const resizes = p.sent.filter((m) => m[0] === OP.RESIZE);
  assert.equal(resizes.length, 0);
});

test('소유자는 통보를 따르지 않는다 — 그쪽의 진실은 자기 fit 이다', () => {
  const { p, OP } = pane({ owner: true });
  p._onOp(sizeFrame(OP, 44, 20));
  assert.equal(p.term.cols, 151, '소유자의 폭이 통보에 끌려갔다');
  assert.equal(p.term.rows, 42);
});

// ── FR-M9-3: doFit 이 그것을 되돌리지 않는다 ──────────────────────────────

test('비소유자의 doFit 은 fit 하지 않고 PTY 크기를 지킨다', () => {
  const { p, OP } = pane({ owner: false });
  p._onOp(sizeFrame(OP, 44, 20));
  p.doFit();
  assert.equal(p.fitCalls, 0, 'fit 이 돌아 자기 폭으로 되돌렸다');
  assert.equal(p.term.cols, 44);
  assert.equal(p.term.rows, 20);
});

test('소유자의 doFit 은 종전과 같다', () => {
  const { p } = pane({ owner: true });
  p.doFit();
  assert.equal(p.fitCalls, 1);
});

// ── FR-M9-3: 모르면 따르지 않는다 (옛 서버 호환) ──────────────────────────

test('크기를 받지 못한 비소유자는 종전대로 자기 fit 을 쓴다', () => {
  const { p } = pane({ owner: false });
  p.doFit();
  assert.equal(p.fitCalls, 1, '통보가 없었는데 fit 이 막혔다');
});

test('0 은 쓰지 않는다 — term.resize(0,0) 은 화면을 잃는 일이다', () => {
  const { p, OP } = pane({ owner: false });
  p._onOp(sizeFrame(OP, 0, 0));
  assert.equal(p.term.cols, 151);
  p.doFit();
  assert.equal(p.fitCalls, 1, '모르는 값에 끌려 fit 이 막혔다');
});

test('짧은 프레임은 조용히 버린다', () => {
  const { p, OP } = pane({ owner: false });
  p._onOp(new Uint8Array([OP.SIZE, 1, 2]));
  assert.equal(p.term.cols, 151);
});

// ── FR-M9-3: 255 를 넘는 폭 ───────────────────────────────────────────────

test('cols 가 255 를 넘어도 빅엔디언으로 바로 읽는다', () => {
  const { p, OP } = pane({ owner: false });
  p._onOp(sizeFrame(OP, 300, 41));
  assert.equal(p.term.cols, 300);
  assert.equal(p.term.rows, 41);
});

// ── FR-TRS-9 와 같은 규약: 모르는 op 는 버린다 ────────────────────────────

test('OpSize 를 모르는 옛 클라이언트의 규약 — 분기는 if/else 사슬이다', () => {
  const { p } = pane({ owner: false });
  // 등록되지 않은 op. 던지지 않고 아무 일도 일어나지 않아야 한다.
  p._onOp(new Uint8Array([0x7f, 1, 2, 3]));
  assert.equal(p.term.cols, 151);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { load, fakeClock } from './harness.mjs';

/**
 * `web/js/ui/term-pane.js` — 소유권 이동의 전량 재생은 **한 벌**이다
 * (OWNER_TRANSFER_REPLAY_SRS FR-OTR-1~5).
 *
 * 종전에는 재생을 거는 자리가 둘이었고 **서로 다른 쪽의 화면**이었다:
 *
 *   되찾는 쪽  `ptySize()`      — 자기 폭으로 되재며 `cols!==had`
 *   잃는 쪽    `_applyPtySize()` — PTY 폭을 따라가며 `cols!==had`
 *
 * 그래서 소유권이 한 번 움직일 때마다 1 MiB 짜리 재생이 두 벌 돌았다. 잃는 쪽의
 * 것은 아무도 기다리지 않는 일이다 — 그 화면은 dim 이고, 원 설계 결정 E-7 이
 * 이미 *"off-focus 시 dim 이 되므로 정상 동작"* 으로 못박았다.
 *
 * 그래서 **미룬다**. 없애는 것이 아니다 (D-OTR-1) — 되찾으면 반드시 받는다.
 */
function pane(opts = {}) {
  const clock = fakeClock();
  const ctx = load(['core/i18n.js', 'i18n/ko.js', 'core/constants.js', 'core/timer-hub.js', 'ui/term-pane.js'], {
    clock,
    expose: ['OP', 'TerminalTool', 'TIMERS', 'SEQ_FLAG_FULL', 'SEQ_FLAG_ALT'],
  });
  const state = { owner: opts.owner !== false };
  ctx.app = { resizeCheck: () => state.owner, isMobile: false };
  const p = new ctx.TerminalTool('t1', 'tool');
  p._send = () => {};
  // 자기 폭은 151. PTY 가 44 로 오면 잃는 쪽의 폭 변화가 된다.
  p.fitCalls = 0;
  p.term = {
    cols: 151, rows: 42,
    resize(c, r) { this.cols = c; this.rows = r },
    write() {}, scrollToBottom() {}, focus() {},
  };
  p.fit = { fit: () => { p.fitCalls++; p.term.cols = opts.ownWidth || 151; p.term.rows = 42 } };
  let visible = true;
  p.el.classList.contains = (c) => (c === 'vis' ? visible : false);
  return {
    ctx, p, clock, OP: ctx.OP, ctxFlags: { FULL: ctx.SEQ_FLAG_FULL, ALT: ctx.SEQ_FLAG_ALT },
    claim: () => { state.owner = true },
    release: () => { state.owner = false },
  };
}

function sizeFrame(OP, cols, rows) {
  const d = new Uint8Array(5);
  d[0] = OP.SIZE;
  const dv = new DataView(d.buffer);
  dv.setUint16(1, cols, false);
  dv.setUint16(3, rows, false);
  return d;
}

/** 서버가 통보하는 좌표 프레임. 8바이트 오프셋 + 1바이트 플래그. */
function seqFrame(OP, offset, flag) {
  const d = new Uint8Array(10);
  d[0] = OP.SEQ;
  const dv = new DataView(d.buffer, 1, 9);
  dv.setUint32(0, 0, false);
  dv.setUint32(4, offset, false);
  d[9] = flag;
  return d;
}

/** `_refreshForWidth` 를 세는 스파이. 소켓을 실제로 열지 않는다. */
function countRefresh(p) {
  const calls = { n: 0 };
  const real = p._refreshForWidth.bind(p);
  p._refreshForWidth = () => { calls.n++; void real; return true };
  return calls;
}

// ── FR-OTR-1: 잃는 쪽은 미룬다 ────────────────────────────────────────────

test('비소유가 되어 폭이 바뀌어도 전량 재생을 걸지 않는다 (FR-OTR-1)', () => {
  const h = pane({ owner: true });
  h.p.doFit();
  h.release();
  const c = countRefresh(h.p);

  h.p._onOp(sizeFrame(h.OP, 44, 20));   // 상대가 44 로 잡는다

  assert.equal(h.p.term.cols, 44, 'PTY 를 따라가는 것 자체는 그대로여야 한다 (FR-M9-3)');
  assert.equal(c.n, 0, '잃는 쪽이 재생을 걸었다 — 아무도 기다리지 않는 일이다');
});

// ── FR-OTR-2: 되찾는 쪽이 갚는다 ──────────────────────────────────────────

test('되찾으면 미뤄 둔 재생을 건다 (FR-OTR-2)', () => {
  const h = pane({ owner: true });
  h.p.doFit();
  h.release();
  h.p._onOp(sizeFrame(h.OP, 44, 20));
  h.claim();
  const c = countRefresh(h.p);

  h.p.ptySize();

  assert.equal(c.n, 1, '되찾았는데 재생이 없다 — 미룬 것을 갚지 않았다');
});

/**
 * V-OTR-3: **빚이 근거이지 `cols!==had` 가 근거가 아니다.**
 *
 * 되찾을 때의 자기 폭이 따라가던 PTY 폭과 우연히 같으면 `cols!==had` 가 서지
 * 않는다. 빚을 조건에 넣지 않으면 그 화면은 옛 폭의 그림을 영영 든다.
 */
test('되찾을 때 폭이 같아도 빚이 있으면 건다 (FR-OTR-2)', () => {
  const h = pane({ owner: true, ownWidth: 44 });
  h.p.doFit();                          // 자기 폭 44 로 기록
  h.release();
  h.p.term.cols = 151;                  // 상대가 151 로 잡았다가
  h.p._onOp(sizeFrame(h.OP, 44, 20));   // 44 로 바꾼다 → 빚이 선다
  h.claim();
  const c = countRefresh(h.p);

  h.p.ptySize();                        // fit 하면 44 — 따라가던 값과 같다

  assert.equal(c.n, 1, 'cols 가 같다는 이유로 미룬 재생이 사라졌다');
});

// ── FR-OTR-3: 빚은 도착으로 갚는다 ────────────────────────────────────────

test('전량 재생이 도착하면 빚이 갚아진다 (FR-OTR-3)', () => {
  const h = pane({ owner: true });
  h.p.doFit();
  h.release();
  h.p._onOp(sizeFrame(h.OP, 44, 20));       // 빚이 선다
  h.p._onOp(seqFrame(h.OP, 100, h.ctxFlags.FULL));  // 전량 재생 도착
  h.claim();
  const c = countRefresh(h.p);

  h.p.ptySize();                             // fit → 151, 따라가던 44 와 다르다

  assert.equal(c.n, 1, '폭이 실제로 바뀌었으므로 한 번은 돌아야 한다');
});

test('델타 재개는 빚을 갚지 않는다 (NFR-OTR-2)', () => {
  const h = pane({ owner: true, ownWidth: 44 });
  h.p.doFit();
  h.release();
  h.p.term.cols = 151;
  h.p._onOp(sizeFrame(h.OP, 44, 20));   // 빚이 선다
  h.p._onOp(seqFrame(h.OP, 100, 0));    // FULL 없는 델타 재개
  h.claim();
  const c = countRefresh(h.p);

  h.p.ptySize();                        // 폭은 같다 — 빚만이 근거다

  assert.equal(c.n, 1, '델타가 빚을 갚아 버렸다 — 델타는 옛 폭의 그림을 못 고친다');
});

// ── FR-OTR-4: 소유자의 폭 변화는 그대로 ───────────────────────────────────

test('소유자의 폭 변화는 종전대로 즉시 재생한다 (FR-OTR-4)', () => {
  const h = pane({ owner: true, ownWidth: 80 });
  h.p.doFit();
  h.p.term.cols = 151;                  // 상자가 바뀌어 다음 fit 이 80 을 낸다
  const c = countRefresh(h.p);

  h.p.ptySize();

  assert.equal(c.n, 1, '소유자의 폭 변화까지 미루면 안 된다');
});

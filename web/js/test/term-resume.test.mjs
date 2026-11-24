import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CONSTANTS, load, fakeClock, TERM_PANE } from './harness.mjs';

/**
 * `web/js/ui/term-pane.js` — 재접속의 좌표 (TERMINAL_RESUME_SRS 묶음 A·E).
 *
 * 여기서 재는 것은 **한 가지 사실**이다: 이 패널이 자기가 본 바이트 수를
 * 정확히 세는가. 그것이 틀리면 서버는 엉뚱한 자리부터 이어 붙이고, 증상은
 * 접수한 것과 똑같아진다 — 글자가 중복되거나 사라진다 (SRS §2.2).
 *
 * 브라우저를 띄우지 않는다. 세는 일은 순수하고, xterm 도 소켓도 필요 없다.
 */
function pane(opts = {}) {
  const clock = fakeClock();
  const ctx = load(['core/i18n.js', 'i18n/ko.js', ...CONSTANTS, 'core/timer-hub.js', 'ui/clipboard.js', 'ui/term-clipboard.js', ...TERM_PANE], {
    clock,
    expose: ['OP', 'TerminalTool', 'TIMERS'],
  });
  // `resizeCheck` 는 크기의 주인을 가르는 판정이다 (FR-TRS-19). 검사가 그 답을 쥔다.
  //
  // 이름에 `_` 가 없는 이유: `FE-4` 가 디렉터리를 넘는 이름을 승격했다
  // (FE_MODULE_BOUNDARY_SRS FR-FMB-40) — `term-pane.js` 가 `ui/` 라 이것이 그
  // 경계를 넘는다. **격리 하네스는 전역을 손으로 세우므로**(C-5) 승격이 이
  // 스텁까지가 그 변경의 범위다.
  ctx.app = { isMobile: false, focus: { owner: { resizeCheck: () => opts.owner !== false } } };
  const p = new ctx.TerminalTool('t1', 'tool');
  // 보낸 프레임을 붙잡는다 — 소켓은 세우지 않는다.
  p.sent = [];
  p._send = (m) => { p.sent.push(m) };
  p.term = { cols: 100, rows: 30, write() {}, scrollToBottom() {}, focus() {} };
  return { ctx, p, clock, OP: ctx.OP };
}

/** 서버가 보내는 `OpSeq` 한 벌. */
// 플래그는 **비트**다 (TERMINAL_RESUME_SRS FR-TRS-18b): bit0 전량, bit1 alt screen.
function seqFrame(OP, offset, full, alt = false) {
  const d = new Uint8Array(10);
  d[0] = OP.SEQ;
  const dv = new DataView(d.buffer);
  dv.setUint32(1, Math.floor(offset / 4294967296), false);
  dv.setUint32(5, offset >>> 0, false);
  d[9] = (full ? 1 : 0) | (alt ? 2 : 0);
  return d;
}

function outFrame(OP, bytes) {
  const d = new Uint8Array(1 + bytes.length);
  d[0] = OP.OUTPUT;
  d.set(bytes, 1);
  return d;
}

// ── FR-TRS-3: since ──────────────────────────────────────────────────────

test('좌표를 모르면 since 를 붙이지 않고 스냅숏을 달라고 한다', () => {
  const { ctx, p } = pane();
  ctx.location = { protocol: 'http:', host: 'h' };
  assert.equal(p._seq, -1);
  assert.equal(p._termOpenArgs().since, undefined);
  assert.equal(p._termOpenArgs().snap, true);
});

test('좌표를 알면 since 로 이어 붙여 달라고 한다', () => {
  const { ctx, p, OP } = pane();
  ctx.location = { protocol: 'http:', host: 'h' };
  p._onOp(seqFrame(OP, 4242, false));
  assert.equal(p._termOpenArgs().since, 4242);
  assert.equal(p._termOpenArgs().snap, undefined);
});

// ── FR-TRS-6: OpSeq 해석 ─────────────────────────────────────────────────

test('오프셋은 8바이트 빅엔디언이다', () => {
  const { p, OP } = pane();
  p._onOp(seqFrame(OP, 1048576, false));
  assert.equal(p._seq, 1048576);
});

test('2^32 를 넘는 오프셋도 정확하다 — 32비트 둘로 읽는다', () => {
  const { p, OP } = pane();
  const big = 8589934592 + 12345; // 2*2^32 + 12345
  p._onOp(seqFrame(OP, big, false));
  assert.equal(p._seq, big);
});

test('잘린 SEQ 프레임은 좌표를 흔들지 않는다', () => {
  const { p, OP } = pane();
  p._onOp(seqFrame(OP, 100, false));
  p._onOp(new Uint8Array([OP.SEQ, 1, 2]));
  assert.equal(p._seq, 100);
});

// ── FR-TRS-7·8: 무엇을 세는가 ────────────────────────────────────────────

test('좌표 통보 앞의 출력은 세지 않는다 — 그것이 재생분이다', () => {
  const { p, OP } = pane();
  p._onOp(outFrame(OP, [1, 2, 3, 4, 5])); // 재생
  assert.equal(p._seq, -1, '재생분을 셌다');
  p._onOp(seqFrame(OP, 500, true));
  assert.equal(p._seq, 500);
});

test('좌표 통보 뒤의 출력은 바이트 길이만큼 더한다', () => {
  const { p, OP } = pane();
  p._onOp(seqFrame(OP, 500, false));
  p._onOp(outFrame(OP, [1, 2, 3]));
  p._onOp(outFrame(OP, [4, 5]));
  assert.equal(p._seq, 505);
});

test('세는 것은 **디코딩 전 바이트**다 — 서버의 좌표가 raw 바이트이기 때문', () => {
  const { p, OP } = pane();
  p._onOp(seqFrame(OP, 0, false));
  // "한" 은 UTF-8 3 바이트다. 글자 수(1)로 세면 좌표가 어긋난다.
  p._onOp(outFrame(OP, [0xed, 0x95, 0x9c]));
  assert.equal(p._seq, 3);
});

test('새 소켓이 열리면 통보 전까지 다시 세지 않는다', () => {
  const { p, OP } = pane();
  p._onOp(seqFrame(OP, 500, false));
  p._onOp(outFrame(OP, [1, 2, 3]));
  assert.equal(p._seq, 503);
  p._onWsOpen(); // 재접속
  p._onOp(outFrame(OP, [9, 9, 9, 9])); // 재생분
  assert.equal(p._seq, 503, '재생분이 좌표를 앞질렀다');
  p._onOp(seqFrame(OP, 700, true));
  assert.equal(p._seq, 700);
});

// ── PERF D-19: 넛지는 없다 ───────────────────────────────────────────────

// 링 전량 재생이 사라졌다. 버퍼를 통째로 바꾸는 것은 화면 상태 스냅숏뿐이고, 스냅숏은 대체 화면·모드까지
// 정확하므로 넛지(rows 를 흔드는 SIGWINCH 두 번)를 걸지 않는다 (`web/js/test/term-wake.test.mjs` 가 SNAP 깃발을 잰다).
test('버퍼를 바꾼 SEQ 뒤에도 rows 를 흔들지 않는다', async () => {
  const { p, clock, OP } = pane();
  p._onOp(seqFrame(OP, 0, true, true));
  await clock.advance(50);
  assert.equal(p.sent.filter((m) => m[0] === OP.RESIZE).length, 0);
});

// ── FR-TRS-4: 디코더 상태 ────────────────────────────────────────────────

test('이어 붙일 좌표가 있으면 디코더를 지우지 않는다 — 걸친 글자를 잃는다', () => {
  const { p, OP } = pane();
  p._onOp(seqFrame(OP, 10, false));
  const before = p._decoder;
  p._resetDecoderIfNoResume();
  assert.equal(p._decoder, before);
});

test('좌표가 없으면 지운다 — 전량 재생은 별개의 바이트열이다', () => {
  const { p } = pane();
  const before = p._decoder;
  p._resetDecoderIfNoResume();
  assert.notEqual(p._decoder, before);
});

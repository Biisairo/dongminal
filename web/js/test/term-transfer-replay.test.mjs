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
    // xterm 의 활성 버퍼는 **언제나 normal 이다** — 실측(2026-09-24): 전량 재생은
    // `?1049l` 로 시작하고 서버는 대체 화면을 복원하지 않으므로, 앱이 대체 화면
    // 안이어도 클라이언트는 normal 에 남는다. 그래서 이것은 판정 재료가 아니다 (FR-OTR-9).
    buffer: { active: { type: 'normal' } },
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
    // 이 연결의 좌표를 받은 **라이브** 상태로 만든다 — 실제로 되찾기가 일어나는
    // 순간의 pane 은 언제나 이 상태다. 대체 화면인지는 **서버가** 좌표와 함께 말한다.
    live: () => { p._onOp(seqFrame(ctx.OP, 1, opts.alt ? ctx.SEQ_FLAG_ALT : 0)) },
    // 라이브 구간에서 앱이 대체 화면을 벗어난다 — xterm 파서가 `CSI ? 1049 l` 을 본다.
    altExit: () => p._onAltMode([1049], false),
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

/**
 * `_refreshForWidth` 를 세는 스파이. **진짜를 부른다** — 좌표를 버리고 라이브를
 * 내리는 것(`_seqLive=false`, 재생 진행 중)까지가 그 함수의 일이고, FR-OTR-8 이
 * 딛는 사실이 바로 그것이다. `ws` 가 없으므로 소켓은 열지 않고 물러난다.
 */
function countRefresh(p) {
  const calls = { n: 0 };
  const real = p._refreshForWidth.bind(p);
  p._refreshForWidth = () => { calls.n++; return real() };
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
  h.live();                             // 되찾기는 라이브 구간에서 일어난다 (FR-OTR-8)
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

// ── FR-OTR-8: 재생이 진행 중이면 빚은 근거가 아니다 (§2.6) ─────────────────

/**
 * V-OTR-7: **되찾는 한 번에 `ptySize()` 는 두 번 불린다** — `_focusWindow` 의
 * `resendWindowSizes` 와, 한 프레임 뒤 render 의 `_afterLayout`. 둘째가 첫째의
 * 재생이 끝나기 전에 오고, 빚은 FULL `OpSeq` 가 도착해야 지워지므로(FR-OTR-3)
 * 가드가 없으면 둘째가 재생을 또 요청하며 첫째를 끊는다.
 */
test('되찾을 때 ptySize 가 두 번 불려도 재생은 한 번이다 (FR-OTR-8)', () => {
  const h = pane({ owner: true });
  h.p.doFit();
  h.live();
  h.release();
  h.p._onOp(sizeFrame(h.OP, 44, 20));   // 따라가며 빚이 선다
  h.claim();
  const c = countRefresh(h.p);

  h.p.ptySize();                        // ① _focusWindow → resendWindowSizes
  h.p.ptySize();                        // ② render → _afterLayout → resendWindowSizes

  assert.equal(c.n, 1, '둘째 호출이 재생을 또 요청했다 — 첫째 재생을 끊는 헛재생이다');
});

// ── FR-OTR-6: 대체 화면은 재생 대신 앱의 재그리기에 맡긴다 ─────────────────

test('서버가 대체 화면이라 하면 xterm 이 normal 이어도 재생을 건너뛴다 (FR-OTR-6·9 — 실측의 상황)', () => {
  const h = pane({ owner: true, alt: true });
  h.p.doFit();
  h.live();
  h.release();
  h.p._onOp(sizeFrame(h.OP, 44, 20));
  h.claim();
  const c = countRefresh(h.p);

  const s = h.p.ptySize();

  assert.equal(c.n, 0, '대체 화면에서 1 MiB 재생을 걸었다 — 화면에 나오지도 않는 스크롤백이다');
  assert.equal(h.p._widthDebt, true, '빚을 버렸다 — 대체 화면을 벗어날 때 갚을 근거가 사라진다');
  assert.equal(s.cols, 151, '자기 폭이 PTY 로 나가야 앱이 SIGWINCH 로 다시 그린다');
});

test('일반 화면에서 되찾으면 종전대로 재생한다 (FR-OTR-6 · V-OTR-12)', () => {
  const h = pane({ owner: true });
  h.p.doFit();
  h.live();
  h.release();
  h.p._onOp(sizeFrame(h.OP, 44, 20));
  h.claim();
  const c = countRefresh(h.p);

  h.p.ptySize();

  assert.equal(c.n, 1, '일반 화면의 스크롤백은 새 폭으로 다시 파싱돼야 한다 (FR-M10-2)');
});

// ── FR-OTR-7: 대체 화면을 벗어나는 순간 갚는다 ────────────────────────────

test('빚이 선 채로 대체 화면을 벗어나면 그때 갚는다 (FR-OTR-7)', () => {
  const h = pane({ owner: true, alt: true });
  h.p.doFit();
  h.live();
  h.release();
  h.p._onOp(sizeFrame(h.OP, 44, 20));
  h.claim();
  h.p.ptySize();                        // 대체 화면 — 빚으로 둔다
  const c = countRefresh(h.p);

  h.altExit();

  assert.equal(c.n, 1, '스크롤백이 드러났는데 옛 폭의 그림 그대로다');
});

/**
 * V-OTR-10: **재생 도중의 버퍼 전환은 앱의 것이 아니다.** 재생은 `termHardClear`
 * 의 `?1049l` 로 시작하고 tail 안에도 `?1049h/l` 이 섞여 있다. 그것을 "앱이 대체
 * 화면을 벗어났다" 로 읽으면 재생이 재생을 부른다.
 */
test('재생 진행 중의 버퍼 전환으로는 갚지 않는다 — 재생이 재생을 부르지 않는다 (FR-OTR-8)', () => {
  const h = pane({ owner: true, alt: true });
  h.p.doFit();
  h.p._widthDebt = true;
  // `_seqLive` 가 거짓 — 이 연결의 OpSeq 를 아직 받지 못했다. 재생이 흐르는 중이다.
  const c = countRefresh(h.p);

  h.altExit();

  assert.equal(c.n, 0, '재생 바이트 속의 ?1049l 을 앱의 이탈로 읽었다 — 고리가 된다');
});

test('PTY 를 따르는 중이면 대체 화면을 벗어나도 갚지 않는다 (FR-OTR-7)', () => {
  const h = pane({ owner: true, alt: true });
  h.p.doFit();
  h.live();
  h.release();
  h.p._onOp(sizeFrame(h.OP, 44, 20));   // 비소유로 따라가며 빚이 선다
  const c = countRefresh(h.p);

  h.altExit();

  assert.equal(c.n, 0, '비소유의 빚은 되찾을 때 갚는다 — 여기서 갚으면 FR-OTR-1 을 되돌린다');
});

test('빚이 없으면 대체 화면을 벗어나도 재생하지 않는다 (FR-OTR-7)', () => {
  const h = pane({ owner: true, alt: true });
  h.p.doFit();
  h.live();
  const c = countRefresh(h.p);

  h.altExit();

  assert.equal(c.n, 0, '갚을 것이 없는데 1 MiB 를 다시 받았다');
});

// ── FR-OTR-9: 판정의 권위는 서버의 AltScreen 이다 ────────────────────────────

/**
 * 라이브 구간에서 앱이 대체 화면에 **들어가는 것**도 따라간다. 좌표(`OpSeq`)는
 * 접속 때만 오므로, 그 뒤의 진입은 xterm 파서가 서버와 같은 바이트를 보고 안다.
 */
test('라이브 구간의 대체 화면 진입을 따라가 다음 되찾기에서 건너뛴다 (FR-OTR-9)', () => {
  const h = pane({ owner: true });
  h.p.doFit();
  h.live();                             // 접속 때는 일반 화면이었다
  h.p._onAltMode([1049], true);         // 그 뒤 claude 가 대체 화면에 들어간다
  h.release();
  h.p._onOp(sizeFrame(h.OP, 44, 20));
  h.claim();
  const c = countRefresh(h.p);

  h.p.ptySize();

  assert.equal(c.n, 0, '접속 뒤의 대체 화면 진입을 놓쳤다 — 1 MiB 재생이 되살아난다');
});

test('대체 화면과 무관한 CSI ? h/l 은 판정을 바꾸지 않는다 (FR-OTR-9)', () => {
  const h = pane({ owner: true, alt: true });
  h.p.doFit();
  h.live();
  h.p._onAltMode([25], false);          // 커서 감춤 — 대체 화면이 아니다
  h.p._onAltMode([2004], false);        // 괄호 붙여넣기 끔
  h.release();
  h.p._onOp(sizeFrame(h.OP, 44, 20));
  h.claim();
  const c = countRefresh(h.p);

  h.p.ptySize();

  assert.equal(c.n, 0, '엉뚱한 모드 전환을 대체 화면 이탈로 읽었다');
});

test('파서 훅은 xterm 의 처리를 가로채지 않는다 — false 를 돌려준다 (FR-OTR-9)', () => {
  const h = pane({ owner: true, alt: true });
  h.live();
  assert.equal(h.p._onAltMode([1049], true), false, 'true 를 돌려주면 xterm 이 모드 전환을 삼킨다');
  assert.equal(h.p._onAltMode([7], true), false);
});

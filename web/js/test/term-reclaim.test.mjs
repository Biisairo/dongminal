import assert from 'node:assert/strict';
import { test } from 'node:test';

import { load, fakeClock } from './harness.mjs';

/**
 * `web/js/ui/term-pane.js` — 소유권을 되찾은 창이 자기 폭을 되찾는다
 * (M10_SRS FR-M10-1·2).
 *
 * 재는 사실은 둘이다:
 *
 *   ① 되찾을 때 PTY 로 나가는 값이 **자기 폭**인가. 비소유 동안 따라간 PTY 폭이
 *      나가면 PTY 는 그대로이고, 사용자는 새로고침을 해야 한다 (SRS §2.2)
 *   ② 폭이 바뀌었을 때 **전량 재생**을 다시 받는가. 그것이 스크롤백을 새 폭으로
 *      다시 파싱하는 유일한 길이다 (SRS §2.3)
 *
 * `term-size.test.mjs` 가 재는 것은 따라가기(FR-M9-3)이고, 이 파일이 재는 것은
 * 그 따라가기가 **끝나는 순간**이다. 둘은 배타적이다 (D-M10-1).
 */
function pane(opts = {}) {
  const clock = fakeClock();
  const ctx = load(['core/i18n.js', 'i18n/ko.js', 'core/constants.js', 'core/timer-hub.js', 'ui/term-pane.js'], {
    clock,
    expose: ['OP', 'TerminalTool', 'TIMERS'],
  });
  // 소유는 검사가 쥔다. `owner` 는 **바뀔 수 있는 값**이다 — 이 파일이 재는 것이
  // 그 전이이므로, term-size 의 고정 답과 달리 상자에 담는다.
  const state = { owner: opts.owner !== false };
  ctx.app = { resizeCheck: () => state.owner, isMobile: false };
  const p = new ctx.TerminalTool('t1', 'tool');
  p.sent = [];
  p._send = (m) => { p.sent.push(m) };
  // xterm 흉내. `fit` 은 **상자의 폭**을 답한다 — 그것이 자기 폭의 출처다.
  p.fitCalls = 0;
  p.term = {
    cols: 151, rows: 42,
    resize(c, r) { this.cols = c; this.rows = r },
    write() {}, scrollToBottom() {}, focus() {},
  };
  p.fit = { fit: () => { p.fitCalls++; p.term.cols = 151; p.term.rows = 42 } };
  // 보이는 pane 인지는 `vis` 클래스가 가른다 (renderer 의 규약).
  let visible = opts.visible !== false;
  p.el.classList.contains = (c) => (c === 'vis' ? visible : false);
  return {
    ctx, p, clock, OP: ctx.OP,
    claim: () => { state.owner = true },
    release: () => { state.owner = false },
    hide: () => { visible = false },
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

/** `_refreshForWidth` 를 세는 스파이. 소켓을 실제로 열지 않는다. */
function countRefresh(p) {
  const calls = { n: 0 };
  p._refreshForWidth = () => { calls.n++; return true };
  return calls;
}

// ── FR-M10-1: 따라가도 자기 폭을 잃지 않는다 ──────────────────────────────

test('비소유가 되어 PTY 를 따라가도 자기 폭은 남는다', () => {
  const { p, OP } = pane({ owner: true });
  p.doFit();                       // 소유자로서 자기 폭을 잰다
  const { release } = pane();      // (형식만 맞춘 호출 — 아래에서 다시 쓴다)
  void release;
  assert.equal(p._ownCols, 151, '소유자로서 잰 자기 폭이 기록되지 않았다');
  assert.equal(p._ownRows, 42);
});

test('_applyPtySize 는 자기 폭을 덮지 않는다 — 두 진실을 한 칸에 담지 않는다', () => {
  const h = pane({ owner: true });
  h.p.doFit();
  h.release();
  h.p._onOp(sizeFrame(h.OP, 44, 20));
  assert.equal(h.p.term.cols, 44, 'PTY 를 따라가지 않았다 (FR-M9-3)');
  assert.equal(h.p._ownCols, 151, '따라가기가 자기 폭을 먹었다 — M10-B1 의 자리다');
  assert.equal(h.p._ownRows, 42);
});

// ── FR-M10-1: 되찾으면 자기 폭이 나간다 ───────────────────────────────────

test('되찾은 창은 자기 폭으로 되잰다 — 물려받은 PTY 폭이 아니다', () => {
  const h = pane({ owner: true });
  h.p.doFit();
  h.release();
  h.p._onOp(sizeFrame(h.OP, 44, 20));   // 모바일이 소유 → 44 로 따라간다
  h.claim();                            // 포커스가 돌아온다
  countRefresh(h.p);
  const s = h.p.ptySize();
  assert.equal(s.cols, 151, '되찾았는데 물려받은 44 가 나갔다 (M10-B1)');
  assert.equal(s.rows, 42);
});

test('숨은 pane 은 fit 을 돌리지 않고 기억한 자기 폭을 쓴다', () => {
  const h = pane({ owner: true });
  h.p.doFit();
  const before = h.p.fitCalls;
  h.release();
  h.p._onOp(sizeFrame(h.OP, 44, 20));
  h.hide();
  h.claim();
  countRefresh(h.p);
  const s = h.p.ptySize();
  assert.equal(h.p.fitCalls, before, '상자가 없는 pane 에 fit 을 걸었다 — 폭을 잃는 길이다');
  assert.equal(s.cols, 151);
  assert.equal(s.rows, 42);
});

test('한 번도 소유한 적 없는 pane 은 지금 term 크기를 쓴다', () => {
  const h = pane({ owner: true });
  h.hide();
  countRefresh(h.p);
  const s = h.p.ptySize();
  assert.equal(s.cols, 151);
  assert.equal(s.rows, 42);
});

// ── FR-M10-2: 폭이 바뀌면 전량 재생 ───────────────────────────────────────

test('되찾기로 폭이 바뀌면 전량 재생을 한 번 받는다', () => {
  const h = pane({ owner: true });
  h.p.doFit();
  h.release();
  h.p._onOp(sizeFrame(h.OP, 44, 20));
  h.claim();
  const c = countRefresh(h.p);
  h.p.ptySize();
  assert.equal(c.n, 1, '폭이 44 에서 151 로 돌아왔는데 스크롤백을 다시 그리지 않았다');
});

test('폭이 그대로면 전량 재생을 받지 않는다', () => {
  const h = pane({ owner: true });
  h.p.doFit();
  const c = countRefresh(h.p);
  h.p.ptySize();
  assert.equal(c.n, 0, '폭이 같은데 tail 을 통째로 다시 받았다');
});

test('PTY 를 따라가 폭이 바뀐 쪽도 전량 재생을 받는다', () => {
  const h = pane({ owner: true });
  h.p.doFit();
  h.release();
  const c = countRefresh(h.p);
  h.p._onOp(sizeFrame(h.OP, 44, 20));
  assert.equal(c.n, 1, '따라가서 폭이 바뀌었는데 스크롤백이 옛 폭으로 남았다');
});

test('같은 크기의 통보는 전량 재생을 부르지 않는다 — 멱등이다', () => {
  const h = pane({ owner: true });
  h.p.doFit();
  h.release();
  h.p._onOp(sizeFrame(h.OP, 44, 20));
  const c = countRefresh(h.p);
  h.p._onOp(sizeFrame(h.OP, 44, 20));
  assert.equal(c.n, 0);
});

// ── FR-M10-2: 재생 요청은 좌표를 버린다 ───────────────────────────────────

test('전량 재생 요청은 좌표를 버린다 — since 가 있으면 서버는 이어 붙인다', () => {
  const h = pane({ owner: true });
  h.p._seq = 4096;
  h.p._seqLive = true;
  h.p.ws = { close() {} };
  h.p.reconnectNow = () => true;   // 소켓을 실제로 열지 않는다
  h.p._refreshForWidth();
  assert.equal(h.p._seq, -1, '좌표를 들고 재연결하면 델타가 와서 스크롤백이 그대로다');
  assert.equal(h.p._seqLive, false);
});

test('전량 재생 요청은 재연결 오버레이를 띄우지 않는다 — 우리가 거는 갱신이다', () => {
  const h = pane({ owner: true });
  h.p.ws = { close() {} };
  let opts = null;
  h.p.reconnectNow = (o) => { opts = o; return true };
  h.p._refreshForWidth();
  assert.ok(opts && opts.quiet === true, 'quiet 없이 불러 "다시 연결" 화면이 뜬다');
});

test('종료·파괴된 pane 은 다시 붙지 않는다', () => {
  const h = pane({ owner: true });
  h.p.ws = { close() {} };
  h.p.reconnectNow = () => { throw new Error('불리면 안 된다') };
  h.p._exited = true;
  assert.equal(h.p._refreshForWidth(), false);
  h.p._exited = false; h.p._destroyed = true;
  assert.equal(h.p._refreshForWidth(), false);
});

// ── 회귀 방어: 소유자가 그대로일 때의 동작은 종전과 같다 ──────────────────

test('소유자가 그대로인 창의 doFit 은 종전과 같다', () => {
  const h = pane({ owner: true });
  const c = countRefresh(h.p);
  h.p.doFit();
  assert.equal(h.p.fitCalls, 1);
  assert.equal(c.n, 0, '창 드래그마다 tail 을 통째로 다시 받는다 (D-M10-3)');
});

test('비소유자의 doFit 은 여전히 fit 하지 않는다 (FR-M9-3 을 되돌리지 않는다)', () => {
  const h = pane({ owner: true });
  h.release();
  h.p._onOp(sizeFrame(h.OP, 44, 20));
  const before = h.p.fitCalls;
  h.p.doFit();
  assert.equal(h.p.fitCalls, before, 'D-M10-1 을 어겼다 — 따라가기는 비소유일 때의 규약이다');
  assert.equal(h.p.term.cols, 44);
});

// ── FR-M11-1: 폭이 바뀐 사실은 소켓보다 오래 산다 ─────────────────────────
//
// `!this.ws` 로 물러날 때 좌표를 그대로 두면, 뒤이은 재접속이 `since` 를 달고
// 붙어 **델타**를 받는다. 옛 폭의 그림은 지워지지 않는다 — 그것이 M11-B1 이고,
// 서버 재시작·절전·망 전환이 그 구간을 만든다 (M11_SRS §2.4c·§2.4d).

test('V-M11-1: 소켓이 없어도 폭이 바뀌면 좌표를 버린다', () => {
  const h = pane({ owner: true });
  h.p._seq = 4096;
  h.p._seqLive = true;
  h.p.ws = null;
  h.p.reconnectNow = () => { throw new Error('소켓이 없는데 다시 붙이려 했다 (D-M11-1)') };
  assert.equal(h.p._refreshForWidth(), false, '반환값의 뜻은 "지금 다시 붙였는가" 다');
  assert.equal(h.p._seq, -1, '좌표를 들고 있으면 다음 접속이 델타가 된다 — M11-B1 의 자리다');
  assert.equal(h.p._seqLive, false);
});

test('V-M11-2: 좌표를 버리는 갈래는 디코더 판정을 지난다', () => {
  const h = pane({ owner: true });
  h.p._seq = 4096;
  h.p._outputBuf = '반쪽';
  h.p.ws = null;
  h.p._refreshForWidth();
  assert.equal(h.p._outputBuf, '', '반쪽 멀티바이트가 전량 재생의 첫 바이트에 이어 붙는다 (FR-TRS-4)');
});

test('V-M11-3: 종료·파괴된 pane 은 좌표조차 버리지 않는다', () => {
  for (const flag of ['_exited', '_destroyed']) {
    const h = pane({ owner: true });
    h.p._seq = 4096;
    h.p._seqLive = true;
    h.p.ws = null;
    h.p[flag] = true;
    assert.equal(h.p._refreshForWidth(), false);
    assert.equal(h.p._seq, 4096, `${flag} 인데 좌표를 건드렸다`);
    assert.equal(h.p._seqLive, true);
  }
});

test('V-M11-4: 소켓이 있을 때의 동작은 종전과 같다', () => {
  const h = pane({ owner: true });
  h.p._seq = 4096;
  h.p._seqLive = true;
  h.p.ws = { close() {} };
  let opts = null;
  h.p.reconnectNow = (o) => { opts = o; return true };
  assert.equal(h.p._refreshForWidth(), true);
  assert.equal(h.p._seq, -1);
  assert.equal(h.p._seqLive, false);
  assert.ok(opts && opts.quiet === true);
});

test('V-M11-5: 되찾기가 소켓 없이 폭 전환을 만나면 다음 접속에 since 가 없다', () => {
  const h = pane({ owner: true });
  h.p.doFit();                          // 소유자로서 자기 폭 151 을 잰다
  h.release();
  h.p._onOp(sizeFrame(h.OP, 44, 20));   // 좁은 쪽이 소유 → 44 를 따라간다
  h.p._seq = 4096;                      // 여기까지 델타로 이어 붙고 있었다
  h.p._seqLive = true;
  h.hide();                             // 숨은 pane — doFit 을 돌리지 않는다
  h.claim();                            // 포커스가 돌아온다
  h.p.ws = null;                        // 그런데 소켓은 재접속 중이다
  h.p.reconnectNow = () => { throw new Error('백오프가 도는 중에 하나를 더 걸었다') };
  h.ctx.location = { protocol: 'http:', host: 'h' };
  const s = h.p.ptySize();
  assert.equal(s.cols, 151, '되찾은 폭이 자기 폭이어야 한다 (FR-M10-1)');
  assert.ok(!/since=/.test(h.p._wsURL()), 'since 를 달고 붙으면 델타가 와서 옛 폭의 그림이 남는다 (M11-B1)');
});

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { load, fakeClock, TERM_PANE } from './harness.mjs';

/**
 * UX_BATCH11_SRS — 터미널 복사·붙여넣기 키 규칙(FR-TCP)과 끊긴 동안의 입력 보류(FR-HIN).
 *
 * 클립보드 쓰기·토스트는 대역이다. 재는 것은 **어느 키가 무엇이 되는가**와 **무엇이 언제
 * 소켓으로 나가는가**다 — 클립보드 3단 자체는 FR-ETR-40 의 검사가 잰다.
 */
function pane() {
  const clock = fakeClock();
  const opened = [];
  class FakeWS {
    constructor(url) { this.url = url; this.readyState = 0; this.closed = 0; this.sent = []; opened.push(this) }
    send(m) { this.sent.push(m) }
    close() { this.closed++; this.readyState = 3 }
  }
  const toasts = [];
  const ctx = load(['core/i18n.js', 'i18n/ko.js', 'core/constants.js', 'core/timer-hub.js', 'ui/clipboard.js', 'ui/term-clipboard.js', ...TERM_PANE], {
    clock,
    globals: {
      WebSocket: FakeWS, location: { protocol: 'http:', host: 'h' },
      Toast: { show: (text, kind) => { toasts.push([text, kind]); return {} } },
      ErrorLog: { quiet: (_k, fn) => { try { fn() } catch { /* 대역 */ } } },
    },
    expose: ['TerminalTool', 'OP', 'TOPTS', 'ClipboardWriter', 'TERM_HELD_MAX', 'TERM_OVERLAY_HIDE_MS', 'termHeldPreview'],
  });
  ctx.app = { resizeCheck: () => false, isMobile: false };
  const copied = [];
  let copyOk = true;
  ctx.ClipboardWriter.write = async (text) => { copied.push(text); return copyOk };
  const p = new ctx.TerminalTool('t1', 'tool');
  p.overlays = [];
  p._showOverlay = (title) => { p.overlays.push(title) };
  p._hideOverlay = () => { p.overlays.push('-') };
  p.banners = 0;
  p._heldBanner = () => { p.banners++ };
  let sel = '';
  p.term = {
    hasSelection: () => sel !== '',
    getSelection: () => sel,
    clearSelection: () => { sel = '' },
    scrollToBottom: () => {},
  };
  return {
    ctx, p, clock, opened, copied, toasts,
    select: (s) => { sel = s },
    copyFails: () => { copyOk = false },
  };
}

const openSock = (ws) => { ws.readyState = 1; ws.onopen() };
const dropSock = (ws) => { ws.readyState = 3; ws.onclose() };
const texts = (ws) => ws.sent.filter((m) => m[0] === 0).map((m) => new TextDecoder().decode(m.subarray(1)));
const key = (k, m = {}) => Object.assign({ key: k, type: 'keydown', ctrlKey: false, shiftKey: false, altKey: false, metaKey: false }, m);

// ── FR-TCP ─────────────────────────────────────────────────────────────

test('TC-TCP-1 선택이 있을 때 단독 Ctrl+C 만 복사다 — 모든 플랫폼', () => {
  const { p, select } = pane();
  select('abc');
  for (const mac of [false, true]) {
    assert.equal(p._clipKey(key('c', { ctrlKey: true }), mac), 'copy');
    assert.equal(p._clipKey(key('C', { ctrlKey: true }), mac), 'copy');
    assert.equal(p._clipKey(key('c', { ctrlKey: true, shiftKey: true }), mac), null);
    assert.equal(p._clipKey(key('c', { ctrlKey: true, altKey: true }), mac), null);
    assert.equal(p._clipKey(key('c', { metaKey: true }), mac), null, 'Cmd+C 는 종전 경로다');
  }
  select('');
  assert.equal(p._clipKey(key('c', { ctrlKey: true }), false), null);
});

test('TC-TCP-5 단독 Ctrl+V 는 mac 이 아닐 때만 붙여넣기다', () => {
  const { p } = pane();
  assert.equal(p._clipKey(key('v', { ctrlKey: true }), false), 'paste');
  assert.equal(p._clipKey(key('v', { ctrlKey: true }), true), null);
  assert.equal(p._clipKey(key('v', { ctrlKey: true, shiftKey: true }), false), null, 'Ctrl+Shift+V 는 분할 단축키다');
  assert.equal(p._clipKey(key('v', { ctrlKey: true, altKey: true }), false), null);
});

test('TC-TCP-1·9 사용자 입력 0x03 은 선택이 있으면 복사가 되고 보내지 않는다', async () => {
  const { p, opened, copied, toasts, select } = pane();
  p.connect();
  openSock(opened[0]);
  select('hello');
  p._userInput('\x03');
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(copied, ['hello']);
  assert.equal(p.term.hasSelection(), false, '복사 후 선택이 해제된다');
  assert.deepEqual(texts(opened[0]), []);
  assert.equal(toasts.length, 1);
  assert.equal(toasts[0][1], 'ok');
  // 선택이 없으면 중단이다.
  p._userInput('\x03');
  assert.deepEqual(texts(opened[0]), ['\x03']);
});

test('TC-TCP-3 복사창으로 내려가면(쓰기 실패) 토스트가 없다', async () => {
  const { p, opened, toasts, select, copyFails } = pane();
  p.connect();
  openSock(opened[0]);
  copyFails();
  select('x');
  p._userInput('\x03');
  await new Promise((r) => setImmediate(r));
  assert.equal(toasts.length, 0);
});

test('TC-TCP-4 mac 에서 Option+드래그로 선택을 강제한다', () => {
  const { ctx } = pane();
  assert.equal(ctx.TOPTS.macOptionClickForcesSelection, true);
});

// ── FR-HIN ─────────────────────────────────────────────────────────────

test('TC-HIN-1 한 번도 열린 적 없는 소켓의 여는 중 입력은 종전대로 열리면 보낸다', () => {
  const { p, opened } = pane();
  p.connect();
  p._userInput('a');
  assert.equal(p._sock.heldBytes, 0);
  openSock(opened[0]);
  assert.deepEqual(texts(opened[0]), ['a']);
});

test('TC-HIN-1 열린 뒤 끊긴 동안의 사용자 입력은 보류되고 저절로 나가지 않는다', async () => {
  const { ctx, p, clock, opened } = pane();
  p.connect();
  openSock(opened[0]);
  dropSock(opened[0]);
  p._userInput('ls');                 // 소켓 없음(닫힘)
  await clock.advance(0);             // 재접속 시도 — 여는 중
  p._userInput('\r');                 // 여는 중
  p._sendResize(80, 24);              // 리사이즈는 보류 대상이 아니다
  assert.equal(p._sock.heldBytes, 3);
  assert.ok(p._sock.held.every((m) => m[0] === ctx.OP.INPUT), '리사이즈가 보류함에 들었다');
  openSock(opened[1]);
  await clock.advance(ctx.TERM_OVERLAY_HIDE_MS);
  assert.deepEqual(texts(opened[1]), [], '보류분이 저절로 나갔다');
  assert.equal(p.banners, 1, '재연결 뒤 배너가 한 번 선다');
});

test('TC-HIN-1 보고 응답은 보류하지 않는다', () => {
  const { p, opened } = pane();
  p.connect();
  openSock(opened[0]);
  dropSock(opened[0]);
  p._replySeat = true;
  p._onTermData('\x1b[?1;2c');
  assert.equal(p._sock.heldBytes, 0);
});

test('FR-HIN-5 [보내기]는 담긴 순서대로 보내고 비운다 · [버리기]는 보내지 않는다', async () => {
  const { ctx, p, clock, opened } = pane();
  p.connect();
  openSock(opened[0]);
  dropSock(opened[0]);
  p._userInput('echo ');
  p._userInput('hi\r');
  await clock.advance(0);
  openSock(opened[1]);
  await clock.advance(ctx.TERM_OVERLAY_HIDE_MS);
  // FR-HIN-6: 배너가 떠 있는 동안 친 것은 곧바로 간다.
  p._userInput('x');
  assert.deepEqual(texts(opened[1]), ['x']);
  p._heldSend();
  assert.deepEqual(texts(opened[1]), ['x', 'echo ', 'hi\r']);
  assert.equal(p._sock.heldBytes, 0);

  dropSock(opened[1]);
  p._userInput('rm');
  await clock.advance(1000);
  openSock(opened[2]);
  await clock.advance(ctx.TERM_OVERLAY_HIDE_MS);
  p._heldDiscard();
  assert.deepEqual(texts(opened[2]), []);
  assert.equal(p._sock.heldBytes, 0);
});

test('FR-HIN-7 도구가 끝나면 보류분을 버린다', () => {
  const { ctx, p, opened } = pane();
  p.connect();
  openSock(opened[0]);
  dropSock(opened[0]);
  p._userInput('ls');
  p._onOp(new Uint8Array([ctx.OP.EXIT]));
  assert.equal(p._sock.heldBytes, 0);
});

test('TC-HIN-2 상한을 넘는 입력은 담지 않고 앞부분을 지킨다', () => {
  const { ctx, p, opened } = pane();
  p.connect();
  openSock(opened[0]);
  dropSock(opened[0]);
  p._userInput('a'.repeat(ctx.TERM_HELD_MAX - 1));
  assert.equal(p._sock.heldOver, false);
  p._userInput('bb');
  assert.equal(p._sock.heldBytes, ctx.TERM_HELD_MAX - 1);
  assert.equal(p._sock.heldOver, true);
  assert.equal(ctx.TERM_HELD_MAX, 64 * 1024);
});

test('TC-HIN-3 미리보기는 제어 문자를 ^X 로, 줄바꿈을 ⏎ 로 적고 200자에서 자른다', () => {
  const { ctx } = pane();
  assert.equal(ctx.termHeldPreview('ls\r'), 'ls⏎');
  assert.equal(ctx.termHeldPreview('a\r\nb'), 'a⏎⏎b');
  assert.equal(ctx.termHeldPreview('\x1b[A'), '^[[A');
  assert.equal(ctx.termHeldPreview('\x03\t\x7f'), '^C^I^?');
  assert.equal(ctx.termHeldPreview('한글'), '한글');
  assert.equal(ctx.termHeldPreview('x'.repeat(300)), 'x'.repeat(200));
});

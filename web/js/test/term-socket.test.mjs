import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { load, fakeClock, TERM_PANE } from './harness.mjs';

/**
 * `web/js/ui/term-socket.js` — 터미널 WS 배선 한 벌 (OPTIMIZE_REFACTOR_SRS FR-OPT-12-1 ·
 * FEU-14 · IPC-16 · FEU-15).
 *
 * 재는 것: ① 백오프 수열은 종전과 같고 기다리는 시간에만 ±20% 지터가 얹힌다 ② 소켓 콜백이
 * 한 자리에서 서고, 최초 연결의 콜백도 지금 소켓이 아닌 것에는 답하지 않는다 ③ 송신 큐 상한과
 * 키 매핑이 상수 표에서 온다.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = (rel) => readFileSync(join(HERE, '..', rel), 'utf8');

function pane(rnd = 0.5) {
  const clock = fakeClock();
  const opened = [];
  class FakeWS {
    constructor(url) { this.url = url; this.readyState = 0; this.closed = 0; this.sent = []; opened.push(this) }
    send(m) { this.sent.push(m) }
    close() { this.closed++; this.readyState = 3 }
  }
  const ctx = load(['core/i18n.js', 'i18n/ko.js', 'core/constants.js', 'core/timer-hub.js', 'ui/clipboard.js', 'ui/term-clipboard.js', ...TERM_PANE], {
    clock,
    // 지터의 난수를 쥔다 — 기다리는 시간이 결정적이어야 잴 수 있다.
    globals: { WebSocket: FakeWS, location: { protocol: 'http:', host: 'h' }, Math: Object.assign(Object.create(Math), { random: () => rnd }) },
    expose: ['TerminalTool', 'TIMERS', 'OP', 'termNextRetryDelay', 'termRetryWait', 'TERM_SEND_QUEUE_MAX', 'TERM_KEY_SEQ', 'TERM_OVERLAY_HIDE_MS'],
  });
  ctx.app = { resizeCheck: () => false, isMobile: false };
  const p = new ctx.TerminalTool('t1', 'tool');
  p.overlays = [];
  p._showOverlay = (title) => { p.overlays.push(title) };
  p._hideOverlay = () => { p.overlays.push('-') };
  return { ctx, p, clock, opened };
}

const openSock = (ws) => { ws.readyState = 1; ws.onopen() };
const dropSock = (ws) => { ws.readyState = 3; ws.onclose() };

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

test('재접속은 지터가 얹힌 시간 뒤에 연다 — 저장된 다음 지연은 지터 없이 자란다', async () => {
  const { p, clock, opened } = pane(1);
  p.connect();
  openSock(opened[0]);
  dropSock(opened[0]);           // 첫 재시도: 지연 0
  await clock.advance(0);
  assert.equal(opened.length, 2);
  assert.equal(p._retryDelay, 200);
  dropSock(opened[1]);           // 두 번째: 200 × 1.2 = 240
  await clock.advance(239);
  assert.equal(opened.length, 2, '지터 없이 200 에 열었다');
  await clock.advance(1);
  assert.equal(opened.length, 3);
  assert.equal(p._retryDelay, 500);
});

test('최초 연결의 콜백도 지금 소켓이 아닌 것에는 답하지 않는다 (stale 가드 한 벌)', async () => {
  const { p, clock, opened } = pane();
  p.connect();
  const first = opened[0];
  const other = { readyState: 1, send() {}, close() { throw new Error('지금 소켓을 닫았다') } };
  p.ws = other;
  first.onclose();
  await clock.advance(20000);
  assert.equal(opened.length, 1, '옛 소켓의 close 가 재접속을 걸었다');
  assert.equal(p.ws, other);
  assert.deepEqual(p.overlays, []);
});

test('재접속으로 붙으면 오버레이를 TERM_OVERLAY_HIDE_MS 뒤 한 번 걷는다', async () => {
  const { ctx, p, clock, opened } = pane();
  p.connect();
  openSock(opened[0]);
  dropSock(opened[0]);
  await clock.advance(0);
  openSock(opened[1]);
  assert.equal(p.ws, opened[1]);
  await clock.advance(ctx.TERM_OVERLAY_HIDE_MS - 1);
  assert.ok(!p.overlays.includes('-'));
  await clock.advance(1);
  assert.equal(p.overlays.filter((x) => x === '-').length, 1);
});

test('reconnectNow 는 옛 소켓과 대기 소켓의 콜백을 모두 끊고 닫는다', async () => {
  const { p, clock, opened } = pane();
  p.connect();
  openSock(opened[0]);
  dropSock(opened[0]);
  await clock.advance(0);        // 대기 소켓(아직 열리지 않음)
  const pending = opened[1];
  p.reconnectNow({ quiet: true });
  assert.equal(pending.onclose, null);
  assert.equal(pending.onopen, null);
  assert.equal(pending.closed, 1);
  assert.equal(opened.length, 3);
  assert.equal(p.ws, opened[2]);
});

test('송신 큐 상한은 TERM_SEND_QUEUE_MAX 이고 넘치면 가장 오래된 것을 버린다', () => {
  const { ctx, p } = pane();
  p.ws = { readyState: 0, send() {} };
  for (let i = 0; i < ctx.TERM_SEND_QUEUE_MAX + 6; i++) p._send(new Uint8Array([1, i]));
  assert.equal(p._sendQueue.length, ctx.TERM_SEND_QUEUE_MAX);
  assert.equal(p._sendQueueMax, ctx.TERM_SEND_QUEUE_MAX);
  assert.equal(p._sendDropCount, 6);
  assert.equal(p._sendQueue[0][1], 6);
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

test('WS 배선은 한 자리다 — 소켓을 만드는 곳과 콜백을 다는 곳이 하나씩', () => {
  const src = TERM_PANE.map(SRC).join('\n');
  assert.equal((src.match(/new WebSocket\(/g) || []).length, 1);
  assert.equal((src.match(/\.onopen\s*=\s*\(/g) || []).length, 1);
  assert.equal((src.match(/\.onclose\s*=\s*\(/g) || []).length, 1);
  assert.equal((src.match(/TIMERS\.after\(\s*300\b/g) || []).length, 0, '300ms 리터럴이 남았다');
});

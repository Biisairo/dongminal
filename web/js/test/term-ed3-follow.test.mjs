import assert from 'node:assert/strict';
import { test } from 'node:test';

import { load, fakeClock } from './harness.mjs';

/**
 * `web/js/ui/term-pane.js` — 스크롤백을 지운 뒤에는 바닥을 따른다
 * (ED3_SCROLL_FOLLOW_SRS FR-ESF-1~5).
 *
 * xterm 은 사용자 스크롤 상태에서 ED3(`CSI 3 J`)를 받으면 `ydisp` 가 0 으로 당겨진
 * 채 뒤이은 줄을 따라가지 않는다 — omp 가 크기 변경마다 보내는 "지우고 전부 다시
 * 쓰기"가 맨 위에서 멈추는 이유다 (SRS §2.2).
 */
function pane() {
  const ctx = load(['core/i18n.js', 'i18n/ko.js', 'core/constants.js', 'core/timer-hub.js', 'ui/clipboard.js', 'ui/term-clipboard.js', 'ui/term-pane.js'], {
    clock: fakeClock(),
    expose: ['TerminalTool'],
  });
  ctx.app = { resizeCheck: () => true, isMobile: false };
  const p = new ctx.TerminalTool('t1', 'tool');
  p._send = () => {};
  const parsed = new Set();
  const counts = { bottom: 0 };
  p.term = {
    cols: 100, rows: 30,
    buffer: { active: { type: 'normal' } },
    onWriteParsed(fn) { parsed.add(fn); return { dispose: () => parsed.delete(fn) } },
    scrollToBottom() { counts.bottom++ },
    write() {}, focus() {},
  };
  return {
    p, counts,
    /** xterm 이 한 쓰기의 파싱을 끝냈다고 알린다. */
    writeParsed: () => { for (const fn of [...parsed]) fn() },
    alt: (on) => { p.term.buffer.active.type = on ? 'alternate' : 'normal' },
  };
}

test('V-ESF-1: 일반 화면의 ED3 — 파싱이 끝난 뒤 바닥으로 한 번 보낸다', () => {
  const t = pane();
  t.p._onEraseDisplay([3]);
  assert.equal(t.counts.bottom, 0, '파싱이 끝나기 전에는 보내지 않는다 — 뒤이은 줄이 아직 없다');
  t.writeParsed();
  assert.equal(t.counts.bottom, 1);
  t.writeParsed();
  assert.equal(t.counts.bottom, 1, 'ED3 한 번에 한 번뿐이다');
});

test('V-ESF-2: 대체 화면의 ED3 는 건드리지 않는다', () => {
  const t = pane();
  t.alt(true);
  t.p._onEraseDisplay([3]);
  t.writeParsed();
  assert.equal(t.counts.bottom, 0);
});

test('V-ESF-3: ED3 가 아닌 ED 는 건드리지 않는다', () => {
  const t = pane();
  for (const ps of [[], [0], [1], [2]]) t.p._onEraseDisplay(ps);
  t.writeParsed();
  assert.equal(t.counts.bottom, 0);
});

test('V-ESF-4: 파싱 전의 ED3 여럿은 한 번, 다음 쓰기의 ED3 는 다시 한 번', () => {
  const t = pane();
  t.p._onEraseDisplay([3]);
  t.p._onEraseDisplay([3]);
  t.writeParsed();
  assert.equal(t.counts.bottom, 1);
  t.p._onEraseDisplay([3]);
  t.writeParsed();
  assert.equal(t.counts.bottom, 2);
});

test('V-ESF-5: 훅은 xterm 의 처리를 가로채지 않는다', () => {
  const t = pane();
  for (const ps of [[3], [2], []]) assert.equal(t.p._onEraseDisplay(ps), false);
  t.alt(true);
  assert.equal(t.p._onEraseDisplay([3]), false);
});

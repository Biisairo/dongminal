import assert from 'node:assert/strict';
import { test } from 'node:test';

import { load, fakeClock } from './harness.mjs';

/**
 * `web/js/ui/term-pane.js` — 터미널이 스스로 내는 보고와 사용자의 키를 가르는
 * 자리 (`_onTermData`).
 *
 * 재는 사실은 하나다: **보고는 sticky 수식키를 소비하지 않는다.** sticky 는
 * 대상이 아니어도 소비되는 것이 규약이므로(FR-MTI-15~17), 보고가 그 그물을
 * 지나면 사용자가 눌러 둔 Ctrl 이 조용히 사라진다.
 */
function pane(mods = {}) {
  const clock = fakeClock();
  const ctx = load(['core/i18n.js', 'i18n/ko.js', 'core/constants.js', 'core/timer-hub.js', 'ui/clipboard.js', 'ui/term-clipboard.js', 'ui/term-pane.js'], {
    clock,
    expose: ['TerminalTool', 'TIMERS', 'TERM_REPORT_RE', 'OP'],
  });
  const modKbd = Object.assign({ ctrl: false, alt: false }, mods);
  ctx.app = { resizeCheck: () => true, isMobile: true, modKbd, mkbRefresh() {} };
  const p = new ctx.TerminalTool('t1', 'tool');
  // 보낸 **문자열**만 붙잡는다 — 인코딩은 이 검사의 관심이 아니다.
  p.sentText = [];
  p._sendText = (s) => { p.sentText.push(s) };
  return { ctx, p, modKbd, OP: ctx.OP };
}

// xterm 이 실제로 내는 보고 한 벌. 접수된 증상(2026-09-20)의 재료 그대로다.
const REPORTS = [
  ['포커스 얻음', '\x1b[I'],
  ['포커스 잃음', '\x1b[O'],
  ['DA1 응답', '\x1b[?1;2c'],
  ['DA2 응답', '\x1b[>0;276;0c'],
  ['DSR 응답', '\x1b[0n'],
  ['CPR 응답', '\x1b[24;80R'],
  ['DECXCPR 응답', '\x1b[?56;9R'],
  ['DECRQM 응답', '\x1b[?2026;0$y'],
  ['OSC 색 보고 (ST)', '\x1b]11;rgb:3f3f/3f3f/3f3f\x1b\\'],
  ['OSC 색 보고 (BEL)', '\x1b]11;rgb:3f3f/3f3f/3f3f\x07'],
  ['DECRQSS 응답', '\x1bP1$r0"q\x1b\\'],
];

for (const [name, data] of REPORTS) {
  test(`보고는 sticky 를 소비하지 않는다 — ${name}`, () => {
    const { p, modKbd } = pane({ ctrl: true });
    p._onTermData(data);
    assert.equal(modKbd.ctrl, true, 'Ctrl 이 먹혔다');
    assert.deepEqual(p.sentText, [data], '보고가 변형됐다');
  });
}

// 반증: 사용자의 키는 종전 그대로다. 갈래를 세우며 규약이 바뀌면 안 된다.
test('사용자 키는 sticky 를 소비하고 변형한다', () => {
  const { p, modKbd } = pane({ ctrl: true });
  p._onTermData('a');
  assert.equal(modKbd.ctrl, false, 'Ctrl 이 소비되지 않았다');
  assert.deepEqual(p.sentText, ['\x01']);
});

// 반증: 보고가 아닌 이스케이프(화살표·F 키·마우스)는 사용자의 것이다 —
// sticky 는 대상이 아니어도 소비한다 (FR-MTI-15~17).
for (const [name, data] of [['화살표', '\x1b[A'], ['Home', '\x1b[H'], ['F5', '\x1b[15~'], ['SGR 마우스', '\x1b[<0;10;20M']]) {
  test(`보고가 아닌 것은 sticky 를 소비한다 — ${name}`, () => {
    const { p, modKbd } = pane({ ctrl: true });
    p._onTermData(data);
    assert.equal(modKbd.ctrl, false);
    assert.deepEqual(p.sentText, [data], 'ESC 로 시작하는 것은 변형 대상이 아니다');
  });
}

// 모바일이 아니면 sticky 자체가 없다 — 갈래가 그 경로를 건드리지 않는다.
test('데스크톱에서는 보고도 키도 그대로 나간다', () => {
  const { ctx, p } = pane();
  ctx.app.isMobile = false;
  p._onTermData('\x1b[?2026;0$y');
  p._onTermData('a');
  assert.deepEqual(p.sentText, ['\x1b[?2026;0$y', 'a']);
});

// ── 응답 좌석 (TERM_REPLY_SEAT_SRS 묶음 C) ────────────────────────────────

/** 서버가 보내는 `OpReplySeat` 한 벌. */
function seatFrame(OP, owns) {
  return new Uint8Array([OP.REPLY_SEAT, owns ? 1 : 0]);
}

// 답장과 포커스 보고는 좌석 앞에서 갈린다 — 앞엣것은 질의의 답이고, 뒤엣것은
// 그 창 고유의 사실이다 (FR-RPS-8).
const REPLIES = REPORTS.filter(([, d]) => d !== '\x1b[I' && d !== '\x1b[O');

// V-RPS-10: 통보를 받기 전에는 주인이다 — 좌석을 모르는 서버에 붙은 탭은 종전
// 그대로 돈다 (FR-RPS-9).
test('좌석 통보 전에는 답장을 보낸다', () => {
  const { p } = pane();
  p._onTermData('\x1b[?2026;0$y');
  assert.deepEqual(p.sentText, ['\x1b[?2026;0$y']);
});

// V-RPS-11
test('좌석 통보를 받으면 그 값으로 바뀐다', () => {
  const { p, OP } = pane();
  p._onOp(seatFrame(OP, false));
  assert.equal(p._replySeat, false);
  p._onOp(seatFrame(OP, true));
  assert.equal(p._replySeat, true);
});

// V-RPS-8
for (const [name, data] of REPLIES) {
  test(`좌석의 주인이 아니면 답장을 보내지 않는다 — ${name}`, () => {
    const { p, OP } = pane();
    p._onOp(seatFrame(OP, false));
    p._onTermData(data);
    assert.deepEqual(p.sentText, [], '답장이 새어 나갔다');
  });
}

// V-RPS-9: 포커스 보고는 좌석과 무관하다. 폰에서 터미널을 탭한 사실을 데스크톱이
// 대신 말할 수는 없다.
for (const [name, data] of [['포커스 얻음', '\x1b[I'], ['포커스 잃음', '\x1b[O']]) {
  test(`포커스 보고는 좌석과 무관하게 나간다 — ${name}`, () => {
    const { p, OP } = pane();
    p._onOp(seatFrame(OP, false));
    p._onTermData(data);
    assert.deepEqual(p.sentText, [data]);
  });
}

// 반증: 좌석은 **사용자의 키**를 막지 않는다. 어느 창에서 타이핑해도 같은
// 터미널이 움직이는 것은 의도된 동작이다 (SRS §2.3).
test('좌석의 주인이 아니어도 사용자의 키는 나간다', () => {
  const { p, OP } = pane();
  p._onOp(seatFrame(OP, false));
  p._onTermData('a');
  p._onTermData('\x1b[A');
  assert.deepEqual(p.sentText, ['a', '\x1b[A']);
});

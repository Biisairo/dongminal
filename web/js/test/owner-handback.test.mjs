import assert from 'node:assert/strict';
import { test } from 'node:test';

import { load } from './harness.mjs';

/**
 * `web/js/core/app-focus-owner.js` — 크기를 정할 자격의 **조건이 선 자리**
 * (OWNER_HANDBACK_SRS FR-OHB-9~13).
 *
 * 재는 사실은 하나다: **주인을 먼저 묻는가.**
 *
 * 종전에는 `resizeCheck` 의 첫 줄이 `if(!this.windowFocused) return false` 였다.
 * 그래서 주인이 누구냐를 묻기도 전에 죽었고, 두 가지가 한꺼번에 어긋났다 —
 * 내가 주인인데도 크기를 못 보내고, 주인이 아무도 없는데도 남이 남긴 PTY 폭을
 * 계속 따랐다 (SRS §2.2 실측: `owner:(none) rc:false fp:true cols:201 own:108`).
 *
 * 조건을 없애는 것이 아니라 **자리를 옮기는 것**이다 (D-OHB-2). 주인이 없을
 * 때는 종전 그대로 OS 포커스를 묻는다.
 */
function app(opts = {}) {
  const ctx = load(['core/app-focus-owner.js'], {
    globals: { App: function App() {}, apiPost: () => {}, apiGet: () => Promise.resolve({ ok: false }) },
    expose: ['App'],
  });
  const a = new ctx.App();
  a.windowFocused = opts.focused !== false;
  a._windowFocusOwner = opts.owners || {};
  a.clientId = 'me';
  // 칸 0 의 신원은 clientId 그대로다 (FR-WSL-10).
  a._slotIdentity = (i) => (i ? 'me#' + i : 'me');
  a.slotFocused = () => 0;
  a.slotKey = (id, si) => id + '@' + si;
  a.ws = {
    activeWindow: 'W1',
    windows: [{ id: 'W1', layout: { type: 'pane', tabs: [{ toolId: 't1' }] } }],
  };
  const sent = [];
  a.tools = new Map([['t1@0', {
    term: {},
    ptySize: () => ({ cols: 108, rows: 40 }),
    _send: (m) => { sent.push(m) },
  }]]);
  return { a, sent };
}

/**
 * V-OHB-7: 네 상태. 앞의 둘이 이 묶음이 바꾸는 것이고, 뒤의 둘은 **바뀌지 않아야
 * 하는 것**이다 — 조건을 옮기는 일이 조건을 없애는 일이 되면 안 된다.
 */
test('내가 주인이면 OS 포커스가 없어도 크기는 내 것이다 (FR-OHB-9)', () => {
  const { a } = app({ focused: false, owners: { W1: 'me' } });
  assert.equal(a.resizeCheck('t1', 0), true);
});

test('주인이 없고 OS 포커스도 없으면 종전대로 PTY 를 따른다 (FR-OHB-11)', () => {
  const { a } = app({ focused: false, owners: {} });
  assert.equal(a.resizeCheck('t1', 0), false);
});

test('남이 주인이면 OS 포커스가 있어도 남의 것이다 (FR-XDF-4 그대로)', () => {
  const { a } = app({ focused: true, owners: { W1: 'other' } });
  assert.equal(a.resizeCheck('t1', 0), false);
});

test('주인이 없고 OS 포커스가 있으면 내 것이다 (FR-XDF-13 의 남은 절반)', () => {
  const { a } = app({ focused: true, owners: {} });
  assert.equal(a.resizeCheck('t1', 0), true);
});

/**
 * FR-WSL-14: 같은 창이 두 칸에 있으면 한쪽만 주인이다. 조건을 옮기면서 칸을
 * 묻는 것을 잃으면 두 인스턴스가 서로 다른 크기를 PTY 에 보낸다.
 */
test('칸이 다르면 같은 창이라도 주인이 아니다 (FR-WSL-14)', () => {
  const { a } = app({ focused: true, owners: { W1: 'me' } });
  assert.equal(a.resizeCheck('t1', 1), false);
});

/**
 * V-OHB-8: 판정은 **한 자리**다 (FR-OHB-12). `resendWindowSizes` 가 자기만의
 * 갈래를 들고 있으면, 돌려받은 화면이 전량 재생(FR-M10-2)의 문을 지나지 못한다.
 */
test('포커스가 없어도 주인이면 크기를 다시 보낸다 (FR-OHB-12·13)', () => {
  const { a, sent } = app({ focused: false, owners: { W1: 'me' } });
  a.resendWindowSizes('W1');
  assert.equal(sent.length, 1, '돌려받은 화면이 PTY 에 자기 폭을 말해야 한다');
});

test('주인도 포커스도 없으면 보내지 않는다 (FR-OHB-11)', () => {
  const { a, sent } = app({ focused: false, owners: {} });
  a.resendWindowSizes('W1');
  assert.equal(sent.length, 0, '배경 화면이 주인 없는 PTY 를 흔들면 안 된다');
});

test('남이 주인이면 보내지 않는다', () => {
  const { a, sent } = app({ focused: true, owners: { W1: 'other' } });
  a.resendWindowSizes('W1');
  assert.equal(sent.length, 0);
});

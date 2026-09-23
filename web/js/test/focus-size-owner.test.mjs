import assert from 'node:assert/strict';
import { test } from 'node:test';

import { load } from './harness.mjs';

/**
 * `web/js/core/app-focus-owner.js` — 크기를 정할 자격 (FOCUS_INITIAL_RESTORE_SRS).
 *
 * 초기 코드(`854ada6f`)의 판정이다: **OS 포커스가 먼저**이고, 그다음에 주인을 묻는다.
 * 주인이 없으면 포커스 있는 화면의 것이다.
 *
 * 이 판정을 "주인을 먼저 묻는다" 로 바꾼 적이 있다(OWNER_HANDBACK_SRS FR-OHB-9 —
 * 폐기). 돌려받은 **포커스 없는** 주인이 크기를 정하게 하려던 것이었고, 돌려주기가
 * 걷히면서 그 이유도 사라졌다. 포커스 없는 주인이 PTY 를 흔들 이유가 없다.
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

test('주인이어도 OS 포커스가 없으면 크기를 정하지 않는다 (초기 판정)', () => {
  const { a } = app({ focused: false, owners: { W1: 'me' } });
  assert.equal(a.resizeCheck('t1', 0), false, '포커스 없는 주인이 PTY 를 흔든다');
});

test('주인이고 포커스가 있으면 내 것이다', () => {
  const { a } = app({ focused: true, owners: { W1: 'me' } });
  assert.equal(a.resizeCheck('t1', 0), true);
});

test('남이 주인이면 포커스가 있어도 남의 것이다 (FR-XDF-4)', () => {
  const { a } = app({ focused: true, owners: { W1: 'other' } });
  assert.equal(a.resizeCheck('t1', 0), false);
});

test('주인이 없으면 포커스 있는 화면의 것이다', () => {
  assert.equal(app({ focused: true, owners: {} }).a.resizeCheck('t1', 0), true);
  assert.equal(app({ focused: false, owners: {} }).a.resizeCheck('t1', 0), false);
});

test('칸이 다르면 같은 창이라도 주인이 아니다 (FR-WSL-14)', () => {
  const { a } = app({ focused: true, owners: { W1: 'me' } });
  assert.equal(a.resizeCheck('t1', 1), false);
});

test('남이 주인이면 창 전체의 크기 재전송도 물러난다', () => {
  const { a, sent } = app({ focused: true, owners: { W1: 'other' } });
  a.resendWindowSizes('W1');
  assert.equal(sent.length, 0);
});

test('blur 로 소유권을 놓는 동사가 없다 (FR-XDF-9 — 비는 계기는 구독 끊김뿐)', () => {
  const { a } = app();
  assert.equal(typeof a._focusReleaseAll, 'undefined', '반납이 남아 있다 — 주인 없는 창이 다시 생긴다');
});

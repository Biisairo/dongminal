import assert from 'node:assert/strict';
import { test } from 'node:test';

import { load } from './harness.mjs';

/**
 * BROWSER_TAB_SRS TC-BRT-40 (화면 절반): 뷰포트는 그 탭이 속한 **창의 주인**이 정한다.
 * 주인이 아닌 뷰어는 크기를 보내지 않는다(흐리게 그린다). 주인이 없으면 누구나 보낸다.
 */
function world(owner, focused) {
  const ctx = load(['core/layout-tree.js', 'core/app-browser.js'], {
    globals: { App: function App() {}, TAB_TYPE_BROWSER: 'browser', TAB_TYPE_TERMINAL: 'terminal', newUUID: () => 'u' },
  });
  const a = new ctx.App();
  a.ws = { windows: [{ id: 'W', layout: { type: 'pane', id: 'P', tabs: [{ id: 'B', type: 'browser' }] } }] };
  a.windowFocused = focused;
  a._windowFocusOwner = owner ? { W: owner } : {};
  a._slotIdentity = (slot) => (slot ? 'me#' + slot : 'me');
  return a;
}

test('주인이면 보낸다 · 남이 주인이면 보내지 않는다 · 주인이 없으면 보낸다', () => {
  assert.equal(world('me', true).brvOwns('B', 0), true);
  assert.equal(world('other', true).brvOwns('B', 0), false);
  assert.equal(world(null, true).brvOwns('B', 0), true);
});

test('슬롯까지 묻는다 — 같은 창의 다른 슬롯은 주인이 아니다', () => {
  assert.equal(world('me', true).brvOwns('B', 1), false);
  assert.equal(world('me#1', true).brvOwns('B', 1), true);
});

test('이 브라우저 창에 OS 포커스가 없으면 보내지 않는다', () => {
  assert.equal(world('me', false).brvOwns('B', 0), false);
});

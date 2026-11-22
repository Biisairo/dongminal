import assert from 'node:assert/strict';
import { test } from 'node:test';

import { BASE, FOCUS, controllers, load } from './harness.mjs';

/**
 * UX_BATCH12_SRS TC-AFC-1 (FR-AFC-1·2) — 포커스 탭의 도구가 다른 도구에서 알람 도구로 바뀌면
 * 알람을 끈다. 바뀌지 않으면(첫 판정 포함) 아무것도 하지 않는다.
 */
function rig() {
  const ctx = load([...BASE, ...FOCUS], { globals: { App: class {} } });
  const app = controllers(ctx, new ctx.App());   // REFACTOR3_FE_APPCTL_SRS 9g: 하이라이트는 `focus.hl`
  app.cur = '';
  app.attn._agFocusedTool = () => app.cur;
  app._attn = new Map();
  app.cleared = [];
  app.attn._attnClear = (id, typed) => { app.cleared.push([id, typed]); app._attn.delete(id) };
  return app;
}

test('TC-AFC-1: 첫 판정은 기록만 한다', () => {
  const app = rig();
  app.cur = 'a'; app._attn.set('a', { reason: 'signaled' });
  app.focus.hl.attnFocusSync();
  assert.deepEqual(app.cleared, []);
});

test('TC-AFC-1: 다른 도구에서 알람 도구로 바뀌면 본 것으로 끈다', () => {
  const app = rig();
  app.cur = 'a'; app.focus.hl.attnFocusSync();
  app._attn.set('b', { reason: 'signaled' });
  app.cur = 'b'; app.focus.hl.attnFocusSync();
  assert.deepEqual(app.cleared, [['b', false]]);
});

test('TC-AFC-1: 같은 도구에 알람이 새로 서도 끄지 않는다', () => {
  const app = rig();
  app.cur = 'a'; app.focus.hl.attnFocusSync();
  app._attn.set('a', { reason: 'signaled' });
  app.focus.hl.attnFocusSync();
  assert.deepEqual(app.cleared, []);
});

test('TC-AFC-1: 알람 없는 도구로 바뀌면 아무것도 하지 않는다', () => {
  const app = rig();
  app.cur = 'a'; app.focus.hl.attnFocusSync();
  app._attn.set('a', { reason: 'signaled' });
  app.cur = 'b'; app.focus.hl.attnFocusSync();
  app.cur = ''; app.focus.hl.attnFocusSync();
  assert.deepEqual(app.cleared, []);
  assert.equal(app._attn.has('a'), true);
});

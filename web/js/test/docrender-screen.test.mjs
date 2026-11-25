import assert from 'node:assert/strict';
import { test } from 'node:test';

import { BASE, EDITOR, GIT, controllers, load } from './harness.mjs';

/**
 * PERF 3.4.8 — 문서 렌더는 `docrender` 묶음이다 (D-29·D-30, M3_DESIGN §3.4).
 *   렌더 탭만 그 화면이 맡는다 — 소스 편집기 탭은 editor 화면(PERF 3.4.7)의 몫이다.
 */
function setup() {
  const ctx = load([...BASE, ...GIT, ...EDITOR], {
    globals: { App: class {}, TAB_TYPE_EDITOR: 'editor' },
    expose: ['Screens'],
  });
  controllers(ctx, new ctx.App());
  return { ctx };
}

test('렌더 탭만 docrender 화면이 맡는다', () => {
  const { ctx } = setup();
  assert.equal(ctx.Screens.forTab({ type: 'editor', render: true, filePath: '/a.md' }), 'docrender');
  assert.equal(ctx.Screens.forTab({ type: 'editor', filePath: '/a.md' }), 'editor');
  assert.equal(ctx.Screens.forTab({ type: 'terminal', render: true }), null);
});

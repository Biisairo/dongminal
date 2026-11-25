import assert from 'node:assert/strict';
import { test } from 'node:test';

import { BASE, EDITOR, GIT, controllers, load } from './harness.mjs';

/**
 * PERF 3.4.8 — 문서 렌더는 `docrender` 묶음이다 (D-29·D-30, M3_DESIGN §3.4).
 *   렌더 탭만 그 화면이 맡는다 · 뷰는 묶음이 실린 뒤에만 선다.
 */
function setup() {
  const ctx = load([...BASE, ...GIT, ...EDITOR], {
    globals: { App: class {}, TAB_TYPE_EDITOR: 'editor' },
    expose: ['Screens'],
  });
  return { ctx, a: controllers(ctx, new ctx.App()) };
}

test('렌더 탭만 docrender 화면이 맡는다', () => {
  const { ctx } = setup();
  assert.equal(ctx.Screens.forTab({ type: 'editor', render: true, filePath: '/a.md' }), 'docrender');
  assert.equal(ctx.Screens.forTab({ type: 'editor', filePath: '/a.md' }), null);
  assert.equal(ctx.Screens.forTab({ type: 'terminal', render: true }), null);
});

test('묶음이 실리기 전에는 렌더 뷰를 세우지 않는다', () => {
  const { ctx, a } = setup();
  assert.equal(ctx.Screens.ready('docrender'), false);
  assert.throws(() => a.editor.docRender.docRenderView({ id: 't1', name: 'a.md', filePath: '/a.md' }), /docrender/);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { load, fakeClock } from './harness.mjs';

/**
 * `web/js/ui/doc-render.js` — 가려진 렌더 탭은 편집마다 다시 그리지 않는다
 * (OPTIMIZE_REFACTOR_SRS FR-OPT-12-6 · FEU-11).
 *
 * 렌더는 markdown → DOMPurify → innerHTML 전체라 비싸다. 가려진 탭(`.vis` 없음)은 표식만
 * 남기고, 다시 보일 때(`restoreView`) 한 번 그린다. 세는 것은 `_paint` 호출 수다.
 */
function view(visible) {
  const clock = fakeClock();
  const ctx = load(['core/timer-hub.js', 'ui/doc-render.js'], {
    clock,
    expose: ['DocRender'],
    globals: { DOC_RENDER_DEBOUNCE_MS: 150 },
  });
  const v = Object.create(ctx.DocRender.prototype);
  let vis = visible;
  v.el = { classList: { contains: (c) => c === 'vis' && vis }, isConnected: true };
  v._body = { scrollTop: 0 };
  v._timer = null;
  v.paints = 0;
  v._paint = () => { v.paints++ };
  return { v, clock, show: () => { vis = true } };
}

test('보이는 렌더 탭은 편집 뒤 디바운스로 한 번 그린다 (종전과 같다)', async () => {
  const { v, clock } = view(true);
  v._schedule(); v._schedule(); v._schedule();
  await clock.advance(200);
  assert.equal(v.paints, 1);
});

test('가려진 렌더 탭은 편집해도 그리지 않고, 다시 보일 때 한 번 그린다', async () => {
  const { v, clock, show } = view(false);
  for (let i = 0; i < 5; i++) { v._schedule(); await clock.advance(200) }
  assert.equal(v.paints, 0, '가려진 탭을 그렸다');
  show();
  v.restoreView();
  assert.equal(v.paints, 1);
  v.restoreView();
  assert.equal(v.paints, 1, '밀린 것이 없는데 또 그렸다');
});

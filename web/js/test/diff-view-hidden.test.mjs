import assert from 'node:assert/strict';
import { test } from 'node:test';

import { load } from './harness.mjs';

/**
 * `web/js/git/diff-view.js` — 가려진 Diff 뷰는 폭이 0 이 되었다는 이유로 편집기를 다시 세우지 않는다
 * (이슈 3.2).
 *
 * 같은 칸에 다른 탭(History 등)을 열면 Diff 의 그릇은 폭이 0 이 되고 ResizeObserver 가 `layout()` 을
 * 부른다. 폭 0 을 "좁다" 로 읽으면 나란히 보기를 인라인으로 다시 세운다 — 큰 파일에서는 그 한 번이
 * 수 초짜리 diff 계산이고, 다시 보일 때 또 한 번 세운다. 세는 것은 `_cmBuild` 호출 수다.
 */
function view(width, kind) {
  const ctx = load(['git/diff-view.js'], { expose: ['GitDiffView'] });
  const v = Object.create(ctx.GitDiffView.prototype);
  v._sideBySide = true;
  v._breakpoint = 700;
  v._host = { clientWidth: width };
  v.measures = 0;
  v._cm = { kind, b: { requestMeasure: () => { v.measures++ } } };
  v.builds = 0;
  v._cmBuild = () => { v.builds++ };
  return v;
}

test('넓은 그릇의 나란히 보기는 다시 세우지 않고 재기만 한다 (종전과 같다)', () => {
  const v = view(1200, 'split');
  v.layout();
  assert.equal(v.builds, 0);
  assert.equal(v.measures, 1);
});

test('보이는 그릇이 좁아지면 인라인으로 다시 세운다 (종전과 같다)', () => {
  const v = view(400, 'split');
  v.layout();
  assert.equal(v.builds, 1);
});

test('가려져 폭이 0 인 그릇은 다시 세우지 않는다', () => {
  const v = view(0, 'split');
  v.layout();
  assert.equal(v.builds, 0, '가려진 Diff 를 인라인으로 다시 세웠다');
});

test('편집기가 없으면 아무것도 하지 않는다', () => {
  const v = view(0, 'split');
  v._cm = null;
  v.layout();
  assert.equal(v.builds, 0);
});

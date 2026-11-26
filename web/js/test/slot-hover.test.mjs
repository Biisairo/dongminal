import assert from 'node:assert/strict';
import { test } from 'node:test';

import { BASE, SLOTS, load } from './harness.mjs';

/** UX_BATCH14_SRS FR-SFX-1·2 (TC-UB14-4): 에이전트 카드 hover 때 흐릴 칸을 고르는 순수 판정. */
const { slotBlurTargets } = load([...BASE, ...SLOTS], { expose: ['slotBlurTargets'], globals: { App: class App {} } });

test('TC-UB14-4: 탭을 가진 칸을 뺀 나머지 칸을 흐린다', () => {
  assert.deepEqual([...slotBlurTargets(['w1', 'w2', 'w3'], 'w2')], [0, 2]);
  assert.deepEqual([...slotBlurTargets(['w1', 'w1', 'w2'], 'w1')], [2], '같은 창을 보는 칸은 모두 또렷하다');
  assert.deepEqual([...slotBlurTargets(['w1', null], 'w1')], [1], '빈 칸도 흐린다');
});

test('TC-UB14-4: 흐릴 것이 없으면 빈 목록이다', () => {
  assert.deepEqual([...slotBlurTargets(['w1'], 'w1')], [], '칸이 하나');
  assert.deepEqual([...slotBlurTargets([], 'w1')], [], '칸 없음');
  assert.deepEqual([...slotBlurTargets(['w1', 'w2'], 'w9')], [], '어느 칸에도 탭이 없다');
  assert.deepEqual([...slotBlurTargets(['w1', 'w1'], 'w1')], [], '모든 칸이 탭을 가진다');
  assert.deepEqual([...slotBlurTargets(['w1', 'w2'], null)], [], 'hover 없음');
});

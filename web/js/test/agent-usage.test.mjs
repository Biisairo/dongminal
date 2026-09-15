import assert from 'node:assert/strict';
import { test } from 'node:test';

import { load } from './harness.mjs';

/**
 * `web/js/ui/agent-pane.js` 의 사용량 병합 — **창은 그 모델의 것이다**
 * (M12_SRS FR-M12-7 / V-M12-18).
 *
 * 접수: *"지금 300% 넘게 쓰고있으니까 말이야."* 뿌리는 어댑터에 있었고
 * (`FR-M12-6`) 화면에는 그 결함을 **살려 두는 손**이 하나 더 있었다 —
 * `Object.assign(…, filter(v=>v))` 라 `contextWindow` 가 한 번 박히면 영영 남는다.
 *
 * 어댑터가 *"못 고르겠다"* 며 창을 싣지 않아도(D-M12-3) 화면이 옛 창으로 계속
 * 나누면 그 부재가 사용자에게 닿지 않는다.
 *
 * 순수 함수라 브라우저가 필요 없다.
 */
function fn() {
  const ctx = load(['ui/agent-pane.js'], {
    globals: {
      // 싣는 동안 클래스 본문은 돌지 않는다 — 최상위에서 부르는 것만 세워 둔다.
      t: (k) => k, UIKit: {}, TIMERS: {}, Toast: {},
    },
  });
  return ctx.agentMergeUsage;
}

test('V-M12-18: 같은 모델에서는 앞 턴의 창이 이어진다', () => {
  const merge = fn();
  const a = merge({}, { tokens: 100, contextWindow: 1000000 }, 'claude-opus-5[1m]');
  assert.equal(a.contextWindow, 1000000);
  // 다음 턴은 창을 다시 말하지 않는다 — 한 세션에서 창은 바뀌지 않는다.
  const b = merge(a, { tokens: 250 }, 'claude-opus-5[1m]');
  assert.equal(b.contextWindow, 1000000, '같은 모델의 앞 턴 창을 잇는 것은 정상이다');
  assert.equal(b.tokens, 250);
});

test('V-M12-18: 모델이 바뀌고 새 창이 안 오면 옛 창을 버린다', () => {
  const merge = fn();
  const a = merge({}, { tokens: 100, contextWindow: 1000000 }, 'claude-opus-5[1m]');
  // 어댑터가 `modelUsage` 에서 이 모델을 못 찾아 창을 싣지 않았다 (FR-M12-6 의 3번 갈래).
  const b = merge(a, { tokens: 600000 }, 'claude-sonnet-5');
  assert.equal(b.contextWindow, undefined,
    '남의 모델의 창으로 나누면 600000/1000000 이 아니라 거짓이 된다');
  assert.equal(b.tokens, 600000, '분자는 남는다 — 화면이 토큰만 적는다');
});

test('V-M12-18: 새 창이 오면 임자가 그것으로 갈린다', () => {
  const merge = fn();
  const a = merge({}, { tokens: 100, contextWindow: 1000000 }, 'claude-opus-5[1m]');
  const b = merge(a, { tokens: 300, contextWindow: 200000 }, 'claude-haiku-4-5');
  assert.equal(b.contextWindow, 200000);
  // 그 뒤로는 새 임자의 창이 이어진다.
  assert.equal(merge(b, { tokens: 400 }, 'claude-haiku-4-5').contextWindow, 200000);
});

test('V-M12-18: 모델을 모르면 아무것도 버리지 않는다', () => {
  const merge = fn();
  const a = merge({}, { tokens: 100, contextWindow: 1000000 }, 'claude-opus-5[1m]');
  // `status.model` 이 아직 없는 판 — 모르는 것으로 버릴 근거를 삼지 않는다 (FR-CBG-5).
  assert.equal(merge(a, { tokens: 200 }, '').contextWindow, 1000000);
});

test('V-M12-18: 0 과 빈 값은 종전대로 덮지 않는다', () => {
  const merge = fn();
  const a = merge({ tokens: 100, costUSD: 0.5 }, { tokens: 0, costUSD: 0 }, 'm');
  assert.equal(a.tokens, 100, '0 은 "이 이벤트가 말하지 않았다" 이다');
  assert.equal(a.costUSD, 0.5);
});

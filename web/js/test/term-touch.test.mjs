import assert from 'node:assert/strict';
import { test } from 'node:test';

import { load, plain } from './harness.mjs';

/**
 * `web/js/ui/term-touch.js` — 모바일 터치 스크롤의 순수 계산 (UX_BATCH11_SRS FR-MTS).
 */
const ctx = () => load(['core/i18n.js', 'i18n/ko.js', 'core/constants.js', 'ui/term-touch.js'], {
  expose: ['MTI_TOUCH_GAIN', 'MTI_VELOCITY_WINDOW_MS'],
  globals: { TerminalTool: class {} },
});

test('TC-MTS-1 행 단위로 나누고 나머지를 넘긴다', () => {
  const c = ctx();
  const steps = (acc, px, rh) => plain(c.termWheelSteps(acc, px, rh));
  assert.deepEqual(steps(0, 40, 17), { n: 2, rest: 6 });
  assert.deepEqual(steps(6, 12, 17), { n: 1, rest: 1 });
  assert.deepEqual(steps(0, -40, 17), { n: -2, rest: -6 });
  assert.deepEqual(steps(-6, 12, 17), { n: 0, rest: 6 });
  assert.deepEqual(steps(0, 5, 17), { n: 0, rest: 5 });
  assert.deepEqual(steps(0, 0, 17), { n: 0, rest: 0 });
  // 행 높이를 모르면 내지 않고 쥐고 있는다.
  assert.deepEqual(steps(3, 5, 0), { n: 0, rest: 8 });
});

test('TC-MTS-2 속도는 창 안 첫·끝 표본의 px/ms 다', () => {
  const c = ctx();
  const v = (s, now, w = 100) => c.termTouchVelocity(s, now, w);
  // y 가 줄면(손가락이 위로) 앞으로 스크롤 — 양수.
  assert.equal(v([{ t: 0, y: 500 }, { t: 50, y: 450 }, { t: 100, y: 400 }], 100), 1);
  assert.equal(v([{ t: 0, y: 400 }, { t: 100, y: 500 }], 100), -1);
  // 창 밖의 옛 표본은 세지 않는다.
  assert.equal(v([{ t: -300, y: 900 }, { t: 0, y: 500 }, { t: 100, y: 400 }], 100), 1);
  // 표본 하나·멈췄다 뗀 경우는 관성이 없다.
  assert.equal(v([{ t: 100, y: 400 }], 100), 0);
  assert.equal(v([{ t: 0, y: 500 }, { t: 100, y: 400 }], 300), 0);
  assert.equal(v([], 0), 0);
});

test('FR-MTS-2·5 배율은 1, 속도 창은 100 ms 다', () => {
  const c = ctx();
  assert.equal(c.MTI_TOUCH_GAIN, 1);
  assert.equal(c.MTI_VELOCITY_WINDOW_MS, 100);
});

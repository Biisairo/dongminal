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

// 화면 줄 목록. `rows(off, n)` 은 off 부터 n 줄, `foot` 은 고정 꼬리 줄이다.
const rows = (off, n, foot = []) => [...Array.from({ length: n }, (_, i) => `row-${off + i}`), ...foot];

test('TC-MTS-9 보고 전후 화면을 비교해 움직인 줄 수를 잰다', () => {
  const c = ctx();
  const sh = (b, a, d) => c.termScreenShift(b, a, d);
  // 아래로(내용이 위로 올라감) 3줄, 위로 2줄.
  assert.equal(sh(rows(10, 20), rows(13, 20), 1), 3);
  assert.equal(sh(rows(10, 20), rows(8, 20), -1), 2);
  // 고정 꼬리 줄(입력창·상태줄)이 있어도 이동을 찾는다.
  const foot = ['> ', '──────', 'status'];
  assert.equal(sh(rows(10, 17, foot), rows(13, 17, foot), 1), 3);
  // 반복 줄(빈 줄·구분선)은 짝이 되지 않는다 — 그것만 맞으면 재지 못한다.
  assert.equal(sh(['a', '──', '──', '──', '──', 'b'], ['──', '──', '──', '──', 'x', 'y'], 1), null);
  // 짝 부족·방향 반대·이동 없음·내용이 통째로 바뀜.
  assert.equal(sh(rows(10, 20), rows(28, 20), 1), null);
  assert.equal(sh(rows(10, 20), rows(13, 20), -1), null);
  assert.equal(sh(rows(10, 20), rows(10, 20), 1), null);
  assert.equal(sh(rows(10, 20), rows(500, 20), 1), null);
  assert.equal(sh([], [], 1), null);
});

test('TC-MTS-11 같은 방향으로 다시 튕기면 남은 속도를 더한다', () => {
  const c = ctx();
  const f = (v, carry, max = 10) => c.termFlingStart(v, carry, max);
  assert.equal(f(3, 2), 5);
  assert.equal(f(-3, -2), -5);
  assert.equal(f(8, 5), 10);
  assert.equal(f(-8, -5), -10);
  assert.equal(f(3, -2), 3);
  assert.equal(f(3, 0), 3);
  assert.equal(f(0, 4), 0);
  assert.equal(f(12, 0), 10, '혼자서도 상한에서 자른다');
});

test('FR-MTS-10 관성 감쇠는 프레임당 0.97 이다', () => {
  const c = load(['core/i18n.js', 'i18n/ko.js', 'core/constants.js'], { expose: ['MTI_FLING_DECAY'] });
  assert.equal(c.MTI_FLING_DECAY, 0.97);
});

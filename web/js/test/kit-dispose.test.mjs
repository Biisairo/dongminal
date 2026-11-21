import assert from 'node:assert/strict';
import { test } from 'node:test';

import { load } from './harness.mjs';

/**
 * REFACTOR3_FE_BASE_SRS TC-FEB-2 (FR-FEB-3) — `UIKit.roving` 은 해제 함수를 돌려준다. 부르면 리스너가 사라진다.
 *
 * REFACTOR3_FE_REST2_SRS FR-FR2-8 · TC-FR2-3: `UIKit.tabsFitWatch` 는 지웠다 — 앱 안 호출이 0 이었다(탭 줄의 폭 관측은
 * `TabBar` 가 직접 건다). 이 파일의 그 시험 둘도 함께 지웠다.
 */

const ctx = load(['ui/ui-kit.js'], {
  expose: ['UIKit'],
  globals: {
    addEventListener() {}, removeEventListener() {},
    TIMERS: { defer() {} },
  },
});
const { UIKit } = ctx;

function host() {
  const ls = new Map();
  return {
    ls,
    classList: { add() {}, remove() {}, toggle() {} },
    addEventListener(t, fn) { ls.set(t, fn) },
    removeEventListener(t, fn) { if (ls.get(t) === fn) ls.delete(t) },
    querySelector: () => null,
    querySelectorAll: () => [],
  };
}

test('TC-FR2-3: UIKit.tabsFitWatch 는 없다', () => {
  assert.equal(UIKit.tabsFitWatch, undefined);
});

test('roving: 해제 함수가 keydown 리스너를 뗀다', () => {
  const h = host();
  const off = UIKit.roving(h, { items: () => [] });
  assert.equal(typeof off, 'function');
  assert.equal(h.ls.has('keydown'), true);
  off();
  assert.equal(h.ls.has('keydown'), false);
});

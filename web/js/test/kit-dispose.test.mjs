import assert from 'node:assert/strict';
import { test } from 'node:test';

import { load } from './harness.mjs';

/**
 * REFACTOR3_FE_BASE_SRS TC-FEB-2 (FR-FEB-3) — `UIKit.tabsFitWatch`·`UIKit.roving` 은 해제 함수를 돌려준다.
 * 부르면 관측·리스너가 사라진다. 같은 호스트에 두 번 걸지 않는 규약은 그대로다.
 */
const observers = [];
class FakeRO {
  constructor(fn) { this.fn = fn; this.targets = []; this.off = false; observers.push(this) }
  observe(t) { this.targets.push(t) }
  disconnect() { this.off = true }
}

const ctx = load(['ui/ui-kit.js'], {
  expose: ['UIKit'],
  globals: {
    ResizeObserver: FakeRO,
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

test('tabsFitWatch: 해제 함수가 관측을 끊고 다시 걸 수 있게 한다', () => {
  const h = host();
  const n0 = observers.length;
  const off = UIKit.tabsFitWatch(h);
  assert.equal(typeof off, 'function');
  assert.equal(observers.length, n0 + 1);
  // 두 번째 걸기는 관측을 더하지 않는다.
  UIKit.tabsFitWatch(h);
  assert.equal(observers.length, n0 + 1);
  off();
  assert.equal(observers[n0].off, true);
  assert.equal(h._fitRo, undefined);
  UIKit.tabsFitWatch(h);
  assert.equal(observers.length, n0 + 2);
});

test('tabsFitWatch: 호스트가 없어도 해제 함수를 돌려준다', () => {
  assert.equal(typeof UIKit.tabsFitWatch(null), 'function');
});

test('roving: 해제 함수가 keydown 리스너를 뗀다', () => {
  const h = host();
  const off = UIKit.roving(h, { items: () => [] });
  assert.equal(typeof off, 'function');
  assert.equal(h.ls.has('keydown'), true);
  off();
  assert.equal(h.ls.has('keydown'), false);
});

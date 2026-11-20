import assert from 'node:assert/strict';
import { test } from 'node:test';

import { load } from './harness.mjs';

/**
 * UX_AUDIT_FIX_SRS TC-UXF-84 (FR-UXF-84): 메뉴 항목의 `key` 는 단축키 동작 이름이다.
 * 그 동작에 바인딩이 있으면 항목 끝에 키캡(`.ui-menu-key`)이 서고, 없으면 아무것도 서지 않는다.
 */
function el(tag) {
  const e = {
    tagName: tag, className: '', dataset: {}, style: {}, children: [], attrs: {}, textContent: '', parentNode: null,
    appendChild(c) { e.children.push(c); c.parentNode = e; return c },
    removeChild(c) { e.children = e.children.filter((x) => x !== c); c.parentNode = null },
    setAttribute(k, v) { e.attrs[k] = String(v) },
    getAttribute: (k) => (k in e.attrs ? e.attrs[k] : null),
    addEventListener() {},
    contains: () => false,
    getBoundingClientRect: () => ({ width: 100, height: 100 }),
    querySelectorAll: () => [],
  };
  return e;
}

function setup(binds) {
  const body = el('body');
  const document = {
    createElement: el, body, activeElement: null,
    addEventListener() {}, removeEventListener() {},
  };
  const ctx = load(['ui/ui-kit.js'], {
    expose: ['UIKit'],
    globals: {
      document, innerWidth: 1000, innerHeight: 1000,
      addEventListener() {}, removeEventListener() {},
      TIMERS: { defer() {} },
      shortcuts: binds,
      displayKey: (s) => s.replace(/Key/g, '').replace(/Ctrl/g, '⌃').replace(/Shift/g, '⇧'),
    },
  });
  return { UIKit: ctx.UIKit, body };
}

const item = (m, id) => m.children.find((c) => c.dataset.id === id);
const keyOf = (d) => d.children.find((c) => /\bui-menu-key\b/.test(c.className));

test('key 가 있고 바인딩이 있으면 키캡이 그 표기로 선다', () => {
  const { UIKit } = setup({ closeTab: 'Ctrl+Shift+KeyD' });
  const m = UIKit.menu([{ id: 'close', label: 'Close', key: 'closeTab', onClick() {} }]);
  const k = keyOf(item(m, 'close'));
  assert.ok(k, '.ui-menu-key 가 없다');
  assert.equal(k.textContent, '⌃+⇧+D');
});

test('바인딩이 비었거나 없는 동작이면 키캡이 서지 않는다', () => {
  const { UIKit } = setup({ closeTab: '' });
  const m = UIKit.menu([
    { id: 'a', label: 'A', key: 'closeTab', onClick() {} },
    { id: 'b', label: 'B', key: 'noSuchAction', onClick() {} },
  ]);
  assert.equal(keyOf(item(m, 'a')), undefined);
  assert.equal(keyOf(item(m, 'b')), undefined);
});

test('key 가 없는 항목은 그대로다', () => {
  const { UIKit } = setup({ closeTab: 'Ctrl+Shift+KeyD' });
  const m = UIKit.menu([{ id: 'x', label: 'X', onClick() {} }]);
  assert.equal(keyOf(item(m, 'x')), undefined);
});

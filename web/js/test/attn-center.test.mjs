import assert from 'node:assert/strict';
import { test } from 'node:test';

import { load } from './harness.mjs';

/**
 * OPTIMIZE_REFACTOR_SRS FR-OPT-11-7 (FEC-32): 주의 센터의 x 는 알림 하나를 떼고 **한 번** 그린다.
 * `_attnClear` → `_attnRefresh` 가 센터가 열려 있으면 이미 다시 그린다 — 종전에는 그 뒤에
 * 한 번 더 그렸다.
 */
function el(tag) {
  const on = {};
  const e = {
    tag, className: '', textContent: '', title: '', children: [], style: {},
    classList: { add() {}, remove() {}, contains: (c) => c === 'open' },
    appendChild(c) { e.children.push(c); return c },
    addEventListener(t, fn) { on[t] = fn },
    querySelector: () => el('button'),
    _fire(t) { on[t] && on[t]({ stopPropagation() {} }) },
    set innerHTML(v) { if (v === '') e.children.length = 0 },
    get innerHTML() { return '' },
  };
  return e;
}

test('x 한 번에 센터를 한 번 그린다', () => {
  const center = el('div');
  const doc = { getElementById: (id) => (id === 'attn-center' ? center : null), createElement: el };
  const ctx = load(['core/app-attn-center.js'], {
    globals: {
      App: function App() {}, document: doc, escHtml: (s) => s, t: (k) => k,
      TIP_ATTN_CLEAR_ALL: '', TIP_ATTN_DISMISS: '', UIKit: { button: () => el('button') },
    },
  });
  const a = new ctx.App();
  a._attn = new Map([['tool-1', { reason: 'idle' }], ['tool-2', { reason: 'signal' }]]);
  a._toolName = (id) => id;
  a._attnDetail = () => '';
  let renders = 0;
  const orig = a._attnCenterRender;
  a._attnCenterRender = function () { renders++; return orig.call(this) };
  // `_attnClear` 는 `_attnRefresh` 를 지나 열린 센터를 다시 그린다 (app-attn.js).
  a._attnClear = function (id) { this._attn.delete(id); this._attnCenterRender() };
  a._attnCenterRender();
  renders = 0;
  const item = center.children.find((c) => c.className === 'attn-item');
  const x = item.children[item.children.length - 1];
  x._fire('click');
  assert.equal(renders, 1);
  assert.equal(a._attn.size, 1);
});

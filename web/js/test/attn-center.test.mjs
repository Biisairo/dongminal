import assert from 'node:assert/strict';
import { test } from 'node:test';

import { load } from './harness.mjs';

/**
 * OPTIMIZE_REFACTOR_SRS FEC-32 — 주의 센터의 그리기.
 *
 * - FR-OPT-11-7: x 는 알림 하나를 떼고 **한 번** 그린다. `_attnClear` → `_attnRefresh` 가
 *   센터가 열려 있으면 이미 다시 그린다 — 종전에는 그 뒤에 한 번 더 그렸다.
 * - FR-OPT-16-2: 다시 그리기는 `reconcileList` 다. 바뀌지 않은 행의 요소는 그대로 남는다 —
 *   종전에는 `innerHTML=''` 뒤 머리와 행 전부를 새로 만들었다.
 */

// 센터 컨테이너가 받은 DOM 변이(삽입·제거)를 센다. 행 안쪽의 조립은 세지 않는다 —
// 새로 만든 행은 삽입 한 번으로 센다.
function makeDoc() {
  const stats = { mutations: 0 };
  const el = (tag) => {
    const on = {};
    const e = {
      tag, className: '', textContent: '', title: '', children: [], style: {}, dataset: {}, parentNode: null,
      classList: { add() {}, remove() {}, contains: (c) => c === 'open' },
      appendChild(c) { return e.insertBefore(c, null) },
      insertBefore(c, ref) {
        if (c.parentNode) c.parentNode.removeChild(c, true);
        const i = ref ? e.children.indexOf(ref) : -1;
        if (i < 0) e.children.push(c); else e.children.splice(i, 0, c);
        c.parentNode = e;
        if (e.tag === 'center') stats.mutations++;
        return c;
      },
      removeChild(c, moving) {
        e.children.splice(e.children.indexOf(c), 1);
        c.parentNode = null;
        if (e.tag === 'center' && !moving) stats.mutations++;
        return c;
      },
      replaceChildren() { for (const c of [...e.children]) e.removeChild(c) },
      addEventListener(t, fn) { on[t] = fn },
      querySelector: () => el('button'),
      _fire(t) { on[t] && on[t]({ stopPropagation() {} }) },
      set innerHTML(v) { if (v === '') e.replaceChildren() },
      get innerHTML() { return '' },
    };
    return e;
  };
  const center = el('center');
  const doc = { getElementById: (id) => (id === 'attn-center' ? center : null), createElement: el };
  return { center, doc, el, stats };
}

function setup() {
  const d = makeDoc();
  const ctx = load(['ui/repaint.js', 'core/app-attn-center.js'], {
    globals: {
      App: function App() {}, document: d.doc, escHtml: (s) => s, t: (k, p) => k + (p ? JSON.stringify(p) : ''),
      TIP_ATTN_CLEAR_ALL: '', TIP_ATTN_DISMISS: '', UIKit: { button: () => d.el('button') },
    },
  });
  const a = new ctx.App();
  a._attn = new Map();
  a._toolName = (id) => id;
  a._details = {};
  a._attnDetail = (id) => a._details[id] || '';
  return { a, ...d };
}

const rows = (center) => center.children.filter((c) => c.className === 'attn-item');

test('x 한 번에 센터를 한 번 그린다', () => {
  const { a, center } = setup();
  a._attn = new Map([['tool-1', { reason: 'idle' }], ['tool-2', { reason: 'signal' }]]);
  let renders = 0;
  const orig = a._attnCenterRender;
  a._attnCenterRender = function () { renders++; return orig.call(this) };
  // `_attnClear` 는 `_attnRefresh` 를 지나 열린 센터를 다시 그린다 (app-attn.js).
  a._attnClear = function (id) { this._attn.delete(id); this._attnCenterRender() };
  a._attnCenterRender();
  renders = 0;
  const item = rows(center)[0];
  const x = item.children[item.children.length - 1];
  x._fire('click');
  assert.equal(renders, 1);
  assert.equal(a._attn.size, 1);
  assert.equal(rows(center).length, 1);
});

test('바뀐 것이 없으면 다시 그려도 DOM 을 건드리지 않는다', () => {
  const { a, center, stats } = setup();
  for (let i = 1; i <= 5; i++) a._attn.set('tool-' + i, { reason: 'idle' });
  a._attnCenterRender();
  assert.equal(rows(center).length, 5);
  const before = [...center.children];
  stats.mutations = 0;
  a._attnCenterRender();
  // 종전: 비우기 6 + 머리·행 6 삽입 = 12
  assert.equal(stats.mutations, 0);
  assert.deepEqual(center.children, before);
});

test('알림 하나가 늘면 머리와 그 행만 바뀐다', () => {
  const { a, center, stats } = setup();
  for (let i = 1; i <= 5; i++) a._attn.set('tool-' + i, { reason: 'idle' });
  a._attnCenterRender();
  const kept = rows(center);
  stats.mutations = 0;
  a._attn.set('tool-6', { reason: 'signal' });
  a._attnCenterRender();
  // 머리(개수가 바뀐다) 제거·삽입 2 + 새 행 삽입 1. 종전: 비우기 6 + 삽입 7 = 13
  assert.equal(stats.mutations, 3);
  assert.deepEqual(rows(center).slice(0, 5), kept);
  assert.equal(rows(center).length, 6);
});

test('한 행의 내용이 바뀌면 그 행만 다시 만든다', () => {
  const { a, center, stats } = setup();
  for (let i = 1; i <= 3; i++) a._attn.set('tool-' + i, { reason: 'idle' });
  a._attnCenterRender();
  const [r1, , r3] = rows(center);
  stats.mutations = 0;
  a._details['tool-2'] = 'Bash: ls';
  a._attnCenterRender();
  assert.equal(stats.mutations, 2);
  const now = rows(center);
  assert.equal(now[0], r1);
  assert.equal(now[2], r3);
  assert.equal(now[1].children.find((c) => c.className === 'attn-detail').textContent, 'Bash: ls');
});

test('마지막 알림이 떨어지면 비우고 닫는다', () => {
  const { a, center } = setup();
  a._attn.set('tool-1', { reason: 'idle' });
  a._attnCenterRender();
  let closed = 0;
  a._attnCenterClose = () => { closed++ };
  a._attn.clear();
  a._attnCenterRender();
  assert.equal(center.children.length, 0);
  assert.equal(closed, 1);
});

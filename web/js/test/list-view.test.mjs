import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { BASE, GITVIEW, LIST, load } from './harness.mjs';

/**
 * REFACTOR3_FE_LIST_SRS — 목록 기반 클래스 `ListView` 와 그 하위.
 *   TC-FEL-1·2 ListView · TC-FEL-3 SidebarList · TC-FEL-4 GitListTab(단계 5 부터 GitView 하위, ListView 는 부품)
 */
const JS = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => readFileSync(join(JS, f), 'utf8');
const GIT_LIST = ['git/git-list-tab.js', 'git/worktrees.js', 'git/submodules.js'];

function el(tag) {
  const e = {
    tagName: tag, children: [], parentNode: null, dataset: {}, listeners: {},
    appendChild(c) { return this.insertBefore(c, null) },
    insertBefore(c, at) {
      if (c.parentNode) c.parentNode.removeChild(c);
      const i = at ? this.children.indexOf(at) : -1;
      if (i < 0) this.children.push(c); else this.children.splice(i, 0, c);
      c.parentNode = this;
      return c;
    },
    removeChild(c) { this.children.splice(this.children.indexOf(c), 1); c.parentNode = null; return c },
    addEventListener(t, fn) { this.listeners[t] = fn },
    removeEventListener(t, fn) { if (this.listeners[t] === fn) delete this.listeners[t] },
  };
  return e;
}

function setup(extra = [], expose = [], globals = {}) {
  const released = [];
  const UIKit = { roving: (box) => { box.roved = (box.roved || 0) + 1; return () => released.push(box) } };
  const ctx = load([...BASE, 'ui/repaint.js', ...LIST, ...extra], {
    expose: ['ListView', 'View', 'RPT_SEP', ...expose],
    globals: { UIKit, TIMERS: { disposeOwner() {} }, document: { createElement: el }, ...globals },
  });
  return { ctx, released };
}

test('TC-FEL-1 reconcile 은 key·sig·buildRow 를 쓰고, 서명이 같은 행은 다시 만들지 않는다', () => {
  const { ctx } = setup();
  let built = 0;
  class Rows extends ctx.ListView {
    sigParts(it) { return [it.key, it.v] }
    buildRow(it) { built++; const r = el('div'); r.v = it.v; return r }
  }
  const v = new Rows();
  assert.equal(v.sig({ key: 'a', v: 1 }), 'a' + ctx.RPT_SEP + '1');
  const box = el('div');
  assert.equal(v.reconcile(box, [{ key: 'a', v: 1 }, { key: 'b', v: 2 }]), 2);
  assert.equal(built, 2);
  const a0 = box.children[0];
  v.reconcile(box, [{ key: 'a', v: 1 }, { key: 'b', v: 3 }]);
  assert.equal(built, 3, '바뀐 행만 다시 만든다');
  assert.equal(box.children[0], a0);
  assert.equal(box.children[1].v, 3);
});

test('TC-FEL-2 bindKeys 는 상자마다 한 번, dispose 가 푼다', () => {
  const { ctx, released } = setup();
  const v = new ctx.ListView();
  const box = el('div');
  v.bindKeys(box, {});
  v.bindKeys(box, {});
  assert.equal(box.roved, 1);
  v.dispose();
  assert.deepEqual(released, [box]);
});

test('TC-FEL-3 SidebarList 는 ListView 의 하위이고 (app, def) 마다 인스턴스 하나, 서명은 옛 바이트', () => {
  const { ctx } = setup(['ui/sidebar-list.js'], ['SidebarList'], { SB_TAB_DEFS: [] });
  const SL = ctx.SidebarList;
  assert.ok(SL.prototype instanceof ctx.ListView);
  const app = {}, def = { id: 'w', list: { containerId: 'x', key: (i) => i } };
  const a = SL.of(app, def);
  assert.equal(SL.of(app, def), a);
  assert.notEqual(SL.of({}, def), a, '앱이 다르면 인스턴스도 다르다');
  let painted = 0;
  a.paint = () => { painted++ };
  SL.paint(app, def);
  assert.equal(painted, 1);
  const r = { name: 'n', title: 't', cls: 'c', dotCls: 'd', active: true, attn: false, work: true, removable: false,
    badge: { icon: 'i', text: '3', cls: 'bc', title: 'bt' }, chip: { text: 'ch', color: 'red' } };
  const want = ['n', 't', 'c', 'd', 1, 0, 1, 0, 'i3\x02bc\x02bt', 'ch\x02red'].join('\x01');
  assert.equal(a.sig(r), want);
});

// D-FEV-3 (REFACTOR3_FE_GITVIEW_SRS): GitListTab 은 이제 GitView 를 상속하고 ListView 를 부품(`rows`)으로 든다.
test('TC-FEL-4 GitListTab 계층 — 받은 칸이 루트이고 dispose 는 그 칸을 떼지 않는다', () => {
  const { ctx } = setup([...GITVIEW, ...GIT_LIST], ['GitListTab', 'GitWorktrees', 'GitSubmodules', 'GitView'],
    { GIT_NOTE_CLOSE: 'x', GIT_TIP_NOTE_CLOSE: 'x' });
  for (const C of [ctx.GitListTab, ctx.GitWorktrees, ctx.GitSubmodules]) {
    assert.ok(C === ctx.GitListTab || C.prototype instanceof ctx.GitListTab, C.name);
    assert.ok(C.prototype instanceof ctx.GitView, C.name);
    assert.ok(C.prototype instanceof ctx.View, C.name);
  }
  const t = new ctx.GitListTab({ app: {} }, 'p');
  assert.ok(t.rows instanceof ctx.ListView);
  t._mountHead = () => {};
  const host = el('div');
  host.querySelector = () => ({ addEventListener() {} });
  const parent = el('div');
  parent.appendChild(host);
  t.mount(host);
  assert.equal(t.el, host);
  t.unmount();
  assert.equal(t.el, null);
  t.mount(host);
  t.dispose();
  assert.equal(host.parentNode, parent, '받은 칸을 뗐다');
  for (const f of GIT_LIST) {
    assert.doesNotMatch(read(f), /this\._el\b|_rowEl|_sigParts/, f);
  }
});

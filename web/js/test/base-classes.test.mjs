import assert from 'node:assert/strict';
import { test } from 'node:test';

import { BASE, fakeClock, load } from './harness.mjs';

/**
 * REFACTOR3_FE_BASE_SRS 단계 1 — 기반 클래스 (`web/js/core/base/`).
 *   TC-FEB-10 Component · TC-FEB-11 View · TC-FEB-12 EscapeStack · TC-FEB-13 badgeOf · FR-FEB-12 Controller · FR-FEB-14 ScrollMemo
 */
const json = (v) => JSON.stringify(v);

/** 리스너를 세는 최소 대상. */
function target() {
  const ls = new Set();
  return {
    ls,
    addEventListener(t, fn) { ls.add(t + ':' + fn.name); this[t] = fn },
    removeEventListener(t, fn) { if (this[t] === fn) { ls.delete(t + ':' + fn.name); delete this[t] } },
  };
}

function setup() {
  const clock = fakeClock();
  const ctx = load(['core/timer-hub.js', 'core/event-bus.js', ...BASE], {
    clock,
    expose: ['TimerHub', 'EventBus', 'Component', 'View', 'Controller', 'EscapeStack', 'ScrollMemo'],
    globals: {
      UIKit: {
        scrollSave: (root) => { if (root) root.saved = root.top },
        scrollRestore: (root) => { if (root) root.top = root.saved },
      },
    },
  });
  const timers = new ctx.TimerHub();
  const bus = new ctx.EventBus({}, timers);
  return { ctx, clock, timers, bus };
}

// ── TC-FEB-10 Component ──────────────────────────────────────────────────

test('TC-FEB-10: own·listen·observe·after·every·on 이 dispose 에서 모두 풀린다', async () => {
  const { ctx, clock, timers, bus } = setup();
  const c = new ctx.Component({ timers, bus });
  const log = [];
  c.own(() => log.push('own1'));
  const t = target();
  const onKey = function onKey() {};
  c.listen(t, 'keydown', onKey);
  assert.equal(t.ls.size, 1);
  const ob = { on: false, observe() { this.on = true }, disconnect() { this.on = false } };
  c.observe(ob, {}, {});
  assert.equal(ob.on, true);
  let fired = 0, ticks = 0, heard = 0;
  c.after(100, () => { fired++ });
  c.every(50, () => { ticks++ });
  c.on('topic', () => { heard++ });
  c.own(() => log.push('own2'));
  assert.equal(bus.publish('topic'), 1);
  assert.equal(heard, 1);

  c.dispose();
  assert.equal(c.disposed, true);
  // 쌓인 해제는 거꾸로 분다.
  assert.equal(json(log), json(['own2', 'own1']));
  assert.equal(t.ls.size, 0);
  assert.equal(ob.on, false);
  assert.equal(json(timers.pending()), '[]');
  assert.equal(bus.publish('topic'), 0);
  await clock.advance(500);
  assert.equal(fired, 0);
  assert.equal(ticks, 0);
});

test('TC-FEB-10: 타이머·구독의 주인은 인스턴스다', () => {
  const { ctx, timers, bus } = setup();
  const a = new ctx.Component({ timers, bus });
  const b = new ctx.Component({ timers, bus });
  a.after(100, () => {});
  b.after(100, () => {});
  a.on('x', () => {});
  b.on('x', () => {});
  a.dispose();
  assert.equal(timers.pending().length, 1);
  assert.equal(timers.pending()[0].owner, b);
  assert.equal(bus.publish('x'), 1);
});

test('TC-FEB-10: dispose 를 두 번 불러도 안전하다', () => {
  const { ctx, timers, bus } = setup();
  const c = new ctx.Component({ timers, bus });
  let n = 0;
  c.own(() => { n++ });
  c.dispose();
  c.dispose();
  assert.equal(n, 1);
  assert.equal(c.disposed, true);
});

// ── TC-FEB-11 View ───────────────────────────────────────────────────────

function node() {
  const n = { children: [], parentNode: null };
  n.appendChild = (c) => { if (c.parentNode) c.parentNode.removeChild(c); n.children.push(c); c.parentNode = n; return c };
  n.removeChild = (c) => { n.children.splice(n.children.indexOf(c), 1); c.parentNode = null; return c };
  return n;
}

test('TC-FEB-11: mount 는 build 를 한 번만 부르고 그릴 때마다 render 를 부른다', () => {
  const { ctx, timers, bus } = setup();
  let built = 0, rendered = 0;
  class V extends ctx.View {
    build() { built++; return node() }
    render() { rendered++ }
  }
  const v = new V({ timers, bus });
  const host = node();
  v.mount(host);
  v.mount(host);
  assert.equal(built, 1);
  assert.equal(rendered, 2);
  assert.equal(host.children.length, 1);
  assert.equal(host.children[0], v.el);
  v.dispose();
  assert.equal(host.children.length, 0);
});

test('TC-FEB-11: adopt 한 요소는 build 하지 않고 dispose 가 떼지 않는다', () => {
  const { ctx, timers, bus } = setup();
  let built = 0;
  class V extends ctx.View { build() { built++; return node() } }
  const host = node();
  const el = host.appendChild(node());
  const v = new V({ timers, bus }).adopt(el);
  v.mount();
  assert.equal(built, 0);
  assert.equal(v.el, el);
  v.dispose();
  assert.equal(el.parentNode, host);
  assert.equal(v.disposed, true);
});

// ── FR-FEB-12 Controller ─────────────────────────────────────────────────

test('FR-FEB-12: Controller 는 app 을 들고 화면 요소를 갖지 않는다', () => {
  const { ctx, timers, bus } = setup();
  const app = { timers, bus };
  const c = new ctx.Controller(app);
  assert.equal(c.app, app);
  assert.equal('el' in c, false);
  assert.equal(c instanceof ctx.Component, true);
  // 주인 등록은 앱의 시간·버스를 쓴다.
  c.after(10, () => {});
  c.on('y', () => {});
  assert.equal(timers.pending()[0].owner, c);
  c.dispose();
  assert.equal(timers.pending().length, 0);
  assert.equal(bus.publish('y'), 0);
});

// ── TC-FEB-12 EscapeStack ────────────────────────────────────────────────

test('TC-FEB-12: Esc 는 맨 위 하나만 닫고, 뺀 항목은 닫지 않는다', () => {
  const { ctx } = setup();
  const { EscapeStack } = ctx;
  const log = [];
  const a = { close: () => log.push('a') };
  const b = { close: () => log.push('b') };
  const c = { close: () => log.push('c') };
  EscapeStack.push(a);
  EscapeStack.push(b);
  EscapeStack.push(c);
  EscapeStack.remove(c);
  let prevented = 0;
  const ev = (key) => ({ key, preventDefault: () => { prevented++ }, stopPropagation() {} });
  assert.equal(EscapeStack.handle(ev('Enter')), false);
  assert.equal(EscapeStack.handle(ev('Escape')), true);
  assert.equal(json(log), json(['b']));
  assert.equal(prevented, 1);
  assert.equal(EscapeStack.handle(ev('Escape')), true);
  assert.equal(json(log), json(['b', 'a']));
  assert.equal(EscapeStack.handle(ev('Escape')), false);
});

test('TC-FEB-12: 같은 항목을 다시 넣으면 맨 위로 올라가고 하나로 남는다', () => {
  const { ctx } = setup();
  const { EscapeStack } = ctx;
  const log = [];
  const a = { close: () => log.push('a') };
  const b = { close: () => log.push('b') };
  EscapeStack.push(a);
  EscapeStack.push(b);
  EscapeStack.push(a);
  EscapeStack.handle({ key: 'Escape', preventDefault() {}, stopPropagation() {} });
  EscapeStack.handle({ key: 'Escape', preventDefault() {}, stopPropagation() {} });
  assert.equal(EscapeStack.handle({ key: 'Escape', preventDefault() {}, stopPropagation() {} }), false);
  assert.equal(json(log), json(['a', 'b']));
});

// ── TC-FEB-13 badgeOf ────────────────────────────────────────────────────

test('TC-FEB-13: 0·null 은 숨긴다', () => {
  const { ctx } = setup();
  for (const n of [0, null, undefined]) {
    assert.equal(json(ctx.badgeOf(n)), json({ shown: false, text: '', dot: false }));
  }
});

test('TC-FEB-13: 수는 글자로 보인다', () => {
  const { ctx } = setup();
  assert.equal(json(ctx.badgeOf(3)), json({ shown: true, text: '3', dot: false }));
  // 수가 있으면 점은 서지 않는다 (FR-PCH-81).
  assert.equal(json(ctx.badgeOf(12, { dot: true })), json({ shown: true, text: '12', dot: false }));
});

test('TC-FEB-13: 수가 없고 점을 청하면 점이다', () => {
  const { ctx } = setup();
  assert.equal(json(ctx.badgeOf(0, { dot: true })), json({ shown: false, text: '', dot: true }));
  assert.equal(json(ctx.badgeOf(0, { dot: false })), json({ shown: false, text: '', dot: false }));
});

// ── FR-FEB-14 ScrollMemo ─────────────────────────────────────────────────

test('FR-FEB-14: 키별로 스크롤 자리를 요소에 적고 되돌린다', () => {
  const { ctx } = setup();
  const roots = { a: { top: 10 }, b: { top: 20 } };
  const m = new ctx.ScrollMemo((k) => roots[k] || null);
  m.save('a');
  m.save('b');
  roots.a.top = 0; roots.b.top = 0;
  m.restore('a');
  assert.equal(roots.a.top, 10);
  assert.equal(roots.b.top, 0);
  m.restore('b');
  assert.equal(roots.b.top, 20);
  // 없는 키는 아무것도 하지 않는다.
  m.save('zz');
  m.restore('zz');
});

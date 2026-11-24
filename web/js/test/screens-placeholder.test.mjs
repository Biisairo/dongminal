import assert from 'node:assert/strict';
import { test } from 'node:test';

import { BASE, fakeClock, load } from './harness.mjs';

/**
 * PERF 3.4.3 — 렌더러 자리표시 (D-30, M3_DESIGN §3.4).
 *   묶음이 아직이면 자리표시를 붙이고 `Screens.load` 를 건다. 실리면 `app.render()` 한 번,
 *   그다음 그리기에서 실제 본문으로 바뀐다. 렌더러는 동기로 남는다.
 */
function fakeEl(tag = 'div') {
  const cls = new Set();
  const el = {
    tagName: tag.toUpperCase(), children: [], parentNode: null, textContent: '', attrs: {},
    classList: { add: (c) => cls.add(c), remove: (c) => cls.delete(c), contains: (c) => cls.has(c) },
    get className() { return [...cls].join(' ') },
    set className(v) { cls.clear(); for (const c of String(v).split(/\s+/).filter(Boolean)) cls.add(c) },
    appendChild(c) { if (c.parentNode) c.remove(); c.parentNode = el; el.children.push(c); return c },
    remove() { const p = el.parentNode; if (p) p.children.splice(p.children.indexOf(el), 1); el.parentNode = null },
    setAttribute(k, v) { el.attrs[k] = String(v) },
  };
  return el;
}

function setup() {
  const clock = fakeClock();
  const head = fakeEl('head');
  const document = {
    hidden: false, head,
    addEventListener() {}, removeEventListener() {},
    createElement: (tag) => fakeEl(tag),
    querySelector: () => null,
    body: { classList: { contains: () => false } },
  };
  const ctx = load(['core/i18n.js', 'i18n/ko.js', 'core/constants.js', 'core/timer-hub.js', 'core/event-bus.js',
    'core/channel.js', ...BASE, 'ui/screen-life.js', 'core/screens.js', 'ui/renderer.js', 'ui/renderer-layout.js',
    'ui/renderer-pane.js'], { clock, globals: { document }, expose: ['TimerHub', 'EventBus', 'Channel', 'Screens', 'Renderer'] });
  const timers = new ctx.TimerHub();
  const bus = new ctx.EventBus({}, timers);
  const channel = new ctx.Channel(bus, timers, { pingMs: () => 1000 });
  const runEl = fakeEl();
  const calls = { render: 0, runView: 0 };
  const app = {
    timers, bus, channel,
    render() { calls.render++ },
    runsPanel: () => ({ runViewEl() { calls.runView++; return runEl } }),
  };
  ctx.app = app;
  ctx.Screens.register('tscreen', { tab: (at) => at.type === 'run' });
  const r = new ctx.Renderer(app);
  r._rSlot = 0;
  return { ctx, r, head, runEl, calls };
}

const drain = () => new Promise((res) => setImmediate(res));
const AT = { type: 'run', id: 'tab1' };

test('묶음이 아직이면 자리표시를 붙이고 묶음을 싣기 시작한다', () => {
  const { r, head, calls } = setup();
  const body = fakeEl();
  r._mountTabBody(body, AT);
  assert.equal(calls.runView, 0, '아직 실리지 않은 화면의 본문을 만들지 않는다');
  assert.equal(body.children.length, 1);
  const ph = body.children[0];
  assert.ok(ph.classList.contains('ui-empty') && ph.classList.contains('ui-empty-center'), ph.className);
  assert.equal(ph.textContent, '불러오는 중…');
  assert.equal(r._mounted.get(ph), null, '자리표시는 생명주기 전이 대상이 아니다 (3.5.1)');
  assert.deepEqual(head.children.map((e) => e.src), ['b/tscreen.js']);
});

test('기다리는 동안 다시 그려도 같은 자리표시·같은 태그이고, 실리면 render 는 한 번이다', async () => {
  const { r, head, calls } = setup();
  const body = fakeEl();
  r._mountTabBody(body, AT);
  const ph = body.children[0];
  r._mountTabBody(body, AT);
  r._mountTabBody(body, AT);
  assert.equal(body.children[0], ph);
  assert.equal(head.children.length, 1);
  head.children[0].onload();
  await drain();
  assert.equal(calls.render, 1);
});

test('실린 뒤 다시 그리기 한 번으로 실제 본문으로 바뀐다', async () => {
  const { r, head, runEl, calls } = setup();
  const body = fakeEl();
  r._mountTabBody(body, AT);
  head.children[0].onload();
  await drain();
  r._mountTabBody(body, AT);
  assert.equal(calls.runView, 1);
  assert.deepEqual(body.children, [runEl]);
  assert.ok(runEl.classList.contains('vis'));
});

test('싣기에 실패하면 render 를 부르지 않고, 다음 그리기가 새 URL 로 다시 싣는다', async () => {
  const { r, head, calls } = setup();
  const body = fakeEl();
  r._mountTabBody(body, AT);
  head.children[0].onerror();
  await drain();
  assert.equal(calls.render, 0);
  r._mountTabBody(body, AT);
  assert.equal(head.children.at(-1).src, 'b/tscreen.js?r=1');
  assert.ok(body.children[0].classList.contains('ui-empty'), '자리표시가 남는다');
});

test('등록된 화면이 맡지 않는 탭은 그대로 그린다', () => {
  const { r, head } = setup();
  const body = fakeEl();
  r._mountTabBody(body, { type: 'terminal', id: 'c' });
  assert.equal(head.children.length, 0);
});

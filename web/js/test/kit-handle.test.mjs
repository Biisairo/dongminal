import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { BASE, HANDLE, load } from './harness.mjs';

/**
 * REFACTOR3_FE_REST3_SRS FR-FR3-15·16 (FU-13, TC-FR3-37) — 핸들의 끌기(`SizeDrag`)와 크기 HUD(`SizeHud`)가 킷 밖의
 * 자기 파일로 갔다. `UIKit.drag` 는 입구로 남는다. HUD 의 글자·정렬·가장자리 자르기는 옮기기 전과 같다.
 */
const JS = join(dirname(fileURLToPath(import.meta.url)), '..');

function el(tag) {
  const cls = new Set();
  const e = {
    tag, id: '', children: [], style: {}, textContent: '', listeners: {},
    classList: {
      add: (c) => cls.add(c), remove: (c) => cls.delete(c), contains: (c) => cls.has(c),
      toggle: (c, on) => { if (on) cls.add(c); else cls.delete(c) },
    },
    get className() { return [...cls].join(' ') },
    set className(v) { cls.clear(); for (const c of String(v).split(/\s+/).filter(Boolean)) cls.add(c) },
    appendChild(c) { e.children.push(c); return c },
    querySelectorAll: (sel) => (sel === '.ui-size-box' ? e.children.filter((c) => c.classList.contains('ui-size-box')) : []),
    addEventListener(t, fn) { e.listeners[t] = fn },
  };
  Object.defineProperty(e, 'innerHTML', {
    set(v) {
      e.children = [];
      if (v.includes('ui-size-box')) for (let i = 0; i < 2; i++) { const b = el('div'); b.className = 'ui-size-box'; e.children.push(b) }
    },
  });
  return e;
}

function world() {
  const docL = {};
  const body = el('body');
  const document = {
    body,
    createElement: el,
    getElementById: (id) => body.children.find((c) => c.id === id) || null,
    addEventListener: (t, fn) => { (docL[t] = docL[t] || []).push(fn) },
    removeEventListener: (t, fn) => { docL[t] = (docL[t] || []).filter((f) => f !== fn) },
  };
  const frames = [];
  const TIMERS = {
    disposeOwner() {},
    frame: (fn, o) => { frames.push({ fn, o }); return frames.length },
    cancel() {},
  };
  const ctx = load([...BASE, 'ui/ui-kit.js', ...HANDLE], {
    expose: ['UIKit', 'SizeHud', 'SizeDrag'], globals: { document, TIMERS, innerWidth: 1000, innerHeight: 600 },
  });
  return { ctx, document, docL, frames };
}

const text = (b) => b.children.map((c) => c.textContent);

test('TC-FR3-37: SizeHud.show — 상자 둘에 px·칸·% 를 세로로 싣고 붙는 변으로 정렬한다', () => {
  const { ctx, document } = world();
  ctx.SizeHud.show('x', 500, 300, [{ px: 120.4, cell: '40 cols', pct: 33.3 }, { px: 240.6, pct: 66.7 }]);
  const hud = document.getElementById('ui-size-hud');
  assert.ok(hud && hud.classList.contains('on'));
  const [a, b] = hud.querySelectorAll('.ui-size-box');
  assert.deepEqual(text(a), ['120px', '40 cols', '33%']);
  assert.deepEqual(text(b), ['241px', '67%'], '칸이 없는 쪽은 그 줄을 적지 않는다');
  assert.ok(a.classList.contains('to-r') && !a.classList.contains('to-l'));
  assert.ok(b.classList.contains('to-l') && !b.classList.contains('to-r'));
  assert.deepEqual([a.style.left, a.style.top, b.style.left, b.style.top], ['438px', '300px', '562px', '300px']);
});

test('TC-FR3-37: 세로 핸들은 위아래로 놓고 정렬을 두지 않는다 — 화면 밖이면 안으로 민다', () => {
  const { ctx, document } = world();
  ctx.SizeHud.show('y', 10, 590, [{ px: 1 }, { px: 2 }]);
  const [a, b] = document.getElementById('ui-size-hud').querySelectorAll('.ui-size-box');
  assert.ok(!a.classList.contains('to-r') && !b.classList.contains('to-l'));
  assert.deepEqual([a.style.left, a.style.top, b.style.left, b.style.top], ['48px', '550px', '48px', '572px']);
});

test('TC-FR3-37: 상자 둘이 아니면 그리지 않는다. 겹은 하나뿐이고 hide 가 끈다', () => {
  const { ctx, document } = world();
  ctx.SizeHud.show('x', 0, 0, [{ px: 1 }]);
  assert.equal(document.getElementById('ui-size-hud'), null);
  ctx.SizeHud.show('x', 0, 0, [{ px: 1 }, { px: 2 }]);
  ctx.SizeHud.show('x', 0, 0, [{ px: 3 }, { px: 4 }]);
  assert.equal(document.body.children.filter((c) => c.id === 'ui-size-hud').length, 1);
  ctx.SizeHud.hide();
  assert.ok(!document.getElementById('ui-size-hud').classList.contains('on'));
});

test('TC-FR3-37: UIKit.drag 는 SizeDrag.bind 에 맡긴다 — 끄는 동안 프레임마다 HUD, 놓으면 숨기고 end', () => {
  const { ctx, document, docL, frames } = world();
  const h = el('div');
  const log = [];
  ctx.UIKit.drag(h, {
    axis: 'x',
    start: (e) => { log.push('start:' + e.clientX); return { w: 10 } },
    move: (c, e) => log.push('move:' + (e.clientX - c.sx0)),
    end: () => log.push('end'),
    sides: (c, pt) => [{ px: pt.x }, { px: c.w }],
  });
  h.listeners.mousedown({ button: 0, clientX: 100, clientY: 5, preventDefault() {} });
  assert.equal(frames.length, 1);
  assert.deepEqual({ ...frames[0].o }, { owner: 'ui-kit', coalesce: 'size-hud' });
  for (const fn of docL.mousemove) fn({ clientX: 130, clientY: 5 });
  frames.at(-1).fn();
  const hud = document.getElementById('ui-size-hud');
  assert.deepEqual(text(hud.querySelectorAll('.ui-size-box')[0]), ['130px']);
  for (const fn of [...docL.mouseup]) fn({});
  assert.ok(!hud.classList.contains('on'));
  assert.deepEqual(log, ['start:100', 'move:30', 'end']);
  assert.equal((docL.mousemove || []).length, 0, '놓으면 수신기를 푼다');
});

test('TC-FR3-37: 오른쪽 단추·start 의 false 는 시작하지 않는다', () => {
  const { ctx, frames } = world();
  const h = el('div');
  ctx.UIKit.drag(h, { start: () => false, sides: () => [{}, {}] });
  h.listeners.mousedown({ button: 2, preventDefault() {} });
  h.listeners.mousedown({ button: 0, clientX: 1, clientY: 1, preventDefault() {} });
  assert.equal(frames.length, 0);
});

test('TC-FR3-37: UIKit 에 HUD 가 남지 않는다 — 끌기·HUD 는 각자 파일이다', () => {
  const { ctx } = world();
  for (const n of ['_hud', '_hudEl', '_hudHide']) assert.equal(ctx.UIKit[n], undefined, n);
  const kit = readFileSync(join(JS, 'ui/ui-kit.js'), 'utf8');
  assert.doesNotMatch(kit, /UIK_HUD_EDGE|uikClamp|ui-size-hud/);
  assert.match(readFileSync(join(JS, 'ui/size-hud.js'), 'utf8'), /^class SizeHud\b/m);
  assert.match(readFileSync(join(JS, 'ui/size-drag.js'), 'utf8'), /^class SizeDrag\b/m);
});

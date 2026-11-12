import assert from 'node:assert/strict';
import { test } from 'node:test';

import { load, fakeClock, TERM_PANE } from './harness.mjs';

/**
 * `web/js/ui/term-gpu.js` — 터미널 GPU 렌더링의 수명 (TERMINAL_GPU_RENDER_SRS).
 *
 * WebGL 을 실제로 띄우지 않는다. 재는 것은 **언제 붙이고 언제 떼는가** 이며,
 * 그 판정에 필요한 것은 xterm 의 `loadAddon` 과 addon 의 `dispose`·`onContextLoss` 흉내다.
 */

function memStore(init = {}) {
  const m = new Map(Object.entries(init));
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)) },
    removeItem: (k) => { m.delete(k) },
  };
}

/** addon 흉내. 만든 것·버린 것을 센다. `opts.throwNew` 면 생성자가 던진다. */
function fakeAddonLib(opts = {}) {
  const lib = { made: [], throwNew: !!opts.throwNew };
  lib.WebglAddon = class {
    constructor() {
      if (lib.throwNew) throw new Error('WebGL2 not supported');
      this.disposed = 0;
      this.lossFn = null;
      lib.made.push(this);
    }
    onContextLoss(fn) { this.lossFn = fn; return { dispose() {} } }
    dispose() { this.disposed++ }
  };
  return lib;
}

function world(opts = {}) {
  const lib = 'lib' in opts ? opts.lib : fakeAddonLib();
  const globals = {
    localStorage: memStore(opts.local || {}),
    sessionStorage: memStore(),
    addEventListener() {},
  };
  if (lib) globals.WebglAddon = lib;
  const ctx = load(['core/error-log.js', 'core/pref-store.js', 'core/i18n.js', 'i18n/ko.js', 'core/constants.js',
    'core/timer-hub.js', 'ui/clipboard.js', 'ui/term-clipboard.js', ...TERM_PANE, 'ui/term-gpu.js'], {
    clock: fakeClock(),
    globals,
    expose: ['TerminalTool', 'TermGpu', 'ErrorLog', 'TERM_GPU_LOSS_LIMIT', 'STORE_KEYS'],
  });
  ctx.app = { resizeCheck: () => true, isMobile: false, tools: new Map() };
  return { ctx, lib };
}

/** 열린 칸 하나. `term` 은 `loadAddon` 만 흉내낸다. */
function pane(ctx, id = 't1', vis = true) {
  const p = new ctx.TerminalTool(id, 'tool');
  p.loaded = [];
  p.term = { loadAddon(a) { p.loaded.push(a) } };
  p.el = { classList: { contains: (c) => c === 'vis' && p.vis } };
  p.fits = 0;
  p.doFit = () => { p.fits++ };
  p.vis = vis;
  ctx.app.tools.set(id, p);
  return p;
}

const gpuErrors = (ctx) => ctx.ErrorLog.items().filter((e) => e.kind === 'gpu');

test('TC-TGR-1: 보이는 칸 + 켬이면 붙인다', () => {
  const { ctx, lib } = world();
  const p = pane(ctx);
  p.syncGpu(true);
  assert.equal(lib.made.length, 1);
  assert.equal(p.loaded.length, 1);
  assert.equal(p.gpuRenderer(), 'webgl');
});

test('TC-TGR-2: 같은 상태로 여러 번 불러도 한 번만 붙인다', () => {
  const { ctx, lib } = world();
  const p = pane(ctx);
  p.syncGpu(true); p.syncGpu(true); p.syncGpu(true);
  assert.equal(lib.made.length, 1);
  assert.equal(p.loaded.length, 1);
});

test('TC-TGR-3: 붙은 칸이 숨으면 뗀다', () => {
  const { ctx, lib } = world();
  const p = pane(ctx);
  p.syncGpu(true);
  p.syncGpu(false);
  assert.equal(lib.made[0].disposed, 1);
  assert.equal(p.gpuRenderer(), 'dom');
  p.syncGpu(false);
  assert.equal(lib.made[0].disposed, 1, '두 번 떼지 않는다');
});

test('TC-TGR-4: 설정이 꺼져 있으면 붙이지 않고, 끄면 보이는 칸에서 뗀다', () => {
  const off = world({ local: { termGpu: '0' } });
  const q = pane(off.ctx);
  q.syncGpu(true);
  assert.equal(off.lib.made.length, 0);

  const { ctx, lib } = world();
  const a = pane(ctx, 'a'), b = pane(ctx, 'b'), hidden = pane(ctx, 'h', false);
  ctx.TermGpu.apply(ctx.app);
  assert.equal(lib.made.length, 2, '보이는 칸만 붙는다');
  assert.equal(hidden.gpuRenderer(), 'dom');
  ctx.TermGpu.setEnabled(false, ctx.app);
  assert.equal(a.gpuRenderer(), 'dom');
  assert.equal(b.gpuRenderer(), 'dom');
  assert.equal(lib.made.every((x) => x.disposed === 1), true);
  assert.equal(ctx.localStorage.getItem('termGpu'), '0');
  ctx.TermGpu.setEnabled(true, ctx.app);
  assert.equal(a.gpuRenderer(), 'webgl', '켜면 곧바로 다시 붙는다 (FR-TGR-15)');
});

test('TC-TGR-5: WebglAddon 이 없으면 붙이지 않고 던지지 않는다', () => {
  const { ctx } = world({ lib: null });
  const p = pane(ctx);
  assert.doesNotThrow(() => p.syncGpu(true));
  assert.equal(p.loaded.length, 0);
  assert.equal(p.gpuRenderer(), 'dom');
});

test('TC-TGR-6: 생성이 던지면 DOM 에 남고 페이지 전체가 불가가 된다', () => {
  const lib = fakeAddonLib({ throwNew: true });
  const { ctx } = world({ lib });
  const a = pane(ctx, 'a'), b = pane(ctx, 'b');
  a.syncGpu(true);
  assert.equal(a.gpuRenderer(), 'dom');
  assert.equal(ctx.TermGpu.unavailable, true);
  lib.throwNew = false;
  b.syncGpu(true);
  assert.equal(lib.made.length, 0, '다른 칸도 다시 시도하지 않는다');
  assert.equal(gpuErrors(ctx).length, 1);
});

test('TC-TGR-6b: loadAddon 이 던지면 만든 addon 을 버리고 불가가 된다', () => {
  const { ctx, lib } = world();
  const p = pane(ctx);
  p.term.loadAddon = () => { throw new Error('context creation failed') };
  p.syncGpu(true);
  assert.equal(p.gpuRenderer(), 'dom');
  assert.equal(lib.made[0].disposed, 1);
  assert.equal(ctx.TermGpu.unavailable, true);
});

test('TC-TGR-7: 컨텍스트 손실이면 떼고, 숨었다 다시 보일 때만 다시 붙인다', () => {
  const { ctx, lib } = world();
  const p = pane(ctx);
  p.syncGpu(true);
  lib.made[0].lossFn();
  assert.equal(lib.made[0].disposed, 1);
  assert.equal(p.gpuRenderer(), 'dom');
  p.syncGpu(true);
  assert.equal(lib.made.length, 1, '보이는 동안은 다시 붙이지 않는다');
  p.syncGpu(false);
  p.syncGpu(true);
  assert.equal(lib.made.length, 2);
  assert.equal(p.gpuRenderer(), 'webgl');
  assert.equal(ctx.TermGpu.losses, 1);
});

test('TC-TGR-8: 손실이 한도에 이르면 페이지 전체가 불가가 된다', () => {
  const { ctx, lib } = world();
  assert.equal(ctx.TERM_GPU_LOSS_LIMIT, 3);
  const p = pane(ctx);
  for (let i = 0; i < ctx.TERM_GPU_LOSS_LIMIT; i++) {
    p.syncGpu(false);
    p.syncGpu(true);
    lib.made[lib.made.length - 1].lossFn();
  }
  assert.equal(ctx.TermGpu.unavailable, true);
  p.syncGpu(false);
  p.syncGpu(true);
  assert.equal(lib.made.length, ctx.TERM_GPU_LOSS_LIMIT, '이후 붙이지 않는다');
  assert.equal(gpuErrors(ctx).length, 1);
});

test('TC-TGR-9: term 이 없으면 아무 일도 없다', () => {
  const { ctx, lib } = world();
  const p = pane(ctx);
  p.term = null;
  assert.doesNotThrow(() => p.syncGpu(true));
  assert.equal(lib.made.length, 0);
});

test('TC-TGR-10: 칸이 파괴되면 참조를 버리고 이후 동기화가 던지지 않는다', () => {
  const { ctx } = world();
  const p = pane(ctx);
  p.syncGpu(true);
  p.term = null;
  p.syncGpu(true);
  assert.equal(p.gpuRenderer(), 'dom');
  assert.doesNotThrow(() => p.syncGpu(false));
});

test("TC-TGR-11: 설정 값 — 없음은 켬, '0' 은 끔, 깨진 값은 켬", () => {
  assert.equal(world().ctx.TermGpu.enabled(), true);
  assert.equal(world({ local: { termGpu: '0' } }).ctx.TermGpu.enabled(), false);
  assert.equal(world({ local: { termGpu: 'garbage' } }).ctx.TermGpu.enabled(), true);
  assert.equal(world().ctx.STORE_KEYS.termGpu, 'termGpu');
});

test('TC-TGR-13: 터치 기기는 붙이지 않고, 붙은 뒤 모바일로 바뀌면 뗀다', () => {
  const coarse = world();
  coarse.ctx.matchMedia = (q) => ({ matches: q === '(pointer: coarse)' });
  const c = pane(coarse.ctx);
  c.syncGpu(true);
  assert.equal(coarse.lib.made.length, 0);

  const { ctx, lib } = world();
  const p = pane(ctx);
  p.syncGpu(true);
  assert.equal(p.gpuRenderer(), 'webgl');
  ctx.app.isMobile = true;
  p.syncGpu(true);
  assert.equal(p.gpuRenderer(), 'dom');
  assert.equal(lib.made[0].disposed, 1);
});

test('TC-TGR-14: 설정 스위치로 바꾸면 보이는 칸만 다시 잰다', () => {
  const { ctx } = world();
  const a = pane(ctx, 'a'), h = pane(ctx, 'h', false);
  ctx.TermGpu.setEnabled(true, ctx.app);
  assert.equal(a.fits, 1, '붙인 뒤 1회');
  ctx.TermGpu.setEnabled(false, ctx.app);
  assert.equal(a.fits, 2, '뗀 뒤 1회');
  assert.equal(h.fits, 0, '숨은 칸은 재지 않는다');
});

test('TC-TGR-15: 컨텍스트 손실로 DOM 에 돌아가면 다시 잰다', () => {
  const { ctx, lib } = world();
  const p = pane(ctx);
  p.syncGpu(true);
  const before = p.fits;
  lib.made[0].lossFn();
  assert.equal(p.fits, before + 1);
});

test('TC-TGR-12:_afterLayout 은 칸마다 syncGpu 를 doFit 보다 먼저 부른다', () => {
  const log = [];
  const ctx = load(['ui/renderer-layout.js'], {
    globals: { Renderer: class {}, TIMERS: { frame: (fn) => fn() } },
  });
  const r = new ctx.Renderer();
  const mk = (id, vis) => ({
    _opened: false,
    el: { classList: { contains: (c) => c === 'vis' && vis } },
    open() { this._opened = true; log.push(id + ':open') },
    syncGpu(v) { log.push(id + ':gpu:' + v) },
    doFit() { log.push(id + ':fit') },
  });
  r.app = { tools: new Map([['a', mk('a', true)], ['h', mk('h', false)]]), windowFocused: false };
  r._moved = [];
  r._restoreScrollOf = () => {};
  r._refocus = () => {};
  r._afterLayout();
  assert.deepEqual([...log], ['a:open', 'a:gpu:true', 'a:fit', 'h:gpu:false']);
});

/**
 * FR-TGR-10 개정·10a (2026-11-12): 캔버스를 흉내 낸 칸. addon 을 실으면 캔버스가 생기고, 칸 요소는
 * 캡처 리스너를 쥔다. 캔버스의 컨텍스트는 `loseContext` 호출을 센다.
 */
function canvasPane(ctx) {
  const p = pane(ctx);
  const listeners = [];
  const canvases = [];
  const order = [];
  p.el.addEventListener = (type, fn, capture) => listeners.push({ type, fn, capture });
  p.term.element = { querySelectorAll: (sel) => (sel === 'canvas' ? canvases.slice() : []) };
  p.term.loadAddon = (a) => {
    p.loaded.push(a);
    const c = { lost: 0, getContext: (k) => (k === 'webgl2' ? c.gl : null) };
    c.gl = { getExtension: (n) => (n === 'WEBGL_lose_context' ? { loseContext() { c.lost++; order.push('lose') } } : null) };
    const link = { lost: 0, getContext: () => null };
    canvases.push(link, c);
    const dispose = a.dispose.bind(a);
    a.dispose = () => { dispose(); order.push('dispose'); canvases.splice(canvases.indexOf(link), 2) };
    a.canvas = c;
  };
  const fire = (target) => {
    for (const l of listeners) if (l.type === 'webglcontextlost' && l.capture) l.fn({ type: 'webglcontextlost', target });
  };
  return { p, fire, order };
}

test('TC-TGR-16: 그 칸 캔버스의 webglcontextlost 는 곧바로 DOM 으로 돌리고, 뒤늦은 onContextLoss 는 다시 세지 않는다', () => {
  const { ctx, lib } = world();
  const { p, fire } = canvasPane(ctx);
  p.syncGpu(true);
  const a = lib.made[0];
  fire({ other: true });
  assert.equal(p.gpuRenderer(), 'webgl', '다른 캔버스의 이벤트는 무시한다');
  fire(a.canvas);
  assert.equal(p.gpuRenderer(), 'dom');
  assert.equal(a.disposed, 1);
  assert.equal(p.fits, 1);
  assert.equal(ctx.TermGpu.losses, 1);
  a.lossFn();
  assert.equal(ctx.TermGpu.losses, 1, '이미 처리한 손실이다');
  assert.equal(p.fits, 1);
  p.syncGpu(true);
  assert.equal(lib.made.length, 1, '보이는 동안은 다시 붙이지 않는다');
});

test('TC-TGR-17: addon 을 떼면 dispose 뒤 그 캔버스의 컨텍스트를 반납한다', () => {
  const { ctx, lib } = world();
  const { p, order } = canvasPane(ctx);
  p.syncGpu(true);
  const c = lib.made[0].canvas;
  p.syncGpu(false);
  assert.equal(c.lost, 1);
  assert.equal(order.join(','), 'dispose,lose');
});

test('TC-TGR-17b: 칸을 파괴해도 GPU 컨텍스트를 반납한다', () => {
  const { ctx, lib } = world();
  const { p } = canvasPane(ctx);
  p.syncGpu(true);
  const c = lib.made[0].canvas;
  p.term.dispose = () => {};
  p.el.remove = () => {};
  p._sock = { close() {} };
  p._flingStop = () => {};
  p.destroy();
  assert.equal(c.lost, 1);
  assert.equal(p.gpuRenderer(), 'dom');
});

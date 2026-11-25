import assert from 'node:assert/strict';
import { test } from 'node:test';

import { BASE, CONSTANTS, TERM_PANE, fakeClock, load } from './harness.mjs';

/**
 * PERF 3.6.2 (FR-SPA-4 · D-40 A안) — 렌더 뒤처리(`_afterLayout`)의 GPU 붙이기를 첫 프레임 뒤로 나눈다.
 *
 * 첫 프레임은 `open`·`doFit` 만 한다. 붙일 예정인 칸의 `doFit` 은 WebGL 로 설 크기(예측값)로 잰다 — 붙인 뒤에도
 * cols·rows 가 같아 PTY 리사이즈는 칸마다 한 번이다. 보이는 칸의 WebGL 붙이기는 칸마다 `idle` 프레임 작업이다.
 * 숨은 칸 떼기는 곧바로 한다(컨텍스트 반납, FR-TGR-10a). 붙이기가 실패하면 그 칸을 DOM 크기로 다시 잰다.
 */
function layoutWorld() {
  const clock = fakeClock();
  const perf = { ms: 0 };
  const ctx = load(['core/i18n.js', 'i18n/ko.js', 'core/constants.js', 'core/timer-hub.js', 'core/event-bus.js',
    'core/channel.js', ...BASE, 'ui/screen-life.js', 'ui/renderer.js', 'ui/renderer-layout.js'], {
    clock,
    globals: { performance: { now: () => perf.ms } },
    expose: ['TimerHub', 'EventBus', 'Channel', 'Renderer', 'TIMERS'],
  });
  const timers = ctx.TIMERS;
  const bus = new ctx.EventBus({}, timers);
  const channel = new ctx.Channel(bus, timers, { pingMs: () => 1000 });
  const log = [];
  const app = { timers, bus, channel, tools: new Map(), windowFocused: false };
  ctx.app = app;
  const r = new ctx.Renderer(app);
  r._refocus = () => {};
  const env = { fail: false };
  /** 터미널 대역. 붙이기 한 번에 `cost` ms 가 든다. `env.fail` 이면 붙이기가 실패한다(FR-TGR-9). */
  const tool = (id, vis, cost = 9) => {
    const p = {
      id, _opened: true, _gpu: null, vis,
      el: { classList: { contains: (c) => c === 'vis' && p.vis } },
      open() { log.push(id + ':open'); p._opened = true },
      _gpuWant(v) { return !!v && !env.fail },
      syncGpu(v) {
        const want = !!v && !env.fail;
        if (want === !!p._gpu) return;
        log.push(id + (want ? ':gpu' : ':dom'));
        if (want) perf.ms += cost;
        p._gpu = want ? {} : null;
      },
      sizer: { doFit: () => log.push(id + ':fit') },
    };
    app.tools.set(id, p);
    return p;
  };
  return { clock, app, r, log, tool, env };
}

test('PERF 3.6.2: 첫 프레임은 open·fit 만 한다 — GPU 는 뒤 프레임이다', async () => {
  const { clock, r, log, tool } = layoutWorld();
  const a = tool('a', true); a._opened = false;
  tool('h', false).syncGpu(true);
  log.length = 0;
  r._afterLayout();
  await clock.advance(16);
  assert.deepEqual(log, ['a:open', 'a:fit', 'h:dom']);
  await clock.advance(16);
  assert.deepEqual(log, ['a:open', 'a:fit', 'h:dom', 'a:gpu', 'a:fit']);
});

test('PERF 3.6.2: 보이는 터미널 셋이면 GPU 붙이기가 서로 다른 프레임에서 돈다', async () => {
  const { clock, r, log, tool } = layoutWorld();
  for (const id of ['a', 'b', 'c']) tool(id, true);
  r._afterLayout();
  await clock.advance(16);
  const gpuFrames = [];
  for (let f = 0; f < 4; f++) {
    log.length = 0;
    await clock.advance(16);
    gpuFrames.push(log.filter((x) => x.endsWith(':gpu')));
  }
  assert.deepEqual(gpuFrames, [['a:gpu'], ['b:gpu'], ['c:gpu'], []]);
});

test('PERF 3.6.2: 이미 붙은 칸은 붙이기 작업을 걸지 않는다', async () => {
  const { clock, r, log, tool } = layoutWorld();
  tool('a', true)._gpu = {};
  r._afterLayout();
  await clock.advance(48);
  assert.deepEqual(log, ['a:fit']);
});

test('PERF 3.6.2: 뒤 프레임 붙이기가 실패하면 그 칸을 다시 잰다 (주의점 ③)', async () => {
  const { clock, r, log, tool, env } = layoutWorld();
  tool('a', true);
  r._afterLayout();
  await clock.advance(16);
  env.fail = true;
  log.length = 0;
  await clock.advance(16);
  assert.deepEqual(log, ['a:fit']);
});

test('PERF 3.6.2: 붙이기 전에 숨거나 사라진 칸은 붙이지도 재지도 않는다', async () => {
  const { clock, app, r, log, tool } = layoutWorld();
  const a = tool('a', true), b = tool('b', true);
  r._afterLayout();
  await clock.advance(16);
  a.vis = false;
  app.tools.delete('b'); b._destroyed = true;
  log.length = 0;
  await clock.advance(48);
  assert.deepEqual(log, []);
});

test('PERF 3.6.2: 다시 그려도 칸마다 붙이기는 하나로 접힌다', async () => {
  const { clock, r, log, tool } = layoutWorld();
  tool('a', true, 1);
  r._afterLayout(); r._afterLayout();
  await clock.advance(16);
  r._afterLayout();
  await clock.advance(64);
  assert.equal(log.filter((x) => x === 'a:gpu').length, 1);
});

// ── 부팅 때만 (사용자 결정 2026-11-25) ──────────────────────────────────

test('PERF 3.6.2: 부팅 뒤 새로 보이는 칸은 그 프레임에 syncGpu → doFit 한다 (FR-TGR-7 원래 순서)', async () => {
  const { clock, r, log, tool } = layoutWorld();
  tool('a', true);
  r._afterLayout();
  await clock.advance(64);
  const b = tool('b', false);
  r._afterLayout();
  await clock.advance(16);
  b.vis = true;
  log.length = 0;
  r._afterLayout();
  await clock.advance(16);
  assert.deepEqual(log, ['a:fit', 'b:gpu', 'b:fit']);
  log.length = 0;
  await clock.advance(64);
  assert.deepEqual(log, [], '뒤 프레임 붙이기 작업이 없다');
});

test('PERF 3.6.2: 부팅 첫 렌더에서 숨어 있던 칸이 나중에 보이면 그 프레임에 붙인다', async () => {
  const { clock, r, log, tool } = layoutWorld();
  tool('a', true);
  const h = tool('h', false);
  r._afterLayout();
  await clock.advance(64);
  h.vis = true;
  log.length = 0;
  r._afterLayout();
  await clock.advance(16);
  assert.deepEqual(log, ['a:fit', 'h:gpu', 'h:fit']);
});

test('PERF 3.6.2: 부팅 때 미룬 칸은 붙기 전에 다시 그려도 미룬 채 재기만 한다', async () => {
  const { clock, app, r, log, tool } = layoutWorld();
  tool('a', true); tool('b', true); tool('c', true);
  r._afterLayout();
  await clock.advance(16);
  log.length = 0;
  r._afterLayout();
  await clock.advance(16);
  // 둘째 렌더 프레임: 칸마다 fit 만 한다. 같은 프레임의 idle 작업이 하나(a) 붙는다.
  assert.deepEqual(log.filter((x) => x.endsWith(':gpu')).length <= 1, true);
  await clock.advance(64);
  assert.deepEqual([...app.tools.values()].map((p) => !!p._gpu), [true, true, true]);
});

test('PERF 3.6.2: 첫 렌더에 보이는 터미널이 없으면 부팅은 다음 렌더까지 이어진다', async () => {
  const { clock, r, log, tool } = layoutWorld();
  const a = tool('a', false);
  r._afterLayout();
  await clock.advance(16);
  a.vis = true;
  log.length = 0;
  r._afterLayout();
  await clock.advance(16);
  assert.deepEqual(log, ['a:fit']);
  await clock.advance(16);
  assert.deepEqual(log, ['a:fit', 'a:gpu', 'a:fit']);
});

// ── 예측 (주의점 ①·②) ──────────────────────────────────────────────────

function memStore() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)) }, removeItem: (k) => { m.delete(k) } };
}

/**
 * 실제 `TerminalTool`·`TermFit`·`term-gpu.js` 위에 xterm 흉내를 얹는다. 칸 상자는 `box`(부모 computed 크기),
 * 문자 크기는 `_charSizeService`, 스크롤 막대 폭은 `viewport.scrollBarWidth` 다 — addon-fit 이 읽는 그 값들이다.
 */
function fitWorld(o = {}) {
  const lib = { WebglAddon: class { onContextLoss() { return { dispose() {} } } dispose() {} } };
  const globals = {
    localStorage: memStore(), sessionStorage: memStore(), addEventListener() {},
    devicePixelRatio: o.dpr ?? 1,
    getComputedStyle: (el) => ({ getPropertyValue: (k) => (el.style[k] ?? '0px') }),
  };
  if (!o.noAddon) globals.WebglAddon = lib;
  const ctx = load(['core/error-log.js', 'core/pref-store.js', 'core/i18n.js', 'i18n/ko.js', ...CONSTANTS,
    'core/timer-hub.js', 'ui/clipboard.js', 'ui/term-clipboard.js', ...TERM_PANE, 'ui/term-gpu.js'], {
    clock: fakeClock(), globals, expose: ['TerminalTool', 'TermGpu'],
  });
  ctx.app = { isMobile: false, tools: new Map(), focus: { owner: { resizeCheck: () => o.owner !== false } } };
  const p = new ctx.TerminalTool('t1', 'tool');
  p.vis = true;
  // 부팅 때 뒤 프레임 붙이기를 기다리는 칸(`_afterLayout` 이 세운다). `o.wait === false` 면 부팅 뒤의 칸이다.
  p._gpuWait = o.wait !== false;
  p.el = { classList: { contains: (c) => c === 'vis' && p.vis } };
  p.sent = [];
  p._send = (m) => { p.sent.push(m) };
  p.fitCalls = 0;
  p.cleared = 0;
  const parent = { style: { width: (o.w ?? 1433) + 'px', height: (o.h ?? 600) + 'px' } };
  p.term = {
    cols: 80, rows: 24,
    options: { lineHeight: o.lineHeight ?? 1, letterSpacing: o.letterSpacing ?? 0, scrollback: o.scrollback ?? 1000, fontSize: 14 },
    element: { parentElement: parent, style: { 'padding-top': '0px', 'padding-bottom': '0px', 'padding-left': '0px', 'padding-right': '0px' } },
    _core: {
      _charSizeService: { width: o.charW ?? 8.43, height: o.charH ?? 17 },
      viewport: { scrollBarWidth: o.sb ?? 0 },
      _renderService: { clear: () => { p.cleared++ } },
    },
    loadAddon() {},
    resize(c, r) { this.cols = c; this.rows = r },
    write() {}, scrollToBottom() {}, focus() {},
  };
  // DOM 렌더러의 fit — 소수 px 칸 폭으로 잰다.
  p.fit = { fit: () => { p.fitCalls++; p.term.cols = Math.floor((o.w ?? 1433) / (o.charW ?? 8.43)); p.term.rows = 35 } };
  return { ctx, p };
}

test('PERF 3.6.2: 붙일 예정인 칸의 doFit 은 WebGL 칸 크기로 잰다 (DOM fit 을 부르지 않는다)', () => {
  const { p } = fitWorld();
  p.sizer.doFit();
  assert.equal(p.fitCalls, 0);
  // WebGL 칸 폭 = floor(8.43·1)/1 = 8 → 1433/8 = 179. 칸 높이 = floor(ceil(17)·1) = 17 → 600/17 = 35.
  assert.deepEqual([p.term.cols, p.term.rows], [179, 35]);
  assert.deepEqual([p._ownCols, p._ownRows], [179, 35]);
  assert.equal(p.cleared, 1, 'addon-fit 과 같이 크기가 바뀔 때 그리기를 비운다');
  p.sizer.doFit();
  assert.equal(p.cleared, 1, '크기가 같으면 다시 비우지 않는다');
});

test('PERF 3.6.2: 예측은 dpr·줄 높이·자간·스크롤 막대를 WebGL 렌더러와 같이 셈한다', () => {
  // dpr 1.5: 칸 폭 = (floor(8.43·1.5)+round(1.4))/1.5 = (12+1)/1.5 = 8.667 → (1200−14)/8.667 = 136.8 → 136.
  // 칸 높이 = floor(ceil(17.2·1.5)·1.2)/1.5 = floor(26·1.2)/1.5 = 31/1.5 = 20.667 → 500/20.667 = 24.19 → 24.
  const { p } = fitWorld({ dpr: 1.5, w: 1200, h: 500, charH: 17.2, lineHeight: 1.2, letterSpacing: 1.4, sb: 14 });
  p.sizer.doFit();
  assert.deepEqual([p.term.cols, p.term.rows], [136, 24]);
});

test('PERF 3.6.2: scrollback 0 이면 스크롤 막대 폭을 빼지 않는다 (addon-fit 과 같다)', () => {
  const { p } = fitWorld({ w: 800, sb: 14, scrollback: 0 });
  p.sizer.doFit();
  assert.equal(p.term.cols, 100);
});

test('PERF 3.6.2: 붙일 예정이 아니면 종전 DOM fit 이다 — 붙은 칸·숨은 칸·불가·설정 끔·addon 없음', () => {
  const cases = [
    ['붙은 칸', (p) => { p._gpu = {} }],
    ['숨은 칸', (p) => { p.vis = false }],
    ['손실된 칸', (p) => { p._gpuLost = true }],
  ];
  for (const [name, arrange] of cases) {
    const { p } = fitWorld();
    arrange(p);
    p.sizer.doFit();
    assert.equal(p.fitCalls, 1, name);
  }
  const off = fitWorld();
  off.ctx.TermGpu.unavailable = true;
  off.p.sizer.doFit();
  assert.equal(off.p.fitCalls, 1, 'GPU 사용 불가');
  const disabled = fitWorld();
  disabled.ctx.TermGpu._on = false;
  disabled.p.sizer.doFit();
  assert.equal(disabled.p.fitCalls, 1, '설정 끔');
  const none = fitWorld({ noAddon: true });
  none.p.sizer.doFit();
  assert.equal(none.p.fitCalls, 1, 'WebglAddon 없음');
});

test('PERF 3.6.2: 부팅 뒤의 칸(기다리지 않는 칸)은 붙기 전이라도 예측값을 쓰지 않는다', () => {
  const { p } = fitWorld({ wait: false });
  p.sizer.doFit();
  assert.equal(p.fitCalls, 1);
  assert.equal(p.term.cols, 169);
});

test('PERF 3.6.2: 문자 크기를 아직 못 쟀으면 종전 fit 에 맡긴다', () => {
  const { p } = fitWorld({ charW: 0 });
  p.sizer.doFit();
  assert.equal(p.fitCalls, 1);
});

test('PERF 3.6.2: 붙일 예정인 칸의 ptySize 는 예측값을 보낸다 (resendWindowSizes 경로)', () => {
  const { p } = fitWorld();
  assert.deepEqual({ ...p.sizer.ptySize() }, { cols: 179, rows: 35 });
});

test('PERF 3.6.2: 비소유자는 예정 상태에서도 PTY 크기를 따른다 (_followsPty 갈래 그대로)', () => {
  const { p } = fitWorld({ owner: false });
  p._ptyCols = 44; p._ptyRows = 20;
  p.sizer.doFit();
  assert.deepEqual([p.term.cols, p.term.rows], [44, 20]);
  assert.equal(p.fitCalls, 0);
});

test('PERF 3.6.2: 예측한 크기는 붙인 뒤에도 그대로다 — 리사이즈가 한 번뿐이다', () => {
  const { p } = fitWorld();
  const sizes = [];
  const resize = p.term.resize;
  p.term.resize = function (c, r) { sizes.push(c + 'x' + r); resize.call(this, c, r) };
  // fit 은 그때의 렌더러 칸 폭으로 잰다 — DOM 8.43, WebGL 8.
  p.fit.fit = () => { p.fitCalls++; const c = Math.floor(1433 / (p._gpu ? 8 : 8.43)), r = 35; if (c !== p.term.cols || r !== p.term.rows) p.term.resize(c, r) };
  p.sizer.doFit();
  p.syncGpu(true);
  p.sizer.doFit();
  assert.equal(p.gpuRenderer(), 'webgl');
  assert.deepEqual(sizes, ['179x35']);
});

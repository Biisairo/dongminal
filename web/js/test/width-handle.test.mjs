import assert from 'node:assert/strict';
import { test } from 'node:test';

import { load } from './harness.mjs';

/**
 * OPTIMIZE_REFACTOR_SRS FR-OPT-16-2 (FEU-17): Agents 패널과 사이드바의 폭 손잡이는 한 구현이다.
 *
 * 둘은 방향(오른쪽 패널은 왼쪽으로 끌면 넓어진다)·구간 상수·저장소만 다르다. 종전에는
 * `UIKit.drag` 배선을 두 벌 가졌고, 사이드바만 놓을 때 든 폭을 담았다.
 */
function memStore(seed = {}) {
  const d = new Map(Object.entries(seed));
  return { getItem: (k) => (d.has(k) ? d.get(k) : null), setItem: (k, v) => d.set(k, String(v)), removeItem: (k) => d.delete(k) };
}

function world({ local = {}, session = {}, collapsed = false, agOpen = true, dock = { left: ['sidebar'], right: ['activity'] } } = {}) {
  const vars = {};
  const drags = {};
  const node = (id, w) => ({
    id, offsetWidth: w, classList: { add() {}, remove() {}, contains: () => false },
    addEventListener() {},
  });
  const els = {
    'agents-panel': node('agents-panel', 260),
    'agents-handle': node('agents-handle', 4), 'sb-handle': node('sb-handle', 4),
  };
  const ls = memStore(local), ss = memStore(session);
  const ctx = load(['core/error-log.js', 'core/pref-store.js', 'core/panel-dock.js', 'core/constants.js', 'ui/input-binding.js'], {
    globals: {
      t: (k) => k, tn: (k) => k, localStorage: ls, sessionStorage: ss, addEventListener() {},
      document: {
        getElementById: (id) => els[id] || null,
        documentElement: { style: { setProperty: (k, v) => { vars[k] = v } } },
      },
      UIKit: { drag: (h, o) => { drags[h.id] = o }, grid: () => null },
    },
    expose: ['InputBinding', 'AGENTS_W_MIN_PX', 'AGENTS_W_MAX_PX', 'AGENTS_COLLAPSE_AT_PX', 'SIDEBAR_W_MIN_PX', 'SIDEBAR_W_MAX_PX', 'SIDEBAR_COLLAPSE_AT_PX'],
  });
  const state = { collapsed, agOpen, fits: 0 };
  const app = {
    actPanelOpen() {}, tools: new Map([['p', { el: { classList: { contains: () => true } }, doFit: () => { state.fits++ } }]]),
    focusedTerminal: () => null,
    sidebarCollapsed: () => state.collapsed,
    setSidebarCollapsed: (v) => { state.collapsed = v },
    agentsPanelOpen: () => state.agOpen,
    setAgentsPanelOpen: (v) => { state.agOpen = v },
    panelDock: () => dock,
  };
  const ib = new ctx.InputBinding(app);
  const calls = [];
  const orig = ib._bindWidthHandle;
  if (orig) ib._bindWidthHandle = function (h, o) { calls.push({ id: h.id, o }); return orig.call(this, h, o) };
  const content = node('content', 900);
  const sb = node('sidebar', 200);
  ib._bindAgentsPanel(content);
  ib._bindSidebarHandle(sb, content);
  // UIKit.drag 의 한 판: start → move(들) → end.
  const run = (id, ...dxs) => {
    const o = drags[id];
    const c = { ...o.start(), sx0: 100 };
    for (const dx of dxs) o.move(c, { clientX: 100 + dx });
    o.end(c);
    return c;
  };
  return { ctx, ib, calls, vars, run, ls, ss, state, drags };
}

test('두 손잡이가 한 구현을 지나고 구간은 상수다', () => {
  const { ctx, calls } = world();
  assert.deepEqual(calls.map((c) => c.id), ['agents-handle', 'sb-handle']);
  const [ag, sb] = calls.map((c) => c.o);
  assert.deepEqual([ag.min, ag.max], [ctx.AGENTS_W_MIN_PX, ctx.AGENTS_W_MAX_PX]);
  assert.deepEqual([sb.min, sb.max], [ctx.SIDEBAR_W_MIN_PX, ctx.SIDEBAR_W_MAX_PX]);
});

// PANEL_LAYOUT_SRS FR-PLY-1: Activity 폭도 이 탭의 것이다.
test('Agents: 왼쪽으로 끌면 넓어지고, 놓을 때 든 폭을 이 탭에 담는다', () => {
  const { vars, run, ls, ss, state } = world();
  run('agents-handle', -60);
  assert.equal(vars['--ag-w'], '320px');
  assert.equal(ss.getItem('agentsWidth'), '320');
  assert.equal(ls.getItem('agentsWidth'), null);
  assert.equal(state.fits, 1);
});

test('Agents: 구간 밖은 따라가지 않고 담지도 않는다', () => {
  const { vars, run, ls } = world();
  run('agents-handle', -400);
  assert.equal(vars['--ag-w'], undefined);
  assert.equal(ls.getItem('agentsWidth'), null);
});

// FR-PLY-23: 다른 화면에서 온 비율은 범위를 벗어날 수 있다 — 버리지 않고 접는다.
test('Agents: 담긴 폭을 되살리고, 구간 밖이면 끝으로 접는다', () => {
  assert.equal(world({ session: { agentsWidth: '300' } }).vars['--ag-w'], '300px');
  assert.equal(world({ session: { agentsWidth: '999' } }).vars['--ag-w'], '480px');
  assert.equal(world({ session: { agentsWidth: 'x' } }).vars['--ag-w'], undefined);
});

test('사이드바: 오른쪽으로 끌면 넓어지고, 놓을 때 이 창에 담는다', () => {
  const { vars, run, ss, ls } = world();
  run('sb-handle', 50);
  assert.equal(vars['--sb-w'], '250px');
  assert.equal(ss.getItem('sidebarWidth'), '250');
  assert.equal(ls.getItem('sidebarWidth'), null);
});

test('사이드바: 접기 임계 아래로 끌면 접히고 폭은 담지 않는다', () => {
  const { vars, run, ss, state, ctx } = world();
  run('sb-handle', ctx.SIDEBAR_COLLAPSE_AT_PX - 200 - 1);
  assert.equal(state.collapsed, true);
  assert.equal(vars['--sb-w'], undefined);
  assert.equal(ss.getItem('sidebarWidth'), null);
});

test('사이드바: 접힌 채로 오른쪽으로 끌면 펼쳐진다', () => {
  const { run, state, vars } = world({ collapsed: true });
  run('sb-handle', 60);
  assert.equal(state.collapsed, false);
  assert.equal(vars['--sb-w'], '260px');
});

test('양쪽 값: Agents 는 [콘텐츠, 패널], 사이드바는 [사이드바, 콘텐츠] 순이다', () => {
  const { drags } = world();
  const ag = drags['agents-handle'], sb = drags['sb-handle'];
  assert.deepEqual([...ag.sides(ag.start()).map((s) => s.px)], [900, 260]);
  assert.deepEqual([...sb.sides(sb.start()).map((s) => s.px)], [200, 900]);
});

// PANEL_DOCK_SRS FR-PDK-20~22: 방향은 드래그를 시작할 때의 자리를 따른다.
const SWAPPED = { left: ['activity'], right: ['sidebar'] };

test('FR-PDK-20: 오른쪽 사이드바는 왼쪽으로 끌면 넓어진다', () => {
  const { vars, run } = world({ dock: SWAPPED });
  run('sb-handle', -50);
  assert.equal(vars['--sb-w'], '250px');
});

test('FR-PDK-20: 왼쪽 Agents 는 오른쪽으로 끌면 넓어진다', () => {
  const { vars, run } = world({ dock: SWAPPED });
  run('agents-handle', 40);
  assert.equal(vars['--ag-w'], '300px');
});

test('FR-PDK-21: 오른쪽 사이드바는 오른쪽 끝까지 끌면 접힌다', () => {
  const { run, state, ctx } = world({ dock: SWAPPED });
  run('sb-handle', 200 - ctx.SIDEBAR_COLLAPSE_AT_PX + 1);
  assert.equal(state.collapsed, true);
});

test('FR-PDK-22: 자리가 바뀌면 양쪽 값의 순서도 바뀐다', () => {
  const { drags } = world({ dock: SWAPPED });
  const ag = drags['agents-handle'], sb = drags['sb-handle'];
  assert.deepEqual([...ag.sides(ag.start()).map((s) => s.px)], [260, 900]);
  assert.deepEqual([...sb.sides(sb.start()).map((s) => s.px)], [900, 200]);
});

test('FR-PDK-20: 방향은 시작할 때 한 번 정한다', () => {
  const dock = { left: ['sidebar'], right: ['activity'] };
  const { drags, vars } = world({ dock });
  const o = drags['sb-handle'];
  const c = { ...o.start(), sx0: 100 };
  dock.left = []; dock.right = ['sidebar', 'activity'];
  o.move(c, { clientX: 130 });
  assert.equal(vars['--sb-w'], '230px');
});

// UX_BATCH12_SRS TC-ACF-3 (FR-ACF-6): Activity 손잡이도 사이드바처럼 접고 편다.
test('TC-ACF-3: Activity 를 접기 임계 아래로 끌면 레일이 되고 폭은 담지 않는다', () => {
  const { vars, run, ss, state, ctx } = world();
  assert.equal(ctx.AGENTS_COLLAPSE_AT_PX, 70);
  run('agents-handle', 260 - ctx.AGENTS_COLLAPSE_AT_PX + 1);
  assert.equal(state.agOpen, false);
  assert.equal(vars['--ag-w'], undefined);
  assert.equal(ss.getItem('agentsWidth'), null);
});

test('TC-ACF-3: 레일에서 콘텐츠 쪽으로 끌면 펼친다', () => {
  const { run, state, vars } = world({ agOpen: false });
  run('agents-handle', -200);
  assert.equal(state.agOpen, true);
  assert.equal(vars['--ag-w'], '460px');
});

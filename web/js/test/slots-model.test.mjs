import assert from 'node:assert/strict';
import { test } from 'node:test';

import { BASE, SLOTS, load } from './harness.mjs';

/**
 * WINDOW_SLOTS_SRS — 칸 모델의 순수 규약 (TC-WSL-5·11·11b·13·14·18·18b·26·28(칸 이동)·28b).
 *
 * 종전에는 e2e(`e2e/window-slots.spec.ts`)가 브라우저를 띄워 이 판정을 쟀다. 재는 것은 DOM 이 아니라
 * `app._slots` 와 `ws.activeWindow` 의 값이므로 여기로 옮겼다 (E2E_PRUNE_REPORT §8.3 7행). 화면(강조·머리글)과
 * 키 배선(TC-WSL-28c)은 e2e 에 남는다.
 *
 * 실물: `SlotsController`·`SlotOps`·`LayoutTabOps.paneNavigate`. 대역: 앱의 나머지(창 활성화·포커스·렌더·SSE·저장소).
 * 창 활성화 대역은 실물 `_activateWindow` 처럼 `ws.activeWindow` 를 그 창으로 둔다.
 */
function world(nWins = 3) {
  const session = new Map();
  const ctx = load([...BASE, 'core/layout-tree.js', 'core/layout-tab-ops.js', ...SLOTS], {
    expose: ['SlotsController', 'LayoutTabOps', 'App'],
    globals: {
      App: class App {},
      PrefStore: { session: {
        get: (k) => (session.has(k) ? session.get(k) : null),
        set: (k, v) => { session.set(k, v) },
        json: (k, d) => (session.has(k) ? JSON.parse(session.get(k)) : d),
        setJson: (k, v) => { session.set(k, JSON.stringify(v)) },
        remove: (k) => { session.delete(k) },
      } },
      ErrorLog: { quiet: (_l, fn) => fn() },
      crypto: globalThis.crypto,   // `newUUID`(layout-tree.js) — 칸 1.. 의 신원
    },
  });
  const wins = [];
  for (let i = 0; i < nWins; i++) {
    const id = 'w' + (i + 1);
    wins.push({ id, layout: { type: 'pane', id: 'p' + (i + 1), tabs: [] }, focusedPane: 'p' + (i + 1) });
  }
  const app = new ctx.App();
  Object.assign(app, {
    clientId: 'c0',
    isMobile: false,
    ws: { windows: wins, activeWindow: wins[0].id },
    _slots: null,
    focused: wins[0].layout.id,
    tools: new Map(),
    fileEditors: new Map(),
    renders: 0,
    render() { app.renders++ },
    flattenPanes: (l) => (l.type === 'pane' ? [l] : l.children.flatMap((c) => app.flattenPanes(c))),
    bus: { openChannel: () => ({}), closeChannel: () => {} },
    wsSave: { save() {} },
    focus: { setFocusState(id) { app.focused = id }, _navNote() {}, owner: { _focusWindow() {} } },
    git: { surfaces: { _gitPanelReap() {} } },
    tool: { life: { aw: () => app.ws.windows.find((w) => w.id === app.ws.activeWindow) || null } },
    layout: { winState: { _activateWindow(id) { app.ws.activeWindow = id } } },
  });
  app.slot = new ctx.SlotsController(app);
  app.layout.tabOps = new ctx.LayoutTabOps(app);
  return { app, ids: wins.map((w) => w.id) };
}

// e2e 의 `slotsWith` 와 같은 순서 — 칸 n 개를 서로 다른 창으로 채우고 포커스를 칸 0 으로 되돌린다.
function slotsWith(app, ids, n) {
  for (let i = 1; i < n; i++) app.slot.ops.slotAdd();
  for (let i = 0; i < n; i++) app.slot.ops.slotOpen(i, ids[i]);
  app.slot.ops.slotFocusTo(0);
  return ids.slice(0, n);
}

const nav = (app, dir) => app.layout.tabOps.paneNavigate(dir);

test('TC-WSL-5: 포커스 슬롯이 activeWindow 를 정한다 (FR-WSL-3)', () => {
  const { app, ids } = world();
  const [w1, , w3] = slotsWith(app, ids, 3);
  assert.equal(app.ws.activeWindow, w1);
  app.slot.ops.slotFocusTo(2);
  assert.equal(app.ws.activeWindow, w3);
  assert.equal(app.tool.life.aw().id, w3);
  app.slot.ops.slotFocusTo(0);
  assert.equal(app.ws.activeWindow, w1);
});

test('TC-WSL-11: 창의 끝에서 한 번 더 누르면 옆 칸으로 간다 (FR-WSL-40/43)', () => {
  const { app, ids } = world();
  const [, w2] = slotsWith(app, ids, 2);
  nav(app, 'right');
  assert.equal(app._slots.focused, 1);
  assert.equal(app.ws.activeWindow, w2);
  // FR-WSL-43: 옮겨 간 칸의 창이 기억하는 pane 에 포커스가 선다.
  assert.equal(app.focused, 'p2');
  nav(app, 'left');
  assert.equal(app._slots.focused, 0);
});

test('TC-WSL-11: 창 안에 옆 pane 이 있으면 칸을 넘지 않는다 (FR-WSL-40)', () => {
  const { app, ids } = world();
  slotsWith(app, ids, 2);
  // 칸 0 의 창을 좌우로 나눈다 — 오른쪽 pane 이 먼저다.
  const w = app.ws.windows[0];
  w.layout = { type: 'split', direction: 'horizontal', children: [
    { type: 'pane', id: 'pa', tabs: [] }, { type: 'pane', id: 'pb', tabs: [] }] };
  app.focused = 'pa';
  nav(app, 'right');
  assert.equal(app._slots.focused, 0, '창 안에서 갈 곳이 있는데 칸을 넘었다');
  assert.equal(app.focused, 'pb');
  nav(app, 'right');
  assert.equal(app._slots.focused, 1, '창의 끝에서 옆 칸으로 가지 않았다');
});

test('TC-WSL-11b: 칸이 셋이면 한 칸씩 건너간다 (FR-WSL-40)', () => {
  const { app, ids } = world();
  slotsWith(app, ids, 3);
  for (const want of [1, 2]) { nav(app, 'right'); assert.equal(app._slots.focused, want) }
  for (const want of [1, 0]) { nav(app, 'left'); assert.equal(app._slots.focused, want) }
});

test('TC-WSL-13: 가로 배치에서 위아래는 칸을 넘지 않는다 (FR-WSL-42)', () => {
  const { app, ids } = world();
  slotsWith(app, ids, 2);
  assert.equal(app.slotDir, 'horizontal');
  nav(app, 'down');
  assert.equal(app._slots.focused, 0);
  nav(app, 'up');
  assert.equal(app._slots.focused, 0);
});

test('TC-WSL-14: 단일 칸·가장자리에서는 무동작이고 순환하지 않는다 (FR-WSL-44/46)', () => {
  const { app, ids } = world();
  const before = app.ws.activeWindow;
  nav(app, 'right');
  assert.equal(app.slot.slotCount(), 1);
  assert.equal(app.ws.activeWindow, before);

  slotsWith(app, ids, 2);
  app.slot.ops.slotFocusTo(1);
  // 마지막 칸에서 오른쪽 — 첫 칸으로 돌아오지 않는다.
  nav(app, 'right');
  assert.equal(app._slots.focused, 1);
});

test('TC-WSL-14: 빈 칸으로는 넘지 않는다 (FR-WSL-46)', () => {
  const { app, ids } = world();
  slotsWith(app, ids, 2);
  app._slots.windows[1] = null;
  nav(app, 'right');
  assert.equal(app._slots.focused, 0);
});

test('TC-WSL-18: + 는 포커스 칸 뒤에 같은 창으로 서고 포커스를 가져간다 (FR-WSL-52)', () => {
  const { app, ids } = world();
  const wins = slotsWith(app, ids, 3);
  app.slot.ops.slotFocusTo(1);
  app.slot.ops.slotAdd();
  const st = app._slots;
  assert.equal(st.windows.length, 4);
  assert.equal(st.focused, 2);              // 포커스 칸 **바로 뒤**
  assert.equal(st.windows[2], wins[1]);     // 같은 창
  assert.equal(st.windows[3], wins[2]);     // 뒤의 칸은 밀린다
});

test('TC-WSL-18b: − 는 포커스 칸을 없애고 포커스를 이웃으로 옮긴다 (FR-WSL-53)', () => {
  const { app, ids } = world();
  const wins = slotsWith(app, ids, 3);
  app.slot.ops.slotFocusTo(1);
  app.slot.ops.slotRemove();
  assert.deepEqual([...app._slots.windows], [wins[0], wins[2]]);
  assert.equal(app._slots.focused, 1);
  assert.equal(app.ws.activeWindow, wins[2]);
});

test('TC-WSL-26: 세로에서는 위아래가 칸을 넘는다 (FR-WSL-42)', () => {
  const { app, ids } = world();
  app.slotDir = 'vertical';
  slotsWith(app, ids, 2);
  // 좌우는 넘지 않는다 — 칸이 위아래로 놓였다.
  nav(app, 'right');
  assert.equal(app._slots.focused, 0);
  nav(app, 'down');
  assert.equal(app._slots.focused, 1);
  nav(app, 'up');
  assert.equal(app._slots.focused, 0);
});

test('TC-WSL-28: 다음·이전 칸으로 옮기고 끝에서 감긴다 (FR-WSL-56)', () => {
  const { app, ids } = world();
  const wins = slotsWith(app, ids, 3);
  assert.equal(app.slot.slotFocused(), 0);
  app.slot.ops.slotNav(1);
  assert.equal(app.slot.slotFocused(), 1);
  assert.equal(app.ws.activeWindow, wins[1]);
  app.slot.ops.slotNav(1);
  assert.equal(app.slot.slotFocused(), 2);
  // 끝에서 한 번 더 — 첫 칸으로 감긴다.
  app.slot.ops.slotNav(1);
  assert.equal(app.slot.slotFocused(), 0);
  assert.equal(app.ws.activeWindow, wins[0]);
  // 반대 방향도 같은 규약이다.
  app.slot.ops.slotNav(-1);
  assert.equal(app.slot.slotFocused(), 2);
  assert.equal(app.ws.activeWindow, wins[2]);
});

test('TC-WSL-28b: 칸이 하나면 두 액션 모두 무동작이다 (FR-WSL-56)', () => {
  const { app } = world();
  const renders = app.renders;
  app.slot.ops.slotNav(1);
  app.slot.ops.slotNav(-1);
  assert.equal(app.slot.slotCount(), 1);
  assert.equal(app.slot.slotFocused(), 0);
  assert.equal(app._slots, null);
  assert.equal(app.renders, renders);
});

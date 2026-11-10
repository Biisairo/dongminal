import assert from 'node:assert/strict';
import { test } from 'node:test';

import { load, plain } from './harness.mjs';

/**
 * PANEL_LAYOUT_SRS — 탭별 패널 상태와 저장 레이아웃 (NFR-PLY-1).
 */
const ctx = load(['core/panel-layout.js', 'core/pref-store.js'], {
  expose: ['PLY_KEYS', 'layoutParse', 'layoutSeedEntries', 'layoutFromLegacy', 'layoutCapture', 'layoutBoot', 'STORE_KEYS'],
});

function mem(init = {}) {
  const m = new Map(Object.entries(init));
  return {
    m,
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)) },
    removeItem: (k) => { m.delete(k) },
  };
}

test('키 이름은 STORE_KEYS 와 같다', () => {
  const k = ctx.PLY_KEYS, s = ctx.STORE_KEYS;
  for (const name of ['panelDock', 'repoSideDock', 'agentsPanelOpen', 'agentsWidth']) assert.equal(k[name], s[name], name);
  assert.equal(k.sidebarWidth, 'sidebarWidth');
  assert.equal(k.sidebarCollapsed, 'sidebarCollapsed');
  assert.equal(k.repoSideWidth, 'repoSideWidth');
});

test('TC-PLY-1: capture → parse 왕복, 폭은 비율이다', () => {
  const lay = ctx.layoutCapture({
    dock: { left: ['activity'], right: ['sidebar'] }, repoSide: 'right',
    sidebarPx: 300, sidebarCollapsed: true, repoSidePx: 250, activityPx: 400, activityOpen: true,
  }, 2000);
  assert.deepEqual(plain(lay), {
    v: 1, dock: { left: ['activity'], right: ['sidebar'] }, repoSide: 'right',
    sidebar: { ratio: 0.15, collapsed: true }, repoSideW: { ratio: 0.125 }, activity: { ratio: 0.2, open: true },
  });
  assert.deepEqual(plain(ctx.layoutParse(JSON.stringify(lay))), plain(lay));
});

test('TC-PLY-1: 폭을 모르면 비율을 빼고, 잘못된 필드는 버린다', () => {
  const lay = ctx.layoutCapture({ dock: null, repoSide: 'x', sidebarPx: NaN, sidebarCollapsed: false, repoSidePx: 0, activityPx: 5000, activityOpen: false }, 1000);
  assert.deepEqual(plain(lay), { v: 1, sidebar: { collapsed: false }, activity: { open: false } });
  for (const bad of [null, '', '{깨진', '42', '[]', JSON.stringify({ v: 2 })]) assert.equal(ctx.layoutParse(bad), null, String(bad));
  const p = ctx.layoutParse(JSON.stringify({ v: 1, sidebar: { ratio: 1.5, collapsed: 'yes' }, dock: { left: 'x' }, repoSide: 'up', activity: { ratio: 0.2 } }));
  assert.deepEqual(plain(p), { v: 1, sidebar: {}, activity: { ratio: 0.2 } });
});

test('TC-PLY-2: 씨앗은 비율을 이 화면의 px 로 바꾸고 범위로 접는다', () => {
  const lay = { v: 1, dock: { left: ['sidebar'], right: ['activity'] }, repoSide: 'right',
    sidebar: { ratio: 0.15, collapsed: true }, repoSideW: { ratio: 0.125 }, activity: { ratio: 0.2, open: false } };
  const e = Object.fromEntries(ctx.layoutSeedEntries(lay, 1000));
  assert.deepEqual(plain(e), {
    panelDock: JSON.stringify(lay.dock), repoSideDock: 'right',
    sidebarWidth: '150', sidebarCollapsed: '1', repoSideWidth: '125', agentsWidth: '200', agentsPanelOpen: '0',
  });
  const small = Object.fromEntries(ctx.layoutSeedEntries({ v: 1, sidebar: { ratio: 0.01 }, activity: { ratio: 0.9 }, repoSideW: { ratio: 0.9 } }, 1000));
  assert.equal(small.sidebarWidth, '100');
  assert.equal(small.agentsWidth, '480');
  assert.equal(small.repoSideWidth, '520');
});

test('TC-PLY-2: 표지가 있으면(새로고침) 씨앗을 넣지 않는다', () => {
  const local = mem({ panelLayout: JSON.stringify({ v: 1, activity: { open: true } }) });
  const session = mem({ layoutSeeded: '1', agentsPanelOpen: '0' });
  ctx.layoutBoot(local, session, 1000);
  assert.equal(session.getItem('agentsPanelOpen'), '0');
});

test('TC-PLY-2: 표지가 없으면 씨앗을 넣고 표지를 세운다. 저장 레이아웃이 없으면 쓰지 않는다', () => {
  const local = mem({ panelLayout: JSON.stringify({ v: 1, activity: { open: true } }) });
  const session = mem();
  ctx.layoutBoot(local, session, 1000);
  assert.equal(session.getItem('layoutSeeded'), '1');
  assert.equal(session.getItem('agentsPanelOpen'), '1');

  const empty = mem();
  ctx.layoutBoot(mem(), empty, 1000);
  assert.deepEqual([...empty.m.keys()], ['layoutSeeded']);
});

test('TC-PLY-3: 옛 localStorage 값은 저장 레이아웃이 되고 옛 키는 지워진다', () => {
  const local = mem({
    panelDock: JSON.stringify({ left: [], right: ['activity', 'sidebar'] }), repoSideDock: 'right',
    sidebarCollapsed: '1', agentsPanelOpen: '1', agentsWidth: '300',
  });
  const session = mem();
  ctx.layoutBoot(local, session, 1500);
  const saved = JSON.parse(local.getItem('panelLayout'));
  assert.deepEqual(saved, {
    v: 1, dock: { left: [], right: ['activity', 'sidebar'] }, repoSide: 'right',
    sidebar: { collapsed: true }, activity: { ratio: 0.2, open: true },
  });
  for (const k of ['panelDock', 'repoSideDock', 'sidebarCollapsed', 'agentsPanelOpen', 'agentsWidth']) assert.equal(local.getItem(k), null, k);
  assert.equal(session.getItem('agentsWidth'), '300');
  assert.equal(session.getItem('sidebarCollapsed'), '1');
});

test('TC-PLY-3: 저장 레이아웃이 이미 있으면 옛 값은 옮기지 않고 지우기만 한다', () => {
  const local = mem({ panelLayout: JSON.stringify({ v: 1 }), agentsWidth: '300' });
  ctx.layoutBoot(local, mem(), 1500);
  assert.equal(local.getItem('panelLayout'), JSON.stringify({ v: 1 }));
  assert.equal(local.getItem('agentsWidth'), null);
});

test('옛 값이 하나도 없으면 저장 레이아웃을 만들지 않는다', () => {
  assert.equal(ctx.layoutFromLegacy(() => null, 1000), null);
});

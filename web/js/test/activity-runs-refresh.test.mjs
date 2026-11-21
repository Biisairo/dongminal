import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AGENTS, BASE, PANELS, controllers, load } from './harness.mjs';

/**
 * ACTIVITY_RUNS_REFRESH_SRS — 패널을 여는 경로와 Runs 목록 재조회 (TC-ARR-2~4).
 *
 *   TC-ARR-2  `_runsListRestore` 가 `RunsPanel._runsRefresh` 를 부른다 (FR-ARR-3)
 *   TC-ARR-3  `agentsToggle` 로 열 때만 구역 재조회 한 번 (FR-ARR-4)
 *   TC-ARR-4  `actPanelOpen` 의 구역 재조회는 경로마다 한 번 (FR-ARR-5)
 */

function classList() {
  const s = new Set();
  return {
    contains: (c) => s.has(c),
    toggle: (c, on) => { if (on) s.add(c); else s.delete(c) },
  };
}

function rig() {
  const els = { 'agents-panel': { classList: classList() }, 'agents-handle': { classList: classList() } };
  // `_runsListRestore` 는 `app.js` 본문이다 (REFACTOR3_FE_APPCTL_SRS 9a — 옛 `app-runs.js`). 생성자는 돌리지 않는다.
  const ctx = load([...BASE, ...PANELS, 'core/app.js', ...AGENTS], {
    globals: {
      TIMERS: { disposeOwner() {} },
      ACTIVITY_STATE: { ENDED: 'ended' },
      // UX_AUDIT_FIX_SRS FR-UXF-122 로 개정: actPanelOpen 이 지금 탭(`_actTab` → `local.get`)을 읽는다.
      PrefStore: { session: { setBool() {} }, local: { setJson() {}, get() { return null }, set() {} } },
      STORE_KEYS: {},
      RunsPanel: class {},
    },
    expose: ['App'],
  });
  ctx.document.getElementById = (id) => els[id] || null;
  // `isMobile` 은 App 의 접근자다 — 시험이 값을 바꿔 넣으므로 인스턴스 속성으로 가린다.
  const app = controllers(ctx, Object.create(ctx.App.prototype, { isMobile: { value: false, writable: true } }));
  app.tools = new Map();
  app.refreshes = 0;
  app._actRefresh = () => { app.refreshes++ };
  app.agentsRender = () => {};
  app._actTabSelect = () => {};
  return { app, panel: els['agents-panel'] };
}

test('TC-ARR-2: _runsListRestore 는 Runs 목록을 한 번 다시 받는다', () => {
  const { app } = rig();
  let n = 0;
  app._runs = { _runsRefresh: () => { n++ } };
  app._runsListRestore();
  assert.equal(n, 1);
});

test('TC-ARR-3: agentsToggle 로 열면 구역 재조회 한 번, 닫을 때는 없다', () => {
  const { app, panel } = rig();
  app.agentsToggle();
  assert.equal(panel.classList.contains('open'), true);
  assert.equal(app.refreshes, 1);
  app.agentsToggle();
  assert.equal(panel.classList.contains('open'), false);
  assert.equal(app.refreshes, 1, '닫을 때 다시 받았다');
});

test('TC-ARR-4: actPanelOpen 은 닫힌 패널을 열 때도, 열린 패널에서 구역을 바꿀 때도 한 번이다', () => {
  const { app, panel } = rig();
  app.actPanelOpen('runs');
  assert.equal(panel.classList.contains('open'), true);
  assert.equal(app.refreshes, 1, '닫힌 패널을 열며 두 번 받았다');
  app.actPanelOpen('bg');
  assert.equal(app.refreshes, 2);
});

/**
 * UX_BATCH12_SRS FR-ACF-1·8·9·10 — 데스크톱에서 `.open` 이 없으면 레일이다. 레일도 보인다.
 * 모바일에서는 `.open` 이 없으면 숨는다. `setAgentsPanelOpen` 은 같은 값이면 아무것도 하지 않는다.
 */
test('FR-ACF-9: _agentsPanelShown — 데스크톱은 늘 참, 모바일은 펼침일 때만', () => {
  const { app } = rig();
  app.isMobile = false;
  assert.equal(app._agentsPanelShown(), true);
  app.isMobile = true;
  assert.equal(app._agentsPanelShown(), false);
  app.setAgentsPanelOpen(true);
  assert.equal(app._agentsPanelShown(), true);
});

test('FR-ACF-6: setAgentsPanelOpen 은 상태를 정하고, 같은 값이면 다시 받지 않는다', () => {
  const { app, panel } = rig();
  app.setAgentsPanelOpen(true);
  assert.equal(app.agentsPanelOpen(), true);
  assert.equal(app.refreshes, 1);
  app.setAgentsPanelOpen(true);
  assert.equal(app.refreshes, 1);
  app.setAgentsPanelOpen(false);
  assert.equal(panel.classList.contains('open'), false);
  assert.equal(app.agentsPanelOpen(), false);
});

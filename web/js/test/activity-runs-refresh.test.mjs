import assert from 'node:assert/strict';
import { test } from 'node:test';

import { load } from './harness.mjs';

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
  const ctx = load(['core/app-runs.js', 'core/app-agents.js', 'core/app-agents-sub.js', 'core/app-activity.js'], {
    globals: {
      App: class {},
      ACTIVITY_STATE: { ENDED: 'ended' },
      PrefStore: { session: { setBool() {} }, local: { setJson() {} } },
      STORE_KEYS: {},
      RunsPanel: class {},
    },
  });
  ctx.document.getElementById = (id) => els[id] || null;
  const app = new ctx.App();
  app.tools = new Map();
  app.refreshes = 0;
  app._actRefresh = () => { app.refreshes++ };
  app.agentsRender = () => {};
  app._actScrollTo = () => {};
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

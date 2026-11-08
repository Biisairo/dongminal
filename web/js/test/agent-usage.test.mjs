import assert from 'node:assert/strict';
import { test } from 'node:test';

import { load, plain } from './harness.mjs';

/**
 * ACTIVITY_CARD_USAGE_SRS — 에이전트 카드의 사용량 줄 (TC-ACU-6~9).
 *
 *   TC-ACU-6  값이 있는 부분만 서고, 백분율은 정수다 (FR-ACU-10·11·12·14)
 *   TC-ACU-7  등급 클래스 (FR-ACU-13)
 *   TC-ACU-8  재조정 근거 (FR-ACU-15)
 *   TC-ACU-9  SSE 덮어쓰기와 복원이 usage 를 다루는 방식 (FR-ACU-16·17)
 */
function loadAgents(globals = {}) {
  return load(['core/app-agents.js'], {
    globals: { App: class {}, ACTIVITY_STATE: { ENDED: 'ended' }, ...globals },
  });
}

const FULL = { ctxPct: 55.4, ctxLevel: 'ok', model: 'Opus 5.5', effort: 'high' };

// ── TC-ACU-6 ──

test('FR-ACU-11: 요약이 없거나 빈 요약이면 사용량 줄이 없다', () => {
  const { agentUsageView } = loadAgents();
  assert.equal(agentUsageView(undefined), null);
  assert.equal(agentUsageView(null), null);
  assert.equal(agentUsageView({}), null);
});

test('FR-ACU-10·12·14: 전부 있으면 정수 백분율 · 막대 폭 · 모델·effort · 영어 툴팁', () => {
  const { agentUsageView } = loadAgents();
  assert.deepEqual(plain(agentUsageView(FULL)), {
    pct: 55, fill: 55.4, level: 'ok', label: 'Opus 5.5·high',
    title: 'Context 55% · Opus 5.5 · effort high',
  });
});

test('FR-ACU-11: 부분만 있으면 그 부분만 선다', () => {
  const { agentUsageView } = loadAgents();
  const ctxOnly = agentUsageView({ ctxPct: 55, ctxLevel: 'ok' });
  assert.equal(ctxOnly.pct, 55);
  assert.equal(ctxOnly.label, '');
  assert.equal(ctxOnly.title, 'Context 55%');

  const modelOnly = agentUsageView({ model: 'Opus 5.5' });
  assert.equal(modelOnly.pct, null);
  assert.equal(modelOnly.fill, null);
  assert.equal(modelOnly.label, 'Opus 5.5');

  const effortOnly = agentUsageView({ effort: 'high' });
  assert.equal(effortOnly.label, 'high');
  assert.equal(effortOnly.title, 'effort high');
});

test('FR-ACU-12: 막대 폭은 0~100 으로 자른다', () => {
  const { agentUsageView } = loadAgents();
  assert.equal(agentUsageView({ ctxPct: 120 }).fill, 100);
  assert.equal(agentUsageView({ ctxPct: 120 }).pct, 120);
  assert.equal(agentUsageView({ ctxPct: -3 }).fill, 0);
});

test('FR-ACU-10·11: 줄의 순서는 막대 → 백분율 → 모델이고, 없는 부분은 원소도 없다', () => {
  const ctx = loadAgents();
  const app = new ctx.App();
  const kinds = (row) => row.children.map((c) => c.className.split(' ')[0]);
  assert.deepEqual(plain(kinds(app._agUsageEl(ctx.agentUsageView(FULL)))),
    ['ag-usage-bar', 'ag-usage-pct', 'ag-usage-model']);
  assert.deepEqual(plain(kinds(app._agUsageEl(ctx.agentUsageView({ ctxPct: 10 })))),
    ['ag-usage-bar', 'ag-usage-pct']);
  assert.deepEqual(plain(kinds(app._agUsageEl(ctx.agentUsageView({ model: 'm' })))),
    ['ag-usage-model']);

  const row = app._agUsageEl(ctx.agentUsageView(FULL));
  assert.equal(row.title, 'Context 55% · Opus 5.5 · effort high');
  assert.equal(row.children[0].children[0].style.width, '55.4%');
  assert.equal(row.children[1].textContent, '55%');
  assert.equal(row.children[2].textContent, 'Opus 5.5·high');
});

// ── TC-ACU-7 ──

test('FR-ACU-13: 등급 클래스는 warn·critical 에만 붙는다', () => {
  const ctx = loadAgents();
  const app = new ctx.App();
  const cls = (level) => app._agUsageEl(ctx.agentUsageView({ ctxPct: 50, ctxLevel: level })).className;
  assert.equal(cls('ok'), 'ag-usage');
  assert.equal(cls('warn'), 'ag-usage lv-warn');
  assert.equal(cls('critical'), 'ag-usage lv-critical');
});

// ── TC-ACU-8 ──

test('FR-ACU-15: 근거는 반올림한 백분율·등급·모델·effort 로 바뀐다', () => {
  const { agentUsageSig } = loadAgents();
  assert.equal(agentUsageSig({ ...FULL, ctxPct: 55.2 }), agentUsageSig({ ...FULL, ctxPct: 55.4 }));
  assert.notEqual(agentUsageSig({ ...FULL, ctxPct: 55 }), agentUsageSig({ ...FULL, ctxPct: 56 }));
  assert.notEqual(agentUsageSig(FULL), agentUsageSig({ ...FULL, ctxLevel: 'warn' }));
  assert.notEqual(agentUsageSig(FULL), agentUsageSig({ ...FULL, model: 'Sonnet 5.5' }));
  assert.notEqual(agentUsageSig(FULL), agentUsageSig({ ...FULL, effort: 'low' }));
  assert.equal(agentUsageSig(undefined), '');
});

// ── TC-ACU-9 ──

function stubApp(ctx) {
  const app = new ctx.App();
  app._activity = new Map();
  app._restoreNote = () => {};
  app.agentsRender = () => {};
  app._restoreBegin = () => new Set();
  app._restoreLive = () => true;
  app._restoreEnd = () => {};
  return app;
}

test('FR-ACU-17·16: 복원이 usage 를 담고, SSE 덮어쓰기는 그것을 지우지 않는다', async () => {
  let activities = [{ toolId: 't1', state: 'working', tool: 'Edit', detail: 'a', usage: FULL }];
  const ctx = loadAgents({ stateFetch: () => Promise.resolve({ ok: true, data: { activities } }) });
  const app = stubApp(ctx);

  await app._activityRestore();
  assert.deepEqual(plain(app._activity.get('t1').usage), FULL);

  app._onToolActivity({ toolId: 't1', state: 'done', tool: '', detail: '' });
  assert.equal(app._activity.get('t1').state, 'done');
  assert.deepEqual(plain(app._activity.get('t1').usage), FULL);

  activities = [{ toolId: 't1', state: 'done' }];
  await app._activityRestore();
  assert.equal(app._activity.get('t1').usage, undefined);
});

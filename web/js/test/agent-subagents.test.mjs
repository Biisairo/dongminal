import assert from 'node:assert/strict';
import { test } from 'node:test';

import { load, plain } from './harness.mjs';

/**
 * SUBAGENT_USAGE_SRS — 카드의 서브에이전트 줄 (TC-SAU-7 · 8).
 *
 *   TC-SAU-7  줄 구성·모델 글자·흐림·툴팁 (FR-SAU-20~23)
 *   TC-SAU-8  재조정 근거와 SSE·복원 (FR-SAU-24·25)
 */
function loadAgents(globals = {}) {
  return load(['core/app-agents.js'], {
    globals: { App: class {}, ACTIVITY_STATE: { ENDED: 'ended' }, ...globals },
  });
}

const RUN = {
  id: 'a1', agentType: 'Explore', status: 'running', model: 'claude-haiku-5-5', effort: 'low',
  tokens: 19250, windowTokens: 1000000, ctxPct: 1.925, ctxLevel: 'ok', startTime: 1000,
};

// ── TC-SAU-7 ──

test('FR-SAU-20·21·23: 전부 있으면 종류 · claude- 를 뗀 모델·effort · 막대 · 정수 백분율 · 영어 툴팁', () => {
  const { agentSubagentView } = loadAgents();
  assert.deepEqual(plain(agentSubagentView(RUN)), {
    type: 'Explore', label: 'haiku-5-5·low', pct: 2, fill: 1.925, level: 'ok', done: false,
    title: 'Explore · claude-haiku-5-5 · effort low · 19,250 / 1,000,000 tokens · running',
  });
});

test('FR-SAU-21: 값이 없는 부분은 없고, 종류가 없으면 agent 다', () => {
  const { agentSubagentView } = loadAgents();
  const v = agentSubagentView({ id: 'x', status: 'running' });
  assert.equal(v.type, 'agent');
  assert.equal(v.label, '');
  assert.equal(v.pct, null);
  assert.equal(v.fill, null);
  assert.equal(v.title, 'agent · running');
  assert.equal(agentSubagentView({ id: 'y', tokens: 500 }).title, 'agent · 500 tokens');
  assert.equal(agentSubagentView({ id: 'z', model: 'sonnet-x' }).label, 'sonnet-x');
});

test('FR-SAU-22: running 이 아닌 줄은 done 이다', () => {
  const { agentSubagentView } = loadAgents();
  assert.equal(agentSubagentView({ ...RUN, status: 'completed' }).done, true);
  assert.equal(agentSubagentView({ ...RUN, status: 'failed' }).done, true);
  assert.equal(agentSubagentView({ ...RUN, status: undefined }).done, true);
  assert.equal(agentSubagentView(RUN).done, false);
});

test('FR-SAU-20·22: 줄은 화살표 → 종류 → 모델 → 막대 → 백분율이고, 흐림·등급 클래스가 붙는다', () => {
  const ctx = loadAgents();
  const app = new ctx.App();
  const kinds = (row) => row.children.map((c) => c.className.split(' ')[0]);
  const row = app._agSubagentEl(ctx.agentSubagentView(RUN));
  assert.deepEqual(plain(kinds(row)), ['ag-sub-arrow', 'ag-sub-type', 'ag-sub-model', 'ag-usage-bar', 'ag-usage-pct']);
  assert.equal(row.className, 'ag-sub');
  assert.equal(row.title, 'Explore · claude-haiku-5-5 · effort low · 19,250 / 1,000,000 tokens · running');
  assert.equal(row.children[1].textContent, 'Explore');
  assert.equal(row.children[2].textContent, 'haiku-5-5·low');
  assert.equal(row.children[3].children[0].style.width, '1.925%');
  assert.equal(row.children[4].textContent, '2%');

  const done = app._agSubagentEl(ctx.agentSubagentView({ ...RUN, status: 'completed', ctxLevel: 'critical' }));
  assert.equal(done.className, 'ag-sub done lv-critical');

  const bare = app._agSubagentEl(ctx.agentSubagentView({ id: 'x', status: 'running' }));
  assert.deepEqual(plain(kinds(bare)), ['ag-sub-arrow', 'ag-sub-type']);
});

// ── TC-SAU-8 ──

test('FR-SAU-24: 근거는 그려지는 값으로 바뀐다', () => {
  const { agentSubagentsSig } = loadAgents();
  const sig = (s) => agentSubagentsSig([s]);
  assert.equal(sig({ ...RUN, ctxPct: 2.1 }), sig({ ...RUN, ctxPct: 2.3 }));
  assert.equal(sig({ ...RUN, tokens: 19300 }), sig(RUN));
  assert.notEqual(sig(RUN), sig({ ...RUN, status: 'completed' }));
  assert.notEqual(sig(RUN), sig({ ...RUN, ctxPct: 3 }));
  assert.notEqual(sig(RUN), sig({ ...RUN, ctxLevel: 'warn' }));
  assert.notEqual(sig(RUN), sig({ ...RUN, model: 'claude-opus-5-5' }));
  assert.notEqual(sig(RUN), sig({ ...RUN, effort: 'high' }));
  assert.notEqual(sig(RUN), sig({ ...RUN, agentType: 'Plan' }));
  assert.notEqual(sig(RUN), sig({ ...RUN, id: 'a2' }));
  assert.notEqual(agentSubagentsSig([RUN]), agentSubagentsSig([RUN, { ...RUN, id: 'a2' }]));
  assert.equal(agentSubagentsSig(undefined), '');
  assert.equal(agentSubagentsSig([]), '');
});

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

test('FR-SAU-25: 복원이 subagents 를 담고, SSE 덮어쓰기는 지우지 않고, 없는 응답은 지운다', async () => {
  let activities = [{ toolId: 't1', state: 'working', subagents: [RUN] }];
  const ctx = loadAgents({ stateFetch: () => Promise.resolve({ ok: true, data: { activities } }) });
  const app = stubApp(ctx);

  await app._activityRestore();
  assert.deepEqual(plain(app._activity.get('t1').subagents), [RUN]);

  app._onToolActivity({ toolId: 't1', state: 'done', tool: '', detail: '' });
  assert.deepEqual(plain(app._activity.get('t1').subagents), [RUN]);

  activities = [{ toolId: 't1', state: 'done' }];
  await app._activityRestore();
  assert.equal(app._activity.get('t1').subagents, undefined);
});

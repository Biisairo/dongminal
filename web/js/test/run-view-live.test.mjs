import assert from 'node:assert/strict';
import { test } from 'node:test';
import { load } from './harness.mjs';

/**
 * RUN_VIEW_LIVE_SRS — 열린 Run 뷰가 새로고침 없이 따라온다 (TC-RLV-4~6).
 *
 *   TC-RLV-4  멤버 도구의 활동 상태가 바뀌면 그 뷰와 목록을 다시 받는다 (FR-RLV-5·6)
 *   TC-RLV-5  주기 실행은 살아 있는 뷰만 받고 사라진 뷰는 정리한다 (FR-RLV-7·8)
 *   TC-RLV-6  상태 등록부의 `run.views` 주기 (FR-RLV-7)
 */
const ctx = load(['ui/runs-panel.js'], {
  globals: { t: (k) => k, panesOf: () => [], TIMERS: { cancel() {} } },
  expose: ['RunsPanel'],
});

function panel(views, live, list = []) {
  const p = new ctx.RunsPanel({ ws: { windows: [] }, slotBase: (k) => k });
  const fetched = [];
  let soon = 0;
  p._runsRefreshSoon = () => { soon++ };
  p._runLiveTabIds = () => new Set(live);
  p._runFetch = (v) => fetched.push(v.key);
  p._runsList = list;
  for (const v of views) p._runViewMap().set(v.key, v);
  return { p, fetched, soon: () => soon };
}

const viewA = { key: 'tab-a', runId: 'run-a', data: { members: [{ id: 'm1', toolId: 'tool-1' }] } };
const viewB = { key: 'tab-b', runId: 'run-b', data: { members: [{ id: 'm2', toolId: 'tool-2' }] } };
const listed = [{ id: 'run-a', members: [{ id: 'm1', toolId: 'tool-1' }] }];

// ── TC-RLV-4 ──

test('TC-RLV-4: 멤버 도구의 상태가 바뀌면 그 뷰만 다시 받고 목록도 받는다', () => {
  const { p, fetched, soon } = panel([viewA, viewB], ['tab-a', 'tab-b'], listed);
  p._onMemberActivity({ toolId: 'tool-1', state: 'working' });
  assert.deepEqual([...fetched], ['tab-a']);
  assert.equal(soon(), 1);
  p._onMemberActivity({ toolId: 'tool-1', state: 'done' });
  assert.deepEqual([...fetched], ['tab-a', 'tab-a']);
  assert.equal(soon(), 2);
});

test('TC-RLV-4: 같은 상태가 다시 오면(도구·detail 만 바뀜) 받지 않는다', () => {
  const { p, fetched, soon } = panel([viewA], ['tab-a'], listed);
  p._onMemberActivity({ toolId: 'tool-1', state: 'working', tool: 'Bash' });
  p._onMemberActivity({ toolId: 'tool-1', state: 'working', tool: 'Read' });
  assert.deepEqual([...fetched], ['tab-a']);
  assert.equal(soon(), 1);
});

test('TC-RLV-4: 멤버가 아닌 도구는 아무것도 받지 않는다', () => {
  const { p, fetched, soon } = panel([viewA], ['tab-a'], listed);
  p._onMemberActivity({ toolId: 'tool-x', state: 'working' });
  assert.deepEqual([...fetched], []);
  assert.equal(soon(), 0);
});

test('TC-RLV-4: 목록에만 있는 멤버는 목록만 받는다', () => {
  const { p, fetched, soon } = panel([viewB], ['tab-b'], listed);
  p._onMemberActivity({ toolId: 'tool-1', state: 'ended' });
  assert.deepEqual([...fetched], []);
  assert.equal(soon(), 1);
});

// ── TC-RLV-5 ──

test('TC-RLV-5: 주기 실행은 살아 있는 뷰만 받고 사라진 뷰는 정리한다', () => {
  const { p, fetched } = panel([viewA, viewB], ['tab-a']);
  p._runViewsRefresh();
  assert.deepEqual([...fetched], ['tab-a']);
  assert.equal(p._runViewMap().has('tab-b'), false);
  assert.equal(p._runViewMap().has('tab-a'), true);
});

// ── TC-RLV-6 ──

test('TC-RLV-6: run.views 주기는 Run 뷰가 있을 때만 활동 주기로 돈다', () => {
  const reg = load(['core/state-registry.js'], { expose: ['wireStateRegistry'] });
  const jobs = [];
  let open = false;
  let calls = 0;
  const app = {
    bus: { subscribe() {} },
    timers: { every: (spec) => jobs.push(spec) },
    agentsPollMs: 4321,
    _attn: new Map(),
    _agentsPanelOpen: () => false,
    _runViewsOpen: () => open,
    _runViewsRestore: () => { calls++ },
  };
  reg.wireStateRegistry(app);
  const job = jobs.find((j) => j.id === 'run.views');
  assert.ok(job, 'Run 뷰 주기가 없다');
  assert.equal(job.every(), 4321);
  assert.equal(job.when(), false);
  open = true;
  assert.equal(job.when(), true);
  job.run();
  assert.equal(calls, 1);
});

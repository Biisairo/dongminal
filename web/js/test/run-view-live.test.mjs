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
const ctx = load(['core/screens.js', 'ui/runs-panel.js', 'ui/run-view.js'], {
  globals: { t: (k) => k, panesOf: () => [], TIMERS: { cancel() {} } },
  expose: ['RunsPanel'],
});

function panel(views, live, list = []) {
  // `renderer.life` — 사라진 뷰는 생명주기에서도 빠진다 (PERF M3 §3.5).
  const p = new ctx.RunsPanel({ ws: { windows: [] }, slot: { slotBase: (k) => k }, renderer: { life: { unmount() {} } } });
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

// ── TC-CH3-11 (PERF M1 C3) ──

function topicPanel() {
  const subs = new Map();
  const stopped = [];
  const p = new ctx.RunsPanel({
    ws: { windows: [] }, slot: { slotBase: (k) => k }, renderer: { life: { unmount() {} } },
    channel: { sub: (topic, fn) => { subs.set(topic, fn); return { stop: () => stopped.push(topic) } } },
  });
  const painted = [];
  p._runPaint = (v) => painted.push(v.key);
  return { p, subs, stopped, painted };
}

test('TC-CH3-11: 열린 Run 화면은 run:<id> 를 구독해 그래프를 GET 없이 얹는다', async () => {
  const { p, subs, painted } = topicPanel();
  const v = { key: 'tab-a', runId: 'run-a', data: null, err: null };
  p._runViewMap().set(v.key, v);
  p._runSubscribe(v);
  assert.deepEqual([...subs.keys()], ['run:run-a']);
  await subs.get('run:run-a')({ kind: 'full', data: { runId: 'run-a', state: 'open' } });
  assert.equal(v.data.state, 'open');
  assert.deepEqual(painted, ['tab-a']);
  await subs.get('run:run-a')({ kind: 'full', data: null });
  assert.equal(v.err, 'gone', '사라진 Run 을 사라짐으로 그리지 않았다');
});

test('TC-CH3-11: 화면이 사라지거나 runId 가 바뀌면 옛 토픽을 해지한다', () => {
  const { p, subs, stopped } = topicPanel();
  const v = { key: 'tab-a', runId: 'run-a', data: null, err: null };
  p._runViewMap().set(v.key, v);
  p._runSubscribe(v);
  p._runSubscribe(v);
  assert.deepEqual(stopped, [], '같은 Run 을 두 번 구독했다');
  v.runId = 'run-b';
  p._runSubscribe(v);
  assert.deepEqual(stopped, ['run:run-a']);
  assert.ok(subs.has('run:run-b'));
  p._runDisposeView(v);
  assert.deepEqual(stopped, ['run:run-a', 'run:run-b']);
});

test('TC-CH3-8: runs 토픽의 목록을 GET 없이 얹는다', () => {
  const { p } = topicPanel();
  let painted = 0;
  p._runsPanelPaint = () => { painted++ };
  p._runsErr = 'x';
  p._runsApplyList([{ id: 'r1' }]);
  assert.equal(p._runsList.length, 1);
  assert.equal(p._runsErr, null);
  assert.equal(painted, 1);
});

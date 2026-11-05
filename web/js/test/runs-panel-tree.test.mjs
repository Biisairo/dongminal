import assert from 'node:assert/strict';
import { test } from 'node:test';
import { load } from './harness.mjs';

/**
 * ISSUE_AGENT_TREE_SRS TC-ITD-4 (FR-ITD-7): 트리 뷰는 자기 Run 이거나 같은 트리의 변경에만
 * 다시 받는다. 다른 트리·트리 아닌 Run 의 `run_changed` 로는 요청하지 않는다.
 */
const ctx = load(['ui/runs-panel.js'], {
  globals: { t: (k) => k, panesOf: () => [] },
  expose: ['RunsPanel'],
});

function panel(views) {
  const p = new ctx.RunsPanel({ ws: { windows: [] }, slotBase: (k) => k });
  const fetched = [];
  p._runsRefreshSoon = () => {};
  p._runLiveTabIds = () => new Set(views.map((v) => v.key));
  p._runFetch = (v) => fetched.push(v.key);
  for (const v of views) p._runViewMap().set(v.key, v);
  return { p, fetched };
}

const treeView = { key: 'tab-a', runId: 'run-a', data: { tree: 'o/r#1' } };
const plainView = { key: 'tab-p', runId: 'run-p', data: {} };

test('자기 Run 의 변경에는 다시 받는다', () => {
  const { p, fetched } = panel([treeView, plainView]);
  p._onRunChanged({ runId: 'run-a', tree: 'o/r#1' });
  assert.deepEqual([...fetched], ['tab-a']);
});

test('같은 트리의 다른 Run 변경에는 트리 뷰가 다시 받는다', () => {
  const { p, fetched } = panel([treeView, plainView]);
  p._onRunChanged({ runId: 'run-b', tree: 'o/r#1' });
  assert.deepEqual([...fetched], ['tab-a']);
});

test('다른 트리의 변경에는 받지 않는다', () => {
  const { p, fetched } = panel([treeView, plainView]);
  p._onRunChanged({ runId: 'run-c', tree: 'o/r#2' });
  assert.deepEqual([...fetched], []);
});

test('트리 아닌 Run 의 변경에는 트리 뷰가 받지 않는다', () => {
  const { p, fetched } = panel([treeView, plainView]);
  p._onRunChanged({ runId: 'run-x' });
  assert.deepEqual([...fetched], []);
});

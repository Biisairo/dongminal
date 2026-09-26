import assert from 'node:assert/strict';
import { test } from 'node:test';

import { load } from './harness.mjs';

/**
 * OPTIMIZE_REFACTOR_SRS FR-OPT-11-2 (FEC-22): `closeTab` 을 나눠도 **물을 것이 없는 닫기는 같은
 * 틱에 끝난다.** 부른 쪽이 await 없이 곧바로 그리는 자리가 있다(Run 탭 닫기 → render →
 * run 변경 수신, e2e `slot-run-view` TC-SRV-6). 나눈 뒤 묻기를 늘 기다리게 해서 그것이 깨졌었다.
 */
function world() {
  const ctx = load(['core/app-layout.js'], {
    globals: {
      App: function App() {}, TAB_TYPE_TERMINAL: 'terminal', TAB_TYPE_EDITOR: 'editor', TAB_TYPE_RUN: 'run',
      TAB_TYPE_GIT: 'git',
      findPane: (layout, id) => (layout && layout.id === id ? layout : null),
      doRemove: () => null, firstPane: () => null,
    },
  });
  const a = new ctx.App();
  const pane = { type: 'pane', id: 'p1', tabs: [{ id: 'r1', type: 'run', runId: 'x' }, { id: 't2', type: 'terminal', toolId: 'k' }], activeTab: 'r1' };
  const win = { id: 'w1', layout: pane };
  a.ws = { activeWindow: 'w1', windows: [win] };
  a.aw = () => win;
  a.calls = [];
  for (const m of ['paneTabSet', 'setFocusState', '_focusWindow', 'render', 'save', '_killTool', 'editorsDrop', '_gitRescheduleAll']) {
    a[m] = (...args) => { a.calls.push(m) };
  }
  a._isToolBusy = async () => false;
  return { a, pane };
}

test('Run 탭 닫기는 같은 틱에 탭을 빼고 그린다', () => {
  const { a, pane } = world();
  a.closeTab('p1', 'r1');
  assert.deepEqual(pane.tabs.map((x) => x.id), ['t2']);
  assert.ok(a.calls.includes('render'));
});

test('도구가 있는 탭은 busy 를 물은 뒤에 닫는다', async () => {
  const { a, pane } = world();
  const p = a.closeTab('p1', 't2');
  assert.equal(pane.tabs.length, 2, '묻기 전에는 빼지 않는다');
  await p;
  assert.deepEqual(pane.tabs.map((x) => x.id), ['r1']);
  assert.ok(a.calls.includes('_killTool'));
});

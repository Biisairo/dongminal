import assert from 'node:assert/strict';
import { test } from 'node:test';

import { BASE, LAYOUT, controllers, load, plain } from './harness.mjs';

/**
 * ISSUE_AGENT_TREE_SRS FR-WGR-21·22·24 — 사이드바의 그룹 접기와 끌어 놓기.
 *
 *   FR-WGR-21·22 활성 window 가 든 그룹도 접을 수 있다. 펼치는 것은 접힌 그룹 안의
 *                window 가 활성이 **되는 순간**뿐이다.
 *   FR-WGR-24    그룹 안 window 의 위·아래에 놓을 때 포인터가 들여쓰기 왼쪽이면(`out`)
 *                그룹 밖, 그룹의 앞·뒤에 놓인다. 오른쪽이면 지금처럼 그룹 안이다.
 */
function setup(windows, groups, active) {
  const stored = {};
  const ctx = load([...BASE, 'core/window-order.js', ...LAYOUT], {
    globals: {
      App: function App() {}, TIMERS: { disposeOwner() {} },
      TAB_TYPE_TERMINAL: 'terminal', TAB_TYPE_EDITOR: 'editor', TAB_TYPE_RUN: 'run', TAB_TYPE_CHAT: 'chat', TAB_TYPE_GIT: 'git',
      t: (k) => k,
      STORE_KEYS: { windowGroupFold: 'fold' },
      PrefStore: { local: { json: (k, d) => (k in stored ? stored[k] : d), setJson: (k, v) => { stored[k] = v } } },
    },
  });
  const app = controllers(ctx, new ctx.App());
  app.ws = { windows, windowGroups: groups, activeWindow: active };
  app.git.plainWindows = () => app.ws.windows.filter((w) => !w.type);
  app.render = () => {};
  return app;
}

const W = (id, groupId) => Object.assign({ id }, groupId ? { groupId } : {});
const order = (app) => plain(app.ws.windows.map((w) => w.id + (w.groupId ? '@' + w.groupId : '')));
const folded = (app, gid) => app.sidebarWindowEntries().find((e) => e.kind === 'group' && e.group.id === gid).folded;

test('FR-WGR-21·22: 활성 window 가 든 그룹도 접힌 채로 남는다', () => {
  const app = setup([W('a', 'g'), W('b', 'g'), W('c')], [{ id: 'g', name: 'G' }], 'a');
  app.sidebarWindowEntries(); // 시작할 때 목록을 한 번 그린다
  app.wgFoldToggle('g');
  assert.equal(folded(app, 'g'), true, '접은 그룹이 다시 펼쳐졌다');
  assert.equal(folded(app, 'g'), true, '두 번째 그리기에서 펼쳐졌다');
});

test('FR-WGR-22: 활성 window 가 접힌 그룹 안으로 들어오면 펼친다', () => {
  const app = setup([W('a', 'g'), W('b', 'g'), W('c')], [{ id: 'g', name: 'G' }], 'c');
  app.wgFoldToggle('g');
  assert.equal(folded(app, 'g'), true);
  app.ws.activeWindow = 'b';
  assert.equal(folded(app, 'g'), false, '들어온 순간 펼쳐야 한다');
  app.wgFoldToggle('g');
  assert.equal(folded(app, 'g'), true, '들어온 뒤에는 다시 접을 수 있어야 한다');
  app.ws.activeWindow = 'c'; // 그룹 밖으로 나가도 접힌 채다
  assert.equal(folded(app, 'g'), true);
});

const G = [{ id: 'g', name: 'G' }];
const KEY = 'grp:';

test('FR-WGR-24: 그룹 마지막 window 아래, 들여쓰기 안쪽이면 그룹 안 끝이다', () => {
  const app = setup([W('a', 'g'), W('b', 'g'), W('c')], G, 'c');
  assert.equal(app.sidebarReorder({ src: 'c', target: 'b', before: false, out: false }), true);
  assert.deepEqual(order(app), ['a@g', 'b@g', 'c@g']);
});

test('FR-WGR-24: 그룹 마지막 window 아래, 들여쓰기 왼쪽이면 그룹 바로 뒤(밖)다', () => {
  const app = setup([W('x'), W('a', 'g'), W('b', 'g'), W('c')], G, 'c');
  assert.equal(app.sidebarReorder({ src: 'x', target: 'b', before: false, out: true }), true);
  assert.deepEqual(order(app), ['a@g', 'b@g', 'x', 'c']);
});

test('FR-WGR-24: 그룹 첫 window 위, 들여쓰기 왼쪽이면 그룹 바로 앞(밖)이다', () => {
  const app = setup([W('a', 'g'), W('b', 'g'), W('c')], G, 'c');
  assert.equal(app.sidebarReorder({ src: 'c', target: 'a', before: true, out: true }), true);
  assert.deepEqual(order(app), ['c', 'a@g', 'b@g']);
});

test('FR-WGR-24: 그룹 안 window 를 끌어 그 그룹 뒤로 빼낼 수 있다', () => {
  const app = setup([W('a', 'g'), W('b', 'g'), W('c')], G, 'c');
  assert.equal(app.sidebarReorder({ src: 'a', target: 'b', before: false, out: true }), true);
  assert.deepEqual(order(app), ['b@g', 'a', 'c']);
});

test('FR-WGR-24: 그룹 가운데 window 사이에서는 out 이어도 그룹 안이다', () => {
  const app = setup([W('a', 'g'), W('b', 'g'), W('d', 'g'), W('c')], G, 'c');
  assert.equal(app.sidebarReorder({ src: 'c', target: 'a', before: false, out: true }), true);
  assert.deepEqual(order(app), ['a@g', 'c@g', 'b@g', 'd@g']);
});

test('그룹 머리를 끄는 것은 out 과 상관없다', () => {
  const app = setup([W('c'), W('a', 'g'), W('b', 'g')], G, 'c');
  assert.equal(app.sidebarReorder({ src: KEY + 'g', target: 'c', before: true, out: true }), true);
  assert.deepEqual(order(app), ['a@g', 'b@g', 'c']);
});

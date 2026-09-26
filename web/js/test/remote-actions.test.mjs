import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { load, plain } from './harness.mjs';

/**
 * OPTIMIZE_REFACTOR_SRS FR-OPT-11-2 (FEC-23 · IPC-17): `_execRemote` 는 action 표다.
 *
 * 표의 이름은 서버의 허용 표(`hub/commands.go` `cmdActions`)와 **같은 집합**이다 —
 * 서버가 받는 action 은 전부 여기 처리기가 있고, 받지 않는 action 의 처리기는 없다.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..', '..');

function serverActions() {
  const src = readFileSync(join(ROOT, 'internal/webserver/hub/commands.go'), 'utf8');
  const i = src.indexOf('var cmdActions = map[string]cmdSpec{');
  assert.ok(i >= 0, 'cmdActions 표가 있다');
  const body = src.slice(i, src.indexOf('\n}\n', i));
  return [...body.matchAll(/^\s*"([A-Za-z]+)":/gm)].map((m) => m[1]).sort();
}

function world() {
  const ctx = load(['core/app-cmd.js'], {
    globals: { App: function App() {}, TAB_TYPE_TERMINAL: 'terminal' },
    expose: ['REMOTE_ACTIONS'],
  });
  const calls = [];
  const a = new ctx.App();
  const rec = (name, ret) => (...args) => { calls.push(plain([name, ...args])); return ret };
  a.calls = calls;
  a.ws = { activeWindow: 'w1', windows: [{ id: 'w1' }] };
  a.focused = 'p1';
  a._resolveLocation = (loc) => (loc === 'W1.P1.T1'
    ? { windowId: 'w1', paneId: 'p1', tabId: 't1', win: { id: 'w1' }, pane: { id: 'p1' }, tab: { id: 't1' } }
    : null);
  a._focusLocation = rec('_focusLocation');
  a.executeAction = rec('executeAction');
  a._viewMark = () => null;
  a._viewRestore = rec('_viewRestore');
  a.closeTab = rec('closeTab');
  a.closeWindowActive = rec('closeWindowActive');
  a.render = rec('render');
  a._notify = rec('_notify');
  a._echoResult = rec('_echoResult');
  a.addTab = (...args) => { calls.push(['addTab', ...args]); return Promise.resolve({ uuid: 'tNew', toolId: 'x' }) };
  a.split = (...args) => { calls.push(['split', ...args]); return Promise.resolve({ panes: ['pN'], tabs: ['tN'] }) };
  a._mkWindow = (...args) => { calls.push(['_mkWindow', ...args]); return Promise.resolve({ win: 'wN', pane: 'pN', tab: 'tN' }) };
  return { ctx, a, calls };
}

const tick = () => new Promise((r) => setImmediate(r));

test('처리기 표의 이름은 서버 허용 표와 같은 집합이다', () => {
  const { ctx } = world();
  assert.deepEqual(Object.keys(ctx.REMOTE_ACTIONS).sort(), serverActions());
});

test('처리기는 전부 함수다', () => {
  const { ctx } = world();
  for (const [k, v] of Object.entries(ctx.REMOTE_ACTIONS)) assert.equal(typeof v, 'function', k);
});

test('closeTab 의 자리를 못 찾으면 아무것도 닫지 않는다 (FR-RUN-6b)', () => {
  const { a, calls } = world();
  a._execRemote('closeTab', { location: 'W9.P9.T9' });
  assert.deepEqual(calls.filter((c) => c[0] === 'closeTab' || c[0] === 'executeAction'), []);
});

test('closeTab 에 자리가 있으면 그 탭을 닫고, 없으면 공통 경로다', () => {
  const { a, calls } = world();
  a._execRemote('closeTab', { location: 'W1.P1.T1', force: true });
  assert.deepEqual(calls.find((c) => c[0] === 'closeTab'), ['closeTab', 'p1', 't1', 'w1', { force: true }]);
  a._execRemote('closeTab', {});
  assert.deepEqual(calls.find((c) => c[0] === 'executeAction'), ['executeAction', 'closeTab']);
});

test('closeWindow 는 답(force·keepTool)이 있을 때만 직접 닫고, 아니면 공통 경로다', async () => {
  const { a, calls } = world();
  a._execRemote('closeWindow', {});
  assert.deepEqual(calls.find((c) => c[0] === 'executeAction'), ['executeAction', 'closeWindow']);
  assert.equal(calls.find((c) => c[0] === 'closeWindowActive'), undefined);
  a._execRemote('closeWindow', { force: true, keepTool: true });
  assert.deepEqual(calls.find((c) => c[0] === 'closeWindowActive'), ['closeWindowActive', { force: true, keepTool: true }]);
});

test('시선 이동 action 은 executeAction 으로 간다', () => {
  const { a, calls } = world();
  for (const act of ['windowNext', 'tabPrev', 'paneLeft']) a._execRemote(act, {});
  assert.deepEqual(calls.filter((c) => c[0] === 'executeAction').map((c) => c[1]), ['windowNext', 'tabPrev', 'paneLeft']);
});

test('생성 명령은 처리기의 결과를 reqId 로 echo 한다', async () => {
  const { a, calls } = world();
  a._execRemote('newTab', { reqId: 'r1' });
  a._execRemote('splitV', { reqId: 'r2', location: 'W1.P1.T1' });
  a._execRemote('newWindow', { reqId: 'r3', name: 'n' });
  await tick();
  const echoes = calls.filter((c) => c[0] === '_echoResult').sort((x, y) => x[1].localeCompare(y[1]));
  assert.deepEqual(JSON.parse(JSON.stringify(echoes)), [
    ['_echoResult', 'r1', { newTabs: [{ uuid: 'tNew', toolId: 'x' }] }],
    ['_echoResult', 'r2', { newPanes: ['pN'], newTabs: ['tN'] }],
    ['_echoResult', 'r3', { newWindows: ['wN'], newPanes: ['pN'], newTabs: ['tN'] }],
  ]);
  const sp = calls.find((c) => c[0] === 'split');
  assert.equal(sp[1], 'vertical');
  assert.equal(sp[2].targetPane, 'p1');
});

test('reqId 가 없으면 echo 하지 않는다', async () => {
  const { a, calls } = world();
  a._execRemote('newTab', {});
  await tick();
  assert.equal(calls.filter((c) => c[0] === '_echoResult').length, 0);
});

test('표에 없는 action 은 종전처럼 공통 경로로 간다', () => {
  const { a, calls } = world();
  a._execRemote('focusBack', {});
  assert.deepEqual(calls.find((c) => c[0] === 'executeAction'), ['executeAction', 'focusBack']);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { load, plain } from './harness.mjs';

/**
 * UX_AUDIT_FIX_SRS §3.14 (FR-UXF-110~112, D-37): 에이전트 구역의 순서는 창 순서 · 생성 순서 · 끌어 놓은 순서뿐이다.
 * 상태로 자리를 옮기지 않고, 그리기가 저장된 순서를 지우지 않는다.
 */
function setup({ windows, where, order = [] }) {
  const ctx = load(['core/app-agents.js', 'core/app-agents-sub.js'], {
    globals: {
      App: class {},
      ACTIVITY_STATE: { ENDED: 'ended', WORKING: 'working', DONE: 'done', WAITING: 'waiting', IDLE: 'idle' },
      AGENT_STATE_ICON: {}, AGENT_STATE_LABEL: {},
      PrefStore: { local: { json: (_k, d) => d, setJson() {}, remove() {} } },
      STORE_KEYS: { agentsGroupFold: 'f' },
    },
  });
  const app = new ctx.App();
  app.ws = { windows: windows.map((id) => ({ id })), agentsOrder: order.slice() };
  app._activity = new Map();
  app.findToolLocation = (id) => (where[id] ? { win: { id: where[id] }, tab: { name: id } } : null);
  app.attnHas = () => false;
  return app;
}

const report = (app, id, state = 'working') => app._activity.set(id, { state });
const cards = (app) => plain(app._agWindowItems().filter((x) => x.t === 'card').map((x) => x.toolId));
const groups = (app) => plain(app._agWindowItems().filter((x) => x.t === 'group').map((x) => x.win.id));

test('TC-UXF-110: 승인 대기여도 카드와 그룹이 자리를 옮기지 않는다', () => {
  const app = setup({ windows: ['w1', 'w2'], where: { a: 'w1', b: 'w1', c: 'w2' }, order: ['a', 'b', 'c'] });
  report(app, 'a'); report(app, 'b'); report(app, 'c');
  assert.deepEqual(cards(app), ['a', 'b', 'c']);
  report(app, 'b', 'waiting'); report(app, 'c', 'waiting');
  assert.deepEqual(cards(app), ['a', 'b', 'c']);
  assert.deepEqual(groups(app), ['w1', 'w2']);
});

test('TC-UXF-111: 저장된 순서에 없는 에이전트는 생성 순서(id 사전순)로 끝에 붙는다', () => {
  const ids = ['01a1f6a1-0000-7000-8000-000000000001', '01a1f6a1-0000-7000-8000-000000000002', '01a1f6a1-0000-7000-8000-000000000003'];
  const where = Object.fromEntries(ids.map((id) => [id, 'w1']));
  const app = setup({ windows: ['w1'], where });
  // 보고는 생성 순서와 다르게 도착한다.
  report(app, ids[2]); report(app, ids[0]); report(app, ids[1]);
  assert.deepEqual(cards(app), ids);
});

test('TC-UXF-112: 보고가 비었다가 다시 와도 저장된 순서가 그대로다', () => {
  const app = setup({ windows: ['w1'], where: { a: 'w1', b: 'w1', c: 'w1' }, order: ['c', 'a', 'b'] });
  // 복원 직전 — 보고가 하나도 없다. 이때 그려도 저장된 순서를 지우지 않는다.
  assert.deepEqual(cards(app), []);
  assert.deepEqual(plain(app.ws.agentsOrder), ['c', 'a', 'b']);
  // 보고가 도착 순서대로 다시 온다.
  report(app, 'a'); report(app, 'b'); report(app, 'c');
  assert.deepEqual(cards(app), ['c', 'a', 'b']);
  assert.deepEqual(plain(app.ws.agentsOrder), ['c', 'a', 'b']);
});

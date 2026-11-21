import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AGENTS, BASE, TOOL, controllers, load } from './harness.mjs';

/**
 * UX_AUDIT_FIX_SRS TC-UXF-62 의 unit 부분 (FR-UXF-60·63) — 작업 중 판정과 에이전트 탭 배지.
 */
const ACTIVITY_STATE = { WORKING: 'working', WAITING: 'waiting', DONE: 'done', IDLE: 'idle', ENDED: 'ended' };

function setup(acts, { located = () => true, attn = new Set() } = {}) {
  const ctx = load([...BASE, ...AGENTS, ...TOOL], {
    expose: ['ACTIVITY_SECTIONS'],
    globals: { App: function App() {}, TIMERS: { disposeOwner() {} }, t: (k) => k, ACTIVITY_STATE },
  });
  const app = controllers(ctx, new ctx.App());
  app._activity = new Map(Object.entries(acts).map(([id, state]) => [id, { state }]));
  app.findToolLocation = located;
  app.attnHas = (id) => attn.has(id);
  const agents = ctx.ACTIVITY_SECTIONS.find((s) => s.key === 'agents');
  return { app, badge: (its) => JSON.parse(JSON.stringify(agents.badge(app, its))) };
}

test('TC-UXF-62: 배지는 자리가 있는 작업 중 에이전트의 수다', () => {
  const { badge } = setup({ a: 'working', b: 'working', c: 'done' });
  assert.deepEqual(badge([]), { n: 2, dot: false });
});

test('TC-UXF-62: 자리가 없는 도구는 세지 않는다', () => {
  const { badge } = setup({ a: 'working', b: 'working' }, { located: (id) => id === 'a' });
  assert.deepEqual(badge([]), { n: 1, dot: false });
});

test('TC-UXF-62: 주의가 있는 그룹이 있으면 수 대신 점이다', () => {
  const { badge } = setup({ a: 'working' });
  assert.deepEqual(badge([{ t: 'group', attn: 1 }]), { n: 0, dot: true });
});

test('FR-UXF-61: 주의가 있는 탭에는 작업 중 점을 두지 않는다', () => {
  const { app } = setup({ a: 'working', b: 'working', c: 'waiting' }, { attn: new Set(['b']) });
  assert.equal(app.tabWorkDot('a'), true);
  assert.equal(app.tabWorkDot('b'), false);
  assert.equal(app.tabWorkDot('c'), false);
  assert.equal(app.tabWorkDot(undefined), false);
});

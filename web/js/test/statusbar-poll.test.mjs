import assert from 'node:assert/strict';
import { test } from 'node:test';

import { BASE, load } from './harness.mjs';

/**
 * REFACTOR3_FE_REST1_SRS FR-FR1-14 (FC-21): 상태바 회차의 ping·stats 를 함께 보낸다.
 *   이전 동작: ping 응답을 기다린 뒤 stats 를 보냈다(회차당 직렬 2왕복)
 *   새  동작: 둘을 곧바로 보내고, 두 응답이 모두 온 뒤 지금 순서대로 처리한다
 *   이유:     회차 대기가 RTT 두 번에서 한 번으로 준다. `_latency` 는 그대로 ping 의 왕복이다(D-FR1-10)
 */
function setup() {
  const calls = [];
  const clock = { now: 0 };
  const ctx = load([...BASE, 'core/statusbar-controller.js', 'core/statusbar-enc.js'], {
    expose: ['StatusBarController'],
    globals: {
      App: class {},
      performance: { now: () => clock.now },
      apiGet: (path, opts) => new Promise((resolve) => calls.push({ path, opts, resolve })),
    },
  });
  const settles = [];
  let updates = 0;
  const app = {
    _stats: { cpu: 1 }, _latency: 5,
    _gitJobsBegin: () => 7,
    _gitJobsSettle: (jt, jobs) => settles.push([jt, jobs]),
    updateStatusBar: () => { updates++ },
  };
  const sb = new ctx.StatusBarController(app);
  return { sb, app, calls, clock, settles, updates: () => updates };
}
const tick = () => new Promise((r) => setImmediate(r));
const req = (calls, p) => calls.find((c) => c.path === p);

test('TC-FR1-9: ping 응답 전에 stats 를 보낸다', async () => {
  const { sb, calls } = setup();
  const done = sb._pollStats();
  await tick();
  assert.deepEqual(calls.map((c) => c.path), ['/api/ping', '/api/stats']);
  assert.equal(JSON.stringify(req(calls, '/api/stats').opts), JSON.stringify({ query: { jobs: '1' } }));
  req(calls, '/api/ping').resolve({ ok: true, status: 200 });
  req(calls, '/api/stats').resolve({ ok: true, status: 200, data: {} });
  await done;
});

test('TC-FR1-9: 지연은 ping 의 왕복만 잰다 — stats 가 늦어도 늘지 않는다', async () => {
  const { sb, app, calls, clock, settles, updates } = setup();
  clock.now = 100;
  const done = sb._pollStats();
  await tick();
  clock.now = 130;
  req(calls, '/api/ping').resolve({ ok: true, status: 200 });
  await tick();
  assert.equal(updates(), 0, '두 응답 전에는 그리지 않는다');
  clock.now = 400;
  req(calls, '/api/stats').resolve({ ok: true, status: 200, data: { cpu: 9, jobs: [{ id: 'j' }] } });
  await done;
  assert.equal(app._latency, 30);
  assert.deepEqual(settles, [[7, [{ id: 'j' }]]]);
  assert.deepEqual(app._stats, { cpu: 9 });
  assert.equal(updates(), 1);
});

test('TC-FR1-9: stats 가 먼저 와도 처리는 두 응답 뒤 한 번이다', async () => {
  const { sb, app, calls, clock, updates } = setup();
  const done = sb._pollStats();
  await tick();
  req(calls, '/api/stats').resolve({ ok: true, status: 200, data: { cpu: 3 } });
  await tick();
  assert.equal(updates(), 0);
  assert.deepEqual(app._stats, { cpu: 1 });
  clock.now = 12;
  req(calls, '/api/ping').resolve({ ok: true, status: 200 });
  await done;
  assert.equal(app._latency, 12);
  assert.deepEqual(app._stats, { cpu: 3 });
  assert.equal(updates(), 1);
});

test('TC-FR1-9: ping 이 망 실패면 지연은 null 이고 stats 는 그대로 받는다', async () => {
  const { sb, app, calls, updates } = setup();
  const done = sb._pollStats();
  await tick();
  req(calls, '/api/ping').resolve({ ok: false, status: 0 });
  req(calls, '/api/stats').resolve({ ok: true, status: 200, data: { cpu: 4 } });
  await done;
  assert.equal(app._latency, null);
  assert.deepEqual(app._stats, { cpu: 4 });
  assert.equal(updates(), 1);
});

test('TC-FR1-9: stats 가 실패하면 지표를 두고 작업 목록은 null 로 정산한다', async () => {
  const { sb, app, calls, settles, updates } = setup();
  const done = sb._pollStats();
  await tick();
  req(calls, '/api/ping').resolve({ ok: true, status: 200 });
  req(calls, '/api/stats').resolve({ ok: false, status: 0 });
  await done;
  assert.deepEqual(app._stats, { cpu: 1 });
  assert.deepEqual(settles, [[7, null]]);
  assert.equal(updates(), 1);
});

test('TC-FR1-9: git 패널이 없으면(작업 표 없음) stats 에 jobs 를 묻지 않는다', async () => {
  const { sb, app, calls, settles } = setup();
  app._gitJobsBegin = () => 0;
  const done = sb._pollStats();
  await tick();
  assert.equal(req(calls, '/api/stats').opts, undefined);
  req(calls, '/api/ping').resolve({ ok: true, status: 200 });
  req(calls, '/api/stats').resolve({ ok: true, status: 200, data: {} });
  await done;
  assert.deepEqual(settles, []);
});

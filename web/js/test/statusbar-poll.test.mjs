import assert from 'node:assert/strict';
import { test } from 'node:test';

import { BASE, load } from './harness.mjs';

/**
 * PERF M1 C3 TC-CH3-10 — 상태바는 묻지 않는다.
 *   이전 동작: `statsInterval` 마다 `/api/ping`·`/api/stats` 를 보냈다 (FR-FR1-14)
 *   새  동작: 채널의 `stats:<statsInterval>` 을 구독하고, 지연은 채널 ping 의 왕복이다
 *   이유:     유휴 요청을 없앤다 (FR-CON-7)
 */
function setup({ interval = 3000 } = {}) {
  const gets = [];
  const subs = new Map();
  const busSubs = new Map();
  let latency = 12;
  const ctx = load([...BASE, 'core/statusbar-controller.js', 'core/statusbar-enc.js'], {
    expose: ['StatusBarController'],
    globals: { App: class {}, apiGet: (p) => { gets.push(p); return new Promise(() => {}) } },
  });
  ctx.statsInterval = interval;
  const app = {
    _stats: {}, _latency: null,
    bus: { subscribe: (t, fn) => { if (!busSubs.has(t)) busSubs.set(t, []); busSubs.get(t).push(fn) } },
    channel: {
      sub: (topic, fn) => { subs.set(topic, fn); return { stop: () => subs.delete(topic) } },
      latency: () => latency,
    },
  };
  const sb = new ctx.StatusBarController(app);
  app.statusbar = sb;
  let updates = 0;
  sb.updateStatusBar = () => { updates++ };
  sb._initStatusBarReflow = () => {};
  const fire = (t, a) => { for (const fn of busSubs.get(t) || []) fn(a) };
  return { ctx, sb, app, gets, subs, fire, updates: () => updates, setLatency: (v) => { latency = v } };
}

test('TC-CH3-10: 상태바는 /api/ping·/api/stats 를 부르지 않고 stats:<주기> 를 구독한다', () => {
  const { sb, gets, subs } = setup();
  sb.initStatusBar();
  assert.deepEqual(gets, []);
  assert.deepEqual([...subs.keys()], ['stats:3000']);
});

test('TC-CH3-10: full 마다 지표를 얹고 지연은 채널 왕복이다', () => {
  const { sb, app, subs, updates } = setup();
  sb.initStatusBar();
  subs.get('stats:3000')({ kind: 'full', data: { cpu: 7 } });
  assert.equal(app._stats.cpu, 7);
  assert.equal(app._latency, 12);
  assert.ok(updates() >= 1);
});

test('TC-CH3-10: 주기가 바뀌면 옛 토픽을 해지하고 새 토픽을 구독한다', () => {
  const { ctx, sb, subs } = setup();
  sb.initStatusBar();
  ctx.statsInterval = 10000;
  subs.get('stats:3000')({ kind: 'full', data: {} });
  assert.deepEqual([...subs.keys()], ['stats:10000']);
});

test('TC-CH3-10: 설정이 주기를 바꾸면 곧바로 토픽을 갈아탄다', () => {
  const { ctx, sb, subs } = setup();
  sb.initStatusBar();
  ctx.statsInterval = 1000;
  sb._statsRearm();
  assert.deepEqual([...subs.keys()], ['stats:1000']);
});

test('TC-CH3-10: 채널이 아직 없으면 첫 chan:open 에 구독하고, 끊기면 연결 표시를 끈다', () => {
  const { sb, app, subs, fire } = setup();
  const ch = app.channel;
  app.channel = null;
  sb.initStatusBar();
  assert.equal(subs.size, 0);
  app.channel = ch;
  fire('chan:open', { gen: 1 });
  assert.deepEqual([...subs.keys()], ['stats:3000']);
  app._latency = 5;
  fire('chan:lost', {});
  assert.equal(app._latency, null);
});

test('TC-ATF-44: 메모리는 사용량이 숫자일 때만 그린다(총량만 오면 그리지 않는다)', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../core/statusbar-controller.js', import.meta.url), 'utf8');
  assert.match(src, /if\(statusBar\.memory&&this\.app\._stats\.memTotal&&typeof this\.app\._stats\.memUsed==='number'\)/);
});

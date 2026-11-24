import assert from 'node:assert/strict';
import { test } from 'node:test';

import { BASE, EDITOR, GIT, controllers, load } from './harness.mjs';

/**
 * PERF_OPTIMIZATION_SRS 이슈 1.14 (D-9): 탐색기·편집기에는 주기 틱이 없다. 서버의 `fs` 토픽과
 * `git:<root>` 토픽이 변화를 밀고, 맞추기(`_edTick`)는 사건마다 한 번이다 — 탭 복귀, 채널 재연결.
 */
function app() {
  let polls = 0;
  let everys = 0;
  const ctx = load([...BASE, ...GIT, ...EDITOR], {
    globals: {
      App: class {},
      TIMERS: { disposeOwner() {} },
      visiblePoll: () => { polls++; return { stop() {} } },
    },
  });
  const a = controllers(ctx, new ctx.App());
  const subs = new Map();
  a.bus = { subscribe: (topic, fn) => { subs.set(topic, fn); return { stop() {} } } };
  a.timers = { every: () => { everys++; return { stop() {} } } };
  const ticks = [];
  a.editor.pane._edTick = () => { ticks.push(1) };
  return { a, subs, ticks, polls: () => polls, everys: () => everys };
}

test('시작해도 주기 틱을 걸지 않는다', () => {
  const t = app();
  t.a.editor.pane._edStartSync();
  assert.equal(t.polls(), 0, 'visiblePoll 을 걸었다');
  assert.equal(t.everys(), 0, 'timers.every 를 걸었다');
});

test('탭이 다시 보이면 한 번 맞춘다', () => {
  const t = app();
  t.a.editor.pane._edStartSync();
  const f = t.subs.get('life:visible');
  assert.ok(f, 'life:visible 를 구독하지 않았다');
  f({});
  assert.equal(t.ticks.length, 1);
});

test('채널이 다시 붙으면 한 번 맞추고, 첫 연결은 맞추지 않는다', () => {
  const t = app();
  t.a.editor.pane._edStartSync();
  const f = t.subs.get('chan:open');
  assert.ok(f, 'chan:open 을 구독하지 않았다');
  f({ gen: 1 });
  assert.equal(t.ticks.length, 0, '첫 연결은 부팅이 이미 받았다');
  f({ gen: 2 });
  assert.equal(t.ticks.length, 1);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { load, fakeClock } from './harness.mjs';

/**
 * `web/js/core/app-agent-tool.js` — 셸 쪽 에이전트를 끝내고 **사라진 것을 본다**
 * (M11_SRS FR-M11-5 / M11-B2).
 *
 * 재는 사실은 셋이다:
 *
 *   ① 턴 중이면 **먼저 끊는다.** 끊지 않으면 종료 명령이 입력창에 얹힐 뿐이다
 *   ② 사라질 때까지 기다린다 — 활동 등록부에서 항목이 지워지는 것이 판정이다
 *   ③ 시한 안에 사라지지 않으면 **거짓을 낸다.** 부르는 쪽은 GUI 를 열지 않는다
 *
 * 브라우저가 필요 없다 — 이 함수가 보는 것은 등록부 하나와 두 번의 POST 뿐이다.
 */
function app(activity) {
  const clock = fakeClock();
  const posts = [];
  const ctx = load(['core/i18n.js', 'i18n/ko.js', 'core/constants.js', 'core/app-agent-tool.js'], {
    clock,
    globals: {
      App: class App {},
      apiGet: async () => ({ ok: true, data: {} }),
      apiPost: async (path, body) => { posts.push({ path, body }); return { ok: true, data: {} } },
      Toast: { show() {} },
      // 실시간을 기다리지 않는다 — 가짜 시계를 밀고 깨운다 (하네스의 규약).
      TIMERS: { after: (ms, fn) => { clock.advance(ms).then(fn) } },
    },
    expose: ['AGENT_LIFT_EXIT_MS', 'AGENT_LIFT_POLL_MS'],
  });
  const a = new ctx.App();
  a._activity = new Map(activity || []);
  return { a, posts, ctx, clock };
}

const ESC = String.fromCharCode(27);

test('V-M11-9: 활동이 없으면 종료 명령만 넣고 지나간다', async () => {
  const { a, posts } = app();
  assert.equal(await a._endShellAgent('t1', '/exit'), true);
  assert.deepEqual(posts.map((p) => p.body.text), ['/exit']);
  assert.equal(posts[0].body.execute, true);
});

test('V-M11-10: 턴 중이면 먼저 끊고 나서 종료 명령을 넣는다', async () => {
  const { a, posts } = app([['t1', { state: 'working' }]]);
  // 등록부가 비는 것이 종료의 판정이다 — 기다리는 사이에 비운다.
  const post = a._endShellAgent('t1', '/exit');
  setTimeout(() => a._activity.delete('t1'), 0);
  assert.equal(await post, true);
  assert.deepEqual(posts.map((p) => p.body.text), [ESC, '/exit'],
    '끊지 않고 보내면 종료 명령이 입력창에 얹힐 뿐이다 (M11-B2)');
});

test('V-M11-11: 도는 중이 아니면 끊지 않는다', async () => {
  const { a, posts } = app([['t1', { state: 'idle' }]]);
  const post = a._endShellAgent('t1', '/exit');
  setTimeout(() => a._activity.delete('t1'), 0);
  assert.equal(await post, true);
  assert.deepEqual(posts.map((p) => p.body.text), ['/exit'], '멀쩡히 쉬는 에이전트를 끊었다');
});

test('V-M11-12: 시한 안에 사라지지 않으면 거짓을 낸다 — GUI 를 열지 않는다', async () => {
  const { a } = app([['t1', { state: 'idle' }]]);
  assert.equal(await a._endShellAgent('t1', '/exit'), false,
    '끝나지 않았는데 참을 내면 둘이 함께 산다 — 그것이 접수한 증상이다');
  assert.ok(a._activity.has('t1'));
});

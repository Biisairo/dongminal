import assert from 'node:assert/strict';
import { test } from 'node:test';

import { fakeClock, load } from './harness.mjs';

/**
 * Git 패널의 관측 두 가지 (OPTIMIZE_REFACTOR_SRS FR-OPT-4-1·4-7 후속, Ofix2).
 *
 *   · 쓰기 응답을 적용(`adopt`)하면 그 본문은 옛 mark 의 관측이 아니다 — 다음 collect 가
 *     옛 mark 로 `ifMark` 를 실어 틀린 `unchanged` 를 받지 않게 mark 를 버린다
 *   · collect 는 허브의 줄에 떠날 때 선다 — 늦게 온 ask 의 옛 답이 feed 된 관측을 덮지 않는다
 */
function setup(answer) {
  const clock = fakeClock();
  const sent = [];
  const waits = [];
  const apiGet = (path, opts) => {
    const u = new URL(path, 'http://x');
    if (opts && opts.query) for (const [k, v] of Object.entries(opts.query)) u.searchParams.set(k, v);
    sent.push(u);
    const r = answer(u);
    return new Promise((resolve) => waits.push(() => resolve(r)));
  };
  const ctx = load(['core/constants-api.js', 'git/api.js', 'git/status-hub.js', 'git/panel-poll.js', 'git/panel-write.js'], {
    clock,
    expose: ['GitStatusHub'],
    globals: {
      GitPanel: class {},
      GIT_STATUS_API: '/api/git/status',
      GIT_STATUS_FETCH_TIMEOUT_MS: 20000,
      GIT_STATUS_HUB_TTL_MS: 500,
      apiGet,
    },
  });
  const hub = new ctx.GitStatusHub({ clientId: () => 'c-1' });
  const app = { clientId: 'c-1', gitStatusHub: () => hub, gitReposRefresh() {}, updateStatusBar() {} };
  const p = Object.create(ctx.GitPanel.prototype);
  const applied = [];
  Object.assign(p, {
    app, repo: '/r', _seq: 0, _busy: false, _again: false, _writeGen: 0,
    obs: { paintAll() {} }, token: () => ({ repo: '/r' }),
    _applyStatus: (tok, r) => applied.push(r),
  });
  const flush = async () => { while (waits.length) waits.shift()(); await clock.advance(0) };
  // 나중에 떠난 요청의 답부터 도착시킨다.
  const flushReverse = async () => { while (waits.length) { waits.pop()(); await clock.advance(0) } };
  return { p, hub, sent, flush, flushReverse, applied };
}

const full = (mark, extra = {}) => ({
  ok: true, status: 200,
  data: { repo: '/r', requested: '/r', isRepo: true, mark, status: { untracked: [] }, ...extra },
});

test('adopt 는 옛 mark 를 버린다 — 다음 collect 가 옛 mark 로 ifMark 를 싣지 않는다', async () => {
  const { p, sent, flush } = setup(() => full('m2'));
  p._status = { requested: '/r', repo: '/r', mark: 'm1', status: { untracked: ['old'] } };
  p.adopt({ requested: '/r', repo: '/r', status: { untracked: [] } });
  const c = p.collect(); await flush(); await c;
  assert.equal(sent[0].searchParams.get('ifMark'), null, '쓰기 뒤 본문에 옛 mark 를 붙여 물었다');
});

test('collect 의 feed 는 떠난 순서로 선다 — 먼저 떠난 ask 의 늦은 답이 덮지 않는다', async () => {
  let n = 0;
  const { p, hub, flushReverse } = setup(() => full('m' + (++n)));
  const a = hub.ask('/r');
  const c = p.collect();
  // 패널의 답(m2)이 먼저, ask 의 답(m1)이 나중에 온다.
  await flushReverse();
  await Promise.all([a, c]);
  assert.equal(hub.peek('/r').data.mark, 'm2');
});

test('collect 는 떠날 때 번호를 받는다 — 먼저 떠난 패널의 늦은 feed 가 나중 ask 의 답을 덮지 않는다', async () => {
  let n = 0;
  const { p, hub, flushReverse } = setup(() => full('m' + (++n)));
  const c = p.collect();
  const a = hub.ask('/r');
  // ask 의 답(m2)이 먼저, 패널의 답(m1)이 나중에 온다.
  await flushReverse();
  await Promise.all([a, c]);
  assert.equal(hub.peek('/r').data.mark, 'm2', '먼저 떠난 패널 관측이 새 답을 덮었다');
});

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { load } from './harness.mjs';

/**
 * OPTIMIZE_REFACTOR_SRS FR-OPT-1-5 (FEU-1 · FEU-2) — 원격 목록의 적재는 `gitLoadList`
 * 규약을 지난다.
 *
 * 낡은 응답은 **그 값을 쓰지 않는 것**이지 잠금을 쥐는 것이 아니다 (FR-GRF-24).
 * 새 조회는 앞선 조회를 끊는다 (FR-GRF-31).
 */
const calls = [];
const ctx = load(['core/constants-api.js', 'git/view-util.js', 'git/remote.js'], {
  globals: {
    gitFetch: (url, params, opts) => new Promise((resolve) => calls.push({ url, params, opts, resolve })),
    GIT_RM_LOAD_FAIL: 'load-fail',
    AbortController,
  },
});

function list() {
  const panel = { repo: '/r', token: () => 1, isStale: () => false };
  const v = new ctx.GitRemoteList(panel);
  v._repo = '/r';
  v.paint = () => {};
  return v;
}

test('FEU-1: 낡은 응답이 와도 _loading 이 풀린다', async () => {
  calls.length = 0;
  const v = list();
  const p = v._load();
  assert.equal(v._loading, true);
  calls[0].resolve({ stale: true });
  await p;
  assert.equal(v._loading, false, '낡은 응답 뒤에도 적재 중으로 남았다');
});

test('FEU-2: 조회가 신호를 싣고, 새 조회가 앞선 것을 끊는다', async () => {
  calls.length = 0;
  const v = list();
  const p1 = v._load();
  const p2 = v._load();
  assert.equal(calls.length, 2);
  assert.ok(calls[0].opts.signal, '신호를 싣지 않았다');
  assert.equal(calls[0].opts.signal.aborted, true, '앞선 조회를 끊지 않았다');
  calls[1].resolve({ ok: true, data: { remotes: [{ name: 'origin' }] } });
  await p2;
  // 끊긴 조회가 늦게 깨어나도 살아 있는 조회의 결과를 덮지 않는다.
  calls[0].resolve({ ok: true, data: { remotes: [] } });
  await p1;
  assert.deepEqual(v._list.map((r) => r.name), ['origin']);
  assert.equal(v._loading, false);
});

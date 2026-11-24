import assert from 'node:assert/strict';
import { test } from 'node:test';

import { load } from './harness.mjs';

/**
 * GIT_REFRESH_LIFECYCLE_SRS FR-GRF-6 (`GP-5`) — 응답하지 않는 연결에서 History 의 잠금이 시한 뒤 풀린다.
 *
 * `git-refresh-lifecycle` V-GRF-4 에서 옮겨 왔다 (E2E_PRUNE_REPORT §8.3). e2e 는 기본 시한
 * (`GIT_STATUS_FETCH_TIMEOUT_MS`=20초)을 실제로 기다렸다. 재는 것은 "호출자가 시한을 주지 않아도
 * **기본 시한이 붙는가**" 이므로 상수만 짧게 두고 `_load → _get → gitFetch → apiGet` 의 실제
 * 경로를 그대로 지난다 (선례 `git-hunk-fresh.test.mjs`).
 */

const TIMEOUT_MS = 20;

// 블랙홀 — 응답도 거부도 오지 않는다. 신호가 끊을 때만 거부된다 (진짜 `fetch` 와 같은 모양).
function blackhole() {
  const calls = [];
  const fn = (url, init) => {
    calls.push({ url, init: init || {} });
    return new Promise((_, reject) => {
      const s = init && init.signal;
      if (s) s.addEventListener('abort', () => reject(s.reason));
    });
  };
  fn.calls = calls;
  return fn;
}

function history(fetch) {
  const ctx = load(['core/api.js', 'git/api.js', 'git/history-load.js'], {
    globals: {
      fetch,
      GitHistory: function GitHistory() {},
      GIT_API: { log: '/api/git/log' },
      GIT_STATUS_FETCH_TIMEOUT_MS: TIMEOUT_MS,
      GIT_HIST_LOAD_FAIL: 'fail',
      GitConfirm: { policy: async () => null },
      gitLogLimit: () => undefined,
    },
  });
  const h = Object.create(ctx.GitHistory.prototype);
  Object.assign(h, {
    _repo: 'r', el: {}, _commits: [], _filters: {}, _order: '', _grep: '', _reflog: false, _ref: '',
    _paintBar() {}, _paintFoot() {}, paint() {}, _rebuild() {},
    ticket() { return {} }, stale() { return false },
  });
  h.panel = { repo: 'r', _lastSig: null };
  return h;
}

test('V-GRF-4 (FR-GRF-6): 무응답 연결에서도 기본 시한 뒤 잠금이 풀리고 사유가 선다', async () => {
  const f = blackhole();
  const h = history(f);
  const p = h._load(false);
  // 정책을 받은 뒤에 요청이 나간다 — 마이크로태스크를 비운다.
  await new Promise((r) => setImmediate(r));
  assert.equal(h._loading, true, '전제가 깨졌다 — 적재가 시작되지 않았다');
  assert.equal(f.calls.length, 1);
  assert.ok(f.calls[0].init.signal, '호출자가 시한을 주지 않았는데 기본 시한이 붙지 않았다');

  // 종전에는 여기서 영원히 참이었다 — `finally` 가 실행되지 않는다. 상한을 두어 멈추지 않게 한다.
  let cap;
  const over = new Promise((r) => { cap = setTimeout(() => r('hung'), TIMEOUT_MS * 50) });
  const got = await Promise.race([p.then(() => 'done'), over]);
  clearTimeout(cap);
  assert.equal(got, 'done', '시한이 지나도 적재가 끝나지 않았다');
  assert.equal(h._loading, false, '시한 뒤에도 잠금이 남았다');
  assert.equal(h._err, 'fail', '끊긴 적재가 사유를 보이지 않는다');
});

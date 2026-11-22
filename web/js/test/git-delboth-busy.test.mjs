import assert from 'node:assert/strict';
import { test } from 'node:test';

import { load } from './harness.mjs';

/**
 * ATTIC_FIX_SRS FR-ATF-75 (AT-GAPI-5) — delete-both 의 원격 잡 등록이 거절되면 서버는 거절 응답에
 * 이미 적용된 로컬 삭제(`deleted`)를 싣는다. 화면은 그것을 반쪽 삭제로 읽는다: 목록을 다시 읽고
 * (`afterRefWrite`) 「로컬은 지웠지만 원격을 지우지 못했다」 를 사유와 함께 알린다.
 *   이전 동작: 일반 실패(`applyWriteFail`)만 보였다 — 지워진 로컬 브랜치가 목록에 남아 보였다
 */
const toasts = [];
const ctx = load(['git/branches-ops.js'], {
  expose: ['GitBranches'],
  globals: {
    GitBranches: { refName: (t) => t.name },
    GIT_API: { branchDeleteBoth: '/api/git/branch/delete-both' },
    GIT_BR_DELETE_BOTH_FAIL: 'BOTH_FAIL',
    Toast: { show: (m, k) => toasts.push([m, k]) },
    TOAST_ERR_MS: 1,
    GIT_REF_KIND_REMOTE: 'remote', GIT_REF_KIND_LOCAL: 'local', GIT_REF_KIND_TAG: 'tag',
  },
});

function panel(res) {
  const calls = [];
  return {
    calls,
    repo: '/r',
    write: {
      post: async () => res,
      afterRefWrite: (d) => calls.push(['afterRefWrite', d]),
      applyWriteFail: () => calls.push(['applyWriteFail']),
      writeError: () => 'job_busy: 다른 작업이 돈다',
    },
  };
}

test('TC-ATF-75: 거절 응답에 deleted 가 오면 목록을 다시 읽고 반쪽 삭제를 알린다', async () => {
  toasts.length = 0;
  const p = panel({ ok: false, code: 409, data: { error: 'job_busy', deleted: { names: ['feat'], oids: ['a'] } } });
  await ctx.GitBranches.delBoth(p, { name: 'feat' }, ['feat'], false);
  assert.deepEqual(p.calls.map((c) => c[0]), ['afterRefWrite']);
  assert.equal(toasts.length, 1);
  assert.match(toasts[0][0], /^BOTH_FAIL — job_busy/);
});

test('TC-ATF-75: deleted 가 없는 거절은 지금처럼 일반 실패다', async () => {
  toasts.length = 0;
  const p = panel({ ok: false, code: 409, data: { error: 'job_busy' } });
  await ctx.GitBranches.delBoth(p, { name: 'feat' }, ['feat'], false);
  assert.deepEqual(p.calls.map((c) => c[0]), ['applyWriteFail']);
  assert.equal(toasts.length, 0);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { load } from './harness.mjs';

/**
 * REPO_FIX 04 §3A-6 (T-8.1) — git 폴링 응답의 mark 가 직전 적용분과 같으면 상태
 * 재계산·rollup·전체 재칠을 하지 않는다.
 */
function tree(responses) {
  let i = 0;
  const ctx = load(['ui/file-tree-paint.js'], {
    globals: {
      FileTree: class {},
      GIT_STATUS_API: '/api/git/status',
      apiGet: async () => responses[Math.min(i++, responses.length - 1)],
      editorGitBackoffMs: () => 1000,
      gitStateChar: (k) => ({ untracked: '?', conflicts: 'U' })[k] || 'M',
      EDITOR_TREE_ST_RANK: { M: 2, '?': 1, U: 3 },
      pathSep: () => '/',
    },
  });
  const t = Object.create(ctx.FileTree.prototype);
  t.root = '/r';
  t.store = { gitKey: '' };
  Object.assign(t, { _gitOff: false, _gitBusy: false, _gitRetryAt: 0, _repoPrefix: '', _gitOn: false });
  t.calls = { rollup: 0, paintAll: 0 };
  const roll = t._rollup;
  t._rollup = function (m) { t.calls.rollup++; return roll.call(this, m) };
  t._paintAll = () => { t.calls.paintAll++ };
  return t;
}

function status(mark, n) {
  const untracked = [];
  for (let k = 0; k < n; k++) untracked.push({ path: 'd/f' + k, XY: '??' });
  return { status: 200, ok: true, data: { repo: '/r', isRepo: true, rootMatch: true, mark, status: { untracked, staged: [], changes: [], conflicts: [] } } };
}

test('같은 mark 폴링 10회 동안 rollup·재칠 0회, mark 변경 1회에 각 1회', async () => {
  const big = status('m1', 2000);
  const t = tree([big, ...Array(10).fill(big), status('m2', 2000)]);
  await t.pollGit();
  assert.deepEqual({ ...t.calls }, { rollup: 1, paintAll: 1 }, '첫 관측은 칠한다');
  for (let k = 0; k < 10; k++) await t.pollGit();
  assert.deepEqual({ ...t.calls }, { rollup: 1, paintAll: 1 }, '같은 mark 는 다시 계산하지 않는다');
  await t.pollGit();
  assert.deepEqual({ ...t.calls }, { rollup: 2, paintAll: 2 }, 'mark 가 바뀌면 한 번');
});

test('비저장소(mark 무효화) 뒤의 같은 mark 는 다시 칠한다', async () => {
  const a = status('m1', 3);
  const notRepo = { status: 200, ok: true, data: { isRepo: false, mark: '' } };
  const t = tree([a, notRepo, a]);
  await t.pollGit();
  await t.pollGit();
  const before = t.calls.rollup;
  t._gitRetryAt = 0;
  await t.pollGit();
  assert.equal(t.calls.rollup, before + 1);
});

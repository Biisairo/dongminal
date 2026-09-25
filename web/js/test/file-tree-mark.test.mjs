import assert from 'node:assert/strict';
import { test } from 'node:test';

import { fakeClock, load } from './harness.mjs';

/**
 * REPO_FIX 04 §3A-6 (T-8.1) — git 폴링 응답의 mark 가 직전 적용분과 같으면 상태
 * 재계산·rollup·전체 재칠을 하지 않는다.
 */
// OPTIMIZE_REFACTOR_SRS FR-OPT-4-1: 탐색기의 status 는 GitStatusHub 를 지난다. 이
// 검사가 재는 것(mark 로 재칠 생략)은 그대로이고, 응답이 오는 자리만 hub 로 옮겼다.
function tree(responses, opts = {}) {
  let i = 0;
  const clock = fakeClock();
  const hub = {
    fetches: 0,
    invalidated: 0,
    peeked: null,
    invalidate: () => { hub.invalidated++ },
    ask: async () => { hub.fetches++; return responses[Math.min(i++, responses.length - 1)] },
    peek: () => hub.peeked,
  };
  const ctx = load(['ui/file-tree-paint.js'], {
    clock,
    globals: {
      FileTree: class {},
      GIT_STATUS_API: '/api/git/status',
      gitStatusInterval: opts.safety ?? 30000,
      apiGet: async () => { throw new Error('탐색기가 hub 를 지나지 않고 직접 물었다') },
      editorGitBackoffMs: () => 1000,
      gitStateChar: (k) => ({ untracked: '?', conflicts: 'U' })[k] || 'M',
      EDITOR_TREE_ST_RANK: { M: 2, '?': 1, U: 3 },
      pathSep: () => '/',
    },
  });
  const t = Object.create(ctx.FileTree.prototype);
  t.root = '/r';
  t.app = { gitStatusHub: () => hub };
  t.hub = hub;
  t.clock = clock;
  t.store = { gitKey: '', gitOkAt: 0, gitRepo: '', gitMark: '', gitAgain: false };
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

test('스탬프 틱의 재칠은 요청 없이 hub 의 관측으로 칠하고, 같은 관측이면 칠하지 않는다 (FR-OPT-4-1)', async () => {
  const t = tree([status('m1', 3)]);
  t.hub.peeked = { data: status('m2', 3).data, at: t.clock.now() };
  t.paintGitCached();
  assert.equal(t.hub.fetches, 0);
  assert.deepEqual({ ...t.calls }, { rollup: 1, paintAll: 1 });
  assert.equal(t.store.gitMark, 'm2');
  assert.equal(t.store.gitOkAt, t.clock.now(), '넘겨받은 관측도 관측이다 — 안전망 시계를 되돌린다');
  const first = t.clock.now();
  await t.clock.advance(10000);
  t.paintGitCached();
  assert.deepEqual({ ...t.calls }, { rollup: 1, paintAll: 1 }, '같은 관측은 다시 칠하지 않는다');
  assert.equal(t.store.gitOkAt, first, '오래된 캐시를 지금 칠해도 지금 관측한 것이 되지 않는다');
});

test('안전망: 관측이 없으면 매 틱, 있으면 gitStatusInterval 뒤에만 묻는다', async () => {
  const t = tree([status('m1', 1)]);
  assert.equal(t.gitDue(), true, '관측 전');
  await t.pollGit();
  assert.equal(t.store.gitRepo, '/r');
  assert.equal(t.gitDue(), false, '방금 관측했다');
  await t.clock.advance(29999);
  assert.equal(t.gitDue(), false);
  await t.clock.advance(1);
  assert.equal(t.gitDue(), true, '안전망 주기가 지났다');
});

test('안전망을 끄면(0) 관측 뒤에는 주기로 묻지 않는다', async () => {
  const t = tree([status('m1', 1)], { safety: 0 });
  assert.equal(t.gitDue(), true, '첫 관측은 한다');
  await t.pollGit();
  await t.clock.advance(3600000);
  assert.equal(t.gitDue(), false);
});

test('일시 실패(5xx·전송)는 관측이 아니다 — 다음 틱에 다시 묻는다', async () => {
  const t = tree([{ ok: false, status: 500, data: null }]);
  await t.pollGit();
  assert.equal(t.gitDue(), true);
});

test('즉시 계기(now)는 캐시를 넘는다 — 방금 한 조작 뒤의 답이어야 한다', async () => {
  const t = tree([status('m1', 1)]);
  await t.pollGit();
  assert.equal(t.hub.invalidated, 0, '주기 물음은 캐시를 나눠 쓴다');
  await t.pollGit({ now: true });
  assert.equal(t.hub.invalidated, 1);
});

test('비행 중에 온 즉시 계기는 버리지 않고 끝난 뒤 한 번 더 묻는다', async () => {
  const t = tree([status('m1', 1), status('m2', 1)]);
  const first = t.pollGit();
  const a = t.pollGit({ now: true });
  const b = t.pollGit({ now: true });
  await Promise.all([a, b, first]);
  assert.equal(t.hub.fetches, 2, '겹친 계기 둘은 한 번으로 합쳐진다');
  assert.equal(t.store.gitMark, 'm2');
});

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { load } from './harness.mjs';

/**
 * OPTIMIZE_REFACTOR_SRS FR-OPT-4-3·4-4 후속 (Ofix2) — 목록 두 개의 순서.
 *
 *   · 상태바 틱이 싣는 jobs 도 `gitJobs` 비행에 선다 — 옛 `/api/stats` 의 목록이
 *     그 뒤에 떠난 `/api/git/jobs` 의 새 목록을 덮지 않는다
 */
function setup() {
  const waits = [];
  const hold = (path, r) => new Promise((resolve) => waits.push({ path, go: () => resolve(r) }));
  const answers = {};
  const ctx = load(['core/event-bus.js', 'core/app-cmd.js', 'core/app-statusbar.js', 'core/app-git.js'], {
    expose: ['EventBus'],
    globals: {
      App: class {},
      performance: { now: () => 0 },
      apiGet: (path) => path === '/api/ping' ? Promise.resolve({ ok: true, status: 200 }) : hold(path, answers[path]),
      gitFetch: (path) => hold(path, answers[path]),
    },
  });
  const a = new ctx.App();
  a.bus = new ctx.EventBus(a, {});
  a.gitPanels = new Map([['/r', { repo: '/r' }]]);
  const adopted = [];
  Object.defineProperty(a, 'gitPanel', { value: { adoptJobs: (j) => adopted.push(j) } });
  a.updateStatusBar = () => {};
  const arrive = async (path) => {
    const i = waits.findIndex((w) => w.path === path);
    waits.splice(i, 1)[0].go();
    await new Promise((r) => setImmediate(r));
  };
  return { a, answers, arrive, adopted, waits };
}

test('옛 /api/stats 의 jobs 가 나중에 떠난 /api/git/jobs 의 새 목록을 덮지 않는다', async () => {
  const { a, answers, arrive, adopted } = setup();
  answers['/api/stats'] = { ok: true, status: 200, data: { cpu: 1, jobs: [{ id: 'old' }] } };
  answers['/api/git/jobs'] = { ok: true, status: 200, data: { jobs: [{ id: 'new' }] } };
  const tick = a._pollStats();
  await new Promise((r) => setImmediate(r));
  const push = a._pollGitJobs();
  await arrive('/api/git/jobs'); await push;
  await arrive('/api/stats'); await tick;
  assert.deepEqual(a._gitJobs, [{ id: 'new' }], '옛 틱의 목록이 새 목록을 덮었다');
  assert.equal(adopted.length, 1);
  assert.equal(a._stats.cpu, 1, '통계 자체는 적용된다');
});

test('틱이 늦게 떠났으면 그 목록이 선다', async () => {
  const { a, answers, arrive } = setup();
  answers['/api/stats'] = { ok: true, status: 200, data: { cpu: 1, jobs: [{ id: 'tick' }] } };
  answers['/api/git/jobs'] = { ok: true, status: 200, data: { jobs: [{ id: 'push' }] } };
  const push = a._pollGitJobs();
  const tick = a._pollStats();
  await new Promise((r) => setImmediate(r));
  await arrive('/api/stats'); await tick;
  await arrive('/api/git/jobs'); await push;
  assert.deepEqual(a._gitJobs, [{ id: 'tick' }]);
});

// Ofix3: 틱이 비행 중인 push 조회를 밀어낸 뒤 /api/stats 가 실패하면 그 목록이
// 사라진다 — 밀어낸 틱이 실패하면 다시 조회해 세운다.
test('밀어낸 틱이 실패하면 목록을 다시 조회한다', async () => {
  const { a, answers, arrive } = setup();
  answers['/api/stats'] = { ok: false, status: 0, data: null };
  answers['/api/git/jobs'] = { ok: true, status: 200, data: { jobs: [{ id: 'push' }] } };
  const push = a._pollGitJobs();
  const tick = a._pollStats();
  await new Promise((r) => setImmediate(r));
  await arrive('/api/git/jobs'); await push;
  await arrive('/api/stats'); await tick;
  await arrive('/api/git/jobs');
  assert.deepEqual(a._gitJobs, [{ id: 'push' }], '밀려난 조회의 목록이 사라졌다');
});

test('아무것도 밀어내지 않은 틱의 실패는 다시 조회하지 않는다', async () => {
  const { a, answers, arrive, waits } = setup();
  answers['/api/stats'] = { ok: false, status: 0, data: null };
  const tick = a._pollStats();
  await new Promise((r) => setImmediate(r));
  await arrive('/api/stats'); await tick;
  assert.equal(waits.length, 0, '실패한 틱마다 조회가 하나씩 늘었다');
});

// 안전망 주기도 목록 갱신을 합치는 줄로 선다 — 비행 중인 갱신과 겹쳐 `observe=1`
// 요청이 둘 뜨면 서버 도착 순서가 뒤바뀔 수 있다.
test('안전망 주기 폴은 gitReposKick 을 지나 비행 중인 갱신과 겹치지 않는다', async () => {
  let tickFn = null;
  const ctx = load(['core/app-git.js'], {
    globals: {
      App: class {},
      visiblePoll: (_iv, fn) => { tickFn = fn; return { stop() {} }; },
      gitStatusInterval: 30000,
    },
  });
  const a = new ctx.App();
  const holds = [];
  a.gitReposRefresh = () => new Promise((r) => holds.push(r));
  a._startGitReposPoll();
  a.gitReposKick();
  tickFn();
  assert.equal(holds.length, 1, '주기 폴이 비행 중인 갱신 옆에 하나를 더 띄웠다');
  holds[0]();
  await new Promise((r) => setImmediate(r));
  assert.equal(holds.length, 2, '비행 중에 온 주기 폴은 끝난 뒤 한 번 더 받아야 한다');
});

// Repo 탭의 들고 남은 목록 갱신을 합치는 줄(`gitReposKick`)로 보낸다 — `observe=1` 과
// `observe=0` 이 동시에 떠 서버에 도착 순서가 뒤바뀌면 임대가 남거나 사라진다.
test('Repo 탭의 onEnter·onLeave 는 목록 갱신을 합치는 줄로 보낸다', () => {
  const ctx = load(['ui/sidebar-tabs.js'], {
    expose: ['SB_TAB_DEFS'],
    globals: {
      t: (k) => k, REPO_TAB_ID: 'repo', REPO_TAB_LABEL: 'Repo', REPO_PANEL_ID: 'p', REPO_LIST_ID: 'l',
      REPO_ROOT_ID: 'r', REPO_ENTRIES_NONE: 'REPO_ENTRIES_NONE', REPO_ADD_ID: 'a', SHORTCUT_DEFAULTS: {}, SHORTCUT_LABELS: {}, shortcuts: {}, SB_JUMP_MAX: 9,
    },
  });
  const repo = ctx.SB_TAB_DEFS.find((d) => d.id === 'repo');
  const calls = [];
  const app = { gitReposKick: () => calls.push('kick'), gitReposRefresh: () => calls.push('refresh') };
  repo.onEnter(app);
  repo.onLeave(app);
  assert.deepEqual(calls, ['kick', 'kick']);
});

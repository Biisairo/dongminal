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
  return { a, answers, arrive, adopted };
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

// Repo 탭의 들고 남은 목록 갱신을 합치는 줄(`gitReposKick`)로 보낸다 — `observe=1` 과
// `observe=0` 이 동시에 떠 서버에 도착 순서가 뒤바뀌면 임대가 남거나 사라진다.
test('Repo 탭의 onEnter·onLeave 는 목록 갱신을 합치는 줄로 보낸다', () => {
  const ctx = load(['ui/sidebar-tabs.js'], {
    expose: ['SB_TAB_DEFS'],
    globals: {
      t: (k) => k, REPO_TAB_ID: 'repo', REPO_TAB_LABEL: 'Repo', REPO_PANEL_ID: 'p', REPO_LIST_ID: 'l',
      REPO_ROOT_ID: 'r', REPO_ENTRIES_NONE: 'REPO_ENTRIES_NONE', REPO_ADD_ID: 'a', SHORTCUT_DEFAULTS: {}, SHORTCUT_LABELS: {}, shortcuts: {},
    },
  });
  const repo = ctx.SB_TAB_DEFS.find((d) => d.id === 'repo');
  const calls = [];
  const app = { gitReposKick: () => calls.push('kick'), gitReposRefresh: () => calls.push('refresh') };
  repo.onEnter(app);
  repo.onLeave(app);
  assert.deepEqual(calls, ['kick', 'kick']);
});

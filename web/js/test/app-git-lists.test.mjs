import assert from 'node:assert/strict';
import { test } from 'node:test';

import { BASE, GIT, controllers, load } from './harness.mjs';

/**
 * OPTIMIZE_REFACTOR_SRS FR-OPT-4-3 후속 — Repo 목록 갱신의 합치기. (작업 목록의 순서 시험은
 * `git.jobs` 토픽으로 옮겨 사라졌다 — PERF_OPTIMIZATION_SRS M1 C4, `git-topics.test.mjs`.)
 */
// Repo 탭의 들고 남은 목록 갱신을 합치는 줄(`gitReposKick`)로 보낸다.
test('Repo 탭의 onEnter·onLeave 는 목록 갱신을 합치는 줄로 보낸다', () => {
  const ctx = load(['core/constants-api.js', 'ui/sidebar-tab-chat.js', 'ui/sidebar-tabs.js'], {
    expose: ['SB_TAB_DEFS'],
    globals: {
      t: (k) => k, REPO_TAB_ID: 'repo', REPO_TAB_LABEL: 'Repo', REPO_PANEL_ID: 'p', REPO_LIST_ID: 'l',
      REPO_ROOT_ID: 'r', REPO_ENTRIES_NONE: 'REPO_ENTRIES_NONE', REPO_ADD_ID: 'a', SHORTCUT_DEFAULTS: {}, SHORTCUT_LABELS: {}, shortcuts: {}, SB_JUMP_MAX: 9,
    },
  });
  const repo = ctx.SB_TAB_DEFS.find((d) => d.id === 'repo');
  const calls = [];
  const app = { git: { sync: { gitReposKick: () => calls.push('kick'), gitReposRefresh: () => calls.push('refresh') } } };
  repo.onEnter(app);
  repo.onLeave(app);
  assert.deepEqual(calls, ['kick', 'kick']);
});

/**
 * UX_BATCH12_SRS TC-LIV-5 (FR-LIV-8) — Repo 탭이 보이지 않아도 핀 저장소의 `git_changed` 는
 * 목록을 다시 받게 한다. 겹친 알림은 비행 하나와 끝난 뒤 한 번으로 합친다.
 */
test('Repo 탭이 숨어 있어도 git_changed 가 목록 갱신을 합쳐 부른다', async () => {
  const ctx = load([...BASE, 'core/constants-api.js', ...GIT], {
    globals: { App: class {}, TIMERS: { disposeOwner() {} }, visiblePoll: () => ({ stop() {} }) },
  });
  const a = controllers(ctx, new ctx.App());
  a.sbTab = 'windows';
  a.gitRepos = { pinned: [{ path: '/r', root: '/r' }] };
  const holds = [];
  a.git.sync.gitReposRefresh = () => new Promise((r) => holds.push(r));
  a.git.sync._gitReposOnChanged('/r');
  a.git.sync._gitReposOnChanged('/r');
  a.git.sync._gitReposOnChanged('/r');
  assert.equal(holds.length, 1, 'Repo 탭이 숨어 있다고 다시 받지 않았거나 겹쳐 받았다');
  holds[0]();
  await new Promise((r) => setImmediate(r));
  assert.equal(holds.length, 2, '비행 중에 온 알림은 끝난 뒤 한 번으로 합쳐야 한다');
  a.git.sync._gitReposOnChanged('/other');
  assert.equal(holds.length, 2, '핀이 아닌 저장소의 알림은 무시한다');
});

// PERF 1.18: 목록 요청은 신원을 싣지 않고, 탭을 떠난 뒤에도 놓을 임대가 없다(`observe=0` 이 없다).
test('Repo 목록 요청은 clientId 와 observe=0 을 싣지 않는다', async () => {
  const sent = [];
  const ctx = load([...BASE, 'core/constants-api.js', ...GIT], {
    globals: {
      App: class {}, TIMERS: { disposeOwner() {} }, visiblePoll: () => ({ stop() {} }),
      gitFetch: (path, query) => { sent.push({ ...query }); return Promise.resolve({ ok: false, status: 500 }) },
    },
  });
  const a = controllers(ctx, new ctx.App());
  a.clientId = 'c1';
  let observe = true;
  a.git.sync._gitObserveOk = () => observe;
  await a.git.sync.gitReposRefresh();
  observe = false;
  await a.git.sync.gitReposRefresh();
  assert.deepEqual(sent, [{ observe: '1' }, {}]);
});

// REFACTOR3_FE_FIX_SRS TC-FFX-14 (FX-6, FR-FFX-18): 지운 서버 종단 둘의 경로는 FE 표에도 없다.
test('TC-FFX-14: GIT_API 에 repo-at·repos/reorder 가 없다', () => {
  const ctx = load(['core/constants-api.js'], { expose: ['GIT_API'] });
  assert.equal('repoAt' in ctx.GIT_API, false);
  assert.equal('reposReorder' in ctx.GIT_API, false);
  assert.equal(Object.values(ctx.GIT_API).some((p) => p === '/api/git/repo-at' || p === '/api/git/repos/reorder'), false);
});

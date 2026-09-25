import assert from 'node:assert/strict';
import { test } from 'node:test';

import { load } from './harness.mjs';

/**
 * OPTIMIZE_REFACTOR_SRS FR-OPT-4-1: 탐색기의 git 색은 `git_changed` 가 본줄이고 주기는
 * 안전망이다. 숨어 있는 동안 온 방송은 받지 않지만(FR-GRF-28) **버리지 않고 미룬다**
 * (D-GRF-7) — 복귀 틱이 그 저장소를 다시 묻지 않으면 다음 안전망(기본 30초, 0 이면
 * 영영)까지 색이 낡는다.
 */
function app() {
  const ctx = load(['core/app-git.js', 'core/app-editor-open.js', 'core/app-editor-pane.js'], {
    globals: { App: class {} },
  });
  const a = new ctx.App();
  const store = { root: '/r', gitRepo: '/r', gitMark: 'm1' };
  const polls = [];
  const tree = {
    store,
    gitDue: () => false,
    pollGit: (o) => { polls.push(o || {}) },
    paintGitCached: () => {},
  };
  a._edVisibleTrees = () => [tree];
  a.edStampTick = async () => {};
  return { ctx, a, polls };
}

test('숨은 동안 온 git_changed 는 복귀 틱에 그 저장소를 다시 묻는다', () => {
  const { ctx, a, polls } = app();
  ctx.document.hidden = true;
  a._onGitChanged({ repo: '/r', mark: 'm2' });
  assert.equal(polls.length, 0, '숨은 동안에는 묻지 않는다');
  ctx.document.hidden = false;
  a._edTick();
  assert.equal(polls.length, 1);
  assert.equal(polls[0].now, true, '방송이 가리킨 변화다 — 캐시를 넘는다');
  a._edTick();
  assert.equal(polls.length, 1, '미룬 방송은 한 번만 갚는다');
});

test('숨은 동안 온 방송이 이미 받은 mark 면 복귀 틱도 묻지 않는다', () => {
  const { ctx, a, polls } = app();
  ctx.document.hidden = true;
  a._onGitChanged({ repo: '/r', mark: 'm1' });
  ctx.document.hidden = false;
  a._edTick();
  assert.equal(polls.length, 0);
});

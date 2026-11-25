import assert from 'node:assert/strict';
import { test } from 'node:test';

import { load } from './harness.mjs';

/**
 * 4.15.3 — `git.jobs` 토픽의 full 이 Git 패널보다 먼저 오면(새로고침 직후) 목록은 앱(`git.sync.gitJobs()`)에만 남는다.
 * 잡 표시기를 처음 세울 때 그 목록을 딛어야 도는 잡에 다시 붙는다 — 토픽은 목록이 바뀔 때만 다시 민다.
 */
const ctx = load(['core/base/component.js', 'git/git-part.js', 'git/git-views.js'], {
  expose: ['GitViews'],
  globals: {
    GitJobs: class { constructor(p) { this.p = p; this.got = [] } adoptJobs(j) { this.got.push(j) } },
  },
});

function views(gitJobs) {
  const p = { app: { git: { sync: { gitJobs: () => gitJobs || [] } } } };
  return { p, v: new ctx.GitViews(p) };
}

test('4.15.3: 표시기를 세울 때 이미 받은 진행 중 목록을 딛는다', () => {
  const jobs = [{ id: 'j1', kind: 'commit', repo: '/r', slots: ['index'], indicator: true }];
  const { p, v } = views(jobs);
  const r = v._remote();
  assert.equal(p._remoteView, r);
  assert.deepEqual(r.got, [jobs]);
});

test('4.15.3: 받은 목록이 비었거나 없으면 딛지 않는다', () => {
  assert.deepEqual(views([]).v._remote().got, []);
  assert.deepEqual(views(undefined).v._remote().got, []);
});

test('4.15.3: 이미 선 표시기는 다시 딛지 않는다', () => {
  const { v } = views([{ id: 'j1' }]);
  const r = v._remote();
  v._remote();
  assert.equal(r.got.length, 1);
});

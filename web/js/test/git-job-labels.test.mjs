import assert from 'node:assert/strict';
import { test } from 'node:test';

import { load } from './harness.mjs';

/**
 * 잡 줄의 버튼 글자 — 정책(`jobSlots`)이 늦게 와서 `_build` 가 박스를 갈아 끼워도 버튼이
 * 비지 않는다. 종전에는 글자를 `panel-changes` 가 골격을 세울 때 한 번만 넣어, 갈아 끼운
 * 박스의 닫기·복사·취소 버튼이 빈 네모로 남았다.
 */
const L = {
  GIT_JOB_CANCEL: 'Cancel', GIT_TIP_JOB_CANCEL: 'tip-cancel', GIT_JOB_COPY: 'Copy', GIT_TIP_JOB_COPY: 'tip-copy',
  GIT_JOB_CLOSE: 'Close', GIT_TIP_JOB_CLOSE: 'tip-close', GIT_TIP_JOB_FOLD: 'tip-fold',
  GIT_JOB_AUTH_COPY: 'Copy command', GIT_TIP_JOB_AUTH_COPY: 'tip-auth',
};

function btn() { return { textContent: '', title: '' } }

function root() {
  const by = {
    '.git-job-cancel': [btn(), btn()], '.git-job-copy': [btn(), btn()], '.git-job-close': [btn(), btn()],
    '.git-job-fold': [btn(), btn()], '.git-job-auth-copy': [btn(), btn()],
  };
  return { innerHTML: '', by, querySelectorAll: (sel) => by[sel] || [] };
}

test('정책이 늦게 와 박스를 갈아 끼워도 버튼에 글자와 툴팁이 있다', () => {
  const ctx = load(['git/remote.js', 'git/remote-view.js', 'git/jobs.js'], { globals: { ...L } });
  const box = root();
  const j = Object.create(ctx.GitJobs.prototype);
  Object.assign(j, {
    panel: { app: {} }, views: {}, slots: [], _heads: new Set(), _jobs: null, _owned: new Set(),
    _el: { querySelector: (s) => (s === '.git-jobs' ? box : null) },
    bind() {}, paint() {},
  });
  assert.equal(j._build([{ slot: 'index' }, { slot: 'common', remote: true }]), true);
  for (const b of box.by['.git-job-close']) assert.deepEqual([b.textContent, b.title], ['Close', 'tip-close']);
  for (const b of box.by['.git-job-copy']) assert.deepEqual([b.textContent, b.title], ['Copy', 'tip-copy']);
  for (const b of box.by['.git-job-cancel']) assert.deepEqual([b.textContent, b.title], ['Cancel', 'tip-cancel']);
  for (const b of box.by['.git-job-auth-copy']) assert.equal(b.textContent, 'Copy command');
  for (const b of box.by['.git-job-fold']) assert.equal(b.title, 'tip-fold');
});

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { load } from './harness.mjs';

/**
 * REPO_FIX 05 §3A-7 (F-9.4) — 잡 `done` 의 판정. 보관 기간(5분)이 지나 `{id, done:true}` 만
 * 오면 **결과 미상**이다 — 성공으로 칠하지 않는다. 성공은 `exitCode===0` 이 명시된 경우만.
 */
const S = { GIT_JOB_OK: 'ok', GIT_JOB_FAIL: 'fail', GIT_JOB_CANCELED: 'canceled', GIT_JOB_UNKNOWN: 'unknown',
  GIT_JOB_RUNNING: 'running', GIT_JOB_CANCELING: 'canceling', GIT_JOB_STREAM_FAIL: 'stream' };

const ctx = load(['git/remote.js', 'git/jobs.js'], { globals: { ...S } });

test('F-9.4: 판정 넷 — 취소·성공·실패·결과 미상', () => {
  const o = ctx.gitJobOutcome;
  assert.equal(o({ id: 'a', done: true, canceled: true, exitCode: -1 }), 'canceled');
  assert.equal(o({ id: 'a', done: true, exitCode: 0 }), 'ok');
  assert.equal(o({ id: 'a', done: true, exitCode: 1 }), 'fail');
  assert.equal(o({ id: 'a', done: true, exitCode: 0, err: 'boom' }), 'fail');
  assert.equal(o({ id: 'a', done: true }), 'unknown', '보관 기간이 지난 잡');
  assert.equal(o(null), 'unknown');
});

test('F-9.4: 결과 미상은 성공으로 칠하지 않는다 — 상태 글자와 접기', () => {
  const r = Object.create(ctx.GitRemote.prototype);
  Object.assign(r, { _job: null, _busy: false, _err: null, _conflict: false, _logOpen: null, _done: { id: 'a', done: true } });
  assert.equal(r._state(), 'unknown');
  assert.equal(r._logCollapsed(), false, '성공만 접는다');
  r._done = { id: 'a', done: true, exitCode: 0 };
  assert.equal(r._state(), 'ok');
  assert.equal(r._logCollapsed(), true);
});

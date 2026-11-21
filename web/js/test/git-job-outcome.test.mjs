import assert from 'node:assert/strict';
import { test } from 'node:test';

import { load } from './harness.mjs';

/**
 * REPO_FIX 05 §3A-7 (F-9.4) — 잡 `done` 의 판정. 보관 기간(5분)이 지나 `{id, done:true}` 만
 * 오면 **결과 미상**이다 — 성공으로 칠하지 않는다. 성공은 `exitCode===0` 이 명시된 경우만.
 */
const S = { GIT_JOB_OK: 'ok', GIT_JOB_FAIL: 'fail', GIT_JOB_CANCELED: 'canceled', GIT_JOB_UNKNOWN: 'unknown',
  GIT_JOB_RUNNING: 'running', GIT_JOB_CANCELING: 'canceling', GIT_JOB_STREAM_FAIL: 'stream' };

const ctx = load(['git/remote.js', 'git/remote-view.js', 'git/jobs.js'], { globals: { ...S } });

test('F-9.4: 판정 넷 — 취소·성공·실패·결과 미상', () => {
  const o = ctx.gitJobOutcome;
  assert.equal(o({ id: 'a', done: true, canceled: true, exitCode: -1 }), 'canceled');
  assert.equal(o({ id: 'a', done: true, exitCode: 0 }), 'ok');
  assert.equal(o({ id: 'a', done: true, exitCode: 1 }), 'fail');
  assert.equal(o({ id: 'a', done: true, exitCode: 0, err: 'boom' }), 'fail');
  assert.equal(o({ id: 'a', done: true }), 'unknown', '보관 기간이 지난 잡');
  assert.equal(o(null), 'unknown');
});

// REFACTOR3_FE_REST3_SRS TC-FR3-36: 상태 글자와 접기 판정은 표시기의 뷰(`GitRemoteView`)가 표시기의 상태를 읽어 낸다.
test('F-9.4: 결과 미상은 성공으로 칠하지 않는다 — 상태 글자와 접기', () => {
  const r = { _job: null, _busy: false, _err: null, _conflict: false, _logOpen: null, _done: { id: 'a', done: true } };
  const v = new ctx.GitRemoteView(r);
  assert.equal(v._state(), 'unknown');
  assert.equal(v._logCollapsed(), false, '성공만 접는다');
  r._done = { id: 'a', done: true, exitCode: 0 };
  assert.equal(v._state(), 'ok');
  assert.equal(v._logCollapsed(), true);
});

test('TC-FR3-36: 표시는 뷰에, 상태·수명은 GitRemote 에 — 원형이 겹치지 않는다', () => {
  const view = ['bind', 'bindHead', 'paintHead', 'paintJob', '_box', '_logCollapsed', '_state', '_paintFail', '_paintLog',
    '_termCmd', '_copyLog'];
  for (const n of view) {
    assert.equal(typeof ctx.GitRemoteView.prototype[n], 'function', 'GitRemoteView.' + n);
    assert.equal(ctx.GitRemote.prototype[n], undefined, 'GitRemote 에 ' + n + ' 가 남았다');
  }
  for (const n of ['paint', '_paint', 'busy', 'dismiss', 'cancel', '_launch', '_attach', '_finish', 'adoptJobs', 'awaitJob']) {
    assert.equal(typeof ctx.GitRemote.prototype[n], 'function', 'GitRemote.' + n);
  }
  const r = new ctx.GitRemote({ app: {} }, 'index', null);
  assert.ok(r.view instanceof ctx.GitRemoteView);
  assert.equal(r.view.r, r);
});

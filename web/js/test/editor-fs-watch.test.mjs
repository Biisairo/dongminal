import assert from 'node:assert/strict';
import { test } from 'node:test';

import { load } from './harness.mjs';

/**
 * EDITOR_LIVE_RELOAD_SRS 묶음 C (FR-ELR-65~70) — 감시 등록과 `fs_changed` 에 대한 반응.
 */

function fakeTimers() {
  const jobs = [];
  return {
    jobs,
    frame: (fn, opts) => {
      const key = opts && opts.coalesce;
      if (key && jobs.some((j) => j.key === key && !j.done)) return {};
      jobs.push({ fn, key, ms: 0, done: false });
      return {};
    },
    after: (ms, fn) => { jobs.push({ fn, ms, done: false }); return { stop() {} } },
    flush() {
      for (const j of [...jobs]) if (!j.done) { j.done = true; j.fn() }
    },
  };
}

function app(opts = {}) {
  const timers = fakeTimers();
  const puts = [];
  const ctx = load(['core/app-editor-watch.js'], {
    globals: {
      App: class {},
      TIMERS: timers,
      FS_WATCH_API: '/api/fs/watch',
      serverMeta: { fsWatchDirsMax: 1024 }, capToServer: (l, m) => (m > 0 && l.length > m ? l.slice(0, m) : l),
      EXPLORER_FS_CHANGES_DELAY_MS: 500,
      EDITOR_DOC_RELOAD_QUEUE: 2,
      apiPut: async (path, body) => { puts.push({ path, body }); return opts.putReply || { ok: true, status: 200 } },
    },
  });
  const a = new ctx.App();
  a.clientId = 'c1';
  const refreshed = [];
  let release = null;
  a.edDocRefresh = (p) => {
    refreshed.push(p);
    return opts.slowRefresh ? new Promise((res) => { release = res }) : Promise.resolve(true);
  };
  a._edDocs = new Map();
  const ticks = [];
  a._edTick = () => { ticks.push(1) };
  const polls = [];
  const store = { kids: new Map([['/r', {}], ['/r/sub', {}]]), stampDirs: () => ['/r', '/r/sub'], pollStamp: () => { polls.push(1) } };
  const tree = { store, _edit: null };
  a._edVisibleTrees = () => [tree];
  a._edVisibleDocPaths = () => new Set(['/r/a.txt', '/x/y/b.md']);
  return { ctx, a, timers, puts, refreshed, ticks, polls, tree, releaseRefresh: () => release && release(true) };
}

const doc = (extra = {}) => ({ buf: {}, dirty: false, stamp: 's', ...extra });

test('V-ELR-33: UPDATED 가 다섯 번 와도 다시 읽기는 두 번 이하다', async () => {
  const { a, refreshed, releaseRefresh } = app({ slowRefresh: true });
  a._edDocs.set('/r/a.txt', doc());
  for (let i = 0; i < 5; i++) a._onFsChanged({ changes: [{ path: '/r/a.txt', type: 'updated' }] });
  assert.equal(refreshed.length, 1, '실행 중 하나');
  releaseRefresh();
  await new Promise((r) => setImmediate(r));
  releaseRefresh();
  await new Promise((r) => setImmediate(r));
  assert.equal(refreshed.length, 2, '대기 하나까지만');
});

test('ADDED 도 문서를 다시 읽는다. dirty·버퍼 없음·DELETED 는 읽지 않는다', () => {
  const { a, refreshed } = app();
  a._edDocs.set('/r/a.txt', doc());
  a._edDocs.set('/r/d.txt', doc({ dirty: true }));
  a._edDocs.set('/r/n.txt', doc({ buf: null }));
  a._edDocs.set('/r/g.txt', doc());
  a._onFsChanged({ changes: [
    { path: '/r/a.txt', type: 'added' },
    { path: '/r/d.txt', type: 'updated' },
    { path: '/r/n.txt', type: 'updated' },
    { path: '/r/g.txt', type: 'deleted' },
  ] });
  assert.deepEqual(refreshed, ['/r/a.txt']);
});

test('FR-ELR-70: 페이지가 숨어 있으면 무시한다', () => {
  const { ctx, a, refreshed, polls, timers } = app();
  a._edDocs.set('/r/a.txt', doc());
  ctx.document.hidden = true;
  a._onFsChanged({ changes: [{ path: '/r/a.txt', type: 'updated' }, { path: '/r/new', type: 'added' }] });
  timers.flush();
  assert.equal(refreshed.length, 0);
  assert.equal(polls.length, 0);
});

test('FR-ELR-69: overflow 는 편집기 틱을 곧바로 돌린다', () => {
  const { a, ticks } = app();
  a._onFsChanged({ overflow: true });
  assert.equal(ticks.length, 1);
});

test('FR-ELR-68: 읽힌 겹의 ADDED·DELETED 는 500ms 묶음 뒤 겹 스탬프를 한 번 묻는다', () => {
  const { a, polls, timers } = app();
  a._onFsChanged({ changes: [{ path: '/r/sub/n1', type: 'added' }] });
  a._onFsChanged({ changes: [{ path: '/r/sub/n2', type: 'deleted' }, { path: '/r/n3', type: 'added' }] });
  const delays = timers.jobs.filter((j) => j.ms > 0).map((j) => j.ms);
  assert.deepEqual(delays, [500], '창은 첫 이벤트에서 한 번 열린다');
  assert.equal(polls.length, 0);
  timers.flush();
  assert.equal(polls.length, 1);
});

test('FR-ELR-68: UPDATED·읽히지 않은 겹은 탐색기를 건드리지 않는다', () => {
  const { a, polls, timers } = app();
  a._onFsChanged({ changes: [{ path: '/r/sub/x', type: 'updated' }, { path: '/elsewhere/y', type: 'added' }] });
  timers.flush();
  assert.equal(polls.length, 0);
});

test('FR-ELR-68: 이름을 고치는 중이면 미룬다', () => {
  const { a, polls, timers, tree } = app();
  tree._edit = { mode: 'rename' };
  a._onFsChanged({ changes: [{ path: '/r/n', type: 'added' }] });
  timers.flush();
  assert.equal(polls.length, 0, '편집 중');
  tree._edit = null;
  timers.flush();
  assert.equal(polls.length, 1, '편집이 끝난 뒤');
});

test('FR-ELR-65: 등록 집합은 열린 파일의 부모와 탐색기 겹의 합이다', () => {
  const { a } = app();
  assert.deepEqual([...a._edWatchDirs()], ['/r', '/r/sub', '/x/y']);
});

const settle = () => new Promise((r) => setImmediate(r));

test('FR-ELR-66: SSE 구독이 처음 열리기 전에는 보내지 않는다 — 서버가 400 으로 거절한다', async () => {
  const { a, puts, timers } = app();
  a.edWatchSync();
  timers.flush();
  await settle();
  assert.equal(puts.length, 0, '구독 전');
  await a._edWatchRestore();
  assert.equal(puts.length, 1, '구독이 열린 뒤 한 번');
});

test('FR-ELR-66: 집합이 같으면 다시 보내지 않고, 바뀌면 보낸다', async () => {
  const { a, puts, timers } = app();
  await a._edWatchRestore();
  assert.equal(puts.length, 1);
  assert.equal(puts[0].path, '/api/fs/watch');
  assert.deepEqual(JSON.parse(JSON.stringify(puts[0].body)), { clientId: 'c1', dirs: ['/r', '/r/sub', '/x/y'] });
  a.edWatchSync();
  a.edWatchSync();
  timers.flush();
  await settle();
  assert.equal(puts.length, 1, '같은 집합');
  a._edVisibleDocPaths = () => new Set(['/q/z.txt']);
  a.edWatchSync();
  a.edWatchSync();
  timers.flush();
  await settle();
  assert.equal(puts.length, 2, '한 프레임에 한 번');
});

test('FR-ELR-66: SSE 가 다시 열리면 같은 집합이라도 다시 보낸다', async () => {
  const { a, puts } = app();
  await a._edWatchRestore();
  await a._edWatchRestore();
  assert.equal(puts.length, 2);
});

test('FR-ELR-66: 404 면 등록을 멈춘다', async () => {
  const { a, puts, timers } = app({ putReply: { ok: false, status: 404 } });
  await a._edWatchRestore();
  a._edVisibleDocPaths = () => new Set(['/q/z.txt']);
  a.edWatchSync();
  timers.flush();
  await settle();
  await a._edWatchRestore();
  assert.equal(puts.length, 1);
});

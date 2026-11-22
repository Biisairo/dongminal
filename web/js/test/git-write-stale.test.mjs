import assert from 'node:assert/strict';
import { test } from 'node:test';

import { BASE, GITVIEW, load } from './harness.mjs';

/**
 * ATTIC_FIX_SRS FR-ATF-74 (AT-GAPI-4) — 쓰기는 적용됐고 재조회만 실패하면 서버는 200 에
 * `status` 대신 `statusStale:true` 를 싣는다. 화면은 그 응답을 성공으로 읽고 새로고침 경로
 * (`viewReload.refresh`)로 상태를 다시 읽는다.
 */
let posted = null;
const ctx = load([...BASE, 'core/constants-api.js', 'git/view-util.js', ...GITVIEW, 'git/git-part.js',
  'git/git-write.js', 'git/remote-list.js'], {
  expose: ['GitWrite', 'GitRemoteList'],
  globals: {
    GitPanel: class {},
    gitPost: async () => posted,
    gitFetch: async () => ({}),
    GIT_WRITE_UNBOUNDED: new Set(),
    AbortController,
  },
});

const stale = { requested: '/r', repo: '/r', ok: true, partial: false, statusStale: true };

function panel() {
  const refreshed = [];
  const painted = [];
  const p = {
    app: { git: { sync: { gitReposRefresh() {} } }, statusbar: { updateStatusBar() {} } },
    repo: '/r', _writeGen: 0, _note: { msg: 'old' },
    _status: { requested: '/r', repo: '/r', mark: 'm1', status: { untracked: ['kept'] } },
    obs: { paintAll() { painted.push(1) } },
    viewReload: { refresh() { refreshed.push(1) } },
    views: { _stash: () => ({ adoptWrite() {} }) },
    token: () => 1, isStale: () => false,
  };
  p.write = new ctx.GitWrite(p);
  return { p, refreshed, painted };
}

test('FR-ATF-74: post 는 statusStale 응답을 성공으로 읽는다', async () => {
  const { p } = panel();
  posted = { ok: true, status: 200, data: stale };
  const res = await p.write.post('/api/git/stage', { repo: '/r', paths: ['a.txt'] });
  assert.equal(res.ok, true, 'statusStale 응답을 실패로 읽었다');
});

test('FR-ATF-74: adopt 는 statusStale 이면 새로고침으로 상태를 다시 읽고 옛 본문을 지우지 않는다', () => {
  const { p, refreshed, painted } = panel();
  p.write.adopt(stale);
  assert.equal(refreshed.length, 1, '상태를 다시 읽지 않았다');
  assert.deepEqual(p._status.status, { untracked: ['kept'] }, '빈 status 로 화면을 덮었다');
  assert.equal(painted.length, 0);
});

test('FR-ATF-74: 다른 저장소의 statusStale 응답은 새로고침하지 않는다', () => {
  const { p, refreshed } = panel();
  p.write.adopt({ ...stale, requested: '/other' });
  assert.equal(refreshed.length, 0);
});

test('FR-ATF-74: stash 쓰기의 statusStale 응답도 상태를 다시 읽는다', () => {
  const { p, refreshed } = panel();
  p.write.afterStashWrite({ ok: true, code: 200, data: stale });
  assert.equal(refreshed.length, 1);
});

test('FR-ATF-74: 원격 목록 쓰기의 statusStale 응답도 상태를 다시 읽는다', () => {
  const { p, refreshed } = panel();
  const v = new ctx.GitRemoteList(p);
  v.paint = () => {};
  assert.equal(v.adoptWrite({ ok: true, code: 200, data: stale }), true);
  assert.equal(refreshed.length, 1);
});

test('status 가 실린 성공 응답은 종전대로 본문을 적용하고 새로고침하지 않는다', () => {
  const { p, refreshed, painted } = panel();
  p.write.adopt({ requested: '/r', repo: '/r', ok: true, status: { untracked: [] } });
  assert.equal(refreshed.length, 0);
  assert.equal(painted.length, 1);
  assert.deepEqual(p._status.status, { untracked: [] });
});

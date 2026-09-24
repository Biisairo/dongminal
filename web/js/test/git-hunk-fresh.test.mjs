import assert from 'node:assert/strict';
import { test } from 'node:test';

import { load } from './harness.mjs';

/**
 * REPO_FIX 05 §3A-6 (F-5.1) — Diff 본문이 바뀐 회차에 hunk 목록·diffId 를 함께 버리고
 * 곧바로 다시 받는다. 그 사이 툴바는 낡은 조각을 쓰지 않는다(#44).
 */
function panel() {
  const ctx = load(['git/panel-diff.js'], {
    globals: {
      GitPanel: class {},
      GIT_HUNK_AXES: new Set(['unstaged']),
      GIT_PATCH_REVERT: 'revert',
      GIT_STATUS_FETCH_TIMEOUT_MS: 1,
      GIT_HUNK_LOADING: 'loading', GIT_HUNK_NONE: 'none', GIT_HUNK_DIRTY: 'dirty', GIT_HUNK_UTF16: 'utf16',
    },
  });
  const p = Object.create(ctx.GitPanel.prototype);
  const posts = [], loads = [];
  const f = { repo: '/r', axis: 'unstaged', path: 'a.txt' };
  const el = { dataset: { built: '1' }, querySelector: () => ({ dataset: {}, classList: { toggle() {} } }) };
  Object.assign(p, {
    repo: '/r', commitFile: null, previewFile: f, _blameOn: false, _writing: false,
    _els: new Map([['diff', el]]),
    _diffView: { dirty: false, docEncoding: () => '' },
    _hunkKey: ['/r', 'unstaged', 'a.txt'].join('\u0000'),
    _hunks: { diffId: 'old', list: [{ index: 0, header: '@@' }], note: '' },
    _hunkBarPos: null, _hunkBarHunk: 0,
    _hunkBarCoords: () => ({ hunk: 0, from: 0, to: 0 }),
    _hunkNote() {}, _hunkBarCursor() {},
    _diffTarget() { return this.commitFile || this.previewFile },
    _loadHunks: (tf, key) => loads.push([tf.path, key]),
    post: async (url, body) => { posts.push([url, body]); return { ok: true, data: {} } },
    _afterHunk() {},
  });
  return { p, posts, loads };
}

test('F-5.1: 본문이 바뀌면 조각 관측을 버리고 곧바로 다시 받는다', () => {
  const { p, loads } = panel();
  p._diffChanged();
  assert.equal(p._hunks, null, '낡은 목록·diffId 를 들고 있지 않다');
  assert.equal(loads.length, 1, '다음 그리기를 기다리지 않고 요청한다');
  assert.equal(loads[0][0], 'a.txt');
});

test('F-5.1: 다시 받는 사이의 hunk 동작은 낡은 diffId 를 보내지 않는다', async () => {
  const { p, posts } = panel();
  p._diffChanged();
  await p._hunkAct('stage');
  assert.equal(posts.length, 0);
});

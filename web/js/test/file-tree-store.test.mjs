import assert from 'node:assert/strict';
import { test } from 'node:test';

import { load } from './harness.mjs';

/**
 * REPO_FIX 04 §3A-2 (T-3.1) — 같은 루트를 여러 칸에 띄워도 스탬프 질의는 store 가
 * 한 번에, 모든 뷰의 펼친 폴더 합집합으로 한다. 사라진 폴더는 캐시를 버리고, 다시
 * 생기면 그 폴더를 펼친 뷰가 새로 읽는다.
 */
// OPTIMIZE_REFACTOR_SRS FR-OPT-4-2: 묻는 종단은 `/api/fs/stamps` 하나다. 본문은
// `{trees:[{root,dirs}],paths}`, 답은 루트마다 `{stamps}` 또는 `{code,status}` 다.
function setup(answers, raw) {
  const sent = [];
  const urls = [];
  let i = 0;
  const ctx = load(['ui/file-tree-obs.js', 'ui/file-tree-store.js'], {
    expose: ['FileTreeStore'],
    globals: {
      FS_STAMP_MAX: 256, FS_STAMPS_API: '/api/fs/stamps',
      apiPost: async (u, body) => {
        urls.push(u);
        sent.push(body.trees[0].dirs.slice());
        const a = answers[Math.min(i++, answers.length - 1)];
        return raw ? a : { ok: true, status: 200, data: { trees: { '/r': { stamps: a } }, paths: {} } };
      },
    },
  });
  const store = new ctx.FileTreeStore({ edStores: new Map() }, '/r');
  const reloads = [];
  const view = (open) => ({ _open: new Set(open), paint() {}, reload: async (d) => { reloads.push(d) } });
  return { store, sent, urls, reloads, view };
}

test('두 뷰의 펼친 폴더 합집합을 한 번에 묻는다', async () => {
  const { store, sent, view } = setup([{ '/r': 's', '/r/a': 's', '/r/b': 's' }]);
  store.kids.set('/r/a', {}); store.kids.set('/r/b', {});
  store.attach(view(['/r/a'])); store.attach(view(['/r/b', '/r/a']));
  await store.pollStamp();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].join(), '/r,/r/a,/r/b');
});

test('사라진 폴더는 캐시를 버리고, 다시 생기면 그 폴더를 펼친 뷰가 새로 읽는다', async () => {
  const { store, reloads, view } = setup([
    { '/r': 's', '/r/b': 's1' },
    { '/r': 's' },
    { '/r': 's', '/r/b': 's1' },
  ]);
  store.kids.set('/r/b', { entries: [] });
  store.attach(view([])); store.attach(view(['/r/b']));
  await store.pollStamp(); // 처음 본 겹 — 기억만
  await store.pollStamp(); // 사라짐
  assert.equal(store.kids.has('/r/b'), false);
  await store.pollStamp(); // 다시 생김
  assert.equal(reloads.join(), '/r/b');
});

test('종단은 합친 하나이고, 루트의 답이 4xx 판정이면 그 루트만 굳힌다 (FR-OPT-4-2 · FR-FSL-12)', async () => {
  const { store, sent, urls } = setup([
    { ok: true, status: 200, data: { trees: { '/r': { code: 'io_failed', status: 500 } }, paths: {} } },
    { ok: true, status: 200, data: { trees: { '/r': { code: 'outside_root', status: 403 } }, paths: {} } },
  ], true);
  await store.pollStamp();
  assert.equal(urls[0], '/api/fs/stamps');
  assert.equal(store.stampOff, false, '5xx 판정은 굳히지 않는다');
  await store.pollStamp();
  assert.equal(store.stampOff, true);
  await store.pollStamp();
  assert.equal(sent.length, 2, '굳은 뒤에는 묻지 않는다');
});

test('요청 전체가 4xx 면(종단이 없는 옛 서버) 굳힌다', async () => {
  const { store, sent } = setup([{ ok: false, status: 404, data: null }], true);
  await store.pollStamp();
  await store.pollStamp();
  assert.equal(store.stampOff, true);
  assert.equal(sent.length, 1);
});

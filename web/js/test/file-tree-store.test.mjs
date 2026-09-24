import assert from 'node:assert/strict';
import { test } from 'node:test';

import { load } from './harness.mjs';

/**
 * REPO_FIX 04 §3A-2 (T-3.1) — 같은 루트를 여러 칸에 띄워도 스탬프 질의는 store 가
 * 한 번에, 모든 뷰의 펼친 폴더 합집합으로 한다. 사라진 폴더는 캐시를 버리고, 다시
 * 생기면 그 폴더를 펼친 뷰가 새로 읽는다.
 */
function setup(answers) {
  const sent = [];
  let i = 0;
  const ctx = load(['ui/file-tree-obs.js', 'ui/file-tree-store.js'], {
    expose: ['FileTreeStore'],
    globals: {
      FS_STAMP_MAX: 256, FS_STAMP_API: '/api/fs/stamp',
      apiPost: async (_u, body) => { sent.push(body.dirs.slice()); return { ok: true, status: 200, data: { stamps: answers[Math.min(i++, answers.length - 1)] } } },
    },
  });
  const store = new ctx.FileTreeStore({ edStores: new Map() }, '/r');
  const reloads = [];
  const view = (open) => ({ _open: new Set(open), paint() {}, reload: async (d) => { reloads.push(d) } });
  return { store, sent, reloads, view };
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

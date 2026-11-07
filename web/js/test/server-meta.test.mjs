import assert from 'node:assert/strict';
import { test } from 'node:test';

import { load } from './harness.mjs';

/**
 * SERVER_DRIVEN_ACTIONS_SRS K-b·K-c·K-d (FR-SDA-80) — 화면이 그대로 쓰는 상한·목록은 **서버가**
 * 보낸다. 받기 전에는 자르지 않고, 목록은 비어 있다.
 */
function fresh() {
  return load(['core/i18n.js', 'i18n/ko.js', 'core/constants.js', 'core/constants-git-history.js'], {
    expose: ['applyServerMeta', 'capToServer', 'gitLogLimit', 'serverMeta'],
  });
}

test('받기 전에는 자르지 않는다', () => {
  const { capToServer, serverMeta } = fresh();
  const list = Array.from({ length: 2000 }, (_, i) => i);
  assert.equal(capToServer(list, serverMeta.fsStampMax).length, 2000);
  assert.deepEqual([...serverMeta.encodings], []);
});

test('서버의 상한으로 자른다', () => {
  const { applyServerMeta, capToServer, serverMeta } = fresh();
  applyServerMeta({ fsStampMax: 3, fileStampsMax: 2, fsWatchDirsMax: 5, encodings: ['utf-8', 'cp949'] });
  assert.deepEqual(capToServer([1, 2, 3, 4], serverMeta.fsStampMax), [1, 2, 3]);
  assert.deepEqual(capToServer([1, 2, 3], serverMeta.fileStampsMax), [1, 2]);
  assert.equal(serverMeta.fsWatchDirsMax, 5);
  assert.deepEqual([...serverMeta.encodings], ['utf-8', 'cp949']);
});

test('모르는 값은 무시한다', () => {
  const { applyServerMeta, serverMeta } = fresh();
  applyServerMeta({ fsStampMax: 3, encodings: ['utf-8'] });
  applyServerMeta({ fsStampMax: -1, encodings: 'utf-8' });
  applyServerMeta({ encodings: ['utf-8', 7] });
  applyServerMeta(null);
  assert.equal(serverMeta.fsStampMax, 3);
  assert.deepEqual([...serverMeta.encodings], ['utf-8']);
});

test('History 페이지 크기는 정책의 값이다', () => {
  const { gitLogLimit } = fresh();
  const lim = { initial: 30, page: 10, max: 200 };
  assert.equal(gitLogLimit(lim, false, false, 0), 30);
  assert.equal(gitLogLimit(lim, true, false, 55), 10);
  assert.equal(gitLogLimit(lim, false, true, 55), 55);
  assert.equal(gitLogLimit(lim, false, true, 5), 30);
  assert.equal(gitLogLimit(lim, false, true, 900), 200);
});

test('정책이 없으면 limit 을 싣지 않는다 — 서버가 첫 장 크기로 접는다', () => {
  const { gitLogLimit } = fresh();
  assert.equal(gitLogLimit(null, false, false, 0), undefined);
  assert.equal(gitLogLimit(null, true, false, 55), undefined);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { load } from './harness.mjs';

/** REPO_FIX 04 §3A-2 — 폴더 관측 상태 전이. */
const { ftObsLoaded, ftObsPoll } = load(['ui/file-tree-obs.js']);

test('unseen 은 스탬프만 기억하고, ok 의 스탬프 변화는 재조회', () => {
  const obs = new Map();
  let r = ftObsPoll(obs, ['/a'], { '/a': 's1' }, 0);
  assert.equal(r.reload.length, 0);
  assert.equal(obs.get('/a').state, 'ok');
  r = ftObsPoll(obs, ['/a'], { '/a': 's1' }, 1);
  assert.equal(r.reload.length, 0);
  r = ftObsPoll(obs, ['/a'], { '/a': 's2' }, 2);
  assert.equal(r.reload.join(), '/a');
});

test('실패한 폴더는 스탬프와 무관하게 재조회 — 백오프 시각 전이면 건너뛴다', () => {
  const obs = new Map();
  ftObsLoaded(obs, '/a', false, '', 'io', 100, 50);
  assert.equal(obs.get('/a').state, 'failed');
  assert.equal(ftObsPoll(obs, ['/a'], { '/a': 's' }, 120).reload.length, 0, '백오프 중');
  assert.equal(ftObsPoll(obs, ['/a'], { '/a': 's' }, 150).reload.join(), '/a');
  ftObsLoaded(obs, '/a', false, '', 'io', 150, 50);
  assert.equal(obs.get('/a').fails, 2, '연속 실패를 센다');
  ftObsLoaded(obs, '/a', true, 's9', '', 300, 0);
  assert.equal(obs.get('/a').state, 'ok');
});

test('사라진 폴더는 gone(캐시 폐기), 다시 생기면 새로 읽는다', () => {
  const obs = new Map();
  ftObsLoaded(obs, '/a', true, 's1', '', 0, 0);
  let r = ftObsPoll(obs, ['/a'], {}, 1);
  assert.equal(r.gone.join(), '/a');
  assert.equal(obs.get('/a').state, 'gone');
  r = ftObsPoll(obs, ['/a'], {}, 2);
  assert.equal(r.gone.length + r.reload.length, 0, '여전히 없으면 무동작');
  r = ftObsPoll(obs, ['/a'], { '/a': 's1' }, 3);
  assert.equal(r.reload.join(), '/a', '같은 스탬프로 돌아와도 새로 읽는다');
});

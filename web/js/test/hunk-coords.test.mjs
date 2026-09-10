import assert from 'node:assert/strict';
import { test } from 'node:test';

import { load, plain } from './harness.mjs';

/**
 * `web/js/core/hunk-coords.js` — 서버 hunk 좌표의 클라이언트 측 사상
 * (DIFF_HUNK_BAR_SRS D-2 · EDITOR_DIRTY_DIFF_SRS FR-EDD-46).
 *
 * **우선순위 1** 이다 (`05-test.md §3.4`): 틀리면 사용자가 고른 것과 **다른 줄이
 * 스테이지되거나 되돌려진다.** 되돌리기는 파괴적이고 확인창은 개수만 세므로,
 * 좌표가 한 칸 어긋나도 화면은 그럴듯하게 보인다.
 *
 * 지금까지 이 함수들의 유일한 검사는 `git-hunk.spec.ts:407-448` 이었다 — 브라우저를
 * 띄워 순수 함수를 부르는 e2e 5건. 여기가 그 자리를 대신한다.
 */
const ctx = load(['core/hunk-coords.js']);
const { gitHunkScan, gitHunkRangeForChange, gitHunkRangeForLines,
  gitHunkCoordsForChange, gitHunkAt } = ctx;

/** `git diff` 본문 한 벌. 문맥 1 · 삭제 1 · 추가 2 · 문맥 1. */
const HUNK = {
  index: 0, newStart: 10, newLines: 4, oldStart: 10, oldLines: 3,
  lines: [' ctx-a', '-gone', '+new-1', '+new-2', ' ctx-b'],
};

test('scan: 새 쪽·옛 쪽 번호를 함께 센다 — 한쪽만 세면 절반을 가리킬 수 없다', () => {
  assert.deepEqual(plain(gitHunkScan(HUNK)), [
    { i: 1, mark: ' ', newLine: 10, oldLine: 10 },
    { i: 2, mark: '-', newLine: 0, oldLine: 11 },
    { i: 3, mark: '+', newLine: 11, oldLine: 0 },
    { i: 4, mark: '+', newLine: 12, oldLine: 0 },
    { i: 5, mark: ' ', newLine: 13, oldLine: 12 },
  ]);
});

test('scan: `\\ No newline` 은 줄이 아니라 표식이다 — 양쪽 번호가 0', () => {
  const rows = gitHunkScan({ newStart: 1, oldStart: 1, lines: ['+a', '\\ No newline at end of file'] });
  assert.deepEqual(plain(rows[1]), { i: 2, mark: '\\', newLine: 0, oldLine: 0 });
  assert.equal(rows[0].newLine, 1, '표식이 앞 줄의 번호를 먹었다');
});

test('scan: 빈 덩어리·undefined 를 견딘다', () => {
  assert.deepEqual(plain(gitHunkScan(null)), []);
  assert.deepEqual(plain(gitHunkScan({})), []);
  assert.deepEqual(plain(gitHunkScan({ lines: [] })), []);
});

test('rangeForChange: 새 줄 범위와 옛 줄 범위를 함께 받아 본문 인덱스를 낸다', () => {
  // 새 11~12 (추가 둘) + 옛 11 (삭제 하나) = 본문 2..4
  assert.deepEqual(plain(gitHunkRangeForChange(HUNK, { line: 11, count: 2, baseStart: 11, baseCount: 1 })),
    [2, 4]);
});

test('rangeForChange: 추가만 고르면 삭제 줄은 범위 밖이다', () => {
  assert.deepEqual(plain(gitHunkRangeForChange(HUNK, { line: 11, count: 2, baseStart: 0, baseCount: 0 })),
    [3, 4]);
});

test('rangeForChange: 겹치는 줄이 없으면 null — 관측이 낡았다는 신호다', () => {
  assert.equal(gitHunkRangeForChange(HUNK, { line: 99, count: 1, baseStart: 99, baseCount: 1 }), null);
  assert.equal(gitHunkRangeForChange(HUNK, null), null);
});

test('rangeForChange: `\\ No newline` 은 앞 줄을 골랐을 때만 따라온다', () => {
  const h = { newStart: 1, oldStart: 1, lines: ['+a', '\\ No newline at end of file'] };
  assert.deepEqual(plain(gitHunkRangeForChange(h, { line: 1, count: 1, baseStart: 0, baseCount: 0 })), [1, 2],
    '앞 줄을 골랐는데 표식이 빠졌다 — 없는 줄에 대한 표식이 남는다');
});

test('rangeForLines: 수정 짝은 함께 간다 (FR-DHB-33)', () => {
  // 새 줄 11 하나만 골랐다. 그 짝인 삭제 줄(본문 2)이 함께 와야 한다 — 사용자가
  // 고른 것은 "이 줄을 이렇게 바꾼다" 이지 "이 줄을 더한다" 가 아니다.
  assert.deepEqual(plain(gitHunkRangeForLines(HUNK, 11, 11)), [2, 4]);
});

test('rangeForLines: 문맥 줄이 블록을 가른다', () => {
  const h = {
    newStart: 1, oldStart: 1,
    lines: ['+a', ' ctx', '+b'],   // 새 1 / 문맥 2 / 새 3
  };
  assert.deepEqual(plain(gitHunkRangeForLines(h, 1, 1)), [1, 1]);
  assert.deepEqual(plain(gitHunkRangeForLines(h, 3, 3)), [3, 3]);
  assert.deepEqual(plain(gitHunkRangeForLines(h, 1, 3)), [1, 3], '두 블록에 걸치면 사이의 문맥도 범위다');
});

test('rangeForLines: 삭제만 있는 블록은 새 쪽 선택으로 닿을 수 없다 (FR-DHB-35)', () => {
  const h = { newStart: 5, oldStart: 5, lines: [' ctx', '-gone', ' ctx2'] };
  assert.equal(gitHunkRangeForLines(h, 5, 6), null);
});

test('rangeForLines: 거꾸로 고른 범위도 같게 읽는다', () => {
  assert.deepEqual(plain(gitHunkRangeForLines(HUNK, 12, 11)), plain(gitHunkRangeForLines(HUNK, 11, 12)));
});

test('coordsForChange: 좁히지 못하면 wide — 덩어리 전체를 가리킨다', () => {
  const hs = [HUNK];
  // 새 쪽 줄은 겹치는데(덩어리 10~13) 본문에서 짚을 줄이 없는 조각.
  const r = gitHunkCoordsForChange(hs, { line: 10, count: 1, baseStart: 0, baseCount: 0 });
  assert.equal(r.hunk, 0);
  assert.equal(r.wide, true, '좁히지 못했는데 좁힌 척했다 — 다른 줄을 건드린다');
  assert.equal(r.from, 0);
});

test('coordsForChange: 겹치는 덩어리가 없으면 null', () => {
  assert.equal(gitHunkCoordsForChange([HUNK], { line: 500, count: 1 }), null);
  assert.equal(gitHunkCoordsForChange([], { line: 10, count: 1 }), null);
  assert.equal(gitHunkCoordsForChange(null, { line: 10, count: 1 }), null);
  assert.equal(gitHunkCoordsForChange([HUNK], null), null);
});

test('coordsForChange: 삭제 조각은 경계 한 줄 밖까지 자기 자리로 본다', () => {
  // count 0 = 새 쪽에 줄이 없는 삭제. 덩어리는 새 10~13 이므로 9 도 걸린다.
  assert.equal(gitHunkCoordsForChange([HUNK], { line: 9, count: 0 }).hunk, 0);
  assert.equal(gitHunkCoordsForChange([HUNK], { line: 14, count: 0 }).hunk, 0);
  assert.equal(gitHunkCoordsForChange([HUNK], { line: 8, count: 0 }), null);
});

test('hunkAt: 문맥 줄도 그 덩어리의 것이다 (FR-DHB-11)', () => {
  assert.equal(gitHunkAt([HUNK], 10), HUNK);
  assert.equal(gitHunkAt([HUNK], 13), HUNK);
  assert.equal(gitHunkAt([HUNK], 14), null);
});

test('hunkAt: newLines 0 인 덩어리는 newStart 한 줄로 본다', () => {
  const empty = { index: 1, newStart: 7, newLines: 0 };
  assert.equal(gitHunkAt([empty], 7), empty);
  assert.equal(gitHunkAt([empty], 8), null);
});

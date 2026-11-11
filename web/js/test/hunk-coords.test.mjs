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
  gitHunkCoordsForChange, gitHunkAt, gitHunkBlockAt, gitHunkSpanAt } = ctx;

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

// UX_BATCH12_SRS FR-HKB-1·3 (TC-HKB-3): 커서 줄이 닿은 **변경 블록** 하나의 좌표.
// 블록은 문맥 없이 이어진 `-`·`+` 의 묶음이다 — 화면의 변경 조각 하나에 맞는다.
const TWO = {
  index: 0, newStart: 7, newLines: 9, oldStart: 7, oldLines: 9,
  lines: [' 7', ' 8', ' 9', '-10', '+TEN', ' 11', '-12', ' 13', '+N', ' 14', ' 15'],
};

test('block: 수정 블록의 새 줄에 커서 — 그 블록만 (`-` 짝 포함)', () => {
  assert.deepEqual(plain(gitHunkBlockAt(TWO, 10)), { from: 4, to: 5, s: 10, e: 10 });
});

test('block: 삭제만 있는 블록은 바로 다음 줄이 그 자리다', () => {
  // 새 쪽: 7 8 9 TEN(10) 11(11) 13(12) N(13) 14 15 — `-12` 다음 줄은 새 12행(13)
  assert.deepEqual(plain(gitHunkBlockAt(TWO, 12)), { from: 7, to: 7, s: 12, e: 12 });
});

test('block: 추가만 있는 블록', () => {
  assert.deepEqual(plain(gitHunkBlockAt(TWO, 13)), { from: 9, to: 9, s: 13, e: 13 });
});

test('block: 문맥 줄은 블록이 아니다 — null', () => {
  for (const ln of [7, 9, 11, 14, 15]) assert.equal(gitHunkBlockAt(TWO, ln), null, String(ln));
});

test('block: 파일 끝의 삭제는 바로 앞 줄이 그 자리다', () => {
  const END = { index: 0, newStart: 3, newLines: 2, oldStart: 3, oldLines: 3, lines: [' a', ' b', '-c'] };
  assert.deepEqual(plain(gitHunkBlockAt(END, 4)), { from: 3, to: 3, s: 4, e: 4 });
  assert.equal(gitHunkBlockAt(END, 3), null);
});

test('block: `\\ No newline` 표식은 블록에 딸려 간다', () => {
  const NL = { index: 0, newStart: 1, newLines: 1, oldStart: 1, oldLines: 1,
    lines: ['-a', '\\ No newline at end of file', '+b', '\\ No newline at end of file'] };
  assert.deepEqual(plain(gitHunkBlockAt(NL, 1)), { from: 1, to: 4, s: 1, e: 1 });
});

/**
 * UI_POLISH_SRS FR-UIP-25 · TC-UIP-13: 화면이 한 덩어리로 칠한 줄 범위 → 그 범위에 닿은 git 블록 전부.
 * 화면(CodeMirror)의 diff 는 가까운 삭제·추가를 한 덩어리로 칠하는데, git 은 사이에 문맥을 두고
 * 블록 둘로 나눈다. 동작은 사용자가 보는 덩어리를 따른다.
 */
test('span: 칠해진 덩어리가 git 블록 둘(삭제만 · 추가)에 걸치면 둘을 함께 잡는다', () => {
  assert.deepEqual(plain(gitHunkSpanAt(TWO, 12, 13)), { from: 7, to: 9, s: 12, e: 13 });
});

test('span: 덩어리가 블록 하나면 그 블록과 같다', () => {
  assert.deepEqual(plain(gitHunkSpanAt(TWO, 10, 10)), { from: 4, to: 5, s: 10, e: 10 });
});

test('span: 블록에 닿지 않는 범위(문맥뿐)는 null 이다', () => {
  assert.equal(gitHunkSpanAt(TWO, 11, 11), null);
});

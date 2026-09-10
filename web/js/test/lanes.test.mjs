import assert from 'node:assert/strict';
import { test } from 'node:test';

import { load, plain } from './harness.mjs';

/**
 * `web/js/git/lanes.js` — History 그래프의 레인 배치 (R1~R4).
 *
 * **우선순위 3** 이다 (`05-test.md §3.4`): 입력이 DAG 이고 출력이 열 번호라
 * 표 기반 검사에 가장 잘 맞는다. 지금까지 이 알고리즘의 검사는 그려진 픽셀을
 * 보는 e2e 뿐이었고, 그것은 배치가 틀린 것과 CSS 가 틀린 것을 가르지 못한다.
 *
 * 커밋 목록은 위가 최신이다 (`git log` 순서). 부모는 언제나 아래에 있다.
 */
const ctx = load(['git/lanes.js']);
const { buildLaneGraph, clampLanes } = ctx;

/** `A → B → C` 한 줄. */
const LINEAR = [
  { hash: 'A', parents: ['B'] },
  { hash: 'B', parents: ['C'] },
  { hash: 'C', parents: [] },
];

/**
 * 갈라졌다 합쳐진다.
 *   M(머지) ─┬─ X ─┐
 *            └─ Y ─┴─ Z
 */
const MERGE = [
  { hash: 'M', parents: ['X', 'Y'] },
  { hash: 'X', parents: ['Z'] },
  { hash: 'Y', parents: ['Z'] },
  { hash: 'Z', parents: [] },
];

test('빈 입력은 빈 그래프다', () => {
  assert.deepEqual(plain(buildLaneGraph([])), { rows: [], maxLanes: 0 });
});

test('한 줄 히스토리는 전부 0번 레인이다', () => {
  const g = buildLaneGraph(LINEAR);
  assert.deepEqual(plain(g.rows.map(r => r.lane)), [0, 0, 0]);
  assert.equal(g.maxLanes, 1);
});

test('한 줄 히스토리에는 지나가는 선이 없다', () => {
  const g = buildLaneGraph(LINEAR);
  for (const r of g.rows) assert.equal(r.passThrough.length, 0, r.hash + ' 에 남의 선이 있다');
});

test('가장 위 커밋은 새 갈래의 머리다 — 진입선을 그리지 않는다 (FR-GIT-121)', () => {
  const g = buildLaneGraph(LINEAR);
  assert.equal(g.rows[0].isNewHead, true);
  assert.equal(g.rows[1].isNewHead, false);
});

test('머지는 부모 수만큼 내려가는 선을 갖는다', () => {
  const g = buildLaneGraph(MERGE);
  assert.equal(g.rows[0].hash, 'M');
  assert.equal(g.rows[0].parentLanes.length, 2, '머지의 두 부모가 각자 열을 갖지 않는다');
});

test('갈래가 둘이면 레인도 둘이다', () => {
  const g = buildLaneGraph(MERGE);
  assert.equal(g.maxLanes, 2);
  const lanes = plain(g.rows.map(r => r.lane));
  assert.equal(lanes[0], 0, '머지 커밋은 첫 열에 선다');
  assert.notEqual(lanes[1], lanes[2], 'X 와 Y 가 같은 열에 겹쳤다');
});

test('점의 열에서 시작하는 선만 parentLanes 다 — 나머지는 지나가는 선', () => {
  const g = buildLaneGraph(MERGE);
  for (const r of g.rows) {
    for (const s of r.passThrough) {
      assert.notEqual(s.top, r.lane, r.hash + ': 자기 점에서 나가는 선이 남의 선으로 분류됐다');
    }
  }
});

test('로드된 창 밖의 부모는 목록 끝까지 내려간다 — 끊기지 않는다', () => {
  // C 의 부모 'OLD' 는 목록에 없다. 그 선은 마지막 행까지 살아 있어야 한다.
  const g = buildLaneGraph([
    { hash: 'A', parents: ['B'] },
    { hash: 'B', parents: ['C'] },
    { hash: 'C', parents: ['OLD'] },
  ]);
  assert.equal(g.rows[2].parentLanes.length, 1, '창 밖 부모로 가는 선이 사라졌다');
});

test('위상 정렬이 깨진 입력에서도 걸음이 되돌아 돌지 않는다', () => {
  // B 의 부모가 자기보다 **위**에 있다. 바닥으로 떨어뜨려 무한 순환을 막는 자리.
  const g = buildLaneGraph([
    { hash: 'A', parents: ['B'] },
    { hash: 'B', parents: ['A'] },
  ]);
  assert.equal(g.rows.length, 2);
});

test('부모가 undefined 여도 견딘다', () => {
  const g = buildLaneGraph([{ hash: 'A' }, { hash: 'B' }]);
  assert.equal(g.rows.length, 2);
});

test('clamp: 상한 안에 드는 그래프는 압축 표식이 서지 않는다', () => {
  const c = clampLanes(buildLaneGraph(MERGE), 10);
  for (const r of c.rows) assert.equal(r.compressed, false, r.hash + ' 이 접히지도 않고 접혔다고 말한다');
  assert.equal(c.maxLanes, 2);
});

test('clamp: 상한을 넘는 열은 마지막 열로 접히고 그 행만 표식이 선다', () => {
  const c = clampLanes(buildLaneGraph(MERGE), 1);
  assert.equal(c.maxLanes, 1);
  for (const r of c.rows) assert.ok(r.lane <= 0, r.hash + ' 의 열이 상한 밖이다');
  assert.ok(c.rows.some(r => r.compressed), '접혔는데 아무도 그 사실을 말하지 않는다');
});

test('clamp: 원본을 제자리에서 고치지 않는다 — 상한을 바꿔 다시 접을 수 있어야 한다', () => {
  const g = buildLaneGraph(MERGE);
  const before = plain(g.rows.map(r => r.lane));
  clampLanes(g, 1);
  assert.deepEqual(plain(g.rows.map(r => r.lane)), before, '원본 배치가 접힌 값으로 덮였다');
});

test('clamp: 이미 접힌 그래프를 다시 넣어도 압축 사실이 남는다', () => {
  const once = clampLanes(buildLaneGraph(MERGE), 1);
  const twice = clampLanes(once, 1);
  assert.deepEqual(
    plain(twice.rows.map(r => r.compressed)),
    plain(once.rows.map(r => r.compressed)),
    '두 번째 호출에서 압축 표식이 사라졌다');
});

test('clamp: 접힌 뒤 중복 선이 사라지고 오름차순으로 선다', () => {
  const c = clampLanes(buildLaneGraph(MERGE), 1);
  for (const r of c.rows) {
    const keys = r.passThrough.map(s => s.top + ':' + s.bottom);
    assert.equal(new Set(keys).size, keys.length, r.hash + ' 에 같은 선이 둘 있다');
    const cols = r.parentLanes.map(s => s.col);
    assert.deepEqual(plain(cols), [...cols].sort((a, b) => a - b), r.hash + ' 의 부모 선이 정렬되지 않았다');
  }
});

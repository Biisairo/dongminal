import assert from 'node:assert/strict';
import test from 'node:test';

import { loadCM } from './cm-harness.mjs';
import { load, plain } from './harness.mjs';

/**
 * `git/diff-cm.js` — CODEMIRROR_MIGRATION_SRS FR-CMR-53·57 / §11.4.
 *
 * `gitDiffIgnoreWs(a, b)` 는 `diffConfig.override` 자리에 들어가는 diff 다. 줄마다 앞뒤 공백을 걷어 비교하고,
 * 결과 범위는 원래 텍스트의 offset 이다.
 */

const CM = await loadCM();
const ctx = load(['ui/file-editor-diff.js', 'git/diff-cm.js'], {
  expose: ['gitDiffIgnoreWs', 'gitDiffRulerItems'],
  globals: {
    CM,
    FileEditor: class {},
    ED_DD_ADD: 'add', ED_DD_MOD: 'mod', ED_DD_DEL: 'del', ED_DD_COLOR_VAR: {},
    ED_DD_MAX_LINES: 50000, ED_DD_MAX_EDITS: 2000,
    GIT_DIFF_RULER_ADD: '--diff-add', GIT_DIFF_RULER_DEL: '--diff-del',
  },
});
const ws = (a, b) => plain(ctx.gitDiffIgnoreWs(a, b)).map((c) => [c.fromA, c.toA, c.fromB, c.toB]);
// 변경을 a 에 적용하면 b 가 되는가 — offset 이 원문 범위 안에서 맞는지 본다.
const applies = (a, b) => {
  let out = '', at = 0;
  for (const c of ctx.gitDiffIgnoreWs(a, b)) {
    assert.ok(c.fromA >= at && c.toA <= a.length && c.fromB <= c.toB && c.toB <= b.length, '범위가 원문 밖이다');
    out += a.slice(at, c.fromA) + b.slice(c.fromB, c.toB);
    at = c.toA;
  }
  return out + a.slice(at);
};

test('FR-CMR-53: 앞뒤 공백만 다른 줄은 변경이 아니다', () => {
  assert.deepEqual(ws('a\n  b\nc\n', 'a\nb  \nc\n'), []);
  assert.deepEqual(ws('x\t\n', 'x\n'), []);
  assert.deepEqual(ws('a\r\nb', 'a\nb'), [], 'CRLF 의 \\r 도 줄 끝 공백이다');
});

test('FR-CMR-53: 줄 안의 공백 차이는 변경이다', () => {
  assert.deepEqual(ws('a b\n', 'ab\n'), [[0, 4, 0, 3]]);
});

test('수정 줄은 그 줄을 줄 끝까지 바꾼다 — 적용하면 b 다', () => {
  const a = 'one\ntwo\nthree\n', b = 'one\nTWO\nthree\n';
  assert.deepEqual(ws(a, b), [[4, 8, 4, 8]]);
  assert.equal(applies(a, b), b);
});

test('추가와 삭제 · 문서 처음과 끝', () => {
  for (const [a, b] of [
    ['a\nb\n', 'new\na\nb\n'],
    ['a\nb\n', 'a\nb\nnew\n'],
    ['new\na\nb\n', 'a\nb\n'],
    ['a\nb', 'a\nb\nc'],
    ['', 'x\ny\n'],
    ['x\ny\n', ''],
  ]) assert.equal(applies(a, b), b, JSON.stringify([a, b]));
});

test('공백 차이가 섞여도 적용 결과는 b 와 줄 내용이 같다', () => {
  const a = 'a\n  keep\nold\nz\n', b = 'a\nkeep  \nnew\nz\n';
  assert.deepEqual(ws(a, b), [[9, 13, 9, 13]]);
});

test('FR-CMR-57: 조각은 ruler 의 두 칸에 찍힌다 — 지운 것은 왼쪽, 더한 것은 오른쪽', () => {
  const chunks = [
    { fromA: 0, toA: 4, fromB: 0, toB: 0 },
    { fromA: 10, toA: 10, fromB: 6, toB: 12 },
    { fromA: 20, toA: 25, fromB: 20, toB: 26 },
  ];
  assert.deepEqual(plain(ctx.gitDiffRulerItems(chunks)), [
    { from: 0, to: 0, lane: 'left', color: '--diff-del' },
    { from: 6, to: 12, lane: 'right', color: '--diff-add' },
    { from: 20, to: 26, lane: 'left', color: '--diff-del' },
    { from: 20, to: 26, lane: 'right', color: '--diff-add' },
  ]);
});

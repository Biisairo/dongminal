import assert from 'node:assert/strict';
import test from 'node:test';

import { loadCM } from './cm-harness.mjs';
import { load, plain } from './harness.mjs';

/**
 * `git/diff-cm.js` `gitDiffBounded` — Diff 뷰의 diff 계산에 상한을 둔다 (이슈 3.2).
 *
 * vendor 의 글자 단위 diff 는 바뀐 글자 수에 비례해 느려지고 상한이 없다(2만 줄을 모두 고친 파일에서
 * 60초 넘게 메인 스레드를 잡았다). 줄 단위로 먼저 비교하고, 바뀐 덩어리 중 작은 것만 글자 단위로
 * 다듬는다. 글자 단위 diff(`CM.diff`)에 넘기는 입력은 예산 안이어야 한다 — 그것을 **대역으로 센다**.
 * 시간을 재지 않으므로 기계 속도와 무관하다.
 */

const REAL = await loadCM();
const BUDGET = 32000000;
let calls = [];
// 예산을 넘는 입력은 계산하지 않고 바로 실패한다 — 넘기면 시험이 수십 초 멎는다.
const spyDiff = (a, b, cfg) => {
  const n = a.length + b.length;
  calls.push(n);
  if (n * n > BUDGET) throw new Error('글자 단위 diff 에 예산을 넘는 입력: ' + n + '자');
  return REAL.diff(a, b, cfg);
};
const CM = { ...REAL, diff: spyDiff };
const ctx = load(['ui/file-editor-diff.js', 'git/diff-cm.js'], {
  expose: ['gitDiffBounded', 'gitDiffIgnoreWs'],
  globals: {
    CM,
    FileEditor: class {},
    ED_DD_ADD: 'add', ED_DD_MOD: 'mod', ED_DD_DEL: 'del', ED_DD_COLOR_VAR: {},
    ED_DD_MAX_LINES: 50000, ED_DD_MAX_EDITS: 2000,
    GIT_DIFF_LINE_MAX_EDITS: 4000, GIT_DIFF_REFINE_BUDGET: BUDGET,
    GIT_DIFF_RULER_ADD: '--diff-add', GIT_DIFF_RULER_DEL: '--diff-del',
  },
});

const run = (fn, a, b) => { calls = []; return plain(fn(a, b)) };
// 변경을 a 에 적용하면 b 가 되는가 — 범위가 원문 안에 있고 겹치지 않는지도 본다.
function applies(changes, a, b) {
  let out = '', at = 0;
  for (const c of changes) {
    assert.ok(c.fromA >= at && c.fromA <= c.toA && c.toA <= a.length && c.fromB <= c.toB && c.toB <= b.length,
      '범위가 원문 밖이거나 겹친다: ' + JSON.stringify(c));
    out += a.slice(at, c.fromA) + b.slice(c.fromB, c.toB);
    at = c.toA;
  }
  return out + a.slice(at);
}
const chunks = (a, b, override) =>
  plain(REAL.Chunk.build(REAL.Text.of(a.split('\n')), REAL.Text.of(b.split('\n')), override ? { override } : {})
    .map((c) => [c.fromA, c.toA, c.fromB, c.toB]));
const lines = (n, f) => Array.from({ length: n }, (_, i) => f(i)).join('\n') + '\n';
const src = (i) => 'line ' + i + ' const value_' + i + ' = compute(' + i + ') // some comment text';

test('같은 두 글은 변경이 없다', () => {
  assert.deepEqual(run(ctx.gitDiffBounded, 'a\nb\n', 'a\nb\n'), []);
  assert.deepEqual(run(ctx.gitDiffBounded, '', ''), []);
});

test('한 줄 안의 작은 수정은 글자 단위로 다듬는다 — 기본 diff 와 같은 조각', () => {
  const a = 'one\ntwo three\nfour\n', b = 'one\ntwo 3 three\nfour\n';
  const got = run(ctx.gitDiffBounded, a, b);
  assert.deepEqual(got, plain(REAL.diff(a, b)), '줄 전체가 아니라 더한 글자만');
  assert.equal(got.length, 1);
  assert.equal(got[0].toB - got[0].fromB, 2);
  assert.equal(applies(got, a, b), b);
  assert.deepEqual(chunks(a, b, ctx.gitDiffBounded), chunks(a, b));
});

test('흩어진 평범한 수정은 기본 diff 와 같은 조각을 낸다', () => {
  const base = Array.from({ length: 3000 }, (_, i) => '  const v' + i + ' = compute(' + i + ', "text ' + i + '");');
  const mod = base.map((l, i) => (i % 10 === 3 ? l.replace('compute', 'recompute') : l));
  for (let i = 0; i < 50; i++) mod.splice(i * 50, 0, '// added ' + i);
  const a = base.join('\n'), b = mod.join('\n');
  assert.deepEqual(chunks(a, b, ctx.gitDiffBounded), chunks(a, b));
});

test('추가·삭제 · 문서 처음과 끝 · 마지막 줄 줄바꿈 없음 — 적용하면 b 다', () => {
  for (const [a, b] of [
    ['a\nb\n', 'new\na\nb\n'],
    ['a\nb\n', 'a\nb\nnew\n'],
    ['new\na\nb\n', 'a\nb\n'],
    ['a\nb', 'a\nb\nc'],
    ['a\nb\nc', 'a\nb'],
    ['a\nb', 'a\nB'],
    ['', 'x\ny\n'],
    ['x\ny\n', ''],
    ['x', 'y'],
  ]) assert.equal(applies(run(ctx.gitDiffBounded, a, b), a, b), b, JSON.stringify([a, b]));
});

test('2만 줄을 모두 고친 큰 diff: 글자 단위 diff 에 예산을 넘는 입력을 넘기지 않는다', () => {
  const a = lines(20000, src);
  const b = lines(20000, (i) => src(i).replace('compute', 'recompute').replace('comment', 'remark')) +
    lines(3000, (i) => 'added ' + i);
  const got = run(ctx.gitDiffBounded, a, b);
  assert.equal(applies(got, a, b), b);
  assert.ok(calls.reduce((s, n) => s + n * n, 0) <= BUDGET, '글자 단위 diff 의 누적 비용이 예산을 넘었다');
});

test('현실형 큰 diff(3,000줄 추가 + 흩어진 100줄 수정)는 한 덩어리로 뭉개지지 않는다', () => {
  const a = lines(20000, src);
  const b = lines(20000, (i) => (i % 200 === 199 ? src(i).replace('compute', 'recompute') : src(i))) +
    lines(3000, (i) => 'added ' + i);
  const got = run(ctx.gitDiffBounded, a, b);
  assert.equal(applies(got, a, b), b);
  const cs = chunks(a, b, ctx.gitDiffBounded);
  // 마지막 수정 줄(19,999번째)은 끝의 추가와 맞닿아 한 조각이다.
  assert.equal(cs.length, 100, '수정 100곳(마지막은 추가와 한 조각)');
});

test('줄 비교가 상한을 넘으면 공통 앞뒤를 뺀 구간 하나가 바뀐 것이다', () => {
  const a = 'head\n' + lines(5000, src) + 'tail\n';
  const b = 'head\n' + lines(5000, (i) => 'x' + src(i)) + 'tail\n';
  const got = run(ctx.gitDiffBounded, a, b);
  assert.equal(applies(got, a, b), b);
  assert.equal(got[0].fromA, 5, '공통 첫 줄은 바뀐 범위가 아니다');
  assert.equal(a.length - got[got.length - 1].toA, 5, '공통 끝 줄은 바뀐 범위가 아니다');
});

test('공백 무시 모드도 상한을 넘으면 글자 단위 diff 에 전체를 넘기지 않는다', () => {
  const a = lines(3000, src), b = lines(3000, (i) => 'y' + src(i));
  const got = run(ctx.gitDiffIgnoreWs, a, b);
  assert.equal(applies(got, a, b), b);
  assert.ok(calls.every((n) => n * n <= BUDGET));
});

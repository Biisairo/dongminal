import assert from 'node:assert/strict';
import test from 'node:test';

import { loadCM } from './cm-harness.mjs';
import { load, plain } from './harness.mjs';

/**
 * `ui/cm-marks.js` — EDITOR_LINK_LSP_SRS FR-ELS-30~36 (V-ELS-8·9).
 *
 * ruler 항목은 `{from, to, lane, color, cls}`, 미니맵 항목은 `{line, kind, color, cls}` 다.
 */

const CM = await loadCM();
const ED_MARK_COLOR = { sel: '--s', match: '--m', error: '--e', warning: '--w', cursor: '--c' };
const ctx = load(['ui/cm-marks.js'], {
  globals: { CM, ED_MARK_COLOR, ED_RULER_MATCH_MAX: 3, ED_MATCH_SEL_MAX: 200 },
  expose: ['edCmMatches', 'edCmMarkRuler', 'edCmMarkMinimap'],
});

const state = (text, ranges, extra = []) => CM.EditorState.create({
  doc: text,
  selection: CM.EditorSelection.create(ranges.map(([a, h]) => CM.EditorSelection.range(a, h))),
  extensions: [CM.EditorState.allowMultipleSelections.of(true), ...extra],
});
const ruler = (st, phase) => plain(ctx.edCmMarkRuler(st, phase));
const minimap = (st, phase) => plain(ctx.edCmMarkMinimap(st, phase));

test('FR-ELS-31: 선택 하나의 글자열을 문서 전체에서 찾고 선택 자신은 뺀다', () => {
  const st = state('ab x ab\nab', [[0, 2]]);
  assert.deepEqual(plain(ctx.edCmMatches(st)), [{ from: 5, to: 7 }, { from: 8, to: 10 }]);
});

test('FR-ELS-31: 빈 선택 · 두 범위 · 200자를 넘는 선택에는 같은 낱말이 없다', () => {
  assert.deepEqual(plain(ctx.edCmMatches(state('ab ab', [[1, 1]]))), []);
  assert.deepEqual(plain(ctx.edCmMatches(state('ab ab', [[0, 2], [3, 5]]))), []);
  const long = 'x'.repeat(201);
  assert.deepEqual(plain(ctx.edCmMatches(state(long + ' ' + long, [[0, 201]]))), []);
});

test('FR-ELS-31: 같은 낱말은 ED_RULER_MATCH_MAX 에서 자른다', () => {
  assert.equal(ctx.edCmMatches(state('a a a a a a', [[0, 1]])).length, 3);
});

test('FR-ELS-30·32: low 는 같은 낱말 → 선택(다중 포함) 순, 오른쪽 칸', () => {
  const st = state('ab ab\ncd ab', [[0, 2], [6, 8]]);
  const items = ruler(st, 'low');
  assert.deepEqual(items.map((i) => [i.from, i.to, i.lane, i.color]), [
    [0, 2, 'right', '--s'], [6, 8, 'right', '--s'],
  ], '두 범위 선택이면 같은 낱말이 없다');
  const one = ruler(state('ab ab\ncd ab', [[0, 2]]), 'low');
  assert.deepEqual(one.map((i) => [i.from, i.to, i.color]), [[3, 5, '--m'], [9, 11, '--m'], [0, 2, '--s']]);
});

test('FR-ELS-30: 빈 선택은 선택 표식이 없다', () => {
  assert.deepEqual(ruler(state('ab', [[1, 1]]), 'low'), []);
});

test('FR-ELS-30·33: high 는 진단(error·warning 만, 왼쪽) → 커서(full) 순', () => {
  const diags = [
    { from: 0, to: 1, severity: 'error', message: 'e' },
    { from: 3, to: 4, severity: 'info', message: 'i' },
    { from: 6, to: 7, severity: 'warning', message: 'w' },
  ];
  let st = state('ab\ncd\nef', [[4, 4]]);
  st = st.update(CM.setDiagnostics(st, diags)).state;
  const items = ruler(st, 'high');
  assert.deepEqual(items.map((i) => [i.from, i.lane, i.color]), [
    [0, 'left', '--e'], [6, 'left', '--w'], [4, 'full', '--c'],
  ]);
});

test('FR-ELS-34: 진단이 없으면 커서만 남는다', () => {
  assert.deepEqual(ruler(state('ab', [[1, 1]]), 'high').map((i) => i.lane), ['full']);
});

test('FR-ELS-30: 미니맵 low 는 같은 낱말 → 선택의 줄마다 mark, high 는 없다', () => {
  const st = state('ab\nx ab\nab', [[0, 2]]);
  assert.deepEqual(minimap(st, 'low').map((i) => [i.line, i.kind, i.color]), [
    [2, 'mark', '--m'], [3, 'mark', '--m'], [1, 'mark', '--s'],
  ]);
  const multi = state('a\nb\nc\nd', [[0, 5]]);
  assert.deepEqual(minimap(multi, 'low').map((i) => i.line), [1, 2, 3], '여러 줄 선택은 줄마다');
  assert.deepEqual(minimap(st, 'high'), []);
});

test('FR-ELS-31: 여러 줄 선택의 미니맵 줄도 ED_RULER_MATCH_MAX 에서 자른다', () => {
  const st = state('a\nb\nc\nd\ne', [[0, 9]]);
  assert.equal(minimap(st, 'low').length, 3);
});

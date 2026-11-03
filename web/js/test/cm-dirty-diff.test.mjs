import assert from 'node:assert/strict';
import test from 'node:test';

import { loadCM } from './cm-harness.mjs';
import { load, plain } from './harness.mjs';

/**
 * `ui/file-editor-diff.js` 의 CodeMirror 쪽 — CODEMIRROR_MIGRATION_SRS FR-CMR-40·41 / §11.3.
 *
 * 조각(`edDiffLines` 의 출력)을 줄 표식과 되돌리기 변경으로 옮기는 함수들이다. 조각의 좌표는 1-기반 줄이다.
 */

const CM = await loadCM();
const ctx = load(['ui/file-editor-diff.js'], {
  expose: ['edDdLineMarks', 'edDdRevertChange', 'edDdField'],
  globals: {
    CM,
    FileEditor: class {},
    ED_DD_ADD: 'add', ED_DD_MOD: 'mod', ED_DD_DEL: 'del', ED_DD_COLOR_VAR: {},
  },
});

const BASE = ['one', 'two', 'three', 'four', 'five'];
const doc = (lines) => CM.Text.of([...lines, '']);
const apply = (d, c) => d.replace(c.from, c.to, CM.Text.of(c.insert.split('\n'))).toString();
const ch = (type, line, count, baseStart, baseCount) => ({ type, line, count, baseStart, baseCount });

test('FR-CMR-40: 수정·추가는 줄마다 표식 하나, 삭제는 그 자리에 오게 된 줄 하나다', () => {
  const d = doc(['one', 'TWO', 'THREE', 'new', 'four', 'five']);
  assert.deepEqual(plain(ctx.edDdLineMarks(d, [ch('mod', 2, 2, 2, 2), ch('add', 4, 1, 4, 0)])),
    [{ line: 2, type: 'mod' }, { line: 3, type: 'mod' }, { line: 4, type: 'add' }]);
  assert.deepEqual(plain(ctx.edDdLineMarks(doc(['one', 'four', 'five']), [ch('del', 2, 0, 2, 2)])),
    [{ line: 2, type: 'del' }]);
});

test('표식의 줄은 문서 끝을 넘지 않는다 — 마지막 줄이 지워졌으면 마지막 줄에 붙는다', () => {
  const d = CM.Text.of(['one', 'two']);
  assert.deepEqual(plain(ctx.edDdLineMarks(d, [ch('del', 3, 0, 3, 1)])), [{ line: 2, type: 'del' }]);
  assert.deepEqual(plain(ctx.edDdLineMarks(d, [ch('add', 2, 5, 2, 0)])), [{ line: 2, type: 'add' }]);
});

test('FR-CMR-40: 표식은 편집에 맞춰 옮겨진다 — 위에 줄을 넣으면 한 줄 내려간다', () => {
  const d = doc(['one', 'TWO', 'three']);
  let st = CM.EditorState.create({ doc: d, extensions: [ctx.edDdField().field] });
  st = st.update({ effects: ctx.edDdField().set.of(ctx.edDdLineMarks(st.doc, [ch('mod', 2, 1, 2, 1)])) }).state;
  const lines = (s) => { const out = []; s.field(ctx.edDdField().field).between(0, s.doc.length, (f, _t, m) => { out.push([s.doc.lineAt(f).number, m.type]) }); return out };
  assert.deepEqual(lines(st), [[2, 'mod']]);
  st = st.update({ changes: { from: 0, insert: 'zero\n' } }).state;
  assert.deepEqual(lines(st), [[3, 'mod']]);
  // 표식 줄의 앞에 글자를 쳐도 표식은 그 줄에 남는다(늘어나지 않는다).
  st = st.update({ changes: { from: st.doc.line(3).from, insert: 'X' } }).state;
  assert.deepEqual(lines(st), [[3, 'mod']]);
});

test('FR-CMR-41 되돌리기: 수정 조각은 기준 줄로 바꾼다', () => {
  const d = doc(['one', 'two', 'THREE', 'four', 'five']);
  const c = ctx.edDdRevertChange(d, BASE, ch('mod', 3, 1, 3, 1));
  assert.equal(apply(d, c), [...BASE, ''].join('\n'));
});

test('되돌리기: 가운데 더해진 줄은 줄째 걷는다', () => {
  const d = doc(['one', 'two', 'new', 'three', 'four', 'five']);
  assert.equal(apply(d, ctx.edDdRevertChange(d, BASE, ch('add', 3, 1, 3, 0))), [...BASE, ''].join('\n'));
});

test('되돌리기: 끝에 더해진 줄은 앞 줄의 끝부터 걷는다', () => {
  const d = CM.Text.of(['one', 'two', 'x', 'y']);
  assert.equal(apply(d, ctx.edDdRevertChange(d, ['one', 'two'], ch('add', 3, 2, 3, 0))), 'one\ntwo');
});

test('되돌리기: 전부 더해진 문서는 비운다', () => {
  const d = CM.Text.of(['a', 'b']);
  assert.equal(apply(d, ctx.edDdRevertChange(d, [], ch('add', 1, 2, 1, 0))), '');
});

test('되돌리기: 지워진 줄은 그 자리에 다시 넣는다', () => {
  const d = doc(['one', 'four', 'five']);
  assert.equal(apply(d, ctx.edDdRevertChange(d, BASE, ch('del', 2, 0, 2, 2))), [...BASE, ''].join('\n'));
});

test('되돌리기: 문서 끝에서 지워진 줄은 끝에 붙인다', () => {
  const d = CM.Text.of(['one', 'two']);
  assert.equal(apply(d, ctx.edDdRevertChange(d, ['one', 'two', 'three'], ch('del', 3, 0, 3, 1))), 'one\ntwo\nthree');
});

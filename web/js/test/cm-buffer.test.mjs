import assert from 'node:assert/strict';
import test from 'node:test';

import { loadCM } from './cm-harness.mjs';
import { load } from './harness.mjs';

/**
 * `ui/cm-buffer.js` 의 `EdBuffer` — CODEMIRROR_MIGRATION_SRS FR-CMR-16·21·22·24 / §11.1.
 *
 * 칸(sink)은 `{state, dispatch, setState?}` 다. 여기서는 `EditorState` 만으로 흉내낸다 —
 * 실제 `EditorView` 도 같은 모양으로 붙는다.
 */

const CM = await loadCM();
const ctx = load(['ui/cm-buffer.js'], { globals: { CM }, expose: ['EdBuffer'] });
const { EdBuffer } = ctx;

/** `EditorState` 하나로 선 가짜 칸. 자기 편집은 버퍼로 알린다. */
function sink(buf, extra = {}) {
  const s = {
    state: CM.EditorState.create({ doc: buf.doc, extensions: [EdBuffer.HISTORY.of(CM.history())] }),
    dispatched: 0,
    dispatch(spec) {
      const tr = s.state.update(spec);
      s.state = tr.state;
      s.dispatched++;
      buf.fromSink(s, [tr]);
    },
    ...extra,
  };
  buf.attach(s);
  return s;
}

const type = (s, at, text) => s.dispatch({ changes: { from: at, insert: text }, userEvent: 'input.type' });

test('FR-CMR-21: 한 칸의 편집이 다른 칸에 전달되고 실행 취소 기록에는 들어가지 않는다', () => {
  const buf = new EdBuffer('abc\n');
  const a = sink(buf), b = sink(buf);
  type(a, 0, 'X');
  assert.equal(a.state.doc.toString(), 'Xabc\n');
  assert.equal(b.state.doc.toString(), 'Xabc\n');
  assert.equal(buf.doc.toString(), 'Xabc\n');
  assert.equal(CM.undoDepth(a.state), 1);
  assert.equal(CM.undoDepth(b.state), 0, '전달된 변경이 받은 칸의 기록에 들어갔다');
});

test('FR-CMR-21: 전달된 변경은 다시 전달되지 않는다', () => {
  const buf = new EdBuffer('');
  const a = sink(buf), b = sink(buf), c = sink(buf);
  type(a, 0, 'hi');
  assert.equal(a.dispatched, 1);
  assert.equal(b.dispatched, 1);
  assert.equal(c.dispatched, 1);
  assert.equal(buf.version, 1);
});

test('FR-CMR-22: 실행 취소는 칸마다 따로다', () => {
  const buf = new EdBuffer('');
  const a = sink(buf), b = sink(buf);
  type(a, 0, 'A');
  type(b, 1, 'B');
  assert.equal(buf.doc.toString(), 'AB');
  CM.undo({ state: b.state, dispatch: (tr) => { b.state = tr.state; buf.fromSink(b, [tr]) } });
  assert.equal(buf.doc.toString(), 'A', 'b 의 실행 취소가 a 의 편집까지 되돌렸다');
  assert.equal(a.state.doc.toString(), 'A');
});

test('version 은 변경마다 오르고 onChange 가 알린다 · 구독을 끊을 수 있다', () => {
  const buf = new EdBuffer('');
  const a = sink(buf);
  const seen = [];
  const off = buf.onChange((e) => seen.push(e.flush));
  type(a, 0, '1');
  type(a, 1, '2');
  assert.equal(buf.version, 2);
  assert.deepEqual(seen, [false, false]);
  off();
  type(a, 2, '3');
  assert.equal(seen.length, 2);
});

test('선택만 바뀐 트랜잭션은 변경이 아니다', () => {
  const buf = new EdBuffer('abc');
  const a = sink(buf);
  let n = 0;
  buf.onChange(() => n++);
  a.dispatch({ selection: { anchor: 2 } });
  assert.equal(buf.version, 0);
  assert.equal(n, 0);
});

test('FR-CMR-24: replace 는 모든 칸을 함께 바꾸고 실행 취소 기록을 끊는다', () => {
  const buf = new EdBuffer('one\n');
  const a = sink(buf), b = sink(buf);
  type(a, 0, 'X');
  const seen = [];
  buf.onChange((e) => seen.push(e.flush));
  assert.equal(buf.replace('DISK\n'), true);
  for (const s of [a, b]) {
    assert.equal(s.state.doc.toString(), 'DISK\n');
    assert.equal(CM.undoDepth(s.state), 0, '디스크 판으로 바꾼 뒤 옛 편집을 되돌릴 수 있다');
  }
  assert.deepEqual(seen, [true]);
});

test('FR-ELR-31: replace 는 칸마다의 커서를 (줄, 열) 로 남기고 사라진 줄이면 가장 가까운 자리로 접는다', () => {
  const buf = new EdBuffer('aaaa\nbbbb\ncccc\n');
  const a = sink(buf), b = sink(buf);
  a.dispatch({ selection: { anchor: 7 } });     // 2행 3열
  b.dispatch({ selection: { anchor: 12 } });    // 3행 3열
  buf.replace('AAAA\nBB\n');
  assert.equal(a.state.selection.main.head, 7, '2행은 남았으나 3열이 줄 길이(2)를 넘으면 줄 끝이다');
  // 3행은 사라지지 않았다 — 마지막 줄(빈 줄)이다. 열은 그 줄 길이(0)로 접힌다.
  assert.equal(b.state.selection.main.head, 8);
});

test('replace 는 내용이 같으면 아무것도 하지 않는다 (FR-LSP-26b)', () => {
  const buf = new EdBuffer('same\n');
  const a = sink(buf);
  type(a, 0, 'X');
  buf.replace('Xsame\n');
  assert.equal(buf.version, 1);
  assert.equal(CM.undoDepth(a.state), 1, '같은 내용인데 실행 취소 기록이 끊겼다');
});

test('replace 는 칸이 주는 스크롤 스냅숏을 되돌린다', () => {
  const buf = new EdBuffer('a\n');
  const marker = CM.StateEffect.define();
  const effects = [];
  const a = sink(buf, { scrollSnapshot: () => marker.of(1) });
  const orig = a.dispatch;
  a.dispatch = (spec) => { if (spec.effects) effects.push(spec.effects); orig(spec) };
  buf.replace('b\n');
  assert.ok(effects.some((e) => (Array.isArray(e) ? e : [e]).some((x) => x.is && x.is(marker))));
});

test('늦게 붙은 칸은 버퍼의 지금 내용을 받는다', () => {
  const buf = new EdBuffer('base');
  const a = sink(buf);
  type(a, 4, '!');
  const late = { state: CM.EditorState.create({ doc: 'stale' }), dispatch(spec) { late.state = late.state.update(spec).state } };
  buf.attach(late);
  assert.equal(late.state.doc.toString(), 'base!');
});

test('떨어진 칸에는 전달하지 않고, 떨어진 칸의 편집은 버퍼에 들어가지 않는다', () => {
  const buf = new EdBuffer('');
  const a = sink(buf), b = sink(buf);
  buf.detach(b);
  type(a, 0, 'A');
  assert.equal(b.state.doc.toString(), '');
  type(b, 0, 'B');
  assert.equal(buf.doc.toString(), 'A');
  assert.equal(buf.sinkCount, 1);
});

test('FR-CMR-16: dirty 판정은 저장한 Text 와의 비교다 — 되돌리면 깨끗하다', () => {
  const buf = new EdBuffer('x');
  const a = sink(buf);
  const saved = buf.doc;
  type(a, 1, 'y');
  assert.equal(buf.doc.eq(saved), false);
  CM.undo({ state: a.state, dispatch: (tr) => { a.state = tr.state; buf.fromSink(a, [tr]) } });
  assert.equal(buf.doc.eq(saved), true);
});

test('dispose 뒤에는 붙일 수 없고 알리지 않는다', () => {
  const buf = new EdBuffer('');
  let n = 0;
  buf.onChange(() => n++);
  buf.dispose();
  assert.equal(buf.disposed, true);
  const s = { state: CM.EditorState.create({ doc: '' }), dispatch() {} };
  assert.equal(buf.attach(s), false);
  assert.equal(buf.replace('z'), false);
  assert.equal(n, 0);
});

test('FR-RTU-42: 디스크 판으로 갈아 끼운 변경과 붙일 때 맞춘 변경에는 FLUSH 표식이 있고, 다른 칸의 편집에는 없다', () => {
  const buf = new EdBuffer('a');
  const seen = [];
  const rec = (s) => {
    const orig = s.dispatch;
    s.dispatch = (spec) => {
      const tr = s.state.update(spec);
      if (tr.docChanged) seen.push(!!tr.annotation(EdBuffer.FLUSH));
      orig(spec);
    };
    return s;
  };
  const a = sink(buf);
  rec(sink(buf));
  type(a, 1, 'b');          // 다른 칸의 편집 → 표식 없음
  buf.replace('disk');      // 디스크 판 → 표식
  const late = rec({ state: CM.EditorState.create({ doc: 'stale' }), dispatch(spec) { late.state = late.state.update(spec).state } });
  buf.attach(late);         // 붙일 때 맞춤 → 표식
  assert.deepEqual(seen, [false, true, true]);
});

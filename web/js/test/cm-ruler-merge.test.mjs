import assert from 'node:assert/strict';
import test from 'node:test';

import { loadCM } from './cm-harness.mjs';
import { load, plain } from './harness.mjs';

/**
 * PERF_OPTIMIZATION_SRS FR-SPA-5 (이슈 3.8) — 찾기 일치가 많을 때의 눈금·미니맵 표식.
 *
 * 눈금은 그린 항목(`items`, e2e 어댑터가 읽는다)을 그대로 두고, 그리기만 같은 lane·색이 잇달아 겹치는 항목을
 * 사각형 하나로 합친다(`edRulerRects`). 색은 변수마다 한 번만 읽는다. 미니맵에 넘기는 찾기 표식은 줄마다 하나다.
 */

const CM = await loadCM();

// ── 눈금 사각형 합치기 ──────────────────────────────────────────────────────

const sb = load(['ui/cm-scrollbar.js'], {
  globals: { ED_SCROLL_MIN_THUMB: 20, ED_SCROLL_W: 14 },
  expose: ['edRulerRects', 'EdCmScrollbar'],
});
const rects = (items) => plain(sb.edRulerRects(items));
const it = (y, h, color = '--a', lane = 'right') => ({ y, h, color, lane });

test('같은 lane·색이 잇달아 겹치면 사각형 하나로 합친다', () => {
  assert.deepEqual(rects([it(0, 2), it(1, 2), it(2.5, 2)]), [it(0, 4.5)]);
});

test('맞닿은 것도 합친다 · 떨어진 것은 합치지 않는다', () => {
  assert.deepEqual(rects([it(0, 2), it(2, 2), it(5, 2)]), [it(0, 4), it(5, 2)]);
});

test('색이나 lane 이 다르면 합치지 않는다', () => {
  assert.deepEqual(rects([it(0, 2), it(1, 2, '--b'), it(1, 2, '--b', 'left')]),
    [it(0, 2), it(1, 2, '--b'), it(1, 2, '--b', 'left')]);
});

test('그리는 순서를 지킨다 — 사이에 다른 색이 끼면 건너서 합치지 않는다', () => {
  assert.deepEqual(rects([it(0, 2), it(1, 2, '--cur'), it(1.5, 2)]), [it(0, 2), it(1, 2, '--cur'), it(1.5, 2)]);
});

test('전체 폭 표식도 같은 규칙이다', () => {
  assert.deepEqual(rects([it(3, 2, '--c', 'full'), it(4, 2, '--c', 'full')]), [it(3, 3, '--c', 'full')]);
});

test('일치 1만 1천 개가 0.04 px 간격이면 사각형은 현재 일치 앞·현재·뒤 셋이다', () => {
  const items = Array.from({ length: 11111 }, (_, i) => it(i * 0.04, 2, i === 5000 ? '--cur' : '--a'));
  assert.equal(rects(items).length, 3);
});

test('빈 목록은 빈 목록이다', () => {
  assert.deepEqual(rects([]), []);
});

test('paint 는 합친 사각형만 칠하고 색은 변수마다 한 번 읽는다', () => {
  const calls = { fill: [], prop: 0 };
  const ctx2d = { scale() {}, set fillStyle(v) { calls.style = v }, fillRect: (x, y, w, h) => calls.fill.push([x, y, w, h, calls.style]) };
  sb.getComputedStyle = () => ({ getPropertyValue: (k) => { calls.prop++; return ' ' + k + '-v ' } });
  const self = Object.create(sb.EdCmScrollbar.prototype);
  self.ruler = { style: {}, getContext: () => ctx2d };
  self.view = { dom: {} };
  const items = Array.from({ length: 100 }, (_, i) => it(i * 0.04, 2, i === 50 ? '--cur' : '--a'));
  self.paint(500, items);
  assert.deepEqual(plain(calls.fill), [
    [7, 0, 7, 49 * 0.04 + 2, '--a-v'], [7, 50 * 0.04, 7, 2, '--cur-v'], [7, 51 * 0.04, 7, 99 * 0.04 + 2 - 51 * 0.04, '--a-v']]);
  assert.equal(calls.prop, 2);
});

// ── 미니맵에 넘기는 찾기 표식 ────────────────────────────────────────────────

test('미니맵 찾기 표식은 줄마다 하나다 — 같은 줄이면 현재 일치가 이기고, 현재 일치를 맨 뒤에 둔다', () => {
  const ruler = CM.Facet.define();
  const mini = CM.Facet.define();
  const f = load(['ui/cm-find.js'], {
    globals: {
      CM, ED_FIND_WORD_SEPARATORS: '', ED_FIND_HIT_CUR_CLASS: 'cur', ED_FIND_MARK_COLOR: '--a', ED_FIND_MARK_COLOR_CUR: '--cur',
      edRulerSource: () => ruler, edMinimapSource: () => mini,
    },
    expose: ['edFindMarks', 'edFindSources'],
  });
  const doc = 'aa aa\nxx\naa\naa aa aa';
  let st = CM.EditorState.create({ doc, extensions: [f.edFindMarks().field, f.edFindSources()] });
  const hit = CM.Decoration.mark({ class: 'hit' });
  const cur = CM.Decoration.mark({ class: 'hit cur' });
  const b = new CM.RangeSetBuilder();
  // 1줄 둘 · 3줄 하나 · 4줄 셋(가운데가 현재 일치)
  [[0, 2, hit], [3, 5, hit], [9, 11, hit], [12, 14, hit], [15, 17, cur], [18, 20, hit]].forEach(([a, z, d]) => b.add(a, z, d));
  st = st.update({ effects: f.edFindMarks().set.of(b.finish()) }).state;

  const marks = st.facet(mini).flatMap((src) => src(st));
  assert.deepEqual(plain(marks).map((m) => [m.line, m.color]), [[1, '--a'], [3, '--a'], [4, '--cur']]);
  const rulerItems = st.facet(ruler).flatMap((src) => src(st));
  assert.equal(rulerItems.length, 6, '눈금 항목은 일치마다 하나 그대로다 — e2e 어댑터가 일치마다 찾는다');
});

import assert from 'node:assert/strict';
import test from 'node:test';

import { loadCM } from './cm-harness.mjs';

/**
 * 미니맵 포크(scripts/codemirror/minimap)의 줄 단위 계산 — perf 3.7.
 *
 * 큰 문서를 열 때 모든 줄을 한 번에 훑지 않도록 줄의 span 은 그 줄을 그릴 때 만들고(`minimapLineSpans`),
 * 칸 수는 구간을 나눠 센다(`minimapLineColumns`). 어느 쪽이든 결과는 원본의 한 번 훑기와 같아야 한다.
 */

const CM = await loadCM();

// 원본(@replit/codemirror-minimap 0.5.2)의 `updateMapImpl` — 문서 전체를 차례로 훑는다. 비교 기준이다.
function referenceSpans(docText, lines, highlights) {
  const out = [];
  const it = highlights.values();
  let ptr = it.next();
  for (const line of lines) {
    const spans = [];
    for (const span of line) {
      if (span.from === span.to) continue;
      if (span.folded) { spans.push({ text: '…', tags: '' }); continue }
      let position = span.from;
      while (!ptr.done && ptr.value.from < span.to) {
        const { from, to, tags } = ptr.value;
        if (to < position) { ptr = it.next(); continue }
        if (from > position) spans.push({ text: docText.slice(position, from), tags: '' });
        const start = Math.max(from, span.from);
        const end = Math.min(to, span.to);
        spans.push({ text: docText.slice(start, end), tags });
        position = end;
        if (to > end) break;
        ptr = it.next();
      }
      if (position !== span.to) spans.push({ text: docText.slice(position, span.to), tags: '' });
    }
    out.push(spans);
  }
  return out;
}

// 접힘이 없는 줄 배치 — 원본 `computeLinesState` 의 접힘 없는 경우와 같다.
function plainLines(doc) {
  const lines = [];
  for (let n = 1; n <= doc.lines; n++) {
    const l = doc.line(n);
    lines.push([{ from: l.from, to: l.to, folded: false }]);
  }
  return lines;
}

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

// 겹치지 않고 차례대로인 강조 — `highlightTree` 가 내는 모양. 줄을 넘는 것도 섞는다.
function randomHighlights(len, rand) {
  const out = [];
  let pos = 0;
  while (pos < len) {
    pos += Math.floor(rand() * 6);
    if (pos >= len) break;
    const to = Math.min(len, pos + 1 + Math.floor(rand() * (rand() < 0.1 ? 40 : 6)));
    out.push({ from: pos, to, tags: 't' + Math.floor(rand() * 4) });
    pos = to;
  }
  return out;
}

const WORDS = ['a', 'bc', '\t', '한글', 'x y', '', '  ', 'fn()', '😀'];

function randomDoc(rand, n) {
  const lines = [];
  for (let i = 0; i < n; i++) {
    const k = Math.floor(rand() * 5);
    let s = '';
    for (let j = 0; j < k; j++) s += WORDS[Math.floor(rand() * WORDS.length)];
    lines.push(s);
  }
  return CM.Text.of(lines);
}

function lazyAll(doc, lines, highlights, order) {
  const out = new Array(lines.length);
  for (const i of order) out[i] = CM.minimapLineSpans(doc, lines, highlights, i);
  return out;
}

test('3.7: 줄 span 을 그 줄만 따로 만들어도 원본의 한 번 훑기와 같다 — 무작위 문서·강조, 어느 차례로 물어도', () => {
  const rand = rng(37);
  for (let round = 0; round < 60; round++) {
    const doc = randomDoc(rand, 1 + Math.floor(rand() * 40));
    const lines = plainLines(doc);
    const hs = randomHighlights(doc.length, rand);
    const want = referenceSpans(doc.toString(), lines, hs);
    const order = lines.map((_, i) => i).sort(() => rand() - 0.5);
    assert.deepEqual(lazyAll(doc, lines, hs, order), want, `round ${round}`);
  }
});

test('3.7: 강조가 없거나 일부 구간에만 있어도 같다 (열자마자 보이는 줄만 강조한 상태)', () => {
  const doc = CM.Text.of(['const a = 1', '', 'let b', '// c']);
  const lines = plainLines(doc);
  for (const hs of [[], [{ from: 13, to: 16, tags: 'k' }], [{ from: 6, to: 14, tags: 'k' }]]) {
    assert.deepEqual(lazyAll(doc, lines, hs, [3, 0, 2, 1]), referenceSpans(doc.toString(), lines, hs));
  }
});

test('3.7: 접힌 구간 — 줄 끝에서 접힘·다음 줄 안에서 끝나는 접힘·문서 첫머리의 접힘도 원본과 같다', () => {
  // 문서: "ab{\ncd\nef}gh\nij\n" — 줄 시작 0, 4, 7, 13
  const hs = [
    { from: 0, to: 2, tags: 'a' }, { from: 2, to: 3, tags: 'p' }, { from: 4, to: 6, tags: 'c' },
    { from: 9, to: 10, tags: 'p' }, { from: 10, to: 12, tags: 'g' }, { from: 12, to: 14, tags: 'i' },
  ];
  const doc2 = CM.Text.of(['ab{', 'cd', 'ef}gh', 'ij', '']);
  // 3..9 를 접었다: 1·2·3 번째 줄이 한 항목이 된다 (원본 computeLinesState 의 모양).
  const folded = [
    [{ from: 0, to: 3, folded: false }, { from: 3, to: 9, folded: true }, { from: 9, to: 12, folded: false }],
    [{ from: 13, to: 15, folded: false }],
  ];
  assert.deepEqual(lazyAll(doc2, folded, hs, [1, 0]), referenceSpans(doc2.toString(), folded, hs));
  // 문서 첫머리부터 접혔다: 첫 항목이 접힌 span 으로 시작한다.
  const head = [[{ from: 0, to: 5, folded: true }, { from: 5, to: 6, folded: false }], [{ from: 7, to: 12, folded: false }], [{ from: 13, to: 15, folded: false }]];
  assert.deepEqual(lazyAll(doc2, head, hs, [2, 1, 0]), referenceSpans(doc2.toString(), head, hs));
});

test('3.7: 칸 수를 구간으로 나눠 세도 한 번에 센 것과 같다 — 탭·넓은 글자·접힘', () => {
  const rand = rng(7);
  const doc = randomDoc(rand, 300);
  const state = CM.EditorState.create({ doc, extensions: [CM.EditorState.tabSize.of(4)] });
  const lines = plainLines(doc);
  lines[5] = [{ from: lines[5][0].from, to: lines[5][0].to, folded: true }];
  const whole = CM.minimapLineColumns(state, lines, new Int32Array(lines.length), 0, lines.length);
  const parts = new Int32Array(lines.length);
  for (let i = 0; i < lines.length; i += 17) CM.minimapLineColumns(state, lines, parts, i, Math.min(lines.length, i + 17));
  assert.deepEqual([...parts], [...whole]);
  assert.equal(whole[5], 1, '접힌 구간은 1칸');
  const t = CM.Text.of(['\tx', '한a']);
  const st = CM.EditorState.create({ doc: t, extensions: [CM.EditorState.tabSize.of(4)] });
  assert.deepEqual([...CM.minimapLineColumns(st, plainLines(t), new Int32Array(2), 0, 2)], [5, 3]);
});

test('3.7: 칸 수 세기는 받은 구간 밖을 건드리지 않는다', () => {
  const doc = CM.Text.of(['aaaa', 'bb', 'c']);
  const state = CM.EditorState.create({ doc });
  const out = new Int32Array([-1, -1, -1]);
  CM.minimapLineColumns(state, plainLines(doc), out, 1, 2);
  assert.deepEqual([...out], [-1, 2, -1]);
});

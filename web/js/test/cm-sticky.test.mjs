import assert from 'node:assert/strict';
import test from 'node:test';

import { loadCM } from './cm-harness.mjs';
import { load } from './harness.mjs';

/**
 * `ui/cm-sticky.js` — CODEMIRROR_MIGRATION_SRS FR-CMR-80·81 / §11.5.
 *
 * `edStickyLines(state, line, max)` 는 줄 `line` 을 감싸는 범위의 첫 줄 번호들이다. 바깥 먼저, 최대 `max`.
 * 구문 트리를 주는 언어는 트리로, legacy-modes 와 언어 없는 파일은 들여쓰기로 정한다.
 */

const CM = await loadCM();
const ctx = load(['ui/cm-sticky.js'], { expose: ['edStickyLines'], globals: { CM } });

const langOf = async (name) => (await CM.languages.find((l) => l.name === name).load());
const JS = await langOf('JavaScript');
const SH = await langOf('Shell');

const stateOf = (doc, lang) => {
  const st = CM.EditorState.create({ doc, extensions: lang ? [lang] : [] });
  CM.ensureSyntaxTree(st, st.doc.length, 5000);
  return st;
};
const sticky = (st, line, max = 5) => [...ctx.edStickyLines(st, line, max)];

const NESTED3 = [
  'class A {',        // 1
  '  m() {',          // 2
  '    if (x) {',     // 3
  '      a();',       // 4
  '      b();',       // 5
  '    }',            // 6
  '  }',              // 7
  '}',                // 8
  'const z = 1;',     // 9
].join('\n');

test('FR-CMR-80·81: 중첩 3단계 — 바깥 범위가 먼저다', () => {
  const st = stateOf(NESTED3, JS);
  assert.deepEqual(sticky(st, 4), [1, 2, 3]);
  assert.deepEqual(sticky(st, 5), [1, 2, 3]);
});

test('FR-CMR-80: 맨 위 줄 자신은 고정하지 않는다', () => {
  const st = stateOf(NESTED3, JS);
  assert.deepEqual(sticky(st, 3), [1, 2]);
  assert.deepEqual(sticky(st, 1), []);
});

test('범위를 닫는 줄은 아직 그 범위 안이다 · 범위 밖의 줄은 고정할 것이 없다', () => {
  const st = stateOf(NESTED3, JS);
  assert.deepEqual(sticky(st, 6), [1, 2, 3]);
  assert.deepEqual(sticky(st, 9), []);
});

test('FR-CMR-80: 5단계를 넘으면 바깥 5줄이다', () => {
  const lines = [];
  for (let i = 0; i < 7; i++) lines.push('  '.repeat(i) + `function f${i}() {`);
  lines.push('  '.repeat(7) + 'x();');
  for (let i = 6; i >= 0; i--) lines.push('  '.repeat(i) + '}');
  const st = stateOf(lines.join('\n'), JS);
  assert.deepEqual(sticky(st, 8), [1, 2, 3, 4, 5]);
  assert.deepEqual(sticky(st, 8, 2), [1, 2]);
});

test('FR-CMR-81: 구문 트리가 있으면 들여쓰기가 아니라 트리를 따른다', () => {
  const st = stateOf('function f() {\nx();\n}\n', JS);
  assert.deepEqual(sticky(st, 2), [1]);
});

test('FR-CMR-81: legacy-modes 는 들여쓰기로 정한다 · 빈 줄은 그 아래 첫 글자 줄을 본다', () => {
  const doc = [
    'if true; then',        // 1
    '  for x in a; do',     // 2
    '    echo $x',          // 3
    '',                     // 4
    '    echo y',           // 5
    '  done',               // 6
    'fi',                   // 7
  ].join('\n');
  const st = stateOf(doc, SH);
  assert.ok(st.facet(CM.language) instanceof CM.StreamLanguage, 'Shell 이 legacy-modes 가 아니면 이 검사의 전제가 깨진다');
  assert.deepEqual(sticky(st, 3), [1, 2]);
  assert.deepEqual(sticky(st, 4), [1, 2]);
  assert.deepEqual(sticky(st, 6), [1]);
  assert.deepEqual(sticky(st, 7), []);
});

test('FR-CMR-81: 언어가 없는 파일도 들여쓰기로 정한다 · 탭은 tabSize 칸이다', () => {
  const st = stateOf('a:\n\tb:\n\t\tc\n    d\n', null);
  assert.deepEqual(sticky(st, 3), [1, 2]);
  assert.deepEqual(sticky(st, 4), [1], '네 칸 공백은 탭 하나와 같은 깊이다');
});

test('빈 문서 · 끝까지 빈 줄 · 들여쓰기 없는 줄은 고정할 것이 없다', () => {
  assert.deepEqual(sticky(stateOf('', null), 1), []);
  assert.deepEqual(sticky(stateOf('a\n  b\n\n\n', null), 4), []);
  assert.deepEqual(sticky(stateOf('a\nb\nc\n', null), 3), []);
});

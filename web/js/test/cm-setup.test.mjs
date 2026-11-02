import assert from 'node:assert/strict';
import test from 'node:test';

import { loadCM } from './cm-harness.mjs';
import { load, plain } from './harness.mjs';

/**
 * `ui/cm-setup.js` 의 순수 부분 — 좌표 변환과 언어 대응 (CODEMIRROR_MIGRATION_SRS FR-CMR-13·14).
 */

const CM = await loadCM();
const ctx = load(['core/path.js', 'ui/cm-setup.js'], {
  globals: { CM },
  expose: ['CM_LANG', 'edCmLangName', 'edCmPos', 'edCmLineCol'],
});
const doc = CM.Text.of(['ab', 'cdef', '']);

test('edCmPos: (줄, 열) 1 부터 → offset', () => {
  assert.equal(ctx.edCmPos(doc, 1, 1), 0);
  assert.equal(ctx.edCmPos(doc, 2, 3), 5);
  assert.equal(ctx.edCmPos(doc, 3, 1), 8);
});

test('edCmPos: 범위 밖은 문서 안으로 접는다', () => {
  assert.equal(ctx.edCmPos(doc, 0, 0), 0);
  assert.equal(ctx.edCmPos(doc, 2, 99), 7, '열이 줄 끝을 넘으면 줄 끝');
  assert.equal(ctx.edCmPos(doc, 99, 1), 8, '줄이 문서 끝을 넘으면 마지막 줄');
  assert.equal(ctx.edCmPos(doc, NaN, NaN), 0);
});

test('edCmLineCol: offset → (줄, 열) 1 부터 · 범위 밖은 접는다', () => {
  assert.deepEqual(plain(ctx.edCmLineCol(doc, 0)), { line: 1, col: 1 });
  assert.deepEqual(plain(ctx.edCmLineCol(doc, 5)), { line: 2, col: 3 });
  assert.deepEqual(plain(ctx.edCmLineCol(doc, 999)), { line: 3, col: 1 });
  assert.deepEqual(plain(ctx.edCmLineCol(doc, -4)), { line: 1, col: 1 });
});

test('FR-CMR-13: 대응표의 언어 이름은 전부 language-data 에 있다', () => {
  const names = new Set(CM.languages.map((l) => l.name));
  const missing = [...new Set(Object.values(ctx.CM_LANG))].filter((n) => !names.has(n));
  assert.deepEqual(missing, []);
});

test('FR-CMR-13: 경로 → 언어 이름 (확장자 · 이중 확장자 없음 · 대소문자 · 특수 파일명)', () => {
  const at = (p) => ctx.edCmLangName(p);
  assert.equal(at('/a/b/main.go'), 'Go');
  assert.equal(at('/a/App.TSX'), 'TSX');
  assert.equal(at('/a/x.jsonc'), 'JSON');
  assert.equal(at('/a/Dockerfile'), 'Dockerfile');
  assert.equal(at('/a/settings.conf'), 'Properties files');
  assert.equal(at('/a/no-ext'), null);
});

test('FR-CMR-14: Makefile · Bat · VimL 은 일반 텍스트다', () => {
  for (const p of ['/a/Makefile', '/a/x.mk', '/a/run.bat', '/a/run.cmd', '/a/.vimrc.vim']) {
    assert.equal(ctx.edCmLangName(p), null, p);
  }
});

test('CM 이 실리기 전에 읽어도 터지지 않는다 — 페이지 로드 시점 (§11.1)', () => {
  assert.doesNotThrow(() => load(['core/path.js', 'ui/cm-buffer.js', 'ui/cm-find.js', 'ui/cm-setup.js']));
});

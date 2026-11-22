import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import * as espree from 'espree';

/**
 * REFACTOR3_FE_REST5_SRS TC-FR5-11: 100줄 넘는 함수가 없다.
 *
 * `method-size.test.mjs` 는 나눈 함수 몇을 이름으로 지키고 주석을 뺀 코드 줄을 잰다. 이 검사는 **모든 함수**를
 * 주석·빈 줄까지 넣은 줄 수로 잰다 — 즉시 실행 함수·팩토리 안의 이름 없는 클래스처럼 이름으로 찾을 수 없는 자리가
 * 다시 불지 않게 하는 것이다. 세지 않는 디렉터리는 `check-file-size.mjs` 와 같다(vendor·test·i18n).
 *
 * 나누기 전(HEAD `90ee3429`): `diag.js` 익명 338 · `version-watch.js` 익명 126 · `edCmStickyPlugin` 119 ·
 * `edCmScrollbarPlugin` 118 · `_makeTab` 109 · `edLspWorkspaceClass` 108 · `FileTree` constructor 104 · `_renderThemePanel` 100.
 */
const JS = join(dirname(fileURLToPath(import.meta.url)), '..');
const MAX = 100;
const SKIP = new Set(['vendor', 'test', 'i18n']);

/** 아직 남은 것 — 줄이면 여기서 지운다. 늘리지 않는다. */
const LEFT = new Map([
  ['ui/file-tree.js constructor', 'R5d 가 부품 조립으로 다시 쓴다 (D-FR5-3)'],
]);

function walk(d, out = []) {
  for (const e of readdirSync(d)) {
    const p = join(d, e);
    if (statSync(p).isDirectory()) { if (!SKIP.has(e)) walk(p, out); continue; }
    if (e.endsWith('.js')) out.push(p);
  }
  return out;
}

function nameOf(n, parent) {
  if (n.id && n.id.name) return n.id.name;
  if (!parent) return '(anon)';
  if ((parent.type === 'MethodDefinition' || parent.type === 'Property') && parent.key) return parent.key.name || parent.key.value;
  if (parent.type === 'VariableDeclarator' && parent.id) return parent.id.name;
  return '(anon)';
}

function longFunctions(file) {
  const src = readFileSync(file, 'utf8');
  const ast = espree.parse(src, { ecmaVersion: 'latest', sourceType: 'script', loc: true });
  const out = [];
  const visit = (n, parent) => {
    if (!n || typeof n.type !== 'string') return;
    if (/Function/.test(n.type)) {
      const lines = n.loc.end.line - n.loc.start.line + 1;
      if (lines > MAX) out.push({ name: nameOf(n, parent), line: n.loc.start.line, lines });
    }
    for (const k of Object.keys(n)) {
      if (k === 'loc' || k === 'range') continue;
      const v = n[k];
      if (Array.isArray(v)) v.forEach((c) => visit(c, n));
      else if (v && typeof v.type === 'string') visit(v, n);
    }
  };
  visit(ast, null);
  return out;
}

test('TC-FR5-11: 100줄 넘는 함수가 없다 (남김 목록 밖)', () => {
  const files = walk(JS);
  assert.ok(files.length > 100, `파일을 ${files.length}개밖에 못 읽었다 — 검사가 공회전한다`);
  const bad = [];
  const left = new Set();
  for (const f of files) {
    const rel = relative(JS, f);
    for (const fn of longFunctions(f)) {
      const key = rel + ' ' + fn.name;
      if (LEFT.has(key)) { left.add(key); continue; }
      bad.push(`${rel}:${fn.line} ${fn.name} ${fn.lines}줄`);
    }
  }
  assert.deepEqual(bad, [], '100줄 넘는 함수');
  const stale = [...LEFT.keys()].filter((k) => !left.has(k));
  assert.deepEqual(stale, [], '남김 목록에 이제 100줄 이하인 함수가 있다 — 목록에서 지운다');
});

/**
 * 지연 묶음 경계 검사기 (PERF M3 §3.4 · D-30·D-32).
 *
 * ## 왜 있는가
 *
 * 화면 묶음(`web/bundles.txt` 에 있지만 index.html 이 싣지 않는 묶음)은 `Screens.load` 가
 * 부를 때 실린다. 부팅 묶음 코드가 그 전에 화면 묶음의 전역(클래스·함수·상수)을 읽으면
 * 런타임에서, 그 경로가 돌 때만 `ReferenceError` 가 난다. `no-undef` 는 트리 전체의 전역을
 * 보므로 이것을 잡지 못한다 (`check-load-order.mjs` 머리말의 같은 함정).
 *
 * ## 무엇을 잡는가
 *
 * 페이지가 싣는 파일(부팅)이 화면 묶음 파일의 최상위 선언 이름을 참조하면 실패한다.
 * 로드 시점이든 함수 안이든 같다. 예외는 진입점 둘뿐이다.
 *
 *   1. 같은 함수에서 앞서 `await Screens.load(…)` 를 기다린 뒤의 참조
 *   2. `scripts/lazy-entries.txt` 에 적힌 함수(안의 클로저 포함). 그 함수는 `Screens.load`·
 *      `Screens.ready` 를 불러야 한다 — 렌더러처럼 동기로 남는 자리가 이것을 쓴다
 *
 * `typeof X` 는 던지지 않으므로 참조로 보지 않는다. 지역 이름은 `eslint-scope` 가 가른다.
 *
 * ## 무엇을 잡지 않는가
 *
 * `Screens.load(name)` 의 이름이 그 전역이 든 묶음인지는 보지 않는다(이름→묶음은 실행 때
 * 등록된다). 화면 묶음끼리의 참조도 보지 않는다.
 *
 * 사용: node scripts/check-lazy-boundary.mjs [저장소 뿌리]
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as eslintScope from 'eslint-scope';
import * as espree from 'espree';

import { pageScripts, readBundles } from './bundles-def.mjs';

const ROOT = process.argv[2] || join(dirname(fileURLToPath(import.meta.url)), '..');
const ENTRIES = 'scripts/lazy-entries.txt';
const PARSE = { ecmaVersion: 2022, sourceType: 'script', loc: true, range: true };
const FN = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']);

function parse(rel) {
  const src = readFileSync(join(ROOT, 'web', rel), 'utf8');
  return { src, ast: espree.parse(src, PARSE) };
}

function topNames(ast) {
  const names = new Set();
  const bind = (id) => {
    if (!id) return;
    if (id.type === 'Identifier') names.add(id.name);
    else if (id.type === 'ObjectPattern') for (const p of id.properties) bind(p.value || p.argument);
    else if (id.type === 'ArrayPattern') for (const e of id.elements) bind(e);
    else if (id.type === 'AssignmentPattern') bind(id.left);
    else if (id.type === 'RestElement') bind(id.argument);
  };
  for (const n of ast.body) {
    if (n.type === 'VariableDeclaration') for (const d of n.declarations) bind(d.id);
    else if (n.type === 'FunctionDeclaration' || n.type === 'ClassDeclaration') bind(n.id);
  }
  return names;
}

function parents(ast) {
  const up = new Map();
  const walk = (n) => {
    for (const k of Object.keys(n)) {
      if (k === 'loc' || k === 'range') continue;
      for (const c of [n[k]].flat()) {
        if (c && typeof c.type === 'string') { up.set(c, n); walk(c); }
      }
    }
  };
  walk(ast);
  return up;
}

const isScreensCall = (n, method) => n.type === 'CallExpression' && n.callee.type === 'MemberExpression' &&
  !n.callee.computed && n.callee.object.type === 'Identifier' && n.callee.object.name === 'Screens' &&
  n.callee.property.name === method;

/** 함수 본문(안쪽 함수 제외)의 `await Screens.load(…)` 끝 위치들. */
function awaitedLoads(fn) {
  const ends = [];
  const walk = (n) => {
    if (n !== fn && FN.has(n.type)) return;
    if (n.type === 'AwaitExpression' && isScreensCall(n.argument, 'load')) ends.push(n.range[1]);
    for (const k of Object.keys(n)) {
      if (k === 'loc' || k === 'range') continue;
      for (const c of [n[k]].flat()) if (c && typeof c.type === 'string') walk(c);
    }
  };
  walk(fn);
  return ends;
}

function asksScreens(fn) {
  let hit = false;
  const walk = (n) => {
    if (hit) return;
    if (isScreensCall(n, 'load') || isScreensCall(n, 'ready')) { hit = true; return; }
    for (const k of Object.keys(n)) {
      if (k === 'loc' || k === 'range') continue;
      for (const c of [n[k]].flat()) if (c && typeof c.type === 'string') walk(c);
    }
  };
  walk(fn.body);
  return hit;
}

/** 함수 노드의 이름: `f`, `Class.method`, `a.b.c = function`, `Object.assign(X.prototype, {m})` 의 `X.prototype.m`. 이름이 없으면 null. */
function fnName(fn, up, src) {
  if (fn.type === 'FunctionDeclaration' && fn.id) return fn.id.name;
  const p = up.get(fn);
  if (!p) return null;
  if (p.type === 'MethodDefinition' && !p.computed) {
    const cls = up.get(up.get(p));
    return cls && cls.id ? `${cls.id.name}.${p.key.name}` : null;
  }
  if (p.type === 'VariableDeclarator' && p.id.type === 'Identifier') return p.id.name;
  if (p.type === 'AssignmentExpression' && p.left.type === 'MemberExpression') return src.slice(...p.left.range);
  // `Object.assign(X.prototype, { m(){…} })` — 렌더러 같은 증강 파일의 메서드다. 이름은 `X.prototype.m`.
  if (p.type === 'Property' && !p.computed && p.key.type === 'Identifier') {
    const call = up.get(up.get(p));
    const c = call && call.type === 'CallExpression' ? call.callee : null;
    if (c && c.type === 'MemberExpression' && !c.computed && c.object.type === 'Identifier' && c.object.name === 'Object' &&
      c.property.name === 'assign' && call.arguments.length > 1) return `${src.slice(...call.arguments[0].range)}.${p.key.name}`;
  }
  return null;
}

function readEntries() {
  let text = '';
  try { text = readFileSync(join(ROOT, ENTRIES), 'utf8') } catch { return [] }
  return text.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
    .map((l) => { const [file, name] = l.split(/\s+/); return { file, name }; });
}

const defs = readBundles(ROOT);
const boot = pageScripts(readFileSync(join(ROOT, 'web', 'index.html'), 'utf8'), defs);
const bootSet = new Set(boot);

const screenGlobals = new Map();
let screenBundles = 0;
for (const [bundle, { js }] of defs) {
  if (js.every((f) => bootSet.has(f))) continue;
  screenBundles++;
  for (const file of js) for (const name of topNames(parse(file).ast)) screenGlobals.set(name, { bundle, file });
}

const entries = readEntries();
const bad = [];
const badEntries = [];

for (const file of boot) {
  const { src, ast } = parse(file);
  const own = topNames(ast);
  const up = parents(ast);
  const fns = new Map();
  for (const [n] of up) if (FN.has(n.type)) {
    const name = fnName(n, up, src);
    if (name) fns.set(name, n);
  }
  const allowed = new Set();
  for (const e of entries.filter((x) => x.file === file)) {
    const fn = fns.get(e.name);
    if (!fn) badEntries.push(`${e.file} ${e.name} — 그런 함수가 없다`);
    else if (!asksScreens(fn)) badEntries.push(`${e.file} ${e.name} — Screens.load·Screens.ready 를 부르지 않는다`);
    else allowed.add(fn);
  }

  const sm = eslintScope.analyze(ast, { ecmaVersion: 2022, sourceType: 'script' });
  for (const ref of sm.globalScope.through) {
    const id = ref.identifier;
    const hit = screenGlobals.get(id.name);
    if (!hit || own.has(id.name)) continue;
    const p = up.get(id);
    if (p && p.type === 'UnaryExpression' && p.operator === 'typeof') continue;
    let ok = false;
    for (let s = ref.from; s && !ok; s = s.upper) {
      if (!FN.has(s.block.type)) continue;
      ok = allowed.has(s.block) || awaitedLoads(s.block).some((end) => end <= id.range[0]);
    }
    if (!ok) bad.push(`  ${file}:${id.loc.start.line}  ${id.name} ← [${hit.bundle}] ${hit.file}`);
  }
}
for (const e of entries) if (!bootSet.has(e.file)) badEntries.push(`${e.file} ${e.name} — 부팅 파일이 아니다`);

if (badEntries.length) {
  console.error(`${ENTRIES} 의 진입점이 틀렸습니다 (${badEntries.length}건):`);
  for (const b of badEntries) console.error(`  ${b}`);
}
if (bad.length) {
  console.error(`지연 묶음 경계 위반 (${bad.length}건) — 부팅 코드가 아직 실리지 않았을 화면 묶음의 전역을 읽습니다:`);
  for (const b of bad) console.error(b);
  console.error('');
  console.error("  그 함수에서 먼저 `await Screens.load('<화면>')` 를 기다리거나, 동기로 남아야 하는 자리면");
  console.error(`  Screens.ready 로 가린 뒤 ${ENTRIES} 에 진입점으로 적으세요.`);
}
if (bad.length || badEntries.length) process.exit(1);

console.log(`lazy-boundary ok — 부팅 파일 ${boot.length}개 · 화면 묶음 ${screenBundles}개(전역 ${screenGlobals.size}개) · 진입점 ${entries.length}개`);

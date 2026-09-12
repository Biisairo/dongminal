/**
 * 로드 순서 검사기 (M6 `FE-3` · `02-fe-arch.md`).
 *
 * ## 왜 있는가
 *
 * `web/index.html` 이 클래식 `<script>` 90여 개를 순서대로 싣고, 파일들은 전역
 * `class`/`function`/`const` 로 서로를 본다 (`type="module"` 0). 그 순서는
 * **암묵적이다** — 어디에도 적혀 있지 않고, 지키는 것도 없다.
 *
 * `02 FE-3` 이 그 대가를 적었다: **스크립트 한 줄을 옮기면 조용히
 * `ReferenceError` 가 난다.** 그것도 런타임에, 그 경로가 실행될 때만.
 *
 * `eslint` 의 `no-undef` 는 이것을 잡지 못한다 — 그 규칙이 보는 전역 목록은
 * `eslint.config.mjs` 가 **트리 전체**에서 뽑으므로 "나중에 로드되는 파일이
 * 선언한다" 와 "지금 선언돼 있다" 를 구분하지 않는다.
 *
 * ## 무엇을 잡는가
 *
 * **로드 시점에 실행되는 코드**만 본다. 그것만이 TDZ 오류를 낼 수 있기 때문이다.
 *
 *   const A = LATER_CONST;        ← 잡는다. 로드하다 죽는다
 *   function f(){ return LATER }  ← 잡지 않는다. f 를 부를 때는 이미 서 있다
 *
 * 함수·클래스 **본문 안**은 건너뛴다. 그 안의 코드는 나중에 불리고, 그때는 모든
 * 스크립트가 로드를 마쳤다.
 *
 * ## 무엇을 잡지 않는가
 *
 * 로드 시점에 **불리는** 함수 안은 여전히 사각지대다 (`main.js` 의 부팅 경로).
 * 그것을 쫓으려면 호출 그래프가 필요하고, 이 검사의 값은 싼 것을 확실히 잡는
 * 데 있다 — `no-undef` 가 이름의 존재를 이미 보장하므로, 여기가 더하는 것은
 * **시각**뿐이다.
 *
 * 사용: node scripts/check-load-order.mjs
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as espree from 'espree';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const INDEX = join(ROOT, 'web', 'index.html');

/** `index.html` 이 싣는 순서. 이 배열의 인덱스가 곧 "언제 선다" 이다. */
function loadOrder() {
  const html = readFileSync(INDEX, 'utf8');
  const out = [];
  for (const m of html.matchAll(/<script\s+src="(js\/[^"?]+)/g)) out.push('web/' + m[1]);
  return out;
}

const PARSE = { ecmaVersion: 2022, sourceType: 'script', loc: true };

/**
 * 최상위 선언 이름들. `var`·함수 선언은 호이스팅되므로 **순서를 타지 않는다** —
 * 그래도 목록에 넣는다: 잡으려는 것은 TDZ 이고, 호이스팅되는 것은 애초에 문제가
 * 아니므로 "이미 있는 것" 쪽에 두면 거짓 양성이 줄어든다.
 */
function declaredIn(ast) {
  const names = new Set();
  const bind = (id) => {
    if (!id) return;
    if (id.type === 'Identifier') names.add(id.name);
    else if (id.type === 'ObjectPattern') for (const p of id.properties) bind(p.value || p.argument);
    else if (id.type === 'ArrayPattern') for (const e of id.elements) if (e) bind(e);
    else if (id.type === 'AssignmentPattern') bind(id.left);
    else if (id.type === 'RestElement') bind(id.argument);
  };
  for (const n of ast.body) {
    if (n.type === 'VariableDeclaration') for (const d of n.declarations) bind(d.id);
    else if (n.type === 'FunctionDeclaration' || n.type === 'ClassDeclaration') bind(n.id);
  }
  return names;
}

const SKIP_BODY = new Set([
  'FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression',
  // 클래스 메서드의 본문도 나중에 돈다. 다만 `extends` 절과 필드 초기화식은
  // **클래스가 평가될 때** 도므로 건너뛰지 않는다 — 아래에서 그것만 따로 본다.
  'MethodDefinition',
]);

/**
 * 로드 시점에 **실제로 읽히는** 식별자를 모은다.
 *
 * 함수 본문에 들어가지 않는다. 지역 스코프를 추적하지 않는 대신, 잡은 이름이
 * 파일 자신의 최상위 선언이거나 전역이면 넘긴다 — 이 검사가 답하는 물음은
 * "그 이름이 있는가" 가 아니라 **"그때 이미 서 있는가"** 다.
 */
function loadTimeRefs(ast) {
  const refs = [];
  const walk = (n, parent) => {
    if (!n || typeof n.type !== 'string') return;
    if (SKIP_BODY.has(n.type)) {
      // 기본값 식(`function f(a = SOME_CONST)`)은 호출 시점에 돈다 — 함께 건너뛴다.
      return;
    }
    if (n.type === 'PropertyDefinition' && !n.static) {
      // 인스턴스 필드는 생성 시점에 돈다. 로드 시점이 아니다.
      return;
    }
    if (n.type === 'Identifier') {
      // 속성 이름(`a.b`)·키(`{b:1}`)·라벨은 참조가 아니다.
      if (parent && parent.type === 'MemberExpression' && parent.property === n && !parent.computed) return;
      if (parent && parent.type === 'Property' && parent.key === n && !parent.computed) return;
      if (parent && (parent.type === 'LabeledStatement' || parent.type === 'BreakStatement' ||
        parent.type === 'ContinueStatement')) return;
      refs.push({ name: n.name, line: n.loc.start.line });
      return;
    }
    for (const k of Object.keys(n)) {
      if (k === 'loc' || k === 'range' || k === 'parent') continue;
      const v = n[k];
      if (Array.isArray(v)) for (const c of v) walk(c, n);
      else if (v && typeof v.type === 'string') walk(v, n);
    }
  };
  for (const n of ast.body) {
    // 선언의 **이름**은 참조가 아니다. 초기화식만 본다.
    if (n.type === 'VariableDeclaration') {
      for (const d of n.declarations) if (d.init) walk(d.init, d);
      continue;
    }
    if (n.type === 'FunctionDeclaration') continue;
    if (n.type === 'ClassDeclaration' || n.type === 'ClassExpression') {
      if (n.superClass) walk(n.superClass, n);
      for (const el of n.body.body) {
        // static 블록·static 필드는 클래스 평가 시점에 돈다.
        if (el.type === 'StaticBlock') walk(el, n);
        else if (el.type === 'PropertyDefinition' && el.static && el.value) walk(el.value, el);
      }
      continue;
    }
    walk(n, null);
  }
  return refs;
}

// 브라우저·벤더 전역. `eslint.config.mjs` 의 목록과 겹치지만 **여기서 다시 적지
// 않는다** — 이 검사가 보는 것은 `web/js` 안의 이름이고, 그 밖의 것은 전부
// "이미 서 있는 것" 으로 본다 (아래 `known` 이 그 판정이다).
const files = loadOrder();
const declaredAt = new Map();   // 이름 → 처음 선언된 파일의 인덱스
const parsed = [];

for (let i = 0; i < files.length; i++) {
  const rel = files[i];
  let src = '';
  try { src = readFileSync(join(ROOT, rel), 'utf8') } catch { continue }
  let ast;
  try { ast = espree.parse(src, PARSE) } catch (e) {
    console.error(`${rel}: 파싱 실패 — ${e.message}`);
    process.exit(1);
  }
  parsed.push({ rel, i, ast });
  for (const name of declaredIn(ast)) if (!declaredAt.has(name)) declaredAt.set(name, i);
}

const bad = [];
for (const { rel, i, ast } of parsed) {
  for (const { name, line } of loadTimeRefs(ast)) {
    const at = declaredAt.get(name);
    // `web/js` 안에서 선언되지 않은 이름은 이 검사의 대상이 아니다 — 브라우저
    // 전역이거나 벤더의 것이고, 그 존재는 `no-undef` 가 이미 본다.
    if (at === undefined) continue;
    if (at > i) bad.push({ rel, line, name, decl: files[at] });
  }
}

if (bad.length) {
  console.error(`로드 순서 위반 (${bad.length}건) — 로드 시점에 아직 서지 않은 이름을 읽습니다:`);
  for (const b of bad) {
    console.error(`  ${b.rel}:${b.line}  ${b.name}  ← ${b.decl} 가 나중에 선언합니다`);
  }
  console.error('');
  console.error('  web/index.html 의 <script> 순서를 고치거나, 그 참조를 함수 안으로 옮기세요.');
  console.error('  (함수 안은 호출 시점에 돌고, 그때는 모든 스크립트가 로드를 마쳤습니다.)');
  process.exit(1);
}

console.log(`load-order ok — 스크립트 ${files.length}개 · 로드 시점 참조에 순서 위반 0`);

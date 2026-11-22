#!/usr/bin/env node
/**
 * 위임자가 되살아나지 않는가 (REFACTOR3_FE_DELEG_SRS FR-DLG-7).
 *
 * ## 왜
 *
 * 리팩토링 3차는 App·GitPanel·FileTree·TerminalTool 의 메서드를 컨트롤러·부품으로 옮기면서 옛 이름을
 * **위임자**(주인 원형의 한 줄 메서드)로 남겼다 — 768개. 위임자는 이름 하나에 자리가 둘인 상태다: 부르는 쪽은
 * 주인을, 시험은 어느 쪽을 갈아 끼울지 골라야 했다. DELEG 가 부르는 쪽을 소유 경로로 옮기고 전부 걷었다.
 * 이 게이트가 같은 꼴이 다시 들어오지 않게 한다.
 *
 * ## 무엇을 잡는가
 *
 *   ① `Controller.delegate(` 호출 — 위임자 표
 *   ② 클래스 본문에서 **같은 이름을 같은 인자로** 넘기기만 하는 메서드
 *        name(a,b){ return this.part.name(a,b) }      static name(o){ return Other.name(o) }
 *
 * 이름이 다른 전달(`_write(){ return this.saver.write() }`)과 필드 접근자(`get _x(){ return this.store.x }`)는
 * 잡지 않는다 — 위임자가 아니다(SRS §1.4).
 *
 * ## 예외
 *
 * `Class.name` 단위로 아래 표에 적는다(SRS D-DLG-8). 파일을 통째로 빼면 그 파일의 새 위반이 조용히 들어온다.
 *
 * 사용: node scripts/check-delegates.mjs [루트=web/js]
 */
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const acorn = require('acorn');

/**
 * SRS D-DLG-8 — 이 SRS 범위 밖의 것. `FileEditor` 의 알림 부품 둘, `GitRemote.run`(원격 작업의 길잡이 `router` —
 * REFACTOR3_FE_REST3 FU-12 의 공개 입구), `DocRender.focus`(DOM 요소의 `focus` — 부품이 아니다).
 */
const ALLOW = new Set(['FileEditor.note', 'FileEditor.offer', 'GitRemote.run', 'DocRender.focus']);

/**
 * 기준선 — **병렬 진행 중**인 하위 이슈의 남은 위임자 (SRS §2.3 DL-3 GitPanel · DL-7 FileTree). 다른 작업 트리에서 걷는
 * 중이라 이 커밋에는 남아 있다. 예외가 아니다: 그 이슈가 합쳐지면 이 표에서 줄을 지운다. 수가 늘면 실패한다.
 *   delegate  주인 → `Controller.delegate(` 호출 수 · forward  클래스 → 같은 이름 전달 메서드 수
 */
const PENDING = { delegate: { FileTree: 8 }, forward: { GitPanel: 157 } };

const ROOT = process.argv[2] || 'web/js';

function walk(dir, out = []) {
  for (const n of readdirSync(dir)) {
    const f = join(dir, n);
    if (statSync(f).isDirectory()) { if (n !== 'test' && n !== 'vendor') walk(f, out); continue }
    if (n.endsWith('.js')) out.push(f);
  }
  return out;
}

function visit(node, fn) {
  if (!node || typeof node.type !== 'string') return;
  fn(node);
  for (const k in node) {
    const v = node[k];
    if (Array.isArray(v)) v.forEach((c) => visit(c, fn));
    else if (v && typeof v.type === 'string') visit(v, fn);
  }
}

/** `name(a,b){ return this.f.name(a,b) }` · `static name(a){ return X.name(a) }` 인가. */
function isForward(m) {
  if (m.type !== 'MethodDefinition' || m.kind !== 'method' || m.computed || m.key.type !== 'Identifier') return false;
  const body = m.value.body.body;
  if (body.length !== 1) return false;
  const st = body[0];
  const e = st.type === 'ReturnStatement' ? st.argument : st.type === 'ExpressionStatement' ? st.expression : null;
  if (!e || e.type !== 'CallExpression' || e.callee.type !== 'MemberExpression' || e.callee.computed) return false;
  if (e.callee.property.name !== m.key.name) return false;
  const obj = e.callee.object;
  const target = m.static
    ? obj.type === 'Identifier'
    : obj.type === 'MemberExpression' && !obj.computed && obj.object.type === 'ThisExpression';
  if (!target) return false;
  const params = m.value.params;
  if (params.length !== e.arguments.length) return false;
  return params.every((p, i) => {
    const a = e.arguments[i];
    if (p.type === 'Identifier') return a.type === 'Identifier' && a.name === p.name;
    if (p.type === 'RestElement') return a.type === 'SpreadElement' && a.argument.name === p.argument.name;
    return false;
  });
}

const hits = [];
const pending = { delegate: {}, forward: {} };
for (const f of walk(ROOT)) {
  const src = readFileSync(f, 'utf8');
  let ast;
  try { ast = acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'script', locations: true }) }
  catch { ast = acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'module', locations: true }) }
  const rel = relative(process.cwd(), f);
  visit(ast, (n) => {
    if (n.type === 'CallExpression' && n.callee.type === 'MemberExpression' && !n.callee.computed
      && n.callee.object.type === 'Identifier' && n.callee.object.name === 'Controller' && n.callee.property.name === 'delegate') {
      const host = n.arguments[0] && n.arguments[0].type === 'Identifier' ? n.arguments[0].name : '?';
      if (PENDING.delegate[host]) pending.delegate[host] = (pending.delegate[host] || 0) + 1;
      else hits.push(`${rel}:${n.loc.start.line}: Controller.delegate( — 위임자 표`);
    }
    if ((n.type === 'ClassDeclaration' || n.type === 'ClassExpression') && n.id) {
      for (const m of n.body.body) {
        if (!isForward(m)) continue;
        const id = n.id.name + '.' + m.key.name;
        if (ALLOW.has(id)) continue;
        if (PENDING.forward[n.id.name]) { pending.forward[n.id.name] = (pending.forward[n.id.name] || 0) + 1; continue }
        hits.push(`${rel}:${m.loc.start.line}: ${id} — 같은 이름을 같은 인자로 넘기기만 하는 메서드`);
      }
    }
  });
}

for (const kind of ['delegate', 'forward']) {
  for (const [host, max] of Object.entries(PENDING[kind])) {
    const got = pending[kind][host] || 0;
    if (got > max) hits.push(`${host}: ${kind} ${got} > 기준선 ${max} — 병렬 진행 중인 이슈의 위임자가 늘었다`);
  }
}

if (hits.length) {
  console.error('위임자가 있습니다 (REFACTOR3_FE_DELEG_SRS FR-DLG-7):');
  for (const h of hits) console.error('  ' + h);
  console.error('\n  부르는 쪽이 소유 경로(`app.slot.slotFocused()`·`panel.files.dirtyCount()`)를 부르게 하세요.');
  console.error('  예외가 필요하면 이 파일의 ALLOW 와 SRS D-DLG-8 에 이름 단위로 적습니다.');
  process.exit(1);
}
const left = Object.entries(pending).flatMap(([k, o]) => Object.entries(o).map(([h, c]) => h + ' ' + k + ' ' + c));
console.log('delegates ok — 위임자 표·같은 이름 전달 메서드가 없다 (예외 ' + ALLOW.size + (left.length ? ' · 병렬 진행 중 기준선: '
  + left.join(', ') : '') + ')');

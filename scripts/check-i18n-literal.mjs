#!/usr/bin/env node
/**
 * 화면에 드는 영어 문자열이 `t()` 를 지나는가
 * (WORDING_COLOR_SRS FR-WRD-43·44·46 · `AUDIT-uiux.md` §2.3).
 *
 * ## 왜 있는가
 *
 * `check-i18n.mjs` 가 막는 것은 *"한글을 코드에 박는 것"* 이다. **"번역해야 할
 * 것을 영어로 박는 것" 은 막지 않는다** — 그래서 카탈로그 958키가 초록인 채로
 * 화면의 열세 자리가 영어로 남아 있었다.
 *
 * 착수 시 실측 13자리: 단축키 그룹 `Pane` · `SHORTCUT_LABELS` 의 `Pane ↑↓←→` ·
 * 히스토리 ref `Local`·`Remote`·`Tags`(번역이 **이미 사전에 있었다**) · 변경 그룹
 * `Conflicts`·`Staged`·`Changes` · 사이드바 탭 `Windows`·`Repo` · 상단바 `Background`.
 *
 * ## 무엇을 묻는가 — **이웃이 번역되는데 자기만 안 되는 자리**
 *
 * 감사가 제안한 판정이 그것이다. 같은 배열·객체 안에 `t()` 호출이 섞여 있으면
 * 그 자리는 "번역되는 자리" 이고, 그 안의 맨 영어 문자열은 **빠진 것**이다.
 * 여기에 하나를 더한다 — `textContent` 에 **직접 드는** 영어 문자열. 그 둘이
 * 실측 13자리를 전부 덮는다.
 *
 * ## 잡으면 안 되는 것 (FR-WRD-44)
 *
 * 말이 아닌 영어가 있다: 키 이름(`'Enter'`)·단위(`MB`)·환경변수(`PATH`)·
 * git 하위명령·**엔티티 기본 이름**(`Shell`·`Window`·`Run` — 저장되는 데이터이고
 * 사용자가 rename 한다, D-WRD-10)·`title` 속성(영어가 요구다, FR-TIP-2).
 * 전부 **사유와 함께** 아래 등록부에 산다.
 *
 * 사용: node scripts/check-i18n-literal.mjs [--list]
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import * as espree from 'espree';

const ROOT = new URL('..', import.meta.url).pathname;

/** 말이 아닌 영어 — 자리마다 사유를 적는다. */
const EXEMPT = [
  { value: /^(Enter|Escape|Tab|Backspace|Delete|Home|End|PageUp|PageDown|Shift|Control|Alt|Meta)$/,
    why: '키 이름 — `e.key` 가 견주는 값이다. 번역하면 키를 못 읽는다' },
  { value: /^(MB|GB|KB|TB|ms|px)$/, why: '단위 — 로케일과 무관한 기호다' },
  { value: /^(PATH|HOME|SHELL|TERM)$/, why: '환경변수 이름' },
  { key: /^(title|ariaLabel|aria-label)$/, why: '`title`·`aria-label` 은 영어가 요구다 (UX_BATCH5_SRS FR-TIP-2)' },
  { value: /^(Shell|Window|Run )$/,
    why: '엔티티 기본 이름 — 저장되는 **데이터**이고 사용자가 rename 하면 그것이 이긴다 (D-WRD-10)' },
  // `Run <short>` 는 Run 엔티티의 **이름**이고 그 모양을 요구가 못박았다
  // (ORCHESTRATION_V2_SRS FR-RVZ-8: *"이름은 `Run <short>` 다"*). 탭 이름과 같은
  // 문자열이므로 한쪽만 번역하면 같은 Run 이 두 이름을 갖는다.
  { file: /app-(statusbar|layout)\.js$/, value: /^Run$/,
    why: '`Run <short>` — Run 엔티티의 이름이다 (FR-RVZ-8)' },
  { value: /^(Fetch|Pull|Push|Merge|Rebase|Checkout|Stash|Clone)$/,
    why: 'git 하위명령의 이름 — 사용자가 터미널에서 치는 낱말과 같아야 한다' },
];

if (process.argv.includes('-h') || process.argv.includes('--help')) {
  console.log(`화면에 드는 영어 문자열 검사

  ① 같은 배열·객체 안에 t()/tn() 이 섞여 있는데 자기만 영어 리터럴인 자리
  ② textContent·innerText 에 직접 드는 영어 문자열

  말이 아닌 영어(키 이름·단위·환경변수·엔티티 기본 이름·title)는 등록부가 지난다.

  --list  등록부와 건너뛴 수를 함께 찍는다.`);
  process.exit(0);
}

const PHRASE = /^[A-Z][A-Za-z]*(?:[ \u2190\u2191\u2192\u2193][A-Za-z\u2190\u2191\u2192\u2193]*)*$/;

function walk(d, out) {
  for (const n of readdirSync(d)) {
    const p = join(d, n);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.js')) out.push(p);
  }
  return out;
}
const rel = (p) => relative(ROOT, p).split('\\').join('/');

const files = walk(join(ROOT, 'web', 'js'), []).map(rel)
  .filter((f) => !/^web\/js\/(i18n|test)\//.test(f)).sort();

/** 이 하위 트리 어딘가에 `t()`·`tn()` 이 있는가. */
function hasT(n) {
  let found = false;
  const v = (x) => {
    if (!x || typeof x.type !== 'string' || found) return;
    if (x.type === 'CallExpression' && x.callee.type === 'Identifier' && (x.callee.name === 't' || x.callee.name === 'tn')) { found = true; return }
    for (const k of Object.keys(x)) {
      if (k === 'loc' || k === 'range') continue;
      const c = x[k];
      if (Array.isArray(c)) c.forEach(v); else if (c && typeof c.type === 'string') v(c);
    }
  };
  v(n);
  return found;
}

/**
 * **직접** 든 문자열만 본다 — 함수 본문 안으로 들어가지 않는다.
 *
 * 그릇(배열·객체)의 형제가 번역된다는 사실은 그 그릇의 **직접 값**에 대해서만
 * 뜻이 있다. `App.prototype` 처럼 메서드를 담은 큰 객체는 어딘가에 `t()` 가
 * 있게 마련이고, 거기서 함수 본문까지 파고들면 검사가 *"이 파일 어딘가에
 * 영어가 있다"* 로 무너진다 — 그것은 고칠 자리를 말하지 못한다 (D-CMP-5).
 */
function directLiterals(n, out, key) {
  if (!n || typeof n.type !== 'string') return out;
  if (n.type === 'Literal' && typeof n.value === 'string') { out.push({ node: n, key }); return out }
  if (n.type === 'Property') {
    const k = n.key.type === 'Identifier' ? n.key.name : n.key.value;
    return directLiterals(n.value, out, k);
  }
  if (n.type === 'ObjectExpression') { for (const p of n.properties) directLiterals(p, out, key); return out }
  if (n.type === 'ArrayExpression') { for (const e of n.elements) if (e) directLiterals(e, out, key); return out }
  return out;
}

/** 템플릿 리터럴의 고정 부분 — `` `Background ${n}` `` 의 `Background` 가 그것이다. */
function templateTexts(n, out) {
  if (!n || typeof n.type !== 'string') return out;
  if (n.type === 'TemplateLiteral') { for (const q of n.quasis) out.push({ text: q.value.cooked || '', node: n }); return out }
  for (const k of Object.keys(n)) {
    if (k === 'loc' || k === 'range') continue;
    const c = n[k];
    if (Array.isArray(c)) c.forEach((x) => templateTexts(x, out));
    else if (c && typeof c.type === 'string') templateTexts(c, out);
  }
  return out;
}

const bad = [];
let containers = 0, exempted = 0;
const usedExempt = new Set();

function exemptOf(value, key, file) {
  return EXEMPT.find((e) => (!e.file || e.file.test(file))
    && ((e.value && e.value.test(value)) || (e.key && key && e.key.test(String(key)))));
}

for (const f of files) {
  let ast;
  try { ast = espree.parse(readFileSync(join(ROOT, f), 'utf8'), { ecmaVersion: 2022, sourceType: 'script', loc: true }) }
  catch (e) { bad.push(`  ${f}: 파싱 실패 — ${e.message}`); continue }

  const visit = (n) => {
    if (!n || typeof n.type !== 'string') return;
    // ① 이웃이 번역되는 그릇
    if (n.type === 'ObjectExpression' || n.type === 'ArrayExpression') {
      const kids = n.type === 'ObjectExpression' ? n.properties : n.elements.filter(Boolean);
      if (kids.some(hasT) && kids.some((k) => !hasT(k))) {
        containers++;
        for (const k of kids) {
          if (hasT(k)) continue;
          for (const { node, key } of directLiterals(k, [], null)) {
            if (node.value.length < 2 || !PHRASE.test(node.value)) continue;
            const ex = exemptOf(node.value, key, f);
            if (ex) { exempted++; usedExempt.add(ex.why); continue }
            bad.push(`  ${f}:${node.loc.start.line}  ${key ? key + ': ' : ''}${JSON.stringify(node.value)}   ← 이웃은 t() 를 지난다`);
          }
        }
      }
    }
    // ② 화면에 직접 드는 자리
    if (n.type === 'AssignmentExpression' && n.left.type === 'MemberExpression'
        && n.left.property.type === 'Identifier' && /^(textContent|innerText)$/.test(n.left.property.name)) {
      const drawn = [...directLiterals(n.right, [], null).map((x) => ({ text: x.node.value, line: x.node.loc.start.line })),
        ...templateTexts(n.right, []).map((x) => ({ text: x.text.trim(), line: x.node.loc.start.line }))];
      for (const { text, line } of drawn) {
        if (text.length < 2 || !PHRASE.test(text)) continue;
        const ex = exemptOf(text, null, f);
        if (ex) { exempted++; usedExempt.add(ex.why); continue }
        bad.push(`  ${f}:${line}  ${n.left.property.name} = ${JSON.stringify(text)}   ← 화면에 그대로 든다`);
      }
    }
    for (const k of Object.keys(n)) {
      if (k === 'loc' || k === 'range') continue;
      const c = n[k];
      if (Array.isArray(c)) c.forEach(visit); else if (c && typeof c.type === 'string') visit(c);
    }
  };
  visit(ast);
}

// M6 §4-A-1: 파싱이 죽거나 판정이 좁아지면 검사가 조용히 초록이 된다.
if (files.length < 50 || containers < 20) {
  console.error(`검사가 공회전한다 — 파일 ${files.length}개(실측 100+) · 번역이 섞인 그릇 ${containers}개(실측 40+).`);
  process.exit(1);
}

if (process.argv.includes('--list')) {
  console.log(`파일 ${files.length} · 번역이 섞인 그릇 ${containers} · 등록부가 지난 자리 ${exempted}`);
  for (const w of usedExempt) console.log(`  ${w}`);
}

if (bad.length) {
  console.error(`영어 문자열이 카탈로그 밖에 있다 (${bad.length}자리, FR-WRD-43):`);
  for (const b of bad) console.error(b);
  console.error('');
  console.error("  t('<키>') 를 지나게 하고 ko·en 에 키를 채우세요.");
  console.error('  이미 같은 뜻의 키가 있으면 그것을 쓰세요 — 새 키를 만들지 않습니다.');
  console.error('  말이 아닌 영어(키 이름·단위·기본 이름)라면 이 파일의 등록부에 사유와 함께 올리세요.');
  process.exit(1);
}

console.log(`i18n-literal ok (파일 ${files.length} · 번역이 섞인 그릇 ${containers} · 등록부 ${exempted}자리)`);

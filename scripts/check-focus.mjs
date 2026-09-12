#!/usr/bin/env node
/**
 * 포커스 표시가 **짝이 맞는가** (DESIGN_TOKENS_SRS FR-TOK-24·25·30 / `UX-13`).
 *
 * 착수 시 실측은 `outline:none` 17 vs `:focus-visible` 9 였다. 그 차이 8 이
 * 결함이다 — 지운 자리와 되살린 자리가 짝이 맞지 않으면 **키보드 사용자는 자기가
 * 어디 있는지 모른다** (WCAG 2.4.7).
 *
 * 개수만 세지 않는 것이 요점이다. 17 ≤ 9 를 고치려고 아무 데나 링을 아홉 개 더
 * 그려도 개수는 맞는다 — 그래서 **선택자마다** 대응을 본다.
 *
 * ## 무엇을 같은 요소로 보는가
 *
 * `outline:none` 을 가진 규칙의 선택자에서 상태 의사클래스(`:focus`·`:hover`·
 * `:active`·`:focus-visible`·`:focus-within`)를 걷어낸 것이 **바탕 선택자**다.
 * 같은 바탕 선택자를 가진 `:focus-visible` 규칙이 `outline` 을 **그리면** 짝이
 * 맞는다. 캐스케이드를 흉내 내지 않는다 (`check-css-vars` 와 같은 규약) —
 * "이 요소에 링을 그리는 규칙이 있는가" 가 이 게이트의 물음이고, 그것이 실제로
 * 보이는지는 e2e 와 사람이 답한다.
 *
 * ## 링의 색은 토큰에서 온다 (FR-TOK-25)
 *
 * `var(--accent)` 는 **경계·배경용 원시값**이라 바닥을 받지 않는다 — 실측 2/54
 * (Ayu Light 2.62 · Everforest Light 2.50)에서 WCAG 1.4.11 의 3:1 을 못 넘었다.
 * 링은 `var(--focus-ring)` 을 쓴다. 그것은 파생이라 54종 전부에서 3:1 을 넘는다.
 *
 * 사용: node scripts/check-focus.mjs [--list]
 */
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const CSS_DIR = 'web';

if (process.argv.includes('-h') || process.argv.includes('--help')) {
  console.log(`포커스 짝 검사

  web/*.css 에서 outline 을 지운 규칙마다 같은 요소를 덮는 :focus-visible
  대체가 있는지 본다. 개수가 아니라 **선택자**로 짝을 맞춘다.

  링의 색은 var(--focus-ring) 이어야 한다 — --accent 는 바닥을 받지 않는
  원시값이라 밝은 테마 둘에서 보이지 않았다 (FR-TOK-25).

  --list  바탕 선택자별로 지움/되살림을 함께 찍는다.`);
  process.exit(0);
}

/** 주석은 CSS 가 아니다 (FR-TOK-28a 와 같은 이유). */
const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, ' ');

/**
 * 규칙을 `{선택자, 선언}` 으로 가른다. `@media` 류는 서문을 지나쳐 **안의 규칙을
 * 그대로** 본다 — 포커스 규칙이 미디어 쿼리 안에 살 수 있다.
 */
function parseRules(css) {
  const out = [];
  let buf = '', i = 0;
  while (i < css.length) {
    const ch = css[i];
    if (ch === '{') {
      const sel = buf.trim().replace(/\s+/g, ' ');
      buf = '';
      if (sel.startsWith('@')) { i++; continue; } // 서문 — 안으로 들어간다
      let j = i + 1, decls = '';
      while (j < css.length && css[j] !== '}' && css[j] !== '{') decls += css[j++];
      out.push({ sel, decls });
      i = j + 1;
      continue;
    }
    if (ch === '}') { buf = ''; i++; continue; }
    buf += ch; i++;
  }
  return out;
}

/** 선택자 목록을 쉼표로 가른다. */
const selectors = (sel) => sel.split(',').map((s) => s.trim()).filter(Boolean);

/** 상태 의사클래스를 걷어낸 **바탕 선택자**. */
const base = (s) => s.replace(/:(focus-visible|focus-within|focus|hover|active)\b/g, '').trim();

const files = readdirSync(CSS_DIR).filter((f) => f.endsWith('.css')).map((f) => join(CSS_DIR, f));

const cleared = new Map();  // 바탕 선택자 -> ["file:sel", …]  (outline 을 지운 자리)
const drawn = new Map();    // 바탕 선택자 -> ["file:sel", …]  (:focus-visible 이 그리는 자리)
const rawColor = [];        // 링이 토큰을 쓰지 않는 자리
let clearedDecls = 0, focusVisibleDecls = 0;

for (const f of files) {
  for (const { sel, decls } of parseRules(strip(readFileSync(f, 'utf8')))) {
    const outline = [...decls.matchAll(/(?:^|;)\s*outline\s*:\s*([^;]+)/g)].map((m) => m[1].trim());
    if (!outline.length) continue;
    const isNone = outline.some((v) => v === 'none' || v === '0');
    const ring = outline.find((v) => v !== 'none' && v !== '0');
    for (const s of selectors(sel)) {
      const b = base(s);
      if (isNone) {
        clearedDecls++;
        if (!cleared.has(b)) cleared.set(b, []);
        cleared.get(b).push(`${f}: ${s}`);
      }
      if (ring && /:focus-visible\b/.test(s)) {
        focusVisibleDecls++;
        if (!drawn.has(b)) drawn.set(b, []);
        drawn.get(b).push(`${f}: ${s}`);
        if (!/var\(--focus-ring\)/.test(ring)) rawColor.push(`${f}: ${s} — outline:${ring}`);
      }
    }
  }
}

// M6 §4-A-1: **아무것도 재지 않는 검사**를 만들지 않는다. 파서가 헛돌면
// `cleared` 가 비고 검사는 조용히 초록이 된다.
if (clearedDecls + focusVisibleDecls < 15) {
  console.error(`outline 선언을 ${clearedDecls + focusVisibleDecls}개밖에 못 읽었다 — 검사가 공회전한다.`);
  process.exit(1);
}

if (process.argv.includes('--list')) {
  for (const b of [...new Set([...cleared.keys(), ...drawn.keys()])].sort()) {
    console.log(`${drawn.has(b) ? '  ' : '✗ '}${b}`);
    for (const at of cleared.get(b) || []) console.log(`      지움  ${at}`);
    for (const at of drawn.get(b) || []) console.log(`      링    ${at}`);
  }
  console.log();
}

const orphan = [...cleared].filter(([b]) => !drawn.has(b)).sort();
const bad = [];
if (orphan.length) {
  bad.push(`outline 을 지우고 되살리지 않은 요소 (${orphan.length}개):`);
  for (const [b, at] of orphan) bad.push(`  ${b}\n      ${at.join('\n      ')}`);
  bad.push('');
  bad.push('  같은 바탕 선택자에 :focus-visible{outline:1px solid var(--focus-ring)} 를 두세요.');
}
if (rawColor.length) {
  bad.push(`포커스 링이 토큰을 쓰지 않는다 (${rawColor.length}건, FR-TOK-25):`);
  for (const r of rawColor) bad.push(`  ${r}`);
  bad.push('');
  bad.push('  var(--focus-ring) 을 쓰세요 — --accent 는 바닥(3:1)을 받지 않는 원시값입니다.');
}
if (clearedDecls > focusVisibleDecls) {
  bad.push(`지운 선언 ${clearedDecls} > 되살린 선언 ${focusVisibleDecls} (FR-TOK-30).`);
}

if (bad.length) {
  console.error(bad.join('\n'));
  process.exit(1);
}

console.log(`focus ok (지움 ${clearedDecls} · 링 ${focusVisibleDecls} · 바탕 선택자 ${cleared.size}개 전부 짝이 있다)`);

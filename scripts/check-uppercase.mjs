#!/usr/bin/env node
/**
 * 대문자 장식이 남아 있는가 (KIT_COMPONENTS_SRS FR-CMP-90 / FR-CMP-31).
 *
 * 착수 시 `text-transform:uppercase` 가 **9규칙**이었다 — `.git-refs-head` ·
 * `.gc-target-sect` · `.git-stash-preview-head` · `.git-group-head` ·
 * `.ag-head` · `.ag-group` · `.tl-section` · `.ce-title` · `.sc-group-title`.
 *
 * ## 왜 0 이어야 하는가
 *
 * **한글에는 대소문자가 없다.** 그래서 이 선언은 영문 글자에만 걸리고, 같은
 * 층위의 머리글이 `STAGED`(영·대문자)와 `미커밋 변경`(한)으로 갈려 **다른
 * 층위처럼** 읽힌다 (`AUDIT-uiux.md` §1.2 가 한 화면에서 네 가지를 셌다).
 * 장식이 언어에 따라 다르게 걸리면 그것은 장식이 아니라 **불일치**다.
 *
 * `text-transform:none|normal` 은 **되돌리는** 선언이므로 대상이 아니다 —
 * 부모가 건 변형을 끄는 자리다 (`.git-group-bulk` 가 그렇다).
 *
 * 사용: node scripts/check-uppercase.mjs [--list]
 */
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

const ROOT = 'web';

/** 예외 (SRS §6-예외표와 짝). **재검토 조건 없는 예외는 예외가 아니다.** */
const EXEMPT = [];

if (process.argv.includes('-h') || process.argv.includes('--help')) {
  console.log(`대문자 장식 검사

  web/**/*.css 에 text-transform:uppercase 가 0 인지 본다.
  한글에는 대소문자가 없어 이 장식은 영문에만 걸리고, 그래서 같은 층위의
  머리글이 언어에 따라 다른 층위로 읽힌다 (FR-CMP-31).

  --list  uppercase 를 가진 규칙을 전부 찍는다.`);
  process.exit(0);
}

const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, ' ');

function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    // 벤더 자산은 우리 것이 아니다.
    if (statSync(p).isDirectory()) { if (e !== 'vendor') walk(p, out); continue; }
    if (e.endsWith('.css')) out.push(p);
  }
  return out;
}

const hits = [];
let decls = 0;
for (const f of walk(ROOT)) {
  const css = strip(readFileSync(f, 'utf8'));
  for (const m of css.matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
    const sel = m[1].trim().replace(/\s+/g, ' ');
    if (!sel || sel.startsWith('@')) continue;
    for (const d of m[2].split(';')) {
      const t = d.trim().replace(/\s+/g, ' ');
      if (!/^text-transform\s*:/.test(t)) continue;
      decls++;
      if (/:\s*uppercase/.test(t)) hits.push({ f, sel, t });
    }
  }
}

// M6 §4-A-1: **아무것도 재지 않는 검사**를 만들지 않는다. `text-transform` 선언이
// 하나도 안 읽히면 파서가 헛돌고 있다는 뜻이고, 그때 이 검사는 조용히 초록이 된다.
if (decls < 1) {
  console.error('`text-transform` 선언을 하나도 못 읽었다 — 검사가 공회전한다.');
  process.exit(1);
}

if (process.argv.includes('--list')) {
  for (const h of hits) console.log(`✗ ${h.f}: ${h.sel} — ${h.t}`);
  console.log();
}
if (EXEMPT.length) console.log(`  예외 ${EXEMPT.length}건 (SRS §6-예외표)`);

const bad = hits.filter((h) => !EXEMPT.some((e) => e.sel === h.sel));
if (bad.length) {
  console.error(`✗ 대문자 장식이 ${bad.length}규칙에 남았다 (FR-CMP-31)`);
  for (const h of bad) console.error(`    ${h.f}: ${h.sel}`);
  console.error('');
  console.error('  한글에는 대소문자가 없어 이 장식은 영문에만 걸립니다 — 같은 층위의');
  console.error('  머리글이 언어에 따라 다른 층위로 읽힙니다. 선언을 걷고, 함께 선');
  console.error('  letter-spacing 도 걷으세요 (대문자 조판의 짝입니다).');
  process.exit(1);
}
console.log(`✓ 대문자 장식 0 — text-transform 선언 ${decls}개는 전부 되돌림이거나 다른 값이다 (FR-CMP-90)`);

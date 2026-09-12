#!/usr/bin/env node
/**
 * 글자 크기가 **토큰에서 오는가** (DESIGN_TOKENS_SRS FR-TOK-18·20·32 / `UX-18`).
 *
 * 착수 시 실측은 `font-size` 선언 385개 · 크기 12종이었다:
 * `7 8 9 10 11 11.5 12 13 14 15 18 20`. `11px` 과 `11.5px` 이 함께 있고
 * `13·14·15` 가 함께 있었다 — **어느 것도 뜻으로 갈리지 않는다.** 값이 뜻을
 * 말하지 않으면 다음 사람은 옆줄을 베껴 쓰고, 그렇게 12종이 됐다.
 *
 * 그래서 재는 것은 "크기가 몇 종인가" 가 아니라 **px 리터럴이 남았는가** 다.
 * 종수를 세면 `10px` 을 `11px` 로 고쳐 통과할 수 있고, 그 다음 사람이 다시
 * `13px` 을 적는다 — 리터럴을 0 으로 만들어야 그 길이 막힌다.
 *
 * ## 무엇을 리터럴로 보는가
 *
 * `px` 가 값 안에 있으면 리터럴이다 — `calc()` 안이라도 그렇다. 상대 단위
 * (`em`·`rem`·`%`·`ex`·`ch`)와 `inherit`·`var()` 는 리터럴이 아니다: 상대값은
 * 자기 기준을 물려받으므로 토큰을 우회하지 않는다 (`style-docrender.css` 의
 * `1.7em` 제목들이 그 부류다).
 *
 * ## `--ui-font` 는 값을 갖지 않는다 (FR-TOK-20)
 *
 * `UI_KIT_SRS` 가 `--ui-font:11px` 을 세웠고 이 문서가 `--fs-sm:11px` 을 세운다.
 * 두 이름이 **각자 값을 가지면 키울 때 한쪽만 커진다.** `--ui-font` 는
 * `var(--fs-sm)` 을 가리켜야 한다.
 *
 * 사용: node scripts/check-font-size.mjs [--list]
 */
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const CSS_DIR = 'web';

if (process.argv.includes('-h') || process.argv.includes('--help')) {
  console.log(`글자 크기 토큰 검사

  web/*.css 의 font-size: 값에 px 리터럴이 남았는지 본다. 전부 var(--fs-*)
  이어야 한다 (FR-TOK-32). 상대 단위(em·rem·%)는 리터럴이 아니다.

  --ui-font 가 --fs-sm 을 가리키는지도 함께 본다 (FR-TOK-20).

  --list  파일별로 font-size 선언을 전부 찍는다.`);
  process.exit(0);
}

/**
 * 주석은 CSS 가 아니다 (FR-TOK-28a). 주석을 **공백으로만** 지운다 — 줄바꿈을
 * 지우면 뒤따르는 모든 줄 번호가 밀려서, 게이트가 가리키는 자리가 실제 자리가
 * 아니게 된다. 자리를 잘못 짚는 게이트는 고치는 사람을 엉뚱한 곳으로 보낸다.
 */
const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));

const files = readdirSync(CSS_DIR).filter((f) => f.endsWith('.css')).map((f) => join(CSS_DIR, f));

const literals = [];   // px 가 남은 자리
let total = 0;          // 읽은 font-size 선언 수 (공회전 검출용)
const uiFont = [];      // --ui-font 정의

for (const f of files) {
  const src = strip(readFileSync(f, 'utf8'));
  const lines = src.split('\n');
  lines.forEach((line, i) => {
    for (const m of line.matchAll(/(?:^|[;{])\s*font-size\s*:\s*([^;}]+)/g)) {
      const v = m[1].trim();
      total++;
      if (/\bpx\b|\d\s*px/.test(v)) literals.push({ at: `${f}:${i + 1}`, v, ctx: line.trim().slice(0, 90) });
    }
    for (const m of line.matchAll(/--ui-font\s*:\s*([^;}]+)/g)) {
      uiFont.push({ at: `${f}:${i + 1}`, v: m[1].trim() });
    }
  });
}

// M6 §4-A-1: **아무것도 재지 않는 검사**를 만들지 않는다. 정규식이 헛돌면
// `literals` 가 비고 검사는 조용히 초록이 된다.
if (total < 200) {
  console.error(`font-size 선언을 ${total}개밖에 못 읽었다 — 검사가 공회전한다 (실측 385).`);
  process.exit(1);
}

if (process.argv.includes('--list')) {
  for (const f of files) {
    const src = strip(readFileSync(f, 'utf8'));
    const vals = [...src.matchAll(/(?:^|[;{])\s*font-size\s*:\s*([^;}]+)/g)].map((m) => m[1].trim());
    if (!vals.length) continue;
    const byVal = new Map();
    for (const v of vals) byVal.set(v, (byVal.get(v) || 0) + 1);
    console.log(`${f}  (${vals.length})`);
    for (const [v, n] of [...byVal].sort((a, b) => b[1] - a[1])) console.log(`    ${String(n).padStart(4)}  ${v}`);
  }
  console.log();
}

const bad = [];
if (literals.length) {
  const byVal = new Map();
  for (const l of literals) byVal.set(l.v, (byVal.get(l.v) || 0) + 1);
  bad.push(`font-size 에 px 리터럴이 남았다 (${literals.length}곳 · ${byVal.size}종, FR-TOK-32):`);
  for (const [v, n] of [...byVal].sort((a, b) => b[1] - a[1])) bad.push(`  ${String(n).padStart(4)}  font-size:${v}`);
  bad.push('');
  for (const l of literals.slice(0, 12)) bad.push(`  ${l.at}  ${l.ctx}`);
  if (literals.length > 12) bad.push(`  … 그리고 ${literals.length - 12}곳 (--list 로 전부 본다)`);
  bad.push('');
  bad.push('  var(--fs-xs|sm|md|lg|xl) 을 쓰세요. 뜻이 다섯에 없으면 SRS §3.3 을 고치는 일입니다.');
}
if (!uiFont.length) {
  bad.push('--ui-font 정의를 찾지 못했다 — FR-TOK-20 을 확인할 수 없다.');
} else {
  for (const u of uiFont) {
    if (u.v !== 'var(--fs-sm)') bad.push(`--ui-font 가 자기 값을 갖는다 (FR-TOK-20): ${u.at} — ${u.v}\n  var(--fs-sm) 을 가리켜야 합니다. 두 이름이 각자 값을 가지면 키울 때 한쪽만 커집니다.`);
  }
}

if (bad.length) {
  console.error(bad.join('\n'));
  process.exit(1);
}

console.log(`font-size ok (선언 ${total}개 전부 토큰 · --ui-font → --fs-sm)`);

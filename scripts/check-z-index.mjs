#!/usr/bin/env node
/**
 * z-index 가 **층에서 오는가** (DESIGN_TOKENS_SRS FR-TOK-21·22·31 / `UX-16`).
 *
 * 착수 시 실측은 **44선언 · 28값 · 1~9999** 였다. 의미의 층이 값에서 읽히지
 * 않았다: `#modal-overlay` 100 과 `.ui-modal` 200 이 같은 뜻이고, 토스트가
 * 400 과 420 둘이며, `.ed-find` 9997 · `.tc-copy` 9999 가 메뉴(3000) 위였다.
 *
 * `9997` 이 요점이다 — **위에 있어야 한다는 뜻을 값으로 말할 방법이 없어서 큰
 * 수를 골랐다.** 층이 이름을 갖지 않으면 매번 그렇게 된다.
 *
 * ## 무엇을 잡는가
 *
 * ① **숫자 리터럴** — `z-index:12` 는 그 12 가 무엇보다 위인지 말하지 않는다.
 *    `0`·`auto`·`inherit` 는 리터럴이 아니다(층이 아니라 "쌓지 않는다" 다).
 *
 * ② **층에 대한 산술** — `calc(var(--z-modal) + 1)` 은 이름을 붙인 ±1 이고,
 *    FR-TOK-22 가 금지한 바로 그것이다. 같은 층 안의 순서는 **DOM 이** 정한다.
 *    DOM 순서로 답할 수 없으면 층이 다른 것이다 (D-TOK-8).
 *
 * ## 왜 개수나 종수를 세지 않는가
 *
 * `check-font-size.mjs` 와 같은 이유다. "값이 다섯 종 이하" 로 재면 `100`·`200`
 * 같은 벌거벗은 수로 통과하고, 다음 사람은 그 사이에 `150` 을 적는다. 리터럴이
 * 0 이어야 그 길이 막힌다.
 *
 * 사용: node scripts/check-z-index.mjs [--list]
 */
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const CSS_DIR = 'web';

if (process.argv.includes('-h') || process.argv.includes('--help')) {
  console.log(`z-index 층 검사

  web/*.css 의 z-index: 값이 전부 var(--z-*) 인지 본다 (FR-TOK-31).
  예외는 0·auto·inherit — 그것은 층이 아니라 "쌓지 않는다" 다.

  층에 대한 산술(calc(var(--z-modal) + 1))도 잡는다 — 이름을 붙인 ±1 이고
  FR-TOK-22 가 금지한다. 같은 층 안의 순서는 DOM 이 정한다.

  --list  파일별로 z-index 선언을 전부 찍는다.`);
  process.exit(0);
}

/**
 * 주석은 CSS 가 아니다 (FR-TOK-28a). 주석을 **공백으로만** 지운다 — 줄바꿈을
 * 지우면 뒤따르는 줄 번호가 밀려서 게이트가 엉뚱한 자리를 가리킨다.
 */
const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));

const files = readdirSync(CSS_DIR).filter((f) => f.endsWith('.css')).map((f) => join(CSS_DIR, f));

const NEUTRAL = new Set(['0', 'auto', 'inherit', 'initial', 'unset', 'revert']);

const literals = [];   // 벌거벗은 수가 남은 자리
const arith = [];      // 층에 산술을 한 자리
let total = 0;

for (const f of files) {
  strip(readFileSync(f, 'utf8')).split('\n').forEach((line, i) => {
    for (const m of line.matchAll(/(?:^|[;{])\s*z-index\s*:\s*([^;}]+)/g)) {
      const v = m[1].trim();
      total++;
      const at = `${f}:${i + 1}`;
      if (NEUTRAL.has(v)) continue;
      if (!/var\(\s*--z-/.test(v)) { literals.push({ at, v, ctx: line.trim().slice(0, 90) }); continue; }
      // `var(--z-modal)` 만 허용한다 — 그 밖의 무엇이 더 붙으면 산술이다.
      if (!/^var\(\s*--z-[a-z-]+\s*\)$/.test(v)) arith.push({ at, v, ctx: line.trim().slice(0, 90) });
    }
  });
}

// M6 §4-A-1: **아무것도 재지 않는 검사**를 만들지 않는다. 정규식이 헛돌면
// `literals` 가 비고 검사는 조용히 초록이 된다.
if (total < 30) {
  console.error(`z-index 선언을 ${total}개밖에 못 읽었다 — 검사가 공회전한다 (실측 44).`);
  process.exit(1);
}

if (process.argv.includes('--list')) {
  for (const f of files) {
    const rows = [];
    strip(readFileSync(f, 'utf8')).split('\n').forEach((line, i) => {
      for (const m of line.matchAll(/(?:^|[;{])\s*z-index\s*:\s*([^;}]+)/g)) rows.push(`${String(i + 1).padStart(5)}  ${m[1].trim()}`);
    });
    if (!rows.length) continue;
    console.log(`${f}  (${rows.length})`);
    for (const r of rows) console.log(`  ${r}`);
  }
  console.log();
}

const bad = [];
if (literals.length) {
  const byVal = new Map();
  for (const l of literals) byVal.set(l.v, (byVal.get(l.v) || 0) + 1);
  bad.push(`z-index 에 숫자 리터럴이 남았다 (${literals.length}곳 · ${byVal.size}값, FR-TOK-31):`);
  for (const [v, n] of [...byVal].sort((a, b) => Number(b[0]) - Number(a[0]))) bad.push(`  ${String(n).padStart(4)}  z-index:${v}`);
  bad.push('');
  for (const l of literals.slice(0, 12)) bad.push(`  ${l.at}  ${l.ctx}`);
  if (literals.length > 12) bad.push(`  … 그리고 ${literals.length - 12}곳 (--list 로 전부 본다)`);
  bad.push('');
  bad.push('  var(--z-raised|sticky|overlay|modal|popover|edge) 를 쓰세요.');
  bad.push('  뜻이 여섯에 없으면 층이 부족한 것이고, 층을 더하는 것은 SRS §3.4 를 고치는 일입니다.');
}
if (arith.length) {
  bad.push(`층에 산술을 했다 (${arith.length}곳, FR-TOK-22):`);
  for (const a of arith) bad.push(`  ${a.at}  z-index:${a.v}`);
  bad.push('');
  bad.push('  같은 층 안의 순서는 DOM 이 정합니다. DOM 순서로 답할 수 없으면');
  bad.push('  층이 다른 것이고, 그때는 SRS §3.4 에 층을 더하세요 (D-TOK-8).');
}

if (bad.length) {
  console.error(bad.join('\n'));
  process.exit(1);
}

console.log(`z-index ok (선언 ${total}개 전부 층에서 온다 · 산술 0)`);

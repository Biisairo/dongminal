#!/usr/bin/env node
/**
 * 글꼴이 **토큰에서 오는가** (UIUX_OVERHAUL_SRS FR-TYP-5·6).
 *
 * 착수 시 실측은 `font-family` 선언 57개였고, 그중 고정폭이 **세 종류 스택**으로
 * 갈려 있었다:
 *
 *     monospace                                27곳
 *     ui-monospace,monospace                    5곳
 *     'Menlo','Monaco','Consolas',monospace     1곳
 *     var(--mono)                               3곳
 *
 * `--mono` 토큰이 이미 있는데 **38곳이 그것을 지나쳐 갔다.** 같은 뜻의 글꼴이
 * 자리마다 다른 스택으로 뜨면 그것은 토큰이 아니다 — `ui-monospace` 를 쓴
 * 자리와 `Menlo` 를 쓴 자리가 macOS 에서 실제로 다른 글꼴로 떴다.
 *
 * 그래서 재는 것은 "스택이 몇 종인가" 가 아니라 **글꼴 이름 리터럴이 남았는가**
 * 다. 종수를 세면 `monospace` 를 `ui-monospace,monospace` 로 고쳐 통과할 수
 * 있고, 그 다음 사람이 다시 제 스택을 적는다 (`check-font-size.mjs` 가 px
 * 리터럴에 대해 같은 판단을 한 자리다).
 *
 * ## 무엇이 허용인가
 *
 * `var(--mono)` · `var(--sans)` · `inherit` 셋뿐이다.
 *
 * - **`inherit` 은 리터럴이 아니다.** 물려받는 것은 토큰을 우회하지 않는다 —
 *   조상이 이미 토큰에서 받았다. 키트의 입력·버튼이 그 부류다.
 * - **스택의 정본은 `:root` 다.** `--mono:` · `--sans:` 의 정의 자리에는 글꼴
 *   이름이 있어야 하고, 그 자리는 `font-family:` 선언이 아니므로 애초에 이
 *   검사에 걸리지 않는다. 대신 §정의 검사가 그 둘이 **한 파일 한 자리**인지 본다.
 *
 * ## 왜 `--sans` 를 새로 세우는가
 *
 * `html,body` 만 `-apple-system,sans-serif` 를 들고 있었다. 한 자리뿐이니
 * 토큰이 필요 없어 보이지만, 그러면 **규칙이 "고정폭만 토큰"** 이 되고 다음
 * 사람이 sans 리터럴을 적을 때 막을 근거가 없다. 둘 다 토큰이어야 규칙이 하나다.
 *
 * 사용: node scripts/check-font-family.mjs [--list]
 */
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const CSS_DIR = 'web';

if (process.argv.includes('-h') || process.argv.includes('--help')) {
  console.log(`글꼴 토큰 검사

  web/*.css 의 font-family: 값이 토큰에서 오는지 본다. var(--mono)·var(--sans)·
  inherit 셋만 허용한다 (FR-TYP-6). 글꼴 이름 리터럴은 :root 의 토큰 정의
  자리에만 산다.

  --list  파일별로 font-family 선언을 전부 찍는다.`);
  process.exit(0);
}

/**
 * 주석은 CSS 가 아니다. 주석을 **공백으로만** 지운다 — 줄바꿈을 지우면 뒤따르는
 * 줄 번호가 밀려서 게이트가 엉뚱한 자리를 가리킨다
 * (`check-font-size.mjs` 가 같은 이유로 같은 방법을 쓴다).
 */
const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));

const files = readdirSync(CSS_DIR).filter((f) => f.endsWith('.css')).map((f) => join(CSS_DIR, f));

/** 토큰에서 오는 값. 이 셋 말고는 전부 리터럴이다. */
const ALLOWED = /^(?:var\(--mono\)|var\(--sans\)|inherit)$/;

const literals = [];        // 글꼴 이름이 남은 자리
const defs = { mono: [], sans: [] };  // 스택의 정의 자리
let total = 0;              // 읽은 font-family 선언 수 (공회전 검출용)

for (const f of files) {
  const src = strip(readFileSync(f, 'utf8'));
  src.split('\n').forEach((line, i) => {
    for (const m of line.matchAll(/(?:^|[;{])\s*font-family\s*:\s*([^;}]+)/g)) {
      const v = m[1].trim();
      total++;
      if (!ALLOWED.test(v)) literals.push({ at: `${f}:${i + 1}`, v, ctx: line.trim().slice(0, 90) });
    }
    for (const m of line.matchAll(/--(mono|sans)\s*:\s*([^;}]+)/g)) {
      defs[m[1]].push({ at: `${f}:${i + 1}`, v: m[2].trim() });
    }
  });
}

// **아무것도 재지 않는 검사**를 만들지 않는다. 정규식이 헛돌면 `literals` 가
// 비고 검사는 조용히 초록이 된다 (실측 57).
if (total < 40) {
  console.error(`font-family 선언을 ${total}개밖에 못 읽었다 — 검사가 공회전한다 (실측 57).`);
  process.exit(1);
}

if (process.argv.includes('--list')) {
  for (const f of files) {
    const src = strip(readFileSync(f, 'utf8'));
    const vals = [...src.matchAll(/(?:^|[;{])\s*font-family\s*:\s*([^;}]+)/g)].map((m) => m[1].trim());
    if (!vals.length) continue;
    const byVal = new Map();
    for (const v of vals) byVal.set(v, (byVal.get(v) || 0) + 1);
    console.log(`${f}  (${vals.length})`);
    for (const [v, n] of [...byVal].sort((a, b) => b[1] - a[1])) console.log(`    ${String(n).padStart(4)}  ${v}`);
  }
  process.exit(0);
}

let bad = false;

// ── 스택의 정의는 각각 한 자리다 ────────────────────────────────────────
// 두 자리가 각자 스택을 들면 그 순간 갈린다 — 이 게이트가 막으려는 것이
// 바로 그것이므로, 정본 자체가 둘이면 규칙이 성립하지 않는다.
for (const k of ['mono', 'sans']) {
  if (defs[k].length === 0) {
    console.error(`--${k} 가 정의되지 않았다. :root 에 스택을 세워야 한다 (FR-TYP-5).`);
    bad = true;
  } else if (defs[k].length > 1) {
    console.error(`--${k} 가 ${defs[k].length}곳에서 정의됐다 — 정본은 하나여야 한다 (FR-TYP-5):`);
    for (const d of defs[k]) console.error(`  ${d.at}  ${d.v}`);
    bad = true;
  }
}

// ── 사용처에 글꼴 이름이 남았는가 ───────────────────────────────────────
if (literals.length) {
  console.error(`\nfont-family 리터럴 ${literals.length}곳 (FR-TYP-6):`);
  console.error(`  허용: var(--mono) · var(--sans) · inherit\n`);
  for (const l of literals) console.error(`  ${l.at}\n      ${l.v}`);
  bad = true;
}

if (bad) process.exit(1);

console.log(`font-family ok (선언 ${total}개 — 전부 var(--mono)·var(--sans)·inherit)`);

#!/usr/bin/env node
/**
 * 색이 **토큰에서 오는가** (DESIGN_TOKENS_SRS FR-TOK-6·7·29 / `UX-14`·`UX-15`).
 *
 * 착수 시 실측: `:root` 밖 색 리터럴 **116곳**. 그중 **52곳이 `mask-image`
 * 안**이었고(아래), 실제 색은 64곳이었다 — `rgba(0,0,0,…)` 백드롭 12 · 그림자
 * 23 · Tokyo Night 팔레트 값과 위험 틴트 22 · 구분선 4 · 나머지 3.
 *
 * Tokyo Night 값이 박힌 자리는 **기본 테마에서만 맞고 나머지 53종에서 어긋난다.**
 * 그것이 이 게이트의 이유다.
 *
 * ## `:root` 안은 왜 통과시키는가
 *
 * 색은 어딘가에서 한 번은 리터럴로 적혀야 한다. 그 자리를 `:root` 하나로 모으면
 * **팔레트가 한 화면에서 검토된다.** 규칙은 "리터럴을 쓰지 마라" 가 아니라
 * "리터럴은 이름을 얻고 한자리에 모여라" 다.
 *
 * ## 마스크의 `rgba` 는 색이 아니다
 *
 * `mask-image` · `-webkit-mask-image` 는 **알파 채널만** 읽는다 — `#000` 은
 * "알파 1", `rgba(0,0,0,.18)` 은 "알파 .18" 이라는 뜻이고 RGB 는 버려진다.
 * `#focus-edge` 의 주석이 그것을 이미 적어 뒀다: *"흐려지는 것은 마스크의 알파이지
 * 화면의 픽셀이 아니다"*(D-6). 알파 값에 색 이름을 붙이는 것은 거짓말이므로
 * 이 속성들은 범위 밖이다. **몇 건을 건너뛰었는지 찍는다** — 조용한 예외는
 * 예외가 아니라 구멍이다.
 *
 * ## 두 가지 오탐을 피한다 (실측에서 나왔다)
 *
 * ① **ID 선택자** — `#add-window`·`#add-preset` 이 3자리 hex 로 읽힌다(실측 14건).
 *    그래서 **속성 값 자리**에서만 보고, hex 뒤에 `-`나 글자가 오면 색이 아니다.
 * ② **토큰 이름 안의 색 이름** — `var(--term-green)`·`--run-ok` 가 `green` 으로
 *    읽힌다(실측 8건). 앞이 `-` 면 이름의 일부다.
 *
 * 사용: node scripts/check-hardcoded-color.mjs [--list]
 */
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const CSS_DIR = 'web';

if (process.argv.includes('-h') || process.argv.includes('--help')) {
  console.log(`하드코딩 색 검사

  web/*.css 의 :root 블록 **밖**에 색 리터럴이 0 인지 본다 (FR-TOK-29).
  currentColor·transparent·inherit 는 리터럴이 아니다.

  mask-image 는 범위 밖이다 — 알파만 읽으므로 색이 아니다. 건너뛴 수를 찍는다.

  --list  :root 안에서 찾은 리터럴도 함께 찍는다 (정규식이 사는지 본다).`);
  process.exit(0);
}

/** 주석은 CSS 가 아니다 (FR-TOK-28a). 줄 번호를 보존하며 지운다. */
const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));

/** `:root{…}` 를 중괄호 균형으로 잘라 낸다 — 그 안은 팔레트의 집이다. */
function splitRoot(src) {
  const outside = [];   // [offset, text]
  const inside = [];
  let i = 0;
  for (;;) {
    const m = /:root[^{]*\{/.exec(src.slice(i));
    if (!m) { outside.push([i, src.slice(i)]); break; }
    const st = i + m.index, br = i + m.index + m[0].length;
    let d = 1, j = br;
    while (j < src.length && d) { d += (src[j] === '{') - (src[j] === '}'); j++ }
    outside.push([i, src.slice(i, st)]);
    inside.push(src.slice(br, j - 1));
    i = j;
  }
  return { outside, inside };
}

const HEX = /(?<![-\w#])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3})(?![-\w])/g;
const FUNC = /\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\([^)]*\)/g;
const NAMED = /(?<![-\w])(?:white|black|red|green|blue|yellow|orange|purple|pink|brown|gray|grey|cyan|magenta|lime|navy|teal|olive|maroon|silver|gold|violet|indigo|crimson|coral|tomato|wheat|beige|ivory|azure|khaki|plum|orchid|salmon|tan)(?![-\w])/g;
/** 선언 하나. 여러 줄 값(`mask-image` 의 gradient 넷)도 한 덩이로 잡는다. */
const DECL = /([-a-zA-Z0-9]+)\s*:\s*([^;{}]*)/g;

const scan = (val) => [...val.matchAll(HEX), ...val.matchAll(FUNC), ...val.matchAll(NAMED)].map((m) => m[0]);

const files = readdirSync(CSS_DIR).filter((f) => f.endsWith('.css')).map((f) => join(CSS_DIR, f));

const bad = [];
let rootLits = 0, maskSkipped = 0, declsRead = 0;

for (const f of files) {
  const src = strip(readFileSync(f, 'utf8'));
  const { outside, inside } = splitRoot(src);
  for (const block of inside) rootLits += scan(block).length;
  for (const [base, body] of outside) {
    for (const d of body.matchAll(DECL)) {
      declsRead++;
      const prop = d[1], val = d[2];
      const hits = scan(val);
      if (!hits.length) continue;
      if (/mask/.test(prop)) { maskSkipped += hits.length; continue }
      const line = src.slice(0, base + d.index).split('\n').length;
      bad.push({ at: `${f}:${line}`, prop, hits, ctx: val.replace(/\s+/g, ' ').trim().slice(0, 72) });
    }
  }
}

// M6 §4-A-1: **아무것도 재지 않는 검사**를 만들지 않는다. 정규식이 죽으면
// `bad` 가 비고 검사는 조용히 초록이 된다. `:root` 안에는 팔레트가 있으므로
// 거기서 한 줌도 못 찾으면 그것은 통과가 아니라 고장이다.
if (rootLits < 30 || declsRead < 500) {
  console.error(`검사가 공회전한다 — :root 안 리터럴 ${rootLits}개(실측 40+) · 선언 ${declsRead}개(실측 3000+).`);
  process.exit(1);
}

if (process.argv.includes('--list')) {
  console.log(`:root 안 리터럴 ${rootLits} · 읽은 선언 ${declsRead} · mask 건너뜀 ${maskSkipped}`);
}

if (bad.length) {
  const out = [`:root 밖에 색 리터럴이 남았다 (${bad.length}곳, FR-TOK-29):`];
  for (const b of bad) out.push(`  ${b.at}  ${b.prop}: ${b.ctx}   ← ${b.hits.join(' ')}`);
  out.push('');
  out.push('  색은 이름을 얻고 :root 에 모여야 합니다 (FR-TOK-29).');
  out.push('  테마마다 달라야 하는 색이면 applyThemeObj 가 파생합니다 (FR-TOK-13).');
  out.push('  테마와 무관한 색(브랜드·문서의 종이)이면 쓰는 자리 위의 :root 에 이름을 주세요.');
  console.error(out.join('\n'));
  process.exit(1);
}

console.log(`hardcoded-color ok (:root 밖 0 · :root 안 ${rootLits} · 선언 ${declsRead} · mask ${maskSkipped}건은 알파라 범위 밖)`);

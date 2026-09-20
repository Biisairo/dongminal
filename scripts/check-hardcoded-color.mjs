#!/usr/bin/env node
/**
 * 색이 **토큰에서 오는가** (DESIGN_TOKENS_SRS FR-TOK-6·7·29 / `UX-14`·`UX-15` ·
 * WORDING_COLOR_SRS FR-WRD-20~24).
 *
 * 착수 시 실측: `:root` 밖 색 리터럴 **116곳**. 그중 **52곳이 `mask-image`
 * 안**이었고(아래), 실제 색은 64곳이었다 — `rgba(0,0,0,…)` 백드롭 12 · 그림자
 * 23 · Tokyo Night 팔레트 값과 위험 틴트 22 · 구분선 4 · 나머지 3.
 *
 * Tokyo Night 값이 박힌 자리는 **기본 테마에서만 맞고 나머지 53종에서 어긋난다.**
 * 그것이 이 게이트의 이유다.
 *
 * ## 범위 — 세 자리를 더 본다 (FR-WRD-20)
 *
 * 이 검사는 오래 `web/*.css` 의 `:root` **밖**만 봤다. 프로덕션 승격 감사가
 * 그 사각지대에서 위반 **25건**을 찾았다 (`refactor/AUDIT-design.md` §0.2):
 * `:root` **안** 10 · `web/js/**` 11 · `index.html` 4. 그중 하나
 * (`--git-st-add`)는 **라이트 테마 11종을 깨뜨리고 있었다.** 그래서 범위가
 * ① `web/**\/*.css` (재귀) ② `web/js/**\/*.js` ③ `web/index.html` 로 넓어졌다.
 *
 * ## `:root` 안은 이제 **이름마다** 묻는다
 *
 * 색은 어딘가에서 한 번은 리터럴로 적혀야 한다. 그 자리를 `:root` 하나로 모으면
 * 팔레트가 한 화면에서 검토된다 — 그 규칙은 그대로다. 다만 *"`:root` 면 무엇이든
 * 좋다"* 는 너무 넓었다. `:root` 의 리터럴은 둘 중 하나여야 한다:
 *
 *   ① **런타임이 덮는 이름** — `themeVarsOf`(helpers.js)가 세우는 이름이면 그
 *      값은 첫 페인트용 폴백이다. 이 목록은 **손으로 적지 않고 그 함수에서
 *      파생한다** (FR-WRD-2) — 손으로 적으면 주입 맵이 자랄 때 조용히 갈린다.
 *   ② **등록부에 사유를 가진 이름** — 아래 `ROOT_EXEMPT`.
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
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';

const ROOT = new URL('..', import.meta.url).pathname;

/** 파일 단위 예외 — 통째로 지나간다. 줄마다 사유를 적는다 (FR-WRD-22). */
const SKIP_FILES = [
  { re: /^web\/js\/ui\/themes\.js$/, why: '팔레트 정본 — 54종의 값이 사는 자리다 (D-TOK-1)' },
  { re: /^web\/js\/core\/contrast\.js$/, why: '파생 계산 자신 — 앵커와 바닥이 사는 자리다 (D-TOK-5)' },
  { re: /^web\/js\/test\//, why: '단위 테스트 — 문자열은 검사 대상이 아니라 기대값이다' },
  { re: /^web\/vendor\//, why: '제3자 자산 — 판만 기록한다 (check-vendor.sh)' },
  // WORDING_COLOR_SRS D-WRD-8: 두 길 중 ②를 택한 자리다. 진단 화면이 테마
  // 파생에 기대면 **파생이 깨졌을 때 진단을 못 읽는다** — 그것이 이 화면의
  // 존재 이유와 정면으로 부딪힌다. 파일 머리에 같은 사유가 적혀 있다.
  { re: /^web\/js\/ui\/diag\.js$/, why: '진단 오버레이(`?diag=1`) — 테마가 깨졌을 때도 읽혀야 한다 (D-WRD-8)' },
];

/** 줄 단위 예외 — 그 파일의 그 모양만 지나간다. */
const SKIP_LINES = [
  { file: 'web/js/core/helpers.js', re: /rgba\(\$\{/, why: '`hexToRgba` — 리터럴이 아니라 생성자다' },
  { file: 'web/js/core/app-settings-theme.js', re: /inp\.value\s*=/, why: '`<input type="color">` 의 빈 값 자리표 — 화면에 칠해지지 않는다' },
];

/**
 * `:root` 안에서 리터럴을 가져도 좋은 이름 — **런타임이 덮지 않는** 것들.
 * 언제 없어지는지를 함께 적는다 (FR-WRD-23).
 */
const ROOT_EXEMPT = {
  // style-docrender.css:136~140 이 근거를 적었다. 문서 렌더가 테마를 주입하게 되면 없어진다.
  '--doc-paper': '남의 HTML 문서를 그리는 자리 — 그 문서는 흰 바탕을 전제로 쓰였다',
  // style.css:1534~1536 이 근거를 적었다. 브랜드 자산이 한 파일에서 생성되면 없어진다.
  '--boot-brand': '브랜드 — 파비콘 타일과 **같은 값**이어야 부팅 화면과 탭 아이콘이 한 물건으로 보인다',
  '--boot-brand-dk': '브랜드 — 타일 그라데이션의 어두운 쪽',
  '--boot-brand-lit': '브랜드 — 진행 바 하이라이트',
  '--boot-brand-ink': '브랜드 — 로고 획',
};

if (process.argv.includes('-h') || process.argv.includes('--help')) {
  console.log(`하드코딩 색 검사

  ① web/**/*.css 의 :root 블록 **밖**에 색 리터럴이 0 인가 (FR-TOK-29)
  ② :root **안**의 리터럴이 전부 "런타임이 덮는 이름" 이거나 등록부에 있는가 (FR-WRD-20)
  ③ web/js/**/*.js 와 web/index.html 에 색 리터럴이 0 인가 (FR-WRD-20)

  currentColor·transparent·inherit 는 리터럴이 아니다.
  mask-image 는 범위 밖이다 — 알파만 읽으므로 색이 아니다. 건너뛴 수를 찍는다.

  예외는 전부 **사유와 함께** 이 파일 안에 산다 — 조용한 예외는 예외가 아니라 구멍이다.

  --list  :root 안에서 통과시킨 이름과 건너뛴 파일을 함께 찍는다.`);
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
    inside.push([br, src.slice(br, j - 1)]);
    i = j;
  }
  return { outside, inside };
}

const HEX = /(?<![-\w#])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3})(?![-\w])/g;
const FUNC = /\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\([^)]*\)/g;
const NAMED = /(?<![-\w])(?:white|black|red|green|blue|yellow|orange|purple|pink|brown|gray|grey|cyan|magenta|lime|navy|teal|olive|maroon|silver|gold|violet|indigo|crimson|coral|tomato|wheat|beige|ivory|azure|khaki|plum|orchid|salmon|tan)(?![-\w])/g;
/** 선언 하나. 여러 줄 값(`mask-image` 의 gradient 넷)도 한 덩이로 잡는다. */
const DECL = /([-a-zA-Z0-9]+)\s*:\s*([^;{}]*)/g;

const scan = (val) => [...val.matchAll(HEX), ...val.matchAll(FUNC), ...val.matchAll(NAMED)].map((m) => m[0]);

/** `web/` 아래 전부. 재귀다 — 예전 `readdirSync('web')` 은 하위 폴더를 못 봤다. */
function walk(dir, out) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}
const rel = (p) => relative(ROOT, p).split('\\').join('/');

/**
 * 런타임이 덮는 이름 — `themeVarsOf`(helpers.js)의 맵 키와 구문 강조 여섯.
 * **손으로 적지 않는다** (FR-WRD-2): 주입 맵이 자라면 이 목록도 함께 자란다.
 */
function injectedNames() {
  const helpers = readFileSync(join(ROOT, 'web/js/core/helpers.js'), 'utf8');
  const body = helpers.slice(helpers.indexOf('function themeVarsOf'));
  const mapBody = body.slice(0, body.indexOf('\n}'));
  const names = new Set([...mapBody.matchAll(/'(--[a-z0-9-]+)'\s*:/g)].map((m) => m[1]));
  // `vars['--term-'+k]` 은 키가 계산된다 — 그 k 의 출처가 `SYNTAX_KEYS` 다.
  const contrast = readFileSync(join(ROOT, 'web/js/core/contrast.js'), 'utf8');
  const sk = contrast.match(/const SYNTAX_KEYS=\[([^\]]*)\]/);
  if (sk) for (const m of sk[1].matchAll(/'([a-z]+)'/g)) names.add('--term-' + m[1]);
  // 맵에 **펼쳐 넣는** 파생도 주입이다 (`...deriveShade(…)`, FR-WRD-30). 이름은
  // 그 함수가 갖고 있으므로 거기서 읽는다 — 여기 손으로 적으면 갈린다.
  for (const m of mapBody.matchAll(/\.\.\.(\w+)\(/g)) {
    const fn = contrast.slice(contrast.indexOf(`function ${m[1]}(`));
    if (!fn) continue;
    for (const k of fn.slice(0, fn.indexOf('\n}')).matchAll(/'(--[a-z0-9-]+)'\s*:/g)) names.add(k[1]);
  }
  return names;
}

const INJECTED = injectedNames();
// M6 §4-A-1: 주입 맵을 못 읽으면 `:root` 의 모든 이름이 위반이 되거나(소음) 파생이
// 비어 검사가 제 구실을 못 한다. 실측 32 + 구문 여섯이므로 25 를 밑돌면 고장이다.
if (INJECTED.size < 25) {
  console.error(`주입 맵을 ${INJECTED.size}개밖에 읽지 못했다 — 검사가 공회전한다 (themeVarsOf 를 찾지 못했다).`);
  process.exit(1);
}

const bad = [];
let rootOk = 0, maskSkipped = 0, declsRead = 0, filesSkipped = 0, jsLines = 0;
const skippedNames = [];

const all = walk(join(ROOT, 'web'), []).map(rel).sort();
const skipReason = (f) => SKIP_FILES.find((s) => s.re.test(f));

// ── CSS ─────────────────────────────────────────────────────────────
for (const f of all.filter((p) => p.endsWith('.css'))) {
  if (skipReason(f)) { filesSkipped++; continue }
  const src = strip(readFileSync(join(ROOT, f), 'utf8'));
  const { outside, inside } = splitRoot(src);
  for (const [base, block] of inside) {
    for (const d of block.matchAll(DECL)) {
      const prop = d[1], hits = scan(d[2]);
      if (!hits.length) continue;
      if (/mask/.test(prop)) { maskSkipped += hits.length; continue }
      if (INJECTED.has(prop) || prop in ROOT_EXEMPT) { rootOk += hits.length; skippedNames.push(prop); continue }
      const line = src.slice(0, base + d.index).split('\n').length;
      bad.push({ at: `${f}:${line}`, prop, hits, ctx: d[2].replace(/\s+/g, ' ').trim().slice(0, 72),
        why: ':root 안이지만 런타임이 덮지 않는 이름이다 — 파생으로 옮기거나 등록부에 사유를 적으세요' });
    }
  }
  for (const [base, body] of outside) {
    for (const d of body.matchAll(DECL)) {
      declsRead++;
      const prop = d[1], hits = scan(d[2]);
      if (!hits.length) continue;
      if (/mask/.test(prop)) { maskSkipped += hits.length; continue }
      const line = src.slice(0, base + d.index).split('\n').length;
      bad.push({ at: `${f}:${line}`, prop, hits, ctx: d[2].replace(/\s+/g, ' ').trim().slice(0, 72),
        why: ':root 밖에 색 리터럴이 있다' });
    }
  }
}

// ── JS · HTML ───────────────────────────────────────────────────────
/** 줄 주석과 블록 주석을 지운다 — 주석의 색은 색이 아니라 설명이다. */
function stripJs(src) {
  return strip(src).split('\n').map((ln) => ln.replace(/\/\/.*$/, '')).join('\n');
}

for (const f of all.filter((p) => p.endsWith('.js') || p === 'web/index.html')) {
  if (skipReason(f)) { filesSkipped++; continue }
  const raw = readFileSync(join(ROOT, f), 'utf8');
  const src = f.endsWith('.html')
    ? raw.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '))
    : stripJs(raw);
  src.split('\n').forEach((ln, i) => {
    jsLines++;
    const hits = [...ln.matchAll(HEX), ...ln.matchAll(FUNC)].map((m) => m[0]);
    if (!hits.length) return;
    const line = SKIP_LINES.find((s) => s.file === f && s.re.test(ln));
    if (line) return;
    bad.push({ at: `${f}:${i + 1}`, prop: '', hits, ctx: ln.trim().slice(0, 72),
      why: '색이 코드 안에 있다 — CSS 로 옮기고 클래스를 토글하세요' });
  });
}

// M6 §4-A-1: **아무것도 재지 않는 검사**를 만들지 않는다. 정규식이 죽으면
// `bad` 가 비고 검사는 조용히 초록이 된다.
if (rootOk < 30 || declsRead < 500 || jsLines < 10000) {
  console.error(`검사가 공회전한다 — :root 통과 ${rootOk}개(실측 40+) · 선언 ${declsRead}개(실측 3000+) · JS/HTML 줄 ${jsLines}(실측 40000+).`);
  process.exit(1);
}

if (process.argv.includes('--list')) {
  console.log(`:root 통과 ${rootOk} (${[...new Set(skippedNames)].join(' ')})`);
  console.log(`건너뛴 파일 ${filesSkipped} — ${SKIP_FILES.map((s) => s.why).join(' · ')}`);
}

if (bad.length) {
  const out = [`색 리터럴이 토큰 밖에 있다 (${bad.length}곳, FR-TOK-29 · FR-WRD-20):`];
  for (const b of bad) out.push(`  ${b.at}  ${b.prop ? b.prop + ': ' : ''}${b.ctx}   ← ${b.hits.join(' ')}\n      ${b.why}`);
  out.push('');
  out.push('  색은 이름을 얻고 :root 에 모여야 합니다 (FR-TOK-29).');
  out.push('  테마마다 달라야 하는 색이면 applyThemeObj 가 파생합니다 (FR-TOK-13).');
  out.push('  테마와 무관한 색(브랜드·문서의 종이)이면 :root 에 이름을 주고 이 파일의 등록부에 사유를 적으세요.');
  console.error(out.join('\n'));
  process.exit(1);
}

console.log(`hardcoded-color ok (:root 밖 0 · :root 안 ${rootOk} 전부 파생 또는 등록 · JS/HTML ${jsLines}줄 · 건너뛴 파일 ${filesSkipped} · mask ${maskSkipped}건은 알파라 범위 밖)`);

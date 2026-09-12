#!/usr/bin/env node
/**
 * CSS 가 읽는 커스텀 프로퍼티가 **실제로 세워지는가** (DESIGN_TOKENS_SRS FR-TOK-28).
 *
 * `--bg-alt` 가 이 검사의 이유다. 일곱 자리가 그것을 읽었고 **정의된 적이
 * 없었다** — 넷은 배경이 투명으로 떨어졌고, 셋은 `var(--bg-alt,var(--bg))` 로
 * 폴백을 적어 두어 동작했다. 같은 파일 묶음 안에서 갈렸다는 것이 요점이다:
 * **토큰에 목록이 없으면 쓰는 사람이 있는지 없는지를 매번 짐작하게 된다** (`UX-5`).
 *
 * ## 폴백이 있어도 잡는다 (D-TOK-6)
 *
 * `var(--x, 기본값)` 은 지금 동작한다. 그러나 그 자리는 `--x` 가 **있다고 믿고**
 * 쓴 자리이고, 폴백은 그 믿음이 틀렸다는 사실을 숨긴다. 숨겨진 채로 두면 폴백을
 * 적지 않은 다음 사람이 투명한 배경을 얻는다 — 실제로 그렇게 됐다.
 *
 * ## 세워지는 자리 넷
 *
 *   ① `web/*.css` 의 `:root{ --x: … }`          — 첫 페인트 기본값
 *   ② 선택자에 매인 정의 (`.run-view{--run-ok:…}`) — 그 하위에서만 산다
 *   ③ `applyThemeObj` 의 `vars` 맵 (`helpers.js`) — 테마마다 다시 세운다
 *   ④ JS 의 `setProperty('--x', …)`              — 레이아웃·측정값
 *
 * ② 을 **범위까지 보지는 않는다.** 이 검사가 답하는 물음은 "이 이름이 세워지기는
 * 하는가" 이고, "그 요소에서 보이는가" 는 브라우저가 답한다. 범위를 흉내 내려면
 * 캐스케이드를 다시 구현해야 하고, 그것은 검사가 아니라 두 번째 렌더러다.
 *
 * **주석은 CSS 가 아니다.** 첫 판이 `style.css:412` 의 *"`var(--fg)` 는 어디에도
 * 정의된 적이 없어"* 라는 주석을 **사용으로 읽어** `--fg` 를 결함으로 올렸다 —
 * 그 주석은 이미 고쳐진 과거를 적은 것이었다. 주석을 먼저 걷어낸다.
 *
 * 사용: node scripts/check-css-vars.mjs [--list]
 */
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const CSS_DIR = 'web';
const JS_DIR = 'web/js';

if (process.argv.includes('-h') || process.argv.includes('--help')) {
  console.log(`CSS 커스텀 프로퍼티 정의 검사

  web/*.css 가 var(--x) 로 읽는 이름이 전부 어딘가에서 세워지는지 본다.
  폴백(var(--x, 기본값))이 있어도 미정의는 미정의로 잡는다 — 폴백은 의도를
  숨기고, 숨겨진 채로 두면 폴백을 적지 않은 다음 사람이 빈 값을 얻는다.

  세우는 자리: :root 블록 · applyThemeObj 의 vars 맵 · JS 의 setProperty.

  --list  읽기만 하고 세우는 곳을 함께 찍는다.`);
  process.exit(0);
}

/** `web/` 바로 아래의 CSS (vendor 는 제3자 자산이라 보지 않는다). */
const cssFiles = readdirSync(CSS_DIR)
  .filter((f) => f.endsWith('.css'))
  .map((f) => join(CSS_DIR, f));

/** `web/js` 아래 전부. */
function jsFiles(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...jsFiles(p));
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

/** 주석을 걷어낸다. 주석 안의 `var(--x)` 는 사용이 아니라 이야기다. */
const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, ' ');

const defined = new Set();

// ①② 선언. `--x:` 꼴은 선언에만 나온다 — `var(--x)` 의 이름 뒤에는 `)` 나 `,`
// 가 오므로 섞이지 않는다. `:root` 든 `.run-view` 든, 줄을 나눴든 붙였든 잡힌다.
for (const f of cssFiles) {
  for (const d of strip(readFileSync(f, 'utf8')).matchAll(/(--[\w-]+)\s*:/g)) defined.add(d[1]);
}

// ③④ JS 가 세우는 이름 — `'--x':` (맵) 과 `setProperty('--x'` 둘 다.
for (const f of jsFiles(JS_DIR)) {
  const src = readFileSync(f, 'utf8');
  for (const d of src.matchAll(/setProperty\(\s*['"`](--[\w-]+)/g)) defined.add(d[1]);
  for (const d of src.matchAll(/['"`](--[\w-]+)['"`]\s*:/g)) defined.add(d[1]);
}

// 읽는 자리.
const used = new Map(); // name -> [ "file:line", … ]
for (const f of cssFiles) {
  const lines = strip(readFileSync(f, 'utf8')).split('\n');
  lines.forEach((line, i) => {
    for (const m of line.matchAll(/var\(\s*(--[\w-]+)/g)) {
      if (!used.has(m[1])) used.set(m[1], []);
      used.get(m[1]).push(`${f}:${i + 1}`);
    }
  });
}

// M6 §4-A-1: **아무것도 재지 않는 검사**를 만들지 않는다.
if (used.size < 20 || defined.size < 20) {
  console.error(`읽기 ${used.size}개 · 정의 ${defined.size}개 — 너무 적다. 검사가 공회전한다.`);
  process.exit(1);
}

if (process.argv.includes('--list')) {
  for (const [name, at] of [...used].sort()) {
    console.log(`${defined.has(name) ? '  ' : '✗ '}${name.padEnd(22)} ${at.length}곳`);
  }
  console.log();
}

const missing = [...used].filter(([n]) => !defined.has(n)).sort();
if (missing.length) {
  console.error(`세워지지 않는 커스텀 프로퍼티를 읽는다 (${missing.length}개):`);
  for (const [name, at] of missing) {
    console.error(`  ${name} — ${at.slice(0, 4).join(' · ')}${at.length > 4 ? ` 외 ${at.length - 4}곳` : ''}`);
  }
  console.error('');
  console.error('  :root 에 기본값을 두거나 applyThemeObj 의 vars 맵에 넣으세요.');
  console.error('  폴백(var(--x, 기본값))으로 덮지 마세요 — 의도를 숨깁니다 (D-TOK-6).');
  process.exit(1);
}

console.log(`css-vars ok (읽기 ${used.size}개 이름 전부 세워진다 / 정의 ${defined.size}개)`);

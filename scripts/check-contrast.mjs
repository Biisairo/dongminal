#!/usr/bin/env node
/**
 * 테마 전종의 글자 대비 (DESIGN_TOKENS_SRS FR-TOK-26·27).
 *
 * 착수 시 실측은 이랬다: `--text-dim` 이 `color:` 로 **99번** 쓰이는데 테마
 * **54종 어디서도 3:1 조차 넘지 않았고**, `--text-muted` 는 149번 쓰이면서
 * 10/54 만 4.5:1 을 넘었다. 합쳐 **248개 글자 선언**이 읽히지 않는 값 위에 서
 * 있었다.
 *
 * 팔레트를 손으로 고치는 길은 닫혀 있다 — 그 값들은 각 테마의 **정본**이다
 * (Nord 의 `#4c566a` 는 Nord 그 자체다, D-TOK-1). 그래서 `applyThemeObj` 가
 * **파생**으로 보장하고, 이 게이트가 그 파생이 실제로 닿는지 본다.
 *
 * ## 왜 값을 여기서 다시 계산하지 않는가
 *
 * **`web/js/core/contrast.js` 를 그대로 싣는다** (D-TOK-5 / FR-TOK-27). 게이트가
 * 제 계산을 따로 가지면 둘이 갈라지고, 갈라진 순간 **게이트는 초록인데 화면은
 * 미달**이 된다 — M6 "비싸게 배운 것 9"(초록인 게이트와 재고 있는 게이트는
 * 다르다)와 같은 부류다. 브라우저가 싣는 그 파일이 곧 판정의 근거다.
 *
 * 그래서 `themes.js` 를 고치는 커밋에서 즉시 빨개진다 — 새 테마도 자동으로
 * 이 검사를 받는다.
 *
 * 사용: node scripts/check-contrast.mjs [--table]
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { load } from '../web/js/test/harness.mjs';

const ctx = load(['core/contrast.js', 'ui/themes.js'], {
  // `themes.js` 끝줄이 `TOPTS.theme` 에 대입한다.
  globals: { TOPTS: {} },
  expose: ['CONTRAST_FLOORS', 'THEMES'],
});
const { CONTRAST_FLOORS, THEMES, contrastRatio, deriveContrastTokens } = ctx;

/** 토큰 → 바닥. `ACCESSIBILITY_BASELINE_SRS` FR-A11Y-6·7 이 근거다. */
const CHECK = [
  ['text', CONTRAST_FLOORS.text],
  // `textBright` 의 바닥은 테마마다 다르다 — 파생된 `--text` 가 올린다. 여기서는
  // 고정 하한만 보고, **`--text` 보다 흐리지 않은가**는 아래에서 따로 본다.
  ['textBright', CONTRAST_FLOORS.bright],
  ['textMuted', CONTRAST_FLOORS.muted],
  ['textHint', CONTRAST_FLOORS.hint],
  ['accentText', CONTRAST_FLOORS.strong],
  ['dangerText', CONTRAST_FLOORS.strong],
  // 포커스 링은 글자가 아니라 **UI 컴포넌트**다 — 바닥이 3:1 이다 (FR-TOK-25 /
  // WCAG 1.4.11). 원시 `--accent` 로는 2/54 가 못 넘었다.
  ['focusRing', CONTRAST_FLOORS.ui],
];

/**
 * CSS 가 `:root` 에서 정한 **상태 색** → 바닥 (WORDING_COLOR_SRS FR-WRD-10·12).
 *
 * 위의 `CHECK` 는 파생이 **닿는** 토큰만 본다. 그런데 화면의 색이 전부 파생에서
 * 오는 것은 아니다 — CSS 가 `:root` 에서 값을 직접 정하는 자리가 있고, 그 값은
 * 54종 전부에서 같다. 그것이 글자색이면 어느 테마에서는 읽히지 않는다.
 *
 * 착수 시 실측: `--git-st-add:#9ece6a`(Tokyo Night 의 초록)가 **라이트 테마
 * 11/11 에서 1.26~1.83:1** 이었다. 위의 `CHECK` 는 이 이름을 모르므로 조용히
 * 초록이었다 — `--text-dim` 이 99번 쓰이면서 54종 어디서도 3:1 을 못 넘던 그
 * 상태(§2.1)와 같은 부류이고, 그 문서가 고친 뒤에 남은 마지막 한 자리다.
 *
 * 값이 `var(--term-*)` 이면 **그 테마의 파생값**으로 잰다 — 그것이 이 검사가
 * 요구하는 모양이다. 리터럴이면 54종 전부에 그 한 값으로 잰다.
 */
const CSS_TOKENS = [
  // 글자로 쓰인다 (`.git-file-st.st-add` · `.ed-row.st-add .ed-name` 외). 배경으로
  // 쓰는 `.fe-dd-add` 의 바닥은 3:1 이므로 글자 바닥이 그것을 덮는다.
  ['--git-st-add', CONTRAST_FLOORS.strong],
];

/**
 * ANSI 6색 (UIUX_OVERHAUL_SRS FR-SEM-1·3).
 *
 * `deriveContrastTokens` 는 이 여섯을 `CONTRAST_FLOORS.strong` 으로 끌어올려
 * 파생해 왔지만, **게이트가 그것을 확인한 적은 없었다** — `CHECK` 에도
 * `CSS_TOKENS` 에도 없었고, `--git-st-add` 를 통해 green 하나가 간접적으로
 * 걸렸을 뿐이다. 파생이 있다는 것과 파생이 바닥에 닿는다는 것은 다른 말이다.
 *
 * 6색이 UI 상태 어휘의 정본이 되는 이상(FR-SEM-1) 여섯 다 글자로 선다.
 * `CSS_TOKENS` 와 갈라 두는 이유: 저것은 **`:root` 의 CSS 선언**이 무엇을
 * 가리키는지 보는 목록이고(`--git-st-add:var(--term-green)`), 이것은 **파생
 * 결과** 자체를 보는 목록이다. `:root` 의 `--term-*` 리터럴은 첫 페인트용
 * 폴백이므로 그 값을 재면 라이트 테마에서 Tokyo Night 의 색을 재게 된다.
 */
const SYNTAX_TOKENS = ['red', 'green', 'yellow', 'blue', 'magenta', 'cyan'];

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const STYLE_CSS = readFileSync(join(ROOT, 'web', 'style.css'), 'utf8');

/** `:root` 의 선언 하나. 주석은 값에 들지 않는다. */
function cssDecl(name) {
  const m = STYLE_CSS.match(new RegExp('(^|[;{\\s])' + name + '\\s*:\\s*([^;]+);'));
  return m ? m[2].trim() : null;
}

/** 선언값 → 그 테마에서 실제로 칠해지는 색. 모르면 null. */
function resolveDecl(decl, derived) {
  if (/^#[0-9a-fA-F]{3,8}$/.test(decl)) return decl;
  const v = decl.match(/^var\(\s*--term-([a-z]+)\s*\)$/);
  if (v) return derived.syntax ? derived.syntax[v[1]] : null;
  return null;
}

if (process.argv.includes('-h') || process.argv.includes('--help')) {
  console.log(`테마 전종의 글자 대비 검사

  web/js/ui/themes.js 의 팔레트마다 web/js/core/contrast.js 의 파생을 돌리고,
  나온 글자 토큰이 --bg · --sidebar-bg · --bg-alt **셋 다**에 대해 바닥을 넘는지
  본다. 표면 하나를 빠뜨리면 그 위에서만 조용히 미달이 된다.

  바닥 (사다리 — DESIGN_TOKENS_SRS D-TOK-4):
${CHECK.map(([k, f]) => `    ${k.padEnd(12)} ${f}:1`).join('\n')}

  셋에 같은 바닥을 주면 안 된다: 가장 흐리던 것이 가장 많이 올라가 중간 단계를
  추월하고, 실측 54종 중 34종에서 시각 계층이 무너진다.

  --table  테마별 대비를 표로 찍는다 (근거 기록용).`);
  process.exit(0);
}

const names = Object.keys(THEMES);
// M6 §4-A-1: **아무것도 재지 않는 검사**를 만들지 않는다. 팔레트를 못 읽으면
// 루프가 공회전하면서 초록이 된다.
if (names.length < 50) {
  console.error(`테마를 ${names.length}종밖에 읽지 못했다 — 검사가 공회전한다.`);
  process.exit(1);
}

const bad = [];
const rows = [];
for (const name of names) {
  const t = THEMES[name];
  // `syntax.*` 는 터미널 팔레트가 있어야 선다 — `themeVarsOf`(helpers.js:223)가
  // 넘기는 것과 **같은 인자**로 부른다. 여기서만 다르게 부르면 게이트와 화면이
  // 갈라진다 (D-TOK-5).
  const d = deriveContrastTokens(t.ui, t.mode, null, t.terminal);
  // 글자가 놓이는 배경 **셋** (FR-TOK-9). `--bg-alt` 를 빠뜨리면 그 표면
  // 위에서만 조용히 미달이 된다 — 넣기 전 실측에서 `--text-hint` 가 4.33 이었다.
  const bgs = [['bg', t.ui.bg], ['sidebarBg', t.ui.sidebarBg], ['bg-alt', d.bgAlt]];
  const row = { name, mode: t.mode };
  for (const [tok, floor] of CHECK) {
    let worst = Infinity;
    for (const [bgName, bg] of bgs) {
      const got = contrastRatio(d[tok], bg);
      if (got < worst) worst = got;
      if (got < floor - 1e-9) {
        bad.push(`  ${name} / ${tok} on --${bgName}: ${got.toFixed(2)} < ${floor}`);
      }
    }
    row[tok] = worst;
  }
  for (const k of SYNTAX_TOKENS) {
    const color = d.syntax && d.syntax[k];
    if (!color) { bad.push(`  ${name} / --term-${k} 가 파생되지 않았다 — 터미널 팔레트를 확인한다`); continue }
    for (const [bgName, bg] of bgs) {
      const got = contrastRatio(color, bg);
      if (got < CONTRAST_FLOORS.strong - 1e-9) {
        bad.push(`  ${name} / --term-${k}(${color}) on --${bgName}: ${got.toFixed(2)} < ${CONTRAST_FLOORS.strong}`);
      }
    }
  }
  for (const [name_, floor] of CSS_TOKENS) {
    const decl = cssDecl(name_);
    if (!decl) { bad.push(`  ${name_} 를 web/style.css 에서 찾지 못했다 — 검사가 공회전한다`); continue }
    const color = resolveDecl(decl, d);
    if (!color) { bad.push(`  ${name_}: \`${decl}\` 을 색으로 풀지 못했다 — 리터럴이거나 var(--term-*) 여야 한다`); continue }
    for (const [bgName, bg] of bgs) {
      const got = contrastRatio(color, bg);
      if (got < floor - 1e-9) {
        bad.push(`  ${name} / ${name_}(${decl}) on --${bgName}: ${got.toFixed(2)} < ${floor}`);
      }
    }
  }
  rows.push(row);
}

if (process.argv.includes('--table')) {
  const head = ['theme', 'mode', ...CHECK.map(([k]) => k)];
  console.log(head.map((h, i) => (i ? h.padStart(11) : h.padEnd(24))).join(' '));
  for (const r of rows) {
    console.log([r.name.padEnd(24), r.mode.padStart(11),
      ...CHECK.map(([k]) => r[k].toFixed(2).padStart(11))].join(' '));
  }
  console.log();
}

// "가장 또렷한 글자" 가 본문보다 흐리면 이름이 거짓말을 한다. 고정 바닥으로는
// 잡히지 않는다 — 둘 다 7.0 을 넘으면서 순서가 뒤집힐 수 있다.
for (const r of rows) {
  if (r.textBright < r.text - 1e-9) {
    bad.push(`  ${r.name} / textBright(${r.textBright.toFixed(2)}) 가 text(${r.text.toFixed(2)}) 보다 흐리다`);
  }
}

if (bad.length) {
  console.error(`글자 대비가 바닥에 못 미친다 (${bad.length}건):`);
  for (const b of bad) console.error(b);
  console.error('');
  console.error('  팔레트를 손으로 올리지 마세요 — 그 값은 테마의 정본입니다 (D-TOK-1).');
  console.error('  web/js/core/contrast.js 의 파생이 닿지 못하는 팔레트라는 뜻입니다.');
  process.exit(1);
}

console.log(`contrast ok (테마 ${names.length}종 × 토큰 ${CHECK.length + CSS_TOKENS.length + SYNTAX_TOKENS.length}개 × 배경 3, 바닥 미달 0)`);

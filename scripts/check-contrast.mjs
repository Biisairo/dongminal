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
  const d = deriveContrastTokens(t.ui, t.mode);
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

console.log(`contrast ok (테마 ${names.length}종 × 토큰 ${CHECK.length}개 × 배경 3, 바닥 미달 0)`);

#!/usr/bin/env node
/**
 * 킷 컴포넌트가 **다시 갈라지지 않는가** (KIT_COMPONENTS_SRS FR-CMP-91).
 *
 * B2 의 검사 둘은 *"킷을 달았는가"* 를 물었다. 이 묶음의 결손은 **달 킷이 없던**
 * 자리였으므로 그 물음에 걸리지 않았다. 여기서 묻는 것은 다른 것이다 —
 * **"같은 역할을 하는 자리가 킷 밖에서 자기 값으로 그려지는가"**.
 *
 * ## 한 검사에 몰지 않는다 (D-CMP-5)
 *
 * 여덟 컴포넌트를 한 물음으로 묶으면 실패 메시지가 *"어딘가 킷을 안 썼다"* 가
 * 되어 고칠 자리를 말하지 못한다. 그래서 **규칙마다 이름과 이유를 갖는다.**
 *
 * ## 셀 수 있는 것만 센다 (FR-CMP-91)
 *
 * "이 요소가 의미상 스위치인가" 는 CSS 가 답할 수 없다. 답할 수 있는 것은
 * *"킷이 소유한 값을 킷 밖에서 다시 적는가"* 이고, 그것만 센다.
 *
 * 사용: node scripts/check-kit-components.mjs [--list]
 */
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

const ROOT = 'web';
const KIT_FILE = 'web/style-kit.css';

/**
 * 규칙: 이름 · 무엇을 찾는가 · 왜.
 *
 * `sel` 은 **킷 클래스를 쓰는 선택자**이고, 그 선택자가 킷 파일 **밖**에서
 * `props` 를 적으면 킷을 덮는 것이다 — 킷은 `<link>` 순서상 먼저 오므로
 * 덮으면 컴포넌트가 아무 일도 하지 않는다 (FR-UIK-1).
 */
const RULES = [
  { name: '스위치', cls: 'ui-switch', props: ['width', 'height', 'background', 'border'],
    why: '크기·색을 밖에서 적으면 세 모양으로 다시 갈린다 (FR-CMP-20)' },
  { name: '키캡', cls: 'ui-key', props: ['height', 'padding', 'background', 'border', 'font-size'],
    why: '키캡이 두 벌이 된다 — 착수 시 `.sc-key` 와 `kbd` 가 그랬다 (FR-CMP-10)' },
  { name: '알림', cls: 'ui-notice', props: ['padding', 'font-size'],
    why: '여백·글자가 갈리면 같은 층위의 알림이 다른 층위로 읽힌다 (FR-CMP-50)' },
  { name: '빈 상태', cls: 'ui-empty', props: ['padding', 'font-size'],
    why: '정렬·등급·정보량이 자리마다 달라진다 (FR-CMP-60)' },
  { name: '세그먼트', cls: 'ui-segment', props: ['border-radius'],
    why: '붙은 모서리를 밖에서 적으면 자리마다 다른 덩이가 된다 (FR-CMP-40)' },
  { name: '분할 버튼', cls: 'ui-split', props: ['border-radius', 'gap'],
    why: '§7.5 가 "이름이 아니라 자리다" 로 남겨 두 벌이 됐던 자리다 (FR-CMP-70)' },
  { name: '배지', cls: 'ui-badge', props: ['min-width', 'padding', 'border-radius', 'font-size'],
    why: '개수 표기가 다시 넷으로 갈린다 (FR-CMP-81)' },
  { name: '섹션 머리글', cls: 'ui-section-head', props: ['font-size', 'font-weight', 'color'],
    why: '머리글이 자리마다 다른 무게로 선다 (FR-CMP-30)' },
];

if (process.argv.includes('-h') || process.argv.includes('--help')) {
  console.log(`킷 컴포넌트 검사

  킷이 소유한 값을 킷 밖에서 다시 적는 자리를 찾는다. 규칙 ${RULES.length}개:
${RULES.map((r) => `    .${r.cls} — ${r.props.join(' · ')}`).join('\n')}

  --list  규칙별로 찾은 자리를 전부 찍는다.`);
  process.exit(0);
}

const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, ' ');

function cssFiles(dir, out = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) { if (e !== 'vendor') cssFiles(p, out); continue; }
    if (e.endsWith('.css')) out.push(p);
  }
  return out;
}

/**
 * `:not(.ui-switch)` 처럼 **비켜 가는** 선택자는 그 이름을 쓰는 것이 아니다.
 * 첫 판이 그 구분 없이 세어 전역 체크박스 규칙 13개를 오탐으로 올렸다 — 그
 * 규칙은 오히려 킷에게 자리를 내주려고 `:not()` 을 단 것이다.
 */
const usesClass = (sel, cls) => {
  const bare = sel.replace(/:not\([^)]*\)/g, ' ');
  return new RegExp(`\\.${cls}(?![\\w-])`).test(bare);
};

const rules = [];
for (const f of cssFiles(ROOT)) {
  for (const m of strip(readFileSync(f, 'utf8')).matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
    const sel = m[1].trim().replace(/\s+/g, ' ');
    if (!sel || sel.startsWith('@')) continue;
    rules.push({ f, sel, decls: m[2] });
  }
}

// M6 §4-A-1: **아무것도 재지 않는 검사**를 만들지 않는다.
const kitRules = rules.filter((r) => r.f === KIT_FILE);
if (rules.length < 100 || kitRules.length < 20) {
  console.error(`규칙 ${rules.length}개(킷 ${kitRules.length})밖에 못 읽었다 — 검사가 공회전한다.`);
  process.exit(1);
}
// 컴포넌트가 실제로 킷에 있는지부터 본다 — 없는 것을 감시하면 언제나 초록이다.
const missing = RULES.filter((R) => !kitRules.some((r) => usesClass(r.sel, R.cls)));
if (missing.length) {
  console.error(`✗ 킷에 없는 컴포넌트를 감시하고 있다: ${missing.map((m) => '.' + m.cls).join(' · ')}`);
  process.exit(1);
}

const bad = [];
for (const R of RULES) {
  for (const r of rules) {
    if (r.f === KIT_FILE || !usesClass(r.sel, R.cls)) continue;
    for (const p of R.props) {
      if (new RegExp(`(^|;)\\s*${p}\\s*:`).test(r.decls)) bad.push({ R, r, p });
    }
  }
}

if (process.argv.includes('--list')) {
  for (const R of RULES) {
    const hits = rules.filter((r) => r.f !== KIT_FILE && usesClass(r.sel, R.cls));
    console.log(`.${R.cls} — 킷 밖에서 이 이름을 쓰는 규칙 ${hits.length}개`);
    for (const h of hits) console.log(`    ${h.f}: ${h.sel}`);
  }
  console.log();
}

if (bad.length) {
  console.error(`✗ 킷이 소유한 값을 킷 밖에서 다시 적는 자리 ${bad.length}개 (FR-CMP-91)`);
  for (const b of bad) console.error(`    [${b.R.name}] ${b.r.f}: ${b.r.sel} — ${b.p}\n        ${b.R.why}`);
  console.error('');
  console.error('  킷은 <link> 순서상 먼저 옵니다 (FR-UIK-1) — 밖에서 덮으면 컴포넌트가');
  console.error('  아무 일도 하지 않습니다. 값을 걷거나, 뜻이 다르면 다른 이름을 쓰세요.');
  process.exit(1);
}
console.log(`✓ 킷 컴포넌트 ${RULES.length}종이 자기 값을 소유한다 — 밖에서 덮는 자리 0 (FR-CMP-91)`);

#!/usr/bin/env node
/**
 * 간격이 **토큰에서 오는가** (REFACTOR3_FE_REST4_SRS FR-FR4-17 / PROD3 FU-10).
 *
 * 착수 시 간격 속성의 px 리터럴이 870개 · 값 스무 가지였다. 글자 크기·모서리와
 * 같은 이유로 종수가 아니라 **리터럴이 남았는가**를 잰다. 단은 `style.css` 의
 * `:root` 가 갖는 `--sp-1`~`--sp-8` 여덟이다 (D-FR4-15).
 *
 * ## 무엇을 리터럴로 보는가
 *
 * 간격 속성(`gap`·`row-gap`·`column-gap`·`padding*`·`margin*`) 값 안의 `Npx` 는
 * 함수 안이라도 리터럴이다. 늘 허용하는 것은 셋이다 (D-FR4-18):
 *   `0`·`1px`(선과 짝인 값) · 음수(이웃을 되먹는 여백) · `env()` 의 `0px`(대체값 0)
 * 그 밖은 아래 예외 표에 **파일·선택자·속성·값**으로 있어야 한다 (D-FR4-21).
 * 줄 번호를 열쇠로 쓰지 않는다 — 다른 규칙을 고칠 때마다 밀린다.
 *
 * 사용: node scripts/check-spacing.mjs [--list]
 */
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const CSS_DIR = 'web';

/** 예외 표 — SRS 부록 B 와 같은 스무 줄이다. 줄마다 사유를 적는다. */
const EXCEPT = [
  { f: 'style-main-panel.css', sel: '.ui-panel[data-rail] .sb-tab-badge', prop: 'padding', v: '3px', why: '레일 아이콘 귀퉁이의 12px 배지' },
  { f: 'style-activity.css', sel: '#agents-panel[data-rail] .ag-tab-n', prop: 'padding', v: '3px', why: '작업 패널 레일의 12px 배지' },
  { f: 'style-activity.css', sel: '#agents-panel[data-rail] :is(.ag-card,.bg-row,.runs-row)', prop: 'padding', v: '3px', why: '레일 40px 안의 이름 두 줄 — 좌우 1px 이 글자 폭을 가른다' },
  { f: 'style-main-panel.css', sel: '#sidebar[data-rail] .chat-row', prop: 'padding', v: '3px', why: '레일 40px 안의 이름 두 줄 — 창 목록(.sbl-item)의 옛 여백 3px 을 따랐다 (RAIL_CHAT_USAGE_SRS FR-RCU-2)' },
  { f: 'style-main-panel.css', sel: '#add-sandbox-window', prop: 'padding', v: '5px', why: '`#add-window` 의 padding-right 와 실측(상자 48px + right:5px)으로 묶였다' },
  { f: 'style-main-panel.css', sel: '#add-window', prop: 'padding-right', v: '60px', why: '±2px 안에 단이 없다 — 안쪽 상자의 자리' },
  { f: 'style-activity.css', sel: '.chat-person', prop: 'padding-left', v: '20px', why: '±2px 안에 단이 없다 (들여쓰기)' },
  { f: 'style-activity.css', sel: '.cacct', prop: 'padding', v: '44px', why: '±2px 안에 단이 없다 — 색 막대 칸(40px)에 맞춘 열' },
  { f: 'style-activity.css', sel: '.act-usage-sl-h,.act-usage-sl', prop: 'padding-left', v: '44px', why: '`.cacct` 와 같은 열' },
  { f: 'style-docrender.css', sel: '.dr-body', prop: 'padding', v: '20px', why: '±2px 안에 단이 없다' },
  { f: 'style-docrender.css', sel: '.dr-body', prop: 'padding', v: '40px', why: '±2px 안에 단이 없다 (문서 끝 여백)' },
  { f: 'style-git-tabs.css', sel: '.git-br-pfx-head', prop: 'padding-left', v: '20px', why: '±2px 안에 단이 없다 (브랜치 트리 들여쓰기)' },
  { f: 'style-git-tabs.css', sel: '.git-br-pfx-body>.git-br-row', prop: 'padding-left', v: '44px', why: '위와 같다' },
  { f: 'style-git-tabs.css', sel: '.git-br-group-body>.git-br-row', prop: 'padding-left', v: '28px', why: '위와 같다' },
  { f: 'style-status.css', sel: '.confirm-box', prop: 'padding', v: '20px', why: '±2px 안에 단이 없다' },
  { f: 'style-system.css', sel: '.fe-error', prop: 'padding', v: '20px', why: '±2px 안에 단이 없다' },
  { f: 'style-system.css', sel: '.boot-name', prop: 'margin-top', v: '20px', why: '±2px 안에 단이 없다' },
  { f: 'style-kit.css', sel: '.ui-badge', prop: 'padding', v: 'calc(3px * var(--fs-scale))', why: '배지 지름과 함께 글자 배율을 탄다' },
  { f: 'style-system.css', sel: '.file-editor:has(> .fe-offer) > .cm-editor', prop: 'margin-top', v: 'var(--fe-offer-h,32px)', why: '제안 줄 높이의 대체값 — 간격의 단이 아니다' },
];

if (process.argv.includes('-h') || process.argv.includes('--help')) {
  console.log(`간격 토큰 검사

  web/*.css 의 gap·row-gap·column-gap·padding*·margin* 값에 px 리터럴이 남았는지 본다.
  var(--sp-1..8) 이어야 한다 (FR-FR4-17). 늘 허용: 0 · 1px · 음수 · env() 의 0px.
  그 밖은 이 파일의 예외 표(${EXCEPT.length}줄)에 있어야 한다.

  --list  예외 표를 찍는다.`);
  process.exit(0);
}

const PROP = /^(gap|row-gap|column-gap|padding(-[a-z]+)*|margin(-[a-z]+)*)$/;
/** 주석은 공백으로만 지운다 — 줄 번호가 밀리지 않게 (check-font-size.mjs 와 같다). */
const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));

/** 블록마다 선택자와 간격 선언을 읽는다. 값은 최상위 공백으로 가른다 — 함수는 한 덩이다. */
function decls(src) {
  const out = []; const stack = []; let start = 0;
  for (let i = 0; i < src.length; i++) {
    if (src[i] === '{') { stack.push(src.slice(start, i).trim().replace(/\s+/g, ' ')); start = i + 1; continue; }
    if (src[i] !== '}') continue;
    const sel = stack.pop();
    let off = start;
    for (const part of src.slice(start, i).split(';')) {
      const m = part.match(/^\s*([a-z-]+)\s*:\s*([\s\S]*?)\s*$/);
      if (m && PROP.test(m[1])) {
        const toks = []; let depth = 0, cur = '';
        for (const ch of m[2] + ' ') {
          if (/\s/.test(ch) && depth === 0) { if (cur) toks.push(cur); cur = ''; continue; }
          if (ch === '(') depth++;
          if (ch === ')') depth--;
          cur += ch;
        }
        out.push({ sel, prop: m[1], value: m[2], toks, line: src.slice(0, off + part.match(/^\s*/)[0].length).split('\n').length });
      }
      off += part.length + 1;
    }
    start = i + 1;
  }
  return out;
}

/** 늘 허용하는 토큰인가 (D-FR4-18). */
const allowed = (t) => !/\dpx/.test(t.replace(/env\([^)]*,\s*0px\)/g, ''))
  || /^(0|1px|-\d+(\.\d+)?px)$/.test(t);

const files = readdirSync(CSS_DIR).filter((f) => f.endsWith('.css')).sort();
const bad = [];
const used = new Set();
let total = 0;

for (const f of files) {
  for (const d of decls(strip(readFileSync(join(CSS_DIR, f), 'utf8')))) {
    total++;
    for (const t of d.toks) {
      if (allowed(t)) continue;
      const i = EXCEPT.findIndex((e) => e.f === f && e.sel === d.sel && e.prop === d.prop && e.v === t);
      if (i >= 0) { used.add(i); continue; }
      bad.push(`  ${join(CSS_DIR, f)}:${d.line}  ${d.sel} { ${d.prop}:${d.value} } — ${t}`);
    }
  }
}

// M6 §4-A-1: 아무것도 재지 않는 검사를 만들지 않는다 (착수 시 간격 선언 757개).
if (total < 600) {
  console.error(`간격 선언을 ${total}개밖에 못 읽었다 — 검사가 공회전한다.`);
  process.exit(1);
}

if (process.argv.includes('--list')) {
  for (const e of EXCEPT) console.log(`  ${e.f}  ${e.sel} { ${e.prop}: ${e.v} } — ${e.why}`);
  console.log();
}

const dead = EXCEPT.filter((_, i) => !used.has(i));
if (bad.length || dead.length) {
  if (bad.length) {
    console.error(`간격에 px 리터럴이 남았다 (${bad.length}곳, FR-FR4-17):`);
    console.error(bad.join('\n'));
    console.error('\n  var(--sp-1..8) 을 쓰세요 (2·4·6·8·10·12·16·24px). 붙이기 규칙은 REFACTOR3_FE_REST4_SRS D-FR4-16,');
    console.error('  단에 맞지 않아야 하는 값은 이 파일의 예외 표에 사유와 함께 더합니다.');
  }
  if (dead.length) {
    console.error(`예외 표에 CSS 에 없는 항목이 있다 (${dead.length}줄) — 지우세요:`);
    for (const e of dead) console.error(`  ${e.f}  ${e.sel} { ${e.prop}: ${e.v} }`);
  }
  process.exit(1);
}

console.log(`spacing ok (간격 선언 ${total}개 · 예외 ${EXCEPT.length})`);

#!/usr/bin/env node
/**
 * `<button>` 이 **킷 등급을 받았는가** (KIT_APPLICATION_SRS FR-KIT-21).
 *
 * ## 왜 새 검사가 필요한가
 *
 * `DESIGN_TOKENS_SRS` §7.6 의 잔여표가 이미 이 일을 하려 했으나 **세는 방법이
 * 틀렸다**: 채우는 규칙이 *"키트 클래스와 **함께 붙는** 옛 클래스를 열거한다"*
 * 이므로 **한 번도 병기되지 않은 것을 못 본다.** 그래서 표는 "탭 넷만 남았다"
 * 고 말하는 동안 실제로는 여섯 종 98개가 남아 있었다 (감사 `AUDIT-uiux.md` §5A.5).
 *
 * 이 검사는 반대로 센다 — **`<button>` 인데 킷 등급이 없는 것 전부**.
 *
 * ## 세는 자리 셋
 *
 *   ① `web/**\/*.html` 의 `<button …>`
 *   ② `web/js/**` 템플릿 리터럴 안의 `<button …>`
 *   ③ `web/js/**` 의 `createElement('button')` — 같은 문 또는 **이어지는 3줄**
 *      안에서 킷 등급이 서는지 본다
 *
 * ③ 의 창(3줄)은 한계이고 **게이트가 그것을 적는다** (FR-KIT-21b): 창을 넘겨
 * 클래스를 세우는 자리는 오탐으로 잡히며, 그 자리는 **코드를 게이트에 맞춘다**
 * (만들자마자 클래스를 세운다). 게이트를 넓히지 않는다 (규약 2).
 *
 * 사용: node scripts/check-button-kit.mjs [--list]
 */
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

const ROOT = 'web';
/**
 * 킷 등급. `.ui-btn` 계열 · `.ui-tab` · `.ui-key` 이며 **셋 다 포커스 링을 갖는다**.
 *
 * `.ui-key` 가 늦게 들어왔다 (KIT_COMPONENTS_SRS FR-CMP-14). 그 자리는 실제로
 * `<button>` 이지만 **키캡 표시**라 `ui-btn` 을 달면 뜻이 틀린다 — 그래서 한동안
 * 이 검사의 예외였고, 킷이 `.ui-key` 를 갖게 되면서 예외가 **해소됐다**.
 * 검사를 느슨하게 만든 것이 아니라 **셀 대상이 늘어난 것**이다 (규약 2).
 */
const KIT = /\bui-(?:btn|tab|key)\b/;
/** 같은 문이 아니어도 봐 주는 창 (FR-KIT-21b). */
const WINDOW = 3;

/**
 * 예외 (SRS §6-예외표와 짝이다). **재검토 조건 없는 예외는 예외가 아니다**
 * (FR-A11Y-24).
 */
const EXEMPT = [
  { at: 'web/js/ui/ui-kit.js', why: '킷 자신이 버튼을 만드는 자리 — 등급을 붙이는 쪽이다',
    until: '없어지지 않는다 (킷의 정의)' },
  // 줄 번호는 `index.html` 이 자라면 함께 움직인다 — FR-WRD-35 의 주석 두 줄이
  // 336 → 338 로 밀었고, FR-ACT-1 이 `#attn-center` 를 걷으면서 338 → 337 로
  // 되밀었다. UIUX_OVERHAUL_SRS FR-CHR-8 (D-6) 이 상단바를 되살리며 338 → 340,
  // SLOT_MARKER_SRS FR-SMK-1 의 마커 그릇과 그 주석이 340 → 346.
  { at: 'web/index.html', line: 346,
    why: '`role="switch"` — 토글 스위치이지 버튼이 아니다',
    until: '묶음 B3 이 킷에 `.ui-switch` 를 세우면' },
  // 줄 번호는 파일이 자라면 함께 움직인다 — UX_BATCH10_SRS FR-UXB-44 가 덩이를
  // 이름 있게 꺼내면서(`ED_FIND_MIXIN`) 머리 주석 열 줄이 61 → 71 로 밀었다.
  { at: 'web/js/ui/file-editor-find.js', line: 71,
    why: '`.fe-find-opt` 는 `.on` 상태를 가진 글자 토글 — DESIGN_TOKENS_SRS §7.4 가 "이 표의 행이 아니다" 로 판정했다',
    until: '그 판정이 뒤집히면' },
];

if (process.argv.includes('-h') || process.argv.includes('--help')) {
  console.log(`버튼 킷 등급 검사

  web/** 의 <button> 이 ui-btn 계열 또는 ui-tab 을 갖는지 본다.
  세는 자리: HTML · JS 템플릿 리터럴 · createElement('button').

  --list  자리를 판정과 함께 전부 찍는다.`);
  process.exit(0);
}

function walk(dir, exts, out = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) { if (e !== 'vendor') walk(p, exts, out); continue; }
    if (exts.some((x) => e.endsWith(x))) out.push(p);
  }
  return out;
}

const files = walk(ROOT, ['.html', '.js', '.mjs']).filter((f) => !f.includes('/test/'));
/** 파일 전체이거나(줄 없음) 그 한 줄이다 — 예외는 **좁을수록 좋다**. */
const exemptOf = (f, line) => EXEMPT.find((e) => e.at === f && (e.line === undefined || e.line === line));

const sites = [];   // {file, line, kind, text, ok}
for (const f of files) {
  const lines = readFileSync(f, 'utf8').split('\n');
  lines.forEach((l, i) => {
    // ①② `<button …>` — HTML 과 템플릿 리터럴이 같은 모양이다.
    for (const m of l.matchAll(/<button\b[^>]*>/g)) {
      sites.push({ file: f, line: i + 1, kind: '태그', text: m[0].slice(0, 90), ok: KIT.test(m[0]) });
    }
    // ③ `createElement('button')` — 창 안에서 등급이 서는가.
    if (!/createElement\(\s*['"]button['"]\s*\)/.test(l)) return;
    const win = lines.slice(i, i + 1 + WINDOW).join('\n');
    sites.push({ file: f, line: i + 1, kind: '생성', text: l.trim().slice(0, 90), ok: KIT.test(win) });
  });
}

// M6 §4-A-1: **아무것도 재지 않는 검사**를 만들지 않는다.
if (sites.length < 50) {
  console.error(`버튼 자리를 ${sites.length}개밖에 못 읽었다 — 검사가 공회전한다.`);
  process.exit(1);
}

const skipped = sites.filter((s) => !s.ok && exemptOf(s.file, s.line));
const bad = sites.filter((s) => !s.ok && !exemptOf(s.file, s.line));

if (process.argv.includes('--list')) {
  for (const s of sites) console.log(`${s.ok ? '킷  ' : exemptOf(s.file, s.line) ? '예외' : '✗   '} ${s.file}:${s.line} [${s.kind}] ${s.text}`);
  console.log();
}

// FR-KIT-20c 와 같은 규약: **건너뛴 수를 찍는다.**
if (skipped.length) {
  console.log(`  예외 ${skipped.length}자리 (SRS §6-예외표):`);
  for (const e of EXEMPT) console.log(`    ${e.at}${e.line ? ':' + e.line : ''} — ${e.why} · 언제까지: ${e.until}`);
}

if (bad.length) {
  console.error(`✗ 킷 등급이 없는 버튼 ${bad.length}자리 — 포커스 링도 크기도 킷 밖이다 (FR-KIT-21)`);
  for (const s of bad) console.error(`    ${s.file}:${s.line} [${s.kind}] ${s.text}`);
  console.error('');
  console.error('  ui-btn(+-sm/-lg/-icon/-ghost/-primary/-danger) 또는 ui-tab 을 **옛 이름과 함께** 다세요 (D-5 / FR-KIT-18a).');
  console.error(`  createElement 는 만들자마자 ${WINDOW}줄 안에 등급을 세우세요 — 창을 넓히지 않습니다 (FR-KIT-21b).`);
  process.exit(1);
}

console.log(`✓ 버튼 ${sites.length}자리 전부 킷 등급을 갖는다 — 예외 ${skipped.length} (FR-KIT-21)`);

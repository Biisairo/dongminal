#!/usr/bin/env node
/**
 * 복사가 **한 자리를 지나는가** (STRUCTURE_CLEANUP_SRS FR-STR-17).
 *
 * ## 왜 새 검사가 필요한가
 *
 * OS 클립보드에 쓰는 일은 **환경이 세 갈래로 가른다** — secure context 에서만
 * 있는 `navigator.clipboard`, 제스처를 요구하는 `document.execCommand('copy')`,
 * 그리고 둘 다 실패했을 때 사용자의 클릭을 빌리는 복사창이다
 * (`EXPLORER_TRANSFER_IGNORE_SRS` FR-ETR-40 · D-12).
 *
 * 그 3단은 2026-09-15 에 이미 섰는데 **이름이 `TermClipboard` 였다.** 그래서
 * 다음 네 자리가 그것을 못 보고 각자 1단이나 2단만 다시 만들었고, 그중
 * `app-tool.js` 는 1단만 있어서 **비보안 컨텍스트에서 버튼이 조용히 아무 일도
 * 안 했다** (`navigator.clipboard` 가 아예 없어 `TypeError` 가 나고 빈
 * `catch{}` 가 삼킨다).
 *
 * 그 파일의 `_execCopy` 주석은 *"Git 패널의 `_copyFallback` 과 같은 수법"* 이라
 * 스스로 적고 있었다 — **알면서 다섯 번째를 만들었다.** 주석은 다음 사람을
 * 막지 못한다. 검사는 막는다.
 *
 * ## 세는 자리 둘
 *
 *   ① `document.execCommand('copy')` / `execCommand("copy")`
 *   ② `navigator.clipboard.writeText`
 *
 * **읽기(`readText`)는 대상이 아니다** (FR-STR-18). 브라우저가 주지 않는 것에는
 * 폴백이 없다 — 3단이 성립하지 않는 물음이므로 같은 잣대로 잴 수 없다.
 *
 * 사용: node scripts/check-clipboard.mjs [--list]
 */
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

const ROOT = 'web/js';
/** 3단이 사는 자리. **여기서만** 두 API 를 직접 부른다. */
const HELPER = 'web/js/ui/clipboard.js';

/** ① 2단 · ② 1단. 둘 다 "쓰기" 다. */
const TIERS = [
  { key: '2단', re: /execCommand\(\s*['"]copy['"]\s*\)/ },
  { key: '1단', re: /navigator\.clipboard\.writeText/ },
];

/**
 * 예외 (SRS §6-예외표와 짝이다). **재검토 조건 없는 예외는 예외가 아니다**
 * (FR-A11Y-24).
 */
const EXEMPT = [
  { at: HELPER, why: '복사를 **정의하는 쪽**이다 — 3단이 여기 산다 (S-1)',
    until: '없어지지 않는다' },
];

if (process.argv.includes('-h') || process.argv.includes('--help')) {
  console.log(`클립보드 단일 경로 검사

  web/js 에서 execCommand('copy') 와 navigator.clipboard.writeText 를
  부르는 자리가 ${HELPER} 밖에 없는지 본다.
  읽기(readText)는 대상이 아니다 — 폴백이 성립하지 않는 물음이다 (FR-STR-18).

  --list  자리를 전부 찍는다.`);
  process.exit(0);
}

function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) { if (e !== 'vendor' && e !== 'test') walk(p, out); continue; }
    if (e.endsWith('.js')) out.push(p);
  }
  return out;
}

const sites = [];   // {file, line, tier, text}
for (const f of walk(ROOT)) {
  readFileSync(f, 'utf8').split('\n').forEach((l, i) => {
    // 주석 줄은 세지 않는다 — 이 파일들의 주석이 API 이름을 자주 든다.
    if (/^\s*(\/\/|\*|\/\*)/.test(l)) return;
    for (const t of TIERS) if (t.re.test(l)) sites.push({ file: f, line: i + 1, tier: t.key, text: l.trim().slice(0, 90) });
  });
}

// M6 §4-A-1: **아무것도 재지 않는 검사**를 만들지 않는다.
// 바닥은 자리 수가 아니라 **3단이 실제로 그 파일에 있는가**다 — 옮긴 뒤에는
// 헬퍼 밖의 자리가 0이 되므로 수를 세면 검사가 공회전한다.
const inHelper = sites.filter((s) => s.file === HELPER);
if (!TIERS.every((t) => inHelper.some((s) => s.tier === t.key))) {
  console.error(`✗ ${HELPER} 에 1단·2단이 둘 다 있지 않다 — 검사가 공회전한다.`);
  console.error(`    찾은 것: ${inHelper.map((s) => s.tier).join(' ') || '(없음)'}`);
  process.exit(1);
}

const exemptOf = (f) => EXEMPT.find((e) => e.at === f);
const bad = sites.filter((s) => !exemptOf(s.file));

if (process.argv.includes('--list')) {
  for (const s of sites) console.log(`${exemptOf(s.file) ? '예외' : '✗   '} ${s.file}:${s.line} [${s.tier}] ${s.text}`);
  console.log();
}

// FR-KIT-20c 와 같은 규약: **건너뛴 수를 찍는다.**
console.log(`  예외 ${inHelper.length}자리 (SRS §6-예외표):`);
for (const e of EXEMPT) console.log(`    ${e.at} — ${e.why} · 언제까지: ${e.until}`);

if (bad.length) {
  console.error(`✗ 복사 API 를 직접 부르는 자리 ${bad.length}곳 — 3단이 서지 않는다 (FR-STR-17)`);
  for (const s of bad) console.error(`    ${s.file}:${s.line} [${s.tier}] ${s.text}`);
  console.error('');
  console.error('  `ClipboardWriter.write(text)` 를 쓰세요 — 1단·2단·복사창까지 내려가고 성공 여부를 돌려줍니다 (FR-ETR-40).');
  console.error('  읽기는 대상이 아닙니다 (FR-STR-18).');
  process.exit(1);
}

console.log(`✓ 복사가 ${HELPER} 한 자리를 지난다 — 직접 호출 0 (FR-STR-17)`);

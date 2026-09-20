#!/usr/bin/env node
/**
 * **비우고 다시 그리는 자리가 전부 판정을 받았는가** (PERFORMANCE_HARDENING_SRS FR-PRF-13).
 *
 * ## 왜 판정이 아니라 등록부인가
 *
 * `web/js/ui/repaint.js` 머리말이 규칙을 적는다 — *"목록을 `innerHTML=''` 로 비우고
 * 다시 만드는 것은 **사용자가 부른 다시 그리기에서만** 옳다"*. 즉 이 모양 자체는
 * 결함이 아니고, **계기**가 결함을 만든다.
 *
 * 그 계기는 **호출 사슬을 따라가야** 알 수 있고 파싱으로 파생되지 않는다.
 * `STRUCTURE_CLEANUP_SRS` D-STR-6 이 B5 에서 이 행을 넘긴 이유가 그것이며,
 * SRS §2.2 의 실측이 그 사실을 확인했다 — **감사가 폴링이라고 든 여섯 중 셋이
 * 폴링이 아니었다.** 감사는 `innerHTML=''` 라는 **모양**으로 골랐다.
 *
 * 그래서 이 검사가 묻는 것은 *"이 자리가 옳은가"* 가 아니라
 * **"이 자리가 판정을 받았는가"** 다 (D-PRF-2). 목록은 `PERFORMANCE_BUDGET.md`
 * §2-5 가 갖고, 여기서는 **집합의 일치**만 본다. 새 자리를 만든 사람은 등록하면서
 * 계기를 적어야 하고, 그 커밋이 "여기서 비우고 다시 그리기 시작했다" 를 말한다.
 *
 * **판단을 자동화하지 않고 강제한다.**
 *
 * ## 세는 방법
 *
 *   ① `web/js`(vendor·test 제외)의 `.js` 를 읽는다
 *   ② `X.innerHTML=''` 꼴을 찾는다. **주석 줄은 세지 않는다** (FR-PRF-14) —
 *      지금 넷이 주석이고 그중 셋은 **이미 고친 자리의 기록**이다
 *   ③ 자리의 이름은 `파일 | 함수 | 대상` 셋이다. 줄 번호는 쓰지 않는다 —
 *      위아래로 밀리는 것마다 등록부를 고치게 되면 아무도 읽지 않는 표가 된다
 *
 * 사용: node scripts/check-repaint.mjs [--list]
 */
import { readdirSync, statSync, readFileSync } from 'fs';
import { join } from 'path';

const ROOT = 'web/js';
const DOC = 'docs/internal/PERFORMANCE_BUDGET.md';
/** 세지 않는 디렉터리 (SRS §6-예외표 P-1). */
const SKIP_DIRS = new Set(['vendor', 'test']);
/** 계기의 값 — 등록부가 이 셋 밖을 적으면 실패한다. */
const WHY = new Set(['사용자', '가드', '폴링']);

if (process.argv.includes('-h') || process.argv.includes('--help')) {
  console.log(`비우고 다시 그리는 자리의 등록부 검사

  web/js 의 \`X.innerHTML=''\` 자리 집합이 ${DOC}
  §2-5 의 등록부와 정확히 같은지 본다.

  계기는 셋 중 하나다:
    사용자  사용자가 연/친 것이 계기다 — repaint.js 규약이 허용하는 쪽
    가드    계기는 폴링·관측이지만 근거 가드 뒤라 값이 그대로면 그리지 않는다
    폴링    계기가 폴링·관측이고 가드가 없다 — **갚아야 할 빚이다**

  --list  지금 자리를 등록부 표 꼴로 찍는다 (그대로 붙여 넣을 수 있다)`);
  process.exit(0);
}

function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) { if (!SKIP_DIRS.has(e)) walk(p, out); continue }
    if (e.endsWith('.js')) out.push(p);
  }
  return out;
}

/** `X.innerHTML=''` 의 **대상**. 점·괄호·대괄호를 포함한 왼쪽 표현 전부다. */
const SITE = /((?:[\w$.]|\[[^\]]*\]|\([^)]*\))+)\s*\.innerHTML\s*=\s*(?:""|'')/;
/**
 * 메서드·함수 정의 줄. **여는 중괄호로 끝나는 것만** 본다 — 호출은 그렇지 않다
 * (`paintIfChanged(el, sig, () => {` 이 첫 판에서 정의로 잡혔다).
 */
const DEF = /^ {0,4}(?:static\s+)?(?:async\s+)?(?:function\s+)?([_A-Za-z][\w$]*)\s*\([^)]*\)\s*\{\s*$/;
const COMMENT = /^\s*(\*|\/\/|\/\*)/;
const BLOCK = /^\s*(if|for|while|switch|catch|else)\b/;

/** 지금 코드의 자리 — `파일 | 함수 | 대상` → 수. */
function scan() {
  const found = new Map();
  for (const f of walk(ROOT).sort()) {
    const lines = readFileSync(f, 'utf8').split('\n');
    lines.forEach((line, i) => {
      const m = line.match(SITE);
      if (!m || COMMENT.test(line)) return;
      let owner = '?';
      for (let j = i; j >= 0; j--) {
        const d = lines[j].match(DEF);
        if (d && !BLOCK.test(lines[j])) { owner = d[1]; break }
      }
      const key = `${f} | ${owner} | ${m[1]}`;
      found.set(key, (found.get(key) || 0) + 1);
    });
  }
  return found;
}

/** 등록부 — `| \`파일\` | \`함수\` | \`대상\` | 수 | 계기 | 근거 |` 꼴의 표 행. */
const ROW = /^\|\s*`([^`]+)`\s*\|\s*`([^`]+)`\s*\|\s*`([^`]+)`\s*\|\s*(\d+)\s*\|\s*([^|]+?)\s*\|/;
function registry() {
  const out = new Map();
  const bad = [];
  for (const line of readFileSync(DOC, 'utf8').split('\n')) {
    const m = line.match(ROW);
    if (!m) continue;
    const key = `${m[1]} | ${m[2]} | ${m[3]}`;
    if (!WHY.has(m[5])) bad.push(`${key} — 계기 "${m[5]}"`);
    out.set(key, { n: +m[4], why: m[5] });
  }
  return { out, bad };
}

const found = scan();
const total = [...found.values()].reduce((a, b) => a + b, 0);

// M6 §4-A-1: **아무것도 재지 않는 검사**를 만들지 않는다.
if (total < 20) {
  console.error(`자리를 ${total}개밖에 못 읽었다 — 검사가 공회전한다.`);
  process.exit(1);
}

const table = [...found].sort().map(([k, n]) => {
  const [f, fn, tgt] = k.split(' | ');
  return `| \`${f}\` | \`${fn}\` | \`${tgt}\` | ${n} | 사용자 | (적으세요) |`;
});

if (process.argv.includes('--list')) {
  console.log(table.join('\n'));
  process.exit(0);
}

const { out: reg, bad } = registry();
if (!reg.size) {
  console.error(`✗ ${DOC} 에서 등록부를 못 읽었다 — 검사가 공회전한다.`);
  console.error('  §2-5 에 이 꼴의 표가 있어야 한다:');
  console.error('    | `web/js/…​.js` | `_paintRows` | `box` | 1 | 폴링 | … |');
  process.exit(1);
}

const missing = [];  // 코드에 있는데 등록부에 없다
const stale = [];    // 등록부에 있는데 코드에 없다
const count = [];    // 수가 다르다
for (const [k, n] of found) {
  const r = reg.get(k);
  if (!r) { missing.push(`${k}  (${n})`); continue }
  if (r.n !== n) count.push(`${k}  등록 ${r.n} → 실제 ${n}`);
}
for (const k of reg.keys()) if (!found.has(k)) stale.push(k);

if (missing.length || stale.length || count.length || bad.length) {
  console.error(`✗ 비우고 다시 그리는 자리가 등록부와 어긋난다 (FR-PRF-13 · ${DOC} §2-5):`);
  if (missing.length) {
    console.error('\n  등록되지 않은 자리:');
    for (const s of missing) console.error(`    ${s}`);
    console.error('\n  **계기를 판정해서 등록하세요.** 파싱은 모양까지 가고 계기까지 가지');
    console.error('  못합니다 (D-PRF-2) — 사용자가 부른 그리기인지, 폴링인지, 가드 뒤인지는');
    console.error('  부르는 쪽을 읽어야 압니다. 그 판정이 이 게이트가 요구하는 전부입니다.');
  }
  if (stale.length) {
    console.error('\n  코드에 없는데 등록부에 남은 자리:');
    for (const s of stale) console.error(`    ${s}`);
    console.error('\n  고쳐서 없앴다면 등록부에서도 지우세요 — 낡은 등록부는 없는 것보다 나쁩니다.');
  }
  if (count.length) {
    console.error('\n  수가 다른 자리:');
    for (const s of count) console.error(`    ${s}`);
  }
  if (bad.length) {
    console.error(`\n  계기가 enum(${[...WHY].join(' · ')}) 밖입니다:`);
    for (const s of bad) console.error(`    ${s}`);
  }
  console.error('\n  지금 자리를 표 꼴로 보려면:  node scripts/check-repaint.mjs --list');
  process.exit(1);
}

const debt = [...reg].filter(([, r]) => r.why === '폴링');
const by = (w) => [...reg].filter(([, r]) => r.why === w).reduce((a, [, r]) => a + r.n, 0);
console.log(`✓ 비우고 다시 그리는 자리 ${total}곳이 전부 등록부에 있다 — ` +
  `사용자 ${by('사용자')} · 가드 ${by('가드')} · 폴링 ${by('폴링')}`);
if (debt.length) {
  console.log(`  갚아야 할 빚 ${debt.length}행 (계기가 폴링인데 가드가 없다):`);
  for (const [k] of debt) console.log(`    ${k}`);
}

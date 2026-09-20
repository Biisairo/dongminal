#!/usr/bin/env node
/**
 * **만든 관측자를 잡는가** (PERFORMANCE_HARDENING_SRS FR-PRF-31).
 *
 * ## 왜 "끊는가" 가 아니라 "잡는가" 인가
 *
 * 감사가 적은 측정은 *"pane 20회 생성·삭제 후 힙 스냅샷"* 이었다. 힙은 GC 에
 * 흔들려 같은 커밋을 두 번 재면 다른 답을 낸다 — 게이트가 될 수 없다
 * (FR-PRF-3). 그 자리에서 **같은 결함을 셀 수 있는 모양으로 다시 물었다**:
 * 힙이 아니라 *"끊을 길이 있는가"* 다 (D-PRF-1).
 *
 * *"끊는가"* 까지 묻지 않는 이유는 오탐이다 (D-PRF-6). `app-statusbar.js` 의
 * `_sbRo` 는 상태바를 본다 — 상태바는 프로세스 수명이라 끊을 계기가 없고,
 * 그것을 예외로 등록하면 **예외가 곧 수명 분석**이 된다. 수명은 파싱이 답할 수
 * 없다.
 *
 * **잡는 것까지가 파싱의 물음이다.** 잡히지 않은 관측자는 *"끊을 길이 없다"* 는
 * 사실 하나로 확정되고 그것은 언제나 결함이다. 착수 시 실측이 그 선을 정당화했다 —
 * 아홉 자리 중 **여덟이 잡고 하나가 안 잡았다** (`renderer-pane.js` 의 탭 넘침).
 *
 * ## 세는 방법
 *
 *   ① `web/js`(vendor·test 제외)의 `.js` 를 읽는다
 *   ② `new (Resize|Mutation|Intersection|Performance)Observer(` 를 찾는다
 *   ③ 그 앞이 **이름에 묶는 꼴**인지 본다 — `const x =` · `let x =` · `x =` ·
 *      `this.x =` · `o.x =` · `return`
 *   ④ 아니면(= 만들자마자 메서드를 부르거나 인자로 넘기면) 잡지 않은 것이다
 *
 * 사용: node scripts/check-observer.mjs [--list]
 */
import { readdirSync, statSync, readFileSync } from 'fs';
import { join } from 'path';

const ROOT = 'web/js';
/** 세지 않는 디렉터리 (SRS §6-예외표 P-1). */
const SKIP_DIRS = new Set(['vendor', 'test']);
/** 이 저장소가 쓰는 관측자. 새 종류가 생기면 여기 더한다. */
const KINDS = ['ResizeObserver', 'MutationObserver', 'IntersectionObserver', 'PerformanceObserver'];

if (process.argv.includes('-h') || process.argv.includes('--help')) {
  console.log(`관측자를 잡는가 검사

  web/js 에서 ${KINDS.join(' · ')} 를 만들고
  그 결과를 이름에 묶지 않는 자리를 잡는다.

    잡힌다:   const ro = new ResizeObserver(f);  ro.observe(el)
              this._ro = new ResizeObserver(f);  this._ro.observe(el)
    안 잡힌다: new ResizeObserver(f).observe(el)   ← 끊을 길이 없다

  **"끊는가" 까지는 묻지 않는다** — 프로세스 수명 관측자가 정당하게 있고,
  수명은 파싱이 답할 수 없다 (D-PRF-6).

  --list  지금 자리를 전부 찍는다.`);
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

const MAKE = new RegExp(`new\\s+(${KINDS.join('|')})\\s*\\(`);
/** 결과를 이름에 묶는 꼴. `new` 바로 **앞**의 글자들을 본다. */
const BOUND = /(?:^|[;{}(,]|=>)\s*(?:(?:const|let|var)\s+)?[\w$]+(?:\s*(?:\.\s*[\w$]+|\[[^\]]*\]))*\s*=\s*$|(?:^|[;{}]|=>)\s*return\s*$/;
const COMMENT = /^\s*(\*|\/\/|\/\*)/;

const found = [];
const loose = [];
for (const f of walk(ROOT).sort()) {
  const lines = readFileSync(f, 'utf8').split('\n');
  lines.forEach((line, i) => {
    const m = line.match(MAKE);
    if (!m || COMMENT.test(line)) return;
    const head = line.slice(0, m.index);
    const site = { file: f, line: i + 1, kind: m[1], text: line.trim() };
    found.push(site);
    if (!BOUND.test(head)) loose.push(site);
  });
}

// M6 §4-A-1: **아무것도 재지 않는 검사**를 만들지 않는다.
if (found.length < 5) {
  console.error(`관측자를 ${found.length}개밖에 못 읽었다 — 검사가 공회전한다.`);
  process.exit(1);
}

if (process.argv.includes('--list')) {
  for (const s of found) console.log(`  ${s.file}:${s.line}  ${s.kind}${loose.includes(s) ? '  ← 안 잡힘' : ''}`);
  process.exit(0);
}

if (loose.length) {
  console.error('✗ 만든 관측자를 잡지 않는 자리가 있다 (FR-PRF-31):');
  for (const s of loose) console.error(`    ${s.file}:${s.line}  ${s.text}`);
  console.error('');
  console.error('  이름에 묶으세요 — 묶지 않으면 `disconnect()` 할 길이 자체가 없습니다.');
  console.error('  골격에 얹는 자리는 `el._xxxRo = new ResizeObserver(...)` 꼴이고,');
  console.error('  `renderer.js` 의 `_domGC()` 가 골격을 거둘 때 함께 끊습니다.');
  process.exit(1);
}

const byKind = KINDS.map((k) => `${k.replace('Observer', '')} ${found.filter((s) => s.kind === k).length}`)
  .filter((s) => !s.endsWith(' 0')).join(' · ');
console.log(`✓ 관측자 ${found.length}자리가 전부 이름에 묶인다 — ${byKind} (FR-PRF-31)`);

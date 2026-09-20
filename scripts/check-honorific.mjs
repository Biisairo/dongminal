#!/usr/bin/env node
/**
 * 인터페이스의 목소리가 한 가지인가 (WORDING_COLOR_SRS FR-WRD-70~73 ·
 * `AUDIT-uiux.md` §2.5).
 *
 * ## 왜 있는가
 *
 * 착수 시 같은 앱의 다섯 화면이 서로 다른 등급으로 말했다 — 편집기는
 * *"…나타납니다"*(합쇼체), Agents 는 *"활동 중인 에이전트 없음"*(명사형),
 * Runs 는 *"진행 중인 Run 이 없다"*(**해라체**). 화면을 옮길 때마다 목소리가
 * 바뀌면 같은 제품으로 읽히지 않고, 해라체는 나란히 놓였을 때 무뚝뚝하다.
 *
 * ## 등급은 둘이다 (FR-WRD-70)
 *
 *   문장(안내·확인·오류·설명)   **합쇼체** — `…합니다` · `…습니다` · `…하세요`
 *   라벨·상태 표시             **명사형** — `활동 중인 에이전트 없음`
 *
 * 세 번째를 만들지 않는다. 이 검사는 그중 **해라체가 0인가**만 묻는다 —
 * 명사형과 합쇼체의 갈림은 자리의 뜻이라 기계가 판정할 수 없고, 판정할 수
 * 없는 것을 세면 검사가 소음이 된다 (D-CMP-5).
 *
 * 착수 시 실측 **17자리**. 감사는 "Runs 셋 + Background 하나" 라 적었고
 * 인계서는 둘이라 적었다 — 화면에서 센 수는 표본이다 (SRS §2.1).
 *
 * 사용: node scripts/check-honorific.mjs [--list]
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const KO = 'web/js/i18n/ko.js';

/** 자리마다 사유를 갖는 예외. */
const EXEMPT = [];

if (process.argv.includes('-h') || process.argv.includes('--help')) {
  console.log(`존댓말 등급 검사

  ko 카탈로그의 문장이 해라체(…한다 · …없다)로 끝나지 않는지 본다.
  문장은 합쇼체, 라벨·상태는 명사형 — 둘뿐이다 (FR-WRD-70).

  --list  읽은 항목과 문장 수를 함께 찍는다.`);
  process.exit(0);
}

const ENTRY = /^\s*'([a-z0-9_.]+)'\s*:\s*'((?:[^'\\]|\\.)*)'\s*,\s*$/;
/** 합쇼체의 꼬리 — 이것으로 끝나면 대상이 아니다. */
const POLITE = /(니다|니까|세요|셔요|시오)$/;
/** 해라체 평서 — `…다` 로 끝나되 `…니다` 가 아닌 것. */
const PLAIN = /다$/;

const lines = readFileSync(join(ROOT, KO), 'utf8').split('\n');
const bad = [];
let entries = 0, sentences = 0, exempted = 0;

lines.forEach((ln, i) => {
  const m = ln.match(ENTRY);
  if (!m) return;
  entries++;
  const [, key, val] = m;
  if (EXEMPT.some((e) => e.key === key)) { exempted++; return }
  // 마크업과 줄바꿈을 걷고 문장으로 쪼갠다. `—` 뒤는 새 문장처럼 끝맺는다.
  const body = val.replace(/<[^>]*>/g, '').replace(/\\n/g, ' ');
  for (const raw of body.split(/[.!?]|—/)) {
    const s = raw.trim().replace(/[\s…]+$/, '');
    if (!s || !/[가-힣]$/.test(s)) continue;
    sentences++;
    if (POLITE.test(s)) continue;
    if (PLAIN.test(s)) bad.push(`  ${KO}:${i + 1}  ${key}  해라체 \`${s.slice(-12)}\``);
  }
});

// M6 §4-A-1: 파싱이 죽으면 `bad` 가 비고 검사는 조용히 초록이 된다.
if (entries < 500 || sentences < 300) {
  console.error(`검사가 공회전한다 — 항목 ${entries}(실측 1000+) · 문장 ${sentences}(실측 700+).`);
  process.exit(1);
}

if (process.argv.includes('--list')) console.log(`항목 ${entries} · 문장 ${sentences} · 예외 ${exempted}`);

if (bad.length) {
  console.error(`목소리가 갈린다 — 해라체 ${bad.length}자리 (FR-WRD-71·73):`);
  for (const b of bad) console.error(b);
  console.error('');
  console.error('  문장은 합쇼체로 적습니다 — `…없다` 가 아니라 `…없습니다`.');
  console.error('  라벨·상태 표시는 명사형입니다 — `활동 중인 에이전트 없음`.');
  console.error('  낱말이 아니라 **끝맺음**의 문제입니다 (FR-WRD-74: 낱말은 이 검사의 일이 아니다).');
  process.exit(1);
}

console.log(`honorific ok (항목 ${entries} · 문장 ${sentences} · 해라체 0 · 예외 ${exempted})`);

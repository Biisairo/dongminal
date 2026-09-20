#!/usr/bin/env node
/**
 * `index.html` 의 **보이는 글자**가 카탈로그를 지나는가
 * (WORDING_COLOR_SRS FR-WRD-40·41·45 · `AUDIT-uiux.md` §2.2).
 *
 * ## 왜 있는가
 *
 * `check-i18n.mjs` 는 *"한글 리터럴이 카탈로그 밖에 있는가"* 를 묻는다. 그래서
 * **영어로 박힌 글자는 그 검사의 대상이 아니다** — 번역을 건너뛴 자리가 조용히
 * 남는다. 착수 시 실측: `index.html` 의 보이는 텍스트 노드 중 `data-i18n` 이
 * 없는 자리가 **18**이었다 (상단바 6 · 사이드바 4 · 찾기 3 · 테마 3 · 표시 2).
 * 한국어 사용자에게 앱이 반쯤 영어로 보이던 자리가 그것이다.
 *
 * ## `lang` 이 붙은 자리는 **결함이 아니라 선언이다** (D-WRD-2)
 *
 * 설정 탭 열둘과 모달 제목은 `lang="en"` 을 갖는다 — `index.html:251` 이
 * *"FR-B-5: 탭 이름은 ko 카탈로그에서도 영어다 (FR-B-9 의 데이터) — 요소가 그
 * 언어를 말한다"* 고 적었고 `M8_UNIFIED_SRS` FR-B-5 가 그것을 요구로 갖는다.
 * 요소가 자기 언어를 말하고 있으면 이 검사의 대상이 아니다. **몇 자리를
 * 지났는지 찍는다** — 조용한 예외는 예외가 아니라 구멍이다.
 *
 * 사용: node scripts/check-i18n-html.mjs [--list]
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const FILE = 'web/index.html';

/** 자리마다 사유를 갖는 예외. */
const EXEMPT = [
  { tag: 'title', why: '브라우저 탭의 이름은 제품 이름이다 — 번역 대상이 아니다 (`.boot-name` 과 같은 규약)',
    until: '제품 이름이 로케일마다 달라지면' },
];

if (process.argv.includes('-h') || process.argv.includes('--help')) {
  console.log(`index.html 의 보이는 글자 검사

  텍스트 노드 중 조상에 data-i18n(-html) 이 없는 자리를 센다.
  lang 이 선언된 서브트리는 대상이 아니다 — 요소가 자기 언어를 말한다 (FR-B-5).
  숫자·기호만인 노드도 대상이 아니다 — 낱말이 아니다.

  --list  지나간 자리(선언된 언어·예외)를 함께 찍는다.`);
  process.exit(0);
}

const raw = readFileSync(join(ROOT, FILE), 'utf8');
const blank = (s) => s.replace(/[^\n]/g, ' ');
// 주석·스크립트·스타일·아이콘 스프라이트는 보이는 글자가 아니다.
const src = raw
  .replace(/<!DOCTYPE[^>]*>/i, blank)
  .replace(/<!--[\s\S]*?-->/g, blank)
  .replace(/<script[\s\S]*?<\/script>/g, blank)
  .replace(/<style[\s\S]*?<\/style>/g, blank)
  .replace(/<svg[\s\S]*?<\/svg>/g, blank);

const VOID = new Set(['br', 'hr', 'input', 'img', 'meta', 'link', 'use', 'path', 'source', 'area', 'base', 'col', 'embed', 'param', 'track', 'wbr']);
const TOKEN = /<(\/?)([a-zA-Z][\w-]*)([^>]*)>|([^<]+)/g;

const bad = [];
let declared = 0, exempted = 0, nodes = 0;
const stack = [];
let m;
while ((m = TOKEN.exec(src))) {
  if (m[2]) {
    const tag = m[2].toLowerCase(), attrs = m[3] || '';
    if (m[1]) { while (stack.length && stack[stack.length - 1].tag !== tag) stack.pop(); stack.pop() }
    else if (!/\/>$/.test(m[0]) && !VOID.has(tag)) stack.push({ tag, attrs });
    continue;
  }
  const text = m[4].replace(/\s+/g, ' ').trim();
  if (!text || !/[A-Za-z가-힣]/.test(text)) continue;   // 숫자·기호는 낱말이 아니다
  nodes++;
  if (stack.some((x) => /\sdata-i18n(-html)?\s*=/.test(x.attrs))) continue;
  // `<html lang>` 은 **문서의 언어**이지 그 요소의 선언이 아니다 — 그것까지
  // 인정하면 모든 글자가 "선언된 언어" 가 되어 검사가 아무것도 재지 않는다.
  const langAt = [...stack].reverse().find((x) => /\slang\s*=/.test(x.attrs));
  if (langAt && langAt.tag !== 'html') { declared++; continue }
  if (stack.some((x) => EXEMPT.some((e) => e.tag === x.tag))) { exempted++; continue }
  const line = src.slice(0, m.index).split('\n').length;
  bad.push(`  ${FILE}:${line}  <${stack.length ? stack[stack.length - 1].tag : '?'}>  ${JSON.stringify(text).slice(0, 60)}`);
}

// M6 §4-A-1: 파싱이 죽으면 `bad` 가 비고 검사는 조용히 초록이 된다.
// 실측 35 — 화면의 대부분은 JS 가 그리므로 이 파일의 텍스트 노드는 원래 적다.
if (nodes < 20) {
  console.error(`텍스트 노드를 ${nodes}개밖에 읽지 못했다 — 검사가 공회전한다 (실측 35).`);
  process.exit(1);
}

if (process.argv.includes('--list')) {
  console.log(`텍스트 노드 ${nodes} · 언어가 선언된 자리 ${declared} · 예외 ${exempted}`);
  for (const e of EXEMPT) console.log(`  <${e.tag}> — ${e.why} · 언제까지: ${e.until}`);
}

if (bad.length) {
  console.error(`보이는 글자가 카탈로그 밖에 있다 (${bad.length}자리, FR-WRD-40):`);
  for (const b of bad) console.error(b);
  console.error('');
  console.error('  data-i18n="<키>" 를 달고 ko·en 카탈로그에 키를 채우세요.');
  console.error('  그 자리의 낱말이 영어여야 한다면 ko 값도 영어로 둡니다 — 그것이');
  console.error('  카탈로그의 **데이터** 이고, 낱말이 바뀔 때 코드가 아니라 데이터가 바뀝니다 (FR-B-9).');
  console.error('  요소가 자기 언어를 말하는 자리라면 lang 을 선언하세요 (FR-B-5).');
  process.exit(1);
}

console.log(`i18n-html ok (텍스트 노드 ${nodes} · data-i18n 밖 0 · 언어 선언 ${declared} · 예외 ${exempted})`);

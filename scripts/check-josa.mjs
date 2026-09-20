#!/usr/bin/env node
/**
 * 조사가 받침을 보는가 (WORDING_COLOR_SRS FR-WRD-60~67 · `AUDIT-uiux.md` §2.4).
 *
 * ## 왜 있는가
 *
 * 서식 문자열이 `${name} 를` 꼴로 고정돼 있으면 **이름이 바뀔 때마다 절반이
 * 틀린다** — `go 를`(맞음) / `python 을`(틀림). 화면에서 `markdown 를 설치하면`
 * 이 그것이었다. 제품의 완성도를 가장 싸게 깎아먹는 종류다.
 *
 * 회피책(`을(를)`)도 같은 결함의 다른 얼굴이다. 틀리지는 않지만 **받침을 알 수
 * 있는데도 묻지 않은 것**이고, 괄호가 늘수록 문장이 읽히지 않는다.
 *
 * ## 무엇을 잡는가
 *
 *   ① 회피형 표기 — `을(를)`·`이(가)`·`은(는)`·`와(과)`
 *   ② 자리표시자(`%s`·`{name}`) **바로 뒤**의 고정 조사
 *
 * 둘 다 `{을를}` 꼴의 마커로 고치면 사라진다 — 마커는 `i18n.js` 의 `josa()` 가
 * 치환 뒤에 푼다 (FR-WRD-60·63).
 *
 * 사용: node scripts/check-josa.mjs [--list]
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const KO = 'web/js/i18n/ko.js';

/** 자리마다 사유를 갖는 예외. */
const EXEMPT = [];

if (process.argv.includes('-h') || process.argv.includes('--help')) {
  console.log(`조사 검사

  ko 카탈로그에서 회피형 표기와 자리표시자 뒤의 고정 조사를 센다.
  고치는 법: '%s {을를} 삭제합니다.' — 마커는 josa() 가 치환 뒤에 푼다.

  --list  읽은 항목 수와 예외를 함께 찍는다.`);
  process.exit(0);
}

const ENTRY = /^\s*'([a-z0-9_.]+)'\s*:\s*'((?:[^'\\]|\\.)*)'\s*,\s*$/;
const AVOID = /(을\(를\)|를\(을\)|이\(가\)|가\(이\)|은\(는\)|는\(은\)|와\(과\)|과\(와\))/;
/** 자리표시자 뒤의 조사 — 사이의 공백은 이 저장소의 표기 관용이다. */
const FIXED = /(%[a-z]|\{[a-z0-9_]+\})\s*(를|을|이|가|은|는|와|과|으로|로)(?=[\s.,!?]|$)/;

const lines = readFileSync(join(ROOT, KO), 'utf8').split('\n');
const bad = [];
let entries = 0, exempted = 0;

lines.forEach((ln, i) => {
  const m = ln.match(ENTRY);
  if (!m) return;
  entries++;
  const [, key, val] = m;
  if (EXEMPT.some((e) => e.key === key)) { exempted++; return }
  const a = val.match(AVOID);
  if (a) bad.push(`  ${KO}:${i + 1}  ${key}  회피형 \`${a[1]}\` — 받침을 알 수 있는 자리다`);
  const f = val.match(FIXED);
  if (f) bad.push(`  ${KO}:${i + 1}  ${key}  고정 조사 \`${f[1]} ${f[2]}\` — 이름이 바뀌면 절반이 틀린다`);
});

// M6 §4-A-1: 파싱이 죽으면 `bad` 가 비고 검사는 조용히 초록이 된다.
if (entries < 500) {
  console.error(`카탈로그 항목을 ${entries}개밖에 읽지 못했다 — 검사가 공회전한다 (실측 1000+).`);
  process.exit(1);
}

if (process.argv.includes('--list')) console.log(`항목 ${entries} · 예외 ${exempted}`);

if (bad.length) {
  console.error(`조사가 받침을 보지 않는다 (${bad.length}자리, FR-WRD-65):`);
  for (const b of bad) console.error(b);
  console.error('');
  console.error("  '%s {을를} 삭제합니다.' 처럼 마커를 쓰세요 — josa() 가 치환 뒤에 풉니다.");
  console.error('  마커: {을를} {이가} {은는} {와과} {으로로}');
  process.exit(1);
}

console.log(`josa ok (항목 ${entries} · 회피형 0 · 고정 조사 0 · 예외 ${exempted})`);

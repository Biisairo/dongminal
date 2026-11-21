#!/usr/bin/env node
/**
 * 모듈 크기가 **기준선보다 나빠졌는가** (STRUCTURE_CLEANUP_SRS FR-STR-40).
 *
 * ## 왜 새 검사가 필요한가
 *
 * `FE_MODULE_BOUNDARY_SRS` §4.3 이 *"분할 후 500줄 초과 파일 수와 최대 파일 줄
 * 수를 기록한다"* 로 이 수치를 DoD 로 올렸다. **그 DoD 에는 게이트가 없었다.**
 *
 * 이 저장소의 다른 43종 게이트는 전부 "두 곳이 같은가" 를 재는데, 유일하게 수치
 * DoD 만 문서에 적히고 집행되지 않았다. 결과는 9일 만의 역행이다 —
 * 500줄 초과 22 → 26, 최대 파일 1,336 → 1,586(+19%). §4.3 이 수치를 요구한
 * 이유(`FR-FMB-43`: *"값을 옮기는 것보다 **다시 흩어지지 않게 하는 것**이
 * 본체다"*)가 자기 자신에게 적용되지 않았다.
 *
 * ## 무엇을 재는가
 *
 * 두 수 — ① 500줄 초과 파일 수 ② 최대 파일의 줄 수. 기준선은 **문서가 갖는다**
 * (`FE_MODULE_BOUNDARY_SRS §7.1`). 여기 박아 두면 그것이 세 번째 사본이 된다.
 *
 * **CSS 도 같은 두 수를 잰다** (REFACTOR3_FE_REST4_SRS FR-FR4-11 · D-FR4-11). `web/*.css`(vendor 제외)가
 * 대상이고, 기준선은 같은 절의 `CSS 500줄초과=N · 최대=M` 줄이다. 이전: `web/js` 만 쟀고 CSS 에는
 * 게이트가 없었다 — `style.css` 가 2,545줄이 되도록 아무것도 알리지 않았다.
 *
 * **나빠지면 실패하고, 좋아지면 통과시키되 표를 갱신하라고 안내한다** —
 * `check-error-docs.sh` 가 생성물과 코드를 대조하는 것과 같은 꼴이다.
 *
 * ## 무엇을 세지 않는가 (§6-예외표)
 *
 *   `web/js/i18n/*.js`  — **데이터**다. 키가 늘면 줄이 늘고 분할이 뜻을 갖지 않는다
 *   `web/js/test/**`     — 검사 코드다
 *   `web/vendor/**`      — 우리 코드가 아니다
 *
 * 사용: node scripts/check-file-size.mjs [--list]
 */
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

const ROOT = 'web/js';
/** CSS 는 `web/` 바로 아래의 `*.css` 다 (`web/vendor/` 는 우리 것이 아니다). */
const CSS_DIR = 'web';
const SRS = 'docs/internal/FE_MODULE_BOUNDARY_SRS.md';
/** `FE_MODULE_BOUNDARY_SRS §2.1` 이 정한 경계. 값이 아니라 **경계**가 계약이다. */
const LIMIT = 500;
/** 세지 않는 디렉터리 (SRS §6-예외표 S-3·S-4). */
const SKIP_DIRS = new Set(['vendor', 'test', 'i18n']);

if (process.argv.includes('-h') || process.argv.includes('--help')) {
  console.log(`모듈 크기 기준선 검사

  web/js(vendor·test·i18n 제외)와 web/*.css 의 ${LIMIT}줄 초과 파일 수와 최대 줄 수를
  ${SRS} §7.1 의 기준선(JS 줄 · CSS 줄)과 견준다.

  나빠지면 실패한다. 좋아지면 통과시키되 표를 갱신하라고 안내한다.

  --list  ${LIMIT}줄을 넘는 파일을 전부 찍는다.`);
  process.exit(0);
}

function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) { if (!SKIP_DIRS.has(e)) walk(p, out); continue; }
    if (e.endsWith('.js')) out.push(p);
  }
  return out;
}

/** `wc -l` 과 같은 셈 — 줄바꿈 문자의 수다. 두 방법이 섞이면 수가 하나씩 갈린다. */
function lines(p) {
  const s = readFileSync(p, 'utf8');
  return s.split('\n').length - (s.endsWith('\n') ? 1 : 0);
}

/**
 * 한 종류(JS·CSS)를 기준선 줄과 견준다. 나빠진 것을 돌려준다.
 * `re` 는 그 종류의 기준선 줄이다 — JS 줄은 앞에 `CSS ` 가 없는 줄이어야 CSS 줄과 섞이지 않는다.
 */
function check(kind, files, min, re, example) {
  // M6 §4-A-1: **아무것도 재지 않는 검사**를 만들지 않는다.
  if (files.length < min) {
    console.error(`${kind} 파일을 ${files.length}개밖에 못 읽었다 — 검사가 공회전한다.`);
    process.exit(1);
  }
  const over = files.filter(([, n]) => n > LIMIT);
  const [maxFile, maxLines] = files[0];
  const m = srs.match(re);
  if (!m) {
    console.error(`✗ ${SRS} 에서 ${kind} 기준선을 못 읽었다 — 검사가 공회전한다.`);
    console.error(`  §7.1 에 이 꼴의 줄이 있어야 한다:  \`${example}\``);
    process.exit(1);
  }
  const base = { over: +m[1], max: +m[2] };
  if (process.argv.includes('--list')) {
    for (const [p, n] of over) console.log(`  ${String(n).padStart(5)} ${p}`);
    console.log();
  }
  const worse = [];
  if (over.length > base.over) worse.push(`${kind} ${LIMIT}줄 초과 파일 ${base.over} → ${over.length}`);
  if (maxLines > base.max) worse.push(`${kind} 최대 파일 ${base.max} → ${maxLines} (${maxFile})`);
  return { kind, over, maxFile, maxLines, base, worse };
}

const byLines = (ps) => ps.map((p) => [p, lines(p)]).sort((a, b) => b[1] - a[1]);
const cssFiles = readdirSync(CSS_DIR).filter((e) => e.endsWith('.css')).map((e) => join(CSS_DIR, e));

// 기준선은 **문서가 갖는다.** 여기 박으면 세 번째 사본이 된다.
const srs = readFileSync(SRS, 'utf8');
const results = [
  check('JS', byLines(walk(ROOT)), 50, /(?<!CSS )500줄초과=(\d+)\s*·\s*최대=(\d+)/, '500줄초과=26 · 최대=1586'),
  check('CSS', byLines(cssFiles), 5, /CSS 500줄초과=(\d+)\s*·\s*최대=(\d+)/, 'CSS 500줄초과=5 · 최대=2545'),
];

const worse = results.flatMap((r) => r.worse);
if (worse.length) {
  console.error(`✗ 모듈 크기가 기준선보다 나빠졌다 (FR-STR-40 · FE_MODULE_BOUNDARY_SRS §4.3):`);
  for (const w of worse) console.error(`    ${w}`);
  console.error('');
  console.error('  가르거나, 기준선을 옮길 근거를 §7.1 에 적으세요.');
  console.error('  **게이트를 느슨하게 만들어 통과시키지 않습니다** — 재는 대상이 달라진 것만');
  console.error('  기준선을 움직일 수 있고, 그때 그 이유가 문서에 남아야 합니다 (규약 2).');
  process.exit(1);
}

for (const r of results) {
  if (r.over.length < r.base.over || r.maxLines < r.base.max) {
    console.log(`✓ ${r.kind} 모듈 크기가 기준선보다 낫다 — ${LIMIT}줄 초과 ${r.over.length}(기준선 ${r.base.over}) · 최대 ${r.maxLines}(기준선 ${r.base.max})`);
    console.log(`  ${SRS} §7.1 의 기준선을 이 값으로 갱신하세요 — 좋아진 것을 적지 않으면 다음 역행이 보이지 않습니다.`);
  } else {
    console.log(`✓ ${r.kind} 모듈 크기가 기준선 그대로다 — ${LIMIT}줄 초과 ${r.over.length} · 최대 ${r.maxLines} (${r.maxFile})`);
  }
}

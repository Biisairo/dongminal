#!/usr/bin/env node
/**
 * **애니메이션이 레이아웃을 건드리는가** (PERFORMANCE_HARDENING_SRS FR-PRF-35).
 *
 * ## 왜 이 물음인가
 *
 * 감사가 적은 측정은 *"부팅 구간의 Layout 이벤트 수"* 였다 (`AUDIT-design.md` 10-1).
 * 그 수는 브라우저 계측이 필요하고 기계마다 흔들린다 — 게이트가 될 수 없다
 * (FR-PRF-3). 그 자리에서 **같은 결함을 셀 수 있는 모양으로 다시 물었다**:
 * Layout 이벤트가 아니라 *"레이아웃 속성을 애니메이션하는가"* 다 (D-PRF-1).
 *
 * `transform`·`opacity` 는 합성만 돈다. `left`·`width` 류는 **매 프레임** 레이아웃 →
 * 페인트 → 합성을 전부 돈다. 어느 쪽인지는 소스에 적혀 있고 파싱이 답할 수 있다.
 *
 * 착수 시 실측: `@keyframes` **13개 중 하나**(`boot-flow`)만 어겼다. 열둘이 지키고
 * 하나가 깨는 모양은 이 저장소에서 두 번째다 (관측자 아홉 중 하나 — `check-observer.mjs`).
 *
 * ## 세는 방법
 *
 *   ① `web/*.css` 를 읽는다
 *   ② `@keyframes <이름> {` 을 찾고 **중괄호 깊이**로 블록을 잘라낸다
 *      (정규식으로 블록을 잡으면 안쪽 `{}` 에서 끊긴다 — 첫 판이 그랬다)
 *   ③ 그 블록 안에 레이아웃 속성 선언이 있으면 잡는다
 *
 * `@keyframes` **밖**의 `left:`·`width:` 는 대상이 아니다 (§6-예외표 P-4) —
 * 한 번 놓이는 값이고 애니메이션이 아니다.
 *
 * 사용: node scripts/check-css-animation.mjs [--list]
 */
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

const ROOT = 'web';
/**
 * 값이 바뀌면 레이아웃이 다시 도는 속성. `transform`·`opacity`·`filter`·색은
 * 여기 없다 — 그것이 이 검사가 권하는 쪽이다.
 */
const LAYOUT = /(?:^|[;{\s])(left|right|top|bottom|width|height|min-width|min-height|max-width|max-height|margin(?:-\w+)?|padding(?:-\w+)?|inset(?:-\w+)?|flex-basis|font-size|line-height)\s*:/;

if (process.argv.includes('-h') || process.argv.includes('--help')) {
  console.log(`애니메이션의 레이아웃 유발 검사

  web/*.css 의 @keyframes 블록이 레이아웃 속성을 애니메이션하면 잡는다.

    괜찮다:  @keyframes x{0%{transform:translateX(-98%)}100%{transform:translateX(224%)}}
    잡힌다:  @keyframes x{0%{left:-45%}100%{left:103%}}

  @keyframes **밖**의 선언은 대상이 아니다 — 한 번 놓이는 값이다.

  --list  키프레임을 전부 찍는다.`);
  process.exit(0);
}

/** `@keyframes` 블록을 중괄호 깊이로 잘라낸다. */
function blocks(css) {
  const out = [];
  const re = /@keyframes\s+([\w-]+)\s*\{/g;
  let m;
  while ((m = re.exec(css))) {
    let i = re.lastIndex, depth = 1;
    while (depth > 0 && i < css.length) {
      if (css[i] === '{') depth++;
      else if (css[i] === '}') depth--;
      i++;
    }
    out.push({ name: m[1], body: css.slice(re.lastIndex, i - 1) });
    re.lastIndex = i;
  }
  return out;
}

const found = [];
for (const name of readdirSync(ROOT).sort()) {
  if (!name.endsWith('.css')) continue;
  const path = join(ROOT, name);
  for (const b of blocks(readFileSync(path, 'utf8'))) {
    const hit = b.body.match(LAYOUT);
    found.push({ file: path, name: b.name, prop: hit ? hit[1] : '' });
  }
}

// M6 §4-A-1: **아무것도 재지 않는 검사**를 만들지 않는다.
if (found.length < 5) {
  console.error(`키프레임을 ${found.length}개밖에 못 읽었다 — 검사가 공회전한다.`);
  process.exit(1);
}

if (process.argv.includes('--list')) {
  for (const f of found) console.log(`  ${f.prop ? 'LAYOUT ' : '       '}${f.name}  (${f.file})`);
  process.exit(0);
}

const bad = found.filter((f) => f.prop);
if (bad.length) {
  console.error('✗ 레이아웃을 애니메이션하는 키프레임이 있다 (FR-PRF-35):');
  for (const f of bad) console.error(`    ${f.file}  @keyframes ${f.name}  — ${f.prop}`);
  console.error('');
  console.error('  `transform` 으로 옮기세요 — 합성만 돌고 레이아웃이 서지 않습니다.');
  console.error('  기준이 바뀌는 것에 주의하세요: `left` 는 **상자** 기준이고');
  console.error('  `translateX` 는 **자기 폭** 기준입니다 (boot-flow: -45% → -98%).');
  console.error('  `prefers-reduced-motion` 쪽도 함께 고치세요 — 한쪽만 고치면');
  console.error('  움직임을 끈 사용자에게 모양이 어긋납니다 (FR-PRF-34).');
  process.exit(1);
}

console.log(`✓ 키프레임 ${found.length}개가 레이아웃을 건드리지 않는다 (FR-PRF-35)`);

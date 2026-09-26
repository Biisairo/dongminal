#!/usr/bin/env node
/**
 * **전환 시간이 토큰에서 오는가** (DESIGN_TOKENS_SRS FR-TOK-47 · D-TOK-12).
 *
 * 착수 시 `transition` 27선언이 시간 여덟 종(`.08s`~`.3s`)을 제각각 적었다.
 * 글자 크기 12종·z-index 28값과 같은 부류다 — 값이 뜻을 말하지 않으면 다음
 * 사람은 옆줄을 베껴 쓴다. 눈금은 셋이다: `--dur-fast|base|slow`.
 *
 * ## 세는 방법
 *
 *   ① `web/*.css` 에서 주석을 걷는다 (주석은 CSS 가 아니다 — FR-TOK-28a)
 *   ② `@media (prefers-reduced-motion…)` 블록을 **중괄호 깊이로** 걷는다 —
 *      그 안의 `.01ms` 는 전역으로 멎게 하는 관용값이지 눈금이 아니다
 *   ③ `:root{…}` 블록을 걷는다 — 토큰은 거기서 한 번 적힌다
 *   ④ 남은 `transition:`·`transition-duration:` 값에 시간 리터럴이 있으면 잡는다
 *
 * `animation` 은 대상이 아니다 (FR-TOK-48).
 *
 * 사용: node scripts/check-motion.mjs [--list]
 */
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

const CSS_DIR = 'web';

if (process.argv.includes('-h') || process.argv.includes('--help')) {
  console.log(`전환 시간 토큰 검사

  web/*.css 의 transition · transition-duration 이 시간을 리터럴로 적으면 잡는다.

    괜찮다:  transition:background var(--dur-fast)
    잡힌다:  transition:background .15s

  :root 블록과 prefers-reduced-motion 블록은 대상이 아니다.

  --list  전환 선언을 전부 찍는다.`);
  process.exit(0);
}

/** 주석을 공백으로 지운다 — 줄바꿈은 남겨 줄 번호가 밀리지 않게. */
const blank = (m) => m.replace(/[^\n]/g, ' ');
const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, blank);

/** `head` 로 시작하는 블록을 중괄호 깊이로 찾아 공백으로 지운다. */
function dropBlocks(css, head) {
  let out = css;
  for (;;) {
    const m = head.exec(out);
    head.lastIndex = 0;
    if (!m) return out;
    let i = m.index + m[0].length, depth = 1;
    while (i < out.length && depth) {
      if (out[i] === '{') depth++;
      else if (out[i] === '}') depth--;
      i++;
    }
    out = out.slice(0, m.index) + blank(out.slice(m.index, i)) + out.slice(i);
  }
}

const TIME = /(?:^|[\s,(])(\d*\.?\d+m?s)\b/;
const files = readdirSync(CSS_DIR).filter((f) => f.endsWith('.css')).map((f) => join(CSS_DIR, f));

const bad = [];
const all = [];
for (const f of files) {
  let css = strip(readFileSync(f, 'utf8'));
  css = dropBlocks(css, /@media\s*\(\s*prefers-reduced-motion[^{]*\{/);
  css = dropBlocks(css, /:root\s*\{/);
  css.split('\n').forEach((line, i) => {
    for (const m of line.matchAll(/(?:^|[;{\s])(transition(?:-duration)?)\s*:\s*([^;}]+)/g)) {
      const v = m[2].trim();
      const at = `${f}:${i + 1}`;
      all.push(`${at}  ${m[1]}:${v}`);
      if (TIME.test(v)) bad.push(`  ${at}  ${m[1]}:${v}`);
    }
  });
}

// M6 §4-A-1: 아무것도 재지 않는 검사를 만들지 않는다.
if (all.length < 20) {
  console.error(`전환 선언을 ${all.length}개밖에 못 읽었다 — 검사가 공회전한다 (착수 시 27).`);
  process.exit(1);
}

if (process.argv.includes('--list')) console.log(all.join('\n') + '\n');

if (bad.length) {
  console.error(`전환 시간이 리터럴이다 (${bad.length}곳, FR-TOK-47):`);
  console.error(bad.join('\n'));
  console.error('\n  var(--dur-fast|base|slow) 를 쓰세요 (.1s · .15s · .2s).');
  console.error('  뜻이 셋에 없으면 눈금이 부족한 것이고, 눈금을 더하는 것은 DESIGN_TOKENS_SRS §3.10 을 고치는 일입니다.');
  process.exit(1);
}

console.log(`motion ok (전환 선언 ${all.length}개 전부 토큰에서 온다)`);

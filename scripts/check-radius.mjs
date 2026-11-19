#!/usr/bin/env node
/**
 * 모서리가 **토큰에서 오는가** (UX_AUDIT_FIX_SRS FR-UXF-46·47 / 진단 D19).
 *
 * 착수 시 실측은 `border-radius` 값 아홉 종(1·2·3·4·5·6·7·8·9px)이었다. 4px 과
 * 3px 이 뜻 없이 함께 있었다. check-font-size.mjs 와 같은 이유로 종수가 아니라
 * **px 리터럴이 남았는가**를 잰다. `:root` 의 `--radius-*` 정의만 예외다.
 *
 * 사용: node scripts/check-radius.mjs
 */
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const CSS_DIR = 'web';

if (process.argv.includes('-h') || process.argv.includes('--help')) {
  console.log(`모서리 토큰 검사

  web/*.css 의 border-radius(border-*-radius) 값에 px 리터럴이 남았는지 본다.
  전부 var(--radius-*) · 0 · % · inherit 이어야 한다 (FR-UXF-47).`);
  process.exit(0);
}

/** 주석은 공백으로만 지운다 — 줄 번호가 밀리지 않게 (check-font-size.mjs 와 같다). */
const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));

const files = readdirSync(CSS_DIR).filter((f) => f.endsWith('.css')).map((f) => join(CSS_DIR, f));

const literals = [];
let total = 0;

for (const f of files) {
  const lines = strip(readFileSync(f, 'utf8')).split('\n');
  lines.forEach((line, i) => {
    for (const m of line.matchAll(/(?:^|[;{\s])(border(?:-[a-z]+)*-radius)\s*:\s*([^;}]+)/g)) {
      total++;
      if (/\d\s*px\b/.test(m[2])) literals.push({ at: `${f}:${i + 1}`, v: `${m[1]}:${m[2].trim()}` });
    }
  });
}

// 정규식이 헛돌면 검사가 조용히 초록이 된다 (check-font-size.mjs 와 같은 지킴).
if (total < 100) {
  console.error(`border-radius 선언을 ${total}개밖에 못 읽었다 — 검사가 공회전한다.`);
  process.exit(1);
}

if (literals.length) {
  console.error(`border-radius 에 px 리터럴이 남았다 (${literals.length}곳, FR-UXF-47):`);
  for (const l of literals) console.error(`  ${l.at}  ${l.v}`);
  console.error('\n  var(--radius-sm|md|lg|pill) 을 쓰세요. 사상 규칙은 UX_AUDIT_FIX_SRS §3.6.2 입니다.');
  process.exit(1);
}

console.log(`border-radius ok (선언 ${total}개 전부 토큰)`);

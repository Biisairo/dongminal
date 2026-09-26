#!/usr/bin/env node
/**
 * 브라우저 저장소 접근이 **한 자리를 지나는가** · core 에 빈 `catch{}` 가 없는가
 * (OPTIMIZE_REFACTOR_SRS FR-OPT-11-3 · FEC-19 · FEU-18).
 *
 * ## 왜 있는가
 *
 * `localStorage`·`sessionStorage` 호출이 파일마다 `try{…}catch{}` 로 감싸여
 * 흩어져 있었다. 실패는 아무 데도 남지 않았고(core 의 빈 catch 75개 대부분),
 * 키는 상수와 리터럴이 섞였다. 이제 `core/pref-store.js` 의 `PrefStore` 가 유일한
 * 경로다 — 이 검사가 없으면 다음 사람이 한 줄짜리 `try{localStorage…}catch{}` 를
 * 다시 쓴다.
 *
 * ## 무엇을 재는가
 *
 *   ① web/js(test·vendor·i18n 제외)에서 저장소 전역을 부르는 곳이 예외표 밖에 없다
 *   ② web/js/core 에 빈 `catch{}` 가 없다 — 의도된 무시는 `ErrorLog.quiet` 로 적는다
 *
 * 사용: node scripts/check-storage.mjs
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = 'web/js';

/** 예외표. 이유가 없는 예외는 없다. */
const ALLOW = {
  'web/js/core/pref-store.js': '저장소를 **정의하는 쪽**이다',
  'web/js/core/i18n.js': '카탈로그는 PrefStore 없이 단독으로 실리는 모듈이다 — i18n.test 가 localStorage 대역을 넣어 로케일 판정을 잰다 (FR-B-4·5)',
};

function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) { if (!['test', 'vendor', 'i18n'].includes(e)) walk(p, out); continue; }
    if (e.endsWith('.js')) out.push(p);
  }
  return out;
}

/** 주석을 걷는다 — 규약을 설명하는 문장이 검사를 깨지 않는다. 줄 번호는 지킨다. */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
}

const files = walk(ROOT);
if (files.length < 50) {
  console.error(`파일을 ${files.length}개밖에 못 읽었다 — 검사가 공회전한다.`);
  process.exit(1);
}

const hits = [];
const empties = [];
for (const f of files) {
  const raw = readFileSync(f, 'utf8');
  if (!ALLOW[f]) {
    stripComments(raw).split('\n').forEach((l, i) => {
      if (/\b(localStorage|sessionStorage)\b/.test(l)) hits.push(`${f}:${i + 1}: ${l.trim()}`);
    });
  }
  // 빈 catch 는 블록 주석을 걷지 **않고** 본다 — `catch{ /* 사유 */ }` 는 비어 있지 않다.
  // 주석 줄(`*`·`//` 로 시작)과 줄 끝 `//` 주석 안의 `catch{}` 는 코드가 아니다.
  if (f.startsWith('web/js/core/')) {
    raw.split('\n').forEach((l, i) => {
      const t = l.trim();
      if (t.startsWith('*') || t.startsWith('/*') || t.startsWith('//')) return;
      const code = l.replace(/(^|[^:'"`\\])\/\/.*$/, '$1');
      if (/catch\s*(\([^)]*\))?\s*\{\s*\}/.test(code)) empties.push(`${f}:${i + 1}: ${t}`);
    });
  }
}

let bad = false;
if (hits.length) {
  bad = true;
  console.error('✗ 저장소를 PrefStore 밖에서 직접 부른다 (FR-OPT-11-3):');
  for (const h of hits) console.error('    ' + h);
  console.error('  PrefStore.local / PrefStore.session 을 쓰세요 (web/js/core/pref-store.js).');
}
if (empties.length) {
  bad = true;
  console.error('✗ web/js/core 에 빈 catch{} 가 있다 (FR-OPT-11-3):');
  for (const h of empties) console.error('    ' + h);
  console.error('  무시가 의도라면 ErrorLog.quiet(kind, fn) 으로 적으세요 — 삼키되 흔적을 남깁니다.');
}
if (bad) process.exit(1);

console.log(`  예외 ${Object.keys(ALLOW).length}자리:`);
for (const [f, why] of Object.entries(ALLOW)) console.log(`    ${f} — ${why}`);
console.log(`✓ 저장소 접근이 PrefStore 한 자리를 지난다 · core 의 빈 catch 0 (파일 ${files.length}개)`);

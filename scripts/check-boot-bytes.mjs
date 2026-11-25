#!/usr/bin/env node
/**
 * 부팅 JS 상한 게이트 (PERF_OPTIMIZATION_SRS NFR-PRF-12·D-48, perf 이슈 3.4.12.11).
 *
 * 데스크톱 기본 부팅(터치 아님, `?diag=1` 아님)에서 `web/index.html` 이 싣는 스크립트의 바이트를
 * 로케일마다 더해 NFR-PRF-12 의 상한과 견준다. 바이너리를 띄우지 않는다.
 *   - `<script src>`: `b/<이름>.js` 는 `bundles.txt` 대로 이어 붙이고 주석을 걷은 바이트(`js-strip.mjs`),
 *     그 밖은 파일 바이트 그대로다(서버가 정적 파일을 그대로 낸다).
 *   - `document.write` 로 싣는 인라인은 `var <이름>Src=…` 의 주소를 읽고, 기본 부팅에 싣는지는 아래 표로 정한다.
 *     표에 없는 인라인 로더가 생기면 실패한다 — 그 로더를 기본 부팅이 싣는지 여기에 적어야 한다.
 * 상한은 SRS §4 의 NFR-PRF-12 행에서 읽는다. 실측은 `scenario.mjs --only boot` 의 `jsBytes` 다.
 *
 * 사용: node scripts/check-boot-bytes.mjs [저장소 뿌리]
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readBundles } from './bundles-def.mjs';
import { concatJs } from './js-strip.mjs';

export const SRS = 'docs/internal/PERF_OPTIMIZATION_SRS.md';

// 인라인 로더 → 데스크톱 기본 부팅이 싣는가.
const INLINE_LOADERS = {
  webglSrc: true, // `(pointer: coarse)` 가 아니면 싣는다(D-40·D-47)
  i18nSrc: true, // 활성 로케일 파일 하나(D-34)
  diagSrc: false, // `?diag=1` 일 때만(3.4.12.3)
};

export function srsLimit(md) {
  const row = md.split('\n').find((l) => l.startsWith('| NFR-PRF-12 |'));
  const m = row && row.split('|')[4]?.match(/\(([\d,]+) B\)/);
  if (!m) throw new Error(`${SRS}: NFR-PRF-12 행에서 "(<바이트> B)" 상한을 찾지 못했다`);
  return +m[1].replaceAll(',', '');
}

export function locales(root) {
  return readdirSync(join(root, 'web/js/i18n'))
    .filter((f) => /^[a-z]+\.js$/.test(f))
    .map((f) => f.slice(0, -3))
    .sort();
}

function inlineSrc(body, locale) {
  const m = body.match(/var\s+(\w+)\s*=\s*([^;]+);/);
  if (!m) throw new Error(`index.html: document.write 인라인에서 주소 변수를 찾지 못했다: ${body.slice(0, 80)}`);
  if (!(m[1] in INLINE_LOADERS)) throw new Error(`index.html: 모르는 인라인 로더 ${m[1]} — check-boot-bytes.mjs 의 INLINE_LOADERS 에 적는다`);
  if (!INLINE_LOADERS[m[1]]) return null;
  const parts = m[2].split('+').map((p) => p.trim());
  return parts.map((p) => (p === 'I18N.locale' ? locale : p.replace(/^'(.*)'$/, '$1'))).join('');
}

export function bootScripts(html, locale) {
  const out = [];
  for (const m of html.matchAll(/<script(?:\s+src="([^"]+)")?\s*>([\s\S]*?)<\/script>/g)) {
    const src = m[1] ?? (m[2].includes('document.write') ? inlineSrc(m[2], locale) : null);
    if (src) out.push(src.split('?')[0]);
  }
  return out;
}

export function bootBytes(root, locale) {
  const defs = readBundles(root);
  const read = (p) => readFileSync(join(root, 'web', p));
  return bootScripts(readFileSync(join(root, 'web/index.html'), 'utf8'), locale).map((src) => {
    const b = src.match(/^b\/([^/]+)\.js$/);
    if (!b) return { src, bytes: read(src).length };
    const def = defs.get(b[1]);
    if (!def) throw new Error(`index.html 이 정의에 없는 묶음을 싣는다: ${src}`);
    return { src, bytes: concatJs(b[1], def.js.map((path) => ({ path, src: read(path) }))).length };
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = process.argv[2] || join(dirname(fileURLToPath(import.meta.url)), '..');
  const limit = srsLimit(readFileSync(join(root, SRS), 'utf8'));
  let bad = 0;
  for (const loc of locales(root)) {
    const files = bootBytes(root, loc);
    const sum = files.reduce((a, f) => a + f.bytes, 0);
    const over = sum > limit;
    if (over) {
      bad++;
      for (const f of files) console.error(`  ${f.bytes.toLocaleString('en-US').padStart(10)}  ${f.src}`);
    }
    console.log(`${over ? '✗' : '✓'} 부팅 JS(${loc}, 데스크톱 기본): ${sum.toLocaleString('en-US')} B / 상한 ${limit.toLocaleString('en-US')} B (NFR-PRF-12)`);
  }
  if (bad) process.exit(1);
}

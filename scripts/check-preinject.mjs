#!/usr/bin/env node
/**
 * 첫 페인트 선주입 스크립트가 **상수와 같은 키·범위를 읽는가** (OPTIMIZE_REFACTOR_SRS
 * FR-OPT-11-3 · FEC-20).
 *
 * ## 왜 있는가
 *
 * `web/index.html` 의 `<head>` 인라인 스크립트 셋은 어떤 스크립트보다 먼저 돌아야
 * 하므로(FR-SBC-5 · FR-BTS-3 · FR-B-5) 상수를 볼 수 없다. 그래서 키 문자열과 범위가
 * 리터럴로 박혀 있고, 주석이 *"constants.js 의 그것을 함께 고친다"* 로 사람에게
 * 맡겼다. 한쪽만 고치면 첫 페인트가 조용히 기본값으로 돌아간다 — 폭이 튀고 테마가
 * 한 번 번쩍인다. 아무도 오류를 보지 않는다.
 *
 * ## 무엇을 재는가
 *
 *   ① 선주입이 읽는 키 전부가 아래 표에 있다 (모르는 키 = 대조되지 않는 키)
 *   ② 표의 키·범위·로케일이 원천 상수의 값과 같다
 *   ③ 저장 영역(local|session)이 쓰는 쪽(`PrefStore.<영역>`)과 같다
 *
 * 사용: node scripts/check-preinject.mjs
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const INDEX = 'web/index.html';
const CONST = 'web/js/core/constants.js';
const I18N = 'web/js/core/i18n.js';

const html = readFileSync(INDEX, 'utf8');
const head = html.slice(0, html.indexOf('</head>'));
const inline = [...head.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n');

const errs = [];
if (!inline.includes('Storage.getItem(')) {
  console.error(`✗ ${INDEX} 의 <head> 에서 선주입 스크립트를 못 찾았다 — 검사가 공회전한다.`);
  process.exit(1);
}

/** `const NAME=<값>` 의 값. 문자열·수·문자열 배열만 다룬다. */
function constOf(file, name) {
  const src = readFileSync(file, 'utf8');
  const m = src.match(new RegExp(`^const ${name}\\s*=\\s*([^;\\n]+);`, 'm'));
  if (!m) { errs.push(`${file} 에 ${name} 가 없다`); return undefined; }
  const v = m[1].trim();
  if (/^'[^']*'$/.test(v)) return v.slice(1, -1);
  if (/^\d+$/.test(v)) return +v;
  if (/^\[.*\]$/.test(v)) return [...v.matchAll(/'([^']*)'/g)].map((x) => x[1]);
  errs.push(`${file} 의 ${name} 값을 읽지 못했다: ${v}`);
  return undefined;
}

function jsFiles(dir, out = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) { if (!['test', 'vendor', 'i18n'].includes(e)) jsFiles(p, out); continue; }
    if (e.endsWith('.js')) out.push(p);
  }
  return out;
}
const tree = jsFiles('web/js').map((p) => readFileSync(p, 'utf8')).join('\n');

/** 그 키를 쓰는 쪽이 딛는 영역. `PrefStore.<영역>.<동사>(<상수>` 꼴을 센다. */
function writerArea(constName) {
  const areas = new Set([...tree.matchAll(new RegExp(`PrefStore\\.(local|session)\\.\\w+\\(\\s*${constName}\\b`, 'g'))].map((m) => m[1]));
  if (areas.size !== 1) errs.push(`${constName} 를 쓰는 영역이 하나가 아니다: [${[...areas].join(', ')}]`);
  return [...areas][0];
}

const KEYS = [
  { name: 'SIDEBAR_W_KEY', file: CONST },
  { name: 'SIDEBAR_COLLAPSED_KEY', file: CONST },
  { name: 'THEME_VARS_KEY', file: CONST },
  { name: 'THEME_FOLLOW_KEY', file: CONST },
  { name: 'I18N_STORAGE_KEY', file: I18N, area: 'local' }, // i18n.js 는 PrefStore 앞의 카탈로그다 (check-storage 예외)
];

// ① 선주입이 읽는 키 → 영역. 테마 맵 키는 변수(`tk`)를 지나므로 따로 모은다.
const read = new Map();
for (const m of inline.matchAll(/(local|session)Storage\.getItem\('([^']+)'\)/g)) read.set(m[2], m[1]);
const tk = inline.match(/var tk='([^']+)'/);
if (tk) read.set(tk[1], (inline.match(/(local|session)Storage\.getItem\(tk\)/) || [])[1]);

const known = new Map();
for (const k of KEYS) {
  const v = constOf(k.file, k.name);
  if (v === undefined) continue;
  known.set(v, k);
  // ② 키 문자열.
  if (!read.has(v)) { errs.push(`선주입이 ${k.name}('${v}') 를 읽지 않는다 — 키가 갈렸다`); continue; }
  // ③ 영역.
  const want = k.area || writerArea(k.name);
  if (want && read.get(v) !== want) errs.push(`${k.name}: 선주입은 ${read.get(v)}Storage, 쓰는 쪽은 PrefStore.${want}`);
}
for (const [key] of read) if (!known.has(key)) errs.push(`선주입이 대조되지 않는 키 '${key}' 를 읽는다 — 이 표에 원천 상수를 더하라`);

// ② 범위: 폭의 하한·상한.
const lo = constOf(CONST, 'SIDEBAR_W_MIN_PX'), hi = constOf(CONST, 'SIDEBAR_W_MAX_PX');
const range = inline.match(/w>=(\d+)&&w<=(\d+)/);
if (!range) errs.push('선주입에서 폭의 범위(w>=…&&w<=…)를 못 찾았다');
else if (+range[1] !== lo || +range[2] !== hi) errs.push(`폭의 범위 ${range[1]}~${range[2]} ≠ SIDEBAR_W_MIN_PX·MAX_PX ${lo}~${hi}`);

// ② 테마 추종의 두 맵 접미사 — 쓰는 쪽(`THEME_VARS_KEY+'.dark'`)과 같아야 한다.
for (const sfx of ['.dark', '.light']) {
  if (!inline.includes(`'${sfx}'`)) errs.push(`선주입이 테마 맵 접미사 '${sfx}' 를 모른다`);
  if (!tree.includes(`THEME_VARS_KEY+'${sfx}'`)) errs.push(`쓰는 쪽에 THEME_VARS_KEY+'${sfx}' 가 없다 — 접미사가 갈렸다`);
}

// ② 로케일: 선주입의 `lc==='<다른 것>'?'<다른 것>':'<기본>'` 이 I18N_LOCALES·I18N_DEFAULT 와 같다.
const locales = constOf(I18N, 'I18N_LOCALES'), def = constOf(I18N, 'I18N_DEFAULT');
const lc = inline.match(/lc==='(\w+)'\?'(\w+)':'(\w+)'/);
if (!lc) errs.push('선주입에서 로케일 판정(lc===…)을 못 찾았다');
else if (Array.isArray(locales)) {
  const got = [lc[3], lc[1]].sort().join(','), want = [...locales].sort().join(',');
  if (lc[1] !== lc[2] || lc[3] !== def || got !== want) errs.push(`선주입의 로케일 [${lc[3]} 기본, ${lc[1]}] ≠ I18N_LOCALES [${locales}] · 기본 ${def}`);
}

if (errs.length) {
  console.error('✗ index.html 선주입이 원천 상수와 갈렸다 (FR-OPT-11-3 · FEC-20):');
  for (const e of errs) console.error('    ' + e);
  console.error('');
  console.error('  선주입은 상수를 볼 수 없다 — 두 자리를 함께 고치세요.');
  process.exit(1);
}
console.log(`✓ 선주입 키 ${read.size}개·폭 범위·로케일이 원천 상수와 같다`);

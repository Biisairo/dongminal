import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * UX_AUDIT_FIX_SRS TC-UXF-98·99 (FR-UXF-100~102, D-36): 아이콘은 스프라이트 한 계열이다.
 *
 * 단추·표식에 문자 아이콘이 다시 새지 않게 막는다. 글자 흐름의 일부인 것(FR-UXF-101)은 아래 허용 목록에 이유와 함께 둔다.
 */
const WEB = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const GLYPHS = /[▸▾★☆✓✔✕✖⚠▣↳↗‹›⌄⟳⚙☰]/u;

// 파일 단위 허용 — 그 파일의 글자는 아이콘이 아니다.
const FILE_OK = {
  'js/core/settings-schema.js': '`where` 는 설정 자리를 적은 문장 속 경로다(`Terminal ▸ …`)',
};
// 카탈로그 키 단위 허용.
const KEY_OK = {
  'edge.invited_notice': '문장 속 경로(`설정 ▸ 간선`)',
  'core.term_upload_ok': '알림 문장의 머리 글자 — 글자 흐름의 일부다 (FR-UXF-101)',
};

function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) { if (!['vendor', 'test', 'i18n'].includes(e)) walk(p, out); continue }
    out.push(p);
  }
  return out;
}

// 줄 번호가 맞도록 주석 자리의 줄바꿈은 남긴다.
const keepLines = (m) => m.replace(/[^\n]/g, ' ');
const stripJs = (s) => s.replace(/\/\*[\s\S]*?\*\//g, keepLines).replace(/(^|[^:\\])\/\/.*$/gm, '$1');
const stripCss = (s) => s.replace(/\/\*[\s\S]*?\*\//g, ' ');

test('TC-UXF-98: 코드에 문자 아이콘이 없다', () => {
  const bad = [];
  for (const p of walk(join(WEB, 'js'))) {
    if (!p.endsWith('.js')) continue;
    const rel = relative(WEB, p);
    if (FILE_OK[rel]) continue;
    stripJs(readFileSync(p, 'utf8')).split('\n').forEach((l, i) => { if (GLYPHS.test(l)) bad.push(`${rel}:${i + 1}: ${l.trim().slice(0, 90)}`) });
  }
  assert.deepEqual(bad, []);
});

test('TC-UXF-98: CSS content 에 문자 아이콘이 없다', () => {
  const bad = [];
  for (const f of readdirSync(WEB).filter((f) => f.endsWith('.css'))) {
    for (const m of stripCss(readFileSync(join(WEB, f), 'utf8')).matchAll(/content:\s*(['"])(.*?)\1/g)) {
      if (GLYPHS.test(m[2])) bad.push(`${f}: content:${m[1]}${m[2]}${m[1]}`);
    }
  }
  assert.deepEqual(bad, []);
});

test('TC-UXF-98: 문구 카탈로그 값에 문자 아이콘이 없다', () => {
  const bad = [];
  for (const f of ['ko.js', 'en.js']) {
    for (const m of readFileSync(join(WEB, 'js', 'i18n', f), 'utf8').matchAll(/^\s*'([^']+)':\s*'((?:[^'\\]|\\.)*)'/gm)) {
      if (!KEY_OK[m[1]] && GLYPHS.test(m[2])) bad.push(`${f} ${m[1]}: ${m[2]}`);
    }
  }
  assert.deepEqual(bad, []);
});

test('TC-UXF-99: 새 심볼이 스프라이트에 있고 24×24 형식이다', () => {
  const html = readFileSync(join(WEB, 'index.html'), 'utf8');
  for (const id of ['app-window', 'file-plus', 'folder-plus', 'link', 'triangle-alert', 'corner-down-right']) {
    const m = html.match(new RegExp(`<symbol id="i-${id}"([^>]*)>([\\s\\S]*?)</symbol>`));
    assert.ok(m, `i-${id} 가 없다`);
    assert.match(m[1], /viewBox="0 0 24 24"/);
    assert.doesNotMatch(m[0], /stroke-width|fill="(?!none)/, `i-${id} 가 선·채움을 스스로 정한다 (FR-GLY-2)`);
  }
});

test('TC-UXF-99: 탐색기 머리 단추에 별도 SVG 가 없다', () => {
  // REFACTOR3_FE_REST5_SRS FR-FR5-20: 옛 constants-editor.js 는 두 파일이다.
  const src = ['constants-editor.js', 'constants-explorer.js'].map((f) => readFileSync(join(WEB, 'js', 'core', f), 'utf8')).join('\n');
  assert.doesNotMatch(stripJs(src), /viewBox="0 0 16 16"/);
});

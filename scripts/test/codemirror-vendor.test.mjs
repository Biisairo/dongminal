import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

/**
 * CodeMirror 벤더 묶음 — CODEMIRROR_MIGRATION_SRS 묶음 V.
 *
 * 커밋된 출력(`web/vendor/codemirror`)을 검사한다. 묶음 입력이 설치돼 있으면
 * (`scripts/codemirror/node_modules`) 다시 묶어 커밋된 출력과 바이트가 같은지도 본다 —
 * 입력만 고치고 출력을 다시 만들지 않은 상태가 그것으로 드러난다.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = path.join(root, 'web/vendor/codemirror');
const INPUT = path.join(root, 'scripts/codemirror');
const BUILD = path.join(root, 'scripts/build-codemirror.mjs');

const KB = 1024;
const FIRST_LOAD_MAX = 250 * KB; // NFR-CMR-1
const TOTAL_MAX = 1536 * KB; // NFR-CMR-2
const MIN_LAZY_LANGS = 100; // FR-CMR-3: language-data 의 언어 수(115) 근처

// 단계 A 가 진입점에서 꺼내 쓰는 이름. `export *` 끼리 이름이 겹치면 ESM 규칙으로
// 그 이름이 조용히 빠지므로, 빠지면 안 되는 것을 여기서 못박는다.
const REQUIRED_EXPORTS = [
  'EditorState', 'EditorSelection', 'Compartment', 'StateField', 'StateEffect', 'Annotation',
  'Transaction', 'Text', 'RangeSet', 'RangeSetBuilder', 'Prec', 'Facet',
  'EditorView', 'ViewPlugin', 'Decoration', 'WidgetType', 'keymap', 'gutter', 'GutterMarker',
  'lineNumbers', 'drawSelection', 'highlightActiveLine', 'highlightActiveLineGutter',
  'rectangularSelection', 'crosshairCursor', 'showTooltip', 'hoverTooltip', 'showPanel',
  'history', 'historyKeymap', 'defaultKeymap', 'undo', 'redo', 'indentWithTab',
  'syntaxTree', 'foldable', 'foldGutter', 'foldKeymap', 'indentUnit', 'bracketMatching',
  'indentOnInput', 'syntaxHighlighting', 'HighlightStyle', 'LanguageDescription', 'StreamLanguage',
  'SearchQuery', 'SearchCursor', 'RegExpCursor', 'highlightSelectionMatches',
  'autocompletion', 'closeBrackets', 'closeBracketsKeymap', 'completionKeymap',
  'setDiagnostics', 'lintGutter', 'diagnosticCount',
  'MergeView', 'unifiedMergeView', 'getChunks',
  'LSPClient', 'languageServerExtensions', 'serverDiagnostics', 'hoverTooltips',
  'jumpToDefinition', 'findReferences',
  'languages', 'indentationMarkers',
];

const gunzip = (f) => zlib.gunzipSync(fs.readFileSync(f)).toString('utf8');

function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

// 정적 import 만 따라간다 — 첫 로드에 함께 오는 파일이 그것이다.
function staticClosure(entry) {
  const seen = new Set();
  const visit = (name) => {
    if (seen.has(name)) return;
    seen.add(name);
    const src = gunzip(path.join(OUT, name + '.gz'));
    for (const m of src.matchAll(/(?:^|[;}\s])(?:import|export)\s*(?:[\w$*{},\s]*?from\s*)?"\.\/([^"]+)"/g)) {
      visit(m[1]);
    }
  };
  visit(entry);
  return seen;
}

function exportedNames(src) {
  const names = new Set();
  for (const m of src.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(',')) {
      const s = part.trim();
      if (!s) continue;
      const as = s.split(/\s+as\s+/);
      names.add((as[1] || as[0]).trim());
    }
  }
  return names;
}

test('FR-CMR-2: 출력은 .gz 로만 담기고 모두 풀린다', () => {
  assert.ok(fs.existsSync(OUT), `${OUT} 가 없다`);
  const files = walk(OUT);
  assert.ok(files.length > 0);
  for (const f of files) {
    assert.ok(f.endsWith('.gz'), `raw 파일: ${path.relative(OUT, f)}`);
    assert.doesNotThrow(() => gunzip(f), `깨진 gzip: ${path.relative(OUT, f)}`);
  }
});

test('FR-CMR-1a: 묶음 입력은 web/vendor 에 없다', () => {
  for (const f of walk(OUT)) {
    const base = path.basename(f, '.gz');
    assert.ok(!/^(package(-lock)?\.json|entry\.js)$/.test(base), `입력 파일이 출력에 있다: ${base}`);
  }
});

test('FR-CMR-1·6: 진입 파일 cm.js 가 단계 A 의 이름을 모두 내보낸다', () => {
  const names = exportedNames(gunzip(path.join(OUT, 'cm.js.gz')));
  const missing = REQUIRED_EXPORTS.filter((n) => !names.has(n));
  assert.deepEqual(missing, [], `빠진 이름: ${missing.join(', ')}`);
});

test('FR-CMR-6: 앱이 쓰는 CM.* 이름이 전부 진입 파일에서 나온다', () => {
  const names = exportedNames(gunzip(path.join(OUT, 'cm.js.gz')));
  const used = new Set();
  for (const f of walk(path.join(root, 'web/js')).filter((p) => p.endsWith('.js'))) {
    for (const m of fs.readFileSync(f, 'utf8').matchAll(/\bCM\.([A-Za-z_$][\w$]*)/g)) used.add(m[1]);
  }
  const missing = [...used].filter((n) => !names.has(n));
  assert.deepEqual(missing, [], `묶음에 없는 이름: ${missing.join(', ')}`);
});

test('FR-CMR-3: 언어는 동적 import 로 나뉜다', () => {
  const all = walk(OUT).map((f) => gunzip(f)).join('\n');
  const lazy = new Set([...all.matchAll(/import\("\.\/([^"]+)"\)/g)].map((m) => m[1]));
  assert.ok(lazy.size >= MIN_LAZY_LANGS, `동적 청크 ${lazy.size}개 (< ${MIN_LAZY_LANGS})`);
  const first = staticClosure('cm.js');
  const leaked = [...lazy].filter((n) => first.has(n));
  assert.deepEqual(leaked, [], `언어 청크가 첫 로드에 섞였다: ${leaked.join(', ')}`);
});

test('NFR-CMR-1: 첫 로드는 gzip 250KB 이하다', () => {
  let sum = 0;
  for (const n of staticClosure('cm.js')) sum += fs.statSync(path.join(OUT, n + '.gz')).size;
  assert.ok(sum <= FIRST_LOAD_MAX, `첫 로드 ${sum} 바이트 (> ${FIRST_LOAD_MAX})`);
});

test('NFR-CMR-2: 벤더 총량은 gzip 1.5MB 이하다', () => {
  const sum = walk(OUT).reduce((a, f) => a + fs.statSync(f).size, 0);
  assert.ok(sum <= TOTAL_MAX, `총량 ${sum} 바이트 (> ${TOTAL_MAX})`);
});

test('FR-CMR-5a: 묶인 패키지의 라이선스가 함께 담긴다', () => {
  const lic = gunzip(path.join(OUT, 'THIRD_PARTY_LICENSES.txt.gz'));
  for (const pkg of ['@codemirror/view', '@codemirror/state', '@codemirror/lsp-client', '@lezer/common', 'marked', 'style-mod']) {
    assert.match(lic, new RegExp(`^## ${pkg.replace('/', '\\/')}@\\d`, 'm'), `라이선스 없음: ${pkg}`);
  }
});

test('FR-CMR-5: check-vendor.sh 가 판 기록과 파일이 맞다고 답한다', () => {
  assert.doesNotThrow(() =>
    execFileSync(path.join(root, 'scripts/check-vendor.sh'), { cwd: root, encoding: 'utf8', stdio: 'pipe' }),
  );
});

const installed = fs.existsSync(path.join(INPUT, 'node_modules'));

test('FR-CMR-4: 같은 입력으로 다시 묶으면 커밋된 출력과 바이트가 같다', { skip: !installed && '묶음 입력 미설치' }, () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-out-'));
  // 실패 경로: 낡은 파일이 남아 있어도 출력은 입력만으로 정해진다.
  fs.writeFileSync(path.join(tmp, 'stale-chunk.js.gz'), 'x');
  execFileSync(process.execPath, [BUILD, '--out', tmp], { cwd: root, stdio: 'pipe' });
  const rel = (d) => walk(d).map((f) => path.relative(d, f)).sort();
  assert.deepEqual(rel(tmp), rel(OUT));
  for (const r of rel(OUT)) {
    assert.ok(fs.readFileSync(path.join(tmp, r)).equals(fs.readFileSync(path.join(OUT, r))), `다른 바이트: ${r}`);
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

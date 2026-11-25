import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { pageScripts, readBundles } from '../bundles-def.mjs';

/**
 * PERF 3.4.12.3 (perf/M3_BOOT_SCOPE.md §3 `diag`): 진단 오버레이는 부팅 묶음 밖의 `[diag]` 묶음이다.
 * 페이지의 인라인 스크립트가 `?diag=1` 일 때만 `b/diag.js` 를 `b/boot.js` 바로 뒤에 쓴다.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const html = readFileSync(join(ROOT, 'web', 'index.html'), 'utf8');
const BOOT_TAG = '<script src="b/boot.js?v=__ASSETV__"></script>';

test('diag.js 는 [diag] 묶음 하나에만 있고 페이지가 직접 싣지 않는다', () => {
  const defs = readBundles(ROOT);
  assert.deepEqual(defs.get('diag')?.js, ['js/ui/diag.js']);
  assert.ok(!pageScripts(html, defs).includes('js/ui/diag.js'), '부팅이 diag.js 를 싣는다');
});

test('b/boot.js 바로 다음 인라인 스크립트가 ?diag=1 일 때만 b/diag.js 를 쓴다', () => {
  const at = html.indexOf(BOOT_TAG);
  assert.ok(at >= 0, 'b/boot.js 태그가 없다');
  const next = html.slice(at + BOOT_TAG.length).match(/^(?:\s*<!--[\s\S]*?-->)*\s*<script>([\s\S]*?)<\/script>/);
  assert.ok(next, 'b/boot.js 바로 뒤에 인라인 스크립트가 없다');
  assert.match(next[1], /b\/diag\.js\?v=__ASSETV__/);
  assert.match(next[1], /document\.write\(/);
  // 조건은 DiagOverlay.start 의 것과 같은 정규식이다 — 하나만 바뀌면 묶음은 실리는데 서지 않거나 그 반대다.
  const diag = readFileSync(join(ROOT, 'web', 'js', 'ui', 'diag.js'), 'utf8');
  const re = diag.match(/if\(!(\/\[\?&\]diag=1[^/]*\/)\.test\(location\.search\)\)/);
  assert.ok(re, 'DiagOverlay.start 의 조건을 못 찾았다');
  assert.ok(next[1].includes(re[1] + '.test(location.search)'), '인라인 조건이 DiagOverlay.start 와 다르다');
});

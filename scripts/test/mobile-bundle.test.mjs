import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { pageScripts, readBundles } from '../bundles-def.mjs';

/**
 * PERF 3.4.12.8 (perf/M3_BOOT_SCOPE.md §3 `mobile`): 모바일 본체는 부팅 묶음 밖이다. 키바의 순수 함수(keybar.js)는 설정 ▸
 * Terminal 도 쓰므로 라이브러리 묶음 `[keybar]` 로 따로 두고, `mobile`·`settings` 가 needs 로 싣는다.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const html = readFileSync(join(ROOT, 'web', 'index.html'), 'utf8');
const src = (rel) => readFileSync(join(ROOT, 'web', rel), 'utf8');

test('모바일 본체 넷은 [mobile], keybar.js 는 [keybar] 이고 페이지가 싣지 않는다', () => {
  const defs = readBundles(ROOT);
  assert.deepEqual(defs.get('mobile')?.js, ['js/ui/drawer-sheet.js', 'js/core/mobile-controller.js',
    'js/core/mobile-sheets.js', 'js/core/mobile-nav.js']);
  assert.deepEqual(defs.get('keybar')?.js, ['js/core/keybar.js']);
  const page = pageScripts(html, defs);
  for (const f of [...defs.get('mobile').js, ...defs.get('keybar').js]) assert.ok(!page.includes(f), '부팅이 싣는다: ' + f);
  assert.ok(page.includes('js/core/mobile-shell.js'), '껍데기는 부팅에 있다');
});

test('등록: keybar 는 라이브러리, mobile·settings 는 keybar 를 needs 로 든다', () => {
  const shell = src('js/core/mobile-shell.js');
  assert.match(shell, /Screens\.register\('keybar'\)/);
  assert.match(shell, /Screens\.register\('mobile',\{needs:\['keybar'\]\}\)/);
  assert.match(src('js/core/settings-controller.js'), /Screens\.register\('settings',\s*\{needs:\[[^\]]*'keybar'[^\]]*\]\}\)/);
});

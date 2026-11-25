import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * REFACTOR3_FE_REST2_SRS FR-FR2-10·11 · TC-FR2-4 (FC-18): `web/js` 의 줄은 코드포인트 198 이하다.
 * `i18n/`(데이터)·`test/`·`vendor/`(남의 코드)·`ui/themes.js`·`ui/themes-catalog.js`(테마 데이터)는 세지 않는다. 기준은 D-FR2-10.
 */
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const LIMIT = 198;
const SKIP_DIRS = new Set(['i18n', 'test', 'vendor']);
const SKIP_FILES = new Set(['ui/themes.js', 'ui/themes-catalog.js']);

function* jsFiles(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) yield* jsFiles(p) }
    else if (e.name.endsWith('.js') && !SKIP_FILES.has(relative(ROOT, p))) yield p;
  }
}

test('TC-FR2-4: web/js 의 줄은 198 코드포인트 이하다', () => {
  const over = [];
  for (const f of jsFiles(ROOT)) {
    readFileSync(f, 'utf8').split('\n').forEach((l, i) => {
      const n = [...l].length;
      if (n > LIMIT) over.push(`${relative(ROOT, f)}:${i + 1} (${n})`);
    });
  }
  assert.deepEqual(over, []);
});

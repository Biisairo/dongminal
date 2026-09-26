import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * BROWSER_TAB_SRS TC-BRT-54 — 옛 방식(VIEWER_URL_OPEN)이 저장소에 없다.
 *
 * 문서(`docs/`)는 이력이라 대상이 아니다. 이력을 적은 주석 하나(`check-env-docs.sh`)와
 * 이 파일 자신은 뺀다.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const DIRS = ['internal', 'cmd', 'web', 'e2e', 'scripts'];
const SKIP = new Set(['web/js/test/brt-removal.test.mjs', 'scripts/check-env-docs.sh']);
const PATTERNS = [/\bopenUrl\b/, /\/api\/open-url\/where/, /open-url\.js/, /platform\.Opener/, /\bOpener interface/,
  /DONGMINAL_URL_OPEN/, /\bOpenUrl\b/];

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'vendor' || name.startsWith('.')) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (/\.(go|js|mjs|ts|html|css|sh)$/.test(name)) yield p;
  }
}

test('TC-BRT-54: openUrl 액션·/api/open-url/where·open-url.js·platform.Opener·DONGMINAL_URL_OPEN 이 없다', () => {
  const hits = [];
  let n = 0;
  for (const d of DIRS) for (const f of walk(join(ROOT, d))) {
    const rel = relative(ROOT, f);
    if (SKIP.has(rel)) continue;
    n++;
    const src = readFileSync(f, 'utf8');
    for (const re of PATTERNS) if (re.test(src)) hits.push(rel + ' ~ ' + re);
  }
  assert.ok(n > 500, '파일을 ' + n + '개밖에 못 읽었다 — 검사가 공회전한다');
  assert.deepEqual(hits, []);
});

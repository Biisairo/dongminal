import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * `app.testing` 계약의 이름은 한 번씩만 선다 — 겹치면 `defineProperty` 가 던져 계약 전체가
 * 서지 않고 e2e 가 통째로 무너진다(실측: `_confirmClose` 두 번).
 */
test('APP_TESTING_NAMES 에 겹치는 이름이 없다', () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'core', 'app-testing.js'), 'utf8');
  const body = src.slice(src.indexOf('const APP_TESTING_NAMES'), src.indexOf('];', src.indexOf('const APP_TESTING_NAMES')));
  const names = [...body.matchAll(/'([A-Za-z_$][\w$]*)'/g)].map((m) => m[1].replace(/^_/, ''));
  const dup = names.filter((n, i) => names.indexOf(n) !== i);
  assert.ok(names.length > 50, '이름을 ' + names.length + '개밖에 못 읽었다');
  assert.deepEqual(dup, []);
});

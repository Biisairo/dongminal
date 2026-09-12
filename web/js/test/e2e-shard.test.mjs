/**
 * `scripts/e2e-shard.mjs` 의 계약.
 *
 * **이 검사가 막는 것은 하나다: 조용히 안 도는 스펙.** 계획기가 파일을
 * 빠뜨리면 그 샤드에도 다른 샤드에도 없게 되고, 그러면 그 검사들은 **돌지 않은
 * 채 전량이 초록**이 된다 — 이 저장소가 가장 비싸게 겪는 실패 꼴이다
 * (M6 §4-A-1: 아무것도 재지 않던 단정).
 *
 * 그래서 여기서 보는 것은 균형이 아니라 **덮음과 겹침**이다. 균형은 좋으면
 * 좋은 것이고, 덮음은 틀리면 안 되는 것이다.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SCRIPT = join(ROOT, 'scripts', 'e2e-shard.mjs');

const specs = readdirSync(join(ROOT, 'e2e'))
  .filter((f) => f.endsWith('.spec.ts'))
  .map((f) => 'e2e/' + f)
  .sort();

const list = (i, n) =>
  execFileSync('node', [SCRIPT, '--list', `${i}/${n}`], { cwd: ROOT, encoding: 'utf8' })
    .trim().split('\n').filter(Boolean);

test('스펙이 실제로 있다 (빈 목록으로 초록이 되지 않는다)', () => {
  assert.ok(specs.length > 50, `스펙 ${specs.length}개 — 너무 적다`);
});

for (const n of [1, 3, 8, 16]) {
  test(`샤드 ${n}개로 갈라도 전부 정확히 한 번씩 돈다`, () => {
    const seen = [];
    for (let i = 1; i <= n; i++) seen.push(...list(i, n));

    const dup = seen.filter((f, i) => seen.indexOf(f) !== i);
    assert.deepEqual(dup, [], '두 샤드가 같은 파일을 돈다');

    assert.deepEqual([...seen].sort(), specs, '덮이지 않은 스펙이 있다');
  });
}

test('경로를 슬래시로 낸다 (windows 에서도 playwright 가 거를 수 있게)', () => {
  for (const f of list(1, 8)) assert.ok(!f.includes('\\'), f);
});

test('같은 입력이 같은 분할을 낸다 (로컬과 CI 가 갈리지 않는다)', () => {
  assert.deepEqual(list(3, 8), list(3, 8));
});

test('샤드 수가 파일 수보다 많으면 빈 목록 대신 실패한다', () => {
  // 빈 목록을 그대로 넘기면 인자 없는 playwright 가 **전량**을 돈다 — 그 샤드가
  // 148개를 통째로 다시 도는 모양이 된다. 조용히 넘기지 않는다.
  assert.throws(() => list(specs.length + 1, specs.length + 1));
});

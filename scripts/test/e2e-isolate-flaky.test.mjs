import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ISOLATION_ROUNDS, MAX_FLAKY, classify, isolate, specArg } from '../e2e-isolate-flaky.mjs';

/**
 * `scripts/e2e-isolate-flaky.mjs` 의 판정 — `E2E_FLAKY_ISOLATION_SRS` V-EFI-1~5·7.
 *
 * 이 스크립트가 하는 일의 전부가 **판정**이고, 판정이 틀리면 게이트가 틀린다.
 * 그래서 실제 playwright 를 부르지 않고 실행기를 주입해서 잰다 — 진짜로 돌리면
 * 이 테스트가 몇 분씩 걸리고 **그 자체로 흔들려서**, 흔들림을 가리려고 만든
 * 장치가 흔들림으로 판정되는 꼴이 된다.
 */

const item = (file, line, title = 'T') => ({ file, line, title });

test('V-EFI-7: classify — 하나라도 통과하면 부하다', () => {
  assert.equal(classify([true, false, false]), 'load');
  assert.equal(classify([false, true, false]), 'load');
  assert.equal(classify([false, false, true]), 'load');
});

test('V-EFI-7: classify — 전부 져야 결함이다', () => {
  assert.equal(classify([false, false, false]), 'defect');
});

test('V-EFI-1: flaky 가 없으면 한 번도 돌지 않는다', async () => {
  let calls = 0;
  const r = await isolate([], async () => { calls++; return true });
  assert.equal(calls, 0);
  assert.equal(r.defect.length, 0);
  assert.equal(r.load.length, 0);
  assert.equal(r.skipped, false);
});

test('V-EFI-2: 3회 전부 지면 결함이고 이름이 남는다', async () => {
  const calls = [];
  const it = item('e2e/editor-save.spec.ts', 153, 'TC-ESV-3: 저장 조합을 바꾸면 그 조합이 저장한다');
  const r = await isolate([it], async (_x, round) => { calls.push(round); return false });

  assert.equal(calls.length, ISOLATION_ROUNDS);
  assert.deepEqual(calls, [1, 2, 3]);
  assert.equal(r.defect.length, 1);
  assert.equal(r.defect[0].title, it.title);
  assert.equal(r.load.length, 0);
});

test('V-EFI-3: 한 번이라도 통과하면 부하로 분류된다', async () => {
  const it = item('e2e/git-remote.spec.ts', 42);
  // 1·2 회차는 지고 3 회차에 통과한다.
  const r = await isolate([it], async (_x, round) => round === ISOLATION_ROUNDS);

  assert.equal(r.load.length, 1);
  assert.equal(r.defect.length, 0);
});

test('FR-EFI-5a: 통과한 회차 뒤로는 돌지 않는다', async () => {
  let calls = 0;
  // 첫 회차에 통과한다 — 남은 두 회차는 판정을 바꾸지 못한다.
  const r = await isolate([item('e2e/a.spec.ts', 1)], async () => { calls++; return true });

  assert.equal(calls, 1, '첫 회차 통과 뒤에도 돌면 값만 쓴다');
  assert.equal(r.load.length, 1);
});

test('V-EFI-2: 결함과 부하가 섞여도 각자 자리로 간다', async () => {
  const bad = item('e2e/bad.spec.ts', 10, '언제나 진다');
  const ok = item('e2e/ok.spec.ts', 20, '단독에서는 된다');
  const r = await isolate([bad, ok], async (x) => x.file === ok.file);

  assert.deepEqual(r.defect.map((x) => x.file), [bad.file]);
  assert.deepEqual(r.load.map((x) => x.file), [ok.file]);
});

test('V-EFI-5: 상한을 넘으면 돌지 않고 그 사실을 남긴다', async () => {
  let calls = 0;
  const many = Array.from({ length: MAX_FLAKY + 1 }, (_, i) => item(`e2e/f${i}.spec.ts`, i + 1));
  const r = await isolate(many, async () => { calls++; return false });

  assert.equal(calls, 0, '상한을 넘으면 한 번도 돌지 않는다');
  assert.equal(r.skipped, true);
  assert.match(r.reason, /8/);
  assert.equal(r.defect.length, 0, '건너뛴 것은 결함이 아니다 — 판정하지 않았다');
});

test('V-EFI-5: 상한과 같은 수는 돈다', async () => {
  let calls = 0;
  const exact = Array.from({ length: MAX_FLAKY }, (_, i) => item(`e2e/f${i}.spec.ts`, i + 1));
  await isolate(exact, async () => { calls++; return true });

  assert.equal(calls, MAX_FLAKY, '경계는 넘지 않은 것이다');
});

test('V-EFI-4: 제목이 아니라 위치로 건다', () => {
  // 제목에는 `›` 와 괄호와 한글과 공백이 섞여 있다. 그것을 셸로 넘기면 깨진다.
  const it = item('e2e/editor-link.spec.ts', 72, '묶음 L — git 핀 ↔ Editor 행 (FR-EDT-33·34)');
  assert.equal(specArg(it), 'e2e/editor-link.spec.ts:72');
});

test('V-EFI-4: 위치 인자에 제목의 어느 조각도 섞이지 않는다', () => {
  const it = item('e2e/a.spec.ts', 5, '› ( ) · — ↔ 한글');
  const arg = specArg(it);
  for (const ch of ['›', '(', ')', '·', '—', '↔', '한글', ' ']) {
    assert.ok(!arg.includes(ch), `위치 인자에 ${ch} 가 섞였다: ${arg}`);
  }
});

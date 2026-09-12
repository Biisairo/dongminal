#!/usr/bin/env node
/**
 * e2e 의 고정 대기는 **근거가 있는 예외만** 남는다 (`TEST-16`).
 *
 * `page.waitForTimeout(...)` 은 "그만큼 기다리면 되겠지" 다 — 조건을 보지 않으므로
 * 느린 기계에서 흔들리고 빠른 기계에서 시간을 버린다. `flaky > 0` 이 CI 실패로
 * 승격된 뒤로(`CI_GATES_SRS §3`) 그 흔들림은 곧 빨간 빌드다.
 *
 * 그런데 **전부 걷을 수는 없다.** 재려는 것이 "일어나지 않음" 이면 기다릴 신호가
 * 없다: 중복 발동이 오지 않는다 · 요청이 더 나가지 않는다 · 취소한 명령이 돌지
 * 않는다. 그 자리는 시간을 주고 그래도 그대로인지 보는 것이 검사 자체다.
 *
 * 그래서 금지가 아니라 **근거를 요구한다.** 파일에 `TEST-16` 이라는 표식과 함께
 * 사유가 적혀 있으면 통과한다 — 새로 고정 대기를 들이는 사람은 그 자리에서
 * "왜 조건으로 바꿀 수 없는가" 를 적게 된다.
 */
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const DIR = 'e2e';
const CALL = /\.waitForTimeout\s*\(/;
const MARK = 'TEST-16';

const bad = [];
let calls = 0;
let files = 0;

for (const name of readdirSync(DIR).sort()) {
  if (!name.endsWith('.ts')) continue;
  const path = join(DIR, name);
  const src = readFileSync(path, 'utf8');
  const lines = src.split('\n');
  // 주석 줄의 언급은 호출이 아니다 — 이 검사기 자신과 과거를 적은 주석이 그렇다.
  const hits = lines
    .map((l, i) => [l, i + 1])
    .filter(([l]) => CALL.test(l) && !/^\s*(\/\/|\*)/.test(l));
  if (!hits.length) continue;
  files++;
  calls += hits.length;
  if (!src.includes(MARK)) bad.push([path, hits.length]);
}

if (bad.length) {
  console.error('e2e 고정 대기에 근거가 없다 — `TEST-16` 표식과 사유를 적어라:');
  for (const [p, n] of bad) console.error(`  ${p} (${n}곳)`);
  console.error('\n조건으로 바꿀 수 있으면 바꿔라 (expect.poll · toHaveCount · nextFrames).');
  console.error('바꿀 수 없다면 — 재려는 것이 "일어나지 않음" 이라면 — 그 사실을 적어라.');
  process.exit(1);
}
console.log(`e2e-waits ok — 고정 대기 ${calls}곳 · ${files}파일, 전부 근거가 있다`);

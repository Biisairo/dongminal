#!/usr/bin/env node
/**
 * 전량 실행의 산출물에서 **파일별 소요시간**을 모아 `e2e/shard-timings.json` 을
 * 만든다. `scripts/e2e-shard.mjs` 가 그것으로 샤드를 가른다.
 *
 * 이 파일은 **생성물이다.** 손으로 고치지 않는다 — 손으로 적은 시간표는 조용히
 * 낡고, 낡은 시간표는 없는 것보다 나쁘다(있다고 믿게 만든다). 낡으면 분할이
 * 덜 고를 뿐 **틀리지는 않는다**: 모르는 파일은 가장 무거운 것으로 친다.
 *
 * 입력은 `make e2e` 가 샤드마다 남기는 JSON 리포트다. 여덟을 합친다 — 한
 * 샤드만 보면 그 샤드에 든 파일만 알게 되고, 그러면 다음 분할이 나머지를 전부
 * "모르는 것" 으로 친다.
 *
 * **재시도까지 더한다.** 흔들려서 두 번 도는 파일은 실제로 그만큼 시간을
 * 먹었고, 균형을 맞추는 쪽에서 보면 그것이 사실이다.
 *
 * 사용: node scripts/e2e-timings.mjs [리포트 경로 …]
 *       (생략하면 test-results 아래 샤드별 report.json 을 찾는다)
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'fs';
import { join, basename } from 'path';

const OUT = 'e2e/shard-timings.json';

if (process.argv.includes('-h') || process.argv.includes('--help')) {
  console.log(`e2e 파일별 소요시간 수집

  make e2e 가 남긴 샤드별 JSON 리포트를 합쳐 ${OUT} 을 쓴다.
  인자를 주지 않으면 test-results/s*/report.json 을 찾는다.`);
  process.exit(0);
}

let inputs = process.argv.slice(2).filter((a) => !a.startsWith('-'));
if (!inputs.length) {
  const root = 'test-results';
  if (existsSync(root)) {
    inputs = readdirSync(root)
      .filter((d) => /^s\d+$/.test(d))
      .map((d) => join(root, d, 'report.json'))
      .filter(existsSync);
  }
}
if (!inputs.length) {
  console.error('JSON 리포트를 찾지 못했다 — `make e2e` 를 먼저 돌리세요.');
  process.exit(1);
}

/** Playwright JSON 의 suite 트리를 훑어 `(파일, ms)` 를 꺼낸다. */
function walk(suite, out, file) {
  const f = suite.file ? basename(suite.file) : file;
  for (const spec of suite.specs || []) {
    for (const t of spec.tests || []) {
      for (const r of t.results || []) {
        const name = (spec.file && basename(spec.file)) || f;
        if (name) out.set(name, (out.get(name) || 0) + (r.duration || 0));
      }
    }
  }
  for (const s of suite.suites || []) walk(s, out, f);
}

const ms = new Map();
let files = 0;
for (const p of inputs) {
  let json;
  try {
    json = JSON.parse(readFileSync(p, 'utf8'));
  } catch (e) {
    console.error(`읽지 못했다: ${p} — ${e.message}`);
    continue;
  }
  files++;
  for (const s of json.suites || []) walk(s, ms, null);
}

if (!ms.size) {
  console.error(`리포트 ${files}개를 읽었지만 항목이 없다 — 형식이 바뀌었는지 보세요.`);
  process.exit(1);
}

// 초 단위, 소수 한 자리. 밀리초까지 적으면 회차마다 파일이 통째로 바뀐다.
const out = {};
for (const k of [...ms.keys()].sort()) out[k] = Math.round(ms.get(k) / 100) / 10;
writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n');

const total = Object.values(out).reduce((a, b) => a + b, 0);
console.log(`${OUT} — 리포트 ${files}개에서 스펙 ${ms.size}개 · 합 ${total.toFixed(0)}s`);

#!/usr/bin/env node
/**
 * e2e 샤드를 **시간**으로 가른다 (M6 잔여 — 로드맵 §M6 DoD 의 마지막 관문).
 *
 * Playwright 의 `--shard` 는 **개수**로 가른다. 파일당 시간이 스무 배까지
 * 벌어지는 이 저장소에서 그것은 고르게 나누는 일이 아니다 — `git-*` 스펙이
 * 파일 이름 순 분할에서 특정 샤드에 몰렸고, 실측이 이랬다:
 *
 *     샤드  1     2     3     4     5     6     7     8
 *         4.3분 2.8분 5.4분 5.9분 5.0분 2.4분 3.2분 2.4분
 *
 * 합 31.4분을 여덟로 고르게 나누면 ~3.9분인데 벽시계는 가장 느린 5.9분에
 * 묶인다. **그리고 그 느린 샤드 안에서 흔들림이 난다** — 관측·폴링 상한이
 * 부하에 밀린다. 흔들림은 실패로 승격되므로(`CI_GATES_SRS §3`) 전량이 사실상
 * 초록이 되지 않았고, 그 상태에서는 전량을 신호로 쓸 수 없다.
 *
 * ## 목록을 손으로 적지 않는다
 *
 * 파일 목록은 `e2e/` 에서 **파생한다** (M6 "비싸게 배운 것" 2 · §3-2: 손으로
 * 적은 목록은 새 항목을 놓친다). 시간을 모르는 파일은 **가장 무거운 것으로**
 * 친다 — 모르는 것을 가볍다고 치면 새 파일이 이미 무거운 샤드에 조용히
 * 얹힌다. 비관적으로 치면 최악이라도 한 번 덜 고르게 나뉠 뿐이다.
 *
 * 시간표(`e2e/shard-timings.json`)는 **생성물**이다. 없거나 낡아도 동작한다 —
 * 없으면 전부 같은 무게가 되어 개수 분할로 물러선다.
 *
 * 사용:
 *   node scripts/e2e-shard.mjs --list 3/8    # 그 샤드가 돌 파일들
 *   node scripts/e2e-shard.mjs --plan        # 예상 균형을 표로
 */
import { readdirSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';

const DIR = 'e2e';
const TIMINGS = join(DIR, 'shard-timings.json');

if (process.argv.includes('-h') || process.argv.includes('--help')) {
  console.log(`e2e 샤드 분할 (시간 기준)

  --list N/M   샤드 N(1부터)이 돌 파일 목록을 한 줄에 하나씩
  --plan       예상 균형 · 시간을 모르는 파일 목록

  시간표: ${TIMINGS} (생성물 — \`make e2e-rebalance\`)
  없으면 전부 같은 무게로 치고 개수 분할로 물러선다.`);
  process.exit(0);
}

/** 파일 목록은 **디렉터리에서 파생한다.** 손으로 적으면 새 파일을 놓친다. */
const files = readdirSync(DIR).filter((f) => f.endsWith('.spec.ts')).sort();
if (!files.length) {
  console.error(`${DIR}/ 에 스펙이 없다 — 분할할 것이 없다.`);
  process.exit(1);
}

const timings = existsSync(TIMINGS) ? JSON.parse(readFileSync(TIMINGS, 'utf8')) : {};
// **기록된 0 은 모르는 것이 아니라 아는 것이다.** 전량 skip 되는 스펙
// (`sandbox-window`)이 그렇다 — 그것을 "모름" 으로 치면 가장 무거운 파일 하나가
// 통째로 유령처럼 한 통에 얹힌다.
const isKnown = (f) => typeof timings[f] === 'number' && timings[f] >= 0;
const known = files.filter(isKnown).map((f) => timings[f]);
// 정말 모르는 파일(새로 생긴 것)은 **가장 무거운 것으로** 친다. 가볍다고 치면
// 새 파일이 이미 무거운 샤드에 얹힌다 — 정확히 지금 고치려는 그 모양이 된다.
const unknownWeight = known.length ? Math.max(...known) : 1;
const weight = (f) => (isKnown(f) ? timings[f] : unknownWeight);

/**
 * LPT (longest processing time first) — 무거운 것부터 **그때까지 가장 가벼운
 * 통**에 넣는다. 최적은 아니지만 최적의 4/3 안이고, 무엇보다 **결정적이다**:
 * 같은 입력이 같은 분할을 낸다. 동률은 파일 이름이 가른다.
 */
function plan(n) {
  const bins = Array.from({ length: n }, () => ({ files: [], total: 0 }));
  const order = [...files].sort((a, b) => weight(b) - weight(a) || (a < b ? -1 : 1));
  for (const f of order) {
    let best = 0;
    for (let i = 1; i < n; i++) if (bins[i].total < bins[best].total) best = i;
    bins[best].files.push(f);
    bins[best].total += weight(f);
  }
  for (const b of bins) b.files.sort();
  return bins;
}

const listArg = process.argv[process.argv.indexOf('--list') + 1];
if (process.argv.includes('--list')) {
  const m = /^(\d+)\/(\d+)$/.exec(listArg || '');
  if (!m) {
    console.error('--list 는 N/M 꼴이다 (예: 3/8)');
    process.exit(1);
  }
  const [i, n] = [Number(m[1]), Number(m[2])];
  if (i < 1 || i > n) {
    console.error(`샤드 번호가 범위 밖이다: ${i}/${n}`);
    process.exit(1);
  }
  const bin = plan(n)[i - 1];
  // **빈 샤드를 내보내지 않는다.** 인자 없는 playwright 는 전량을 돈다 —
  // 빈 목록을 그대로 넘기면 그 샤드가 148개를 통째로 다시 돈다.
  if (!bin.files.length) {
    console.error(`샤드 ${i}/${n} 에 배정된 파일이 없다 — 샤드 수가 파일 수보다 많다.`);
    process.exit(1);
  }
  // **슬래시로 낸다.** `path.join` 은 windows 에서 `e2e\\x.spec.ts` 를 주는데
  // playwright 의 위치 인자는 경로 문자열로 거르므로 구분자가 다르면 걸리지
  // 않는다 — 그러면 그 샤드가 **아무것도 돌지 않고 초록**이 된다.
  console.log(bin.files.map((f) => DIR + '/' + f).join('\n'));
  process.exit(0);
}

// --plan
const n = Number(process.argv[process.argv.indexOf('--plan') + 1]) || 8;
const bins = plan(n);
const unknown = files.filter((f) => !isKnown(f));
const totals = bins.map((b) => b.total);
const sum = totals.reduce((a, b) => a + b, 0);

console.log(`스펙 ${files.length}개 · 시간을 아는 것 ${files.length - unknown.length}개 · 샤드 ${n}`);
console.log();
bins.forEach((b, i) => {
  const bar = '█'.repeat(Math.round((b.total / Math.max(...totals)) * 30));
  console.log(`  샤드 ${String(i + 1).padStart(2)}  ${b.total.toFixed(0).padStart(5)}s  ${String(b.files.length).padStart(3)}파일  ${bar}`);
});
console.log();
console.log(`  합 ${sum.toFixed(0)}s · 고르면 ${(sum / n).toFixed(0)}s · 실제 최대 ${Math.max(...totals).toFixed(0)}s`);
console.log(`  불균형(최대/평균) ${(Math.max(...totals) / (sum / n)).toFixed(2)}배`);
if (unknown.length) {
  console.log();
  console.log(`  시간을 모르는 ${unknown.length}개 (가장 무거운 ${unknownWeight.toFixed(0)}s 로 친다):`);
  for (const f of unknown.slice(0, 10)) console.log(`    ${f}`);
  if (unknown.length > 10) console.log(`    … 외 ${unknown.length - 10}개`);
  console.log(`  \`make e2e-rebalance\` 로 시간표를 새로 만든다.`);
}

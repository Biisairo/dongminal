#!/usr/bin/env node
//
// flaky 로 집계된 항목을 **격리해서 세 번 더** 돌려, 부하인지 결함인지 가른다
// (`E2E_FLAKY_ISOLATION_SRS` FR-EFI-4~13).
//
// 왜 이것이 필요한가: `retries: 1` 의 재시도는 **같은 프로세스 · 같은 워커 편성 ·
// 같은 서버 상태**에서 곧바로 돈다. 그래서 "부하에 밀려 진 것" 과 "가끔 지는
// 결함" 이 같은 모양으로 끝나고, 가릴 수 없으니 봐줄 수밖에 없었다
// (`CI_GATES_SRS §3.1` — *"재현할 길이 CI 왕복뿐이다"*).
//
// **이 스크립트가 그 문장을 거짓으로 만든다.** 회차 안에서 재현을 시도한다.
//
// 격리는 프로세스 분리로 저절로 온다: `webServer` 가 없고(D-3) 서버는 워커 스코프
// 픽스처가 띄우며 `E2E_HOME` 이 pid 를 품는다. 새 프로세스면 서버·홈이 새것이다.
// 남는 것은 포트뿐이라 그것만 옮긴다 (FR-EFI-6).
//
// 사용: node scripts/e2e-isolate-flaky.mjs <목록.json> [<목록.json> ...]

import { spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** 격리 회차 수. 셋이다 — 한 번은 표본이 너무 적다 (사용자 결정 2026-09-16). */
export const ISOLATION_ROUNDS = 3;

/**
 * 이 수를 넘으면 돌지 않는다 (FR-EFI-8).
 *
 * 그만큼 흔들린다는 것은 개별 격리로 가릴 일이 아니라 계통 문제이고, 9건 × 3회 =
 * 27번의 서버 기동은 게이트가 치를 값이 아니다. **실측이 아니라 판단이다** —
 * 세 회차 관측에서 샤드당 flaky 는 0~1 이었다.
 */
export const MAX_FLAKY = 8;

/** 독립 재실행이 쓰는 포트 대역. 본 실행(58147~58217)과 겹치지 않는다. */
const PORT_BASE = 59000;

/**
 * 판정 (FR-EFI-7).
 *
 * **한 번이라도 통과하면 부하다.** 잡히는 것은 *독립 실행에서 100% 재현되는
 * 항목* 뿐이고, 그래서 거짓 경보가 사실상 0 인 대신 **간헐 결함은 통과한다.**
 * 그 균형을 택한 것이다 (사용자 결정 2026-09-16).
 */
export function classify(attempts) {
  return attempts.some(Boolean) ? 'load' : 'defect';
}

/**
 * 재실행에 거는 인자 (FR-EFI-4 · V-EFI-4).
 *
 * **제목이 아니라 위치다.** 제목에는 `›`·괄호·중점·한글이 섞여 있어 셸을 지나며
 * 깨진다.
 */
export function specArg(item) {
  return `${item.file}:${item.line}`;
}

/**
 * 목록을 격리 재실행하고 부하/결함으로 가른다.
 *
 * `runner` 를 주입받는 이유는 판정을 **실제 playwright 없이** 잴 수 있어야 하기
 * 때문이다. 진짜로 돌리면 그 테스트가 몇 분씩 걸리고 그 자체로 흔들려서,
 * 흔들림을 가리려고 만든 장치가 흔들림으로 판정된다.
 */
export async function isolate(items, runner) {
  if (items.length > MAX_FLAKY) {
    return {
      skipped: true,
      reason: `flaky ${items.length}건 — 상한 ${MAX_FLAKY} 을 넘는다. 개별 격리로 가릴 일이 아니다.`,
      load: [],
      defect: [],
    };
  }
  const load = [];
  const defect = [];
  for (const it of items) {
    const attempts = [];
    for (let round = 1; round <= ISOLATION_ROUNDS; round++) {
      const ok = await runner(it, round);
      attempts.push(ok);
      // FR-EFI-5a: 통과한 시점에 판정은 `부하` 로 정해졌다. 더 도는 것은 답을
      // 바꾸지 못한 채 값만 쓴다.
      if (ok) break;
    }
    (classify(attempts) === 'load' ? load : defect).push(it);
  }
  return { skipped: false, reason: '', load, defect };
}

/**
 * 실제 실행기 — 항목 하나를 새 playwright 프로세스로 한 번 돈다.
 *
 * **`--reporter=line` 이 설정의 리포터를 대체하는 것은 의도다.** `parity-reporter`
 * 가 여기서 돌면 `parity-flaky.txt` 를 덮어써 잡 요약을 오염시킨다. 본 실행의
 * 판정과 이 실행의 판정은 서로 다른 것을 재고 있다 (FR-EFI-11).
 */
function playwrightRunner(item, round) {
  const port = PORT_BASE + round * 10;
  const r = spawnSync(
    'npx',
    ['playwright', 'test', specArg(item), '--workers=1', '--retries=0', '--reporter=line'],
    {
      stdio: 'inherit',
      env: { ...process.env, E2E_PORT_BASE: String(port), DM_E2E_KEEP_PEERS: '1' },
    },
  );
  return r.status === 0;
}

/** 목록 파일 여럿을 읽어 하나로 모은다. 없는 파일은 flaky 0 이다 (FR-EFI-3). */
function readLists(paths) {
  const out = [];
  for (const p of paths) {
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(p, 'utf8'));
    } catch (e) {
      // 없는 것은 **그 샤드가 흔들리지 않았다**는 뜻이다 (FR-EFI-3). 있는데 못 읽는
      // 것은 다른 일이므로 말은 하되 멈추지 않는다 — 목록 하나가 깨졌다고 게이트가
      // 죽으면 그것은 틀린 실패다.
      if (e.code !== 'ENOENT') console.log(`[격리] 목록을 읽지 못했다: ${p} — ${e.message}`);
      continue;
    }
    if (Array.isArray(parsed)) out.push(...parsed);
  }
  return out;
}

function summarize(lines) {
  console.log(lines.join('\n'));
  const f = process.env.GITHUB_STEP_SUMMARY;
  if (!f) return;
  try {
    appendFileSync(f, `${lines.join('\n')}\n`);
  } catch {
    /* 요약에 못 써도 판정은 위에 찍혔다 */
  }
}

async function main(argv) {
  const items = readLists(argv);
  if (!items.length) {
    console.log('[격리] flaky 0 — 돌 것이 없다.');
    return 0;
  }

  console.log(`[격리] flaky ${items.length}건을 단독 ${ISOLATION_ROUNDS}회씩 다시 돈다.`);
  const r = await isolate(items, playwrightRunner);

  if (r.skipped) {
    summarize(['### e2e 격리 재실행', '', `- **건너뜀** — ${r.reason}`]);
    return 0;
  }

  const lines = ['### e2e 격리 재실행', '', `- 부하 **${r.load.length}** · 결함 **${r.defect.length}**`];
  // FR-EFI-13: 부하도 이름을 남긴다. 회차를 건너 같은 이름이 쌓이면 그것이
  // `CI_GATES_SRS §3.1` 의 되뒤집을 조건을 사람이 판단할 재료다.
  for (const it of r.load) lines.push(`  - 부하: \`${specArg(it)}\` — ${it.title}`);
  // FR-EFI-12: 결함은 수만 적으면 아무도 열지 않는다.
  for (const it of r.defect) lines.push(`  - **결함**: \`${specArg(it)}\` — ${it.title}`);
  summarize(lines);

  if (!r.defect.length) return 0;
  console.log(
    `[격리] 결함 ${r.defect.length}건 — 단독 ${ISOLATION_ROUNDS}회를 모두 졌다. 부하가 아니다 ` +
      '(E2E_FLAKY_ISOLATION_SRS FR-EFI-7).',
  );
  return 1;
}

/**
 * 직접 실행됐는가 — 테스트는 이 모듈을 import 만 하므로 그때 돌면 안 된다.
 *
 * **`` `file://${process.argv[1]}` `` 로 쓰면 Windows 에서 영원히 거짓이다.**
 * 거기서 `argv[1]` 은 `D:\a\…\x.mjs` 이고 `import.meta.url` 은
 * `file:///D:/a/…/x.mjs` 다 — 구분자도 다르고 슬래시 수도 다르다. POSIX 에서는
 * 우연히 맞아떨어져서 **조용히 통과한다.**
 *
 * 실제로 그렇게 나갔고, Windows 러너 8잡이 **아무 출력 없이 exit 0** 했다.
 * flaky 가 난 샤드에서도 격리가 돌지 않았다 (2026-09-16, CI 가 잡았다).
 *
 * 경로를 URL 로 올리는 일은 `pathToFileURL` 에 맡긴다 — 그것이 호스트 규약을
 * 아는 유일한 자리다.
 */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}

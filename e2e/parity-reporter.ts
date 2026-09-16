import { mkdirSync, writeFileSync } from 'fs';
import { join, relative } from 'path';

import type { Reporter, TestCase, TestResult, FullResult, FullConfig } from '@playwright/test/reporter';

/**
 * OS 사이의 **동등성**을 결과에서 읽을 수 있게 한다 (CI_E2E_MATRIX_SRS FR-CEM-27).
 *
 * 접수한 물음은 이것이었다.
 *
 * > **"모든 os 의 e2e 가 같은 동작을 했을 때 같은 결과가 나오는 같은 테스트야?"**
 *
 * 항목을 OS 로 빼는 자리는 없다. 그런데 **조건부 건너뜀**은 있다 — 전제가 없으면
 * (도커가 없다, LSP 팩이 이미 다 서 있다, Editor 루트가 없다) 그 항목은 조용히
 * 건너뛴다. 그것 자체는 옳지만, **결과만 봐서는 어느 OS 에서 몇 개가 실제로
 * 돌았는지 알 수 없다** — "초록" 이 "다 돌았다" 를 뜻하지 않는다.
 *
 * 그래서 끝에 한 줄을 남긴다: 돈 것, 건너뛴 것, 그리고 **건너뛴 사유별 개수**.
 * 두 OS 의 그 줄을 나란히 놓으면 동등성이 눈에 보인다.
 *
 * 판정하지 않는다 — 세어서 말할 뿐이다. 무엇이 정상인지는 사람이 정한다.
 *
 * ── flaky (CI_GATES_SRS §3) ──
 *
 * `retries: 1` 이 한 번까지 봐주므로 흔들린 항목도 초록으로 끝난다. 그 수를
 * 아무도 세지 않던 동안 제품 결함 셋이 초록 뒤에 있었고, 사용자는 그것을
 * "가끔 안 된다" 로 만나고 있었다 (`playwright.config.ts:51-70`).
 *
 * 그래서 여기서 **센다.** 판정은 2026-09-16 에 다시 갈렸다 (`CI_GATES_SRS §3`).
 *
 *   M6 (2026-09-12): `flaky > 0` 이면 실행을 실패로 끝냈다
 *   지금 (2026-09-16): **세고 남기되 실패로 올리지 않는다**
 *
 * M6 의 근거는 *"흔들림 뒤에 제품 결함이 있다"* 였고 그때는 맞았다 — 매핑이
 * 계통 결함 여덟을 닫았다. 지금 남은 것은 성질이 다르다:
 *
 *   · 로컬 전량은 **두 회차 연속 flaky 0** 이다 (1679 통과, 2026-09-16)
 *   · CI 에서만, 매 회차 **다른 항목**이 뜬다 (git·부하 계열)
 *   · 그래서 **재현할 길이 CI 왕복뿐**이다 — 고쳤는지 확인하는 데 한 회차씩 든다
 *
 * 재현할 수 없는 것을 실패로 올리면 게이트가 *"무엇이 깨졌는가"* 를 말하지 못하고
 * 빨간 배지만 남는다. 그때 사람이 배우는 것은 **배지를 무시하는 습관**이다 —
 * M6 이 막으려던 바로 그 상태를 다른 길로 만든다.
 *
 * **부채는 지운 것이 아니라 자리를 옮긴 것이다.** 수·목록·트레이스는 그대로
 * 남고(`parity-flaky.txt`·잡 요약·아티팩트), `DM_E2E_STRICT_FLAKY=1` 이 M6 의
 * 판정을 되살린다 — 계통 결함을 의심할 때 그 자리에서 켠다.
 */
class ParityReporter implements Reporter {
  private skipped: TestCase[] = [];
  private ran = 0;
  private flaky: { file: string; line: number; title: string }[] = [];
  private rootDir = process.cwd();
  private outputDir = 'test-results';

  /**
   * 목록을 **어디에** 쓸지는 여기서만 알 수 있다 (FR-EFI-2).
   *
   * `outputDir` 은 이미 샤드별로 갈려 있다 (`--output=test-results/s$i`). 거기
   * 두면 로컬 8샤드 병렬에서도 서로 덮어쓰지 않는다 — `parity-flaky.txt` 는 cwd 에
   * 쓰는 탓에 실제로 여덟이 같은 파일을 쓴다. 그 실수를 되풀이하지 않는다.
   *
   * **`config.rootDir` 을 쓰지 않는다.** 그것은 리포 루트가 아니라 `testDir`
   * (`./e2e`) 이다 — 그것으로 상대 경로를 만들면 `e2e/` 가 빠져 `a.spec.ts:8` 이
   * 되고, 같은 이름의 파일이 다른 자리에 생기는 순간 어느 것인지 말할 수 없다.
   * 실측으로 걸렸다 (2026-09-16). 기준은 **cwd** 다 — CI 도 `e2e-shard-run.sh` 도
   * 리포 루트에서 playwright 를 부른다.
   */
  onBegin(config: FullConfig) {
    const dir = config.projects[0]?.outputDir;
    if (dir) this.outputDir = dir;
  }

  onTestEnd(test: TestCase, result: TestResult) {
    if (result.status === 'skipped') this.skipped.push(test);
    else this.ran++;
    // 재시도에서 통과한 항목이 flaky 다. `retry > 0` 이면서 결과가 기대와 같다.
    if (result.retry > 0 && result.status === test.expectedStatus) {
      // **위치를 함께 싣는다** (FR-EFI-1). 격리 재실행은 제목이 아니라 위치로
      // 건다 — 제목에는 `›`·괄호·중점·한글이 섞여 있어 셸을 지나며 깨진다.
      this.flaky.push({
        file: relative(this.rootDir, test.location.file),
        line: test.location.line,
        title: test.titlePath().slice(1).join(' › '),
      });
    }
  }

  /**
   * `onEnd` 가 `{status}` 를 돌려주면 playwright 가 그것을 최종 상태로 삼는다 —
   * 검사 결과를 고치지 않고 **실행의 판정만** 바꾸는 자리다. 지금은
   * `DM_E2E_STRICT_FLAKY=1` 일 때만 그 길로 간다 (위 주석의 2026-09-16 개정).
   */
  async onEnd(_result: FullResult) {
    // 사유는 `test.skip(cond, '사유')` 의 그 문자열이다. playwright 는 그것을
    // annotation 으로 싣는다.
    const byReason = new Map<string, number>();
    for (const t of this.skipped) {
      const a = t.annotations.find((x) => x.type === 'skip' && x.description);
      const why = (a && a.description) || '(사유 없음)';
      byReason.set(why, (byReason.get(why) || 0) + 1);
    }
    const lines = [
      '',
      `[parity] ${process.platform} — 돈 항목 ${this.ran} · 건너뛴 항목 ${this.skipped.length}`,
    ];
    for (const [why, n] of [...byReason].sort((a, b) => b[1] - a[1])) {
      lines.push(`[parity]   ${n}× ${why}`);
    }
    lines.push(`[parity] flaky ${this.flaky.length}`);
    for (const t of this.flaky) lines.push(`[parity]   flaky: ${t.title}`);
    // 잡 요약이 읽는 자리. 리포터의 표준 출력은 러너 로그에 묻힌다.
    try { writeFileSync('parity-flaky.txt', String(this.flaky.length)) } catch { /* 없어도 요약이 0 을 쓴다 */ }
    // 격리 재실행이 읽는 자리 (FR-EFI-1·3). **흔들리지 않았으면 만들지 않는다** —
    // 있는지 없는지가 곧 할 일이 있는지 없는지다.
    if (this.flaky.length) {
      try {
        // playwright 는 남길 산출물이 있을 때만 이 자리를 만든다. 흔들린 항목이
        // 트레이스를 남기지 않고 끝나는 경우가 있어 우리가 보장한다.
        mkdirSync(this.outputDir, { recursive: true });
        writeFileSync(join(this.outputDir, 'parity-flaky.json'), JSON.stringify(this.flaky, null, 2));
      } catch { /* 없으면 격리 재실행이 그 샤드를 flaky 0 으로 읽는다 */ }
    }
    // eslint-disable-next-line no-console
    console.log(lines.join('\n'));
    if (!this.flaky.length) return;
    if (process.env.DM_E2E_STRICT_FLAKY !== '1') {
      // 부채는 남긴다 — 수·목록은 위에서 이미 찍혔고 트레이스는 아티팩트에 있다.
      // eslint-disable-next-line no-console
      console.log(
        `[parity] flaky ${this.flaky.length}건 — 실패로 올리지 않는다 (CI_GATES_SRS §3, 2026-09-16).\n` +
        '[parity] 재시도 한 번에 통과한 것까지가 flaky 다. 수와 트레이스는 남는다.\n' +
        '[parity] 계통 결함을 의심하면 DM_E2E_STRICT_FLAKY=1 로 실패로 올린다.');
      return;
    }
    // eslint-disable-next-line no-console
    console.log(
      `[parity] flaky ${this.flaky.length}건 — DM_E2E_STRICT_FLAKY=1 이므로 실패로 올린다.\n` +
      '[parity] 재시도에서 통과한 것은 "가끔 안 되는 것" 이며 사용자는 그것을 그대로 만난다.');
    return { status: 'failed' as const };
  }
}

export default ParityReporter;

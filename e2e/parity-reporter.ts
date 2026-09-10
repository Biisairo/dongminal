import { writeFileSync } from 'fs';

import type { Reporter, TestCase, TestResult, FullResult } from '@playwright/test/reporter';

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
 * 그래서 여기서 **센다.** 판정하지 않는 규약은 그대로다 — 실패로 올리지 않고
 * 수를 드러낼 뿐이다. 승격은 계통 결함이 정리된 뒤(M6)의 일이다.
 */
class ParityReporter implements Reporter {
  private skipped: TestCase[] = [];
  private ran = 0;
  private flaky: string[] = [];

  onTestEnd(test: TestCase, result: TestResult) {
    if (result.status === 'skipped') this.skipped.push(test);
    else this.ran++;
    // 재시도에서 통과한 항목이 flaky 다. `retry > 0` 이면서 결과가 기대와 같다.
    if (result.retry > 0 && result.status === test.expectedStatus) {
      this.flaky.push(test.titlePath().slice(1).join(' › '));
    }
  }

  onEnd(_result: FullResult) {
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
    for (const t of this.flaky) lines.push(`[parity]   flaky: ${t}`);
    // 잡 요약이 읽는 자리. 리포터의 표준 출력은 러너 로그에 묻힌다.
    try { writeFileSync('parity-flaky.txt', String(this.flaky.length)) } catch { /* 없어도 요약이 0 을 쓴다 */ }
    // eslint-disable-next-line no-console
    console.log(lines.join('\n'));
  }
}

export default ParityReporter;

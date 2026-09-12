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
 * 그래서 여기서 **센다.** 그리고 M6 부터는 **판정한다** (`CI_GATES_SRS §3` 개정).
 *
 *   이전 동작: 수를 잡 요약에 드러내고 기준선(4)을 기록하는 데까지
 *   새  동작: `flaky > 0` 이면 실행을 **실패로 끝낸다**
 *   이유:     "올리지 않는다" 의 근거는 *"제품 쪽 계통 결함이 남아 있어 지금
 *             올리면 이후 모든 마일스톤의 CI 가 빨갛다"* 였다. M6 이 그 계통
 *             결함을 닫았으므로 근거가 사라졌다. 세기만 하는 게이트는 결국
 *             아무도 보지 않는다 — `11 §5` 가 매핑하기 전까지 flaky 아홉이
 *             1년 가까이 초록 뒤에 있었던 것이 그 증거다
 *
 * **`DM_E2E_ALLOW_FLAKY=1` 이 그 승격을 끈다.** 조사 중에 전량을 돌리는 사람이
 * 흔들림 하나로 실행 전체를 잃지 않게 하는 손잡이이며, CI 는 이것을 주지 않는다.
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

  /**
   * CI_GATES_SRS §3 (M6 개정): `flaky > 0` 은 실패다.
   *
   * `onEnd` 가 `{status}` 를 돌려주면 playwright 가 그것을 최종 상태로 삼는다 —
   * 검사 결과를 고치지 않고 **실행의 판정만** 바꾸는 자리다.
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
    for (const t of this.flaky) lines.push(`[parity]   flaky: ${t}`);
    // 잡 요약이 읽는 자리. 리포터의 표준 출력은 러너 로그에 묻힌다.
    try { writeFileSync('parity-flaky.txt', String(this.flaky.length)) } catch { /* 없어도 요약이 0 을 쓴다 */ }
    // eslint-disable-next-line no-console
    console.log(lines.join('\n'));
    if (!this.flaky.length) return;
    if (process.env.DM_E2E_ALLOW_FLAKY === '1') {
      // eslint-disable-next-line no-console
      console.log('[parity] DM_E2E_ALLOW_FLAKY=1 — 흔들림을 실패로 올리지 않는다');
      return;
    }
    // eslint-disable-next-line no-console
    console.log(
      `[parity] flaky ${this.flaky.length}건 — 실패로 올린다 (CI_GATES_SRS §3).\n` +
      '[parity] 재시도에서 통과한 것은 "가끔 안 되는 것" 이며 사용자는 그것을 그대로 만난다.\n' +
      '[parity] 조사 중이라면 DM_E2E_ALLOW_FLAKY=1 로 끌 수 있다.');
    return { status: 'failed' as const };
  }
}

export default ParityReporter;

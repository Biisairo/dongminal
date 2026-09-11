import { test, expect, waitForInit, waitShellReady } from './fixtures';

/**
 * 재접속은 이어 붙이는 것이지 다시 뿌리는 것이 아니다 (TERMINAL_RESUME_SRS).
 *
 * 접수한 증상은 **화면으로만** 판정된다 — "이전 글자가 보이고 글자가 중복으로
 * 출력된다". 그래서 이 파일은 합성 페이지를 쓰지 않는다. 실서버에 실제로 붙었다
 * 끊었다 하고, 터미널 버퍼에 같은 표지가 몇 번 있는지를 센다.
 *
 * 단위 검사는 따로 있다 (`web/js/test/term-resume.test.mjs` · Go `term_resume_test.go`).
 * 여기서 재는 것은 그 조각들이 **서로 맞물려 화면을 지키는가** 하나다.
 */

/** 활성 터미널의 스크롤백 전체를 글로 뽑는다. 화면 밖도 포함해야 중복이 보인다. */
const bufferText = (page: any) =>
  page.evaluate(() => {
    const app = (window as any).app;
    const pane = [...app.tools.values()].find((p: any) => p.el.classList.contains('vis')) as any;
    const b = pane.term.buffer.active;
    const out: string[] = [];
    for (let i = 0; i < b.length; i++) out.push(b.getLine(i)?.translateToString(true) ?? '');
    return out.join('\n');
  });

/** 서버가 통보한 좌표. -1 이면 아직 모른다. */
const seqOf = (page: any) =>
  page.evaluate(() => {
    const app = (window as any).app;
    const pane = [...app.tools.values()].find((p: any) => p.el.classList.contains('vis')) as any;
    return pane._seq;
  });

/** 소켓만 끊는다 — pane 은 그대로 두고 재연결을 태운다 (SOFT_RELOAD_SRS D-3 의 경로). */
const dropSocket = (page: any) =>
  page.evaluate(() => {
    const app = (window as any).app;
    const pane = [...app.tools.values()].find((p: any) => p.el.classList.contains('vis')) as any;
    pane.ws.close();
  });

/** 두 번 연속 같은 화면이 나올 때까지 기다린 뒤 그 화면을 준다. */
async function settled(page: any, tries = 40): Promise<string> {
  let last = '';
  for (let i = 0; i < tries; i++) {
    const now = await bufferText(page);
    if (i > 0 && now === last) return now;
    last = now;
    await page.waitForTimeout(150);
  }
  return last;
}

/** 이 뒤로 `OpOutput` 으로 받는 바이트를 센다. */
const countRx = (page: any) =>
  page.evaluate(() => {
    const app = (window as any).app;
    const pane = [...app.tools.values()].find((p: any) => p.el.classList.contains('vis')) as any;
    (window as any).__rx = 0;
    const orig = pane._handleOutput.bind(pane);
    pane._handleOutput = (d: any) => { (window as any).__rx += d.length; orig(d) };
  });

/** 새 소켓이 붙을 때까지 기다린다. */
const waitReconnected = (page: any) =>
  expect
    .poll(async () => page.evaluate(() => {
      const app = (window as any).app;
      const pane = [...app.tools.values()].find((p: any) => p.el.classList.contains('vis')) as any;
      return pane.ws && pane.ws.readyState === 1;
    }), { timeout: 15000 })
    .toBe(true);

test.describe('터미널 재접속 (TERMINAL_RESUME_SRS)', () => {
  /**
   * V-TRS-16 — **재접속이 바이트를 다시 보내지 않는다.**
   *
   * 접수한 증상은 화면의 중복이지만, e2e 가 잴 것은 화면이 아니라 **수신량**이다.
   * 이유를 실측으로 적어 둔다 (2026-09-12):
   *
   *   옛 코드로 셸 하나를 띄우고 평문 열 줄을 낸 뒤 소켓을 끊었다 붙였더니
   *   **892 바이트가 다시 왔는데 화면은 그대로였다** — 되뿌린 것에 섞인 커서
   *   이동이 같은 자리를 덮었기 때문이다.
   *
   * 즉 평범한 셸로는 증상이 재현되지 않는다. 증상은 claude 같은 TUI 의 1 MiB
   * 스크롤백 — 대체 화면 전환과 스크롤 영역이 섞인 것 — 에서 나온다 (SRS §2.6).
   * 그것을 e2e 에 세우는 것은 무겁고 흔들린다.
   *
   * **다시 받지 않으면 겹쳐 그릴 수도 없다.** 그 상위 성질을 재면 증상의 크기와
   * 무관하게 결정적이다. 화면이 그대로인지도 함께 본다 — 싸고, 델타 재개가
   * 엉뚱한 자리에 붙는 회귀를 잡는다.
   */
  test('V-TRS-16 재접속이 이미 본 바이트를 다시 보내지 않는다', async ({ page }) => {
    await waitForInit(page);
    await waitShellReady(page);

    await page.click('#area .pn.focused .xterm-screen');
    await page.keyboard.type('for i in 1 2 3 4 5 6 7 8 9 10; do echo trs_line_$i; done');
    await page.keyboard.press('Enter');
    await expect(page.locator('#area .pn.focused .xterm-rows')).toContainText('trs_line_10', {
      timeout: 15000,
    });
    // 셸이 더 낼 것이 없을 때까지 기다린다. 출력이 흐르는 중에 재면 아래의
    // "다시 받은 것" 에 **새 출력**이 섞인다 (실측: 기준선이 1 과 2 를 오갔다).
    const before = await settled(page);
    await countRx(page);

    for (let i = 0; i < 3; i++) {
      await dropSocket(page);
      await waitReconnected(page);
    }
    await page.waitForTimeout(800);

    // 사이에 새 출력이 없었다. 그러므로 받은 바이트는 **0 이어야 한다.**
    // 옛 코드에서는 재접속 한 번에 892 바이트였다.
    expect(await page.evaluate(() => (window as any).__rx)).toBe(0);
    expect(await bufferText(page)).toBe(before);
    // 그리고 그것이 **이어 붙였기 때문**임을 확인한다 (FR-TRS-6).
    expect(await seqOf(page)).toBeGreaterThan(0);
  });

  // V-TRS-17: 넛지는 전량 재생 뒤에만 나간다. 델타 재개는 좌표를 들고 붙으므로
  // 이어 붙고, 그때 크기를 흔들면 리플로우만 생긴다 (FR-TRS-18).
  test('V-TRS-17 델타 재개는 크기를 흔들지 않는다', async ({ page }) => {
    await waitForInit(page);
    await waitShellReady(page);

    // 보낸 리사이즈 프레임을 센다.
    await page.evaluate(() => {
      const app = (window as any).app;
      const pane = [...app.tools.values()].find((p: any) => p.el.classList.contains('vis')) as any;
      (window as any).__resizes = 0;
      const orig = pane._sendResize.bind(pane);
      pane._sendResize = (c: number, r: number) => { (window as any).__resizes++; orig(c, r) };
    });

    await dropSocket(page);
    await waitReconnected(page);
    // 재개 직후의 넛지는 한 tick 뒤에 온다. 그것까지 지나고 센다.
    await page.waitForTimeout(500);

    // `_onWsOpen` 의 크기 보고 한 번은 정상이다 (넛지가 아니다). 넛지는 두 번을
    // 더하므로, 셋 이상이면 델타 재개에 넛지가 걸린 것이다.
    const resizes = await page.evaluate(() => (window as any).__resizes);
    expect(resizes).toBeLessThan(3);
  });
});

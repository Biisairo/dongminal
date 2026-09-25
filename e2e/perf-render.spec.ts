import { Page } from '@playwright/test';

import { test, expect, waitForInit } from './fixtures';

/**
 * PERFORMANCE_HARDENING_SRS 묶음 P-A — **한 동작이 `render()` 를 한 번만 부른다**
 * (FR-PRF-15~17 · D-PRF-11 · `refactor/README.md` §4.1 항목 3).
 *
 * ## 왜 합치기가 아니라 이 검사인가
 *
 * 감사는 *"`render()` 호출 지점 **57곳**, 무엇이 바뀌었든 9개 하위 렌더를 전부
 * 지난다"* 라 적고 **rAF 합치기**를 처방했다. 재 보니 합칠 것이 없었다 (SRS §2.3a):
 *
 *   탭 열기 ×3        호출 3   (동작당 1)   총 4.5ms · 최대 1.9ms
 *   칸 추가·제거      호출 2   (동작당 1)   총 6.1ms · 최대 3.8ms
 *   창 전환 ×6        호출 6   (동작당 1)   총 5.8ms · 최대 1.8ms
 *   유휴 10초(폴링)   호출 0                총 0.0ms
 *   부팅 + 3초        호출 1                총 0.8ms
 *
 * **호출 지점이 57이라는 것과 회차당 57번 부른다는 것은 다르다.** 합치기는 같은
 * 프레임의 **중복** 호출을 줄이는 장치인데 중복이 없었고, 그러면서 "다음 프레임에
 * 그린다" 로 계약을 바꾼다 — 얻는 것 없이 e2e 1,745건의 전제를 흔든다 (D-PRF-11).
 *
 * 그래서 고치는 대신 **잰 것을 잠근다.** 중복 호출이 생기면 여기서 빨개진다.
 * 이것이 이 항목의 산출이다 — 벽시계가 아니라 **셀 수 있는 수**다 (FR-PRF-3).
 */

/** `render()` 진입을 센다. 반환값은 `fn` 이 도는 동안의 진입 수다. */
async function renderEntries(page: Page, fn: () => Promise<void>) {
  await page.evaluate(() => {
    const w = window as any, r = w.app.renderer;
    if (!w.__dmRenderPatched) {
      w.__dmRenderPatched = true;
      const orig = r.render.bind(r);
      w.__dmRender = 0;
      r.render = (...a: any[]) => { w.__dmRender++; return orig(...a) };
    }
    w.__dmRender = 0;
  });
  await fn();
  return page.evaluate(() => (window as any).__dmRender as number);
}

/**
 * 동작 **하나가 부른** `render()` 수다 — 세기 시작·동작·읽기를 한 번의 왕복 안에서 한다.
 *
 *   이전 동작: `renderEntries` 로 셌다 — 세 번의 왕복 사이에 도착한 남의 비동기 render
 *             (칸을 없앤 뒤 남은 칸의 `cwd` 응답)까지 세어졌다
 *   새 동작: 동작이 돌려준 Promise 까지만 기다린다. 그 await 사슬의 render(터미널 탭의
 *           도구 생성 뒤)는 세고, 동작이 끝난 뒤 온 응답의 render 는 세지 않는다
 *   이유: windows CI 에서 `칸 제거` 가 3 으로 떨어졌다 — 세는 창에 cwd 응답 둘이
 *         들어왔다(trace 실측). 이 검사가 잠그는 것은 한 동작의 중복 호출이다
 */
async function actionRenders(page: Page, action: 'tab' | 'slotAdd' | 'slotRemove') {
  await renderEntries(page, async () => {});
  return page.evaluate(async (act) => {
    const w = window as any, a = w.app;
    w.__dmRender = 0;
    if (act === 'tab') await a.addTab(a.focused, 'terminal');
    else if (act === 'slotAdd') a.slotAdd();
    else a.slotRemove(1);
    return w.__dmRender as number;
  }, action);
}

test.describe('묶음 P-A — 한 동작이 render() 를 한 번만 부른다', () => {
  test('R1 (FR-PRF-17 · TC-PRF-5): 탭 열기 · 칸 추가 · 창 전환이 각각 한 번씩만 그린다', async ({ page }) => {
    await waitForInit(page);

    expect(await actionRenders(page, 'tab'), '탭 열기').toBe(1);
    expect(await actionRenders(page, 'slotAdd'), '칸 추가').toBe(1);
    expect(await actionRenders(page, 'slotRemove'), '칸 제거').toBe(1);
  });

  test('R2 (FR-PRF-17 · TC-PRF-5): 폴링은 그리지 않는다', async ({ page }) => {
    await waitForInit(page);
    /**
     * **고정 대기의 예외 (`TEST-16`).** 재려는 것이 "일어나지 않음" 이다 —
     * 폴링 회차가 `render()` 를 부르지 않는다는 사실에는 기다릴 신호가 없다.
     * 상태바 통계는 3초 주기이므로 5초면 여러 회차가 지난다.
     */
    const idle = await renderEntries(page, async () => { await page.waitForTimeout(5000) });
    expect(idle, '유휴 5초').toBe(0);
  });

  test('R3 (FR-PRF-16 · TC-PRF-6): 그리기는 동기다 — 부른 자리에서 DOM 이 이미 서 있다', async ({ page }) => {
    await waitForInit(page);
    /**
     * D-PRF-11 이 합치기를 기각한 근거의 **다른 쪽 면**이다. 이 계약이 있으므로
     * 호출부 57자리가 그리기 직후를 단정할 수 있다. 합치기를 다시 들이려는
     * 사람은 이 검사를 먼저 마주친다.
     */
    const sync = await page.evaluate(() => {
      const a = (window as any).app;
      a.slotAdd();
      // 같은 태스크 안이다 — 합쳐서 미루면 여기서 DOM 이 아직 하나다.
      const dom = document.querySelectorAll('#area .slot').length;
      const n = a.slotCount();
      a.slotRemove(1);
      return { dom, n };
    });
    expect(sync.n).toBe(2);
    expect(sync.dom).toBe(sync.n);
  });
});

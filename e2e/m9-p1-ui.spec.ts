import { Page } from '@playwright/test';

import { test, expect, waitSettled, waitForInit } from './fixtures';

/**
 * M9 P1 의 화면 요구 넷 (M9_SRS §3.1).
 *
 *   V-M9-5  diff 의 본문이 편집기 안 개요 눈금 아래로 들어가지 않는다 (FR-M9-5)
 *   V-M9-7  모바일 탭의 닫기 표식이 탭의 세로 가운데에 선다 (FR-M9-7)
 *   V-M9-8  모바일 키바가 가려진 키가 있다는 것을 보인다 (FR-M9-8)
 *   V-M9-9  찾기 일치가 개요 눈금과 미니맵에 찍힌다 (FR-M9-9)  → `editor-find-panel.spec.ts`
 *   V-M9-5  diff 의 본문과 눈금                                  → `git-diff.spec.ts`
 *   V-M9-4  닫기 명령이 답을 미리 받는다 (FR-M9-4)               → 아래
 *
 * 두 검증(V-M9-5·9)은 그 기능의 스펙 파일로 갔다 — 같은 픽스처와 헬퍼가 거기 있다.
 * 여기 남은 것은 그런 자리가 없는 둘(모바일)과, 브라우저 쪽 닫기 계약이다.
 */

const MOBILE_VIEWPORT = { width: 390, height: 844 };

async function gotoMobile(page: Page) {
  await page.context().addInitScript(() => {
    sessionStorage.setItem('displayMode', 'mobile');
  });
  await page.setViewportSize(MOBILE_VIEWPORT);
  await page.goto('/');
  await page.waitForSelector('body.mobile', { timeout: 10000 });
  await waitSettled(page);
}

test.describe('FR-M9-7·8: 모바일 탭과 키바', () => {
  /**
   * FR-M9-7. 폭이 아니라 **세로 중심**을 잰다 — 폭 18 은 E-4 의 면제이고 이 요구의
   * 대상이 아니다. 종전 실측은 탭 중심 68 · 아이콘 중심 52.5 (15.5px 위) 였다.
   */
  test('TC-M9-7: 탭 닫기 표식이 탭의 세로 가운데에 선다', async ({ page }) => {
    await gotoMobile(page);

    const tab = page.locator('.pn-tab').first();
    await expect(tab).toBeVisible();

    // **아이콘을 잰다.** 상자(`.pn-tab-x`)는 세로 44 를 받아 탭 안에서 이미 가운데에
    // 서므로, 그것을 재면 결함이 있어도 늘 통과한다 — 어긋나는 것은 상자 **안의**
    // 아이콘이다. (이 테스트의 첫 판은 `querySelector('.pn-tab-x svg, .pn-tab-x')`
    // 로 잤고, 쉼표 선택자는 문서 순서상 상자를 먼저 돌려줘 결함 위에서도 초록이었다.)
    const got = await page.evaluate(() => {
      const t = document.querySelector('.pn-tab');
      const box = t && t.querySelector('.pn-tab-x');
      const icon = box && (box.querySelector('svg') || box);
      if (!t || !icon) return null;
      const a = t.getBoundingClientRect();
      const b = icon.getBoundingClientRect();
      return { tabCy: a.y + a.height / 2, iconCy: b.y + b.height / 2, iconIsBox: icon === box };
    });
    expect(got, '탭 또는 닫기 표식을 찾지 못했다').not.toBeNull();
    expect(got!.iconIsBox, '아이콘이 없어 상자를 쟀다 — 이 검사는 그때 아무것도 말하지 않는다').toBe(false);
    expect(Math.abs(got!.tabCy - got!.iconCy)).toBeLessThanOrEqual(2);
  });

  /**
   * FR-M9-8 / D-M9-7. 키바는 **가로 스크롤 스트립 그대로**이고(E-3), 더해진 것은
   * "여기서 끝이 아니다" 라는 말뿐이다. 그래서 넘침이 있다는 것부터 확인한다 —
   * 없으면 이 요구 자체가 성립하지 않는다.
   */
  test('TC-M9-8: 키바가 가려진 키를 말한다', async ({ page }) => {
    await gotoMobile(page);

    const bar = page.locator('#mobile-keybar');
    await expect(bar).toBeVisible();

    const overflows = await bar.evaluate((el) => el.scrollWidth > el.clientWidth + 1);
    expect(overflows, '390px 에서 키바가 넘치지 않는다 — 이 요구의 전제가 깨졌다').toBe(true);

    // 왼쪽 끝: 오른쪽만 가려져 있다.
    await expect.poll(() => bar.evaluate((el) => (el as HTMLElement).dataset.overflow)).toBe('right');

    // 가운데: 양쪽이 가려져 있다.
    await bar.evaluate((el) => { el.scrollLeft = Math.floor((el.scrollWidth - el.clientWidth) / 2) });
    await expect.poll(() => bar.evaluate((el) => (el as HTMLElement).dataset.overflow)).toBe('both');

    // 오른쪽 끝: 왼쪽만 가려져 있다.
    await bar.evaluate((el) => { el.scrollLeft = el.scrollWidth });
    await expect.poll(() => bar.evaluate((el) => (el as HTMLElement).dataset.overflow)).toBe('left');

    // 표식은 키를 먹지 않는다 — 스크롤 스트립 위에서 그것은 곧 닿지 않는 키다.
    const eats = await bar.evaluate((el) => {
      const cs = [getComputedStyle(el, '::before'), getComputedStyle(el, '::after')];
      return cs.some((c) => c.pointerEvents !== 'none');
    });
    expect(eats, '가려짐 표식이 포인터를 먹는다').toBe(false);
  });
});

/**
 * M9_SRS FR-M9-4 / V-M9-4 (브라우저 절반) — **닫기 명령이 답을 미리 받는다.**
 *
 * `dmctl` 쪽 절반은 Go 단위 검사가 잰다(`dmctl_close_test.go`) — 플래그가 어떤
 * 인자로 실리는가. 여기서 재는 것은 그 인자를 **받은 브라우저가 무엇을 하는가**다.
 * 둘을 한쪽에서만 재면 경계의 한쪽 사실만 초록이 된다 (M8 §2-35 의 교훈).
 */
test.describe('FR-M9-4: 원격 닫기의 답', () => {
  test('TC-M9-4a: keepTool 은 탭만 지우고 도구를 배경으로 보낸다', async ({ page }) => {
    await waitForInit(page);
    const got = await page.evaluate(async () => {
      const a = (window as any).app;
      await a.addTab();
      const tabs = a.testing.aw().layout.tabs;
      const victim = tabs[0];
      a.testing.execRemote('closeTab', { location: victim.id, keepTool: true, force: true });
      await new Promise((r) => setTimeout(r, 1200));
      return {
        victimTab: victim.id,
        victimTool: victim.toolId,
        left: (a.testing.aw().layout.tabs || []).map((t: any) => t.id),
        bg: (a.testing.bg || []).map((b: any) => b.toolId),
      };
    });
    expect(got.left, '탭이 닫히지 않았다').not.toContain(got.victimTab);
    expect(got.bg, '도구가 배경으로 가지 않았다 — keepTool 이 닿지 않는다').toContain(got.victimTool);
  });

  /**
   * **프로세스가 도는 창**이어야 이 요구가 무엇인지 잰다 — 한가한 창은 `force`
   * 없이도 확인 없이 닫히므로(FR-WCU-1 의 Undo 경로) 아무것도 가리지 못한다.
   *
   * busy 판정을 라우트로 바꿔친다 — 실제 프로세스를 띄우는 것보다 결정적이다
   * (`window-close-undo.spec.ts` TC-WCU-7 과 같은 규약).
   */
  test('TC-M9-4b: force 를 받은 closeWindow 는 프로세스가 돌아도 묻지 않는다', async ({ page }) => {
    await waitForInit(page);
    await page.route('**/api/tools/*/busy', (r) => r.fulfill({ json: { busy: true } }));

    const got = await page.evaluate(async () => {
      const a = (window as any).app;
      await a.addWindow();
      const wins = a.testing.plainWindows();
      const victim = wins[wins.length - 1];
      const anchor = victim.layout.tabs[0].id;
      a.testing.execRemote('closeWindow', { location: anchor, force: true });
      await new Promise((r) => setTimeout(r, 1500));
      return { victim: victim.id, left: a.testing.plainWindows().map((w: any) => w.id) };
    });
    // **예외 (`TEST-16`)**: 뜨지 않음을 재는 자리다 — 위 1.5초가 그 관측 창이다.
    await expect(page.locator('.confirm-overlay')).toHaveCount(0);
    expect(got.left, '지목한 창이 닫히지 않았다').not.toContain(got.victim);
  });
});

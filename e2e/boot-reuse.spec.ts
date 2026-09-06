import { test, expect, waitForInit } from './fixtures';

/**
 * BOOT_SCREEN_REUSE_SRS 검증 (V-BTR-1 ~ V-BTR-5).
 *
 * 첫 부팅의 로딩 화면은 `boot-screen.spec.ts` 가 본다. 여기서 보는 것은 **그
 * 화면이 걷힌 뒤 다시 서는가** 다 — 화면을 처음부터 다시 세우는 동작 셋이
 * 그것을 필요로 한다 (D-BTR-2).
 */

// web/js/core/constants.js 의 값 (BOOT_FADE_MS · BOOT_MAX_MS).
const FADE_MS = 180;
const MAX_MS = 6000;

const boot = (page: any) => page.locator('#boot');

// `boot-screen.js` 의 최상위 `const` 는 스크립트의 전역 렉시컬 바인딩이다 —
// 이름으로는 보이지만 `window` 의 속성이 아니다. 다른 스펙이 전역 상수를 쓰는
// 방식과 같이 선언만 둔다.
declare const BootScreen: any;

test.describe('Boot screen reuse', () => {
  test('V-BTR-1: 내부 새로고침이 로딩 화면을 다시 세우고 끝나면 걷는다', async ({ page }) => {
    await waitForInit(page);
    await expect(boot(page)).toHaveCount(0);

    // 정상 복원은 수백 ms 다 — 그 사이를 재려면 한 걸음을 늦춘다. 늦추는 대상은
    // `_onWorkspaceChanged` 가 타는 `/api/state` 이며, 나머지 갈래는 정상 진행한다.
    await page.route('**/api/state', async (route: any) => {
      await new Promise((r) => setTimeout(r, 1200));
      return route.fallback();
    });
    await page.click('#soft-reload-btn');

    await expect(boot(page)).toBeVisible();
    await expect(page.locator('#boot-step')).toHaveText('화면을 다시 세웁니다');
    // FR-BTR-9: 버튼 표시는 그대로 남는다 — 오버레이가 그것을 대신하지 않는다.
    await expect(page.locator('#soft-reload-btn')).toHaveClass(/busy/);

    await expect(boot(page)).toHaveCount(0, { timeout: 20_000 });
    await expect(page.locator('#soft-reload-btn')).not.toHaveClass(/busy/);
    await page.unroute('**/api/state');
  });

  test('V-BTR-2: 서 있는 동안 다시 세워도 화면은 하나다', async ({ page }) => {
    await waitForInit(page);
    await page.evaluate(() => {
      BootScreen.show('첫째');
      BootScreen.show('둘째');
    });
    await expect(boot(page)).toHaveCount(1);
    await expect(page.locator('#boot-step')).toHaveText('둘째');
    await page.evaluate(() => BootScreen.done());
    await expect(boot(page)).toHaveCount(0);
  });

  test('V-BTR-3: 걷히는 도중 다시 세우면 그 제거가 새 화면을 떼지 않는다', async ({ page }) => {
    await waitForInit(page);
    await page.evaluate(() => {
      const b = BootScreen;
      b.show('가는 중');
      b.done();
      b.show('다시');
    });
    // 페이드 뒤의 `remove()` 가 도착하고도 남는 시간을 기다린다 (FR-BTR-5).
    await page.waitForTimeout(FADE_MS + 220);
    await expect(boot(page)).toHaveCount(1);
    await expect(boot(page)).toBeVisible();

    await page.evaluate(() => BootScreen.done());
    await expect(boot(page)).toHaveCount(0);
  });

  test('V-BTR-4: 다시 세운 화면에도 상한이 걸린다', async ({ page }) => {
    await waitForInit(page);
    await page.evaluate(() => BootScreen.show('상한'));
    await expect(boot(page)).toBeVisible();
    // FR-BTR-3: 아무도 걷지 않아도 상한에서 걷힌다.
    await expect(boot(page)).toHaveCount(0, { timeout: MAX_MS + 4000 });
  });

  test('V-BTR-5: 새 버전 자동 새로고침은 문서를 다시 열기 전에 화면을 세운다', async ({ page }) => {
    await waitForInit(page);
    // 문서가 다시 열리므로 관측은 새로고침을 건너는 자리에 남긴다.
    await page.evaluate(() => {
      const b = BootScreen;
      const orig = b.show.bind(b);
      b.show = (t: string) => {
        try { sessionStorage.setItem('e2eBootShown', t || '') } catch { /* 사생활 모드 */ }
        return orig(t);
      };
      (window as any).__dmAssetVersion('deadbeef');
    });
    await waitForInit(page);
    const shown = await page.evaluate(() => sessionStorage.getItem('e2eBootShown'));
    expect(shown).toBe('새 버전을 받았습니다 — 다시 엽니다');
    // 되풀이 방지 기록과 관측 자리를 치운다 — 다음 스펙이 이 탭을 이어 쓴다.
    await page.evaluate(() => {
      try { sessionStorage.removeItem('e2eBootShown'); sessionStorage.removeItem('verReloadTried') } catch { /* 사생활 모드 */ }
    });
  });
});


import { test, expect, waitForInit } from './fixtures';

// 페이지 전역 (web/js/core/helpers.js).
declare const SHORTCUT_DEFAULTS: Record<string, string>;

// PANEL_SHORTCUTS_SRS — 상단 툴바의 `Background`·`Runs` 를 키로 연다.
//
// 재는 것은 "버튼과 같은 자리로 가는가" 다. 여는 함수는 이미 있었고, 버튼만이
// 그것을 부르는 유일한 자리였다 (§2.1).

test.describe('진입점 단축키', () => {
  // V-PSC-1: 기본값이 이미 쓰는 키와 겹치면 둘 중 하나가 조용히 죽는다.
  test('기본 키가 서로 겹치지 않는다', async ({ page }) => {
    await waitForInit(page);
    const got = await page.evaluate(() => {
      // `const` 선언이라 window 의 속성이 아니다 — 전역 어휘 환경에서 이름으로 닿는다.
      const d = SHORTCUT_DEFAULTS as Record<string, string>;
      const byKey: Record<string, string[]> = {};
      for (const [action, key] of Object.entries(d)) (byKey[key] ||= []).push(action);
      return {
        dupes: Object.entries(byKey).filter(([, a]) => a.length > 1),
        bg: d.bgToggle,
        runs: d.runsToggle,
      };
    });
    expect(got.dupes, `같은 키에 두 동작이 걸렸다: ${JSON.stringify(got.dupes)}`).toEqual([]);
    expect(got.bg).toBe('Ctrl+Shift+KeyB');
    expect(got.runs).toBe('Ctrl+Shift+KeyO');
  });

  // V-PSC-2 · FR-PSC-4
  test('Ctrl+Shift+B 가 백그라운드 모달을 열고 닫는다', async ({ page }) => {
    await waitForInit(page);
    await page.keyboard.press('Control+Shift+KeyB');
    await expect(page.locator('#bg-modal')).toBeVisible();
    await page.keyboard.press('Control+Shift+KeyB');
    await expect(page.locator('#bg-modal')).toHaveCount(0);
  });

  // V-PSC-3 · FR-PSC-4
  test('Ctrl+Shift+O 가 Run 모달을 열고 닫는다', async ({ page }) => {
    await waitForInit(page);
    await page.keyboard.press('Control+Shift+KeyO');
    await expect(page.locator('#runs-modal')).toBeVisible();
    await page.keyboard.press('Control+Shift+KeyO');
    await expect(page.locator('#runs-modal')).toHaveCount(0);
  });

  // V-PSC-4: 설정 목록은 두 표에서 자동으로 그려진다 — 배선이 빠지면 여기서 드러난다.
  test('설정 ▸ Shortcuts 에 두 항목이 이름과 함께 뜬다', async ({ page }) => {
    await waitForInit(page);
    await page.click('#settings-btn');
    await page.click('button.mtab[data-tab="shortcuts"]');
    const list = page.locator('#sc-list');
    await expect(list).toContainText('백그라운드 도구');
    await expect(list).toContainText('Run 오케스트레이션');
  });
});

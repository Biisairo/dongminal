import { join } from 'path';

import { test, expect, waitForInit, GIT_VIEW_TABS, gitFixture, cleanGitFixture } from './fixtures';
import { tmpPath, realPath } from './osenv';

// V-FLW-9 (FR-FLW-12) — 상태바의 **브랜치 chip 은 없다.**
//
// FR-GIT-57~59 는 철회됐다 (GIT_FOLLOW_REMOVAL_SRS D-FLW-7). 활성 리포는 사용자가
// 고른 것이고 터미널을 따라가지 않으므로, 하단바에 상주하는 브랜치 표시는 "지금
// 있는 곳" 으로 오해되기만 했다.
//
// 이 파일은 그 회귀 가드다 — 상태바에 리포 표시를 다시 얹는 변경이 오면 여기서
// 깨진다. **진행 중 원격 작업 표시(FR-GIT-112)도 철회됐다**(U-19 ①, 사용자 판정
// 2026-09-11) — 상태바에는 이제 git 표면이 하나도 없다. 작업 목록 폴링은 남으며
// (FR-GIT-101a) git-remote.spec.ts 의 R16 이 그 자리를 지킨다.

const FIXTURES = tmpPath('dm-git-fx-sb-' + process.pid);

test.beforeAll(() => {
  gitFixture(FIXTURES);
});
test.afterAll(() => {
  cleanGitFixture(FIXTURES);
});

const fx = (name: string) => realPath(join(FIXTURES, name));

test.describe('묶음 G — 상태바 (브랜치 chip 철회)', () => {
  test('B1 (V-FLW-9): 리포를 열어도 상태바에 브랜치 chip 이 없다', async ({ page }) => {
    await waitForInit(page);
    // FR-RTU-72: 창을 연다. **뷰 탭은 열지 않는다** — 그것은 Changes 사이드의
    // 아이콘 줄이 하는 일이고(FR-RTU-21), 이 시험은 상태바만 본다. 관측이 돌게
    // 하려면 그 표면이 화면에 있어야 하므로(D-RTU-25) 사이드를 Changes 로 돌린다.
    await page.evaluate((r) => (window as any).app.openGitWindow(r), fx('basic'));
    await page.waitForSelector('#area .ed-win .ed-side', { timeout: 15000 });
    await page.evaluate(() => {
      const a = (window as any).app;
      a._edSetSide(a._aw(), 'changes');
    });
    await expect(page.locator('#area .ed-side .git-view.git-changes')).toBeVisible({ timeout: 10000 });
    // 관측이 도착할 시간을 준 뒤에 본다 — 도착 전에 세면 아무것도 없는 것이 당연하다.
    await expect
      .poll(() => page.evaluate(() => !!(window as any).app.gitPanel.statusOf()), { timeout: 20000 })
      .toBe(true);
    await page.evaluate(() => (window as any).app._updateStatusBar());

    await expect(page.locator('#sb-items .sb-git')).toHaveCount(0);
    const text = (await page.locator('#sb-items').textContent()) || '';
    expect(text, `상태바에 브랜치가 보인다: ${text}`).not.toContain('main');
  });

  /**
   * B2 (V-FLW-9 개정 / FR-FLW-12 · FR-GIT-112 **철회**): 그 설정 항목은 **없다.**
   *
   * 6차 세션은 라벨을 고쳐 그것이 순간 표시임을 말하게 했다. 7차에 사용자가
   * 판정했다 — *"그냥 해당 옵션 제거."* 몇 초 동안만 뜨는 것을 켜고 끄는 스위치는
   * 켜 두어도 늘 안 보이므로 설정으로서 뜻이 없다.
   *
   * 작업 목록 폴링 자체는 남는다 (`FR-GIT-101a`) — `git-remote.spec.ts` 의 R16 이
   * 그 자리를 지킨다.
   */
  test('B2 (V-FLW-9 개정): 상태바 설정에 Git 항목이 없다', async ({ page }) => {
    await waitForInit(page);
    await page.click('#settings-btn');
    await page.click('button.mtab[data-tab="statusbar"]');
    await expect(page.locator('#panel-statusbar .sbs-row').first()).toBeVisible();
    await expect(page.locator('#panel-statusbar .sbs-row[data-item="git"]')).toHaveCount(0);
    const text = (await page.locator('#panel-statusbar').textContent()) || '';
    expect(text, `설정에 Git 항목이 남아 있다: ${text}`).not.toContain('Git 원격 작업');
    await page.click('#modal-close');
  });

  // 상태바 본체에도 그 자리가 없다 — chip 을 다시 얹는 변경이 오면 여기서 깨진다.
  test('B3 (FR-GIT-112 철회): 상태바에 원격 작업 chip 의 자리가 없다', async ({ page }) => {
    await waitForInit(page);
    await expect(page.locator('#sb-items .sb-git-job')).toHaveCount(0);
    const has = await page.evaluate(() => typeof (window as any).app._gitJobChip);
    expect(has, '_gitJobChip 이 되살아났다').toBe('undefined');
  });
});

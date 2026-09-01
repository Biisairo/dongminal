import { execFileSync } from 'child_process';
import { realpathSync } from 'fs';
import { join } from 'path';

import { test, expect, waitForInit, GIT_VIEW_TABS } from './fixtures';

// V-FLW-9 (FR-FLW-12) — 상태바의 **브랜치 chip 은 없다.**
//
// FR-GIT-57~59 는 철회됐다 (GIT_FOLLOW_REMOVAL_SRS D-FLW-7). 활성 리포는 사용자가
// 고른 것이고 터미널을 따라가지 않으므로, 하단바에 상주하는 브랜치 표시는 "지금
// 있는 곳" 으로 오해되기만 했다.
//
// 이 파일은 그 회귀 가드다 — 상태바에 리포 표시를 다시 얹는 변경이 오면 여기서
// 깨진다. 진행 중 원격 작업 표시(FR-GIT-112)는 남으며 git-remote.spec.ts 의
// R16 이 그것을 지킨다.

const FIXTURES = '/tmp/dm-git-fx-sb-' + process.pid;

test.beforeAll(() => {
  execFileSync('bash', ['e2e/git_fixture.sh', FIXTURES], { stdio: 'ignore' });
});
test.afterAll(() => {
  execFileSync('bash', ['e2e/git_fixture.sh', '--clean', FIXTURES], { stdio: 'ignore' });
});

const fx = (name: string) => realpathSync(join(FIXTURES, name));

test.describe('묶음 G — 상태바 (브랜치 chip 철회)', () => {
  test('B1 (V-FLW-9): 리포를 열어도 상태바에 브랜치 chip 이 없다', async ({ page }) => {
    await waitForInit(page);
    await page.evaluate((r) => (window as any).app.openGitWindow(r), fx('basic'));
    await expect(page.locator('#area .pn-tab[data-git-view]')).toHaveCount(GIT_VIEW_TABS);
    // 관측이 도착할 시간을 준 뒤에 본다 — 도착 전에 세면 아무것도 없는 것이 당연하다.
    await expect
      .poll(() => page.evaluate(() => !!(window as any).app.gitPanel.statusOf()), { timeout: 20000 })
      .toBe(true);
    await page.evaluate(() => (window as any).app._updateStatusBar());

    await expect(page.locator('#sb-items .sb-git')).toHaveCount(0);
    const text = (await page.locator('#sb-items').textContent()) || '';
    expect(text, `상태바에 브랜치가 보인다: ${text}`).not.toContain('main');
  });

  test('B2 (V-FLW-9): 설정 항목은 원격 작업 표시를 가리킨다', async ({ page }) => {
    await waitForInit(page);
    await page.click('#settings-btn');
    await page.click('button.mtab[data-tab="statusbar"]');
    const row = page.locator('#panel-statusbar .sbs-row[data-item="git"]');
    await expect(row).toHaveCount(1);
    // 라벨이 아직 "브랜치·변경 수" 를 말하면 설정이 없는 기능을 켜는 것이 된다.
    await expect(row).not.toContainText('브랜치');
    await page.click('#modal-close');
  });
});

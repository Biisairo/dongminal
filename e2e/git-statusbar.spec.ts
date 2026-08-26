import { execFileSync } from 'child_process';
import { realpathSync } from 'fs';
import { join } from 'path';

import { Page } from '@playwright/test';

import { test, expect } from './fixtures';

// GIT_M1_STEP8_CONTRACT §3 — 상태바 chip. 검증 V27 (FR-GIT-57·58·59).
//
// 테스트 저장소는 e2e/git_fixture.sh 가 만든다 (design/README.md).

const FIXTURES = '/tmp/dm-git-fx-sb-' + process.pid;

test.beforeAll(() => {
  execFileSync('bash', ['e2e/git_fixture.sh', FIXTURES], { stdio: 'ignore' });
});
test.afterAll(() => {
  execFileSync('bash', ['e2e/git_fixture.sh', '--clean', FIXTURES], { stdio: 'ignore' });
});

// 서버는 rev-parse 로 정규화한 루트를 준다 (macOS 의 /tmp → /private/tmp).
const fx = (name: string) => realpathSync(join(FIXTURES, name));

async function waitForInit(page: Page) {
  await page.context().addInitScript(() => {
    sessionStorage.setItem('displayMode', 'desktop');
  });
  await page.goto('/');
  await page.waitForSelector('#area .pn.focused .xterm-helper-textarea', { timeout: 15000 });
}

async function openGit(page: Page, repo: string) {
  await page.evaluate((r) => (window as any).app.openGitWindow(r), repo);
  await expect(page.locator('#area .pn-tab[data-git-view]')).toHaveCount(6);
}

const chip = (page: Page) => page.locator('#sb-items .sb-git');

test.describe('묶음 G — 상태바 chip', () => {
  test('B1 (V27): 기본 설정에서 chip 이 브랜치와 변경 수를 보인다', async ({ page }) => {
    const repo = fx('basic');
    await waitForInit(page);
    await openGit(page, repo);

    await expect(chip(page)).toHaveCount(1, { timeout: 10000 });
    // ⎇ 는 글자 기호다 — 이모지가 아니어서 폭이 일정하다.
    await expect(chip(page).locator('.sb-git-branch')).toHaveText('⎇ main');
    // basic 픽스처는 변경이 있으므로 dirty 표식에 개수가 붙는다.
    await expect(chip(page).locator('.sb-git-dirty')).toHaveText(/^●[1-9][0-9]*$/);
    await expect(chip(page)).toHaveAttribute('title', new RegExp(repo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  });

  test('B1b (V27): detached 는 브랜치 자리에 해시 앞 7자를 보인다', async ({ page }) => {
    const repo = fx('detached');
    await waitForInit(page);
    await openGit(page, repo);

    await expect(chip(page)).toHaveCount(1, { timeout: 10000 });
    await expect(chip(page)).toHaveClass(/sb-git-detached/);
    await expect(chip(page).locator('.sb-git-branch')).toHaveText(/^⎇ [0-9a-f]{7}$/);
  });

  test('B2 (V27): 설정에서 git 을 끄면 chip 이 사라진다', async ({ page }) => {
    const repo = fx('basic');
    await waitForInit(page);
    await openGit(page, repo);
    await expect(chip(page)).toHaveCount(1, { timeout: 10000 });

    // FR-GIT-57: 기존 STATUS_ITEMS 체계에 편입돼 사용자가 끌 수 있어야 한다.
    const row = page.locator('#panel-statusbar .sbs-row[data-item="git"]');
    await page.click('#settings-btn');
    await page.click('button.mtab[data-tab="statusbar"]');
    await expect(row).toHaveCount(1);
    await expect(row.locator('input')).toBeChecked();
    // 체크박스는 opacity:0 이다 — 눈에 보이는 것은 슬라이더이고 사용자도 그것을 누른다.
    await row.locator('.slider').click();
    await expect(row.locator('input')).not.toBeChecked();
    await page.click('#modal-close');

    await expect(chip(page)).toHaveCount(0);

    // 설정은 서버에 영속하므로 다시 켜 둔다 — 뒤 테스트가 앞 테스트에 묶이지 않게.
    await page.click('#settings-btn');
    await page.click('button.mtab[data-tab="statusbar"]');
    await row.locator('.slider').click();
    await expect(row.locator('input')).toBeChecked();
    await page.click('#modal-close');
    await expect(chip(page)).toHaveCount(1);
  });

  test('B3 (V27): chip 클릭이 Git 창을 활성화한다', async ({ page }) => {
    const repo = fx('basic');
    await waitForInit(page);
    await openGit(page, repo);
    await expect(chip(page)).toHaveCount(1, { timeout: 10000 });

    // 터미널 창으로 돌아간다 — chip 은 Git 창 밖에서도 마지막 관측을 보인다.
    const termId = await page.evaluate(() => {
      const a = (window as any).app;
      const w = a.ws.windows.find((s: any) => s.type !== 'git');
      a.switchWindow(w.id);
      return w.id;
    });
    expect(await page.evaluate(() => (window as any).app.ws.activeWindow)).toBe(termId);
    await expect(chip(page)).toHaveCount(1);

    await chip(page).click();
    const gitId = await page.evaluate(
      () => (window as any).app.ws.windows.find((s: any) => s.type === 'git').id,
    );
    expect(await page.evaluate(() => (window as any).app.ws.activeWindow)).toBe(gitId);
  });

  test('B4 (V27): 활성 리포가 없으면 chip 이 없다', async ({ page }) => {
    await waitForInit(page);
    // 리포 없이 Git 창을 연다 — 마지막 관측이 없으므로 항목을 넣지 않는다.
    await page.evaluate(() => (window as any).app.openGitWindow());
    await expect(page.locator('#area .pn-tab[data-git-view]')).toHaveCount(6);
    await page.evaluate(() => (window as any).app._updateStatusBar());
    await expect(chip(page)).toHaveCount(0);

    // 리포가 붙으면 나타나고, 떨어지면 다시 사라진다 (FR-GIT-59).
    await page.evaluate((r) => (window as any).app.gitPanel.setRepo(r), fx('basic'));
    await expect(chip(page)).toHaveCount(1, { timeout: 10000 });
    await page.evaluate(() => (window as any).app.gitPanel.setRepo(null));
    await expect(chip(page)).toHaveCount(0);
  });

  test('B5 (V27): chip 을 여러 번 갱신해도 클릭 리스너가 중복되지 않는다', async ({ page }) => {
    const repo = fx('basic');
    await waitForInit(page);
    await openGit(page, repo);
    await expect(chip(page)).toHaveCount(1, { timeout: 10000 });

    // 리스너가 _updateStatusBar 안에서 붙으면 갱신 횟수만큼 누적된다.
    await page.evaluate(() => {
      const a = (window as any).app;
      (window as any).__opens = 0;
      const orig = a.openGitWindow.bind(a);
      a.openGitWindow = (r?: string) => {
        (window as any).__opens++;
        return orig(r);
      };
      for (let i = 0; i < 6; i++) a._updateStatusBar();
    });
    await expect(chip(page)).toHaveCount(1);

    await chip(page).click();
    expect(await page.evaluate(() => (window as any).__opens)).toBe(1);
  });
});

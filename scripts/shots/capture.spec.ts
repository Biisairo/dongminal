import { test, expect, Page } from '@playwright/test';

// README 의 그림을 찍는다 (README_REWRITE_SRS 묶음 C).
//
// **격리 인스턴스에서만 찍는다** — 운영 화면에는 홈 경로·호스트명·실제 저장소
// 이름이 그대로 보이고, README 는 공개된다 (§2.3). 띄우는 쪽은 shoot.sh 다.
//
// 다시 찍는 비용이 낮아야 실제로 다시 찍는다 (D-4). 화면이 바뀌면 이 파일을 돌린다.

const OUT = process.env.SHOT_DIR || 'docs/images';
const BASE = process.env.SHOT_BASE || 'http://127.0.0.1:58199';

async function boot(page: Page) {
  await page.context().addInitScript(() => {
    sessionStorage.setItem('displayMode', 'desktop');
  });
  await page.goto(BASE);
  await page.waitForSelector('#area .pn.focused .xterm-helper-textarea', { timeout: 20000 });
  // 상태바의 호스트명을 끄고 제목을 중립으로 둔다 (FR-RDM-13).
  await page.evaluate(() => {
    const w = window as any;
    w.statusBar.hostname = false;
    w.pageTitle = 'notes-app';
    w.app._updateStatusBar();
    w.app._applyPageTitle();
  });
}

// 프롬프트를 중립으로 만든다 — 기본 프롬프트에는 사용자명@호스트명이 들어간다.
async function neutralShell(page: Page, cmds: string[] = []) {
  await page.keyboard.type('export PS1="$ " && clear\n');
  await page.waitForTimeout(600);
  for (const c of cmds) {
    await page.keyboard.type(c + '\n');
    await page.waitForTimeout(500);
  }
}

test('01 — 터미널과 분할', async ({ page }) => {
  await boot(page);
  await neutralShell(page, ['cd /tmp/dm-demo/notes-app && ls']);
  await page.click('#split-v');
  await page.waitForTimeout(900);
  await neutralShell(page, ['cd /tmp/dm-demo/notes-app && git log --oneline --graph --all']);
  await page.screenshot({ path: `${OUT}/terminal.png` });
});

test('02 — Git 창', async ({ page }) => {
  // 리포 고정은 API 로 한다 — 화면 조작으로 하면 다이얼로그 모양이 바뀔 때마다
  // 촬영이 깨진다. 여기서 재려는 것은 고정된 뒤의 **화면**이다.
  await page.request.post(`${BASE}/api/git/repos/pin`, { data: { path: '/tmp/dm-demo/notes-app' } });
  await boot(page);
  await page.click('.sb-tab[data-panel="git"]');
  await page.waitForTimeout(600);
  await page.locator('#git-list .git-repo, #git-repos .git-repo').first().click().catch(() => {});
  await page.waitForTimeout(1800);
  await page.screenshot({ path: `${OUT}/git.png` });
});

test('03 — 설정과 테마', async ({ page }) => {
  await boot(page);
  await neutralShell(page);
  await page.click('#settings-btn');
  await expect(page.locator('#modal-overlay')).toBeVisible();
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${OUT}/settings.png` });
});

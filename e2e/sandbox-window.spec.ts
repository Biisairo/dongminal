import { execSync } from 'child_process';

import { test, expect } from './fixtures';

// SANDBOX_WINDOW_SRS §4.2: 컨테이너 런타임이 있어야만 도는 시험이다. 없는
// 호스트에서는 건너뛴다 — 이 시험의 부재가 다른 시험을 막아서는 안 된다.
function runtimeReady(): boolean {
  try {
    execSync('docker info', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function sandboxContainers(): string[] {
  try {
    return execSync('docker ps -aq --filter name=dongminal-sbx-', { encoding: 'utf8' })
      .split('\n')
      .filter(Boolean);
  } catch {
    return [];
  }
}

test.describe('샌드박스 창', () => {
  test.skip(!runtimeReady(), '컨테이너 런타임(docker)이 없거나 데몬이 응답하지 않는다');

  // 시험이 남긴 컨테이너가 다음 시험의 계수를 흔들지 않도록 치운다.
  test.afterAll(() => {
    for (const id of sandboxContainers()) {
      try {
        execSync(`docker rm -f ${id}`, { stdio: 'ignore' });
      } catch {
        /* 이미 없는 것은 오류가 아니다 */
      }
    }
  });

  test('▣ Box 로 연 창은 컨테이너 안에서 돌고, 닫으면 회수된다', async ({ page }) => {
    await page.context().addInitScript(() => {
      sessionStorage.setItem('displayMode', 'desktop');
    });
    await page.goto('/');
    await page.waitForSelector('#add-sandbox-window', { timeout: 15000 });
    const before = sandboxContainers().length;

    // FR-SBX-34: 진입점은 `+ New` 안쪽의 박스다.
    await page.locator('#add-sandbox-window').click();

    // 배지가 붙는다 — 어느 창이 격리됐는지 목록에서 구분된다.
    const badged = page.locator('#windows .si:has(.si-sbx)');
    await expect(badged).toHaveCount(1, { timeout: 60000 });

    // FR-SBX-12: 그 창의 도구는 호스트가 아니라 컨테이너 안에서 돈다.
    await page.waitForSelector('#area .pn.focused .xterm-screen', { state: 'visible', timeout: 20000 });
    await page.click('#area .pn.focused .xterm-screen');
    await page.keyboard.type('cat /etc/os-release | head -1');
    await page.keyboard.press('Enter');
    await expect(page.locator('#area .pn.focused .xterm-rows'))
      .toContainText('Debian', { timeout: 30000 });

    // FR-SBX-6: 창 하나에 컨테이너 하나.
    expect(sandboxContainers().length).toBe(before + 1);

    // FR-SBX-8: Window 를 폐기하면 대응 컨테이너도 사라진다.
    const sid = await badged.getAttribute('data-sid');
    await page.locator(`[data-sid="${sid}"] .si-x`).click();
    // 전경 프로세스가 있다고 판정되면 확인창을 지난다.
    const ok = page.locator('.confirm-overlay .confirm-ok');
    if (await ok.isVisible().catch(() => false)) await ok.click();

    await expect.poll(() => sandboxContainers().length, { timeout: 30000 }).toBe(before);
  });

  test('일반 창에는 배지도 컨테이너도 없다', async ({ page }) => {
    await page.context().addInitScript(() => {
      sessionStorage.setItem('displayMode', 'desktop');
    });
    await page.goto('/');
    await page.waitForSelector('#add-window', { timeout: 15000 });
    const before = sandboxContainers().length;

    // 바깥(박스가 아닌 곳)을 누르면 종전대로 일반 창이다 (NFR-SBX-2).
    await page.locator('#add-window').click({ position: { x: 10, y: 15 } });
    await page.waitForSelector('#area .pn.focused .xterm-screen', { state: 'visible', timeout: 20000 });

    expect(sandboxContainers().length).toBe(before);
  });
});

import { execSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

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
    // SANDBOX_PICK_COPY_SRS FR-SPK-1: 선택창은 **언제나** 뜬다 — 프로파일이
    // 하나뿐이어도 그렇다. 여기서는 작업 폴더 없이 scratch 를 고른다.
    const pick = page.locator('.confirm-overlay:has(.sbx-pick)');
    await expect(pick).toBeVisible({ timeout: 15000 });
    await pick.locator('.sbx-opt', { hasText: 'scratch' }).click();

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

  // SANDBOX_PICK_COPY_SRS V-SPK-10·11·19: scratch 의 작업 폴더는 **복사**다.
  //
  // 마운트가 아니라는 것을 컨테이너 안에서 직접 확인한다 — 호스트에서 지운 뒤에도
  // 컨테이너 안에는 남아 있어야 하고(이어져 있지 않다는 증거), `/work` 아래에
  // 원본 폴더 이름의 한 겹이 더 생기지 않아야 한다 (`cp <src>/.` 의 요점).
  test('scratch 는 작업 폴더를 복사로 받는다 (마운트가 아니다)', async ({ page }) => {
    const dir = mkdtempSync(join(tmpdir(), 'dm-sbxcopy-'));
    writeFileSync(join(dir, 'marker.txt'), 'copied-not-mounted\n');

    await page.context().addInitScript(() => {
      sessionStorage.setItem('displayMode', 'desktop');
    });
    await page.goto('/');
    await page.waitForSelector('#add-sandbox-window', { timeout: 15000 });
    await page.locator('#add-sandbox-window').click();

    const pick = page.locator('.confirm-overlay:has(.sbx-pick)');
    await expect(pick).toBeVisible({ timeout: 15000 });
    await pick.locator('.sbx-workdir input').fill(dir);
    await pick.locator('.sbx-opt', { hasText: 'scratch' }).click();

    // 컨테이너 생성과 복사가 끝나야 도구가 뜬다. 그 전에는 **이전 창의**
    // 터미널이 화면에 있으므로, 셀렉터가 아니라 컨테이너 프롬프트를 기다린다 —
    // 요소만 보고 진행하면 호스트 셸에 명령을 치게 된다.
    // FR-SPK-19: 그 프롬프트의 자리가 곧 `/work` 다.
    await expect(page.locator('#area .pn.focused .xterm-rows'))
      .toContainText('/work#', { timeout: 120000 });

    // 여기서부터 컨테이너 안이다. 호스트 쪽 원본을 지운다 — 마운트였다면
    // 아래 cat 이 실패한다. 복사이므로 컨테이너 안에는 그대로 남는다.
    rmSync(dir, { recursive: true, force: true });
    await page.click('#area .pn.focused .xterm-screen');
    await page.keyboard.type('cat /work/marker.txt');
    await page.keyboard.press('Enter');
    await expect(page.locator('#area .pn.focused .xterm-rows'))
      .toContainText('copied-not-mounted', { timeout: 30000 });
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

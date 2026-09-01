import { execFileSync } from 'child_process';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { APIRequestContext, Page } from '@playwright/test';

import { test, expect } from './fixtures';

// 상단의 창 이름은 **지금 무엇을 보고 있는지**를 말해야 한다. Window·Editor 는
// 창 자체가 대상이라 저장된 이름이 곧 목록의 이름인데, Git 창만 `Git` 으로
// 고정이었다 — 창은 하나이고 리포를 갈아타므로 그 이름은 아무것도 말하지 않는다.
//
// SLOT_TITLE_BOUNDARY_SRS FR-STB-1 이 그 자리의 **형식**을 `<타입 라벨> · <창
// 이름>` 으로 바꿨다 (§5.1). 이 파일이 재는 것은 형식이 아니라 여전히 `· ` 뒤의
// 값 — 리포를 갈아타면 그것이 따라오는가 — 이다.

function makeRepo(prefix: string) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  execFileSync('git', ['init', '-q', dir]);
  writeFileSync(join(dir, 'a.txt'), 'x');
  return dir;
}

async function pin(request: APIRequestContext, path: string) {
  const r = await request.post('/api/git/repos/pin', { data: { path } });
  expect(r.ok(), `pin 실패: ${await r.text()}`).toBeTruthy();
  return (await r.json()).root as string;
}

async function waitForInit(page: Page) {
  await page.context().addInitScript(() => { sessionStorage.setItem('displayMode', 'desktop') });
  await page.goto('/');
  await page.waitForSelector('#area .pn.focused .xterm-helper-textarea', { timeout: 15000 });
}

const topName = (page: Page) => page.locator('#window-name');
// 사이드바 목록이 그 리포를 부르는 이름 — 상단이 맞춰야 할 값이다.
const listName = (page: Page, root: string) =>
  page.locator(`#git-repos .git-repo.pinned[data-git-repo="${root}"] .git-repo-name`);

test.describe('Git 창의 상단 이름', () => {
  test('상단 이름이 지금 보고 있는 리포다 — 목록과 같은 이름으로', async ({ page, request }) => {
    const a = await pin(request, makeRepo('dm-gwn-a-'));
    const b = await pin(request, makeRepo('dm-gwn-b-'));
    await waitForInit(page);

    await page.evaluate((p) => (window as any).app.openGitWindow(p), a);
    const wantA = await listName(page, a).textContent();
    expect(wantA).toBeTruthy();
    await expect(topName(page)).toHaveText(`Git · ${wantA!.trim()}`, { timeout: 10000 });
    await expect(topName(page)).not.toHaveText('Git');

    // 같은 창에서 리포만 바꾼다 — render 가 돌지 않는 경로다.
    await page.evaluate((p) => (window as any).app.openGitWindow(p), b);
    const wantB = await listName(page, b).textContent();
    expect(wantB).toBeTruthy();
    expect(wantB!.trim()).not.toBe(wantA!.trim());
    await expect(topName(page)).toHaveText(`Git · ${wantB!.trim()}`, { timeout: 10000 });
  });

  // 리포가 없는 Git 창은 저장된 이름으로 남는다 — 부를 다른 이름이 없다.
  test('리포를 고르지 않은 Git 창은 저장된 이름을 쓴다', async ({ page }) => {
    await waitForInit(page);
    await page.evaluate(() => (window as any).app.openGitWindow());
    // FR-STB-3: 창 이름이 타입 라벨과 같으면 `Git · Git` 으로 겹쳐 적지 않는다.
    await expect(topName(page)).toHaveText('Git', { timeout: 10000 });
  });

  // 터미널 창은 종전대로다 — 이 변경이 Git 밖으로 새지 않아야 한다.
  test('터미널 창의 이름은 종전대로 창 이름이다', async ({ page }) => {
    await waitForInit(page);
    const name = await page.evaluate(() => {
      const app = (window as any).app;
      const w = app.ws.windows.find((x: any) => !app._isGitWin(x) && !app._isEditorWin(x));
      app.switchWindow(w.id);
      return w.name;
    });
    await expect(topName(page)).toHaveText(`Windows · ${name}`, { timeout: 10000 });
  });
});

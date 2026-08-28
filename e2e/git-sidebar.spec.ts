import { execFileSync } from 'child_process';
import { mkdtempSync, realpathSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { basename, join } from 'path';

import { APIRequestContext, Page } from '@playwright/test';

import { test, expect, openGitTab } from './fixtures';

// GIT_M1_STEP4_CONTRACT §4 — 좌측 GIT 섹션. 검증 V17·V16·V3·V7.
//
// fixtures 의 resetWorkspace 가 매 테스트 전에 workspace.json 을 비워
// git.pinned 도 지운다. 필요한 핀은 각 테스트가 스스로 만든다.

// 프로젝트 저장소 경로는 서버에게 묻는다 — 비교 대상이 서버가 rev-parse 로 준
// 값이므로, 테스트 프로세스의 cwd 를 쓰면 심링크 차이로 갈라진다.
async function projectRepo(request: APIRequestContext) {
  const d = await (await request.get('/api/git/repo-at')).json();
  expect(d.isRepo, `서버 cwd 가 저장소가 아니다: ${JSON.stringify(d)}`).toBeTruthy();
  return d.path as string;
}

async function waitForInit(page: Page) {
  await page.context().addInitScript(() => {
    sessionStorage.setItem('displayMode', 'desktop');
  });
  await page.goto('/');
  await page.waitForSelector('#area .pn.focused .xterm-helper-textarea', { timeout: 15000 });
}

// follow 대상은 포커스된 칸의 셸 cwd 다 — 셸을 실제로 이동시킨다.
async function cd(page: Page, dir: string) {
  await page.keyboard.type(`cd ${dir}`);
  await page.keyboard.press('Enter');
  await page.keyboard.type('echo moved_ok');
  await page.keyboard.press('Enter');
  await expect(page.locator('#area .pn.focused .xterm-rows')).toContainText('moved_ok', { timeout: 10000 });
}

// makeRepo 는 tmpdir 아래에 저장소 하나를 만든다. 추적되지 않은 파일 하나를
// 두므로 배지의 total 은 1 이다.
function makeRepo(prefix: string) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  execFileSync('git', ['init', '-q', dir]);
  writeFileSync(join(dir, 'a.txt'), 'x');
  return dir;
}

// 핀은 서버가 rev-parse 로 재확인한 root 를 저장한다 (macOS 의 /var → /private/var).
// 보낸 경로가 아니라 응답의 root 로 항목을 찾아야 한다.
async function pin(request: APIRequestContext, path: string) {
  const r = await request.post('/api/git/repos/pin', { data: { path } });
  expect(r.ok(), `pin 실패: ${await r.text()}`).toBeTruthy();
  return (await r.json()).root as string;
}

const pinned = (page: Page, root: string) =>
  page.locator(`#git-repos .git-repo.pinned[data-git-repo="${root}"]`);

test.describe('묶음 B — 좌측 GIT 섹션', () => {
  // FR-SBT-1·2·7 로 GIT 섹션은 **탭 뒤**로 옮겨졌다. 옛 `.git-sec-title` 은 사라지고
  // 탭 이름이 그 역할을 대신하므로(§3.9.1) 제목 검사는 탭 라벨 검사가 된다.
  test('S1 (V17·V-FLW-10·V-SBT-1·2): GIT 탭 뒤에 + Add·목록이 있다', async ({ page }) => {
    await waitForInit(page);
    // V-SBT-1: 최초 접속은 Windows 활성, Git 패널 숨김.
    await expect(page.locator('.sb-tab[data-panel="windows"]')).toHaveClass(/active/);
    await expect(page.locator('#sb-panel-git')).toBeHidden();
    // WINDOWS 목록은 그대로 남는다 — 옮겨진 것은 GIT 쪽이다.
    await expect(page.locator('#windows .si')).toHaveCount(1);

    await expect(page.locator('.sb-tab[data-panel="git"] .sb-tab-label')).toHaveText('Git');
    await openGitTab(page);
    await expect(page.locator('#sb-panel-windows')).toBeHidden();
    await expect(page.locator('#git-repos')).toBeVisible();
    await expect(page.locator('#git-add-repo')).toBeVisible();
    // FR-FLW-11: follow 행이 사라져 이 섹션은 처음으로 빌 수 있게 됐다. 빈 자리는
    // 고장처럼 읽히므로 안내가 자리를 지킨다.
    await expect(page.locator('#git-repos .git-repos-none')).toBeVisible({ timeout: 10000 });
  });

  // V-FLW-1·4·5 (FR-FLW-1·4·5) — follow 를 지운 자리.
  //
  // 목록은 **핀에서만** 온다. 터미널을 저장소 안으로 옮겨도 줄이 늘지 않고,
  // 그 리포로 가는 길은 `+ Add` 가 대신한다 — 열면 이미 채워져 있다.
  test('S2 (V-FLW-1·5): 터미널을 옮겨도 목록은 그대로고, + Add 가 그 리포를 채운다', async ({
    page,
    request,
  }) => {
    const repo = await projectRepo(request);
    await waitForInit(page);
    await page.waitForSelector('#area .pn.focused .xterm-screen', { state: 'visible', timeout: 15000 });
    await page.click('#area .pn.focused .xterm-screen');
    await cd(page, repo);

    // follow 행은 없다. 저장소로 들어가도 목록은 비어 있다.
    await expect(page.locator('#git-repos .git-repo.follow')).toHaveCount(0);
    await expect(page.locator('#git-repos .git-repo')).toHaveCount(0, { timeout: 10000 });

    await openGitTab(page);
    await page.click('#git-add-repo');
    const dlg = page.locator('#git-add-repo-dlg');
    await expect(dlg).toBeVisible({ timeout: 10000 });
    // 지금 터미널의 리포가 이미 채워져 있다 — 타이핑 없이 한 번의 클릭이다.
    await expect(dlg.locator('.gar-path')).toHaveValue(repo, { timeout: 15000 });
    await dlg.locator('.git-dialog-go').click();

    await expect(pinned(page, repo)).toHaveCount(1, { timeout: 10000 });
    await expect(dlg).toHaveCount(0);
  });

  // V-FLW-4 (FR-FLW-4): 활성 리포는 **스스로 바뀌지 않는다.** 터미널을 다른
  // 저장소로 옮겨도 Git 창과 하단바 chip 은 사용자가 고른 것을 계속 가리킨다 —
  // 이것이 의도된 동작이며, 그 사실을 여기서 고정한다.
  test('S2b (V-FLW-4): 터미널 cwd 를 옮겨도 활성 리포와 chip 이 바뀌지 않는다', async ({
    page,
    request,
  }) => {
    await waitForInit(page);
    const termWin = await page.evaluate(() => (window as any).app.ws.activeWindow);
    const root = await pin(request, makeRepo('dm-repo-flw4-'));
    await openGitTab(page);
    await pinned(page, root).click();
    await expect(page.locator('#area .pn-tab[data-git-view]')).toHaveCount(7);
    expect(await page.evaluate(() => (window as any).app.gitPanel.repo)).toBe(root);

    // 핀을 눌러 Git 창이 활성이 됐다 — 터미널로 돌아가야 cd 를 칠 수 있다.
    const other = makeRepo('dm-repo-flw4b-');
    await page.evaluate((id) => (window as any).app.switchWindow(id), termWin);
    await page.waitForSelector('#area .pn.focused .xterm-screen', { state: 'visible', timeout: 15000 });
    await page.click('#area .pn.focused .xterm-screen');
    await cd(page, other);
    // 폴링 주기를 넉넉히 넘긴 뒤에도 그대로다.
    await expect
      .poll(() => page.evaluate(() => (window as any).app.gitPanel.repo), { timeout: 8000, intervals: [1000] })
      .toBe(root);
  });

  // V-FLW-6 (FR-FLW-7): 거부는 **그 자리에** 보인다. 다이얼로그가 닫히면 복사할
  // 자리도 사유도 사라진다 (FR-GIT-175 와 같은 규약).
  test('S3 (V16·V-FLW-6): 저장소가 아닌 경로는 핀되지 않고 다이얼로그 안에서 사유를 보인다', async ({
    page,
  }) => {
    await waitForInit(page);
    const before = await page.locator('#git-repos .git-repo').count();
    const dir = mkdtempSync(join(tmpdir(), 'dm-norepo-'));

    await openGitTab(page);
    await page.click('#git-add-repo');
    const dlg = page.locator('#git-add-repo-dlg');
    await expect(dlg).toBeVisible({ timeout: 10000 });
    await dlg.locator('.gar-path').fill(dir);
    await dlg.locator('.git-dialog-go').click();

    await expect(dlg.locator('.git-dialog-err-reason')).toContainText('not_a_git_repo', { timeout: 10000 });
    // 닫히지 않는다.
    await expect(dlg).toBeVisible();
    await expect(page.locator('#git-repos .git-repo.pinned')).toHaveCount(0);
    await expect(page.locator('#git-repos .git-repo')).toHaveCount(before);
  });

  // V-FLW-7 (FR-FLW-8): 이미 있는 것을 다시 넣으면 목록이 늘지 않는다. 그 이유가
  // 보이지 않으면 사용자는 실패로 읽는다.
  test('S3b (V-FLW-7): 이미 핀된 리포를 다시 추가하면 그 사실을 알린다', async ({ page, request }) => {
    await waitForInit(page);
    const root = await pin(request, makeRepo('dm-repo-dup-'));
    await expect(pinned(page, root)).toHaveCount(1, { timeout: 10000 });

    await openGitTab(page);
    await page.click('#git-add-repo');
    const dlg = page.locator('#git-add-repo-dlg');
    await expect(dlg).toBeVisible({ timeout: 10000 });
    await dlg.locator('.gar-path').fill(root);
    await dlg.locator('.git-dialog-go').click();

    await expect(dlg.locator('.git-dialog-err-reason')).toContainText('이미 목록에', { timeout: 10000 });
    await expect(page.locator('#git-repos .git-repo.pinned')).toHaveCount(1);
  });

  test('S4 (V16): 핀한 리포가 목록에 나오고 × 로 사라진다', async ({ page, request }) => {
    await waitForInit(page);
    const root = await pin(request, makeRepo('dm-repo-a-'));
    await openGitTab(page);
    const item = pinned(page, root);
    await expect(item).toHaveCount(1, { timeout: 10000 });
    await expect(item.locator('.git-repo-name')).toHaveText(basename(root));

    await item.locator('.git-repo-x').click();
    await expect(item).toHaveCount(0, { timeout: 10000 });
    const after = await (await request.get('/api/git/repos')).json();
    expect(after.pinned.map((p: { path: string }) => p.path)).not.toContain(root);
  });

  test('S5 (V17): 항목 클릭이 Git 창을 활성화하고 그 리포를 활성으로 만든다', async ({ page, request }) => {
    await waitForInit(page);
    const root = await pin(request, makeRepo('dm-repo-b-'));
    await openGitTab(page);
    const item = pinned(page, root);
    await expect(item).toHaveCount(1, { timeout: 10000 });

    await item.click();
    await expect(page.locator('#area .pn-tab[data-git-view]')).toHaveCount(7);
    expect(await page.evaluate(() => (window as any).app.gitPanel.repo)).toBe(root);
    const gid = await page.evaluate(() => (window as any).app._gitWindow().id);
    expect(await page.evaluate(() => (window as any).app.ws.activeWindow)).toBe(gid);
    await expect(item).toHaveClass(/active/);
  });

  test('S6 (V7·V17): 활성이 아닌 리포의 배지는 stale 로 흐려진다', async ({ page, request }) => {
    await waitForInit(page);
    const ra = await pin(request, makeRepo('dm-repo-c-'));
    const rb = await pin(request, makeRepo('dm-repo-d-'));
    // 배지는 서버의 마지막 관측값이다 (FR-GIT-24). /api/git/repos 는 git 을
    // 실행하지 않으므로 관측을 한 번 일으켜 채운다.
    for (const r of [ra, rb]) {
      const st = await request.get('/api/git/status?repo=' + encodeURIComponent(r));
      expect(st.ok(), `status 실패: ${await st.text()}`).toBeTruthy();
    }
    await openGitTab(page);
    const a = pinned(page, ra), b = pinned(page, rb);
    await expect(a.locator('.git-badge')).toHaveText('1', { timeout: 10000 });
    await expect(b.locator('.git-badge')).toHaveText('1', { timeout: 10000 });

    await a.click();
    await expect(a).toHaveClass(/active/);
    await expect(a.locator('.git-badge')).not.toHaveClass(/stale/);
    await expect(b.locator('.git-badge')).toHaveClass(/stale/);
    await expect(b.locator('.git-badge')).toHaveAttribute('title', /최신 아님/);
  });

  // FR-SBT-3 (D-5) 로 **전제가 바뀌었다.** 두 목록은 더 이상 같은 컬럼에서 높이를
  // 다투지 않으므로 "창이 많으면 GIT 이 밀린다" 는 상황 자체가 성립하지 않는다.
  // 남는 계약은 그보다 강하다 — 보이는 패널이 사이드바의 **남은 높이 전부**를 쓴다.
  test('S7 (V17·V-SBT-2·3): 창이 많아도 각 탭이 사이드바의 남은 높이를 쓴다', async ({ page }) => {
    await waitForInit(page);
    await page.setViewportSize({ width: 1280, height: 400 });
    for (let i = 0; i < 10; i++) await page.evaluate(() => (window as any).app.addWindow());
    await expect(page.locator('#windows .si')).toHaveCount(11);

    const sb = (await page.locator('#sidebar').boundingBox())!;
    const tabs = (await page.locator('#sb-tabs').boundingBox())!;
    const set = (await page.locator('#settings-btn').boundingBox())!;
    // V-SBT-3: WINDOWS 목록은 40% 가 아니라 남은 높이 전부로 스크롤한다.
    const wins = (await page.locator('#sb-panel-windows').boundingBox())!;
    expect(wins.y, 'WINDOWS 패널이 탭 바 아래에서 시작하지 않는다')
      .toBeGreaterThanOrEqual(tabs.y + tabs.height - 1);
    expect(wins.height, 'WINDOWS 패널이 남은 높이를 쓰지 않는다')
      .toBeGreaterThan((set.y - (tabs.y + tabs.height)) * 0.9);

    await openGitTab(page);
    await expect(page.locator('#git-repos')).toBeInViewport();
    await expect(page.locator('#git-add-repo')).toBeInViewport();
    const box = (await page.locator('#git-repos').boundingBox())!;
    expect(box.y + box.height, 'GIT 목록이 사이드바 밖으로 밀렸다')
      .toBeLessThanOrEqual(sb.y + sb.height + 1);
    // V-SBT-2: 40% 상한이 사라졌다 — 남은 높이 전부를 쓴다.
    expect(box.height, 'GIT 목록이 아직 사이드바 높이의 절반 아래다')
      .toBeGreaterThan(sb.height * 0.5);
  });
  test('S8 (V16): 서버가 쓴 핀은 클라이언트의 409 재시도 저장에도 살아남는다', async ({ page, request }) => {
    await waitForInit(page);
    const root = await pin(request, makeRepo('dm-repo-e-'));
    await expect(pinned(page, root)).toHaveCount(1, { timeout: 10000 });

    // 핀은 서버가 workspace.json 에 직접 쓴다 (O1). 클라이언트 사본에 git 이 없는
    // 상태로 낡은 rev 를 들고 저장하면 409 재시도가 일어난다 — 그 재시도가 우리
    // 본문으로 덮으면 방금 만든 핀이 조용히 사라진다.
    await page.evaluate(() => {
      const a = (window as any).app;
      delete a.ws.git;
      a.wsETag = '1';
      return a._save();
    });
    // 창 추가도 같은 저장 경로를 밟는다.
    await page.evaluate(() => (window as any).app.addWindow());
    await expect.poll(async () => {
      const d = await (await request.get('/api/git/repos')).json();
      return d.pinned.map((p: { path: string }) => p.path);
    }, { timeout: 10000 }).toContain(root);

    await page.reload();
    await page.waitForSelector('#area .pn.focused .xterm-helper-textarea', { timeout: 15000 });
    await expect(pinned(page, root)).toHaveCount(1, { timeout: 10000 });
  });

});

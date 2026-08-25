import { execFileSync } from 'child_process';
import { mkdtempSync, realpathSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { basename, join } from 'path';

import { APIRequestContext, Page } from '@playwright/test';

import { test, expect } from './fixtures';

// GIT_M1_STEP4_CONTRACT §4 — 좌측 GIT 섹션. 검증 V17·V16·V3·V7.
//
// fixtures 의 resetWorkspace 가 매 테스트 전에 workspace.json 을 비워
// git.pinned 도 지운다. 필요한 핀은 각 테스트가 스스로 만든다.

// 프로젝트 저장소 경로는 서버에게 묻는다 — 비교 대상이 서버가 rev-parse 로 준
// 값이므로, 테스트 프로세스의 cwd 를 쓰면 심링크 차이로 갈라진다.
async function projectRepo(request: APIRequestContext) {
  const d = await (await request.get('/api/git/repos')).json();
  expect(d.follow.isRepo, `서버 cwd 가 저장소가 아니다: ${JSON.stringify(d.follow)}`).toBeTruthy();
  return d.follow.path as string;
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
  test('S1 (V17): GIT 섹션 제목·+ Add·목록이 사이드바에 있다', async ({ page }) => {
    await waitForInit(page);
    await expect(page.locator('#sidebar .git-sec-title')).toHaveText('Git');
    await expect(page.locator('#git-repos')).toBeVisible();
    await expect(page.locator('#git-add-repo')).toBeVisible();
    // WINDOWS 목록은 그대로 남는다 — GIT 섹션은 아래에 덧붙는다.
    await expect(page.locator('#windows .si')).toHaveCount(1);
  });

  test('S2 (V3·V17): follow 항목이 포커스된 칸의 cwd 를 따라간다', async ({ page, request }) => {
    const repo = await projectRepo(request);
    await waitForInit(page);
    // 셸의 초기 cwd 는 홈이다 — follow 대상은 포커스된 칸의 cwd 이므로
    // 저장소 안으로 들어가 확인한다.
    await page.waitForSelector('#area .pn.focused .xterm-screen', { state: 'visible', timeout: 15000 });
    await page.click('#area .pn.focused .xterm-screen');
    await cd(page, repo);

    const follow = page.locator('#git-repos .git-repo.follow');
    await expect(follow).toHaveCount(1, { timeout: 10000 });
    await expect(follow).toHaveAttribute('data-git-repo', repo, { timeout: 15000 });
    await expect(follow).not.toHaveClass(/norepo/);
    await expect(follow.locator('.git-repo-name')).toHaveText(basename(repo));

    // FR-GIT-10: 저장소 밖으로 나가면 마지막 유효 리포를 남기지 않는다.
    await cd(page, realpathSync(mkdtempSync(join(tmpdir(), 'dm-outside-'))));
    await expect(follow).toHaveClass(/norepo/, { timeout: 15000 });
    await expect(follow).not.toHaveAttribute('data-git-repo', repo);
  });

  test('S3 (V16): 저장소가 아닌 경로는 핀되지 않고 사유를 알린다', async ({ page }) => {
    await waitForInit(page);
    await expect(page.locator('#git-repos .git-repo.follow')).toHaveCount(1, { timeout: 10000 });
    const before = await page.locator('#git-repos .git-repo').count();

    const dir = mkdtempSync(join(tmpdir(), 'dm-norepo-'));
    const seen: string[] = [];
    page.on('dialog', async (d) => {
      seen.push(`${d.type()}:${d.message()}`);
      if (d.type() === 'prompt') await d.accept(dir);
      else await d.accept();
    });
    await page.click('#git-add-repo');
    // 프롬프트 → 실패 알림. 조용히 실패하지 않는다.
    await expect.poll(() => seen.length, { timeout: 10000 }).toBe(2);
    expect(seen[1], `실패 사유가 보이지 않았다: ${seen[1]}`).toContain('not_a_git_repo');

    await expect(page.locator('#git-repos .git-repo.pinned')).toHaveCount(0);
    await expect(page.locator('#git-repos .git-repo')).toHaveCount(before);
  });

  test('S4 (V16): 핀한 리포가 목록에 나오고 × 로 사라진다', async ({ page, request }) => {
    await waitForInit(page);
    const root = await pin(request, makeRepo('dm-repo-a-'));
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
    const item = pinned(page, root);
    await expect(item).toHaveCount(1, { timeout: 10000 });

    await item.click();
    await expect(page.locator('#area .pn-tab[data-git-view]')).toHaveCount(6);
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
    const a = pinned(page, ra), b = pinned(page, rb);
    await expect(a.locator('.git-badge')).toHaveText('1', { timeout: 10000 });
    await expect(b.locator('.git-badge')).toHaveText('1', { timeout: 10000 });

    await a.click();
    await expect(a).toHaveClass(/active/);
    await expect(a.locator('.git-badge')).not.toHaveClass(/stale/);
    await expect(b.locator('.git-badge')).toHaveClass(/stale/);
    await expect(b.locator('.git-badge')).toHaveAttribute('title', /최신 아님/);
  });

  test('S7 (V17): 창이 많아 WINDOWS 목록이 넘쳐도 GIT 섹션이 보인다', async ({ page }) => {
    await waitForInit(page);
    // 사이드바 높이를 줄여 두 목록이 서로를 굶기는 상황을 만든다 (FR-GIT-17).
    await page.setViewportSize({ width: 1280, height: 400 });
    for (let i = 0; i < 10; i++) await page.evaluate(() => (window as any).app.addWindow());
    await expect(page.locator('#windows .si')).toHaveCount(11);

    await expect(page.locator('#git-repos')).toBeInViewport();
    await expect(page.locator('#git-add-repo')).toBeInViewport();
    await expect(page.locator('#git-repos .git-repo.follow')).toHaveCount(1, { timeout: 10000 });

    const box = (await page.locator('#git-repos').boundingBox())!;
    const sb = (await page.locator('#sidebar').boundingBox())!;
    expect(box.y + box.height, 'GIT 목록이 사이드바 밖으로 밀렸다')
      .toBeLessThanOrEqual(sb.y + sb.height + 1);
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

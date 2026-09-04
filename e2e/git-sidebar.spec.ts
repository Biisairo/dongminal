import { execFileSync } from 'child_process';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { basename, join } from 'path';

import { APIRequestContext, Page } from '@playwright/test';

import { test, expect, openGitTab, waitForInit } from './fixtures';

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

/**
 * **개정 (REPO_TAB_UNIFY_SRS FR-RTU-1·3 / D-RTU-2).** `Git` 과 `Editor` 두 탭이
 * `Repo` 하나가 되면서 목록의 원천도 `editors.list` 하나가 됐다 — 행은 이제
 * `.ed-entry` 이고 `.git-repo.pinned` 라는 구분이 없다 (핀이 아닌 행이 없다).
 * 배지 클래스(`.git-badge`)는 그대로다.
 */
const pinned = (page: Page, root: string) =>
  page.locator(`#repo-entries .ed-entry[data-git-repo="${root}"]`);

test.describe('묶음 B — 좌측 GIT 섹션', () => {
  // FR-SBT-1·2·7 로 GIT 섹션은 **탭 뒤**로 옮겨졌다. 옛 `.git-sec-title` 은 사라지고
  // 탭 이름이 그 역할을 대신하므로(§3.9.1) 제목 검사는 탭 라벨 검사가 된다.
  test('S1 (V17·V-FLW-10·V-SBT-1·2): GIT 탭 뒤에 + Add·목록이 있다', async ({ page }) => {
    await waitForInit(page);
    // V-SBT-1: 최초 접속은 Windows 활성, Git 패널 숨김.
    await expect(page.locator('.sb-tab[data-panel="windows"]')).toHaveClass(/active/);
    await expect(page.locator('#sb-panel-repo')).toBeHidden();
    // WINDOWS 목록은 그대로 남는다 — 옮겨진 것은 GIT 쪽이다.
    await expect(page.locator('#windows .si')).toHaveCount(1);

    // FR-RTU-1 / D-RTU-15: 탭 이름은 `Repo` 다 — `Git` 과 `Editor` 를 합친 하나다.
    await expect(page.locator('.sb-tab[data-panel="repo"] .sb-tab-label')).toHaveText('Repo');
    await openGitTab(page);
    await expect(page.locator('#sb-panel-windows')).toBeHidden();
    await expect(page.locator('#repo-entries')).toBeVisible();
    await expect(page.locator('#repo-add')).toBeVisible();
    // FR-FLW-11: follow 행이 사라져 이 섹션은 처음으로 빌 수 있게 됐다. 빈 자리는
    // 고장처럼 읽히므로 안내가 자리를 지킨다.
    await expect(page.locator('#repo-entries .ed-entries-none')).toBeVisible({ timeout: 10000 });
  });

  /**
   * **S2 는 폐기됐다** (REPO_TAB_UNIFY_SRS FR-RTU-5 / D-RTU-2).
   *
   * `+ Add` 가 둘이 아니라 하나다 — 진입점은 `#repo-add` 이고 종단은
   * `/api/editors/add` 뿐이며, 그것이 연동으로 핀까지 함께 만든다. git 전용
   * 핀 다이얼로그(`#git-add-repo-dlg`·`.gar-path`)는 진입점이 없다.
   *
   * 그 하나가 하는 일은 `editor-tab.spec.ts` 가 검증한다 (V-EDT-3·11·12).
   */

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
    // FR-RTU-72: 행 클릭은 **그 경로의 Repo 창으로 전환**한다. 뷰 탭은 열지
    // 않는다 — 그것은 Changes 사이드의 아이콘 줄이 하는 일이다 (FR-RTU-21).
    await page.waitForSelector('#area .ed-win .ed-side', { timeout: 15000 });
    // `_edOpenWindow` 는 목록에 없던 경로면 종단을 지나므로 비동기다 — 값이
    // 앉기를 기다린다.
    await expect
      .poll(() => page.evaluate(() => (window as any).app.gitPanel?.repo), { timeout: 10000 })
      .toBe(root);

    // 핀을 눌러 그 저장소의 Repo 창이 활성이 됐다 — 터미널로 돌아가야 cd 를 칠 수 있다.
    const other = makeRepo('dm-repo-flw4b-');
    await page.evaluate((id) => (window as any).app.switchWindow(id), termWin);
    await page.waitForSelector('#area .pn.focused .xterm-screen', { state: 'visible', timeout: 15000 });
    await page.click('#area .pn.focused .xterm-screen');
    await cd(page, other);
    /**
     * 폴링 주기를 넉넉히 넘긴 뒤에도 그대로다.
     *
     * **개정 (REPO_TAB_UNIFY_SRS FR-RTU-60·65 / D-RTU-18).** `app.gitPanel` 은
     * **활성 창의** 패널이다 — 터미널 창에 서 있는 동안에는 루트가 없어 `repo` 가
     * `null` 이고, 그것은 결함이 아니라 새 구조다. FR-FLW-4 가 재던 것은 "그
     * 저장소의 표면이 스스로 다른 저장소를 보지 않는다" 이므로, 대상을 **그
     * 루트의 패널**로 바꿔 같은 사실을 잰다 (저장소가 창의 루트에서 나오므로
     * 터미널의 cwd 는 그것을 건드릴 수 없다, FR-RTU-24).
     */
    await expect
      .poll(() => page.evaluate((r) => {
        const a = (window as any).app;
        const w = a._edWindowFor(r);
        return w ? a._gitPanel(a._edRootOf(w), 0).repo : null;
      }, root), { timeout: 8000, intervals: [1000] })
      .toBe(root);
  });

  /**
   * **S3·S3b 도 폐기됐다** (FR-RTU-9 / D-RTU-12).
   *
   * S3 이 재던 것은 "저장소가 아닌 경로는 거부된다" 였다. 그 규칙이 **뒤집혔다** —
   * 탐색기와 편집기는 git 없이 성립하므로 저장소가 아닌 경로도 Repo 목록의
   * 정당한 행이고, git 이 없다는 사실은 Changes 사이드가 `git init` 과 함께
   * 말한다 (FR-RTU-25). 중복 추가(S3b)의 안내도 `/api/editors/add` 쪽 계약이며
   * `editor-tab.spec.ts` 가 검증한다.
   */

  test('S4 (V16): 핀한 리포가 목록에 나오고 × 로 사라진다', async ({ page, request }) => {
    await waitForInit(page);
    const root = await pin(request, makeRepo('dm-repo-a-'));
    await openGitTab(page);
    const item = pinned(page, root);
    await expect(item).toHaveCount(1, { timeout: 10000 });
    await expect(item.locator('.ed-entry-name')).toHaveText(basename(root));

    await item.locator('.ed-entry-x').click();
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
    // FR-RTU-72: 그 경로의 Repo 창이 활성이 된다. 옛 `_gitWindow()` 는 사라졌다
    // (FR-RTU-70) — 창의 신원은 **루트**다 (D-RTU-18).
    await page.waitForSelector('#area .ed-win .ed-side', { timeout: 15000 });
    expect(await page.evaluate(() => (window as any).app.gitPanel.repo)).toBe(root);
    const gid = await page.evaluate((r) => (window as any).app._edWindowFor(r).id, root);
    expect(await page.evaluate(() => (window as any).app.ws.activeWindow)).toBe(gid);
    await expect(item).toHaveClass(/active/);
  });

  // ATTENTION_LIFECYCLE_GIT_OBSERVE_SRS V-GOB-1·4 (FR-GOB-9·14) 로 **규칙이
  // 바뀌었다.** 옛 S6 은 "활성이 아닌 리포의 배지는 stale" 이었는데, 그때는 관측을
  // 활성 리포만 만들었으므로 그 둘이 같은 말이었다. 이제 Git 탭에 들어가면 핀
  // 전부가 관측되므로, 열어 본 적 없는 리포에도 **최신** 배지가 선다.
  test('S6 (V-GOB-1·4): Git 탭에 들어가면 핀 전부의 배지가 최신이 된다', async ({ page, request }) => {
    await waitForInit(page);
    const ra = await pin(request, makeRepo('dm-repo-c-'));
    const rb = await pin(request, makeRepo('dm-repo-d-'));
    // 관측을 미리 일으키지 **않는다** — 탭 진입이 스스로 만들어야 한다.
    await openGitTab(page);
    const a = pinned(page, ra), b = pinned(page, rb);
    await expect(a.locator('.git-badge')).toHaveText('1', { timeout: 10000 });
    await expect(b.locator('.git-badge')).toHaveText('1', { timeout: 10000 });
    await expect(a.locator('.git-badge')).not.toHaveClass(/stale/);
    await expect(b.locator('.git-badge')).not.toHaveClass(/stale/);

    // 활성 리포를 골라도 나머지가 낡지 않는다 — 낡음의 근거는 관측 시각이다.
    await a.click();
    await page.waitForSelector('#area .ed-win .ed-side', { timeout: 15000 });
    await expect(a).toHaveClass(/active/);
    await expect(b.locator('.git-badge')).not.toHaveClass(/stale/, { timeout: 10000 });
  });

  // FR-GOB-14: 관측이 실제로 멎으면 낡음 표시가 선다. 시각을 뒤로 밀어 그
  // 상태만 만든다 — 폴링을 멈출 방법이 화면에는 없기 때문이다.
  test('S6b (V-GOB-4): 관측이 오래되면 배지가 stale 로 흐려진다', async ({ page, request }) => {
    await waitForInit(page);
    const ra = await pin(request, makeRepo('dm-repo-c2-'));
    await openGitTab(page);
    const a = pinned(page, ra);
    await expect(a.locator('.git-badge')).toHaveText('1', { timeout: 10000 });

    await page.evaluate(() => {
      const app = (window as any).app;
      // 폴링이 곧 최신 값을 다시 실어 오므로, 갱신을 끊고 관측 시각만 뒤로 민다.
      app._gitReposRefresh = async () => {};
      for (const e of (app._gitRepos.pinned || [])) {
        if (e.badge) e.badge.observedAtUnixMs -= 60_000;
      }
      app.renderer._rGitSection();
    });
    await expect(a.locator('.git-badge')).toHaveClass(/stale/);
    await expect(a.locator('.git-badge')).toHaveAttribute('title', /최신 아님/);
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
    await expect(page.locator('#repo-entries')).toBeInViewport();
    await expect(page.locator('#repo-add')).toBeInViewport();
    const box = (await page.locator('#repo-entries').boundingBox())!;
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

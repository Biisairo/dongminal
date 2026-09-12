import { execFileSync } from 'child_process';
import { mkdtempSync, writeFileSync } from 'fs';
import { basename, join } from 'path';

import { APIRequestContext, Page } from '@playwright/test';

import {
  test, expect, openGitTab, waitForInit, waitShellReady, openGit, makeCopyFx, gitFixture, cleanGitFixture, clickGitView, nextFrames,
} from './fixtures';
import { TMP, cssPath, tmpPath, realPath } from './osenv';

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
  // 셸이 입력을 받을 수 있어야 한다 — xterm 이 선 것과 셸이 뜬 것은 다르다
  // (FR-CEM-13).
  await waitShellReady(page);
  await page.keyboard.type(`cd ${dir}`);
  await page.keyboard.press('Enter');
  await page.keyboard.type('echo moved_ok');
  await page.keyboard.press('Enter');
  await expect(page.locator('#area .pn.focused .xterm-rows')).toContainText('moved_ok', { timeout: 10000 });
}

// makeRepo 는 임시 뿌리 아래에 저장소 하나를 만든다. 추적되지 않은 파일 하나를
// 두므로 배지의 total 은 1 이다.
function makeRepo(prefix: string) {
  const dir = mkdtempSync(join(TMP, prefix));
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
  page.locator(`#repo-entries .ed-entry[data-git-repo="${cssPath(root)}"]`);

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
    // `edOpenWindow` 는 목록에 없던 경로면 종단을 지나므로 비동기다 — 값이
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
        const w = a.testing.edWindowFor(r);
        return w ? a.testing.gitPanelAt(a.testing.edRootOf(w), 0).repo : null;
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
    // FR-RTU-72: 그 경로의 Repo 창이 활성이 된다. 옛 `gitWindow()` 는 사라졌다
    // (FR-RTU-70) — 창의 신원은 **루트**다 (D-RTU-18).
    await page.waitForSelector('#area .ed-win .ed-side', { timeout: 15000 });
    expect(await page.evaluate(() => (window as any).app.gitPanel.repo)).toBe(root);
    const gid = await page.evaluate((r) => (window as any).app.testing.edWindowFor(r).id, root);
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
      app.testing.gitReposRefresh = async () => {};
      for (const e of (app.testing.gitRepos.pinned || [])) {
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
      return a.testing.save();
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

/**
 * UI 개정 — **GIT 섹션의 표식·높이·경계·정렬**
 * (FR-GIT-192~194·214·216·219·223 · D-FLW-6).
 *
 * 사이드바의 GIT 섹션이 이 파일의 주제다 — 이모지를 걷고 점으로 활성을 나타낸
 * 자리, 행 높이, 핀 드래그, 섹션 사이의 경계와 간격, 그리고 터미널의 cwd 가
 * `+ Add` 의 값이 되는 근거.
 *
 * `TEST-7` 로 `git-ui-revision` 에서 옮겨 왔다 — 납품 묶음("UI 개정")이 아니라
 * **이 기능**이 주제인 자리다. 단정은 옮기면서 바꾸지 않았다.
 */
const GURFX = tmpPath('dm-gur-sidebar-' + process.pid);
test.beforeAll(() => { gitFixture(GURFX) });
test.afterAll(() => { cleanGitFixture(GURFX) });
const gurFx = (n: string) => realPath(join(GURFX, n));
const gurCopy = makeCopyFx(GURFX);

// 포커스된 칸의 셸을 실제로 옮긴다 — `+ Add` 가 채우는 값의 출처가 셸의 cwd 다.
async function gurCdFocused(page: Page, dir: string) {
  const ta = page.locator('#area .pn.focused .xterm-helper-textarea');
  await ta.fill('cd ' + dir);
  await ta.press('Enter');
  await ta.fill('echo moved_ok');
  await ta.press('Enter');
  await expect(page.locator('#area .pn.focused .xterm-rows')).toContainText('moved_ok', { timeout: 15000 });
}

async function gurOpenChanges(page: Page, repo: string) {
  await openGit(page, repo);
  await page.evaluate(() => (window as any).app.gitPanel.openView('changes'));
  await expect(page.locator('#area .ed-side .git-view.git-changes')).toBeVisible({ timeout: 10000 });
}

const gurFiles = (page: Page) => page.locator('#area .ed-side .git-file');

const gurRepos = (page: Page) => page.locator('#repo-entries .ed-entry');

async function gurWaitFiles(page: Page, min = 1) {
  await expect.poll(() => gurFiles(page).count(), { timeout: 20000 }).toBeGreaterThanOrEqual(min);
}

test.describe('UI 개정 — 터미널의 리포를 딛는 근거 (D-FLW-6, 옛 FR-GIT-210)', () => {
  // follow 행은 사라졌지만(FR-FLW-1) 그것이 잡아낸 사실은 그대로다: 포커스가
  // 터미널을 떠나면 서버는 자기 cwd(=dongminal 저장소)로 답한다. 이제 그 값을
  // 딛는 것은 `+ Add` 이므로 계약도 그 자리로 옮긴다.
  test('V87 (D-FLW-6): Git 창을 보는 중에 연 + Add 가 마지막 터미널의 리포를 채운다', async ({ page }) => {
    const repo = gurFx('with-remote');
    await waitForInit(page);

    const ta = page.locator('#area .pn.focused .xterm-helper-textarea');
    await ta.fill('cd ' + repo);
    await ta.press('Enter');
    await ta.fill('echo moved_ok');
    await ta.press('Enter');
    await expect(page.locator('#area .pn.focused .xterm-rows')).toContainText('moved_ok', { timeout: 15000 });

    // Git 창으로 들어간다 — 포커스가 터미널을 떠난다.
    await openGit(page, repo);

    await page.click('#repo-add');
    const dlg = page.locator('#editor-add-dlg');
    await expect(dlg).toBeVisible({ timeout: 10000 });
    // dongminal 자신이 아니라 마지막 터미널의 리포다.
    await expect(dlg.locator('.eda-path')).toHaveValue(repo, { timeout: 15000 });
  });

  // FR-FLW-3 은 추적을 "포커스가 바뀔 때 값만 갱신한다" 로 규정한다. 그런데
  // 갱신 계기가 칸 포커스(공개 `setFocus`) 하나뿐이어서, 포커스가 실제로 옮겨
  // 가는 다른 통로 — 창 전환·탭 추가 — 가 기억을 낡은 채로 두었다. 낡은 기억이
  // 워크스페이스를 다시 읽는 계산보다 **먼저** 쓰였기 때문에, 사용자가 방금
  // 떠나온 자리가 아니라 마지막으로 **클릭한** 자리가 채워졌다.
  //
  // 아래 둘은 칸을 클릭해 기억을 심은 **뒤** 다른 자리로 옮긴다 — 그것이 이
  // 회귀의 조건이다.
  test('V87a (FR-FLW-3): 다른 창으로 옮겨간 뒤 연 + Add 가 그 창의 리포를 채운다', async ({ page }) => {
    const repoA = gurCopy('with-remote', 'flw3-a');
    const repoB = gurCopy('with-remote', 'flw3-b');
    await waitForInit(page);

    // 칸을 나누고 첫 칸을 **클릭한다** — 기억이 여기서 심긴다.
    await page.click('#split-h');
    await expect(page.locator('#area .pn')).toHaveCount(2, { timeout: 10000 });
    await page.locator('#area .pn').first().click();
    await expect(page.locator('#area .pn.focused')).toHaveCount(1);
    await gurCdFocused(page, repoA);

    // 새 창으로 옮겨간다 — 포커스는 새 창의 터미널로 가지만 칸 클릭은 없다.
    // (`waitForInit` 을 쓰지 않는다 — 그것은 page.goto 라 기억을 날린다.)
    await Promise.all([
      page.waitForResponse((r: any) => r.url().includes('/api/tools') && r.request().method() === 'POST'),
      page.click('#add-window'),
    ]);
    await expect(page.locator('#area .pn')).toHaveCount(1, { timeout: 10000 });
    await expect(page.locator('#area .pn.focused .xterm-helper-textarea')).toBeVisible({ timeout: 15000 });
    await gurCdFocused(page, repoB);

    await openGit(page, repoA);
    await page.click('#repo-add');
    const dlg = page.locator('#editor-add-dlg');
    await expect(dlg).toBeVisible({ timeout: 10000 });
    // 마지막으로 클릭한 칸(repoA)이 아니라 방금 떠나온 자리다.
    await expect(dlg.locator('.eda-path')).toHaveValue(repoB, { timeout: 15000 });
  });

  test('V87b (FR-FLW-3): 탭을 더한 뒤 연 + Add 가 그 탭의 리포를 채운다', async ({ page }) => {
    const repoA = gurCopy('with-remote', 'flw3-c');
    const repoB = gurCopy('with-remote', 'flw3-d');
    await waitForInit(page);

    await page.click('#split-h');
    await expect(page.locator('#area .pn')).toHaveCount(2, { timeout: 10000 });
    await page.locator('#area .pn').first().click();
    await expect(page.locator('#area .pn.focused')).toHaveCount(1);
    await gurCdFocused(page, repoA);

    // 같은 칸에 터미널 탭을 더한다. 칸 id 가 바뀌지 않으므로 칸 포커스 계기가
    // 돌지 않는다 — `addTab` 은 활성 탭만 옮긴다.
    await Promise.all([
      page.waitForResponse((r: any) => r.url().includes('/api/tools') && r.request().method() === 'POST'),
      page.evaluate(() => (window as any).app.addTab((window as any).app.focused)),
    ]);
    await expect(page.locator('#area .pn.focused .pn-tab')).toHaveCount(2, { timeout: 10000 });
    await gurCdFocused(page, repoB);

    await openGit(page, repoA);
    await page.click('#repo-add');
    const dlg = page.locator('#editor-add-dlg');
    await expect(dlg).toBeVisible({ timeout: 10000 });
    await expect(dlg.locator('.eda-path')).toHaveValue(repoB, { timeout: 15000 });
  });
});


test.describe('UI 개정 — GIT 행 높이 (FR-GIT-219)', () => {
  // **개정 (FR-SBT-3 · D-5).** "영역은 항목 수만큼만 자란다" 는 `max-height:40%` 와
  // 짝이던 규약이고, 둘 다 **세로 공존**의 산물이었다. 탭이 공존을 없앴으므로
  // GIT 목록은 이제 패널의 남은 높이를 쓴다 — 그 부분은 여기서 검증하지 않는다
  // (V-SBT-2 가 `git-sidebar` S7 에서 반대 방향으로 고정한다).
  //
  // 남는 계약은 행 높이 하나다: GIT 행과 WINDOWS 행이 같아야 한다 (FR-GIT-219).
  // 두 목록은 이제 동시에 보이지 않으므로 각각 탭을 열어 잰다.
  test('V96 (FR-GIT-219): GIT 행이 WINDOWS 행과 같은 높이다', async ({ page }) => {
    await waitForInit(page);
    await page.evaluate(async (p) => {
      await (window as any).app.testing.gitPin(p);
    }, gurFx('basic'));
    await expect.poll(() => gurRepos(page).count(), { timeout: 20000 }).toBeGreaterThanOrEqual(1);

    const si = await page.evaluate(() => {
      const el = document.querySelector('#windows .si') as HTMLElement | null;
      return el ? Math.round(el.getBoundingClientRect().height) : -1;
    });
    await openGitTab(page);
    const m = await page.evaluate(() => {
      const g = document.getElementById('repo-entries')!;
      const row = g.querySelector('.ed-entry') as HTMLElement;
      return { row: Math.round(row.getBoundingClientRect().height) };
    });
    expect(si, 'WINDOWS 행이 없다').toBeGreaterThan(0);
    expect(m.row, 'GIT 행이 WINDOWS 행과 다른 높이다').toBe(si);
  });
});

// FR-GIT-223: 핀 재배치. WINDOWS 목록·활동 카드와 **같은 native DnD** 경로다 —
// 하나의 DataTransfer 를 공유하는 합성 이벤트로 그 경로를 그대로 지난다.
async function dragPin(page: Page, src: string, dst: string, before = true) {
  await page.evaluate(({ s, d, b }) => {
    const dt = new DataTransfer();
    const from = document.querySelector(`#repo-entries .ed-entry[data-git-repo="${String(s).replace(/\\/g, '\\\\')}"]`)!;
    const to = document.querySelector(`#repo-entries .ed-entry[data-git-repo="${String(d).replace(/\\/g, '\\\\')}"]`)!;
    const r = to.getBoundingClientRect();
    // 경계에서 2px 만 들어오면 행 높이가 다른 OS 에서 반대쪽 절반으로 반올림될
    // 수 있다(러너 실측: 드래그가 커밋되지 않았다) — 각 절반의 한가운데를 겨냥한다.
    const y = b ? r.top + r.height * 0.25 : r.top + r.height * 0.75;
    from.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
    to.dispatchEvent(new DragEvent('dragover', { bubbles: true, dataTransfer: dt, clientY: y }));
    to.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: dt, clientY: y }));
    from.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
  }, { s: src, d: dst, b: before });
}

const pinOrder = (page: Page) =>
  page.evaluate(() => [...document.querySelectorAll('#repo-entries .ed-entry')]
    .filter((e) => !e.classList.contains('follow'))
    .map((e) => (e as HTMLElement).dataset.gitRepo));


test.describe('UI 개정 — 핀 드래그 정렬 (FR-GIT-223)', () => {
  test('V100 (FR-GIT-223): 핀을 끌어 순서를 바꾸고 새로고침 후에도 남는다', async ({ page }) => {
    const a = gurFx('basic'), b = gurFx('with-remote'), c = gurFx('stashes');
    await waitForInit(page);
    // 핀은 서버가 권위다 (O1) — 다시 거는 것이 안전하며 이미 있으면 목록이
    // 그대로다. 셋이 다 설 때까지 되풀이하는 이유는, 핀에 딸린 목록 연동이
    // 워크스페이스 저장을 타고 그 저장이 겹치면 밀릴 수 있기 때문이다
    // (실측: 세 개를 걸었는데 둘만 섰다).
    //
    // 드래그는 행의 사각형을 읽는다 — 숨은 패널의 사각형은 0 이다 (FR-SBT-2).
    // 핀은 서버가 권위이고(O1) 그 목록은 워크스페이스에 산다. 셋을 연속으로 거는
    // 동안 저장이 겹치면 앞의 것이 밀려날 수 있다 — 실측에서 `basic` 이 빠졌다.
    //
    // **빠진 것만 덧붙이면 안 된다**: 다시 건 핀은 목록 맨 뒤로 가므로 순서가
    // 뒤집힌다(실측: `[with-remote, stashes, basic]`). 어긋났으면 전부 지우고
    // 순서대로 다시 건다 — 이 시험이 재려는 것이 **순서**이기 때문이다.
    const pin = (p: string) =>
      page.evaluate(async (x) => { await (window as any).app.testing.gitPin(x) }, p);
    const unpin = (p: string) =>
      page.evaluate(async (x) => { await (window as any).app.testing.gitUnpin(x) }, p);
    await expect(async () => {
      const cur = await pinOrder(page);
      const ok = cur.length === 3 && cur[0] === a && cur[1] === b && cur[2] === c;
      if (!ok) {
        for (const p of cur) await unpin(p);
        for (const p of [a, b, c]) await pin(p);
      }
      await openGitTab(page);
      expect(await pinOrder(page)).toEqual([a, b, c]);
    }).toPass({ timeout: 25000 });

    // 마지막을 맨 앞으로.
    await dragPin(page, c, a, true);
    await expect.poll(() => pinOrder(page), { timeout: 15000 }).toEqual([c, a, b]);

    // **항목 영역을 벗어난 release 도 커밋된다.** 창 목록이 이미 그렇게 한다 —
    // 문서 전역이 drop 을 받고 마지막 dragover 가 기록한 대상으로 커밋한다.
    await page.evaluate(({ s, d }) => {
      const dt = new DataTransfer();
      const from = document.querySelector(`#repo-entries .ed-entry[data-git-repo="${String(s).replace(/\\/g, '\\\\')}"]`)!;
      const to = document.querySelector(`#repo-entries .ed-entry[data-git-repo="${String(d).replace(/\\/g, '\\\\')}"]`)!;
      const r = to.getBoundingClientRect();
      from.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
      to.dispatchEvent(new DragEvent('dragover',
        { bubbles: true, dataTransfer: dt, clientY: r.top + r.height * 0.75 }));
      // 목록 밖(본문)에서 손을 뗀다.
      document.getElementById('area')!
        .dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: dt, clientY: 5 }));
      from.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
    }, { s: c, d: a });
    await expect.poll(() => pinOrder(page), { timeout: 15000 }).toEqual([a, c, b]);

    // 서버가 권위로 쓴다 (O1) — 새로고침해도 남는다.
    await page.reload();
    // **터미널을 기다리지 않는다.** 새로고침 뒤 활성 창은 Repo 창일 수 있고
    // (D-RTU-18: 신원이 루트다) 그 창에는 포커스된 터미널 칸이 없다 (FR-EDT-55).
    // 이 시험이 기다려야 하는 것은 사이드바 목록이 서는 것뿐이다.
    await openGitTab(page);
    await expect.poll(() => pinOrder(page), { timeout: 20000 }).toEqual([a, c, b]);
  });

  test('V100 (FR-GIT-223): follow 항목은 끌 수 없다', async ({ page }) => {
    await waitForInit(page);
    await page.evaluate(async (x) => { await (window as any).app.testing.gitPin(x) }, gurFx('basic'));
    await openGitTab(page);
    await expect.poll(() => gurRepos(page).count(), { timeout: 20000 }).toBeGreaterThanOrEqual(1);

    const follow = page.locator('#repo-entries .ed-entry.follow');
    if (await follow.count()) {
      // 핀이 아니고 늘 최상단 1줄이다 (FR-GIT-193).
      await expect(follow).not.toHaveAttribute('draggable', 'true');
    }
    // 핀 항목은 끌 수 있다.
    await expect(page.locator('#repo-entries .ed-entry:not(.follow)').first())
      .toHaveAttribute('draggable', 'true');
  });
});


// FR-GIT-216: 섹션 경계의 굵기 하한. 색은 테스트가 정하지 않는다 — 테마에서
// 파생하므로 "행 구분선과 다른가" 로만 판정한다.
const SEC_BORDER_W = 2;

// 경계선을 읽는다. **조회와 계산을 한 번의 evaluate 안에서** 한다 — 1초 폴링이
// 목록을 다시 그리므로 밖에서 잡은 요소는 계산 시점에 떨어져 나갈 수 있고,
// 떨어진 요소의 getComputedStyle 은 빈 값을 준다.
const edges = (page: Page, sel: string, side: 'top' | 'bottom') =>
  page.evaluate(([q, s]) => {
    return [...document.querySelectorAll(q)].map((el) => {
      const c = getComputedStyle(el);
      return {
        w: parseFloat(c.getPropertyValue(`border-${s}-width`)) || 0,
        color: c.getPropertyValue(`border-${s}-color`),
      };
    });
  }, [sel, side] as const);

const rootVar = (page: Page, name: string) =>
  page.evaluate((n) => getComputedStyle(document.documentElement)
    .getPropertyValue(n).trim(), name);

test.describe('UI 개정 — 섹션 경계 (FR-GIT-216)', () => {
  test('V93 (FR-GIT-216): 섹션 경계가 행 구분선과 다른 굵기·색으로 그려진다', async ({ page }) => {
    await waitForInit(page);
    await page.evaluate(async (p) => {
      await (window as any).app.testing.gitPin(p);
    }, gurFx('basic'));
    await gurOpenChanges(page, gurFx('basic'));
    await gurWaitFiles(page, 3);

    // 진한 색은 팔레트에서 빌리지 않고 border 를 text 쪽으로 섞어 만든다.
    const strong = await rootVar(page, '--border-strong');
    const plain = await rootVar(page, '--border');
    expect(strong, '--border-strong 이 없다').toBeTruthy();
    expect(strong.toLowerCase(), '섹션 색이 행 구분선과 같다').not.toBe(plain.toLowerCase());

    // ① Changes 그룹 — **처음 보이는** 그룹 위에는 없고, 그다음부터 경계를 갖는다.
    // 충돌이 없으면 `Conflicts` 는 서지 않으므로 세는 대상에서 뺀다.
    // 제품은 `.gone` 을 `[hidden]` 으로 옮겼다 (FR-LAY-3·30) — 숨김의 어휘는 하나다.
    const SEL_GROUP = '#area .ed-side .git-group:not([hidden])';
    await expect.poll(async () => (await edges(page, SEL_GROUP, 'top')).length,
      { timeout: 15000 }).toBeGreaterThanOrEqual(2);
    const groups = await edges(page, SEL_GROUP, 'top');
    expect(groups[0].w, '첫 그룹 위에 선이 있다').toBe(0);
    expect(groups[1].w).toBeGreaterThanOrEqual(SEC_BORDER_W);

    // 같은 화면의 행과 달라야 한다 — 굵기든 색이든.
    const rowLine = (await edges(page, '#area .ed-side .git-file', 'top'))[0];
    expect(groups[1].w + '/' + groups[1].color, '섹션 경계가 행과 구별되지 않는다')
      .not.toBe(rowLine.w + '/' + rowLine.color);

    // ② 사이드바의 WINDOWS ↔ GIT 경계는 **대상이 사라졌다** (FR-SBT-1·§3.9.1).
    // 두 목록이 세로로 쌓여 있지 않으므로 그을 경계가 없고, `.git-sec-title` 자체가
    // 없어졌다. 가르는 일은 탭 바가 한다 — 그것은 섹션 경계가 아니라 컨트롤이므로
    // FR-GIT-216 의 대상이 아니다. (follow ↔ 핀 경계도 FR-FLW-1 로 이미 사라졌다.)

    // ③ 테마를 바꾸면 따라 바뀐다 — 색을 하드코딩하지 않았다는 증거다.
    const before = groups[1].color;
    await page.evaluate<string>(
      '(function(){' +
      "var cur=getComputedStyle(document.documentElement).getPropertyValue('--border').trim().toLowerCase();" +
      'var n=Object.keys(THEMES).find(function(k){' +
      'return THEMES[k].ui.border.toLowerCase()!==cur});' +
      'customTheme=null;currentThemeName=n;applyThemeObj(THEMES[n]);return n})()');
    await expect.poll(async () =>
      (await edges(page, '#area .ed-side .git-group', 'top'))[1].color,
      { timeout: 10000 }).not.toBe(before);
  });

  test('V93 (FR-GIT-216): Branches 그룹과 refs 그룹도 같은 경계를 갖는다', async ({ page }) => {
    await waitForInit(page);
    await openGit(page, gurFx('with-remote'));

    // Branches — 로컬·원격·태그 그룹.
    await clickGitView(page, 'branches');
    await expect.poll(async () => (await edges(page, '#area .pn-body .git-br-group', 'top')).length,
      { timeout: 20000 }).toBeGreaterThanOrEqual(2);
    const br = await edges(page, '#area .pn-body .git-br-group', 'top');
    expect(br[0].w, '첫 그룹 위에 선이 있다').toBe(0);
    expect(br[1].w).toBeGreaterThanOrEqual(SEC_BORDER_W);
    // 접두사 묶음은 섹션이 아니다 — 있어도 경계를 갖지 않는다.
    const pfx = await edges(page, '#area .pn-body .git-br-pfx', 'top');
    expect(pfx.filter((p) => p.w >= SEC_BORDER_W), '접두사 묶음이 섹션처럼 그려졌다').toEqual([]);

    // History refs — 로컬·원격·태그 그룹.
    await clickGitView(page, 'history');
    await expect.poll(async () => (await edges(page, '#area .pn-body .git-refs-group', 'top')).length,
      { timeout: 20000 }).toBeGreaterThanOrEqual(2);
    const rf = await edges(page, '#area .pn-body .git-refs-group', 'top');
    expect(rf[0].w, '첫 refs 그룹 위에 선이 있다').toBe(0);
    expect(rf[1].w).toBeGreaterThanOrEqual(SEC_BORDER_W);
  });
});

// FR-GIT-214 의 간격 하한. 값은 여기 한 곳에만 둔다.
//
// **UX_REVISION_SRS FR-BLP-8 로 배치가 바뀌었다.** `+ Add` 가 목록 **위**로
// 올라가 WINDOWS 패널과 같은 골격이 되었고(FR-BLP-5), 그러면서 옛 FR-GIT-214 가
// 막으려던 상황("목록 → + Add → ⚙ 이 한 덩이로 읽힌다")이 사라졌다 — 그 조항
// 자신이 "WINDOWS 는 버튼이 목록 위라 이 문제가 없다" 고 적어 두었다.
//
// 그래서 재는 대상이 바뀐다: 이제 확인할 것은 **버튼 행과 목록이 붙지 않는가**,
// 그리고 **두 패널의 골격이 같은가** 다.
const MIN_GAP_ACTIONS_LIST = 4;

// 한 패널의 "버튼 행 → 목록" 간격. 숨은 패널은 사각형이 전부 0 이므로
// (FR-SBT-2) **보이는 탭에서만** 잰다 — 두 패널을 한 번에 비교할 수 없다.
// 버튼 행 전체를 기준으로 잡는 이유는 WINDOWS 가 버튼이 둘이기 때문이다.
const panelGap = (page: Page, panelId: string, listId: string) =>
  page.evaluate(([p, l]) => {
    // FR-RTU-1: 패널 id 는 `sb-panel-repo`, 목록 id 는 `repo-entries` 다.
    const bar = document.querySelector('#' + p + ' .sb-actions')!.getBoundingClientRect();
    const list = document.getElementById(l)!.getBoundingClientRect();
    return list.top - bar.bottom;
  }, [panelId, listId]);


test.describe('UI 개정 — GIT 섹션의 간격 (FR-GIT-214 → FR-BLP-5·8)', () => {
  test('V91 개정: + Add 가 목록 위에 서고 둘이 붙지 않는다', async ({ page }) => {
    await waitForInit(page);
    await page.evaluate(async (p) => {
      await (window as any).app.testing.gitPin(p);
    }, gurFx('basic'));
    await expect.poll(() => gurRepos(page).count(), { timeout: 20000 }).toBeGreaterThanOrEqual(1);
    // 간격은 요소 사각형 사이의 빈 거리다 — 숨은 패널에서는 잴 수 없다 (FR-SBT-2).
    await openGitTab(page);

    const gitGap = await panelGap(page, 'sb-panel-repo', 'repo-entries');
    expect(gitGap, '+ Add 와 목록이 붙어 있다').toBeGreaterThanOrEqual(MIN_GAP_ACTIONS_LIST);
    // FR-BLP-5: 두 패널의 골격이 같다 — 같은 자리의 같은 간격이어야 "구조가
    // 같다" 가 눈으로도 성립한다. 숨은 패널은 잴 수 없으므로 탭을 옮겨 잰다.
    await page.locator('.sb-tab[data-panel="windows"]').click();
    const winGap = await panelGap(page, 'sb-panel-windows', 'windows');
    expect(Math.abs(gitGap - winGap), 'WINDOWS 패널과 간격이 다르다').toBeLessThanOrEqual(1);
  });

  test('V91 개정: 모바일 폭에서도 같다', async ({ page }) => {
    await waitForInit(page);
    await page.setViewportSize({ width: 420, height: 800 });
    // 폭 변경은 `resize` 핸들러가 동기로 받는다 — 그림이 한 바퀴 돌면 반영이
    // 끝난다. (`body.mobile` 을 신호로 삼지 않는다: 모바일 판정의 기준폭은
    // per-tab 설정이라 420 이 반드시 그 아래라는 보장이 없다.)
    await nextFrames(page);
    // 모바일은 드로어다 — 열어야 사이드바가 화면에 선다.
    await page.evaluate(() => (window as any).app.openDrawer && (window as any).app.openDrawer());
    // 사이드바가 실제로 서는 것은 아래 `openGitTab` 이 확인한다.
    await openGitTab(page);

    expect(await panelGap(page, 'sb-panel-repo', 'repo-entries')).toBeGreaterThanOrEqual(MIN_GAP_ACTIONS_LIST);
  });
});


test.describe('UI 개정 — GIT 섹션 표식 (FR-GIT-192~194)', () => {
  test('V79 (FR-GIT-192): 이모지가 없고 점이 활성 리포를 나타낸다', async ({ page }) => {
    await waitForInit(page);
    await page.evaluate(async (p) => {
      await (window as any).app.testing.gitPin(p);
    }, gurFx('basic'));
    await page.evaluate(async (p) => {
      await (window as any).app.testing.gitPin(p);
    }, gurFx('with-remote'));
    await openGit(page, gurFx('basic'));
    await expect.poll(() => page.locator('#repo-entries .ed-entry').count(),
      { timeout: 20000 }).toBe(2);

    // 이모지를 쓰지 않는다.
    const text = await page.evaluate(() => document.getElementById('repo-entries')!.textContent || '');
    expect(text).not.toContain('📌');
    expect(text).not.toContain('⟳');

    // 표식은 WINDOWS 의 점과 같은 어휘다 — 활성 리포만 accent 로 채운다.
    const dots = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('#repo-entries .ed-entry')] as HTMLElement[];
      return rows.map(r => {
        const d = r.querySelector('.ed-entry-dot') as HTMLElement | null;
        return {
          repo: (r.dataset.gitRepo || '').split(/[\\/]/).pop(),
          active: r.classList.contains('active'),
          hasDot: !!d,
          bg: d ? getComputedStyle(d).backgroundColor : null,
        };
      });
    });
    const active = dots.find(d => d.active)!;
    const idle = dots.find(d => !d.active)!;
    expect(active.hasDot).toBe(true);
    expect(idle.hasDot).toBe(true);
    expect(active.bg).not.toBe(idle.bg);
  });
});


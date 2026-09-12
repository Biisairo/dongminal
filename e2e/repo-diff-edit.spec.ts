import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import { APIRequestContext, Page } from '@playwright/test';

import { test, expect, rmTree, switchToEditorRoot } from './fixtures';
import { TMP, realPath, cssPath } from './osenv';

// REPO_TAB_UNIFY_SRS §4 — diff 편집의 검증 V-RTU-50~56.
//
// 판정 기준은 하나다 — **오른쪽이 디스크의 파일인가.** 그렇다면 고치고 저장할 수
// 있고(편집기 탭과 같은 경로), 아니라면 되돌려 쓸 자리가 없다.

let BASE = '';
let REPO = '';

const j = (...p: string[]) => path.join(...p);
const w = (p: string, s: string) => fs.writeFileSync(p, s);
const git = (d: string, ...a: string[]) =>
  execFileSync('git', ['-C', d, ...a], { stdio: 'ignore' });

function makeRepo(base: string) {
  const d = j(base, 'repo');
  fs.mkdirSync(d, { recursive: true });
  git(d, 'init', '-q', '-b', 'main', '.');
  git(d, 'config', 'user.name', 'Fixture');
  git(d, 'config', 'user.email', 'fixture@example.invalid');
  git(d, 'config', 'commit.gpgsign', 'false');
  w(j(d, 'mod.txt'), 'one\n');
  w(j(d, 'staged.txt'), 'one\n');
  git(d, 'add', '-A');
  git(d, 'commit', '-qm', 'init');
  // unstaged — 오른쪽이 워킹 트리 파일이다 (편집 가능)
  fs.appendFileSync(j(d, 'mod.txt'), 'two\n');
  // staged — 오른쪽이 index 다 (읽기 전용)
  fs.appendFileSync(j(d, 'staged.txt'), 'staged\n');
  git(d, 'add', 'staged.txt');
  // untracked — diff 가 아니라 편집기로 열린다
  w(j(d, 'fresh.txt'), 'brand new\n');
  return realPath(d);
}

test.beforeAll(() => {
  BASE = realPath(fs.mkdtempSync(j(TMP, 'dm-rde-')));
  REPO = makeRepo(BASE);
});
test.afterAll(() => {
  rmTree(BASE);
});

async function enter(page: Page, request: APIRequestContext, root: string) {
  const r = await request.post('/api/editors/add', { data: { path: root } });
  expect(r.ok()).toBeTruthy();
  await page.context().addInitScript(() => { sessionStorage.setItem('displayMode', 'desktop') });
  await page.goto('/');
  await page.waitForSelector('#area .pn.focused .xterm-helper-textarea', { timeout: 15000 });
  await page.waitForFunction(
    () => !!(window as any).app?.testing.editors && (window as any).app.testing.edWindows().length > 0,
    undefined, { timeout: 15000 });
  await switchToEditorRoot(page, root);
  await page.waitForSelector('#area .ed-win .ed-side', { timeout: 10000 });
  // Changes 사이드로 옮겨 변경 목록을 띄운다.
  await page.locator('.ed-side-tab[data-side="changes"]').click();
  await expect(page.locator('#area .ed-side .git-view.git-changes'))
    .toBeVisible({ timeout: 10000 });
}

// constants-git.js 의 전역 — <script> 로 로드되므로 import 대상이 아니다.
declare const GIT_AXIS_READONLY_WHY: Record<string, string>;
declare const GIT_AXIS: Record<string, string>;

const row = (page: Page, group: string, p: string) =>
  page.locator(`#area .ed-side .git-group[data-group="${group}"] .git-file[data-path="${cssPath(p)}"]`);
const diffTab = (page: Page) => page.locator('#area .ed-area .pn-tab[data-git-view="diff"]');
const modified = (page: Page) =>
  page.locator('#area .ed-area .git-diff .monaco-diff-editor .editor.modified');

test.describe('묶음 D — diff 편집 (FR-RTU-50~56)', () => {
  test('D1 (V-RTU-50·54): unstaged 는 오른쪽이 편집 가능하다', async ({ page, request }) => {
    await enter(page, request, REPO);
    await row(page, 'working', 'mod.txt').click();
    await expect(diffTab(page)).toHaveCount(1, { timeout: 10000 });
    await expect(modified(page)).toBeVisible({ timeout: 20000 });

    const ro = await page.evaluate(() => {
      const p = (window as any).app.gitPanel;
      return { editable: !!p._diffView?._editable, target: p._diffView?._editTarget || '' };
    });
    expect(ro.editable).toBe(true);
    // 저장 대상은 **디스크의 그 파일**이다 — 편집기 탭이 여는 것과 같은 경로다.
    expect(ro.target).toBe(j(REPO, 'mod.txt'));
  });

  test('D2 (V-RTU-51): staged 는 읽기 전용이고 사유가 있다', async ({ page, request }) => {
    await enter(page, request, REPO);
    await row(page, 'staged', 'staged.txt').click();
    await expect(diffTab(page)).toHaveCount(1, { timeout: 10000 });
    await expect(modified(page)).toBeVisible({ timeout: 20000 });

    const st = await page.evaluate(() => {
      const p = (window as any).app.gitPanel;
      return {
        editable: !!p._diffView?._editable,
        why: GIT_AXIS_READONLY_WHY[GIT_AXIS.STAGED] || '',
      };
    });
    expect(st.editable).toBe(false);
    // 사유가 준비돼 있다 — 조용히 무시하면 "타이핑이 먹지 않는다" 가 된다.
    expect(st.why).toContain('스냅샷');
  });

  test('D3 (V-RTU-52·53·55): 고치고 저장하면 파일이 바뀌고 목록이 따라온다',
    async ({ page, request }) => {
      await enter(page, request, REPO);
      await row(page, 'working', 'mod.txt').click();
      await expect(modified(page)).toBeVisible({ timeout: 20000 });

      // 오른쪽 모델을 고친다 — 타이핑과 같은 경로(onDidChangeContent)를 지난다.
      await page.evaluate(() => {
        const v = (window as any).app.gitPanel._diffView;
        v._mod.setValue('one\ntwo\nedited-in-diff\n');
      });
      // FR-RTU-53: 저장되지 않은 변경이 탭 이름에 선다.
      await expect(diffTab(page)).toContainText('●', { timeout: 10000 });

      await page.evaluate(() => (window as any).app.gitPanel._diffView.save());
      await expect(diffTab(page)).not.toContainText('●', { timeout: 10000 });

      // 디스크가 실제로 바뀌었다.
      await expect.poll(() => fs.readFileSync(j(REPO, 'mod.txt'), 'utf8'), { timeout: 10000 })
        .toContain('edited-in-diff');
    });

  test('D4 (V-RTU-56): 편집 중에는 폴링이 내용을 덮지 않는다', async ({ page, request }) => {
    await enter(page, request, REPO);
    await row(page, 'working', 'mod.txt').click();
    await expect(modified(page)).toBeVisible({ timeout: 20000 });

    await page.evaluate(() => {
      const v = (window as any).app.gitPanel._diffView;
      v._mod.setValue('편집 중인 내용\n');
    });
    // **예외 (`TEST-16`)**: 관측 주기(1초)를 여러 번 넘긴다 — 덮였다면 이 사이에
    // 사라지므로, 그 창이 곧 검사다.
    await page.waitForTimeout(3000);
    const kept = await page.evaluate(() =>
      (window as any).app.gitPanel._diffView._mod.getValue());
    expect(kept).toBe('편집 중인 내용\n');
  });

  /**
   * D5 — FR-RTU-51 (개정, 사용자 지시 2026-09-08 "vsc 의 패턴을 똑같이").
   *
   * 가르는 것은 그룹이 아니라 **비교의 왼쪽이 실재하는가**다. 새 파일은 index 에
   * 그 경로가 없으므로 편집기이고, 스테이지한 뒤 다시 고치면 index↔worktree 의
   * 양쪽이 생겨 diff 가 된다. 다시 스테이지하면 왼쪽이 또 사라져 편집기다.
   */
  test('D5 (V-RTU-52): 왼쪽이 없는 행은 편집기, 생기면 diff — 그리고 다시 없어지면 편집기',
    async ({ page, request }) => {
      // **이름을 매번 새로 만든다.** 워크스페이스는 시험 사이에 남는다.
      const name = 'fresh-' + Date.now() + '.txt';
      w(j(REPO, name), 'brand new\n');
      await enter(page, request, REPO);

      // ① 새 파일 — index 에 없다. 편집기 탭이며 미리보기다 (FR-RTU-40·41).
      await row(page, 'working', name).click();
      const tab = page.locator('#area .ed-area .pn-tab', { hasText: name });
      await expect(tab).toHaveCount(1, { timeout: 10000 });
      await expect(tab).not.toHaveAttribute('data-git-view', /.*/);
      await expect(diffTab(page)).toHaveCount(0);
      await expect(tab).toHaveClass(/pn-tab-preview/);

      // ② 스테이지한 뒤 고친다 — index↔worktree 의 양쪽이 생겼다.
      //
      // **행이 보이는 것으로는 부족하다.** ⑦ 이후 그 파일은 상태가 바뀌어도 같은
      // 워킹 그룹에 그대로 있으므로(FR-CMG-1), 행의 존재는 아직 새 파일일 때도
      // 참이다. 상태 문자가 `?`→`M` 으로 바뀐 것을 기다린다 — 그것이 index 에
      // 왼쪽이 생겼다는 유일한 증거다 (FR-CMG-3).
      git(REPO, 'add', name);
      w(j(REPO, name), 'brand new\nsecond line\n');
      await expect(row(page, 'working', name).locator('.git-file-st'))
        .toHaveText('M', { timeout: 20000 });
      await row(page, 'working', name).click();
      await expect(diffTab(page)).toHaveCount(1, { timeout: 15000 });
      await expect(page.locator('#area .monaco-diff-editor'))
        .toContainText('second line', { timeout: 20000 });

      // ③ 같은 파일의 staged 행은 HEAD 에 왼쪽이 없다 (`A`) — 편집기다.
      await expect(row(page, 'staged', name).locator('.git-file-st'))
        .toHaveText('A', { timeout: 20000 });
      await row(page, 'staged', name).click();
      await expect(page.locator('#area .ed-area .pn-tab', { hasText: name }))
        .toHaveCount(1, { timeout: 15000 });
    });
});

/**
 * 묶음 E — 닫을 때의 확인 (FR-RTU-103, 사용자 보고 U-10).
 *
 * `FR-RTU-33` 은 git 뷰 탭을 "확인 없이" 닫게 했고 그 근거가 **"잃는 편집이
 * 없다"** 였다. 그 전제는 `FR-RTU-50~53` 이 diff 편집을 들이면서 깨졌다 —
 * `FR-RTU-53` 이 저장되지 않은 변경을 탭에 `●` 로 세우는 것 자체가 잃을 것이
 * 있다는 증거다. 두 요구가 모순인 채로 남아 있었고, **그 사이를 아무 테스트도
 * 보지 않았다.**
 */
test.describe('묶음 E — 닫을 때의 확인 (FR-RTU-103)', () => {
  test('E1 (V-RTU-103): 편집한 diff 탭을 닫으면 확인을 지난다 — 취소하면 편집이 남는다',
    async ({ page, request }) => {
      await enter(page, request, REPO);
      await row(page, 'working', 'mod.txt').click();
      await expect(modified(page)).toBeVisible({ timeout: 20000 });

      await page.evaluate(() => {
        const v = (window as any).app.gitPanel._diffView;
        v._mod.setValue('one\ntwo\nabout-to-be-lost\n');
      });
      await expect(diffTab(page)).toContainText('●', { timeout: 10000 });

      // 탭의 닫기(×)를 누른다 — 사용자가 실제로 지나는 길이다.
      await diffTab(page).locator('.pn-tab-x').click();

      // 확인이 뜬다. 종전에는 이 창이 없어 편집이 조용히 사라졌다.
      const ov = page.locator('.confirm-overlay');
      await expect(ov).toBeVisible({ timeout: 10000 });
      await expect(ov.locator('.confirm-msg'))
        .toHaveText('저장되지 않은 변경사항이 있습니다.');
      await expect(ov.locator('.confirm-save')).toHaveText('저장 후 닫기');

      // 취소 — 탭도 편집도 그대로여야 한다.
      await ov.locator('.confirm-cancel').click();
      await expect(ov).toHaveCount(0, { timeout: 10000 });
      await expect(diffTab(page)).toHaveCount(1);
      await expect(diffTab(page)).toContainText('●');

      // **뷰가 살아 있다.** 확인이 `dropView` 뒤에 서면 이 값이 사라진다 —
      // 취소를 눌러도 편집이 돌아오지 않는 것이 그 결함이었다.
      const kept = await page.evaluate(() =>
        (window as any).app.gitPanel._diffView?._mod?.getValue() || '');
      expect(kept).toContain('about-to-be-lost');

      // 디스크는 아직 그대로다 — 취소는 저장이 아니다.
      expect(fs.readFileSync(j(REPO, 'mod.txt'), 'utf8')).not.toContain('about-to-be-lost');
    });

  test('E2 (V-RTU-103): "저장 후 닫기" 는 저장하고 닫는다', async ({ page, request }) => {
    await enter(page, request, REPO);
    await row(page, 'working', 'mod.txt').click();
    await expect(modified(page)).toBeVisible({ timeout: 20000 });

    const mark = 'saved-on-close-' + Date.now();
    await page.evaluate((m) => {
      const v = (window as any).app.gitPanel._diffView;
      v._mod.setValue('one\ntwo\n' + m + '\n');
    }, mark);
    await expect(diffTab(page)).toContainText('●', { timeout: 10000 });

    await diffTab(page).locator('.pn-tab-x').click();
    const ov = page.locator('.confirm-overlay');
    await expect(ov).toBeVisible({ timeout: 10000 });
    await ov.locator('.confirm-save').click();

    // 탭이 닫히고 디스크에 남는다.
    await expect(diffTab(page)).toHaveCount(0, { timeout: 10000 });
    await expect.poll(() => fs.readFileSync(j(REPO, 'mod.txt'), 'utf8'), { timeout: 10000 })
      .toContain(mark);
  });

  test('E3 (V-RTU-103): 편집이 없으면 확인 없이 닫힌다 — FR-RTU-33 은 그대로다',
    async ({ page, request }) => {
      await enter(page, request, REPO);
      await row(page, 'working', 'mod.txt').click();
      await expect(modified(page)).toBeVisible({ timeout: 20000 });
      await expect(diffTab(page)).not.toContainText('●');

      await diffTab(page).locator('.pn-tab-x').click();
      // 확인이 뜨지 않고 바로 닫힌다 — 잃을 것이 없을 때의 규약은 유지된다.
      await expect(diffTab(page)).toHaveCount(0, { timeout: 10000 });
      await expect(page.locator('.confirm-overlay')).toHaveCount(0);
    });
});

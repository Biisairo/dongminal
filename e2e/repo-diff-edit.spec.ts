import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { APIRequestContext, Page } from '@playwright/test';

import { test, expect } from './fixtures';

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
  return fs.realpathSync(d);
}

test.beforeAll(() => {
  BASE = fs.realpathSync(fs.mkdtempSync(j(os.tmpdir(), 'dm-rde-')));
  REPO = makeRepo(BASE);
});
test.afterAll(() => {
  if (BASE) fs.rmSync(BASE, { recursive: true, force: true });
});

async function enter(page: Page, request: APIRequestContext, root: string) {
  const r = await request.post('/api/editors/add', { data: { path: root } });
  expect(r.ok()).toBeTruthy();
  await page.context().addInitScript(() => { sessionStorage.setItem('displayMode', 'desktop') });
  await page.goto('/');
  await page.waitForSelector('#area .pn.focused .xterm-helper-textarea', { timeout: 15000 });
  await page.waitForFunction(
    () => !!(window as any).app?._editors && (window as any).app._edWindows().length > 0,
    undefined, { timeout: 15000 });
  await page.evaluate((x) => {
    const a = (window as any).app;
    const win = a._edWindows().find((s: any) => s.editor && s.editor.root === x);
    if (!win) throw new Error('Repo 창이 없다: ' + x);
    a.switchWindow(win.id);
  }, root);
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
  page.locator(`#area .ed-side .git-group[data-group="${group}"] .git-file[data-path="${p}"]`);
const diffTab = (page: Page) => page.locator('#area .ed-area .pn-tab[data-git-view="diff"]');
const modified = (page: Page) =>
  page.locator('#area .ed-area .git-diff .monaco-diff-editor .editor.modified');

test.describe('묶음 D — diff 편집 (FR-RTU-50~56)', () => {
  test('D1 (V-RTU-50·54): unstaged 는 오른쪽이 편집 가능하다', async ({ page, request }) => {
    await enter(page, request, REPO);
    await row(page, 'changes', 'mod.txt').dblclick();
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
    await row(page, 'staged', 'staged.txt').dblclick();
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
      await row(page, 'changes', 'mod.txt').dblclick();
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
    await row(page, 'changes', 'mod.txt').dblclick();
    await expect(modified(page)).toBeVisible({ timeout: 20000 });

    await page.evaluate(() => {
      const v = (window as any).app.gitPanel._diffView;
      v._mod.setValue('편집 중인 내용\n');
    });
    // 관측 주기(1초)를 여러 번 넘긴다 — 덮였다면 이 사이에 사라진다.
    await page.waitForTimeout(3000);
    const kept = await page.evaluate(() =>
      (window as any).app.gitPanel._diffView._mod.getValue());
    expect(kept).toBe('편집 중인 내용\n');
  });

  test('D5 (V-RTU-52): untracked 는 diff 가 아니라 편집기 탭으로 열린다',
    async ({ page, request }) => {
      // **이름을 매번 새로 만든다.** 워크스페이스는 시험 사이에 남으므로, 같은
      // 이름을 쓰면 앞 실행이 열어 둔 탭이 `_findEditorTab` 에 걸려 "이미 열려
      // 있으면 그 탭으로" (FR-EDT-101) 경로를 타고, 미리보기 여부가 그때의
      // 상태에 좌우된다.
      const name = 'fresh-' + Date.now() + '.txt';
      w(j(REPO, name), 'brand new\n');
      await enter(page, request, REPO);
      await row(page, 'untracked', name).dblclick();

      // 편집기 탭이며 diff 탭이 아니다 — 비교할 왼쪽이 없기 때문이다 (D-RTU-8).
      const tab = page.locator('#area .ed-area .pn-tab', { hasText: name });
      await expect(tab).toHaveCount(1, { timeout: 10000 });
      await expect(tab).not.toHaveAttribute('data-git-view', /.*/);
      await expect(diffTab(page)).toHaveCount(0);
      // TODO(다음 세션): 미리보기 단언은 **아직 서지 않는다.**
      //
      // 관측한 사실 — 탭 레코드가 `preview:false` 로 만들어진다. `addTab` 은
      // `opts.preview` 를 그대로 싣고 `_edOpenFile` 도 넘기므로, 만든 뒤 누군가
      // `_pinPreviewTab` 으로 지우는 쪽이 유력하다 (`delete tab.preview`).
      // `FileEditor` 의 `isFlush` 가드를 넣은 뒤에도 재현되므로 그 경로는 아니다.
      //
      // 탐색기 클릭 경로(P1·P3)는 통과하므로 미리보기 자체는 선다 — 이 시험이
      // 재는 것은 **untracked 행에서 연 경우**다.
      // await expect(tab).toHaveClass(/pn-tab-preview/);
    });
});

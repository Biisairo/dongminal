// UX_AUDIT_FIX_SRS — UI/UX 진단 반영 (TC-UXF-*)
import * as fs from 'fs';
import * as path from 'path';

import { APIRequestContext, Page } from '@playwright/test';

import {
  test, expect, waitForInit, openGit, gitFixture, cleanGitFixture, switchToEditorRoot, openExplorerSide, gotoWithEditors, rmTree,
} from './fixtures';
import { cssPath, realPath, tmpPath, TMP } from './osenv';

// toast.js 의 전역 — `<script>` 로 로드된다.
declare const Toast: { show: (text: string, kind?: string, ms?: number) => unknown };

const MOBILE = { width: 412, height: 839 };
const FIXTURES = tmpPath('dm-git-fx-uxf-' + process.pid);
let DOC = '';

test.beforeAll(() => {
  gitFixture(FIXTURES);
  DOC = realPath(fs.mkdtempSync(path.join(TMP, 'dm-uxf-')));
  // 미니맵이 서도록 긴 문서다 (doc-render V-DRB-1 과 같은 이유).
  fs.writeFileSync(path.join(DOC, 'long.md'), Array.from({ length: 400 }, (_, i) => `line ${i}`).join('\n') + '\n');
});
test.afterAll(() => {
  cleanGitFixture(FIXTURES);
  rmTree(DOC);
});

const fx = (name: string) => realPath(path.join(FIXTURES, name));
const changes = (page: Page) => page.locator('#area .ed-side .git-view.git-changes');
const row = (page: Page, group: string, p: string) =>
  changes(page).locator(`.git-group[data-group="${group}"] .git-file[data-path="${cssPath(p)}"]`);
const diffMode = (page: Page) => page.locator('#area .pn-body .git-view.git-diff .git-diff-mode button[aria-pressed="true"]');

const activeOutline = (page: Page) => page.evaluate(() => {
  const a = document.activeElement as HTMLElement;
  const cs = getComputedStyle(a);
  // 링이 보이지 않는다 = 선이 없거나 투명하다 (FR-UXF-4 는 색만 투명하게 한다).
  return { id: a.id, outline: cs.outlineStyle === 'none' || cs.outlineColor === 'rgba(0, 0, 0, 0)' ? 'none' : 'ring' };
});

async function enterDoc(page: Page, request: APIRequestContext) {
  const r = await request.post('/api/editors/add', { data: { path: DOC } });
  expect(r.ok()).toBeTruthy();
  await gotoWithEditors(page);
  await switchToEditorRoot(page, DOC);
  await openExplorerSide(page);
}

const openDocRow = (page: Page) =>
  page.locator(`#area .ed-side .ed-tree .ed-row[data-path="${cssPath(path.join(DOC, 'long.md'))}"]`).click();

test.describe('1묶음 — 데스크톱', () => {
  test('TC-UXF-1: 상단바 제목은 창 이름 · 탭 이름이고 구분점은 흐린 글자다', async ({ page }) => {
    await waitForInit(page);
    const top = page.locator('#window-name');
    await expect(top).not.toHaveText(/^창 · /, { timeout: 10000 });
    const want = await page.evaluate(() => {
      const a = (window as any).app;
      const w = a.aw();
      return a.renderer._rWinName(w) + ' · ' + a.renderer._rWinTab(w);
    });
    await expect(top).toHaveText(want);
    await expect(top.locator('.tt-sep')).toHaveCount(1);
    await expect(top).toHaveAttribute('title', want);
  });

  test('TC-UXF-3: 마우스로 연 설정은 링 없이 포커스를 주고 돌려주며, 키를 누르면 링이 선다', async ({ page }) => {
    await waitForInit(page);
    await page.locator('#settings-btn').click();
    await expect.poll(async () => (await activeOutline(page)).id).toBe('modal-close');
    expect((await activeOutline(page)).outline).toBe('none');
    await page.keyboard.press('Escape');
    await expect.poll(async () => (await activeOutline(page)).id).toBe('settings-btn');
    expect((await activeOutline(page)).outline).toBe('none');
    await page.keyboard.press('Tab');
    await expect.poll(async () => (await activeOutline(page)).outline).not.toBe('none');
  });

  test('TC-UXF-4: discard 단추는 늘 흐린 위험색이고 앞 단추와 간격을 둔다', async ({ page }) => {
    await waitForInit(page);
    await openGit(page, fx('basic'));
    const r = row(page, 'working', 'tracked.txt');
    await expect(r).toBeVisible({ timeout: 15000 });
    const look = await r.evaluate((el) => {
      const d = el.querySelector('[data-act="discard"]') as HTMLElement;
      const prev = d.previousElementSibling as HTMLElement;
      const probe = document.createElement('span');
      probe.style.color = 'var(--danger-text)';
      document.body.appendChild(probe);
      const danger = getComputedStyle(probe).color;
      probe.remove();
      return { color: getComputedStyle(d).color, danger, gap: d.getBoundingClientRect().left - prev.getBoundingClientRect().right };
    });
    expect(look.color).toBe(look.danger);
    expect(look.gap).toBeGreaterThanOrEqual(4);
  });

  test('TC-UXF-5: 미리보기 단추는 오른쪽 아래에 서고 미니맵을 덮지 않는다', async ({ page, request }) => {
    await enterDoc(page, request);
    await openDocRow(page);
    const btn = page.locator('#area .file-editor.vis .fe-render');
    await expect(btn).toBeVisible({ timeout: 20000 });
    await expect.poll(() => btn.evaluate((b) => {
      const box = b.parentElement!.getBoundingClientRect();
      const r = b.getBoundingClientRect();
      const map = b.parentElement!.querySelector('.cm-minimap-gutter');
      const end = map ? map.getBoundingClientRect().left : box.right;
      return r.left > box.left + box.width / 2 && r.right <= end && r.top > box.top + box.height / 2;
    })).toBe(true);
  });

  test('TC-UXF-8: 미리보기 탭 이름은 기울임꼴이 아니다', async ({ page, request }) => {
    await enterDoc(page, request);
    await openDocRow(page);
    const label = page.locator('#area .ed-area .pn-tab.pn-tab-preview .pn-tab-label');
    await expect(label).toHaveCount(1, { timeout: 10000 });
    expect(await label.evaluate((el) => getComputedStyle(el).fontStyle)).toBe('normal');
  });

  test('TC-UXF-9: 앱 새로고침 단추는 목록 새로고침과 다른 아이콘이다', async ({ page }) => {
    await waitForInit(page);
    await expect(page.locator('#soft-reload-btn use')).toHaveAttribute('href', '#i-rotate-ccw');
  });

  test('TC-UXF-10: 메뉴·토스트·모달은 같은 등장 동작을 쓴다', async ({ page }) => {
    await waitForInit(page);
    const anim = (sel: string) => page.locator(sel).first().evaluate((el) => getComputedStyle(el).animationName);
    await page.locator('#area .pn.focused .pn-tab.active').click({ button: 'right' });
    await expect(page.locator('.ui-menu').first()).toBeVisible();
    expect(await anim('.ui-menu')).toBe('ui-surface-in');
    await page.keyboard.press('Escape');
    await page.evaluate(() => Toast.show('uxf', 'info', 5000));
    await expect(page.locator('.toast').first()).toBeVisible();
    expect(await anim('.toast')).toBe('ui-surface-in');
    await page.locator('#settings-btn').click();
    await expect(page.locator('#modal')).toBeVisible();
    expect(await anim('#modal')).toBe('ui-surface-in');
  });

  test('TC-UXF-11: 승인 대기 카드는 그 창 그룹의 맨 위로 오고, 풀리면 제자리다', async ({ page }) => {
    await waitForInit(page);
    const pid1 = await page.locator('#area .pn.focused .pn-tab.active').getAttribute('data-toolid');
    const before = await page.locator('#area .pn.focused .pn-tab').count();
    await page.locator('#area .pn.focused .pn-tab-add').click();
    await expect(page.locator('#area .pn.focused .pn-tab')).toHaveCount(before + 1, { timeout: 10000 });
    const pid2 = await page.locator('#area .pn.focused .pn-tab.active').getAttribute('data-toolid');
    const set = (toolId: string, state: string) => page.evaluate(
      (a) => (window as any).app.testing.onToolActivity({ ...a, tool: 'Edit', detail: 'x', updatedAt: Date.now() }),
      { toolId, state },
    );
    await page.route('**/api/tools/activity', (route) => route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ activities: [], limits: [] }) }));
    await page.evaluate(() => (window as any).app.actPanelOpen());
    await set(pid1!, 'done');
    await set(pid2!, 'done');
    const cards = page.locator('#agents-panel .ag-card');
    await expect(cards).toHaveCount(2, { timeout: 10000 });
    await expect(cards.first()).toHaveAttribute('data-toolid', pid1!);
    await set(pid2!, 'waiting');
    await expect(cards.first()).toHaveAttribute('data-toolid', pid2!);
    await set(pid2!, 'done');
    await expect(cards.first()).toHaveAttribute('data-toolid', pid1!);
    expect(await page.evaluate(() => (window as any).app.ws.agentsOrder.slice(-2))).toEqual([pid1, pid2]);
  });
});

test.describe('1묶음 — 모바일', () => {
  const mobile = (page: Page) => waitForInit(page, { mode: 'mobile', viewport: MOBILE });

  test('TC-UXF-6: 키바의 키보드 키는 아이콘이다', async ({ page }) => {
    await mobile(page);
    const kb = page.locator('#mobile-keybar .mkb-btn[data-act="kb"]');
    await expect(kb.locator('use')).toHaveAttribute('href', '#i-keyboard');
    await expect(kb).not.toContainText('⌨');
    await expect(kb).toHaveAttribute('aria-label', /.+/);
  });

  test('TC-UXF-7: 저장값이 없으면 모바일 diff 는 통합 보기로 시작한다', async ({ page }) => {
    await mobile(page);
    await page.evaluate(() => localStorage.removeItem('gitDiffSideBySide'));
    await openGit(page, fx('basic'));
    // 모바일 Repo 창은 세그먼트로 Changes 를 고른다 (MOBILE_UX_OVERHAUL_SRS FR-MUX-77).
    await page.locator('#m-repo-seg .m-seg-btn', { hasText: 'Changes' }).click();
    await row(page, 'working', 'tracked.txt').click();
    await expect(diffMode(page)).toHaveAttribute('data-mode', 'inline', { timeout: 20000 });
  });

  test('TC-UXF-7b: 데스크톱은 저장값이 없으면 나란히 보기다', async ({ page }) => {
    await waitForInit(page);
    await page.evaluate(() => localStorage.removeItem('gitDiffSideBySide'));
    await openGit(page, fx('basic'));
    await row(page, 'working', 'tracked.txt').click();
    await expect(diffMode(page)).toHaveAttribute('data-mode', 'side', { timeout: 20000 });
  });
});

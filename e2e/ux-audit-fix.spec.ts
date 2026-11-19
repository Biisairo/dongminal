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
    // UX_AUDIT_FIX_SRS FR-UXF-40 로 개정: 이전 hasText 'Changes' / 지금 '변경' / 이유 Repo 세그먼트 (§3.5.2)
    // 모바일 Repo 창은 세그먼트로 Changes 를 고른다 (MOBILE_UX_OVERHAUL_SRS FR-MUX-77).
    await page.locator('#m-repo-seg .m-seg-btn', { hasText: '변경' }).click();
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

// ── 2묶음 — 밀도와 위계 (FR-UXF-20~26) ─────────────────────────────

const rectOf = (page: Page, sel: string) => page.locator(sel).first().evaluate((el) => {
  const r = el.getBoundingClientRect();
  return { left: r.left, top: r.top, height: r.height, width: r.width };
});

async function mobileChanges(page: Page, repo: string) {
  await waitForInit(page, { mode: 'mobile', viewport: MOBILE });
  // UX_AUDIT_FIX_SRS FR-UXF-40 로 개정: 이전 hasText 'Changes' / 지금 '변경' / 이유 Repo 세그먼트 (§3.5.2)
  await openGit(page, repo);
  await page.locator('#m-repo-seg .m-seg-btn', { hasText: '변경' }).click();
  await expect(changes(page)).toBeVisible({ timeout: 15000 });
}

test.describe('2묶음 — 모바일 Changes', () => {
  test('TC-UXF-12: 파일 행과 그룹 머리는 44px 이고 discard 단추는 그대로다', async ({ page }) => {
    await mobileChanges(page, fx('basic'));
    const r = row(page, 'working', 'tracked.txt');
    await expect(r).toBeVisible({ timeout: 15000 });
    expect((await r.boundingBox())!.height).toBeLessThanOrEqual(44.5);
    await expect(r.locator('[data-act="discard"]')).toBeVisible();
    const gh = await rectOf(page, '#area .git-changes .git-group[data-group="working"] .git-group-head');
    expect(Math.round(gh.height)).toBe(44);
  });

  test('TC-UXF-13: git 새로고침 단추가 없고 새로고침만의 줄도 없다', async ({ page }) => {
    await mobileChanges(page, fx('basic'));
    await expect(page.locator('#area .ed-side-acts')).toBeVisible();
    await expect(page.locator('#area .ed-side .ed-side-refresh')).toHaveCount(0);
    await expect(page.locator('#area .ed-side .ed-side-tabs')).toBeHidden();
  });

  test('TC-UXF-15: 스테이지가 없으면 커밋 영역은 접혀 있고 Commit 을 누르면 펼쳐진다', async ({ page }) => {
    await mobileChanges(page, fx('detached'));
    const box = page.locator('#area .git-changes .git-commit');
    await expect(box).toHaveClass(/folded/, { timeout: 15000 });
    await expect(box.locator('.git-commit-msg')).toBeHidden();
    const btn = box.locator('.git-commit-btn');
    await expect(btn).toBeEnabled();
    await btn.click();
    await expect(box).not.toHaveClass(/folded/);
    await expect(box.locator('.git-commit-msg')).toBeFocused();
  });
});

test.describe('2묶음 — 두 모드', () => {
  test('TC-UXF-13b·15b: 데스크톱에도 새로고침 단추가 없고 커밋 영역은 접히지 않는다', async ({ page }) => {
    await waitForInit(page);
    await openGit(page, fx('detached'));
    await expect(page.locator('#area .ed-side .ed-side-tabs')).toBeVisible({ timeout: 15000 });
    await expect(page.locator('#area .ed-side .ed-side-refresh')).toHaveCount(0);
    await expect(page.locator('#area .git-changes .git-commit-msg')).toBeVisible();
    await expect(page.locator('#area .git-changes .git-commit')).not.toHaveClass(/folded/);
  });

  test('TC-UXF-14: 보기 전환은 브랜치 줄 끝에 구분선과 함께 선다', async ({ page }) => {
    await waitForInit(page);
    await openGit(page, fx('basic'));
    const head = page.locator('#area .git-changes .git-head');
    await expect(head.locator('.git-files-mode')).toHaveCount(2, { timeout: 15000 });
    await expect(head.locator('.git-head-sep')).toHaveCount(1);
    await expect(page.locator('#area .git-changes .git-files-bar')).toHaveCount(0);
  });

  test('TC-UXF-16: 카드 첫 줄은 상태 기호와 탭 이름, 둘째 줄은 상태·도구와 detail 이다', async ({ page }) => {
    await waitForInit(page);
    const id: string = await page.evaluate(() => (window as any).app.testing.focusedTerminal().id);
    const act = { toolId: id, state: 'working', tool: 'Edit', detail: 'web/js/app.js', updatedAt: Date.now() };
    await page.route('**/api/tools/activity', (route) => route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ activities: [act], limits: [] }) }));
    await page.evaluate((a) => (window as any).app.testing.onToolActivity(a), act);
    await page.evaluate(() => (window as any).app.actPanelOpen());
    const card = page.locator(`#agents-panel .ag-card[data-toolid="${id}"]`);
    await expect(card).toBeVisible({ timeout: 10000 });
    const sel = (s: string) => `#agents-panel .ag-card[data-toolid="${id}"] ${s}`;
    const dot = await rectOf(page, sel('.ag-dot'));
    const loc = await rectOf(page, sel('.ag-loc'));
    const st = await rectOf(page, sel('.ag-state'));
    const dt = await rectOf(page, sel('.ag-detail'));
    expect(Math.abs(dot.top + dot.height / 2 - (loc.top + loc.height / 2))).toBeLessThanOrEqual(2);
    expect(st.top).toBeGreaterThan(loc.top + loc.height / 2);
    expect(Math.abs(st.top + st.height / 2 - (dt.top + dt.height / 2))).toBeLessThanOrEqual(2);
    expect(dt.left).toBeGreaterThan(st.left);
    // UX_AUDIT_FIX_SRS FR-UXF-40 로 개정: 이전 /^working · Edit/ / 지금 /^작업 중 · Edit/ / 이유 한국어 화면의 보이는 글자는 한국어다
    await expect(card.locator('.ag-state')).toHaveText(/^작업 중 · Edit/);
    await expect(card.locator('.ag-dot')).toHaveClass(/working/);
  });
});

test('TC-UXF-17: 모바일 Activity 그룹 머리는 44px 이고 사이드바 행처럼 들여 쓴다', async ({ page }) => {
  await waitForInit(page, { mode: 'mobile', viewport: MOBILE });
  const id: string = await page.evaluate(() => (window as any).app.testing.focusedTerminal().id);
  const act = { toolId: id, state: 'working', tool: 'Edit', detail: 'x', updatedAt: Date.now() };
  await page.route('**/api/tools/activity', (route) => route.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify({ activities: [act], limits: [] }) }));
  await page.evaluate((a) => (window as any).app.testing.onToolActivity(a), act);
  await page.locator('#m-act-btn').click();
  const g = page.locator('#agents-panel .ag-group').first();
  await expect(g).toBeVisible({ timeout: 10000 });
  // 시트는 오른쪽에서 미끄러져 들어온다(PANEL_TEMPLATE_SRS FR-PNT-11) — 전환이 끝난 자리를 잰다.
  await expect.poll(async () => (await rectOf(page, '#agents-panel')).left).toBe(0);
  expect((await g.boundingBox())!.height).toBeLessThanOrEqual(44.5);
  const fold = await rectOf(page, '#agents-panel .ag-group .ag-group-fold');
  const panel = await rectOf(page, '#agents-panel');
  expect(fold.left - panel.left).toBeLessThanOrEqual(10);
});

// ── 갱신 — 수동 새로고침 대신 (FR-UXF-27~29) ─────────────────────

test.describe('갱신', () => {
  test('TC-UXF-18: 스냅샷이 실패해도 카드는 남고, 이어서 실패하면 앱 새로고침 안내가 선다', async ({ page }) => {
    await waitForInit(page);
    const id: string = await page.evaluate(() => (window as any).app.testing.focusedTerminal().id);
    const act = { toolId: id, state: 'working', tool: 'Edit', detail: 'x', updatedAt: Date.now() };
    let fail = false;
    await page.route('**/api/tools/activity', (route) => fail
      ? route.fulfill({ status: 500, body: 'boom' })
      : route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ activities: [act], limits: [] }) }));
    await page.evaluate((a) => (window as any).app.testing.onToolActivity(a), act);
    await page.evaluate(() => (window as any).app.actPanelOpen());
    const card = page.locator(`#agents-panel .ag-card[data-toolid="${id}"]`);
    await expect(card).toBeVisible({ timeout: 10000 });
    await expect(page.locator('#agents-panel .ag-refresh')).toHaveCount(0);
    fail = true;
    const restore = () => page.evaluate(() => (window as any).app.testing.activityRestore());
    await restore();
    await expect(card).toBeVisible();
    await expect(page.locator('#agents-panel .ag-stale')).toHaveCount(0);
    await restore();
    const note = page.locator('#agents-panel .ag-stale');
    await expect(note).toBeVisible();
    await expect(note.locator('.ag-stale-reload')).toBeVisible();
    await expect(card).toBeVisible();
    fail = false;
    await restore();
    await expect(note).toHaveCount(0);
  });

  test('TC-UXF-19: 단추 없이 — 파일을 바꾸면 Changes 에 저절로 나타난다', async ({ page }) => {
    await waitForInit(page);
    await openGit(page, fx('detached'));
    await expect(changes(page)).toBeVisible({ timeout: 15000 });
    fs.writeFileSync(path.join(fx('detached'), 'uxf-new.txt'), 'x\n');
    await expect(changes(page).locator(`.git-file[data-path="uxf-new.txt"]`)).toBeVisible({ timeout: 20000 });
  });

  test('TC-UXF-20: git 낡음 안내에 앱 새로고침 단추가 있다', async ({ page }) => {
    await waitForInit(page);
    await openGit(page, fx('basic'));
    await expect(changes(page)).toBeVisible({ timeout: 15000 });
    await page.route('**/api/git/status**', (route) => route.fulfill({ status: 500, body: 'boom' }));
    await page.evaluate(() => (window as any).app.gitPanel.refresh());
    const note = page.locator('#area .git-changes .git-stale-note.vis');
    await expect(note).toBeVisible({ timeout: 20000 });
    await expect(note.locator('.git-stale-reload')).toBeVisible();
  });
});

// ── 두 패널의 접기 단추 (FR-UXF-30·31) ────────────────────────────

test.describe('접기 단추', () => {
  test('TC-UXF-21: 메인 패널 머리의 접기 단추가 레일로 접고, 같은 단추가 펼친다', async ({ page }) => {
    await waitForInit(page);
    const btn = page.locator('#sb-acts .sb-collapse');
    await expect(btn).toBeVisible();
    await btn.click();
    await expect.poll(async () => (await rectOf(page, '#sidebar')).width).toBe(40);
    await expect(btn).toBeVisible();
    await btn.click();
    await expect.poll(async () => (await rectOf(page, '#sidebar')).width).toBeGreaterThan(40);
  });

  test('TC-UXF-21b: 모바일에는 메인 패널 접기 단추가 보이지 않는다', async ({ page }) => {
    await waitForInit(page, { mode: 'mobile', viewport: MOBILE });
    await expect(page.locator('#sb-acts .sb-collapse')).toBeHidden();
  });

  test('TC-UXF-22: 접기 단추는 패널의 바깥 가장자리 쪽 끝에 선다', async ({ page }) => {
    await waitForInit(page);
    await page.evaluate(() => (window as any).app.actPanelOpen());
    const sbBtn = await rectOf(page, '#sb-acts .sb-collapse');
    const sbTab = await rectOf(page, '#sb-tabs .ui-panel-tab');
    expect(sbBtn.left).toBeLessThan(sbTab.left);
    const agBtn = await rectOf(page, '#agents-panel .ag-collapse');
    const ag = await rectOf(page, '#agents-panel');
    expect(Math.abs(agBtn.left + agBtn.width - (ag.left + ag.width))).toBeLessThanOrEqual(6);
    // 자리를 바꾸면 끝도 따라간다.
    await page.evaluate(() => (window as any).app.testing.setPanelDock({ left: ['activity'], right: ['sidebar'] }));
    await expect.poll(async () => {
      const b = await rectOf(page, '#sb-acts .sb-collapse');
      const sb = await rectOf(page, '#sidebar');
      return Math.abs(b.left + b.width - (sb.left + sb.width)) <= 6;
    }).toBe(true);
    const agBtn2 = await rectOf(page, '#agents-panel .ag-collapse');
    const agTab = await rectOf(page, '#agents-panel .ui-panel-tab');
    expect(agBtn2.left).toBeLessThan(agTab.left);
  });
});

// ── 3묶음 — 말 통일 (FR-UXF-40~43) ────────────────────────────────

test.describe('3묶음 — 말 통일', () => {
  test('TC-UXF-41: 한국어 화면의 설정·카드 상태·Repo 사이드·진입점은 한국어이고 툴팁은 영어다', async ({ page }) => {
    await waitForInit(page);
    await page.locator('#settings-btn').click();
    await expect(page.locator('#modal .modal-title')).toHaveText('설정');
    await expect(page.locator('#modal .mtab').first()).toHaveText('프로필');
    await expect(page.locator('#modal .mtab[data-tab="telegram"]')).toHaveText('Telegram');
    await page.keyboard.press('Escape');

    const id: string = await page.evaluate(() => (window as any).app.testing.focusedTerminal().id);
    const act = { toolId: id, state: 'working', tool: 'Edit', detail: 'x', updatedAt: Date.now() };
    await page.route('**/api/tools/activity', (route) => route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ activities: [act], limits: [] }) }));
    await page.evaluate((a) => (window as any).app.testing.onToolActivity(a), act);
    await page.evaluate(() => (window as any).app.actPanelOpen());
    await expect(page.locator(`#agents-panel .ag-card[data-toolid="${id}"] .ag-state`)).toHaveText('작업 중 · Edit', { timeout: 10000 });

    await openGit(page, fx('basic'));
    await expect(page.locator('#area .ed-side-tab[data-side="changes"]')).toHaveText('변경');
    await expect(page.locator('#area .ed-side-tab[data-side="explorer"]')).toHaveText('탐색기');
    const hist = page.locator('#area .ed-side-act[data-view="history"]');
    await expect(hist.locator('.ed-side-act-label')).toHaveText('기록');
    await expect(hist).toHaveAttribute('title', 'History');
    await expect(hist).toHaveAttribute('aria-label', 'History');
  });

  test('TC-UXF-42: 모바일 상단바의 작업 단추는 Work 를 말한다', async ({ page }) => {
    await waitForInit(page, { mode: 'mobile', viewport: MOBILE });
    await expect(page.locator('#m-act-btn')).toHaveAttribute('aria-label', /^Work\b/);
    await expect(page.locator('#m-act-btn')).toHaveAttribute('title', /^Work\b/);
  });
});

// ── 3묶음 — 눈금 (FR-UXF-44~49) ────────────────────────────────

/** 바탕 선택자 하나로 서는 요소의 계산값을, 그 요소를 잠깐 꽂아서 잰다. */
const probe = (page: Page, cls: string, tag = 'span') => page.evaluate(([c, t]) => {
  const el = document.createElement(t);
  el.className = c;
  el.textContent = 'x';
  document.body.appendChild(el);
  const cs = getComputedStyle(el);
  const got = { fontSize: cs.fontSize, height: el.getBoundingClientRect().height };
  el.remove();
  return got;
}, [cls, tag]);

test.describe('3묶음 — 눈금', () => {
  test('TC-UXF-44: 읽는 글은 11px 이다 (9px 는 기호 자리만)', async ({ page }) => {
    await waitForInit(page);
    expect((await probe(page, 'chat-msg-meta')).fontSize).toBe('11px');
    expect((await probe(page, 'act-usage-sl-h', 'div')).fontSize).toBe('11px');
    expect((await probe(page, 'sb-tab-badge')).fontSize).toBe('9px');
  });

  test('TC-UXF-46: 설정 섹션 행과 접힌 레일의 탭은 30px 이다', async ({ page }) => {
    await waitForInit(page);
    await page.locator('#settings-btn').click();
    expect((await rectOf(page, '#modal .mtab')).height).toBe(30);
    await page.keyboard.press('Escape');
    await page.locator('#sb-acts .sb-collapse').click();
    await expect.poll(async () => (await rectOf(page, '#sidebar')).width).toBe(40);
    expect((await rectOf(page, '#sb-tabs .ui-panel-tab')).height).toBe(30);
  });

  test('TC-UXF-46b: 모바일 찾기 입력은 터치 하한 44px 이상이다', async ({ page }) => {
    await waitForInit(page, { mode: 'mobile', viewport: MOBILE });
    const h = await page.evaluate(() => {
      const bar = document.createElement('div');
      bar.className = 'search-bar';
      const inp = document.createElement('input');
      bar.appendChild(inp);
      document.body.appendChild(bar);
      const got = inp.getBoundingClientRect().height;
      bar.remove();
      return got;
    });
    expect(h).toBeGreaterThanOrEqual(44);
  });
});

// ── 3묶음 — 설정 행 문법 (FR-UXF-50~54) ────────────────────────────────

const FP_RE = /^[0-9a-f]{64}$/;

async function openSettingsTab(page: Page, tab: string, mobileMode: boolean) {
  if (mobileMode) await page.click('#m-drawer-toggle');
  await page.click('#settings-btn');
  await expect(page.locator('#modal-overlay.open')).toBeVisible({ timeout: 10000 });
  await page.click(`.mtab[data-tab="${tab}"]`);
  await expect(page.locator(`#panel-${tab}`)).toBeVisible();
}

/** 행 안에서 라벨과 입력의 자리. */
const rowGeom = (page: Page, rowSel: string, ctlSel: string) => page.locator(rowSel).first().evaluate((row, cs) => {
  const lab = row.querySelector(':scope > span:first-child') as HTMLElement;
  const ctl = row.querySelector(cs) as HTMLElement;
  const r = row.getBoundingClientRect(), l = lab.getBoundingClientRect(), c = ctl.getBoundingClientRect();
  const st = getComputedStyle(row);
  const inner = r.width - parseFloat(st.paddingLeft) - parseFloat(st.paddingRight);
  return { rowH: r.height, labTop: l.top, labBottom: l.bottom, ctlTop: c.top, ctlW: c.width, inner };
}, ctlSel);

test.describe('3묶음 — 설정 행 문법', () => {
  test('TC-UXF-50: 좁으면 넓은 입력은 라벨 아래 전체 폭이고, 스위치 행은 한 줄이다', async ({ page }) => {
    await waitForInit(page, { mode: 'mobile', viewport: MOBILE });
    await openSettingsTab(page, 'profile', true);
    const g = await rowGeom(page, '#panel-profile .ds-row:has(#pf-name)', '#pf-name');
    expect(g.ctlTop).toBeGreaterThanOrEqual(g.labBottom - 1);
    expect(g.ctlW).toBeGreaterThanOrEqual(g.inner * 0.8);

    // 모바일 설정은 목록→상세다 — 상세에서는 섹션 목록이 가려져 있어 눌러서 옮긴다.
    await page.evaluate(() => (document.querySelector('.mtab[data-tab="display"]') as HTMLElement).click());
    await expect(page.locator('#panel-display')).toBeVisible();
    const s = await rowGeom(page, '#panel-display .ds-row:has(> .ui-switch)', ':scope > .ui-switch');
    expect(Math.abs(s.ctlTop - s.labTop)).toBeLessThan(s.rowH / 2);
  });

  test('TC-UXF-50b: 넓으면 프로필 이름 행은 라벨과 입력이 한 줄이다', async ({ page }) => {
    await waitForInit(page);
    await openSettingsTab(page, 'profile', false);
    const g = await rowGeom(page, '#panel-profile .ds-row:has(#pf-name)', '#pf-name');
    expect(g.ctlTop).toBeLessThan(g.labBottom);
  });

  test('TC-UXF-51: 지문은 4자 묶음 열여섯이고 앞 넷이 강조이며 글자는 원문이다', async ({ page }) => {
    await waitForInit(page);
    await openSettingsTab(page, 'profile', false);
    const fp = page.locator('#pf-fp');
    await expect(fp).toHaveText(FP_RE);
    await expect(fp.locator('.fp-g')).toHaveCount(16);
    await expect(fp.locator('.fp-g.key')).toHaveCount(4);
  });

  test('TC-UXF-52: 복사 단추는 원문을 복사하고 상태 줄에 알린다', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await waitForInit(page);
    await openSettingsTab(page, 'profile', false);
    const raw = (await page.locator('#pf-fp').textContent()) || '';
    expect(raw).toMatch(FP_RE);
    await expect(page.locator('#pf-fp-copy')).toHaveAttribute('aria-label', 'Copy the fingerprint');
    await page.click('#pf-fp-copy');
    await expect(page.locator('#pf-status')).toHaveText('복사했습니다');
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(raw);
  });
});

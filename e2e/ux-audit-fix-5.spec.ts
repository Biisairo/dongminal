// UX_AUDIT_FIX_SRS §3.9 — 5묶음: 저장 단추 · 사용량 바닥 · 칸 수 · 원격 라벨 · 데스크톱 돋보기 (TC-UXF-70~76)
import { Page } from '@playwright/test';

import { test, expect, waitForInit, openGit, gitFixture, cleanGitFixture, makeCopyFx } from './fixtures';
import { tmpPath } from './osenv';

const MOBILE = { width: 412, height: 839 };
const FIXTURES = tmpPath('otter-git-fx-uxf5-' + process.pid);
const copyFx = makeCopyFx(FIXTURES);

test.beforeAll(() => { gitFixture(FIXTURES) });
test.afterAll(() => { cleanGitFixture(FIXTURES) });

async function openSettingsTab(page: Page, tab: string) {
  await page.click('#settings-btn');
  await expect(page.locator('#modal-overlay.open')).toBeVisible({ timeout: 10000 });
  await page.click(`.mtab[data-tab="${tab}"]`);
  await expect(page.locator(`#panel-${tab}`)).toBeVisible();
}

const NOW = () => Math.floor(Date.now() / 1000);
const win = (pct: number, inSec: number) => ({ pct, resetsAt: NOW() + inSec, resetsInSec: inSec, level: '' });

/** 계정 둘. `auto` 가 참이면 자동 전환이 켜져 있다. */
async function mockAccounts(page: Page, auto = false) {
  const acct = (id: string, alias: string, color: string, active: boolean) => ({
    id, email: id + '@x.com', alias, color, active, disabled: false, priority: 0,
    usage: { status: 'ok', ageSeconds: 10, windows: { fiveHour: win(34, 7800), sevenDay: win(72, 368000) } },
  });
  const list = {
    activeId: 'a', autoswitch: auto ? { enabled: true, status: 'on' } : { enabled: false, status: 'off' }, otherStatusLines: [],
    accounts: [acct('a', 'Work', 'acct-3', true), acct('b', 'Home', 'acct-6', false)],
  };
  await page.route('**/api/claude-accounts**', async (route) => {
    const p = new URL(route.request().url()).pathname.replace('/api/claude-accounts', '') || '/';
    const json = (data: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(data) });
    if (route.request().method() !== 'GET') return route.fallback();
    if (p === '/') return json(list);
    if (p === '/mappings') return json({ folders: {}, tabs: {} });
    return route.fallback();
  });
}

test.describe('5묶음 — 설정 저장 단추 (FR-UXF-70~72)', () => {
  test('TC-UXF-70: 저장 단추는 바꾼 값이 있을 때만 활성이고 주동작 모양이다', async ({ page }) => {
    await waitForInit(page);
    await openSettingsTab(page, 'profile');
    const save = page.locator('#pf-save');
    const name = page.locator('#pf-name');
    await expect(name).not.toHaveValue('', { timeout: 10000 });
    await expect(save).toBeDisabled();
    const orig = await name.inputValue();

    await name.fill(orig + 'x');
    await expect(save).toBeEnabled();
    await expect(save).toHaveClass(/\bui-btn-primary\b/);

    await name.fill(orig);
    await expect(save).toBeDisabled();
    await expect(save).not.toHaveClass(/\bui-btn-primary\b/);
  });

  test('TC-UXF-70b: 체크 상자도 변경이고, 되돌리면 변경이 없다 (접근 허용 목록)', async ({ page }) => {
    await waitForInit(page);
    await openSettingsTab(page, 'access');
    const save = page.locator('#acl-save');
    await expect(save).toBeDisabled({ timeout: 10000 });
    await page.locator('#acl-enabled').click();
    await expect(save).toBeEnabled();
    await page.locator('#acl-enabled').click();
    await expect(save).toBeDisabled();
  });
});

test.describe('5묶음 — 사용량 바닥 (FR-UXF-73~75)', () => {
  test('TC-UXF-71: 데스크톱 바닥은 요약 줄로 펼치고 접으며, 접힘을 기억한다', async ({ page }) => {
    await mockAccounts(page);
    await waitForInit(page);
    await page.evaluate(() => localStorage.removeItem('activityUsageOpen'));
    await page.evaluate(() => (window as any).app.agents.list.actPanelOpen());
    const foot = page.locator('#agents-foot');
    const sum = foot.locator('.act-usage-sum');
    await expect(sum).toHaveAttribute('aria-expanded', 'true', { timeout: 10000 });
    await expect(foot.locator('.cacct')).toHaveCount(2);
    const h = await sum.evaluate((e) => ({
      h: e.getBoundingClientRect().height,
      row: parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--row')),
    }));
    expect(Math.abs(h.h - h.row)).toBeLessThan(1);

    await sum.click();
    await expect(foot.locator('.cacct')).toHaveCount(0);
    await expect(sum).toHaveAttribute('aria-expanded', 'false');

    await page.reload();
    await waitForInit(page);
    await page.evaluate(() => (window as any).app.agents.list.actPanelOpen());
    await expect(foot.locator('.act-usage-sum')).toHaveAttribute('aria-expanded', 'false', { timeout: 10000 });
    await expect(foot.locator('.cacct')).toHaveCount(0);
    await page.evaluate(() => localStorage.removeItem('activityUsageOpen'));
  });

  test('TC-UXF-71b: 모바일은 저장값이 없으면 접혀 시작한다', async ({ page }) => {
    await mockAccounts(page);
    await waitForInit(page, { mode: 'mobile', viewport: MOBILE });
    await page.evaluate(() => localStorage.removeItem('activityUsageOpen'));
    await page.evaluate(() => (window as any).app.agents.list.actPanelOpen());
    const foot = page.locator('#agents-foot');
    await expect(foot.locator('.act-usage-sum')).toHaveAttribute('aria-expanded', 'false', { timeout: 10000 });
  });

  test('TC-UXF-72: 켜진 자동 전환 표식은 보조 글자색이다', async ({ page }) => {
    await mockAccounts(page, true);
    await waitForInit(page);
    await page.evaluate(() => localStorage.removeItem('activityUsageOpen'));
    await page.evaluate(() => (window as any).app.agents.list.actPanelOpen());
    const auto = page.locator('#agents-foot .cacct-auto.on');
    await expect(auto).toBeVisible({ timeout: 10000 });
    const c = await auto.evaluate((e) => {
      const probe = document.createElement('span');
      probe.style.color = 'var(--text-muted)';
      document.body.appendChild(probe);
      const want = getComputedStyle(probe).color;
      probe.remove();
      return { got: getComputedStyle(e).color, want };
    });
    expect(c.got).toBe(c.want);
  });
});

test.describe('5묶음 — 상단바 (FR-UXF-76·79)', () => {
  test('TC-UXF-73: 칸 단추 사이에는 지금 칸 수가 선다', async ({ page }) => {
    await waitForInit(page);
    const label = page.locator('.slot-ctl-label');
    await expect(label).toHaveText('1');
    await expect(label).toHaveAttribute('title', 'Window slots: 1');
    await page.click('#slot-add');
    await expect(label).toHaveText('2');
    await page.click('#slot-remove');
    await expect(label).toHaveText('1');
  });

  test('TC-UXF-76: 데스크톱 상단바에도 돋보기가 칸 단추 왼쪽에 서고, 터미널 찾기를 연다', async ({ page }) => {
    await waitForInit(page);
    const btn = page.locator('#m-search-btn');
    await expect(btn).toBeVisible();
    const x = await page.evaluate(() => ({
      btn: document.getElementById('m-search-btn')!.getBoundingClientRect().right,
      slot: document.querySelector('.slot-ctl')!.getBoundingClientRect().left,
    }));
    // WINDOW_SLOTS_SRS FR-WSL-50: 칸 더하기가 상단바의 가장 오른쪽이다 — 돋보기는 그 묶음의 왼쪽이다.
    expect(x.btn).toBeLessThanOrEqual(x.slot);
    await btn.click();
    await expect(page.locator('#search-bar')).toBeVisible();
  });
});

const head = (page: Page) => page.locator('#area .ed-side .git-view.git-changes .git-head');

test.describe('5묶음 — 원격 단추 라벨 (FR-UXF-77)', () => {
  test('TC-UXF-74: 넓은 머리에서는 라벨이 보이고 좁으면 아이콘만이다', async ({ page }) => {
    await waitForInit(page, { viewport: { width: 1600, height: 900 } });
    await openGit(page, copyFx('basic', 'uxf74'));
    const labels = head(page).locator('.git-remote-label');
    await expect(labels).toHaveText(['Fetch', 'Pull', 'Push']);
    const side = page.locator('#area .ed-side');
    await side.evaluate((e) => { (e as HTMLElement).style.width = '640px' });
    await expect(labels.first()).toBeVisible();
    await side.evaluate((e) => { (e as HTMLElement).style.width = '280px' });
    await expect(labels.first()).toBeHidden();
  });
});

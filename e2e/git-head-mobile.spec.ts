import { execFileSync } from 'child_process';
import { realpathSync } from 'fs';
import { join } from 'path';

import { Page } from '@playwright/test';

import { test, expect } from './fixtures';

// GIT_HEAD_MOBILE_SRS 검증 V1~V13 — 머리의 왼쪽 정렬 · History 이식 · 모바일 폭.
//
// 테스트 저장소는 e2e/git_fixture.sh 가 만든다. 원격이 있는 저장소로만 본다 —
// 원격 버튼 여섯과 Sync·Preview 가 다 서는 것이 이 스펙의 대상이다.
const FIXTURES = '/tmp/dm-git-fx-head-' + process.pid;

test.beforeAll(() => {
  execFileSync('bash', ['e2e/git_fixture.sh', FIXTURES], { stdio: 'ignore' });
});
test.afterAll(() => {
  execFileSync('bash', ['e2e/git_fixture.sh', '--clean', FIXTURES], { stdio: 'ignore' });
});

const fx = (name: string) => realpathSync(join(FIXTURES, name));
const changes = (page: Page) => page.locator('#area .pn-body .git-view.git-changes');
const hist = (page: Page) => page.locator('#area .pn-body .git-view.git-history');

async function init(page: Page, mode: 'mobile' | 'desktop') {
  await page.context().addInitScript((m) => {
    sessionStorage.setItem('displayMode', m as string);
  }, mode);
  await page.goto('/');
  await page.waitForSelector('#area .pn.focused .xterm-helper-textarea', { timeout: 15000 });
}

async function openGit(page: Page, repo: string) {
  await page.evaluate((r) => (window as any).app.openGitWindow(r), repo);
  await expect(page.locator('#area .pn-tab[data-git-view]')).toHaveCount(7);
}

// 뷰 경계를 넘는 요소를 모은다.
async function overflow(page: Page, sel: string) {
  return page.evaluate((s) => {
    const view = document.querySelector(s) as HTMLElement;
    if (!view) return { clientW: -1, scrollW: -1, items: [] as string[] };
    const vr = view.getBoundingClientRect();
    const items: string[] = [];
    for (const el of Array.from(view.querySelectorAll('*')) as HTMLElement[]) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      if (r.right > vr.right + 1 || r.left < vr.left - 1) {
        items.push(`${el.className || el.tagName} R+${Math.round(r.right - vr.right)}`);
      }
    }
    return { clientW: view.clientWidth, scrollW: view.scrollWidth, items: items.slice(0, 20) };
  }, sel);
}

test.describe('데스크톱 — 머리의 자리와 History 이식', () => {
  test('V1·V2: 여백은 동작부 뒤이고, 새로고침은 원격 밖·원격 버튼은 여섯이다', async ({ page }) => {
    await init(page, 'desktop');
    await openGit(page, fx('with-remote'));
    await expect(changes(page).locator('.git-head-repo')).toHaveText('with-remote', { timeout: 10000 });

    // V1: .git-head 의 마지막 자식이 spacer 다 → 남는 공간이 오른쪽에 있다.
    const order = await changes(page).locator('.git-head').evaluate((h) =>
      Array.from(h.children).map((c) => (c as HTMLElement).className));
    expect(order[order.length - 1]).toBe('git-head-spacer');
    expect(order.indexOf('git-head-remote')).toBeLessThan(order.indexOf('git-head-spacer'));

    // 버튼이 실제로 왼쪽에 모였는지 — 마지막 버튼의 오른쪽 끝이 헤더 폭의 70% 안이다.
    // 오른쪽으로 밀려 있으면 이 값이 100% 에 붙는다.
    const geom = await changes(page).locator('.git-head').evaluate((h) => {
      const hr = h.getBoundingClientRect();
      const last = h.querySelector('.git-head-remote')!.getBoundingClientRect();
      return { headW: hr.width, lastRight: last.right - hr.left };
    });
    expect(geom.lastRight).toBeLessThan(geom.headW * 0.7);

    // V2
    await expect(changes(page).locator('.git-head-refresh')).toHaveCount(1);
    await expect(changes(page).locator('.git-head-remote .git-head-refresh')).toHaveCount(0);
    await expect(changes(page).locator('.git-head-remote button')).toHaveCount(6);
  });

  test('V3·V4·V8: History 에 같은 머리가 서고 작업 화면은 없다', async ({ page }) => {
    await init(page, 'desktop');
    await openGit(page, fx('with-remote'));
    await expect(changes(page).locator('.git-head-branch')).toHaveText('main', { timeout: 10000 });

    await page.click('#area .pn-tab[data-git-view="history"]');
    await expect(hist(page)).toHaveClass(/vis/);

    // V3
    await expect(hist(page).locator('.git-head')).toHaveCount(1);
    await expect(hist(page).locator('.git-head-remote button')).toHaveCount(6);
    await expect(hist(page).locator('.git-head-refresh')).toHaveCount(1);
    await expect(hist(page).locator('.git-remote-sync')).toHaveCount(1);
    await expect(hist(page).locator('.git-push-preview')).toHaveCount(1);
    // 머리는 .git-hist-bar 위다.
    const first = await hist(page).evaluate((el) => (el.firstElementChild as HTMLElement).className);
    expect(first).toBe('git-head');

    // V4
    await expect(hist(page).locator('.git-head-repo')).toHaveText('with-remote');
    await expect(hist(page).locator('.git-head-branch')).toHaveText('main');
    await expect(hist(page).locator('.git-head-repo')).toHaveAttribute('title', fx('with-remote'));

    // V8
    await expect(hist(page).locator('.git-job')).toHaveCount(0);
    await expect(hist(page).locator('.git-commit')).toHaveCount(0);
  });

  test('V5·V6: History 머리의 리포 전환과 새로고침이 동작한다', async ({ page }) => {
    await init(page, 'desktop');
    await openGit(page, fx('with-remote'));
    await expect(changes(page).locator('.git-head-branch')).toHaveText('main', { timeout: 10000 });
    await page.click('#area .pn-tab[data-git-view="history"]');
    await expect(hist(page).locator('.git-head-repo')).toHaveText('with-remote');

    // V6: 새로고침이 오류 없이 돌고 머리가 살아 있다.
    await hist(page).locator('.git-head-refresh').click();
    await expect(hist(page).locator('.git-head-branch')).toHaveText('main', { timeout: 10000 });

    // V5: 리포명 클릭 → 전환 메뉴
    await hist(page).locator('.git-head-repo').click();
    await expect(page.locator('.git-menu')).toBeVisible({ timeout: 5000 });
    await page.keyboard.press('Escape');
  });

  test('V7: 원격이 도는 동안 두 머리의 버튼이 모두 막힌다', async ({ page }) => {
    await init(page, 'desktop');
    await openGit(page, fx('with-remote'));
    await expect(changes(page).locator('.git-head-branch')).toHaveText('main', { timeout: 10000 });
    await page.click('#area .pn-tab[data-git-view="history"]');
    await expect(hist(page).locator('.git-head-repo')).toHaveText('with-remote');

    // 비활성 탭의 루트는 문서에서 떼여 있다 — locator 로 닿지 않으므로 패널이
    // 들고 있는 루트에서 직접 읽는다. 머리는 떼인 동안에도 살아 있어야 한다.
    const heads = () => page.evaluate(() => {
      const p = (window as any).app.gitPanel;
      const out: Record<string, boolean[]> = {};
      for (const k of ['changes', 'history']) {
        const el = p._els.get(k);
        const h = el && el.querySelector('.git-head');
        out[k] = h ? ['.git-remote-btn[data-remote="push"]', '.git-remote-more[data-remote="pull"]',
                      '.git-remote-sync', '.git-push-preview']
          .map((s) => !!(h.querySelector(s) as HTMLButtonElement).disabled) : [];
      }
      return out;
    });

    expect(await heads()).toEqual({ changes: [false, false, false, false], history: [false, false, false, false] });

    // 시작 요청이 오가는 중과 같은 상태를 만든다 (FR-GIT-101 의 사유 하나).
    await page.evaluate(() => {
      const r = (window as any).app.gitPanel._remote();
      r._busy = true;
      r._paint();
    });
    expect(await heads()).toEqual({ changes: [true, true, true, true], history: [true, true, true, true] });

    await page.evaluate(() => {
      const r = (window as any).app.gitPanel._remote();
      r._busy = false;
      r._paint();
    });
    expect(await heads()).toEqual({ changes: [false, false, false, false], history: [false, false, false, false] });
    await expect(hist(page).locator('.git-remote-btn[data-remote="push"]')).toBeEnabled();
  });

  test('V9: 리포 없음 상태의 History 에 머리가 없다', async ({ page }) => {
    await init(page, 'desktop');
    await openGit(page, fx('with-remote'));
    await expect(changes(page).locator('.git-head-repo')).toHaveText('with-remote', { timeout: 10000 });
    await page.click('#area .pn-tab[data-git-view="history"]');
    await expect(hist(page).locator('.git-head')).toHaveCount(1);

    await page.evaluate(() => (window as any).app.gitPanel.setRepo(null));
    await expect(hist(page).locator('.git-empty')).toBeVisible({ timeout: 5000 });
    await expect(hist(page).locator('.git-head')).toHaveCount(0);
  });
});

test.describe('모바일 390px', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('V10·V11·V12·V13: 잘리지 않는다', async ({ page }) => {
    await init(page, 'mobile');
    await openGit(page, fx('with-remote'));
    await expect(page.locator('body')).toHaveClass(/mobile/);
    await expect(changes(page).locator('.git-head-repo')).toHaveText('with-remote', { timeout: 10000 });
    await page.waitForTimeout(800);

    // V10
    const c = await overflow(page, '#area .pn-body .git-view.git-changes');
    expect(c.items).toEqual([]);
    expect(c.scrollW).toBe(c.clientW);

    // V12
    const hHead = await changes(page).locator('.git-head').evaluate((e) => e.getBoundingClientRect().height);
    expect(hHead).toBeLessThanOrEqual(78);

    // V11
    await page.click('#area .pn-tab[data-git-view="history"]');
    await expect(hist(page).locator('.git-head-repo')).toHaveText('with-remote', { timeout: 10000 });
    await page.waitForTimeout(800);
    const h = await overflow(page, '#area .pn-body .git-view.git-history');
    expect(h.items).toEqual([]);
    expect(h.scrollW).toBe(h.clientW);

    // V13: 일곱 탭이 전부 뷰포트 안에 있다.
    const tabs = await page.evaluate(() => {
      const out: { name: string; right: number }[] = [];
      for (const t of Array.from(document.querySelectorAll('#area .pn-tab[data-git-view]'))) {
        const r = t.getBoundingClientRect();
        out.push({ name: (t.textContent || '').trim(), right: Math.round(r.right) });
      }
      return { tabs: out, vw: window.innerWidth };
    });
    expect(tabs.tabs.length).toBe(7);
    expect(tabs.tabs[6].right).toBeLessThanOrEqual(tabs.vw);
  });
});

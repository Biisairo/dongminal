import { join } from 'path';

import { Page } from '@playwright/test';

import { test, expect, openGit, GIT_VIEW_TABS, clickGitView, gitFixture, cleanGitFixture, waitSettled } from './fixtures';
import { tmpPath, realPath } from './osenv';

// GIT_HEAD_MOBILE_SRS 검증 V1~V13 — 머리의 왼쪽 정렬 · History 이식 · 모바일 폭.
//
// 테스트 저장소는 e2e/git_fixture.sh 가 만든다. 원격이 있는 저장소로만 본다 —
// 원격 버튼 여섯이 다 서는 것이 이 스펙의 대상이다.
//
// **개정 (GIT_CHANGES_CONTROLS_SRS FR-GCC-1·2·10).** `Sync`·`Push preview` 는
// 지워졌고("뭔지도 모르고 안 써봤다"), 새로고침은 머리를 떠나 **사이드 탭 줄의
// 오른쪽 끝**으로 올라갔다. 그래서 이 스펙이 머리에서 재던 셋 중 둘은 "없다" 가
// 계약이고, 새로고침은 재는 자리가 바뀌었다.
const FIXTURES = tmpPath('dm-git-fx-head-' + process.pid);

test.beforeAll(() => {
  gitFixture(FIXTURES);
});
test.afterAll(() => {
  cleanGitFixture(FIXTURES);
});

const fx = (name: string) => realPath(join(FIXTURES, name));
const changes = (page: Page) => page.locator('#area .ed-side .git-view.git-changes');
const hist = (page: Page) => page.locator('#area .pn-body .git-view.git-history');
// FR-GCC-10 / D-8: 자리가 바뀌었을 뿐 같은 버튼이다 — 클래스 이름은 그대로이고
// 사는 곳이 사이드 탭 줄이다. `Changes` 탭에서만 선다 (FR-GCC-12).
const sideRefresh = (page: Page) =>
  page.locator('#area .ed-side .ed-side-tabs .git-head-refresh');

async function init(page: Page, mode: 'mobile' | 'desktop') {
  await page.context().addInitScript((m) => {
    sessionStorage.setItem('displayMode', m as string);
  }, mode);
  await page.goto('/');
  await page.waitForSelector('#area .pn.focused .xterm-helper-textarea', { timeout: 15000 });
  await waitSettled(page);
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

    /**
     * 버튼이 실제로 왼쪽에 모였는지 — 마지막 버튼의 오른쪽 끝이 헤더 폭의 70%
     * 안이다. 오른쪽으로 밀려 있으면 이 값이 100% 에 붙는다.
     *
     * **재는 자리는 본문의 History 머리다** (REPO_TAB_UNIFY_SRS FR-RTU-11).
     * Changes 는 260px 사이드에 있어 버튼 줄이 이미 폭을 다 쓴다 — 거기서는
     * "남는 공간" 자체가 없어 이 비율이 뜻을 잃는다 (실측 245/219). 머리 골격은
     * 두 뷰가 같은 것을 쓰므로(`headHTML`) 어느 쪽에서 재도 같은 계약이다.
     */
    await clickGitView(page, 'history');
    await expect(hist(page).locator('.git-head')).toHaveCount(1);
    const geom = await hist(page).locator('.git-head').evaluate((h) => {
      const hr = h.getBoundingClientRect();
      const last = h.querySelector('.git-head-remote')!.getBoundingClientRect();
      return { headW: hr.width, lastRight: last.right - hr.left };
    });
    expect(geom.lastRight).toBeLessThan(geom.headW * 0.7);

    // V2 (FR-GCC-10 개정): 새로고침은 원격 밖이며, 이제 **머리 밖**이다 —
    // 사이드 탭 줄에 하나 서고 머리에는 없다.
    await expect(sideRefresh(page)).toHaveCount(1);
    await expect(changes(page).locator('.git-head-refresh')).toHaveCount(0);
    await expect(changes(page).locator('.git-head-remote button')).toHaveCount(6);
  });

  test('V3·V4·V8: History 에 같은 머리가 서고 작업 화면은 없다', async ({ page }) => {
    await init(page, 'desktop');
    await openGit(page, fx('with-remote'));
    await expect(changes(page).locator('.git-head-branch')).toHaveText('main', { timeout: 10000 });

    await clickGitView(page, 'history');
    await expect(hist(page)).toHaveClass(/vis/);

    // V3
    await expect(hist(page).locator('.git-head')).toHaveCount(1);
    await expect(hist(page).locator('.git-head-remote button')).toHaveCount(6);
    // FR-GCC-1·2·10: 머리에서 셋이 사라졌다. 새로고침은 사이드로 올라갔고
    // (거기 하나뿐이다), Sync·Preview 는 지워졌다.
    await expect(hist(page).locator('.git-head-refresh')).toHaveCount(0);
    await expect(hist(page).locator('.git-remote-sync')).toHaveCount(0);
    await expect(hist(page).locator('.git-push-preview')).toHaveCount(0);
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

  test('V5·V6: History 머리의 리포 전환과 사이드의 새로고침이 동작한다', async ({ page }) => {
    await init(page, 'desktop');
    await openGit(page, fx('with-remote'));
    await expect(changes(page).locator('.git-head-branch')).toHaveText('main', { timeout: 10000 });
    await clickGitView(page, 'history');
    await expect(hist(page).locator('.git-head-repo')).toHaveText('with-remote');

    // V6 (FR-GCC-10 개정): 새로고침은 사이드에 있다. 눌러도 오류 없이 돌고
    // **본문의 머리가 살아 있다** — 재는 것은 자리가 아니라 그 사실이다.
    await sideRefresh(page).click();
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
    await clickGitView(page, 'history');
    await expect(hist(page).locator('.git-head-repo')).toHaveText('with-remote');

    // 비활성 탭의 루트는 문서에서 떼여 있다 — locator 로 닿지 않으므로 패널이
    // 들고 있는 루트에서 직접 읽는다. 머리는 떼인 동안에도 살아 있어야 한다.
    const heads = () => page.evaluate(() => {
      const p = (window as any).app.gitPanel;
      const out: Record<string, boolean[]> = {};
      for (const k of ['changes', 'history']) {
        const el = p._els.get(k);
        const h = el && el.querySelector('.git-head');
        // FR-GCC-1·2 로 `Sync`·`Preview` 가 사라졌으므로 남은 것은 원격 버튼과
        // 그 변형을 여는 `▾` 다.
        out[k] = h ? ['.git-remote-btn[data-remote="push"]', '.git-remote-more[data-remote="pull"]']
          .map((s) => !!(h.querySelector(s) as HTMLButtonElement).disabled) : [];
      }
      return out;
    });

    expect(await heads()).toEqual({ changes: [false, false], history: [false, false] });

    // 시작 요청이 오가는 중과 같은 상태를 만든다 (FR-GIT-101 의 사유 하나).
    await page.evaluate(() => {
      const r = (window as any).app.gitPanel._remote();
      r._busy = true;
      r._paint();
    });
    expect(await heads()).toEqual({ changes: [true, true], history: [true, true] });

    await page.evaluate(() => {
      const r = (window as any).app.gitPanel._remote();
      r._busy = false;
      r._paint();
    });
    expect(await heads()).toEqual({ changes: [false, false], history: [false, false] });
    await expect(hist(page).locator('.git-remote-btn[data-remote="push"]')).toBeEnabled();
  });

  /**
   * **V9 는 폐기됐다** (REPO_TAB_UNIFY_SRS FR-RTU-24 / D-RTU-18).
   *
   * "리포 없음" 은 옛 Git 창의 상태였다 — 그 창은 리포를 갈아타므로 아무것도
   * 고르지 않은 순간이 있었다. Repo 창의 저장소는 **창의 루트**이므로 비어 있을
   * 수 없고(`repo` getter 가 root 를 준다) `gitPanel.setRepo(null)` 은 조기
   * 반환한다. 그 자리를 대신하는 화면은 "이 폴더는 저장소가 아니다 + git init"
   * 이며 `repo-tab.spec.ts` C2 가 검증한다 (V-RTU-24·25).
   */
});

test.describe('모바일 390px', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  /**
   * **개정 (REPO_TAB_UNIFY_SRS FR-RTU-80~82 / D-RTU-11).**
   *
   * 모바일은 사이드와 본문을 나란히 두지 않는다 — 순회의 **자리 하나**씩이다.
   * 그래서 Changes 를 재려면 첫 자리(`1/n`)로 가고, History 를 재려면 본문 자리로
   * 온다. 종전에는 사이드가 `max-width:40%` 로 눌려 있었고, 그 폭에서 커밋 버튼·
   * 원격 버튼·일괄 버튼이 경계를 넘었다 (실측) — 그 눌림을 없앤 것이 묶음 B 다.
   *
   * V13 의 "일곱 탭" 도 여섯이 된다 (FR-RTU-30·32).
   */
  test('V10·V11·V12·V13: 잘리지 않는다', async ({ page }) => {
    await init(page, 'mobile');
    await openGit(page, fx('with-remote'));
    await expect(page.locator('body')).toHaveClass(/mobile/);

    // ── 사이드 자리 (FR-RTU-80) ─────────────────────────────────────
    await page.evaluate(() => {
      const a = (window as any).app;
      a._mPaneIdx = 0;
      a.render();
    });
    await expect(changes(page).locator('.git-head-repo')).toHaveText('with-remote', { timeout: 10000 });
    await page.waitForTimeout(800);

    // V10
    const c = await overflow(page, '#area .ed-side .git-view.git-changes');
    expect(c.items).toEqual([]);
    expect(c.scrollW).toBe(c.clientW);

    // V12
    const hHead = await changes(page).locator('.git-head').evaluate((e) => e.getBoundingClientRect().height);
    expect(hHead).toBeLessThanOrEqual(78);

    // ── 본문 자리 ───────────────────────────────────────────────────
    await page.click('#m-pane-next');
    await clickGitView(page, 'history');
    await expect(hist(page).locator('.git-head-repo')).toHaveText('with-remote', { timeout: 10000 });
    await page.waitForTimeout(800);
    const h = await overflow(page, '#area .pn-body .git-view.git-history');
    expect(h.items).toEqual([]);
    expect(h.scrollW).toBe(h.clientW);

    /**
     * **V13 개정 (FR-RTU-30·33).** 옛 계약은 "일곱 탭이 전부 뷰포트 안에 있다"
     * 였고, 그 근거는 탭이 **고정**이라 사용자가 줄일 수 없다는 것이었다 —
     * 들어가지 않으면 닿을 방법이 없었다. 지금 뷰 탭은 필요할 때 열고 닫을 수
     * 있는 보통 탭이므로(FR-RTU-33) 남는 계약은 **닿을 수 있는가**다: 탭 바가
     * 가로로 스크롤되고, 그 스크롤 폭 안에 마지막 탭이 들어온다.
     */
    const tabs = await page.evaluate(() => {
      const bar = document.querySelector('#area .pn-tabs') as HTMLElement;
      const list = Array.from(document.querySelectorAll('#area .pn-tab[data-git-view]'));
      const br = bar.getBoundingClientRect();
      const last = list[list.length - 1].getBoundingClientRect();
      return {
        n: list.length,
        scrollable: bar.scrollWidth > bar.clientWidth,
        overflowX: getComputedStyle(bar).overflowX,
        // 바의 스크롤 좌표계 안에서의 마지막 탭 오른쪽 끝.
        lastRight: Math.round(last.right - br.left + bar.scrollLeft),
        scrollW: bar.scrollWidth,
      };
    });
    expect(tabs.n).toBe(GIT_VIEW_TABS);
    expect(tabs.overflowX, '탭 바가 스크롤되지 않으면 닿을 수 없는 탭이 생긴다')
      .toBe('auto');
    expect(tabs.lastRight, '마지막 탭이 스크롤 폭 밖이다').toBeLessThanOrEqual(tabs.scrollW);
  });
});

import { Page } from '@playwright/test';

import { test, expect, waitForInit as fxWaitForInit } from './fixtures';

// SIDEBAR_COLLAPSE_SRS §5 — 검증 V-SBC-*.
//
// 사이드바에 **접힘** 상태를 세운다. 접힌 사이드바는 사라지지 않고 아이콘 레일로
// 줄어든다 (§3.4).
//
// FR-SBC-7 개정(2026-09-06): **접기 버튼이 없다.** 접고 펴는 길은 둘이다 —
// 경계 손잡이를 끝까지 끄는 것과 단축키(`sidebarToggle`). 스펙 대부분은 상태
// 전이만 재므로 키를 쓴다: 그것이 두 길 중 결정적인 쪽이고, 손잡이 드래그는
// 자기 자리(SBC12·13)에서 따로 잰다.

const RAIL_W = 40;

// 키로 토글한다. 손잡이 드래그와 **같은 함수**를 부른다 (FR-SBC-7a).
async function toggleKey(page: Page) {
  await page.keyboard.press('Control+Shift+E');
  await page.waitForTimeout(60);
}

// 경계 손잡이를 끌어 접거나 편다. `to` 는 놓을 지점의 화면 x 좌표다.
async function dragHandle(page: Page, to: number) {
  const box = await page.locator('#sb-handle').boundingBox();
  if (!box) throw new Error('#sb-handle 이 없다');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(to, box.y + box.height / 2, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(80);
}
const collapsed = (page: Page) =>
  page.evaluate(() => document.documentElement.classList.contains('sb-collapsed'));
const sidebarWidth = (page: Page) =>
  page.evaluate(() => document.getElementById('sidebar')!.getBoundingClientRect().width);

async function waitForInit(page: Page, opts?: { mobile?: boolean }) {
  await fxWaitForInit(page, {
    mode: opts && opts.mobile ? 'mobile' : 'desktop',
    // 접힘은 localStorage 에 산다 (FR-SBC-4). **첫 로드에서만** 지운다 — 그냥
    // 지우면 영속(SBC3)을 재는 순간 테스트가 자기 검증 대상을 지운다.
    clearOnFirstLoad: 'sidebarCollapsed',
  });
}

test.describe('묶음 SBC — 접힘 상태와 토글 (FR-SBC-1~10)', () => {
  test('SBC1 (V-SBC-1): 토글하면 사이드바가 레일이 된다', async ({ page }) => {
    await waitForInit(page);
    expect(await collapsed(page)).toBe(false);
    expect(await sidebarWidth(page)).toBeGreaterThan(RAIL_W);

    await toggleKey(page);

    expect(await collapsed(page)).toBe(true);
    expect(await sidebarWidth(page)).toBe(RAIL_W);
  });

  // FR-SBC-2·3: 접힘은 폭을 덮지 않는다. 덮으면 펼쳤을 때 돌아갈 자리가 없다.
  test('SBC2 (V-SBC-2): 펼치면 접기 전 폭으로 돌아간다', async ({ page }) => {
    await waitForInit(page);
    await page.evaluate(() => {
      document.documentElement.style.setProperty('--sb-w', '250px');
      (window as any).app.ws.sidebarWidth = 250;
    });
    expect(await sidebarWidth(page)).toBe(250);

    await toggleKey(page);
    expect(await sidebarWidth(page)).toBe(RAIL_W);
    // 폭 자체는 살아 있어야 한다 — 레일은 그 위에 얹힌 별개 상태다.
    expect(await page.evaluate(() => (window as any).app.ws.sidebarWidth)).toBe(250);

    await toggleKey(page);
    expect(await sidebarWidth(page)).toBe(250);
  });

  // FR-SBC-5: 첫 프레임부터 접힌 채로 그린다. 클래스를 붙이는 자리가 인라인
  // 스크립트여야 하는 이유이며, 스크립트 로드 뒤로 미루면 한 번 펄럭인다.
  test('SBC3 (V-SBC-3): 접은 채 새로고침해도 접힌 채로 뜬다', async ({ page }) => {
    await waitForInit(page);
    await toggleKey(page);
    expect(await page.evaluate(() => localStorage.getItem('sidebarCollapsed'))).toBe('1');

    await page.reload();
    await page.waitForSelector('#sidebar', { timeout: 15000 });
    expect(await collapsed(page)).toBe(true);
    expect(await sidebarWidth(page)).toBe(RAIL_W);
  });

  /**
   * FR-SBC-7 개정: 버튼이 없다 — 그 자리를 손잡이가 대신한다.
   *
   * 폭을 줄이다 임계(`SIDEBAR_COLLAPSE_AT_PX`) 아래로 끌면 접히고, 접힌 경계를
   * 오른쪽으로 끌면 펼쳐진다. 두 방향을 한 테스트에서 잰다 — 되돌아오지 못하면
   * 그것은 접기가 아니라 잠그기다.
   */
  test('SBC4 (V-SBC-11): 손잡이를 끝까지 끌면 접히고, 되돌리면 펼쳐진다', async ({ page }) => {
    await waitForInit(page);
    expect(await collapsed(page)).toBe(false);

    // 화면 왼쪽 끝까지 끈다 — 임계 아래다.
    await dragHandle(page, 8);
    expect(await collapsed(page)).toBe(true);
    expect(await sidebarWidth(page)).toBe(RAIL_W);

    // 접힌 경계를 오른쪽으로 끌면 다시 펼쳐진다.
    await dragHandle(page, 220);
    expect(await collapsed(page)).toBe(false);
    expect(await sidebarWidth(page)).toBeGreaterThan(RAIL_W);
  });

  // 임계를 넘지 않는 드래그는 **폭만** 바꾼다 — 좁히려던 손이 접어 버리면 안 된다.
  test('SBC4b (V-SBC-11): 임계 위에서는 접히지 않는다', async ({ page }) => {
    await waitForInit(page);
    await dragHandle(page, 150);
    expect(await collapsed(page)).toBe(false);
    expect(await sidebarWidth(page)).toBeGreaterThanOrEqual(100);
  });
});

test.describe('묶음 SBC — 레일의 구성 (FR-SBC-11~16)', () => {
  test('SBC5 (V-SBC-4): 레일에는 탭 아이콘과 하단 버튼만 남는다', async ({ page }) => {
    await waitForInit(page);
    await toggleKey(page);

    // 목록과 액션 버튼 행은 숨는다 — 40px 에서 읽히지 않는다 (FR-SBC-11).
    await expect(page.locator('#sb-panel-windows')).toBeHidden();
    // 탭은 남되 라벨 대신 아이콘이다 (FR-SBC-12·13).
    await expect(page.locator('.sb-tab[data-panel="windows"] .sb-tab-icon')).toBeVisible();
    await expect(page.locator('.sb-tab[data-panel="windows"] .sb-tab-label')).toBeHidden();
    // 어느 탭에서나 닿아야 하는 두 버튼은 그대로다 (FR-SBC-15).
    await expect(page.locator('#soft-reload-btn')).toBeVisible();
    await expect(page.locator('#settings-btn')).toBeVisible();
  });

  // FR-SBC-15: 펼침에서 이 행을 아래로 미는 것은 `.sb-panel` 의 `flex:1 1 auto`
  // 인데 레일에서는 그 패널이 숨는다 — 미는 힘을 레일이 따로 세우지 않으면
  // `⟳`·`⚙` 가 탭 바로 아래로 딸려 올라간다.
  test('SBC5b (V-SBC-4): 레일에서도 하단 버튼은 최하단에 남는다', async ({ page }) => {
    await waitForInit(page);
    await toggleKey(page);
    const gap = await page.evaluate(() => {
      const sb = document.getElementById('sidebar')!.getBoundingClientRect();
      const bottom = document.getElementById('sb-bottom')!.getBoundingClientRect();
      return sb.bottom - bottom.bottom;
    });
    // `#sb-bottom` 의 아래 여백(8px)만큼만 떠 있어야 한다.
    expect(gap).toBeLessThanOrEqual(12);
  });

  // FR-SBC-16 (개정): 핸들은 접힘에서도 남는다 — **그것이 펼치는 길**이기 때문이다.
  // 종전에는 감췄고, 그때는 펼치는 버튼이 탑바에 있었다.
  test('SBC6 (V-SBC-8): 접힘에서도 경계는 남고, 레일 폭은 고정이다', async ({ page }) => {
    await waitForInit(page);
    await expect(page.locator('#sb-handle')).toBeVisible();
    await toggleKey(page);
    await expect(page.locator('#sb-handle')).toBeVisible();
    expect(await sidebarWidth(page)).toBe(RAIL_W);
  });

  test('SBC7: 펼침에서는 아이콘이 아니라 라벨이 이름을 말한다', async ({ page }) => {
    await waitForInit(page);
    await expect(page.locator('.sb-tab[data-panel="windows"] .sb-tab-label')).toBeVisible();
    await expect(page.locator('.sb-tab[data-panel="windows"] .sb-tab-icon')).toBeHidden();
  });
});

test.describe('묶음 SBC — 레일에서의 탭 전환 (FR-SBC-17·18)', () => {
  // FR-SBC-17 (개정): 레일에서의 클릭은 **전환만 한다.** 접어 둔 것은 접어 두려는
  // 뜻이고, 펼치는 손잡이는 경계에 따로 있다.
  test('SBC8 (V-SBC-5): 다른 탭의 아이콘을 눌러도 접힌 채로 전환한다', async ({ page }) => {
    await waitForInit(page);
    await toggleKey(page);
    expect(await collapsed(page)).toBe(true);

    await page.locator('.sb-tab[data-panel="repo"]').click();

    expect(await page.evaluate(() => (window as any).app._sbTab)).toBe('repo');
    expect(await collapsed(page)).toBe(true);
  });

  test('SBC9 (V-SBC-6): 이미 활성인 탭의 아이콘은 아무것도 바꾸지 않는다', async ({ page }) => {
    await waitForInit(page);
    const active = await page.evaluate(() => (window as any).app._sbTab);
    await toggleKey(page);
    expect(await collapsed(page)).toBe(true);

    await page.locator(`.sb-tab[data-panel="${active}"]`).click();

    expect(await page.evaluate(() => (window as any).app._sbTab)).toBe(active);
    expect(await collapsed(page)).toBe(true);
  });
});

test.describe('묶음 SBC — 부수 효과 (FR-SBC-19·20)', () => {
  // FR-SBC-19: 사이드바 폭이 바뀌면 터미널의 열 수가 바뀐다. 드래그 리사이즈가
  // 끝날 때와 같은 일을 해야 한다.
  test('SBC10 (V-SBC-9): 접고 펼칠 때 보이는 터미널을 다시 맞춘다', async ({ page }) => {
    await waitForInit(page);
    await page.evaluate(() => {
      const app = (window as any).app;
      (window as any).__fits = 0;
      for (const p of app.tools.values()) {
        const orig = p.doFit.bind(p);
        p.doFit = () => { (window as any).__fits++; return orig() };
      }
    });

    await toggleKey(page);
    expect(await page.evaluate(() => (window as any).__fits)).toBeGreaterThan(0);

    const afterCollapse = await page.evaluate(() => (window as any).__fits);
    await toggleKey(page);
    expect(await page.evaluate(() => (window as any).__fits)).toBeGreaterThan(afterCollapse);
  });

  // FR-SBC-18 이 no-op 을 요구하는 자리다 — 이미 펼쳐진 사이드바에 재적합을 걸
  // 이유가 없다. 레일의 활성 탭 클릭(SBC9)이 이 경로를 탄다.
  test('SBC11: 상태가 그대로면 아무 일도 하지 않는다', async ({ page }) => {
    await waitForInit(page);
    await page.evaluate(() => {
      const app = (window as any).app;
      (window as any).__fits = 0;
      for (const p of app.tools.values()) {
        const orig = p.doFit.bind(p);
        p.doFit = () => { (window as any).__fits++; return orig() };
      }
      app._setSidebarCollapsed(false);
    });
    expect(await page.evaluate(() => (window as any).__fits)).toBe(0);
  });

  // FR-SBC-20: 모바일에서 사이드바는 드로어이고 여는 손잡이를 `#m-drawer-toggle`
  // 이 이미 갖고 있다. 두 규약이 겹치면 드로어를 연 채 접힌 상태가 된다.
  test('SBC12 (V-SBC-10): 모바일에서는 경계 손잡이가 없고 드로어만 있다', async ({ page }) => {
    await waitForInit(page, { mobile: true });
    // 접기 버튼은 아예 없어졌다 (FR-SBC-7 개정). 모바일에서 남는 것은 드로어다.
    await expect(page.locator('#sidebar-toggle')).toHaveCount(0);
    await expect(page.locator('#sb-handle')).toBeHidden();
    await expect(page.locator('#m-drawer-toggle')).toBeVisible();
  });

  test('SBC13 (V-SBC-10): 모바일에서는 접힘 규칙이 걸리지 않는다', async ({ page }) => {
    await waitForInit(page, { mobile: true });
    await page.evaluate(() => (window as any).app._setSidebarCollapsed(true));
    // 클래스는 붙되 드로어의 폭(전체 폭)은 그대로다 — 규칙이 `body:not(.mobile)`
    // 로 한정돼 있기 때문이다.
    expect(await collapsed(page)).toBe(true);
    expect(await sidebarWidth(page)).toBeGreaterThan(RAIL_W);
  });
});

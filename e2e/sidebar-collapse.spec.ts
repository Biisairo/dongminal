import { Page } from '@playwright/test';

import { test, expect, waitForInit as fxWaitForInit, nextFrames } from './fixtures';

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
  // 접힘은 클래스 하나로 드러난다 — 그림이 한 바퀴 돌면 그 클래스가 선다.
  // (토글이므로 "어느 쪽" 인지는 호출부가 안다 — 여기서는 반영만 기다린다.)
  await nextFrames(page);
}

// 경계 손잡이를 끌어 접거나 편다. `to` 는 놓을 지점의 화면 x 좌표다.
async function dragHandle(page: Page, to: number) {
  const box = await page.locator('#sb-handle').boundingBox();
  if (!box) throw new Error('#sb-handle 이 없다');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(to, box.y + box.height / 2, { steps: 8 });
  await page.mouse.up();
  await nextFrames(page);
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

    // FR-SBC-11 개정 (PANEL_SURFACE_SRS FR-RAL-1): 목록은 **남는다.** 숨는 것은
    // 40px 에 들어가지 않는 것 — 액션 버튼 행 — 뿐이다.
    await expect(page.locator('#sb-panel-windows')).toBeVisible();
    await expect(page.locator('#sb-panel-windows .sb-actions')).toBeHidden();
    // 탭은 남되 라벨 대신 아이콘이다 (FR-SBC-12·13).
    await expect(page.locator('.sb-tab[data-panel="windows"] .sb-tab-icon')).toBeVisible();
    await expect(page.locator('.sb-tab[data-panel="windows"] .sb-tab-label')).toBeHidden();
    // 어느 탭에서나 닿아야 하는 두 버튼은 그대로다 (FR-SBC-15).
    await expect(page.locator('#soft-reload-btn')).toBeVisible();
    await expect(page.locator('#settings-btn')).toBeVisible();
  });

  // FR-SBC-15 / FR-RAL-8: 이 행을 아래로 미는 것은 `.sb-panel` 의 `flex:1 1 auto`
  // 다. 레일에서도 그 패널이 남으므로(FR-RAL-1) 미는 힘은 살아 있지만, 목록이
  // 비어 패널이 자연 높이로 줄어드는 순간에도 `⟳`·`⚙` 는 바닥이어야 한다.
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

    expect(await page.evaluate(() => (window as any).app.testing.sbTab)).toBe('repo');
    expect(await collapsed(page)).toBe(true);
  });

  test('SBC9 (V-SBC-6): 이미 활성인 탭의 아이콘은 아무것도 바꾸지 않는다', async ({ page }) => {
    await waitForInit(page);
    const active = await page.evaluate(() => (window as any).app.testing.sbTab);
    await toggleKey(page);
    expect(await collapsed(page)).toBe(true);

    await page.locator(`.sb-tab[data-panel="${active}"]`).click();

    expect(await page.evaluate(() => (window as any).app.testing.sbTab)).toBe(active);
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
      app.testing.setSidebarCollapsed(false);
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
    await page.evaluate(() => (window as any).app.testing.setSidebarCollapsed(true));
    // 클래스는 붙되 드로어의 폭(전체 폭)은 그대로다 — 규칙이 `body:not(.mobile)`
    // 로 한정돼 있기 때문이다.
    expect(await collapsed(page)).toBe(true);
    expect(await sidebarWidth(page)).toBeGreaterThan(RAIL_W);
  });
});

/**
 * PANEL_SURFACE_SRS §3.2 — 레일의 목록 (FR-RAL-1~10 · 검증 V-6·V-7).
 *
 * 요구 ④ "좌측 패널 줄였을 때도 리스트가 보이도록하고싶다." 접힘은 목록을 감추는
 * 일이 아니라 **40px 에 들어가지 않는 것을 걷어 내는** 일이 된다.
 */
test.describe('묶음 RAL — 레일의 목록 (FR-RAL-1~10)', () => {
  // 레일에서도 행이 보이고, 남는 것은 점과 첫 글자다 (FR-RAL-1·2).
  test('RAL1 (V-6): 레일에서도 목록 행이 보이고 40px 안에 든다', async ({ page }) => {
    await waitForInit(page);
    const row = page.locator('#windows .si').first();
    await expect(row).toBeVisible();

    await toggleKey(page);

    await expect(row).toBeVisible();
    const box = await row.boundingBox();
    expect(box!.width).toBeLessThanOrEqual(RAIL_W);
    // FR-RAL-2 (개정): 남는 것은 **이름**이다 — 첫 글자가 아니다.
    await expect(row.locator('.sbl-name')).toBeVisible();
    // ×·배지는 자리를 내준다.
    await expect(row.locator('.sbl-x')).toBeHidden();
  });

  /**
   * RAL1b (FR-RAL-2 개정): 레일의 이름은 **줄여서 두 줄까지** 서고, 모든 행이
   * 같은 크기다. 한 행만 커지면 목록이 계단처럼 보인다 (사용자 지시).
   */
  test('RAL1b (FR-RAL-2): 레일의 이름은 작은 글자로 두 줄까지 서고 크기가 한 벌이다',
    async ({ page }) => {
      await waitForInit(page);
      // 두 줄을 넘겨 `…` 가 설 만큼 긴 이름을 하나 둔다.
      await page.evaluate(() => {
        const a = (window as any).app;
        a.testing.plainWindows()[0].name = '아주아주긴이름을가진창하나';
        a.render();
      });
      await page.locator('#add-window').click();
      await expect(page.locator('#windows .si')).toHaveCount(2, { timeout: 10000 });
      await toggleKey(page);

      const m = await page.evaluate(() => {
        const rows = [...document.querySelectorAll('#windows .si')] as HTMLElement[];
        return rows.map((r) => {
          const n = r.querySelector('.sbl-name') as HTMLElement;
          const cs = getComputedStyle(n);
          return {
            fs: cs.fontSize, clamp: cs.webkitLineClamp,
            w: n.getBoundingClientRect().width,
            rowW: r.getBoundingClientRect().width,
            lines: Math.round(n.scrollHeight / parseFloat(cs.lineHeight)),
          };
        });
      });
      // 크기가 한 벌이다 — 행마다 다르면 그 자체가 결함이다.
      expect(new Set(m.map((x) => x.fs)).size, '행마다 글자 크기가 다르다').toBe(1);
      // 펼침(12px)보다 작다 — 그래야 26px 폭에 여러 글자가 든다.
      expect(parseFloat(m[0].fs)).toBeLessThan(12);
      // 두 줄까지다. 넘치면 마지막 줄 끝에 `…` 가 선다.
      expect(m[0].clamp).toBe('2');
      for (const x of m) expect(x.rowW).toBeLessThanOrEqual(RAIL_W);
      // 한 글자보다 넓다 — 첫 글자만 남던 종전과 갈리는 자리다.
      expect(m[0].w).toBeGreaterThan(parseFloat(m[0].fs) * 1.5);
    });

  // FR-RAL-3: 두 줄에도 들지 않는 이름에 닿는 유일한 길이다. 이름을 줄여 싣게
  // 된 지금도(FR-RAL-2 개정) 이 길은 남는다 — 접힌 글자는 여전히 잘릴 수 있다.
  test('RAL2 (FR-RAL-3): 전체 이름은 title 로 닿는다', async ({ page }) => {
    await waitForInit(page);
    await toggleKey(page);
    const name = await page.evaluate(() => (window as any).app.testing.plainWindows()[0].name);
    const row = page.locator('#windows .si').first();
    await expect(row).toHaveAttribute('title', name);
    // 화면의 글자도 **전체 이름**이다 — 잘리는 일은 CSS 가 한다.
    await expect(row.locator('.sbl-name')).toHaveText(name);
  });

  /**
   * FR-RAL-5: 행을 누르면 그 항목이 열리고, 사이드바는 **접힌 채로** 남는다 —
   * 접어 둔 것은 접어 두려는 뜻이다 (FR-SBC-17·18 의 판단 그대로).
   */
  test('RAL3 (V-6): 레일의 행을 누르면 창이 바뀌고 접힘이 유지된다', async ({ page }) => {
    await waitForInit(page);
    // 옮겨 갈 곳이 있어야 "열렸다" 가 증거가 된다.
    await page.locator('#add-window').click();
    await expect(page.locator('#windows .si')).toHaveCount(2, { timeout: 10000 });
    const [first, second] = await page.evaluate(() =>
      (window as any).app.testing.plainWindows().map((s: any) => s.id).slice(0, 2));
    await page.evaluate((id) => (window as any).app.switchWindow(id), first);

    await toggleKey(page);
    await page.locator(`#windows .si[data-sid="${second}"]`).click();

    expect(await page.evaluate(() => (window as any).app.ws.activeWindow)).toBe(second);
    expect(await collapsed(page)).toBe(true);
  });

  // FR-RAL-4: 표시는 펼친 목록과 **같은 클래스**다 — 색과 맥박이 두 벌이 되지 않는다.
  test('RAL4 (V-7): 알람이 걸린 창의 레일 행이 `.attn` 을 갖는다', async ({ page }) => {
    await waitForInit(page);
    await toggleKey(page);
    const sid = await page.evaluate(() => {
      const app = (window as any).app;
      const s = app.testing.plainWindows()[0];
      const ids: string[] = [];
      const walk = (n: any) => {
        if (!n) return;
        if (n.type === 'pane') (n.tabs || []).forEach((t: any) => t.toolId && ids.push(t.toolId));
        (n.children || []).forEach(walk);
      };
      walk(s.layout);
      app.testing.attn.set(ids[0], { reason: 'test' });
      app.testing.attnRefresh();
      return s.id;
    });
    await expect(page.locator(`#windows .si[data-sid="${sid}"]`)).toHaveClass(/attn/);
  });

  /**
   * FR-RAL-9: 40px 폭에서 위/아래 절반을 가르는 판정은 실패하기 쉽다. CSS 로는
   * 막을 수 없으므로 제스처의 **출발점**에서 끊는다 — 펼침에서는 그대로 시작한다.
   */
  test('RAL5 (FR-RAL-9): 레일에서는 재배치가 시작되지 않는다', async ({ page }) => {
    await waitForInit(page);
    const dragStart = () => page.evaluate(() => {
      const app = (window as any).app;
      app.testing.drag = null;
      const el = document.querySelector('#windows .si') as HTMLElement;
      const e = new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: new DataTransfer() });
      el.dispatchEvent(e);
      const started = !!app.testing.drag;
      app.testing.drag = null;
      return { started, prevented: e.defaultPrevented };
    });

    expect(await dragStart()).toEqual({ started: true, prevented: false });

    await toggleKey(page);
    expect(await dragStart()).toEqual({ started: false, prevented: true });
  });

  // FR-RAL-8: 넘치면 목록만 스크롤한다. `⟳`·`⚙` 의 자리는 SBC5b 가 이미 잰다.
  test('RAL6 (FR-RAL-8): 레일에서도 목록만 세로로 스크롤한다', async ({ page }) => {
    await waitForInit(page);
    await toggleKey(page);
    const ov = await page.evaluate(() =>
      getComputedStyle(document.getElementById('windows')!).overflowY);
    expect(ov).toBe('auto');
  });

  /**
   * FR-RAL-7: 배지(변경 수·샌드박스)는 숫자를 40px 에 넣지 않고 **점의 색**으로
   * 축약된다. 배지를 실제로 띄우려면 저장소가 필요하므로, 여기서 재는 것은
   * 그 축약을 성립시키는 규칙이다 — 행에 붙는 클래스와 점의 색.
   */
  test('RAL7 (FR-RAL-7): 배지가 있는 행은 레일에서 점의 색이 바뀐다', async ({ page }) => {
    await waitForInit(page);
    await toggleKey(page);
    const { plain, badged } = await page.evaluate(() => {
      const row = document.querySelector('#windows .si') as HTMLElement;
      const dot = row.querySelector('.sbl-dot') as HTMLElement;
      // 활성 행은 이미 accent 다 — 축약이 더할 것이 없는 자리이므로 비켜 둔다.
      row.classList.remove('active');
      const plain = getComputedStyle(dot).backgroundColor;
      row.classList.add('has-badge');
      const badged = getComputedStyle(dot).backgroundColor;
      return { plain, badged };
    });
    expect(badged).not.toBe(plain);
  });

  // FR-RAL-10: 접힘은 데스크톱의 것이다. 모바일의 사이드바는 드로어이고, 그
  // 클래스가 붙어도 목록은 펼침 그대로다 (SBC13 이 폭에 대해 재는 것과 같은 경계).
  test('RAL8 (FR-RAL-10): 모바일에서는 레일 규약이 걸리지 않는다', async ({ page }) => {
    await waitForInit(page, { mobile: true });
    await page.evaluate(() => (window as any).app.testing.setSidebarCollapsed(true));
    expect(await page.evaluate(() => (window as any).app.testing.sbRail())).toBe(false);
    const d = await page.evaluate(() => {
      const row = document.querySelector('#windows .si') as HTMLElement;
      const cs = getComputedStyle(row.querySelector('.sbl-name')!);
      return { display: cs.display, fs: cs.fontSize, rowFs: getComputedStyle(row).fontSize };
    });
    expect(d.display).not.toBe('none');
    // 레일의 작은 글자(`--sb-rail-fs`)가 아니라 행에서 물려받은 크기 그대로다.
    // 값을 적지 않는 이유는 모바일이 자기 크기를 갖기 때문이다
    // (`body.mobile .sbl-item`) — 재려는 것은 **레일 규칙이 걸리지 않았다** 이다.
    expect(d.fs).toBe(d.rowFs);
  });
});

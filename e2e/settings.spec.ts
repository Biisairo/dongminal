import { test, expect } from './fixtures';

async function waitForInit(page) {
  await page.context().addInitScript(() => {
    sessionStorage.setItem('displayMode', 'desktop');
  });
  await page.goto('/');
  await page.waitForSelector('#area .pn.focused .xterm-helper-textarea', { timeout: 15000 });
}

test.describe('Settings & configuration', () => {
  test('settings modal opens and closes', async ({ page }) => {
    await waitForInit(page);
    await page.click('#settings-btn');
    await expect(page.locator('#modal-overlay')).toBeVisible();
    await page.click('#modal-close');
    await expect(page.locator('#modal-overlay')).not.toBeVisible();
  });

  test('shortcuts tab shows key bindings', async ({ page }) => {
    await waitForInit(page);
    await page.click('#settings-btn');
    await expect(page.locator('#modal-overlay')).toBeVisible();

    await page.click('button.mtab[data-tab="shortcuts"]');
    await expect(page.locator('#panel-shortcuts')).toBeVisible();

    // At least one shortcut entry should exist.
    const entryCount = await page.locator('#panel-shortcuts .sc-row').count();
    expect(entryCount).toBeGreaterThan(0);

    await page.click('#modal-close');
  });

  test('statusbar tab shows options', async ({ page }) => {
    await waitForInit(page);
    await page.click('#settings-btn');
    await expect(page.locator('#modal-overlay')).toBeVisible();

    await page.click('button.mtab[data-tab="statusbar"]');
    await expect(page.locator('#panel-statusbar')).toBeVisible();

    // At least one status-bar settings row should exist.
    const sbsCount = await page.locator('#panel-statusbar .sbs-row').count();
    expect(sbsCount).toBeGreaterThan(0);

    await page.click('#modal-close');
  });

  test('theme persists after refresh', async ({ page }) => {
    await waitForInit(page);
    await page.click('#settings-btn');
    await expect(page.locator('#theme-list')).toBeVisible();

    // Click second theme.
    const themeItems = page.locator('#theme-list .tl-item');
    await themeItems.nth(1).click();

    const beforeRefresh = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--bg').trim()
    );

    await page.click('#modal-close');
    await page.reload();
    await waitForInit(page);

    const afterRefresh = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--bg').trim()
    );
    expect(afterRefresh).toBe(beforeRefresh);
  });
});

// EDITOR_TAB_SRS FR-EDT-55 — 프리셋의 대상은 **일반 창**이다.
//
// Editor 창은 pane 이 없는 것이 정상이므로 그 layout(null)을 저장하면, 불러오기가
// `_mkWindow` 로 만든 창의 layout 을 null 로 덮어써 그 창이 다음 로드의 창
// 필터에 지워지고 도구(PTY)만 남는다.
test.describe('레이아웃 프리셋과 Editor 창', () => {
  // 프리셋은 서버 설정에 산다 — 다른 스펙에 흘리지 않도록 매번 비운다.
  test.afterEach(async ({ page }) => {
    await page.evaluate(() => {
      const a = (window as any).app;
      (window as any).layoutPresets.length = 0;
      a._saveSettings();
      a._renderPresets();
    }).catch(() => { /* 페이지가 이미 닫혔으면 할 일이 없다 */ });
  });

  test('Editor 창이 활성이어도 layout:null 이 저장되지 않는다', async ({ page }) => {
    await waitForInit(page);
    const got = await page.evaluate(() => {
      const a = (window as any).app;
      (window as any).layoutPresets.length = 0;
      const ed = a._edWindows()[0];
      a.switchWindow(ed.id);
      a._savePreset();
      const list = (window as any).layoutPresets;
      return {
        activeIsEditor: a._isEditorWin(a._aw()),
        edHasLayout: !!ed.layout,
        count: list.length,
        layouts: list.map((p: any) => p.layout),
      };
    });
    // 전제 — 활성 창이 Editor 창이고 그 창에는 pane 이 없다 (FR-EDT-55).
    expect(got.activeIsEditor).toBe(true);
    expect(got.edHasLayout).toBe(false);
    // 저장됐다면 그것은 일반 창의 것이다. layout:null 은 남지 않는다.
    expect(got.layouts.every((l: unknown) => l !== null)).toBe(true);
    expect(got.count).toBe(1);
  });

  test('저장할 일반 창이 없으면 저장하지 않고 사유를 남긴다', async ({ page }) => {
    await waitForInit(page);
    const got = await page.evaluate(() => {
      const a = (window as any).app;
      (window as any).layoutPresets.length = 0;
      const ed = a._edWindows()[0];
      a.switchWindow(ed.id);
      // 일반 창이 하나도 없는 상태는 delWindow 의 과도 상태뿐이므로 그 자리를
      // 대신 세운다 — 재는 것은 "대상이 없을 때의 처신" 이다.
      const real = a._plainWindows;
      a._plainWindows = () => [];
      a._savePreset();
      a._plainWindows = real;
      const msg = document.querySelector('#panel-presets .preset-msg');
      return { count: (window as any).layoutPresets.length, msg: msg ? msg.textContent : '' };
    });
    expect(got.count).toBe(0);
    expect(got.msg).toBeTruthy();
  });

  test('layout 이 빈 프리셋을 불러와도 창이 고아가 되지 않는다', async ({ page }) => {
    await waitForInit(page);
    const got = await page.evaluate(async () => {
      const a = (window as any).app;
      (window as any).layoutPresets.length = 0;
      // 개정 이전에 저장된 프리셋이 이 모양이다.
      (window as any).layoutPresets.push({ name: '빈 프리셋', layout: null });
      const before = a.ws.windows.map((w: any) => w.id);
      await a._loadPreset(0);
      const w = a._aw();
      return {
        isNew: !before.includes(w.id),
        hasLayout: !!w.layout,
        // 창 필터(FR-EDT-49)를 그대로 태운다 — 여기서 지워지면 도구만 남는다.
        survives: a.ws.windows.filter((s: any) => s && (s.layout || a._isEditorWin(s)))
          .some((s: any) => s.id === w.id),
      };
    });
    expect(got.isNew).toBe(true);
    expect(got.hasLayout).toBe(true);
    expect(got.survives).toBe(true);
  });
});

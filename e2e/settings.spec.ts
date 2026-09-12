import { test, expect, waitForInit } from './fixtures';

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
      a.testing.saveSettings();
      a.testing.renderPresets();
    }).catch(() => { /* 페이지가 이미 닫혔으면 할 일이 없다 */ });
  });

  test('Editor 창이 활성이어도 layout:null 이 저장되지 않는다', async ({ page }) => {
    await waitForInit(page);
    const got = await page.evaluate(() => {
      const a = (window as any).app;
      (window as any).layoutPresets.length = 0;
      const ed = a.testing.edWindows()[0];
      a.switchWindow(ed.id);
      a.testing.savePreset();
      const list = (window as any).layoutPresets;
      return {
        activeIsEditor: a.testing.isEditorWin(a.testing.aw()),
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
      const ed = a.testing.edWindows()[0];
      a.switchWindow(ed.id);
      // 일반 창이 하나도 없는 상태는 delWindow 의 과도 상태뿐이므로 그 자리를
      // 대신 세운다 — 재는 것은 "대상이 없을 때의 처신" 이다.
      const real = a.testing.plainWindows;
      a.testing.plainWindows = () => [];
      a.testing.savePreset();
      a.testing.plainWindows = real;
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
      await a.testing.loadPreset(0);
      const w = a.testing.aw();
      return {
        isNew: !before.includes(w.id),
        hasLayout: !!w.layout,
        // 창 필터(FR-EDT-49)를 그대로 태운다 — 여기서 지워지면 도구만 남는다.
        survives: a.ws.windows.filter((s: any) => s && (s.layout || a.testing.isEditorWin(s)))
          .some((s: any) => s.id === w.id),
      };
    });
    expect(got.isNew).toBe(true);
    expect(got.hasLayout).toBe(true);
    expect(got.survives).toBe(true);
  });
});

// PAGE_TITLE_SRS — Settings ▸ Display 의 `페이지 제목`.
//
// 값이 서버 설정 blob 에 살므로(D-1) 스펙 사이에 남는다 — 매번 되돌린다.
test.describe('페이지 제목', () => {
  const TITLE = '작업 서버';

  async function openDisplayPanel(page) {
    await waitForInit(page);
    await page.click('#settings-btn');
    await page.click('button.mtab[data-tab="display"]');
    await expect(page.locator('#panel-display')).toBeVisible();
  }

  // 저장은 입력이 멎은 뒤에 나간다 (FR-PGT-5) — 그 PUT 을 기다린다.
  async function setTitle(page, value: string) {
    const saved = page.waitForResponse(
      r => r.url().includes('/api/settings') && r.request().method() === 'PUT'
    );
    await page.fill('#ds-title', value);
    await saved;
  }

  test.afterEach(async ({ request }) => {
    const r = await request.get('/api/settings');
    const saved = r.ok() ? await r.json() : {};
    delete saved.pageTitle;
    await request.put('/api/settings', { data: saved });
  });

  // V-PGT-1 · V-PGT-2
  test('바꾼 제목이 즉시 반영되고 새로고침 뒤에도 남는다', async ({ page }) => {
    await openDisplayPanel(page);
    await setTitle(page, TITLE);
    await expect(page).toHaveTitle(new RegExp(TITLE + '$'));

    await page.click('#modal-close');
    await page.reload();
    await waitForInit(page);
    await expect(page).toHaveTitle(new RegExp(TITLE + '$'));
    // 모달을 다시 열면 그 값이 입력에 서 있다 (FR-PGT-3).
    await page.click('#settings-btn');
    await page.click('button.mtab[data-tab="display"]');
    await expect(page.locator('#ds-title')).toHaveValue(TITLE);
  });

  // V-PGT-3: 비어 있음이 곧 기본 이름이다 (D-2).
  test('비우면 기본 이름으로 돌아간다', async ({ page }) => {
    await openDisplayPanel(page);
    await setTitle(page, TITLE);
    await setTitle(page, '');
    await expect(page).toHaveTitle(/Dongminal$/);

    await page.reload();
    await waitForInit(page);
    await expect(page).toHaveTitle(/Dongminal$/);
  });

  // V-PGT-4: PUT 이 blob 전체를 갈아치우므로, 다른 설정을 건드리면 조용히
  // 사라질 수 있는 자리다 (SRS §2.3).
  test('다른 설정을 바꿔도 제목이 살아남는다', async ({ page, request }) => {
    await openDisplayPanel(page);
    await setTitle(page, TITLE);

    await page.click('button.mtab[data-tab="theme"]');
    const themeSaved = page.waitForResponse(
      r => r.url().includes('/api/settings') && r.request().method() === 'PUT'
    );
    await page.locator('#theme-list .tl-item').nth(1).click();
    await themeSaved;

    const saved = await (await request.get('/api/settings')).json();
    expect(saved.pageTitle).toBe(TITLE);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// UI_KIT_SRS FR-UIK-14 / V-10a — 설정 모달은 가로로 스크롤하지 않는다.
//
// 종전에는 탭 열이 682px 라 580px 상자에서 가로로 밀렸고(Backup 이 화면 밖),
// 390px 기기에서는 상자 자신이 뷰포트를 넘었다.
test.describe('설정 모달의 가로 (FR-UIK-14)', () => {
  const TABS = ['theme', 'shortcuts', 'statusbar', 'polling', 'presets',
    'display', 'code', 'notify', 'sandbox', 'backup'];

  test('UIK14a: 어느 탭에서도 본문이 가로로 넘치지 않는다', async ({ page }) => {
    await waitForInit(page);
    await page.click('#settings-btn');
    await expect(page.locator('#modal')).toBeVisible();
    for (const t of TABS) {
      await page.click(`button.mtab[data-tab="${t}"]`);
      const over = await page.evaluate(() => {
        const b = document.querySelector('.modal-body') as HTMLElement;
        return b.scrollWidth - b.clientWidth;
      });
      expect(over, `${t} 탭에서 본문이 가로로 넘친다`).toBe(0);
    }
  });

  test('UIK14b: 탭 열이 한 줄로 서고 가로로 밀리지 않는다', async ({ page }) => {
    await waitForInit(page);
    await page.click('#settings-btn');
    await expect(page.locator('#modal')).toBeVisible();
    const tabs = await page.evaluate(() => {
      const el = document.querySelector('.modal-tabs') as HTMLElement;
      const rows = new Set([...el.children].map(c => Math.round(c.getBoundingClientRect().top)));
      return { over: el.scrollWidth - el.clientWidth, rows: rows.size };
    });
    expect(tabs.over, '탭 열이 가로로 밀린다').toBe(0);
    expect(tabs.rows, '탭 열이 한 줄이 아니다').toBe(1);
  });

  test('UIK14c: 좁은 뷰포트에서 상자가 화면 안에 든다', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await waitForInit(page);
    await page.click('#settings-btn');
    await expect(page.locator('#modal')).toBeVisible();
    const fit = await page.evaluate(() => {
      const r = (document.getElementById('modal') as HTMLElement).getBoundingClientRect();
      const b = document.querySelector('.modal-body') as HTMLElement;
      return { left: r.left, right: r.right, vw: window.innerWidth,
        bodyOver: b.scrollWidth - b.clientWidth,
        docOver: document.documentElement.scrollWidth - document.documentElement.clientWidth };
    });
    expect(fit.left).toBeGreaterThanOrEqual(0);
    expect(fit.right).toBeLessThanOrEqual(fit.vw);
    expect(fit.bodyOver).toBe(0);
    expect(fit.docOver, '문서가 가로로 넘친다').toBe(0);
  });

  // FR-UIK-13: 스크롤은 본문 하나다 — 상태바 패널이 자기 `max-height` 를 들고
  // 있었다.
  test('UIK14d: 상태바 패널이 자기 스크롤을 갖지 않는다', async ({ page }) => {
    await waitForInit(page);
    await page.click('#settings-btn');
    await page.click('button.mtab[data-tab="statusbar"]');
    await expect(page.locator('#panel-statusbar')).toBeVisible();
    const own = await page.evaluate(() => {
      const el = document.getElementById('sb-settings') as HTMLElement;
      return { over: el.scrollHeight - el.clientHeight, oy: getComputedStyle(el).overflowY };
    });
    expect(own.over, '상태바 패널이 스스로 스크롤한다').toBe(0);
  });
});

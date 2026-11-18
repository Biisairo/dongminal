import { test, expect, waitForInit } from './fixtures';

test.describe('Settings & configuration', () => {
  test('settings modal opens and closes', async ({ page }) => {
    await waitForInit(page);
    await page.click('#settings-btn');
    await expect(page.locator('#modal-overlay')).toBeVisible();
    await page.click('#modal-close');
    await expect(page.locator('#modal-overlay')).not.toBeVisible();
  });

  /**
   * OPTIMIZE_REFACTOR_SRS FR-OPT-16-2 (FEC-36): 패널과 `#custom-editor` 의 숨김은
   * `[hidden]` 하나다 (UI_LAYOUT_DEFAULTS_SRS FR-LAY-1). 인라인 `display` 가 남으면
   * 같은 사실을 두 어휘가 말하고, 한쪽만 고친 코드가 보이는 패널 둘을 만든다.
   */
  test('settings panels and custom editor hide by [hidden], not inline display', async ({ page }) => {
    await waitForInit(page);
    await page.click('#settings-btn');
    await expect(page.locator('#modal-overlay')).toBeVisible();
    const state = () => page.evaluate(() => ({
      inline: [...document.querySelectorAll<HTMLElement>('#modal .mpanel, #custom-editor')]
        .filter((el) => el.style.display !== '').map((el) => el.id),
      shown: [...document.querySelectorAll<HTMLElement>('#modal .mpanel')]
        .filter((el) => !el.hidden).map((el) => el.id),
      editorHidden: (document.getElementById('custom-editor') as HTMLElement).hidden,
    }));
    // SETTINGS_TAB_ORDER_SRS FR-STO-2: 처음 보이는 패널은 Profile 이다.
    expect(await state()).toEqual({ inline: [], shown: ['panel-profile'], editorHidden: true });

    await page.click('button.mtab[data-tab="shortcuts"]');
    await expect(page.locator('#panel-shortcuts')).toBeVisible();
    expect(await state()).toEqual({ inline: [], shown: ['panel-shortcuts'], editorHidden: true });

    await page.click('button.mtab[data-tab="theme"]');
    await page.click('#custom-toggle');
    await expect(page.locator('#custom-editor')).toBeVisible();
    expect(await state()).toEqual({ inline: [], shown: ['panel-theme'], editorHidden: false });
    await page.click('#custom-toggle');
    await expect(page.locator('#custom-editor')).toBeHidden();
    expect((await state()).editorHidden).toBe(true);
    await page.click('#modal-close');
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
    await page.click('button.mtab[data-tab="theme"]');
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

// PROFILE_NAME_SRS — Settings ▸ Profile 의 이름#번호 (FR-PFN-10~13·20·31).
//
// 이름은 노드 설정(`edges.json`)에 살아 스펙 사이에 남는다 — 매번 되돌린다.
test.describe('프로필 이름', () => {
  const NAME = '작업서버';
  let original = '';

  async function openProfilePanel(page) {
    await waitForInit(page);
    await page.click('#settings-btn');
    await page.click('button.mtab[data-tab="profile"]');
    await expect(page.locator('#panel-profile')).toBeVisible();
  }

  async function saveName(page, value: string) {
    const saved = page.waitForResponse(
      r => r.url().includes('/api/profile') && r.request().method() === 'PUT'
    );
    await page.fill('#pf-name', value);
    await page.click('#pf-save');
    return saved;
  }

  test.beforeEach(async ({ request }) => {
    const r = await request.get('/api/profile');
    original = r.ok() ? (await r.json()).name : '';
  });

  test.afterEach(async ({ request }) => {
    if (original) await request.put('/api/profile', { data: { name: original } });
  });

  test('번호와 지문은 읽기 전용이고, 저장한 이름이 탭 제목이 된다', async ({ page }) => {
    await openProfilePanel(page);
    await expect(page.locator('#pf-tag')).toHaveText(/^#\d{4}$/);
    await expect(page.locator('#pf-fp')).toHaveText(/^[0-9a-f]{64}$/);
    const r = await saveName(page, NAME);
    expect(r.status()).toBe(200);
    await expect(page.locator('#pf-status')).toHaveText('저장했습니다');
    await expect(page).toHaveTitle(new RegExp(NAME + '$'));

    // 새로고침 뒤에도 그 이름이고, Edges 는 이름#번호를 보여 준다.
    await page.click('#modal-close');
    await page.reload();
    await waitForInit(page);
    await expect(page).toHaveTitle(new RegExp(NAME + '$'));
    const tag = (await page.request.get('/api/profile').then(x => x.json())).tag;
    await page.click('#settings-btn');
    await page.click('button.mtab[data-tab="edges"]');
    await expect(page.locator('#eg-handle')).toHaveText(NAME + '#' + tag);
  });

  test('규칙에 맞지 않는 이름은 거절하고 탭 제목을 바꾸지 않는다', async ({ page }) => {
    await openProfilePanel(page);
    const before = await page.title();
    const r = await saveName(page, '작업 서버#1');
    expect(r.status()).toBe(400);
    await expect(page.locator('#pf-status')).toHaveClass(/err/);
    expect(await page.title()).toBe(before);
  });

  // FR-PFN-14: 열린 패널은 다른 창의 변경을 따라간다.
  test('열린 패널은 다른 창이 바꾼 이름으로 다시 그려진다', async ({ page, request }) => {
    await openProfilePanel(page);
    await expect(page.locator('#pf-name')).toHaveValue(original);
    const r = await request.put('/api/profile', { data: { name: NAME } });
    expect(r.status()).toBe(200);
    await expect(page.locator('#pf-name')).toHaveValue(NAME);
    await expect(page).toHaveTitle(new RegExp(NAME + '$'));
    await expect(page.locator('#panel-profile .settings-stale')).toHaveCount(0);
  });

  test('고치던 이름은 덮지 않고 바뀌었다는 안내를 띄운다', async ({ page, request }) => {
    await openProfilePanel(page);
    await page.fill('#pf-name', '고치는중');
    const r = await request.put('/api/profile', { data: { name: NAME } });
    expect(r.status()).toBe(200);
    await expect(page.locator('#panel-profile .settings-stale')).toBeVisible();
    await expect(page.locator('#pf-name')).toHaveValue('고치는중');
    // 안내의 다시 읽기를 누르면 바뀐 값으로 그린다.
    await page.locator('#panel-profile .settings-stale button').click();
    await expect(page.locator('#pf-name')).toHaveValue(NAME);
  });

  test('Display 에 페이지 제목 칸이 없다', async ({ page }) => {
    await waitForInit(page);
    await expect(page.locator('#ds-title')).toHaveCount(0);
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

  // UI_POLISH_SRS FR-UIP-22 (FR-UIK-14 ① 개정): 데스크톱의 탭 열은 왼쪽 세로 목록이다 —
  // 탭마다 한 줄이고 왼쪽 끝이 한 세로줄에 선다. 가로로 밀리지 않는 것은 그대로다.
  test('UIK14b: 탭 열이 세로 목록으로 서고 가로로 밀리지 않는다', async ({ page }) => {
    await waitForInit(page);
    await page.click('#settings-btn');
    await expect(page.locator('#modal')).toBeVisible();
    const tabs = await page.evaluate(() => {
      const el = document.querySelector('.modal-tabs') as HTMLElement;
      const kids = [...el.children].map(c => c.getBoundingClientRect());
      return {
        over: el.scrollWidth - el.clientWidth, n: kids.length,
        rows: new Set(kids.map(r => Math.round(r.top))).size,
        lefts: new Set(kids.map(r => Math.round(r.left))).size,
      };
    });
    expect(tabs.over, '탭 열이 가로로 밀린다').toBe(0);
    expect(tabs.rows, '탭마다 한 줄이 아니다').toBe(tabs.n);
    expect(tabs.lefts, '탭의 왼쪽 끝이 한 줄에 서지 않는다').toBe(1);
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

// 로드맵 M7 P2 — `FUI-25`: 프리셋 삭제는 **인라인 확인**을 지난다 (Runs·백그라운드
// 목록의 `예/아니오` 와 같은 규약). 종전에는 × 한 번에 사라졌고 되돌릴 길이 없었다.
test.describe('프리셋 삭제 확인 (FUI-25)', () => {
  test('× 는 묻고, 아니오는 남기고, 예는 지운다', async ({ page }) => {
    await waitForInit(page);
    await page.evaluate(() => { (window as any).app.testing.savePreset() });
    await page.click('#settings-btn');
    await page.click('.mtab[data-tab="presets"]');
    const items = page.locator('#panel-presets .preset-item');
    await expect(items).not.toHaveCount(0);
    const n = await items.count();
    const last = items.last();
    await last.locator('.preset-del').click();
    const confirm = last.locator('.preset-confirm');
    await expect(confirm).toBeVisible();
    await confirm.locator('.preset-no').click();
    await expect(page.locator('#panel-presets .preset-item')).toHaveCount(n);
    await page.locator('#panel-presets .preset-item').last().locator('.preset-del').click();
    await page.locator('#panel-presets .preset-item').last().locator('.preset-confirm .preset-yes').click();
    await expect(page.locator('#panel-presets .preset-item')).toHaveCount(n - 1);
  });
});

// OPTIMIZE_REFACTOR_SRS FR-OPT-1-12 (FEC-8) — 기본 프리셋 버튼의 표시는 **설정을 얹는
// 길**을 따라간다. 종전에는 부팅의 한 줄(설정이 오기 전)과 프리셋 목록 그리기만
// 버튼을 칠해, 다른 창에서 바뀐 기본 프리셋(`settings_changed`)이 반영되지 않았다.
test.describe('기본 프리셋 버튼 (FEC-8)', () => {
  const PRESET = { name: 'fec8', layout: { type: 'pane', tabCount: 1 } };

  test.afterEach(async ({ request }) => {
    const saved = await (await request.get('/api/settings')).json();
    saved.layoutPresets = [];
    saved.defaultPreset = -1;
    await request.put('/api/settings', { data: saved });
  });

  test('다른 창이 바꾼 기본 프리셋이 버튼의 표시를 바꾼다', async ({ page, request }) => {
    const base = await (await request.get('/api/settings')).json();
    await request.put('/api/settings', { data: { ...base, layoutPresets: [], defaultPreset: -1 } });
    await waitForInit(page);
    const btn = page.locator('#add-preset');
    await expect(btn).toBeHidden();

    await request.put('/api/settings', { data: { ...base, layoutPresets: [PRESET], defaultPreset: 0 } });
    await expect(btn).toBeVisible();

    await request.put('/api/settings', { data: { ...base, layoutPresets: [PRESET], defaultPreset: -1 } });
    await expect(btn).toBeHidden();
  });
});

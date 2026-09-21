/**
 * M8_UNIFIED_SRS 축 B — 국제화 (TC-B-2·3·4·5).
 *
 * 로케일은 서버 설정 `locale` 이 정하고, 바꾸면 페이지가 다시 열린다 (D-B-1).
 * 설정 블롭은 서버가 가지므로 테스트 사이에 남는다 — 각 스펙이 끝에 `ko` 로 되돌린다.
 */
import { Page } from '@playwright/test';

import { test, expect, waitForInit, SPLIT_H} from './fixtures';

const KO = /[가-힣]/;

async function seedLocale(request: any, v: string | null) {
  const r = await request.get('/api/settings');
  const s = r.ok() ? await r.json() : {};
  if (v === null) delete s.locale;
  else s.locale = v;
  await request.put('/api/settings', {
    headers: { 'Content-Type': 'application/json' },
    data: JSON.stringify(s),
  });
}

async function openSettingsTab(page: Page, tab: string) {
  if (!(await page.locator('#modal-overlay').isVisible())) await page.click('#settings-btn');
  await expect(page.locator('#modal-overlay')).toBeVisible();
  await page.click(`button.mtab[data-tab="${tab}"]`);
  await expect(page.locator(`#panel-${tab}`)).toBeVisible();
}

/** 표본 문구 열 곳 — 로케일에 따라 전부 달라야 한다 (TC-B-2). `[선택자, n번째]`. */
const SAMPLES: [string, number][] = [
  ['#panel-display .ds-row > span:first-child', 0],
  ['#panel-display .ds-row > span:first-child', 1],
  ['#panel-display .ds-row > span:first-child', 5],
  ['#panel-display .ds-hint', 0],
  ['#preset-save', 0],
  ['#panel-shortcuts .ds-row > span:first-child', 0],
  ['#panel-shortcuts .ds-hint', 0],
  ['#bk-export', 0],
  ['#bk-import', 0],
  ['#bk-reset', 0],
];

async function sampleTexts(page: Page) {
  await openSettingsTab(page, 'display');
  await openSettingsTab(page, 'shortcuts');
  await openSettingsTab(page, 'backup');
  const out: string[] = [];
  for (const [sel, n] of SAMPLES) {
    out.push(((await page.locator(sel).nth(n).textContent()) || '').trim());
  }
  return out;
}

/** `#ds-locale` 로 바꾸면 저장(PUT)이 끝난 뒤 페이지가 다시 열린다. */
async function switchLocale(page: Page, to: string) {
  await openSettingsTab(page, 'display');
  const put = page.waitForResponse(
    (r: any) => r.url().includes('/api/settings') && r.request().method() === 'PUT');
  const nav = page.waitForEvent('load');
  await page.selectOption('#ds-locale', to);
  await put;
  await nav;
  await page.waitForSelector('#area .pn.focused .xterm-helper-textarea', { timeout: 15000 });
  await page.waitForSelector('#boot', { state: 'detached', timeout: 15000 });
}

test.describe('축 B — 국제화', () => {
  test.afterEach(async ({ request }) => { await seedLocale(request, null) });

  // TC-B-2 · FR-B-4
  test('로케일을 전환하면 표본 문구 열 곳이 전부 바뀌고, 미번역 키는 폴백과 경고를 낸다', async ({ page, request }) => {
    await seedLocale(request, null);
    await waitForInit(page);
    await expect(page.locator('html')).toHaveAttribute('lang', 'ko');
    const ko = await sampleTexts(page);
    for (const s of ko) expect(s).toMatch(KO);

    await switchLocale(page, 'en');
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    const en = await sampleTexts(page);
    expect(en).toHaveLength(ko.length);
    for (let i = 0; i < ko.length; i++) {
      const at = SAMPLES[i].join('#');
      expect(en[i], at).not.toBe(ko[i]);
      expect(en[i], at).not.toMatch(KO);
      expect(en[i], at).not.toBe('');
    }
    // 설정 값도 en 이다 — 다시 열어도 en 으로 뜬다.
    expect((await (await request.get('/api/settings')).json()).locale).toBe('en');

    // 미번역 키 하나를 심는다 — ko 문장으로 떨어지고 콘솔에 경고가 남는다.
    const warned: string[] = [];
    page.on('console', (m) => { if (m.type() === 'warning') warned.push(m.text()) });
    // 최상위 `const I18N` 은 window 의 속성이 아니다 — 문자열로 평가해 전역 렉시컬 이름을 쓴다.
    const shown = await page.evaluate(
      "I18N.register('ko', { 'probe.only_ko': '폴백 문장' }); t('probe.only_ko')");
    expect(shown).toBe('폴백 문장');
    await expect.poll(() => warned.some((w) => w.includes('probe.only_ko'))).toBe(true);
  });

  // TC-B-3 · FR-B-5
  test('<html lang> 은 활성 로케일이고 영어가 섞인 요소에는 lang 이 붙는다', async ({ page, request }) => {
    await seedLocale(request, null);
    await waitForInit(page);
    await expect(page.locator('html')).toHaveAttribute('lang', 'ko');
    // 설정 모달의 탭 이름은 ko 카탈로그에서도 영어다 (FR-B-9 의 데이터) — 그 요소가 말한다.
    await openSettingsTab(page, 'display');
    await expect(page.locator('.modal-tabs')).toHaveAttribute('lang', 'en');
    await expect(page.locator('.boot-name, .modal-title').first()).toHaveAttribute('lang', 'en');
  });

  // TC-B-4 · FR-B-6 (FR-A11Y-21) — ① 빈 칸 안내
  test('빈 슬롯의 안내가 접근성 트리의 텍스트로 잡힌다', async ({ page, request }) => {
    await seedLocale(request, null);
    await waitForInit(page);
    // 새 칸은 활성 창을 복제하므로(FR-WSL-52) 칸 셋에 창 셋을 놓고 가운데 창을 지운다
    // (TC-WSL-20 과 같은 길).
    const win = await page.evaluate(async () => {
      const a = (window as any).app;
      const wins = [a.ws.activeWindow];
      for (let i = 1; i < 3; i++) { const r = await a.testing.mkWindow(); a.render(); wins.push(r.win) }
      for (let i = 1; i < 3; i++) a.slotAdd();
      for (let i = 0; i < 3; i++) a.slotOpen(i, wins[i]);
      a.slotFocusTo(1);
      return wins[1];
    });
    await page.evaluate((id) => (window as any).app.delWindow(id), win);
    const slot = page.locator('#area .slot[data-slot="1"].slot-empty');
    await expect(slot).toHaveCount(1, { timeout: 10000 });
    await expect(slot.getByText('사이드바에서 창을 고르세요')).toBeVisible();
    expect(await slot.ariaSnapshot()).toContain('사이드바에서 창을 고르세요');
  });

  // TC-B-4 — ② 드롭 안내
  test('파일을 끌어 올린 터미널의 안내가 접근성 트리의 텍스트로 잡힌다', async ({ page, request }) => {
    await seedLocale(request, null);
    await waitForInit(page);
    const tp = page.locator('#area .pn.focused .tp').first();
    const dt = await page.evaluateHandle(() => {
      const d = new DataTransfer();
      d.items.add(new File(['x'], 'x.txt', { type: 'text/plain' }));
      return d;
    });
    await tp.dispatchEvent('dragover', { dataTransfer: dt });
    await expect(tp).toHaveClass(/dragover/);
    await expect(tp.getByText('Drop files here')).toBeVisible();
    expect(await tp.ariaSnapshot()).toContain('Drop files here');
  });

  // TC-B-4 — ③ 다른 창이 쥔 칸의 안내
  test('다른 화면이 쥔 칸의 안내가 접근성 트리의 텍스트로 잡힌다', async ({ browser, request }) => {
    await seedLocale(request, null);
    const mk = async () => {
      const ctx = await browser.newContext();
      await ctx.addInitScript(() => sessionStorage.setItem('displayMode', 'desktop'));
      const page = await ctx.newPage();
      await waitForInit(page);
      return { ctx, page };
    };
    const A = await mk();
    const B = await mk();
    await A.page.evaluate(() => (window as any).app.setFocus((window as any).app.focused));
    const dimmed = B.page.locator('#area .pn.pn-dimmed');
    await expect(dimmed).toHaveCount(1, { timeout: 10000 });
    await expect(dimmed.getByText('클릭하여 포커스')).toBeVisible();
    expect(await dimmed.ariaSnapshot()).toContain('클릭하여 포커스');
    await A.ctx.close();
    await B.ctx.close();
  });

  // TC-B-5 · FR-B-7
  test('단축키를 재바인딩하면 툴팁의 표기가 따라온다', async ({ page, request }) => {
    await seedLocale(request, null);
    await waitForInit(page);
    // FR-CHR-1·2: 분할 버튼은 pane 탭줄로 갔다. `data-i18n-title`·
    // `data-i18n-shortcut` 계약은 그대로이므로 재는 것은 한 글자도 바뀌지 않는다.
    const btn = page.locator(SPLIT_H);
    await expect(btn).toHaveAttribute('title', 'Split Horizontal (⌃+⇧+H)');
    await openSettingsTab(page, 'shortcuts');
    await page.click('.sc-key[data-action="splitH"]');
    await page.keyboard.press('Control+Shift+KeyJ');
    await expect.poll(() => page.evaluate(() => (window as any).shortcuts.splitH),
      { timeout: 10000 }).toBe('Ctrl+Shift+KeyJ');
    await expect(btn).toHaveAttribute('title', 'Split Horizontal (⌃+⇧+J)');
    // 되돌리면 툴팁도 되돌아온다.
    await page.locator('.sc-row').filter({ has: page.locator('.sc-key[data-action="splitH"]') })
      .locator('.ui-btn').last().click();
    await expect(btn).toHaveAttribute('title', 'Split Horizontal (⌃+⇧+H)');
  });
});

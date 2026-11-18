import { Page } from '@playwright/test';

import { test, expect, waitForInit } from './fixtures';

/**
 * SETTINGS_ITEM_LEGIBILITY_SRS — 설정 항목은 덩어리로 읽힌다 (FR-SIL-1~7).
 *
 * 접수한 말은 *"setting 창에 탭 내에서 각각 항목에 대한 구분이 힘듬"* 이었고,
 * 조사가 원인을 둘로 확정했다 — **모든 경계가 같은 굵기**이고(§2.1) **설명이
 * 자기 항목에 붙어 있지 않다**(§2.2).
 *
 * 그래서 이 파일이 재는 것은 "예뻐졌는가" 가 아니라 **경계가 실제로 갈렸는가**
 * 다: 한 항목 안이 항목 사이보다 가깝고, 세로선이 이어지는가.
 */

async function openPanel(page: Page, tab: string) {
  await page.click('#settings-btn');
  await expect(page.locator('#modal-overlay')).toHaveClass(/open/, { timeout: 10000 });
  await page.click(`.mtab[data-tab="${tab}"]`);
  await expect(page.locator(`#panel-${tab}`)).toBeVisible({ timeout: 10000 });
}

async function closePanel(page: Page) {
  await page.click('#modal-close');
  await expect(page.locator('#modal-overlay')).not.toHaveClass(/open/, { timeout: 10000 });
}

test.describe('설정 항목의 가시성 (FR-SIL-1~7)', () => {
  test('V-SIL-1 (FR-SIL-2): 항목 행에 아래 테두리가 없다 — 가로선은 그룹만 갖는다',
    async ({ page }) => {
      await waitForInit(page);
      await openPanel(page, 'display');
      const w = await page.locator('#panel-display .ds-row').first()
        .evaluate((el) => getComputedStyle(el).borderBottomWidth);
      expect(parseFloat(w)).toBe(0);
      await closePanel(page);
    });

  test('V-SIL-2·3 (FR-SIL-1·3): 설명은 자기 항목에 붙고 세로선이 이어진다',
    async ({ page }) => {
      await waitForInit(page);
      await openPanel(page, 'display');

      // `UI 글자 크기` 행과 그 설명을 잡는다 — 이 항목은 둘을 모두 갖는다.
      const row = page.locator('#panel-display .ds-row', { has: page.locator('#ds-uifs') });
      const hint = page.locator('#panel-display .ds-row:has(#ds-uifs) + .ds-hint');
      await expect(hint).toBeVisible({ timeout: 10000 });

      const rb = (await row.boundingBox())!;
      const hb = (await hint.boundingBox())!;

      // V-SIL-3: 왼쪽 경계가 같다 — 두 세로선이 한 줄로 이어진다.
      expect(Math.abs(hb.x - rb.x)).toBeLessThan(1);

      // V-SIL-2: 항목 **안**의 간격이 항목 **사이**보다 작다. 붙어 있지 않으면
      // 설명이 아래 항목의 것처럼 읽힌다 (§2.2).
      const inner = hb.y - (rb.y + rb.height);
      const next = page.locator('#panel-display .ds-row:has(#ds-uifs) + .ds-hint + .ds-row');
      const nb = (await next.boundingBox())!;
      const between = nb.y - (hb.y + hb.height);
      expect(inner).toBeLessThan(between);

      await closePanel(page);
    });

  test('V-SIL-4 (FR-SIL-4): 그룹 소제목이 보이고 번역 문구가 들어 있다',
    async ({ page }) => {
      await waitForInit(page);
      await openPanel(page, 'display');
      const secs = page.locator('#panel-display .ds-sec');
      await expect(secs.first()).toBeVisible({ timeout: 10000 });
      expect(await secs.count()).toBeGreaterThanOrEqual(2);
      // 문구는 카탈로그에서 온다 — 비어 있으면 키가 빠진 것이다.
      for (const t of await secs.allTextContents()) expect(t.trim().length).toBeGreaterThan(0);
      await closePanel(page);
    });

  test('V-SIL-5 (FR-SIL-6): 설정 탭 전부가 열리고 항목이 보인다',
    async ({ page }) => {
      await waitForInit(page);
      await page.click('#settings-btn');
      await expect(page.locator('#modal-overlay')).toHaveClass(/open/, { timeout: 10000 });
      const tabs = await page.locator('.mtab[data-tab]').evaluateAll(
        (els) => els.map((e) => (e as HTMLElement).dataset.tab!));
      expect(tabs.length).toBeGreaterThan(5);
      for (const t of tabs) {
        await page.click(`.mtab[data-tab="${t}"]`);
        await expect(page.locator(`#panel-${t}`)).toBeVisible({ timeout: 10000 });
      }
      await closePanel(page);
    });

  // SETTINGS_TAB_ORDER_SRS FR-STO-6~8: 카드형 — 항목은 카드, 섹션 제목은 밝고 굵게, 묶음 이름 위에 선.
  test('V-STO-6~8: 항목은 카드이고 섹션·묶음이 갈린다', async ({ page }) => {
    await waitForInit(page);
    await openPanel(page, 'display');
    const got = await page.evaluate(() => {
      const panel = document.getElementById('panel-display')!;
      const row = panel.querySelector('.ds-row:has(#ds-uifs)') as HTMLElement;
      const hint = row.nextElementSibling as HTMLElement;
      const next = hint.nextElementSibling as HTMLElement;
      const sec = panel.querySelector('.ds-sec') as HTMLElement;
      const label = row.querySelector('span') as HTMLElement;
      const body = document.querySelector('#modal .modal-body') as HTMLElement;
      const cs = (e: Element) => getComputedStyle(e);
      const grp = document.querySelector('#modal .mtab-grp') as HTMLElement;
      return {
        rowBg: cs(row).backgroundColor, hintBg: cs(hint).backgroundColor, bodyBg: cs(body).backgroundColor,
        radius: parseFloat(cs(row).borderTopLeftRadius),
        gap: next.getBoundingClientRect().top - hint.getBoundingClientRect().bottom,
        secWeight: Number(cs(sec).fontWeight), secSize: parseFloat(cs(sec).fontSize), labelSize: parseFloat(cs(label).fontSize),
        labelWeight: Number(cs(label).fontWeight),
        grpBorder: parseFloat(cs(grp).borderTopWidth),
      };
    });
    expect(got.rowBg).toBe(got.hintBg);
    expect(got.rowBg).not.toBe(got.bodyBg);
    expect(got.rowBg).not.toBe('rgba(0, 0, 0, 0)');
    expect(got.radius).toBeGreaterThan(0);
    expect(got.gap).toBeGreaterThan(0);
    expect(got.secWeight).toBeGreaterThanOrEqual(600);
    expect(got.secSize).toBeGreaterThanOrEqual(got.labelSize);
    // 색은 테마마다 같을 수 있다(밝은 글자와 본문 글자가 같은 테마) — 굵기로 가른다.
    expect(got.secWeight).toBeGreaterThan(got.labelWeight);
    expect(got.grpBorder).toBeGreaterThan(0);
    // 저장 버튼·상태만 있는 행은 카드가 아니다.
    await page.click('.mtab[data-tab="edges"]');
    const saveBg = await page.locator('#panel-edges .ds-row:has(#eg-save)').evaluate((e) => getComputedStyle(e).backgroundColor);
    expect(saveBg).toBe('rgba(0, 0, 0, 0)');
    await closePanel(page);
  });
});

/**
 * KIT_APPLICATION_SRS §5 — 모달 골격 다섯이 접근성 계약을 지나는가 (묶음 F).
 *
 * `UIKit.dialogOpen` 이 `role=dialog`·`aria-modal`·**Tab 트랩**·**포커스 복귀**를
 * 전부 갖는데 부르는 자리가 둘뿐이었다 (§2.5). 골격 다섯은 이미
 * `.ui-modal`·`.ui-modal-box` 를 병기하고 있으므로(FR-TOK-40·42 완료) 남은 것은
 * **함수 호출 한 줄씩**이다 — D-A11Y-7 이 *"골격이 일곱이어도 계약은 한 벌"* 이라
 * 적은 그대로다.
 *
 * `_dlgOnKey` 는 **`Tab` 만** 다룬다 — `Escape` 는 각 골격이 자기 핸들러로
 * 갖는다. 그래서 계약을 더해도 닫는 길이 둘이 되지 않는다.
 */
import { Page } from '@playwright/test';

import { test, expect, waitForInit } from './fixtures';

/** 다섯 골격: 이름 · 여는 법 · 상자 선택자 · 닫는 법 · 연 컨트롤. */
const SKELETONS: {
  name: string; box: string; opener: string;
  open: (p: Page) => Promise<void>; close: (p: Page) => Promise<void>;
}[] = [
  {
    name: '확인창', box: '.confirm-overlay .confirm-box', opener: '#settings-btn',
    open: async (p) => { await p.evaluate(() => { void (window as any).app.testing.confirmClose('트랩 검사') }) },
    close: async (p) => { await p.click('.confirm-overlay .confirm-cancel') },
  },
  // UIUX_OVERHAUL_SRS FR-ACT-2: **백그라운드와 Runs 가 이 목록을 떠났다.** 둘은
  // 더 이상 모달이 아니라 활동 패널의 구역이므로 포커스 트랩·백드롭·Escape 의
  // 계약 대상이 아니다 — 되돌릴 것이 없는 조회가 앱을 막지 않는다는 것이 그
  // 요구다. 그 둘의 검증은 `background-ui.spec.ts`·`runs.spec.ts` 로 갔다.
  {
    name: 'git 확인창', box: '#git-confirm .gc-box', opener: '#settings-btn',
    open: async (p) => { await p.evaluate(() => {
      (window as any).GitConfirm.open({ action: 'discard', title: '트랩 검사', targets: ['a.txt'], run: async () => ({ ok: true }) });
    }) },
    close: async (p) => { await p.click('#git-confirm .gc-cancel') },
  },
  {
    name: 'git 다이얼로그', box: '.git-dialog .git-dialog-box', opener: '#settings-btn',
    open: async (p) => { await p.evaluate(() => {
      (window as any).GitDialog.open({ action: 'probe', title: '트랩 검사', body: '본문', runLabel: '실행', run: () => ({ ok: true }) });
    }) },
    close: async (p) => { await p.click('.git-dialog .git-dialog-cancel') },
  },
];

/** 상자의 접근성 속성과 지금 포커스가 그 안에 있는지. */
const state = (page: Page, box: string) => page.evaluate((sel) => {
  const b = document.querySelector(sel) as HTMLElement | null;
  if (!b) return null;
  const labelledBy = b.getAttribute('aria-labelledby');
  const named = labelledBy ? (document.getElementById(labelledBy)?.textContent || '').trim() : '';
  return {
    role: b.getAttribute('role') || '',
    modal: b.getAttribute('aria-modal') || '',
    // **이름이 뜻을 가져야 한다** — 빈 요소를 가리키면 접근 이름은 여전히 없다.
    name: named || b.getAttribute('aria-label') || '',
    inside: b.contains(document.activeElement),
  };
}, box);

test.describe('모달 골격 다섯의 접근성 계약 (KIT_APPLICATION_SRS 묶음 F)', () => {
  test('TC-KIT-11: 열면 포커스가 안으로 들어가고 Tab 이 밖으로 나가지 않으며 닫으면 연 컨트롤로 돌아간다 (FR-KIT-24~26)', async ({ page }) => {
    await waitForInit(page, { clearLocalStorage: true });
    const bad: string[] = [];

    for (const k of SKELETONS) {
      // **연 컨트롤에 포커스를 두고 연다** — 복귀할 자리가 있어야 복귀를 잴 수 있다.
      await page.focus(k.opener);
      await k.open(page);
      await expect(page.locator(k.box), `${k.name} 이 열리지 않았다`).toBeVisible({ timeout: 10000 });

      const s = await state(page, k.box);
      expect(s, `${k.name}: 상자를 찾지 못했다`).not.toBeNull();
      if (s!.role !== 'dialog') bad.push(`${k.name}: role=${s!.role || '없음'}`);
      if (s!.modal !== 'true') bad.push(`${k.name}: aria-modal=${s!.modal || '없음'}`);
      if (!s!.name) bad.push(`${k.name}: 접근 이름이 없다`);
      /**
       * 포커스는 **다음 프레임**에 들어간다 — `dialogOpen` 이 그 이유를 적어 두었다
       * (부르는 쪽이 상자를 붙이는 것은 그 함수가 돌아간 뒤이고, 붙기 전의
       * `focus()` 는 아무 일도 하지 않는다). 그래서 조건이 서기를 **기다린다**.
       * 고정 대기가 아니라 조건 폴링이므로, 포커스가 끝내 안 들어오면 진다.
       */
      const landed = await page.waitForFunction((sel) => {
        const b = document.querySelector(sel);
        return !!b && b.contains(document.activeElement);
      }, k.box, { timeout: 3000 }).then(() => true, () => false);
      if (!landed) bad.push(`${k.name}: 열었는데 포커스가 상자 밖이다`);

      // Tab 트랩 — 상자 안의 닿을 것보다 많이 눌러도 밖으로 못 나간다.
      for (let i = 0; i < 12; i++) await page.keyboard.press('Tab');
      if (!(await state(page, k.box))!.inside) bad.push(`${k.name}: Tab 이 상자 밖으로 샜다`);
      await page.keyboard.press('Shift+Tab');
      if (!(await state(page, k.box))!.inside) bad.push(`${k.name}: Shift+Tab 이 상자 밖으로 샜다`);

      await k.close(page);
      await expect(page.locator(k.box), `${k.name} 이 닫히지 않았다`).toBeHidden({ timeout: 5000 });
      const back = await page.evaluate((sel) => document.activeElement === document.querySelector(sel), k.opener);
      if (!back) bad.push(`${k.name}: 닫았는데 연 컨트롤로 안 돌아왔다`);
    }
    expect(bad).toEqual([]);
  });

  test('TC-KIT-12: 중첩 모달의 Escape 가 위에서부터 닫는다 (FR-KIT-27 / FR-A11Y-18)', async ({ page }) => {
    await waitForInit(page, { clearLocalStorage: true });
    // 설정 모달 위에 git 확인창을 얹는다 — 골격이 서로 다른 두 겹이다.
    await page.click('#settings-btn');
    await expect(page.locator('#modal-overlay.open')).toBeVisible({ timeout: 10000 });
    await page.evaluate(() => {
      (window as any).GitConfirm.open({ action: 'discard', title: '중첩 검사', targets: ['a.txt'], run: async () => ({ ok: true }) });
    });
    await expect(page.locator('#git-confirm .gc-box')).toBeVisible({ timeout: 10000 });

    // 위가 먼저 닫힌다.
    await page.keyboard.press('Escape');
    await expect(page.locator('#git-confirm .gc-box')).toBeHidden({ timeout: 5000 });
    await expect(page.locator('#modal-overlay.open'), '아래 모달까지 함께 닫혔다').toBeVisible();
    // 위가 닫힌 뒤 포커스는 아래 모달 안이어야 한다 — 밖으로 떨어지면 다음 `Tab` 이
    // 문서 맨 앞에서 시작한다 (`dialogOpen` 의 복귀 주석).
    const inLower = await page.evaluate(() => {
      const m = document.getElementById('modal');
      return !!m && m.contains(document.activeElement);
    });
    expect(inLower, '위가 닫힌 뒤 포커스가 아래 모달 밖으로 떨어졌다').toBe(true);

    await page.keyboard.press('Escape');
    await expect(page.locator('#modal-overlay.open')).toBeHidden({ timeout: 5000 });
  });
});

import { Page } from '@playwright/test';

import { test, expect, waitForInit } from './fixtures';

// ACCESSIBILITY_BASELINE_SRS §5.1 — TC-A11Y-8·9 (FR-A11Y-18 / M7 `UX-3`).
//
// **재는 것은 "속성이 있다" 가 아니다.** `role="dialog"` 를 붙이는 것은 한 줄이고,
// 그것만으로는 키보드 사용자가 모달을 벗어나지 않는다는 보장이 생기지 않는다.
// 그래서 세 가지를 **동작으로** 단정한다: ① 열면 포커스가 안으로 들어간다
// ② `Tab` 이 밖으로 나가지 않는다 ③ 닫으면 **연 컨트롤로** 돌아간다.
//
// 중첩은 실제 경로로 잡는다 (`03` 이 미확인으로 남긴 항목): 설정 모달의 Access
// 탭에서 자기 주소를 자르는 목록을 저장하면 `.acl-confirm`(`UIKit.modal`)이 설정
// 모달 **위에** 뜬다 — 이 저장소에서 확인된 유일한 결정적 중첩이다
// (`app-settings-access.js:225`).

/** 설정 모달을 연다. 연 컨트롤이 `#settings-btn` 인 것이 복귀의 기준이다. */
async function openSettings(page: Page) {
  await page.click('#settings-btn');
  await expect(page.locator('#modal-overlay')).toBeVisible();
}

/**
 * 지금 포커스를 가진 요소의 신원. 깊은 비교가 아니라 **자리**를 본다.
 *
 * 포커스는 **다음 프레임**에 올 수 있다 — `UIKit.modal` 의 `focusDefault` 가
 * 그렇게 적혀 있다(붙기 전에는 `focus()` 가 아무 일도 하지 않으므로 프레임을
 * 넘긴다). 그러므로 한 번 읽고 단정하지 않고 **폴링한다**.
 */
const focusInfo = (page: Page) => page.evaluate(() => {
  const a = document.activeElement as HTMLElement | null;
  if (!a) return null;
  return {
    id: a.id || '',
    cls: typeof a.className === 'string' ? a.className : '',
    tag: a.tagName.toLowerCase(),
    inSettings: !!a.closest('#modal-overlay'),
    inAcl: !!a.closest('.acl-confirm'),
  };
});

test.describe('접근성 — 모달의 시맨틱과 포커스 (FR-A11Y-18 / UX-3)', () => {
  test('TC-A11Y-8a: 설정 모달이 dialog 로 이름을 갖는다', async ({ page }) => {
    await waitForInit(page);
    await openSettings(page);

    const box = page.locator('#modal');
    await expect(box).toHaveAttribute('role', 'dialog');
    await expect(box).toHaveAttribute('aria-modal', 'true');

    /**
     * **이름이 실제로 뜻을 갖는지 본다.** `aria-labelledby` 가 있다는 것과 그것이
     * 가리키는 요소에 글자가 있다는 것은 다르다 — 빈 요소를 가리키면 접근 이름은
     * 여전히 없고, axe 도 그것을 잡지 못한다.
     */
    const named = await page.evaluate(() => {
      const b = document.getElementById('modal');
      const id = b?.getAttribute('aria-labelledby') || '';
      const t = id ? document.getElementById(id) : null;
      return { id, text: (t?.textContent || '').trim() };
    });
    expect(named.id, 'aria-labelledby 가 없다').toBeTruthy();
    expect(named.text, 'aria-labelledby 가 가리키는 요소가 비었다').toBeTruthy();
  });

  test('TC-A11Y-8b: 탭 줄이 tablist 이고 선택이 상태로 드러난다', async ({ page }) => {
    await waitForInit(page);
    await openSettings(page);

    await expect(page.locator('.modal-tabs')).toHaveAttribute('role', 'tablist');
    const tabs = page.locator('.modal-tabs .mtab');
    const n = await tabs.count();
    expect(n).toBeGreaterThan(5);

    // 전부 `tab` 이고, **선택된 것이 정확히 하나**다. 색만으로 선택을 말하면
    // 스크린리더에는 아무 것도 전달되지 않는다.
    const roles = await tabs.evaluateAll((els) => els.map((e) => ({
      role: e.getAttribute('role'),
      sel: e.getAttribute('aria-selected'),
      controls: e.getAttribute('aria-controls'),
      active: e.classList.contains('active'),
    })));
    for (const r of roles) expect(r.role, JSON.stringify(r)).toBe('tab');
    expect(roles.filter((r) => r.sel === 'true')).toHaveLength(1);
    // `aria-selected` 가 `.active` 와 **같은 것을 말해야** 한다 — 갈라지면 화면과
    // 접근성 트리가 다른 탭을 가리킨다.
    for (const r of roles) expect(r.sel === 'true', JSON.stringify(r)).toBe(r.active);
    // 가리키는 패널이 실재해야 한다.
    for (const r of roles) {
      expect(r.controls, JSON.stringify(r)).toBeTruthy();
      await expect(page.locator('#' + r.controls)).toHaveCount(1);
    }
  });

  test('TC-A11Y-8c: 열면 포커스가 안으로 들어가고 Tab 이 밖으로 나가지 않는다', async ({ page }) => {
    await waitForInit(page);
    await openSettings(page);

    await expect.poll(async () => (await focusInfo(page))?.inSettings, {
      timeout: 5000,
      message: '열었을 때 포커스가 모달 안으로 들어가지 않았다',
    }).toBe(true);

    /**
     * `Tab` 을 **넉넉히** 눌러 한 바퀴를 돌린다. 설정 모달의 대화 요소는 수십
     * 개이므로 몇 번으로는 경계에 닿지 못한다 — 닿지 못한 검사는 트랩을 재지 않고
     * "아직 안쪽이다" 만 확인한다.
     */
    for (let i = 0; i < 60; i++) {
      await page.keyboard.press('Tab');
      const f = await focusInfo(page);
      expect(f?.inSettings, `Tab ${i + 1}번에 포커스가 모달을 벗어났다: ` + JSON.stringify(f)).toBe(true);
    }
    // 반대 방향도 갇힌다 — 앞쪽 경계는 따로 새는 자리다.
    for (let i = 0; i < 20; i++) {
      await page.keyboard.press('Shift+Tab');
      const f = await focusInfo(page);
      expect(f?.inSettings, `Shift+Tab ${i + 1}번에 포커스가 모달을 벗어났다: ` + JSON.stringify(f)).toBe(true);
    }
  });

  test('TC-A11Y-8d: 닫으면 연 컨트롤로 돌아간다', async ({ page }) => {
    await waitForInit(page);
    await openSettings(page);
    // 먼저 포커스를 **모달 안으로** 보낸다. 열었을 때 포커스가 들어가지 않는
    // 구현에서는 "돌아왔다" 가 공짜로 참이 되고, 그러면 이 검사는 아무것도 재지
    // 않는다 (TC-A11Y-8c 가 들어가는 것을 따로 재지만, 여기서도 전제를 세운다).
    await expect.poll(async () => (await focusInfo(page))?.inSettings, { timeout: 5000 }).toBe(true);
    await page.keyboard.press('Escape');
    await expect(page.locator('#modal-overlay')).not.toBeVisible();
    await expect.poll(async () => (await focusInfo(page))?.id, {
      timeout: 5000, message: 'Escape 로 닫은 뒤 #settings-btn 으로 돌아오지 않았다',
    }).toBe('settings-btn');

    // 닫기 **버튼**으로 닫아도 같다 — 닫는 길이 셋이면 복귀도 셋에서 같아야 한다.
    await openSettings(page);
    await page.click('#modal-close');
    await expect(page.locator('#modal-overlay')).not.toBeVisible();
    await expect.poll(async () => (await focusInfo(page))?.id, {
      timeout: 5000, message: '닫기 버튼으로 닫은 뒤 복귀하지 않았다',
    }).toBe('settings-btn');
  });

  test('TC-A11Y-9: 중첩 모달의 Escape 는 안쪽부터 닫는다', async ({ page }) => {
    await waitForInit(page);
    await openSettings(page);
    await page.click('button.mtab[data-tab="access"]');
    await expect(page.locator('#panel-access')).toBeVisible();
    // 서버에서 "지금 내 주소" 를 받아야 자기 차단 판정이 선다 (access-allowlist 와
    // 같은 전제) — 그 전에 저장하면 확인창이 뜨지 않고 검사가 헛돈다.
    await expect(page.locator('#acl-you')).not.toHaveText('');
    await expect(page.locator('#acl-you')).not.toHaveText('(알 수 없음)');

    await page.click('#acl-add');
    await page.locator('#acl-list .acl-row').last().locator('.acl-value').fill('203.0.113.0/24');
    await page.locator('#acl-enabled').check();
    await page.click('#acl-save');

    const inner = page.locator('.ui-modal.acl-confirm');
    await expect(inner).toBeVisible();
    // 중첩된 동안 포커스는 **안쪽**에 있다.
    await expect.poll(async () => (await focusInfo(page))?.inAcl, {
      timeout: 5000, message: '중첩 모달을 열었는데 포커스가 안쪽으로 들어가지 않았다',
    }).toBe(true);

    // ① 첫 Escape — 안쪽만 닫힌다. 바깥이 함께 닫히면 사용자는 하던 일을 잃는다.
    await page.keyboard.press('Escape');
    await expect(inner).toHaveCount(0);
    await expect(page.locator('#modal-overlay')).toBeVisible();
    // 포커스는 바깥 모달로 돌아온다 — 문서로 떨어지면 다음 Tab 이 어디서 시작할지
    // 알 수 없다.
    await expect.poll(async () => (await focusInfo(page))?.inSettings, {
      timeout: 5000, message: '안쪽을 닫은 뒤 포커스가 바깥 모달로 돌아오지 않았다',
    }).toBe(true);

    // ② 두 번째 Escape — 이제 바깥이 닫히고 연 컨트롤로 돌아간다.
    await page.keyboard.press('Escape');
    await expect(page.locator('#modal-overlay')).not.toBeVisible();
    await expect.poll(async () => (await focusInfo(page))?.id, { timeout: 5000 }).toBe('settings-btn');
  });
});

// DESIGN_TOKENS_SRS §3.9 — TC-TOK-21 (FR-TOK-40~42 / M7 `UX-16` 나머지 절반).
//
// **골격이 한 벌인가**를 일곱을 전부 열어 잰다. 이름(`ui-modal`)만 보면 클래스를
// 붙이고 옛 규칙을 그대로 둔 채 통과할 수 있으므로 **계산값**도 본다 — 백드롭이
// 토큰의 값이고, 상자의 반경·배경이 키트의 값(D-TOK-10: `--bg` · 8px)이다.
// 옛 규칙이 남아 키트를 다시 덮으면 여기서 드러난다.

/** 열린 오버레이·상자의 클래스와 계산값. `overlay` 는 오버레이 선택자, `box` 는 상자. */
const skeleton = (page: Page, overlay: string, box: string) => page.evaluate(([ov, bx]) => {
  const o = document.querySelector(ov) as HTMLElement | null;
  const b = document.querySelector(bx) as HTMLElement | null;
  if (!o || !b) return null;
  const root = getComputedStyle(document.documentElement);
  const cs = getComputedStyle(o), cb = getComputedStyle(b);
  // 토큰의 값을 같은 방법(계산값)으로 읽는다 — 문자열 비교가 표기에 매이지 않게
  // 임시 요소에 칠해서 읽는다.
  const probe = document.createElement('div');
  probe.style.cssText = 'position:absolute;visibility:hidden;background:var(--backdrop);color:var(--bg)';
  document.body.appendChild(probe);
  const pcs = getComputedStyle(probe);
  const backdrop = pcs.backgroundColor, bg = pcs.color;
  probe.remove();
  return {
    ovIsKit: o.classList.contains('ui-modal'),
    ovBg: cs.backgroundColor, backdrop,
    ovBlur: cs.backdropFilter || (cs as any).webkitBackdropFilter || '',
    boxIsKit: b.classList.contains('ui-modal-box'),
    boxRadius: cb.borderTopLeftRadius, boxBg: cb.backgroundColor, bg,
    rootHasBackdrop: !!root.getPropertyValue('--backdrop').trim(),
  };
}, [overlay, box]);

test.describe('모달 골격 — 일곱이 한 벌이다 (FR-TOK-40~42 / UX-16)', () => {
  /** 일곱 골격: 이름 · 여는 법 · 오버레이 · 상자 · 닫는 법. */
  const SKELETONS: { name: string; overlay: string; box: string;
    open: (page: Page) => Promise<void>; close: (page: Page) => Promise<void> }[] = [
    { name: '설정', overlay: '#modal-overlay', box: '#modal',
      open: async (p) => { await p.click('#settings-btn') },
      close: async (p) => { await p.keyboard.press('Escape') } },
    { name: '확인창', overlay: '.confirm-overlay', box: '.confirm-overlay .confirm-box',
      open: async (p) => { await p.evaluate(() => { void (window as any).app.testing.confirmClose('골격 검사') }) },
      close: async (p) => { await p.click('.confirm-overlay .confirm-cancel') } },
    { name: '백그라운드', overlay: '#bg-modal', box: '#bg-modal .bg-box',
      open: async (p) => { await p.click('#bg-btn') },
      close: async (p) => { await p.keyboard.press('Escape') } },
    { name: 'Runs', overlay: '#runs-modal', box: '#runs-modal .runs-box',
      open: async (p) => { await p.click('#runs-btn') },
      close: async (p) => { await p.keyboard.press('Escape') } },
    { name: 'git 확인창', overlay: '#git-confirm', box: '#git-confirm .gc-box',
      open: async (p) => { await p.evaluate(() => {
        (window as any).GitConfirm.open({ action: 'discard', title: '골격 검사', targets: ['a.txt'], run: async () => ({ ok: true }) });
      }) },
      close: async (p) => { await p.click('#git-confirm .gc-cancel') } },
    { name: 'git 다이얼로그', overlay: '.git-dialog', box: '.git-dialog .git-dialog-box',
      open: async (p) => { await p.evaluate(() => {
        (window as any).GitDialog.open({ action: 'probe', title: '골격 검사', body: '본문', runLabel: '실행', run: () => ({ ok: true }) });
      }) },
      close: async (p) => { await p.click('.git-dialog .git-dialog-cancel') } },
    { name: '키트', overlay: '.ui-modal.tok-probe', box: '.ui-modal.tok-probe .ui-modal-box',
      open: async (p) => { await p.evaluate(() => {
        // `UIKit` 은 클래식 스크립트의 최상위 `const` 라 `window` 에 없다 — 전역 렉시컬 스코프에서 읽는다.
        const K = new Function('return UIKit')();
        const m = K.modal({ title: '골격 검사', cls: 'tok-probe', actions: [{ label: '닫기', kind: 'primary' }] });
        document.body.appendChild(m.el);
      }) },
      close: async (p) => { await p.keyboard.press('Escape') } },
  ];

  test('TC-TOK-21: 열린 오버레이는 전부 .ui-modal 이고 상자는 키트의 값으로 그려진다', async ({ page }) => {
    await waitForInit(page, { clearLocalStorage: true });
    const bad: string[] = [];
    for (const k of SKELETONS) {
      await k.open(page);
      await expect(page.locator(k.box), `${k.name} 이 열리지 않았다`).toBeVisible({ timeout: 10000 });
      const s = await skeleton(page, k.overlay, k.box);
      expect(s, `${k.name}: 오버레이·상자를 찾지 못했다`).not.toBeNull();
      if (!s!.rootHasBackdrop) bad.push(`${k.name}: --backdrop 토큰이 없다`);
      if (!s!.ovIsKit) bad.push(`${k.name}: 오버레이에 ui-modal 이 없다`);
      if (s!.ovBg !== s!.backdrop) bad.push(`${k.name}: 백드롭 ${s!.ovBg} ≠ --backdrop ${s!.backdrop}`);
      if (!/blur\(2px\)/.test(s!.ovBlur)) bad.push(`${k.name}: backdrop-filter 가 blur(2px) 가 아니다 (${s!.ovBlur || '없음'})`);
      if (!s!.boxIsKit) bad.push(`${k.name}: 상자에 ui-modal-box 가 없다`);
      if (s!.boxRadius !== '8px') bad.push(`${k.name}: 상자 반경 ${s!.boxRadius} ≠ 8px`);
      if (s!.boxBg !== s!.bg) bad.push(`${k.name}: 상자 배경 ${s!.boxBg} ≠ --bg ${s!.bg}`);
      await k.close(page);
      await expect(page.locator(k.box), `${k.name} 이 닫히지 않았다`).toBeHidden({ timeout: 5000 });
    }
    expect(bad).toEqual([]);
  });
});

import { test, expect, waitForInit } from './fixtures';

/**
 * V-M9-44 (M9_SRS FR-M9-44 / M9-B25) — **글자를 받는 자리의 단축키.**
 *
 * 접수한 말: *"gui agent 의 텍스트박스를 클릭한 상태에서 탭 닫기 단축키를 누르면
 * 브라우저 단축키가 적용된다(현재의 경우 cmd + opt + shift + w 여서 보이는 모든
 * 브라우저를 닫는다)"*.
 *
 * 원인은 한 `return` 이 두 일을 함께 한 것이었다 — 입력 요소에 포커스가 있으면 앱
 * 단축키를 돌리지 않고(옳다) **브라우저 기본도 막지 않았다**(결함이다).
 *
 * 재는 것 셋: ① 에이전트 입력창에서 탭 닫기 단축키가 **탭을 닫는다** ② 같은 자리에서
 * **편집 조합은 살아 있다** ③ 일반 입력(검색창)에서는 단축키가 돌지 않되 브라우저
 * 기본은 **막힌다**.
 */
const MENU_ITEM = '.ui-menu .ui-menu-item[data-id="agent:claude"]';

async function openAgentTab(page: any) {
  const before = await page.locator('#area .pn.focused .pn-tab').count();
  await page.locator('#area .pn.focused .pn-tab-add').click({ button: 'right' });
  await expect(page.locator(MENU_ITEM)).toBeVisible({ timeout: 10000 });
  await page.locator(MENU_ITEM).click();
  await expect(page.locator('#area .pn.focused .pn-tab')).toHaveCount(before + 1, { timeout: 10000 });
  const pane = page.locator('#area .pn.focused .agent-pane.vis');
  await expect(pane).toBeVisible({ timeout: 10000 });
  await expect(pane).toHaveAttribute('data-state', 'idle', { timeout: 15000 });
  return { pane, before };
}

test.describe('에이전트 입력창의 단축키 (M9-B25)', () => {
  test('V-M9-44 ①②: 입력창에서 탭 닫기 단축키가 먹고, 편집 조합은 살아 있다', async ({ page }) => {
    await waitForInit(page);
    const { pane, before } = await openAgentTab(page);
    const ta = pane.locator('.agp-ta');
    await ta.click();
    await expect(ta).toBeFocused();

    // ② 편집 조합은 그 표면의 것이다 — 전체선택이 살아 있어야 한다.
    await ta.fill('가나다');
    await page.keyboard.press('ControlOrMeta+KeyA');
    const selected = await ta.evaluate((el: HTMLTextAreaElement) => el.value.slice(el.selectionStart, el.selectionEnd));
    expect(selected, 'Mod+A 가 삼켜졌다 — 편집 조합은 입력창의 것이다').toBe('가나다');
    await ta.fill('');

    // ① 탭 닫기 단축키(기본 Ctrl+Shift+KeyD)가 **탭을 닫는다**. 종전에는 이 키가
    // 브라우저로 내려갔다.
    await page.keyboard.press('Control+Shift+KeyD');
    await expect(page.locator('#area .pn.focused .pn-tab'),
      '에이전트 입력창에서 탭 닫기 단축키가 먹지 않았다').toHaveCount(before, { timeout: 10000 });
  });

  test('V-M9-44 ③: 일반 입력에서는 단축키가 돌지 않되 브라우저 기본은 막힌다', async ({ page }) => {
    await waitForInit(page);
    const before = await page.locator('#area .pn.focused .pn-tab').count();

    // 검색창은 **자기 편집을 스스로 하지 않는** 일반 입력이다.
    await page.keyboard.press('ControlOrMeta+KeyF');
    const si = page.locator('#search-input');
    await expect(si).toBeVisible({ timeout: 10000 });
    await si.click();
    await expect(si).toBeFocused();

    /**
     * 관측 창을 **키보다 먼저** 건다. 리스너 등록을 기다리지 않고 키를 누르면
     * 두 왕복의 순서가 정해지지 않아 놓친다.
     *
     * **`code` 로 고른다** — `press('Control+Shift+KeyD')` 는 수식키 각각에도
     * keydown 을 내고 그것들은 애초에 차단 대상이 아니다 (`MOD_CODES`). 첫
     * keydown 을 잡으면 늘 `ControlLeft` 를 본다.
     *
     * **`document` 의 캡처 단계에서 본다.** 앱의 핸들러는 `window` 캡처에 걸려
     * 있고 캡처는 window → document 순이므로, 이 자리에서 본 `defaultPrevented`
     * 가 곧 "우리가 막았는가" 다. 버블까지 기다리면 안 된다 — 그 사이에 포커스가
     * 터미널로 옮겨가면 xterm 이 전파를 멈춰 이벤트가 오지 않는다(실측).
     */
    await page.evaluate(() => {
      const w = window as unknown as { __v944?: boolean | null };
      w.__v944 = null;
      const onKey = (ev: KeyboardEvent) => {
        if (ev.code !== 'KeyD') return;
        document.removeEventListener('keydown', onKey, true);
        w.__v944 = ev.defaultPrevented;
      };
      document.addEventListener('keydown', onKey, true);
    });
    await page.keyboard.press('Control+Shift+KeyD');
    await expect.poll(
      () => page.evaluate(() => (window as unknown as { __v944?: boolean | null }).__v944),
      { timeout: 10000, message: '일반 입력에서 브라우저 기본이 막히지 않았다 (FR-KEY-5 개정)' },
    ).toBe(true);
    await expect(page.locator('#area .pn.focused .pn-tab'),
      '일반 입력에서 앱 단축키가 돌았다').toHaveCount(before);
  });
});

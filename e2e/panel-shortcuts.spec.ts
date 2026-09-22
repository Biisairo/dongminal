
import {
  test, expect, waitForInit, gotoSettled,
} from './fixtures';

// 페이지 전역 (web/js/core/helpers.js).
declare const SHORTCUT_DEFAULTS: Record<string, string>;

// PANEL_SHORTCUTS_SRS — 상단 툴바의 `Background`·`Runs` 를 키로 연다.
//
// 재는 것은 "버튼과 같은 자리로 가는가" 다. 여는 함수는 이미 있었고, 버튼만이
// 그것을 부르는 유일한 자리였다 (§2.1).

test.describe('진입점 단축키', () => {
  // V-PSC-1: 기본값이 이미 쓰는 키와 겹치면 둘 중 하나가 조용히 죽는다.
  test('기본 키가 서로 겹치지 않는다', async ({ page }) => {
    await waitForInit(page);
    const got = await page.evaluate(() => {
      // `const` 선언이라 window 의 속성이 아니다 — 전역 어휘 환경에서 이름으로 닿는다.
      const d = SHORTCUT_DEFAULTS as Record<string, string>;
      const byKey: Record<string, string[]> = {};
      for (const [action, key] of Object.entries(d)) (byKey[key] ||= []).push(action);
      return {
        dupes: Object.entries(byKey).filter(([, a]) => a.length > 1),
        bg: d.bgToggle,
        runs: d.runsToggle,
      };
    });
    expect(got.dupes, `같은 키에 두 동작이 걸렸다: ${JSON.stringify(got.dupes)}`).toEqual([]);
    expect(got.bg).toBe('Ctrl+Shift+KeyB');
    expect(got.runs).toBe('Ctrl+Shift+KeyO');
  });

  /**
   * V-PSC-2·3 · FR-PSC-4 (**UIUX_OVERHAUL_SRS FR-ACT-4 로 개정**).
   *
   * 외운 키는 그대로 산다 (NFR-4). 여는 대상이 모달에서 **활동 패널의 그 구역**
   * 으로 바뀌었고, 같은 키를 다시 누르면 닫힌다 — 토글이던 것은 토글로 남는다.
   */
  test('Ctrl+Shift+B 가 백그라운드 구역을 열고 닫는다', async ({ page }) => {
    await waitForInit(page);
    await page.keyboard.press('Control+Shift+KeyB');
    await expect(page.locator('#agents-panel.open .ag-sec[data-sec="bg"]')).toBeVisible();
    await page.keyboard.press('Control+Shift+KeyB');
    await expect(page.locator('#agents-panel.open')).toHaveCount(0);
  });

  test('Ctrl+Shift+O 가 Run 구역을 열고 닫는다', async ({ page }) => {
    await waitForInit(page);
    await page.keyboard.press('Control+Shift+KeyO');
    await expect(page.locator('#agents-panel.open .ag-sec[data-sec="runs"]')).toBeVisible();
    await page.keyboard.press('Control+Shift+KeyO');
    await expect(page.locator('#agents-panel.open')).toHaveCount(0);
  });

  // V-PSC-4: 설정 목록은 두 표에서 자동으로 그려진다 — 배선이 빠지면 여기서 드러난다.
  test('설정 ▸ Shortcuts 에 두 항목이 이름과 함께 뜬다', async ({ page }) => {
    await waitForInit(page);
    await page.click('#settings-btn');
    await page.click('button.mtab[data-tab="shortcuts"]');
    const list = page.locator('#sc-list');
    await expect(list).toContainText('백그라운드 도구');
    await expect(list).toContainText('Run 오케스트레이션');
  });
});

/**
 * 묶음 KEY — **브라우저 기본 키를 막는 경계** (FR-KEY-*).
 *
 * 단축키의 경계가 이 파일의 주제다 — 매칭 없는 Ctrl 조합은 막고, 예외는
 * 통과시킨다.
 *
 * `TEST-7` 로 `ux-revision` 에서 옮겨 왔다 — 납품 묶음이 아니라 **이 기능**이
 * 주제인 자리다. 단정은 옮기면서 바꾸지 않았다.
 */

test.describe('묶음 K — 브라우저 기본 키 차단 (FR-KEY-*)', () => {
  test('V-KEY-1·2·4: 매칭 없는 Ctrl 조합은 막고, 예외는 통과시킨다', async ({ page }) => {
    await gotoSettled(page);
    const probe = (code: string, key: string, ctrl = true) => page.evaluate(([c, k, ctrlKey]) => {
      const e = new KeyboardEvent('keydown', { code: c as string, key: k as string, ctrlKey: !!ctrlKey, bubbles: true, cancelable: true });
      window.dispatchEvent(e);
      return e.defaultPrevented;
    }, [code, key, ctrl] as any);

    // Ctrl+S 는 어느 단축키에도 없다 — 브라우저 저장을 막는다.
    expect(await probe('KeyS', 's')).toBe(true);
    // FR-KEY-4: 복사·새로고침은 그대로 둔다.
    expect(await probe('KeyC', 'c')).toBe(false);
    expect(await probe('F5', 'F5', false)).toBe(false);
    // FR-KEY-2: 수식키 없는 글자는 대상이 아니다.
    expect(await probe('KeyS', 's', false)).toBe(false);

    /**
     * **FR-KEY-6 철회 (D-K2).** 종전에는 여기서 스위치를 끄고 기본 동작이
     * 돌아오는 것을 쟀다. 스위치가 없어졌다 — 차단은 늘 돈다.
     *
     * 재는 대상이 *"끌 수 있는가"* 에서 *"끌 자리가 없는데도 도는가"* 로
     * 바뀐다. 위의 단정 넷이 이미 "돈다" 를 말하므로 여기서는 **스위치가
     * 사라졌다**는 사실만 더한다.
     */
    await expect(page.locator('#sc-blockbrowser')).toHaveCount(0);
  });

  /**
   * UX_REVISION_SRS FR-KEY-8 (D-K2): **입력기에서는 편집 키가 그대로 듣는다.**
   *
   * FR-M9-44 가 면제를 여섯으로 좁히면서 커서 이동과 줄 삭제가 통째로 막혔다.
   * 재는 것은 `defaultPrevented` 가 아니라 **커서와 값이 실제로 움직였는가**다 —
   * 막지 않는 것과 편집이 도는 것은 다른 말이고, 사용자가 겪은 것은 뒤쪽이다.
   */
  test('FR-KEY-8: 입력란에서 커서 이동·지움이 듣는다', async ({ page }) => {
    await waitForInit(page);
    await page.evaluate(() => {
      document.getElementById('search-bar')!.removeAttribute('hidden');
      (document.getElementById('search-input') as HTMLInputElement).focus();
    });
    const set = (val: string, at: number) => page.evaluate(([v, p]: any) => {
      const si = document.getElementById('search-input') as HTMLInputElement;
      si.value = v; si.focus(); si.setSelectionRange(p, p);
    }, [val, at] as any);
    const read = () => page.evaluate(() => {
      const si = document.getElementById('search-input') as HTMLInputElement;
      return { start: si.selectionStart, value: si.value };
    });

    /**
     * **누르는 키가 판마다 다르다** (`CI_E2E_MATRIX_SRS` FR-CEM-9 와 같은 이유).
     *
     * 브라우저의 편집 명령은 UA 가 아니라 **호스트 OS 의 관습**을 따른다 —
     * `devices['Desktop Chrome']` 이 UA 를 Windows 로 적어도 macOS 러너에서는
     * `Cmd+←` 가 줄 처음으로 가고 Linux 러너에서는 아무 일도 하지 않는다.
     * 그래서 판마다 **그 판의 편집 키**로 잰다. 재는 조항은 하나다 —
     * `KEY_EDIT_CODES` 의 면제가 없으면 어느 쪽이든 막힌다.
     */
    await set('hello world', 11);
    if (process.platform === 'darwin') {
      // 줄 단위다 — 자리가 결정적이라 그대로 단정한다.
      await page.keyboard.press('Meta+ArrowLeft');
      expect((await read()).start, 'Cmd+← 가 줄 처음으로 가지 않는다').toBe(0);

      await page.keyboard.press('Meta+ArrowRight');
      expect((await read()).start, 'Cmd+→ 가 줄 끝으로 가지 않는다').toBe(11);

      await page.keyboard.press('Meta+Backspace');
      expect((await read()).value, 'Cmd+Backspace 가 줄을 지우지 않는다').toBe('');
    } else {
      /**
       * 단어 단위다. **경계의 정의는 브라우저 관습이지 우리 계약이 아니다** —
       * 다음 단어의 앞에 서는 판과 앞 단어의 끝에 서는 판이 갈린다. 그래서
       * *"자리가 어디로 갔는가"* 가 아니라 **"움직였는가"** 를 잰다: 막혔다면
       * 한 칸도 움직이지 않는다.
       */
      await page.keyboard.press('Control+ArrowLeft');
      const left = (await read()).start!;
      expect(left, 'Ctrl+← 가 앞 단어로 가지 않는다').toBeLessThan(11);
      expect(left, 'Ctrl+← 가 줄 처음까지 넘어갔다 — 단어 단위가 아니다').toBeGreaterThan(0);

      await page.keyboard.press('Control+ArrowRight');
      expect((await read()).start, 'Ctrl+→ 가 뒤로 가지 않는다').toBeGreaterThan(left);

      await set('hello world', 11);
      await page.keyboard.press('Control+Backspace');
      const after = (await read()).value;
      expect(after.length, 'Ctrl+Backspace 가 앞 단어를 지우지 않는다').toBeLessThan(11);
      expect(after, '한 글자만 지웠다 — 단어 단위가 아니다').not.toBe('hello worl');
    }

    /**
     * **`Ctrl+E` 는 여기서 재지 않는다.** `IS_MAC` 은 `userAgentData` 를 보고
     * 그 값은 어느 러너에서나 `Windows` 다 — 그 판정 아래에서 `Ctrl+E` 는
     * 브라우저의 것(주소창)이라 막히는 것이 맞다. macOS 분기는 아래 시험이
     * 판정을 갈아 끼워 따로 잰다.
     */
  });

  /**
   * FR-KEY-8 의 macOS 분기 — `Ctrl` 조합은 통째로 편집이다.
   *
   * `IS_MAC` 은 스크립트가 평가될 때 한 번 정해지므로(`constants.js`) 페이지가
   * 뜨기 **전에** 판정의 근거를 갈아 끼운다.
   */
  test('FR-KEY-8 (macOS): Ctrl 조합이 편집으로 남는다', async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'userAgentData', { get: () => ({ platform: 'macOS' }) });
    });
    await waitForInit(page);
    expect(await page.evaluate(() => (0, eval)('IS_MAC')), '가장이 듣지 않았다').toBe(true);

    const prevented = await page.evaluate(() => {
      document.getElementById('search-bar')!.removeAttribute('hidden');
      const si = document.getElementById('search-input') as HTMLInputElement;
      si.value = 'hello world'; si.focus();
      const fire = (code: string, mods: Partial<KeyboardEventInit>) => {
        const e = new KeyboardEvent('keydown', { code, key: code, bubbles: true, cancelable: true, ...mods });
        si.dispatchEvent(e);
        return e.defaultPrevented;
      };
      return {
        ctrlE: fire('KeyE', { ctrlKey: true }),   // 줄 끝으로 (emacs)
        ctrlK: fire('KeyK', { ctrlKey: true }),   // 줄 끝까지 지움
        ctrlW: fire('KeyW', { ctrlKey: true }),   // 앞 단어 지움
        metaS: fire('KeyS', { metaKey: true }),   // 저장 — 이쪽은 막힌다
      };
    });
    expect(prevented.ctrlE, 'Ctrl+E 를 아직 막는다').toBe(false);
    expect(prevented.ctrlK, 'Ctrl+K 를 아직 막는다').toBe(false);
    expect(prevented.ctrlW, 'Ctrl+W 를 아직 막는다').toBe(false);
    // macOS 의 브라우저 액셀러레이터는 `Cmd` 기반이므로 그쪽은 그대로 막힌다.
    expect(prevented.metaS, 'Cmd+S 가 저장으로 샌다').toBe(true);
  });

  /**
   * 면제가 **다시 넓어지지 않았는지** 본다. FR-KEY-8 이 여는 것은 편집 키이고,
   * 브라우저의 저장·인쇄는 입력기 안에서도 그대로 막힌다.
   */
  test('FR-KEY-8 (역): 입력란에서도 저장·인쇄는 막힌다', async ({ page }) => {
    await waitForInit(page);
    const prevented = await page.evaluate(() => {
      document.getElementById('search-bar')!.removeAttribute('hidden');
      const si = document.getElementById('search-input') as HTMLInputElement;
      si.focus();
      const fire = (code: string, key: string) => {
        const e = new KeyboardEvent('keydown', { code, key, metaKey: true, bubbles: true, cancelable: true });
        si.dispatchEvent(e);
        return e.defaultPrevented;
      };
      return { s: fire('KeyS', 's'), p: fire('KeyP', 'p'), left: fire('ArrowLeft', 'ArrowLeft') };
    });
    expect(prevented.s, 'Cmd+S 가 브라우저 저장으로 샌다').toBe(true);
    expect(prevented.p, 'Cmd+P 가 인쇄로 샌다').toBe(true);
    expect(prevented.left, 'Cmd+← 를 아직 막고 있다').toBe(false);
  });

  /**
   * FR-KEY-7 개정 (D-K2): 못 막는 조합을 알리는 한 줄은 **키를 배정하는 사람**
   * 에게 하는 말이라 단축키 목록 위에 선다 — 스위치와 함께 사라지지 않는다.
   */
  test('FR-KEY-7: 못 막는 조합을 알리는 줄이 목록 위에 있다', async ({ page }) => {
    await waitForInit(page);
    await page.keyboard.press('Control+Shift+Slash');
    await expect(page.locator('#panel-shortcuts')).toBeVisible();
    const note = page.locator('#panel-shortcuts .ds-hint');
    await expect(note).toBeVisible();
    await expect(note).toContainText('Ctrl+W');
    const order = await page.evaluate(() => {
      const p = document.getElementById('panel-shortcuts')!;
      const n = p.querySelector('.ds-hint')!, l = p.querySelector('#sc-list')!;
      return n.compareDocumentPosition(l) & Node.DOCUMENT_POSITION_FOLLOWING ? 'note-first' : 'list-first';
    });
    expect(order, '안내가 목록 아래로 갔다').toBe('note-first');
  });
});

// 로드맵 M7 P2 — `UX-22`: 단축키를 **찾을 수 있다.** 목록은 설정 안에 있었지만
// 거기 닿는 키가 없었고, 키를 모르는 사람이 키 목록을 찾을 길은 메뉴뿐이었다.
test.describe('단축키 발견 (UX-22)', () => {
  test('Ctrl+Shift+/ 가 설정의 Shortcuts 탭을 연다', async ({ page }) => {
    await waitForInit(page);
    await page.keyboard.press('Control+Shift+Slash');
    await expect(page.locator('#modal-overlay')).toBeVisible();
    await expect(page.locator('#panel-shortcuts')).toBeVisible();
    // 그 키 자신도 목록에 있어 바꿀 수 있다.
    await expect(page.locator('#panel-shortcuts .sc-row', { hasText: '단축키 목록' })).toHaveCount(1);
  });
});

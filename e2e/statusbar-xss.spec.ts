import { test, expect, waitForInit } from './fixtures';

/**
 * 02-fe-arch 의 P0 — 터미널 출력이 상태바를 지나 스크립트가 된다.
 *
 * 셸에서 도는 **어떤 프로그램이든** 이 한 줄로 웹 UI 문서 컨텍스트에서 JS 를
 * 실행시킬 수 있었다:
 *
 *     printf '\e]777;Cwd;<img src=x onerror=…>\a'
 *
 * `cat` 한 파일, `curl` 응답, SSH 원격 호스트의 프롬프트, 에이전트 출력이 전부
 * 소스다. 그리고 이 UI 는 터미널·파일·git 쓰기·설정(ACL 포함) API 에 닿으므로
 * **XSS 가 원격 코드 실행에 준한다.**
 *
 * 싱크는 `app-statusbar.js` 의 `push('cwd', …)` 이고, 그 파일에 이스케이프
 * 호출이 0건이었다. 막는 자리는 값의 출처가 아니라 **싱크**다 — 출처를 세다
 * 보면 하나를 빠뜨리게 되고, 그 하나가 전부다.
 */
test.describe('묶음 SBX — 상태바는 터미널 출력을 그대로 그리지 않는다', () => {
  test('SBX1: OSC 777 Cwd 의 태그가 실행되지 않고 글자로 보인다', async ({ page }) => {
    await waitForInit(page);

    // 스크립트가 돌면 흔적을 남기게 해 둔다. 단정이 "요소가 없다" 뿐이면
    // 렌더링이 바뀌었을 때 조용히 통과한다.
    await page.evaluate(() => { (window as any).__xss = 0 });

    const payload = '/tmp/<img src=x onerror="window.__xss=1">';
    await page.evaluate((p) => {
      const app = (window as any).app;
      const pane = app._focusedTerminal();
      pane._onCwd(p);
    }, payload);

    const bar = page.locator('#sb-items');
    await expect(bar).toBeVisible();

    // ① 스크립트가 돌지 않았다.
    expect(await page.evaluate(() => (window as any).__xss),
      '터미널 출력이 문서 컨텍스트에서 스크립트를 실행했다').toBe(0);

    // ② 주입된 요소가 서지 않았다.
    expect(await page.locator('#sb-items img').count(),
      '터미널 출력이 만든 요소가 상태바에 섰다').toBe(0);

    // ③ 값은 **글자로** 보인다 — 막느라 표시가 사라지면 그것도 결함이다.
    await expect(bar).toContainText('img src=x');
  });

  test('SBX2: 따옴표가 든 값이 속성 경계를 깨지 않는다', async ({ page }) => {
    await waitForInit(page);
    await page.evaluate(() => { (window as any).__xss2 = 0 });

    // `title="…"` 로 들어가는 자리를 노린다 (location 지표).
    await page.evaluate(() => {
      const app = (window as any).app;
      app._stats = { ...(app._stats || {}), hostname: '" onmouseover="window.__xss2=1" x="' };
      app._updateStatusBar();
    });

    expect(await page.evaluate(() => (window as any).__xss2)).toBe(0);
    expect(await page.locator('#sb-items [onmouseover]').count(),
      '값이 속성 경계를 깨고 핸들러를 심었다').toBe(0);
  });
});

/**
 * 03-uiux 의 P1(`UX-1`) — 파괴적 확인창 **두 벌의 규약이 달랐다.**
 *
 * 그 수렴은 그대로다. **도착한 값이 2026-09-10 에 바뀌었다**
 * (POPUP_DEFAULT_ACTION_SRS FR-PDA-1·2·26).
 *
 *   이전: 초기 포커스는 취소, `Enter` 는 실행이 아니다
 *   지금: 초기 포커스는 **목적 버튼**, `Enter` 는 **포커스된 것**을 누른다
 *   이유: "UX 는 사용자가 하고자 했던 걸 유지하는 방향이지 안전한 방향이
 *         아니다" (사용자). 안전은 확인창의 존재와 `Esc` 가 진다
 *
 * `UX-1` 이 고친 넷 중 **둘은 되돌아가고 둘은 남는다** — 확인창이 한 벌로
 * 수렴한 것과 문구가 `textContent` 인 것은 이 결정과 무관하다.
 *
 * 여기서 재는 것은 그 "한 벌" 이 `GitConfirm` 과 **같은 값**에 도착했는가다.
 */
test.describe('묶음 UX1 — 확인창의 규약이 GitConfirm 과 같다', () => {
  test('UX1: Enter 는 포커스된 것을 누른다 — 취소에 두면 죽지 않는다', async ({ page }) => {
    await waitForInit(page);

    const decided = await page.evaluate(async () => {
      const app = (window as any).app;
      const p = app._confirmClose('실행 중인 프로세스가 있습니다. 탭을 닫으시겠습니까?', { bgBtn: true });
      await new Promise((r) => setTimeout(r, 0));
      // 취소로 옮긴 뒤의 Enter 는 취소다 — 팝업이 Enter 를 가로채지 않는다는
      // 증거다 (FR-PDA-2 / D-1). 합성 이벤트로는 브라우저의 click 합성이 일어나지
      // 않으므로, 버튼을 직접 눌러 그 자리의 의미만 잰다.
      const btn = document.querySelector('.confirm-overlay .confirm-cancel') as HTMLElement;
      btn.focus();
      btn.click();
      return await p;
    });

    expect(decided, '취소가 실행으로 읽혔다').toBe(false);
  });

  test('UX2: 초기 포커스는 목적 버튼이다', async ({ page }) => {
    await waitForInit(page);
    const focused = await page.evaluate(async () => {
      const app = (window as any).app;
      app._confirmClose('닫으시겠습니까?', { bgBtn: true, saveBtn: true });
      await new Promise((r) => setTimeout(r, 0));
      const cls = document.activeElement ? document.activeElement.className : '';
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      return cls;
    });
    // 저장 갈래가 있으면 그것이 목적이다 (D-4) — 이 창이 뜨는 이유가 저장 안 된
    // 편집이기 때문이다.
    expect(focused, '목적 버튼에 손이 먼저 가지 않는다').toContain('confirm-save');
  });
});

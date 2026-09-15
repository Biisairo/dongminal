import { test, expect, waitForInit, keepToolBusy, JSON_HDR } from './fixtures';

/**
 * M11_SRS FR-M11-13 (M11-B10) — **새로고침해도 '에이전트로' 가 서 있다.**
 *
 * 접수: *"'에이전트로' 버튼이 새로고침하면 사라졌다가 다음 이벤트가 있을때 다시
 * 버튼이 뜨네"*. 진입점은 서버의 답(`GET /api/agent/session`)으로만 서는데, 묻는
 * 계기가 **탭 이동**과 **활동 신호** 둘뿐이다. 새로 뜬 화면에는 둘 다 없다.
 *
 * 에이전트를 실제로 띄우지 않는다 — 재는 것은 **진입점이 서는가**이고, 신원은
 * 훅이 쓰는 종단(`/api/tools/activity/set`)으로 직접 심는다. 그 종단이 신원을
 * 나르는 것은 FR-M11-8 이 세운 계약이다.
 */

const LIFT = '#area .pn.focused .tp-lift';
// 새로고침 뒤의 준비 판정 — 기본값(`xterm-helper-textarea`)은 **포커스가 있어야**
// 보이므로, 명령이 도는 터미널에서는 서지 않는다. 화면이 섰다는 사실은 행이 말한다.
const READY = { readyFor: { selector: '#area .pn.focused .xterm-rows' } };

const focusedToolId = (page) =>
  page.evaluate(() => [...(window as any).app.tools.values()][0].id as string);

test.describe('M11 — 올리기 진입점의 수명 (FR-M11-13)', () => {
  /**
   * **아직 고치지 않았다 — 이 검사는 재현이다.** `fixme` 를 지우는 것이 B10 의
   * 첫 걸음이고, 그때 빨갛게 떨어지는 것이 고칠 대상이다.
   *
   * 원인의 후보: 진입점을 묻는 계기가 `renderer.js` 의 **이동**(`moved`)과
   * `app-agents.js` 의 **활동 신호** 둘뿐이다. 새로 뜬 화면에는 이동이 없고, 다음
   * 훅이 올 때까지 활동도 없다. 첫 마운트에 `term` 이 아직 없어 그 호출이
   * 건너뛰어지는지도 함께 봐야 한다 (확인하지 않았다).
   */
  test.fixme('V-M11-30: 새로고침 뒤에도 에이전트로 버튼이 선다 (FR-M11-13)', async ({ page, request }) => {
    await waitForInit(page);
    const toolId = await focusedToolId(page);
    await keepToolBusy(page);

    // 훅이 하는 일과 같은 보고 — 신원이 활동과 함께 온다 (FR-M11-8).
    const r = await request.post('/api/tools/activity/set', {
      headers: JSON_HDR,
      data: { toolId, agent: 'claude', state: 'idle', sessionId: 'sess-reload-1' },
    });
    expect(r.ok()).toBeTruthy();

    // 활동 신호가 계기가 되어 버튼이 선다 — 여기까지는 종전에도 됐다.
    await expect(page.locator(LIFT)).toBeVisible({ timeout: 15000 });

    // **새로고침.** 서버는 그대로 알고 있으므로 버튼도 그대로여야 한다.
    await page.reload();
    await waitForInit(page, READY);
    await expect(page.locator(LIFT),
      '새로고침하면 사라졌다가 다음 이벤트에야 다시 뜬다 (M11-B10)').toBeVisible({ timeout: 15000 });
  });

  test('V-M11-31: 올릴 수 없는 도구에는 새로고침 뒤에도 서지 않는다 (FR-M11-13)', async ({ page }) => {
    await waitForInit(page);
    // 신원을 심지 않는다. 대부분의 터미널이 이 상태다 — 물어본 것만으로 버튼이
    // 서면 그것은 "모른다" 를 "있다" 로 읽는 것이다.
    await page.reload();
    await waitForInit(page, READY);
    await expect(page.locator(LIFT)).toBeHidden();
  });
});

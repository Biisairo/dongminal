import AxeBuilder from '@axe-core/playwright';
import { Page } from '@playwright/test';

import { test, expect, waitForInit, waitSettled } from './fixtures';

/**
 * M8_UNIFIED_SRS 묶음 T — 에이전트 도구의 브라우저 몫 (V-2·V-3·V-5·V-6·V-10·V-12,
 * FR-AGT-1·4·4a·5·7·9·10·12). 에이전트는 가짜다 (`global-setup` 이 `DONGMINAL_AGENT_BIN_DIR`
 * 에 놓는다, D-C-7·9) — 시나리오는 프롬프트 본문이 고른다.
 *
 * 어댑터 id `claude`·`codex`·`omp` 는 등록부의 것이다. e2e 는 Go 를 읽지 못하므로 여기
 * 적는다. 앞의 여덟은 claude 로 뷰의 전부를 재고(TC-AGT-11 이 P5 의 휴면·재개), 뒤의 행렬(P4·P5)은
 * 나머지 두 프로토콜이 **같은 뷰**에서 같은 시나리오를 도는지 잰다 (FR-U-2 — 소비자 쪽은
 * 달라지지 않는다).
 */
const AGENT = 'claude';
const MENU_ITEM = `.ui-menu .ui-menu-item[data-id="agent:${AGENT}"]`;
// 새로고침 뒤의 준비 판정 — `waitForInit` 의 기본은 포커스 칸의 xterm 이고, 활성 탭이
// 에이전트 탭이면 그것은 서지 않는다 (InitOpts.readyFor).
const AGENT_PANE_READY = '#area .pn.focused .agent-pane.vis';

async function openAgentTab(page: Page, agent = AGENT) {
  const item = `.ui-menu .ui-menu-item[data-id="agent:${agent}"]`;
  const before = await page.locator('#area .pn.focused .pn-tab').count();
  await page.locator('#area .pn.focused .pn-tab-add').click({ button: 'right' });
  await expect(page.locator(item)).toBeVisible({ timeout: 10000 });
  const [resp] = await Promise.all([
    page.waitForResponse((r) => r.url().includes('/api/tools?kind=agent') && r.request().method() === 'POST'),
    page.locator(item).click(),
  ]);
  expect(resp.status()).toBe(200);
  await expect(page.locator('#area .pn.focused .pn-tab')).toHaveCount(before + 1, { timeout: 10000 });
  const pane = page.locator('#area .pn.focused .agent-pane.vis');
  await expect(pane).toBeVisible({ timeout: 10000 });
  // FR-AGT-8: `system:init` 이 idle 로 읽힌다 — dmctl wait --for ready 와 같은 근거.
  await expect(pane).toHaveAttribute('data-state', 'idle', { timeout: 15000 });
  return pane;
}

async function send(pane: ReturnType<Page["locator"]>, text: string) {
  const ta = pane.locator('.agp-ta');
  await ta.click();
  await ta.fill(text);
  await ta.press('Enter');
}

async function axeViolations(page: Page) {
  const r = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .exclude('.xterm').exclude('.monaco-editor')
    .analyze();
  return r.violations.map((v) => `${v.id} ×${v.nodes.length}: ${v.help} — ${v.nodes[0]?.target?.join(' ') || ''}`);
}

test.describe('에이전트 도구 (M8 묶음 T)', () => {
  test('TC-AGT-1: 에이전트 탭이 서고 한 턴이 오간다 — 대화·상태·사용량 (FR-AGT-1·4)', async ({ page }) => {
    await waitForInit(page);
    const pane = await openAgentTab(page);
    // 탭 레코드는 type:agent 다 (D-C-1) — 이름은 어댑터 id.
    await expect(page.locator('#area .pn.focused .pn-tab.active .pn-tab-label')).toHaveText(AGENT);
    await send(pane, 'say PONG');
    await expect(pane.locator('.agp-msg.agp-user .agp-body')).toHaveText('say PONG');
    await expect(pane.locator('.agp-msg.agp-assistant .agp-body').last()).toHaveText('PONG', { timeout: 15000 });
    await expect(pane).toHaveAttribute('data-state', 'done', { timeout: 15000 });
    // 사용량·컨텍스트 창·비용은 프레임에서 온다 (FR-AGT-6).
    await expect(pane.locator('.agp-ctx')).toContainText('%');
    await expect(pane.locator('.agp-cost')).toContainText('0.0010');
    await expect(pane.locator('.agp-model')).toContainText('fake-model-1');
    // FR-AGT-7: 같은 칸에 터미널 탭이 섞여도 배치·전환이 된다 (V-6).
    await page.locator('#area .pn.focused .pn-tab-add').click();
    await expect(page.locator('#area .pn.focused .tp.vis')).toBeVisible({ timeout: 10000 });
    await expect(pane).toBeHidden();
    await page.locator('#area .pn.focused .pn-tab').nth(1).click();
    await expect(page.locator('#area .pn.focused .agent-pane.vis')).toBeVisible();
  });

  test('TC-AGT-2: 승인 요청은 다이얼로그로 오고 선택지는 프로토콜 것 그대로다 (V-2, FR-APS-5·6, FR-AGT-5·9)', async ({ page }) => {
    await waitForInit(page);
    const pane = await openAgentTab(page);
    await send(pane, 'please APPROVE this');
    const dlg = page.locator('.ui-modal.agp-modal .ui-modal-box');
    await expect(dlg).toBeVisible({ timeout: 15000 });
    await expect(dlg).toHaveAttribute('role', 'dialog');
    await expect(dlg.locator('.ui-modal-title')).toContainText('Bash');
    await expect(dlg.locator('.agp-appr-in')).toContainText('touch fake.txt');
    // allow · deny · 제안 하나 = 셋. 우리가 접거나 늘리지 않는다.
    await expect(dlg.locator('.agp-choice')).toHaveCount(3);
    await expect(dlg.locator('.agp-choice[data-choice="suggestion:0"]')).toContainText('acceptEdits');
    // FR-A11Y-19: 도착이 라이브 리전으로 읽힌다.
    await expect(page.locator('#toast-host')).toContainText('Bash');
    await expect(pane).toHaveAttribute('data-state', 'waiting');
    await expect(pane.locator('.agp-open')).toContainText('1');
    // 열린 상태에서 axe 위반 0 (FR-AGT-9).
    expect(await axeViolations(page)).toEqual([]);
    // Esc 는 답이 아니다 — 요청은 열린 채 남고 메뉴 없이도 다시 열린다 (FR-APS-6).
    await page.keyboard.press('Escape');
    await expect(dlg).toBeHidden();
    await expect(pane.locator('.agp-open')).toContainText('1');
    // 활성 탭이 에이전트 탭이므로 준비 판정은 그 뷰다 — 기본값(xterm)은 서지 않는다.
    await page.reload();
    await waitForInit(page, { readyFor: { selector: AGENT_PANE_READY } });
    await expect(page.locator('.ui-modal.agp-modal .ui-modal-box')).toBeVisible({ timeout: 15000 });
    // 제안을 고르면 권한 모드가 바뀌고(status) 턴이 끝난다.
    await page.locator('.ui-modal.agp-modal .agp-choice[data-choice="suggestion:0"]').click();
    await expect(page.locator('.ui-modal.agp-modal')).toBeHidden({ timeout: 10000 });
    const pane2 = page.locator('#area .pn.focused .agent-pane.vis');
    await expect(pane2.locator('.agp-msg.agp-assistant .agp-body').last()).toHaveText('DONE', { timeout: 15000 });
    await expect(pane2.locator('.agp-perm')).toContainText('acceptEdits');
    await expect(pane2.locator('.agp-tool .agp-tool-res')).toContainText('completed');
    await expect(pane2.locator('.agp-open')).toHaveText('');
  });

  test('TC-AGT-3: 질문 답변 — 선택형 질문이 다이얼로그로 오고 답이 되읊힌다 (FR-AGT-4)', async ({ page }) => {
    await waitForInit(page);
    const pane = await openAgentTab(page);
    await send(pane, 'QUESTION');
    const dlg = page.locator('.ui-modal.agp-modal .ui-modal-box');
    await expect(dlg).toBeVisible({ timeout: 15000 });
    await expect(dlg.locator('.agp-q legend')).toContainText('Pick a color');
    await expect(dlg.locator('.agp-q input')).toHaveCount(2);
    await dlg.locator('.agp-q input[value="Blue"]').check();
    await dlg.locator('.ui-modal-foot .ui-btn-primary').click();
    await expect(dlg).toBeHidden({ timeout: 10000 });
    await expect(pane.locator('.agp-msg.agp-assistant .agp-body').last()).toHaveText('Blue', { timeout: 15000 });
  });

  test('TC-AGT-4: Esc 인터럽트 · ↑↓ 히스토리 · 슬래시 자동완성 (FR-AGT-4a)', async ({ page }) => {
    await waitForInit(page);
    const pane = await openAgentTab(page);
    await send(pane, 'first PONG');
    await expect(pane).toHaveAttribute('data-state', 'done', { timeout: 15000 });
    await send(pane, 'SLOW');
    await expect(pane.locator('.agp-msg.agp-live .agp-body')).toContainText('tick', { timeout: 15000 });
    await pane.locator('.agp-ta').press('Escape');
    await expect(pane.locator('.agp-line.agp-err')).toBeVisible({ timeout: 15000 });
    await expect(pane).toHaveAttribute('data-state', 'done');
    // 히스토리: ↑ 가 마지막 프롬프트, 다시 ↑ 가 그 앞.
    const ta = pane.locator('.agp-ta');
    await ta.click();
    await ta.press('ArrowUp');
    await expect(ta).toHaveValue('SLOW');
    await ta.press('ArrowUp');
    await expect(ta).toHaveValue('first PONG');
    await ta.press('ArrowDown');
    await expect(ta).toHaveValue('SLOW');
    await ta.press('ArrowDown');
    await expect(ta).toHaveValue('');
    // 슬래시: 목록은 initialize 의 commands 다.
    await ta.fill('/co');
    await expect(pane.locator('.agp-sugg .agp-sugg-item')).toHaveText(['/compact']);
    await pane.locator('.agp-sugg .agp-sugg-item').click();
    await expect(ta).toHaveValue('/compact ');
    await ta.fill('/clear');
    await ta.press('Enter');
    await expect(pane.locator('.agp-line', { hasText: /세션|session/ })).toBeVisible({ timeout: 15000 });
  });

  test('TC-AGT-5: 새로고침 뒤 이벤트 로그로 복원되고, 메뉴의 모델 전환·권한 순환이 된다 (FR-ABG-4 P3 · FR-AGT-11)', async ({ page }) => {
    await waitForInit(page);
    const pane = await openAgentTab(page);
    await send(pane, 'say PONG');
    await expect(pane.locator('.agp-msg.agp-assistant .agp-body').last()).toHaveText('PONG', { timeout: 15000 });
    await waitSettled(page);
    await page.reload();
    await waitForInit(page, { readyFor: { selector: AGENT_PANE_READY } });
    const pane2 = page.locator('#area .pn.focused .agent-pane.vis');
    await expect(pane2).toBeVisible({ timeout: 15000 });
    await expect(pane2.locator('.agp-msg.agp-user .agp-body')).toHaveText('say PONG', { timeout: 15000 });
    await expect(pane2.locator('.agp-msg.agp-assistant .agp-body').last()).toHaveText('PONG');
    // 메뉴: 모델 목록은 프로토콜이 준 것 그대로 (FR-AGT-11).
    await pane2.locator('.agp-menu-btn').click();
    await expect(page.locator('.ui-menu.agp-menu .ui-menu-item[data-id="model:fast"]')).toBeVisible();
    await page.locator('.ui-menu.agp-menu .ui-menu-item[data-id="model:fast"]').click();
    await expect(pane2.locator('.agp-model')).toContainText('fast', { timeout: 10000 });
    // Shift+Tab 순환: default → acceptEdits.
    await pane2.locator('.agp-ta').click();
    await pane2.locator('.agp-ta').press('Shift+Tab');
    await expect(pane2.locator('.agp-perm')).toContainText('acceptEdits', { timeout: 10000 });
    expect(await axeViolations(page)).toEqual([]);
  });

  test('TC-AGT-6: TUI 출구 — 같은 세션을 터미널 탭에서 (FR-AGT-10, V-10)', async ({ page }) => {
    await waitForInit(page);
    const pane = await openAgentTab(page);
    // D-C-16: 세션 신원은 첫 턴 뒤에 온다 (실제 claude 의 `system:init` 시점) — 첫 턴 전에는 없다.
    expect(await pane.getAttribute('data-sessionid')).toBeFalsy();
    await send(pane, 'say PONG');
    await expect(pane).toHaveAttribute('data-state', 'done', { timeout: 15000 });
    const sid = await pane.getAttribute('data-sessionid');
    expect(sid).toBeTruthy();
    /**
     * V-M9-36 (FR-M9-36 / M9-B17): **보이는 진입점이 머리에 선다.** 접수한 말이
     * *"어떤 경로에서 여는 건지도 모르고, 어떻게 여는지도 알기 힘들다"* 였다.
     * 우클릭은 그대로 두고 더하는 것이므로, 아래 우클릭 경로도 그대로 잰다.
     */
    await expect(pane.locator('.agp-tui-btn')).toBeVisible();
    const tabs = page.locator('#area .pn.focused .pn-tab');
    const tab = page.locator('#area .pn.focused .pn-tab.active');
    const before = await tabs.count();
    /**
     * V-M9-31 (M9_SRS FR-M9-31 / M9-B14): **전환은 제자리에서 일어난다.**
     *
     *   이전 계약: `toHaveCount(before + 1)` — 터미널 탭이 하나 **더** 생기고
     *             에이전트 탭이 남는다. 그것이 접수한 말로 "자연스럽지 못하다"
     *             인 자리였다 (`M9_SRS` §2.2 M9-B14)
     *   새  계약: 탭 수가 **그대로**이고, 터미널 탭이 **옛 에이전트 탭의 자리**에
     *             선다
     *
     * **자리를 함께 재는 이유**: 탭 수만 재면 "둘 다 생기고 엉뚱한 하나가 닫힘"
     * 에도 초록이 난다 (`M9_PROGRESS` §2-12 — 증상을 재는 검사).
     */
    const idxBefore = await tab.evaluate(
      (el) => [...(el.parentElement as HTMLElement).children].indexOf(el));
    await tab.click({ button: 'right' });
    await expect(page.locator('.ui-menu .ui-menu-item[data-id="agent-tui"]')).toBeVisible();
    await page.locator('.ui-menu .ui-menu-item[data-id="agent-tui"]').click();
    /**
     * **먼저 전환이 끝난 것을 본다.** 탭 수부터 재면 터미널 탭이 서기도 전에
     * `toHaveCount(before)` 가 즉시 참이 되어, **아무 일도 일어나지 않은 상태**에
     * 초록을 준다 (이 검사를 고치는 첫 판이 그랬다 — §2-12 를 한 번 더 밟았다).
     */
    await expect(page.locator('#area .pn.focused .tp.vis')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('#area .pn.focused .tp.vis .xterm-rows')).toContainText('--resume ' + sid, { timeout: 15000 });
    // 그 다음에야 자리와 수가 뜻을 갖는다 (FR-M9-31).
    await expect(tabs).toHaveCount(before, { timeout: 10000 });
    const idxAfter = await page.locator('#area .pn.focused .pn-tab.active').evaluate(
      (el) => [...(el.parentElement as HTMLElement).children].indexOf(el));
    expect(idxAfter, '터미널 탭이 옛 에이전트 탭의 자리에 서지 않았다').toBe(idxBefore);
  });

  /**
   * V-M9-34 (M9_SRS FR-M9-34 / M9-B16): **플랜 한도가 주기별로 선다.**
   *
   * 이 값은 `rate_limit_event` 로 **이미 오고 있었고** 어댑터가 알아본 뒤 버렸다
   * (`claude_proto.go` — `return nil, true`). D-M9-22 의 첫 판이 "프로토콜이 주지
   * 않는다" 를 적은 자리이며, 실측이 그것을 반증했다 (`M9_PROGRESS` §2-23).
   *
   * **재는 것 셋**: ① 주기가 여럿 선다 ② 짧은 주기가 먼저다(`resetsAt` 오름차순 —
   * map 순회는 무작위라 정렬이 없으면 회차마다 흔들린다) ③ **화면이 모르는 주기는
   * 이름 그대로 선다** (D-M9-23). ③ 이 핵심이다 — 열거로 굳힌 구현에서는 그 창이
   * 조용히 사라지고, 그것이 `Signals` 가 막으려던 실패와 같은 종류다.
   */
  test('V-M9-34 (FR-M9-34): 플랜 한도가 주기별로 서고 모르는 주기는 이름 그대로', async ({ page }) => {
    await waitForInit(page);
    const pane = await openAgentTab(page);
    const limits = pane.locator('.agp-limits');
    // 첫 턴 전에는 한도가 오지 않았다 — 그때 자리가 서면 "0%" 로 읽힌다 (FR-CBG-5).
    await expect(limits).toBeHidden();
    await send(pane, 'say PONG');
    await expect(pane).toHaveAttribute('data-state', 'done', { timeout: 15000 });
    await expect(limits).toBeVisible({ timeout: 10000 });
    const text = (await limits.textContent()) || '';
    // 아는 주기는 번역되고 모르는 주기는 어댑터가 준 이름이 그대로 선다.
    expect(text, `한도 줄: ${text}`).toContain('44%');
    expect(text, `모르는 주기가 사라졌다: ${text}`).toContain('opus_weekly');
    // 짧은 주기가 먼저다 — 44%(five_hour) 가 2%(opus_weekly) 앞에 있다.
    expect(text.indexOf('44%')).toBeLessThan(text.indexOf('opus_weekly'));
  });

  /**
   * V-M9-33 · V-M9-36 (M9_SRS FR-M9-33·36 / M9-B15·B17): **CLI → GUI 올리기.**
   *
   * `FR-AGT-10` 이 *"반대 방향도 같은 Resume 으로 가능해야 한다 — P0 스파이크가
   * 확인한다"* 로 남겨 둔 절반이다. 그 스파이크는 돌지 않았고 이 검사가 대신한다.
   *
   * 훅을 **흉내 낸다** — 실측(2026-09-14)에서 dongminal 셸이 `claude` 를 래핑해
   * Run 밖의 탭에서도 활동 훅이 돌고 `sessionId` 를 이 종단으로 보낸다. e2e 의
   * 터미널에는 진짜 에이전트가 없으므로 그 한 걸음만 대신한다.
   *
   * **재는 것 셋**: ① 신원이 오기 전에는 버튼이 없다 ② 오면 선다(보이게 될 때 묻는다)
   * ③ 누르면 에이전트 탭이 서고 **터미널 탭은 남는다** — ③ 이 D-M9-20 이고,
   * `agentOpenTerminal`(탭을 닫는다)과 **대칭이 아닌 것이 의도**다.
   */
  test('V-M9-33/36 (FR-M9-33·36): 셸의 세션을 GUI 로 올리고 터미널 탭은 남는다', async ({ page }) => {
    await waitForInit(page);
    const term = page.locator('#area .pn.focused .tp.vis');
    await expect(term).toBeVisible({ timeout: 10000 });
    const toolId = await term.getAttribute('data-toolid');
    expect(toolId, '터미널 도구가 없다').toBeTruthy();

    // ① 신원이 오기 전에는 진입점이 없다.
    await expect(term.locator('.tp-lift')).toBeHidden();

    // 활동 훅이 신원을 실어 온다 (FR-M9-32 의 경로).
    const posted = await page.evaluate(async (id) => {
      const r = await fetch('/api/runs/context', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ toolId: id, agent: 'claude', sessionId: 'sid-lift-e2e', bytes: 10 }),
      });
      return r.status;
    }, toolId);
    expect(posted, '훅 종단이 받지 않았다').toBe(200);

    // ② 보이게 될 때 묻는다 — 탭을 하나 더 만들고 돌아온다 (실제 사용자 경로다).
    const tabs = page.locator('#area .pn.focused .pn-tab');
    const before = await tabs.count();
    await page.locator('#area .pn.focused .pn-tab-add').click();
    await expect(tabs).toHaveCount(before + 1, { timeout: 10000 });
    const termIdx = before - 1;
    await tabs.nth(termIdx).click();
    const lift = page.locator(`#area .pn.focused .tp.vis[data-toolid="${toolId}"] .tp-lift`);
    await expect(lift).toBeVisible({ timeout: 10000 });

    // ③ 올린다.
    const after = await tabs.count();
    await lift.click();
    // 에이전트 탭이 **더해진다** — 터미널 탭을 대신하는 것이 아니다.
    await expect(tabs, '에이전트 탭이 서지 않았다').toHaveCount(after + 1, { timeout: 15000 });
    await expect(page.locator(AGENT_PANE_READY)).toBeVisible({ timeout: 15000 });
    /**
     * **터미널 탭은 남는다** (D-M9-20). 비활성 탭의 DOM 은 떼어지므로(`_hideOthers`)
     * 요소의 존재로는 잴 수 없다 — **돌아가서** 그 도구가 그대로인지 본다. 이것이
     * 사용자가 실제로 겪는 경로이기도 하다.
     */
    await tabs.nth(termIdx).click();
    await expect(page.locator(`#area .pn.focused .tp.vis[data-toolid="${toolId}"]`),
      '터미널 도구가 사라졌다 — D-M9-20 은 탭을 남긴다').toBeVisible({ timeout: 10000 });
  });

  /**
   * V-M9-35 (M9_SRS FR-M9-35 / M9-B16 의 ③): **그 도구의 cwd 와 저장소.**
   *
   * 접수한 말에 *"path, branch, upstream"* 이 있었고, 이 셋은 **프로토콜이 준 것이
   * 아니라 도구의 것**이다. 그래서 재는 것이 값 자체가 아니라 **출처의 구분**이다 —
   * `title` 이 "에이전트가 보고한 값이 아니다" 를 말하고, 경로를 함께 싣는다.
   * 그 문장이 없으면 사용자는 이 값을 에이전트가 말한 것으로 읽는다.
   *
   * 저장소가 아닌 cwd 에서는 `agp-repo` 가 **빈다** — `-` 나 `unknown` 으로 채우지
   * 않는다 (FR-CBG-5). 그 갈래는 값의 유무가 환경에 달렸으므로, 여기서는 "채워져
   * 있다면 git 이 준 모양이다" 까지만 고정한다.
   */
  test('V-M9-35 (FR-M9-35): 그 도구의 cwd 가 서고 출처를 title 이 말한다', async ({ page }) => {
    await waitForInit(page);
    const pane = await openAgentTab(page);
    const cwd = pane.locator('.agp-cwd');
    await expect(cwd).not.toBeEmpty({ timeout: 10000 });
    const title = (await cwd.getAttribute('title')) || '';
    // 문구 + 줄바꿈 + 절대 경로. 경로만 있으면 출처를 말하지 못한다.
    expect(title, `cwd title: ${title}`).toContain('\n');
    expect(title.split('\n')[1] || '', `cwd title: ${title}`).toMatch(/^[/~]/);
    // 저장소 갈래: 비었거나, git 이 준 이름이다 (대체값을 넣지 않는다).
    const repo = ((await pane.locator('.agp-repo').textContent()) || '').trim();
    if (repo) {
      expect(repo, `repo: ${repo}`).not.toBe('-');
      expect((await pane.locator('.agp-repo').getAttribute('title')) || '').toContain('\n');
    }
  });

  test('TC-AGT-7: 프로세스가 죽으면 오류 상태 — 사유가 보이고 입력이 막히고, 재개가 된다 (V-8, FR-ABG-20)', async ({ page }) => {
    await waitForInit(page);
    const pane = await openAgentTab(page);
    await send(pane, 'DIE');
    // P5 D-C-11·15: 죽음은 `ended` 가 아니라 오류 상태다 — idle 로 읽히지 않는다.
    await expect(pane).toHaveAttribute('data-state', 'error', { timeout: 15000 });
    await expect(pane.locator('.agp-line.agp-err', { hasText: 'exit 1' })).toBeVisible();
    const row = pane.locator('.agp-line.agp-dormant[data-dormant="error"]');
    await expect(row).toBeVisible();
    await expect(pane.locator('.agp-ta')).toBeDisabled();
    // 신원이 있으므로(DIE 앞의 init) 재개 버튼이 있다 — 재개하면 같은 세션이 이어진다.
    const sid = await pane.getAttribute('data-sessionid');
    expect(sid).toBeTruthy();
    await row.locator('.agp-resume').click();
    await expect(pane).toHaveAttribute('data-state', 'idle', { timeout: 15000 });
    await expect(pane.locator('.agp-ta')).toBeEnabled();
    await send(pane, 'say PONG');
    await expect(pane.locator('.agp-msg.agp-assistant .agp-body').last()).toHaveText('PONG', { timeout: 15000 });
    expect(await pane.getAttribute('data-sessionid')).toBe(sid);
    // 탭은 닫힌다 — 같은 닫기 길 (FR-AGT-7).
    const before = await page.locator('#area .pn.focused .pn-tab').count();
    await page.locator('#area .pn.focused .pn-tab.active .pn-tab-x').click();
    await expect(page.locator('#area .pn.focused .pn-tab')).toHaveCount(before - 1, { timeout: 10000 });
  });

  test('TC-AGT-11: 휴면 — 첫 턴 전엔 막히고, 휴면 뒤 새로고침에도 탭이 남고, 재개하면 같은 세션 (FR-ABG-4·10·11, V-3)', async ({ page }) => {
    await waitForInit(page);
    const pane = await openAgentTab(page);
    // D-C-16: 신원이 없으면 휴면 메뉴가 비활성이다.
    await pane.locator('.agp-menu-btn').click();
    await expect(page.locator('.ui-menu.agp-menu .ui-menu-item[data-id="hibernate"]')).toBeDisabled();
    await page.keyboard.press('Escape');
    await send(pane, 'say PONG');
    await expect(pane.locator('.agp-msg.agp-assistant .agp-body').last()).toHaveText('PONG', { timeout: 15000 });
    await expect(pane).toHaveAttribute('data-state', 'done', { timeout: 15000 });
    const sid = await pane.getAttribute('data-sessionid');
    expect(sid).toBeTruthy();
    await pane.locator('.agp-menu-btn').click();
    await page.locator('.ui-menu.agp-menu .ui-menu-item[data-id="hibernate"]').click();
    await expect(pane).toHaveAttribute('data-state', 'hibernated', { timeout: 15000 });
    await expect(pane.locator('.agp-line.agp-dormant[data-dormant="hibernated"] .agp-resume')).toBeVisible();
    await expect(pane.locator('.agp-ta')).toBeDisabled();
    // FR-ABG-4: 새로고침 — 휴면 도구는 목록에 남아(D-C-17) 탭이 살고, 재생이 대화를 되살린다.
    await waitSettled(page);
    await page.reload();
    await waitForInit(page, { readyFor: { selector: AGENT_PANE_READY } });
    const pane2 = page.locator('#area .pn.focused .agent-pane.vis');
    await expect(pane2).toHaveAttribute('data-state', 'hibernated', { timeout: 15000 });
    await expect(pane2.locator('.agp-msg.agp-user .agp-body')).toHaveText('say PONG');
    await expect(pane2.locator('.agp-msg.agp-assistant .agp-body').last()).toHaveText('PONG');
    // 재개 — 같은 탭, 같은 세션. 이력은 우리 로그가 이미 그렸고 새 이벤트가 이어진다.
    await pane2.locator('.agp-line.agp-dormant .agp-resume').click();
    await expect(pane2).toHaveAttribute('data-state', 'idle', { timeout: 15000 });
    await expect(pane2.locator('.agp-ta')).toBeEnabled();
    await send(pane2, 'say PONG again');
    await expect(pane2.locator('.agp-msg.agp-assistant .agp-body').last()).toHaveText('PONG', { timeout: 15000 });
    expect(await pane2.getAttribute('data-sessionid')).toBe(sid);
    await expect(pane2.locator('.agp-msg.agp-user .agp-body')).toHaveCount(2);
    expect(await axeViolations(page)).toEqual([]);
  });
});

/**
 * P4 · §9.2 R-a: 나머지 두 프로토콜. 승인 선택지의 수와 도구 이름은 프로토콜이 준 그대로다
 * (FR-AGT-5) — codex 는 accept·decline·acceptForSession·amendment·cancel 다섯, omp 는
 * Approve·Deny 둘. 그 밖의 뷰 동작은 셋이 같아야 한다.
 */
const OTHERS = [
  { agent: 'codex', tool: 'commandExecution', choices: 5 },
  { agent: 'omp', tool: 'bash', choices: 2 },
];

for (const { agent, tool, choices } of OTHERS) {
  test.describe(`에이전트 도구 — ${agent} (M8 P4)`, () => {
    test(`TC-AGT-8/${agent}: 한 턴 · 사용량 · 모델 (FR-AGT-1·6)`, async ({ page }) => {
      await waitForInit(page);
      const pane = await openAgentTab(page, agent);
      await expect(page.locator('#area .pn.focused .pn-tab.active .pn-tab-label')).toHaveText(agent);
      await send(pane, 'say PONG');
      await expect(pane.locator('.agp-msg.agp-user .agp-body')).toHaveText('say PONG');
      await expect(pane.locator('.agp-msg.agp-assistant .agp-body').last()).toHaveText('PONG', { timeout: 15000 });
      await expect(pane).toHaveAttribute('data-state', 'done', { timeout: 15000 });
      await expect(pane.locator('.agp-ctx')).toContainText('%');
      await expect(pane.locator('.agp-model')).toContainText('fake-model-1');
      expect(await axeViolations(page)).toEqual([]);
    });

    test(`TC-AGT-9/${agent}: 승인 다이얼로그 — 선택지는 프로토콜 것 그대로 (V-2, FR-AGT-5)`, async ({ page }) => {
      await waitForInit(page);
      const pane = await openAgentTab(page, agent);
      await send(pane, 'please APPROVE this');
      const dlg = page.locator('.ui-modal.agp-modal .ui-modal-box');
      await expect(dlg).toBeVisible({ timeout: 15000 });
      await expect(dlg.locator('.ui-modal-title')).toContainText(tool);
      await expect(dlg.locator('.agp-appr-in')).toContainText('touch fake.txt');
      await expect(dlg.locator('.agp-choice')).toHaveCount(choices);
      await expect(page.locator('#toast-host')).toContainText(tool);
      await expect(pane).toHaveAttribute('data-state', 'waiting');
      await expect(pane.locator('.agp-open')).toContainText('1');
      expect(await axeViolations(page)).toEqual([]);
      await dlg.locator('.agp-choice[data-choice="allow"]').click();
      await expect(page.locator('.ui-modal.agp-modal')).toBeHidden({ timeout: 10000 });
      await expect(pane.locator('.agp-msg.agp-assistant .agp-body').last()).toHaveText('DONE', { timeout: 15000 });
      await expect(pane.locator('.agp-tool .agp-tool-res').first()).toBeVisible();
      await expect(pane.locator('.agp-open')).toHaveText('');
      await expect(pane).toHaveAttribute('data-state', 'done', { timeout: 15000 });
    });

    test(`TC-AGT-10/${agent}: 질문 답변 · Esc 인터럽트 · 죽음 (FR-AGT-4·4a, V-8)`, async ({ page }) => {
      await waitForInit(page);
      const pane = await openAgentTab(page, agent);
      await send(pane, 'QUESTION');
      const dlg = page.locator('.ui-modal.agp-modal .ui-modal-box');
      await expect(dlg).toBeVisible({ timeout: 15000 });
      await expect(dlg.locator('.agp-q legend')).toContainText('Pick a color');
      await expect(dlg.locator('.agp-q input')).toHaveCount(2);
      await dlg.locator('.agp-q input[value="Blue"]').check();
      await dlg.locator('.ui-modal-foot .ui-btn-primary').click();
      await expect(dlg).toBeHidden({ timeout: 10000 });
      await expect(pane.locator('.agp-msg.agp-assistant .agp-body').last()).toHaveText('Blue', { timeout: 15000 });
      await expect(pane).toHaveAttribute('data-state', 'done', { timeout: 15000 });
      await send(pane, 'SLOW');
      await expect(pane.locator('.agp-msg.agp-live .agp-body')).toContainText('tick', { timeout: 15000 });
      await pane.locator('.agp-ta').press('Escape');
      await expect(pane).toHaveAttribute('data-state', 'done', { timeout: 15000 });
      await expect(pane.locator('.agp-msg.agp-assistant .agp-body').last()).not.toContainText('slow done');
      await send(pane, 'DIE');
      // P5: 죽음은 오류 상태다 — 재개 버튼이 있다 (신원은 핸드셰이크에서 왔다).
      await expect(pane).toHaveAttribute('data-state', 'error', { timeout: 15000 });
      await expect(pane.locator('.agp-ta')).toBeDisabled();
      await expect(pane.locator('.agp-line.agp-dormant[data-dormant="error"] .agp-resume')).toBeVisible();
    });

    test(`TC-AGT-12/${agent}: 휴면·재개 — 같은 세션 신원 (FR-ABG-10)`, async ({ page }) => {
      await waitForInit(page);
      const pane = await openAgentTab(page, agent);
      // codex·omp 는 핸드셰이크에서 신원이 오므로 첫 턴 전에도 휴면할 수 있다.
      const sid = await pane.getAttribute('data-sessionid');
      expect(sid).toBeTruthy();
      await pane.locator('.agp-menu-btn').click();
      await page.locator('.ui-menu.agp-menu .ui-menu-item[data-id="hibernate"]').click();
      await expect(pane).toHaveAttribute('data-state', 'hibernated', { timeout: 15000 });
      await pane.locator('.agp-line.agp-dormant .agp-resume').click();
      await expect(pane).toHaveAttribute('data-state', 'idle', { timeout: 15000 });
      await send(pane, 'say PONG');
      await expect(pane.locator('.agp-msg.agp-assistant .agp-body').last()).toHaveText('PONG', { timeout: 15000 });
      expect(await pane.getAttribute('data-sessionid')).toBe(sid);
    });
  });
}

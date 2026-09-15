import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import AxeBuilder from '@axe-core/playwright';
import { Page } from '@playwright/test';

import { test, expect, waitForInit, waitSettled, keepToolBusy } from './fixtures';

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
    // FR-M11-16: 다 끝나면 **0 으로 적힌다** — 세어서 아는 값이라 모름이 아니다.
    await expect(pane2.locator('.agp-open')).toContainText('0');
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
    /**
     * 슬래시: 목록은 initialize 의 commands 다.
     *
     * **M9_SRS FR-M9-45 로 계약이 바뀌었다** — 항목은 이름 하나가 아니라 이름과
     * 인자 문법 둘이다. 그래서 이름은 `.agp-sugg-name` 으로 잰다. 항목 전체의
     * 텍스트로 재면 힌트가 붙는 순간 이 검사가 깨지고, 그것은 결함이 아니라
     * 새 계약이다 (V-M9-45 가 힌트 쪽을 잰다).
     */
    await ta.fill('/co');
    await expect(pane.locator('.agp-sugg .agp-sugg-item .agp-sugg-name')).toHaveText(['/compact']);
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
    /**
     * **계약이 바뀌었다** (FR-M11-16 / M11-B13): 첫 턴 전에도 자리는 **서고 모름이라고
     * 적는다**. 종전에는 숨겼고, 그 빈 자리가 *"그런 항목이 아예 없다"* 로 읽힌 것이
     * 접수였다. `FR-CBG-5` 는 그대로다 — 숨기는 대신 **모름을 말한다**.
     */
    await expect(limits).toBeVisible();
    await expect(limits).toContainText('알 수 없음');
    await send(pane, 'say PONG');
    await expect(pane).toHaveAttribute('data-state', 'done', { timeout: 15000 });
    // 값이 오면 그 자리가 채워진다.
    await expect(limits).toContainText('44%', { timeout: 10000 });
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

    // 전경이 비면 올릴 수 없다 (FR-M11-12). 훅은 흉내 내지만 이 셸 자신은
    // 프롬프트에 서 있으므로, 에이전트가 채울 자리를 여기서 대신 채운다.
    await keepToolBusy(page, toolId);

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
   * V-M9-41 (M9_SRS FR-M9-41 / M9-B23): **올린 세션은 기록을 그대로 띄운다.**
   *
   * 접수한 말: *"세션 기록이 그대로 넘어가야하는데 아무것도 안보인다. 처음키는것과
   * 같다."* 세션 자체는 이어진다 — 비는 것은 **그릴 재료**다. 화면은 우리 이벤트
   * 로그를 재생하는데 올리기는 새 `toolId` 라 그 로그가 비어 있었다.
   *
   * 훅을 **흉내 낸다** (위 V-M9-33/36 과 같은 근거) — 다만 이번에는 `transcriptPath`
   * 를 함께 싣는다. 전사본은 이 컴퓨터의 파일이므로 e2e 가 직접 놓는다; 형식은
   * claude 어댑터가 아는 그것이다 (실측 2026-09-14).
   *
   * **재는 것 둘**: ① 올린 뒤 과거 대화가 화면에 선다 ② 기록이 없으면 **그 사실이
   * 문장으로** 보인다 — 조용히 비면 사용자는 세션이 안 이어진 줄 안다.
   */
  test('V-M9-41 (FR-M9-41): 올린 세션의 기록이 화면에 선다', async ({ page }) => {
    const dir = mkdtempSync(join(tmpdir(), 'dm-hist-'));
    const tp = join(dir, 'sid-hist-e2e.jsonl');
    writeFileSync(tp, [
      JSON.stringify({ type: 'user', message: { content: '과거의 물음' } }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: '과거의 답' }] } }),
      JSON.stringify({ type: 'attachment', content: { type: 'ai-title' } }),
      '',
    ].join('\n'));

    await waitForInit(page);
    const term = page.locator('#area .pn.focused .tp.vis');
    await expect(term).toBeVisible({ timeout: 10000 });
    const toolId = await term.getAttribute('data-toolid');
    expect(toolId, '터미널 도구가 없다').toBeTruthy();

    // 전경이 비면 올릴 수 없다 (FR-M11-12). 훅은 흉내 내지만 이 셸 자신은
    // 프롬프트에 서 있으므로, 에이전트가 채울 자리를 여기서 대신 채운다.
    await keepToolBusy(page, toolId);

    const posted = await page.evaluate(async ([id, path]) => {
      const r = await fetch('/api/runs/context', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ toolId: id, agent: 'claude', sessionId: 'sid-hist-e2e', transcriptPath: path, bytes: 10 }),
      });
      return r.status;
    }, [toolId, tp]);
    expect(posted, '훅 종단이 받지 않았다').toBe(200);

    const tabs = page.locator('#area .pn.focused .pn-tab');
    const before = await tabs.count();
    await page.locator('#area .pn.focused .pn-tab-add').click();
    await expect(tabs).toHaveCount(before + 1, { timeout: 10000 });
    await tabs.nth(before - 1).click();
    const lift = page.locator(`#area .pn.focused .tp.vis[data-toolid="${toolId}"] .tp-lift`);
    await expect(lift).toBeVisible({ timeout: 10000 });
    await lift.click();

    const pane = page.locator('#area .pn.focused .agent-pane.vis');
    await expect(pane).toBeVisible({ timeout: 15000 });
    // ① 과거가 그대로 선다 — 사용자의 물음과 에이전트의 답 둘 다.
    await expect(pane.locator('.agp-msg.agp-user .agp-body'),
      '올린 세션의 과거 물음이 보이지 않는다').toHaveText('과거의 물음', { timeout: 15000 });
    await expect(pane.locator('.agp-msg.agp-assistant .agp-body').first(),
      '올린 세션의 과거 답이 보이지 않는다').toContainText('과거의 답', { timeout: 15000 });
    // 기록을 읽었으면 "가져오지 못했다" 를 말하지 않는다.
    // 없음을 재는 관측 창이다 — 요소 자체가 없을 수 있으므로 개수로 잰다.
    await expect(pane.locator('.agp-note', { hasText: '가져오지 못' }),
      '기록을 읽었는데 못 읽었다고 말했다').toHaveCount(0);
  });

  /**
   * V-M9-41 ③ (FR-M9-41 / FR-APS-4): **부재가 뜻이다.**
   *
   * 기록을 읽지 못한 채로 올리면 화면은 비지만, 그 빈 화면이 "세션이 안 이어졌다"
   * 로 읽혀서는 안 된다. 그래서 문장 하나를 낸다.
   */
  test('V-M9-41 (FR-M9-41): 기록을 가져오지 못하면 그 사실을 말한다', async ({ page }) => {
    await waitForInit(page);
    const term = page.locator('#area .pn.focused .tp.vis');
    await expect(term).toBeVisible({ timeout: 10000 });
    const toolId = await term.getAttribute('data-toolid');

    // 전경이 비면 올릴 수 없다 (FR-M11-12). 훅은 흉내 내지만 이 셸 자신은
    // 프롬프트에 서 있으므로, 에이전트가 채울 자리를 여기서 대신 채운다.
    await keepToolBusy(page, toolId);

    // 신원만 있고 전사본은 없다 — 서버가 다시 선 뒤 활동 훅만 닿은 자리다.
    const posted = await page.evaluate(async (id) => {
      const r = await fetch('/api/runs/context', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ toolId: id, agent: 'claude', sessionId: 'sid-nohist-e2e', bytes: 10 }),
      });
      return r.status;
    }, toolId);
    expect(posted).toBe(200);

    const tabs = page.locator('#area .pn.focused .pn-tab');
    const before = await tabs.count();
    await page.locator('#area .pn.focused .pn-tab-add').click();
    await expect(tabs).toHaveCount(before + 1, { timeout: 10000 });
    await tabs.nth(before - 1).click();
    const lift = page.locator(`#area .pn.focused .tp.vis[data-toolid="${toolId}"] .tp-lift`);
    await expect(lift).toBeVisible({ timeout: 10000 });
    await lift.click();

    const pane = page.locator('#area .pn.focused .agent-pane.vis');
    await expect(pane).toBeVisible({ timeout: 15000 });
    await expect(pane.locator('.agp-note').first(),
      '기록을 못 읽은 사실이 조용히 삼켜졌다').toContainText('가져오지 못', { timeout: 15000 });
  });

  /**
   * V-M9-35 (M9_SRS FR-M9-35 / M9-B16 의 ③): **그 도구의 cwd 와 저장소.**
   *
   * 접수한 말에 *"path, branch, upstream"* 이 있었고, 이 셋은 **프로토콜이 준 것이
   * 아니라 도구의 것**이다. 그래서 재는 것이 값 자체가 아니라 **출처의 구분**이다 —
   * `title` 이 "에이전트가 보고한 값이 아니다" 를 말하고, 경로를 함께 싣는다.
   * 그 문장이 없으면 사용자는 이 값을 에이전트가 말한 것으로 읽는다.
   *
   * **저장소 갈래의 계약이 바뀌었다** (FR-M11-16 / M11-B13): 자리는 **항상 서고**
   * 셋 중 하나를 말한다 — git 이 준 이름 · *저장소 아님*(아는 '아님') · *알 수
   * 없음*(묻지 못했다). `-` 같은 대체값으로 채우지 않는 것은 그대로다 (FR-CBG-5).
   * 값의 유무가 환경에 달렸으므로, 여기서는 "이름이 섰다면 git 이 준 모양이다"
   * 까지만 고정한다.
   */
  test('V-M9-35 (FR-M9-35): 그 도구의 cwd 가 서고 출처를 title 이 말한다', async ({ page }) => {
    await waitForInit(page);
    const pane = await openAgentTab(page);
    const cwd = pane.locator('.agp-cwd');
    /**
     * **기다리는 신호가 바뀌었다** (FR-M11-16): 자리는 처음부터 서 있고 모름이 적혀
     * 있으므로, *"비어 있지 않다"* 는 더 이상 **값이 도착했다**는 뜻이 아니다. 출처를
     * 말하는 `title` 이 서는 것이 그 신호다.
     */
    await expect(cwd).toHaveAttribute('title', /\n/, { timeout: 10000 });
    const title = (await cwd.getAttribute('title')) || '';
    // 문구 + 줄바꿈 + 절대 경로. 경로만 있으면 출처를 말하지 못한다.
    expect(title, `cwd title: ${title}`).toContain('\n');
    expect(title.split('\n')[1] || '', `cwd title: ${title}`).toMatch(/^[/~]/);
    // 저장소 갈래: 자리는 서고, 셋 중 하나다 (대체값을 넣지 않는다).
    const repo = ((await pane.locator('.agp-repo').textContent()) || '').trim();
    expect(repo, '저장소 자리가 비었다 — 자리는 항상 선다 (FR-M11-16)').not.toBe('');
    expect(repo, `repo: ${repo}`).not.toBe('-');
    if (!repo.includes('알 수 없음') && !repo.includes('저장소 아님')) {
      // git 이 준 이름이면 출처를 title 이 말한다.
      expect((await pane.locator('.agp-repo').getAttribute('title')) || '').toContain('\n');
    }
  });

  /**
   * V-M9-39 · V-M9-40 (M9_SRS FR-M9-39·40 / M9-B20·B22): **하단 대시보드와 바.**
   *
   * 접수한 말: *"채팅 하단에 보기 좋게 대시보드로 되어있으면 좋겠고"* ·
   * *"context window 는 bar 가 차는 모양으로도 같이 보고싶어"*. 중복을 어떻게 할지
   * 물었을 때 답은 *"상단에것을 없애고 전부 하단으로 내린다"* 였다 — 그래서 **머리에
   * 없다**는 것도 함께 잰다. 옮기지 않고 더하기만 하면 같은 값이 두 자리에 선다.
   *
   * **바의 계약이 바뀌었다** (FR-M11-16 / M11-B13): 첫 턴 전에도 **트랙은 선다**.
   * 종전에는 숨겼고 그 빈 자리가 *"그런 항목이 없다"* 로 읽혔다. 모름과 0% 를 가르는
   * 자리는 이제 **`aria-valuenow`** 다 — 없으면 모름이다 (V-M11-33 이 그 짝이다).
   */
  test('V-M9-39/40 (FR-M9-39·40): 상태는 하단 대시보드에 서고 바가 함께 찬다', async ({ page }) => {
    await waitForInit(page);
    const pane = await openAgentTab(page);
    // 머리에서 사라졌다 — 남는 것은 이름·상태·버튼이다.
    for (const cls of ['.agp-ctx', '.agp-model', '.agp-perm', '.agp-cwd']) {
      expect(await pane.locator(`.agp-head ${cls}`).count(), `머리에 ${cls} 가 남았다`).toBe(0);
      expect(await pane.locator(`.agp-dash ${cls}`).count(), `하단에 ${cls} 가 없다`).toBe(1);
    }
    // 첫 턴 전 — 트랙은 서 있되 **값이 없다** (FR-M11-16).
    await expect(pane.locator('.agp-ctxbar')).toBeVisible();
    await expect(pane.locator('.agp-ctxbar')).not.toHaveAttribute('aria-valuenow', /.*/);
    await send(pane, 'say PONG');
    await expect(pane).toHaveAttribute('data-state', 'done', { timeout: 15000 });
    // 컨텍스트 바가 찬다. **값이므로** 이름과 수치를 함께 단다.
    const bar = pane.locator('.agp-ctxbar');
    await expect(bar).toBeVisible({ timeout: 10000 });
    await expect(bar).toHaveAttribute('aria-label', /\S/);
    const now = Number(await bar.getAttribute('aria-valuenow'));
    expect(Number.isFinite(now) && now >= 0 && now <= 100, `valuenow=${now}`).toBe(true);
    // 숫자는 **그대로 남는다** — 바는 대신이 아니라 함께다.
    await expect(pane.locator('.agp-dash .agp-ctx')).not.toBeEmpty();
    // 플랜 한도 바도 선다 (fakeagent 가 `rate_limit_event` 를 낸다).
    // FR-M11-19: **주기마다 하나**이므로 여럿이다 — 개수는 V-M11-36 이 잰다.
    await expect(pane.locator('.agp-limbar').first()).toBeVisible({ timeout: 10000 });
  });

  /**
   * V-M9-37 (M9_SRS FR-M9-37 / M9-B19): **탭을 옮기지 않아도 진입점이 선다.**
   *
   * 사용자가 겪은 그대로다 (접수 2026-09-14 — *"여전히 버튼은 없어"*). 셸에서
   * `claude` 를 띄우는 순간 **그 탭은 이미 보이는 중**이므로 이동이 일어나지 않는다.
   * 갱신 계기를 이동으로만 두면 버튼은 영영 서지 않는다 — 서버·훅·자산이 모두
   * 새것이고 신원도 잡혀 있는데 **화면만 그 사실을 모르는** 상태가 된다.
   *
   * 그래서 **활동 신호**가 계기다: 그것이 오면 "여기서 에이전트가 돈다" 는 뜻이다.
   */
  test('V-M9-37 (FR-M9-37): 탭을 옮기지 않아도 활동 신호로 진입점이 선다', async ({ page }) => {
    await waitForInit(page);
    const term = page.locator('#area .pn.focused .tp.vis');
    await expect(term).toBeVisible({ timeout: 10000 });
    const toolId = await term.getAttribute('data-toolid');
    expect(toolId).toBeTruthy();

    // 전경이 비면 올릴 수 없다 (FR-M11-12). 훅은 흉내 내지만 이 셸 자신은
    // 프롬프트에 서 있으므로, 에이전트가 채울 자리를 여기서 대신 채운다.
    await keepToolBusy(page, toolId);

    await expect(term.locator('.tp-lift')).toBeHidden();

    // 훅 둘을 흉내 낸다 — 신원은 context 종단, 활동은 activity 종단이다.
    // **별도 종단인 것이 규약이다** (NFR-CBG-2): 둘의 실패가 서로를 막으면 안 된다.
    const codes = await page.evaluate(async (id) => {
      const post = (p: string, b: unknown) => fetch(p, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(b),
      }).then((r) => r.status);
      const a = await post('/api/runs/context',
        { toolId: id, agent: 'claude', sessionId: 'sid-live', bytes: 10 });
      const b = await post('/api/tools/activity/set',
        { toolId: id, agent: 'claude', state: 'working', tool: 'Bash', detail: '' });
      return [a, b];
    }, toolId);
    expect(codes, `종단 응답: ${codes}`).toEqual([200, 200]);

    // **탭을 옮기지 않았다.** 그래도 선다.
    await expect(term.locator('.tp-lift')).toBeVisible({ timeout: 10000 });
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
      // FR-M11-4: 도구 카드는 **접힌 채 선다** — 결과를 보려면 편다.
      await pane.locator('.agp-tool').first().locator('.agp-tool-head').click();
      await expect(pane.locator('.agp-tool .agp-tool-res').first()).toBeVisible();
      await expect(pane.locator('.agp-open')).toContainText('0');
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

/**
 * V-M9-45 (M9_SRS FR-M9-45 / M9-B26): **`/` 제안은 무엇을 넣어야 하는지 말한다.**
 *
 * 접수한 말: *"단순 스킬이 아닌 / 명령어들의 경우 컨트롤 할 수 없다 … (config,
 * model 등의 명령어)"*. 못 하는 것은 명령을 **보내는** 일이 아니라 **무엇을 보낼지
 * 아는** 일이었다 — 제안이 이름 하나만 보였다.
 *
 * 실측(2026-09-14)에서 `initialize` 는 명령마다 `description` 과 `argumentHint` 를
 * 함께 싣는데 우리가 이름만 남기고 버렸다. 재는 것은 그 둘이 화면에 서는지와,
 * **인자를 받지 않는 명령에는 그 자리가 비는지**다 (FR-CBG-5).
 */
test.describe('에이전트 `/` 명령 제안 (M9-B26)', () => {
  test('V-M9-45 (FR-M9-45): 제안이 인자 문법과 설명을 함께 보인다', async ({ page }) => {
    await waitForInit(page);
    const pane = await openAgentTab(page);
    const ta = pane.locator('.agp-ta');
    await ta.click();
    await ta.fill('/m');

    const sugg = pane.locator('.agp-sugg .agp-sugg-item');
    await expect(sugg).toHaveCount(1, { timeout: 10000 });
    await expect(sugg.locator('.agp-sugg-name')).toHaveText('/model');
    // 인자 문법이 그대로 선다 — 이것이 없으면 무엇을 칠지 알 수 없다.
    await expect(sugg.locator('.agp-sugg-hint'), '인자 문법이 보이지 않는다').toHaveText('<model>');
    // 설명은 툴팁이다 — 목록을 길게 만들지 않으면서 뜻을 말한다.
    await expect(sugg).toHaveAttribute('title', 'Set the AI model');

    // 골라 넣으면 인자를 칠 자리가 열린다.
    await sugg.click();
    await expect(ta).toHaveValue('/model ');

    // **인자를 받지 않는 명령에는 그 자리가 없다.** 빈 힌트를 지어내지 않는다.
    await ta.fill('/cl');
    const bare = pane.locator('.agp-sugg .agp-sugg-item');
    await expect(bare).toHaveCount(1, { timeout: 10000 });
    await expect(bare.locator('.agp-sugg-name')).toHaveText('/clear');
    await expect(bare.locator('.agp-sugg-hint'), '없는 인자 문법을 지어냈다').toHaveCount(0);
    await bare.click();
    await expect(ta, '인자가 없는데 공백을 붙였다').toHaveValue('/clear');
  });
});


/**
 * M11_SRS FR-M11-2·3·4 — 에이전트 GUI 를 읽을 수 있게 만든다 (M11-B4·B5·B6).
 *
 * 셋 다 **뷰의 계약**이며 가짜 에이전트 한 턴으로 전부 선다. 재는 것은 모양이
 * 아니라 규약이다 — 어느 표면이 앱의 스크롤을 쓰는가 · 말한 사람이 갈리는가 ·
 * 도구 본문이 접혀 있는가.
 */
test.describe('에이전트 GUI 의 읽힘 (M11)', () => {
  test('V-M11-6: GUI 안의 스크롤 표면은 앱의 규약을 쓴다 (FR-M11-2)', async ({ page }) => {
    await waitForInit(page);
    const pane = await openAgentTab(page);
    // 대화와 입력은 언제나 있다.
    await expect(pane.locator('.agp-log')).toHaveClass(/\bui-scroll\b/);
    await expect(pane.locator('.agp-ta')).toHaveClass(/\bui-scroll\b/);
    // 도구 카드의 본문은 한 턴을 돌려야 선다.
    await send(pane, 'please APPROVE this');
    const dlg = page.locator('.ui-modal.agp-modal .ui-modal-box');
    await expect(dlg).toBeVisible({ timeout: 15000 });
    await expect(dlg.locator('.agp-appr-in')).toHaveClass(/\bui-scroll\b/);
    await dlg.locator('.agp-choice[data-choice="allow"]').click();
    await expect(pane.locator('.agp-tool .agp-tool-res').first()).toHaveClass(/\bui-scroll\b/, { timeout: 15000 });
  });

  test('V-M11-7: 말한 사람이 왼쪽 띠로 갈린다 (FR-M11-3)', async ({ page }) => {
    await waitForInit(page);
    const pane = await openAgentTab(page);
    // 도구 카드까지 서야 한다 — 종전에 **에이전트 말과 도구 카드가 같은 테두리**였고,
    // 그 둘이 갈리지 않는 것이 접수한 "단조롭다" 의 알맹이다.
    await send(pane, 'please APPROVE this');
    const dlg = page.locator('.ui-modal.agp-modal .ui-modal-box');
    await expect(dlg).toBeVisible({ timeout: 15000 });
    await dlg.locator('.agp-choice[data-choice="allow"]').click();
    await expect(pane.locator('.agp-tool').first()).toBeVisible({ timeout: 15000 });
    await expect(pane.locator('.agp-msg.agp-assistant .agp-body').last()).toHaveText('DONE', { timeout: 15000 });

    const stripe = (sel: string) => pane.locator(sel).first().evaluate((n) => {
      const cs = getComputedStyle(n);
      return { color: cs.borderLeftColor, width: parseFloat(cs.borderLeftWidth) };
    });
    const user = await stripe('.agp-msg.agp-user');
    const asst = await stripe('.agp-msg.agp-assistant');
    const tool = await stripe('.agp-tool');
    // 띠는 **보이는 굵기**여야 한다. 1px 테두리는 이미 있었고 그것으로는 갈리지 않았다.
    for (const [name, x] of Object.entries({ user, asst, tool })) {
      expect(x.width, `${name} 의 왼쪽 띠가 얇다`).toBeGreaterThanOrEqual(3);
    }
    // 셋이 서로 다른 색이어야 한다.
    const colors = new Set([user.color, asst.color, tool.color]);
    expect(colors.size, '말한 사람이 색으로 갈리지 않는다').toBe(3);
  });

  test('V-M11-15: 턴 전에도 계정·플랜이 하단에 선다 (FR-M11-6)', async ({ page }) => {
    await waitForInit(page);
    const pane = await openAgentTab(page);
    // **한 턴도 돌리지 않는다.** 이 값은 `initialize` 응답이 주고 어댑터가 나르는데
    // 화면이 버리고 있었다 — 접수한 하단이 비어 보인 까닭의 하나다 (M11-B3).
    await expect(pane.locator('.agp-acct')).toContainText('fake@example', { timeout: 15000 });
    await expect(pane.locator('.agp-acct')).toContainText('Fake');
  });

  /**
   * M11_SRS FR-M11-16 (M11-B13) — **하단은 자리를 세우고 모름을 말한다.**
   *
   * 접수: *"첫 메세지를 보내기전에는 기본값 설정하고 이후 맞추면 되잖아. 없애지 말고
   * 모르는걸로 해서 보여줘."* **앞선 결정의 번복이다** — 그때는 *"있는 것만 더
   * 그린다"* 였다.
   *
   * 빈 자리를 `:empty` 로 지우던 종전 동작이 *"그런 항목이 아예 없다"* 로 읽힌 것이
   * 접수의 내용이다. `FR-CBG-5`(모른다 ≠ 0)는 그대로다 — 0 으로 채우는 것이 아니라
   * **모름을 모름이라고 적는다**.
   */
  test('V-M11-32: 턴 전에도 하단이 자리를 세우고 모름을 말한다 (FR-M11-16)', async ({ page }) => {
    await waitForInit(page);
    const pane = await openAgentTab(page);
    await expect(pane.locator('.agp-acct')).toContainText('fake@example', { timeout: 15000 });

    // **한 턴도 돌리지 않는다.** 아홉 자리가 모두 서 있어야 한다.
    for (const cls of ['.agp-ctx', '.agp-limits', '.agp-cache',
      '.agp-model', '.agp-perm', '.agp-acct', '.agp-sess', '.agp-cwd']) {
      await expect(pane.locator(cls), `${cls} 의 자리가 서지 않았다`).toBeVisible();
      await expect(pane.locator(cls), `${cls} 가 비어 있다 — 빈 자리는 "항목이 없다" 로 읽힌다`)
        .not.toBeEmpty();
    }
    // `initialize` 응답에 **수가 아예 없는** 넷은 모름이라고 적혀 있어야 한다 (§2.5).
    for (const cls of ['.agp-ctx', '.agp-limits', '.agp-cache']) {
      await expect(pane.locator(cls), `${cls} 가 모름을 말하지 않는다`)
        .toContainText('알 수 없음');
    }
  });

  test('V-M11-33: 모를 때 바는 서 있되 valuenow 가 없다 (FR-M11-16 · FR-CBG-5)', async ({ page }) => {
    await waitForInit(page);
    const pane = await openAgentTab(page);
    await expect(pane.locator('.agp-acct')).toContainText('fake@example', { timeout: 15000 });

    // 트랙은 선다 — 자리를 지우지 않는 것이 접수다.
    await expect(pane.locator('.agp-ctxbar')).toBeVisible();
    await expect(pane.locator('.agp-limbar')).toBeVisible();
    /**
     * **그러나 값은 없다.** 화면상 채움 0 은 실제 0% 와 같아 보이고, 그것을 알고 고른
     * 결정이다 (사용자 2026-09-15). 가르는 자리는 **읽히는 쪽**이다 — `aria-valuenow`
     * 가 없으면 indeterminate 이고, 0 이면 "0%" 다.
     */
    await expect(pane.locator('.agp-ctxbar')).not.toHaveAttribute('aria-valuenow', /.*/);
    await expect(pane.locator('.agp-limbar')).not.toHaveAttribute('aria-valuenow', /.*/);

    // 한 턴 돌리면 값이 오고, 그때 달린다.
    await send(pane, 'hello');
    await expect(pane).toHaveAttribute('data-state', 'done', { timeout: 15000 });
    await expect(pane.locator('.agp-ctxbar')).toHaveAttribute('aria-valuenow', /^\d+$/, { timeout: 15000 });
  });

  /**
   * **반대 방향을 지키는 짝이다.** 자리를 세우는 규약이 "모르는 것" 을 넘어 "아는 0"
   * 까지 모름으로 덮으면, 그것은 `FR-CBG-5` 를 반대편에서 어기는 것이다. 열린 요청
   * 수는 **우리가 세는 값**이므로 0 은 0 이다.
   */
  /**
   * M11_SRS FR-M11-15 (M11-B12 · B16) — **하단의 글꼴은 터미널과 같은 상수에서 온다.**
   *
   * 접수는 두 번 왔고(*"너무 작아"* → *"2배로 키워라"*), 터미널 기본값을 보인 뒤의
   * 지시가 *"거기에 맞추자. 터미널 기본값과 같은 상수를 사용"* 이다.
   *
   * **재는 것은 수가 아니라 같음이다.** 18 이나 14 를 적어 두면 한쪽이 바뀔 때 이
   * 검사가 그 사실을 놓친다 — 두 자리가 **한 상수**를 쓰는지가 요구다.
   */
  /**
   * M11_SRS FR-M11-33 (M11-B31) · FR-M11-19 개정 (M11-B30) — **없앤 자리와 이은 자리.**
   *
   * 비용은 사용자 결정으로 **자리째** 없앴다 — 못 구해서가 아니다. 한도는 반대로
   * 주기마다 **한 칸**에 이름·수치·게이지가 함께 들어야 한다 (*"5시간옆에 5시간
   * 게이지를"*). 게이지가 칸 밖에 있으면 어느 주기의 것인지 눈으로 이어지지 않는다.
   */
  test('V-M11-38/41: 주기마다 한 칸에 게이지가 들고, 비용 자리는 없다', async ({ page }) => {
    await waitForInit(page);
    const pane = await openAgentTab(page);
    await send(pane, 'say PONG');
    await expect(pane).toHaveAttribute('data-state', 'done', { timeout: 15000 });
    await expect(pane.locator('.agp-limits')).toContainText('44%', { timeout: 10000 });

    // FR-M11-33: 비용은 **요소 자체가 서지 않는다**.
    expect(await pane.locator('.agp-cost').count(), '비용 자리가 남았다').toBe(0);

    // FR-M11-19 개정: 게이지는 **주기 칸 안**에 있다.
    const cells = pane.locator('.agp-limit');
    const n = await cells.count();
    expect(n, '주기 칸이 서지 않았다').toBeGreaterThan(1);
    expect(await pane.locator('.agp-limit .agp-limbar').count(),
      '게이지가 주기 칸 밖에 있다 — 어느 주기의 것인지 이어지지 않는다').toBe(n);
    // 칸마다 이름·수치가 함께 든다.
    for (const txt of await cells.locator('.agp-limit-txt').allTextContents()) {
      expect(txt.trim(), `빈 칸: ${txt}`).not.toBe('');
    }
  });

  test('V-M11-35: 하단 글꼴이 터미널과 같다 (FR-M11-15)', async ({ page }) => {
    await waitForInit(page);
    /**
     * **터미널을 먼저 잰다.** 에이전트 탭을 열면 그 터미널의 DOM 은 떼어지므로
     * (`_hideOthers`) 나중에는 물어볼 대상이 없다.
     */
    const termFs = await page.locator('#area .pn.focused .xterm .xterm-rows')
      .first().evaluate((n) => parseFloat(getComputedStyle(n).fontSize));

    const pane = await openAgentTab(page);
    await expect(pane.locator('.agp-acct')).toContainText('fake@example', { timeout: 15000 });
    const dashFs = await pane.locator('.agp-dash').evaluate((n) =>
      parseFloat(getComputedStyle(n).fontSize));

    expect(termFs, `터미널 글꼴: ${termFs}`).toBeGreaterThan(0);
    expect(dashFs, `하단 ${dashFs} · 터미널 ${termFs}`).toBe(termFs);
    // 종전은 `--fs-xs`(9px) 였다 — 접수는 그것이 읽히지 않는다는 말이었다.
    expect(dashFs, `하단 글꼴이 그대로다: ${dashFs}`).toBeGreaterThan(9);
  });

  /**
   * M11_SRS FR-M11-19 (M11-B17) — **한도 게이지는 전부이거나 전무다.**
   *
   * 접수: *"게이지를 보여줄거면 1달/5시간 모두 보여주거나 모두 안보여주는쪽으로
   * 해라."* `FR-M9-40` 은 *"가장 임박한 것 하나"* 였고, 그 결과 옆의 텍스트는 두
   * 주기를 말하는데 게이지는 하나만 서는 화면이 되었다.
   */
  test('V-M11-36: 한도 바가 주기 수만큼 선다 (FR-M11-19)', async ({ page }) => {
    await waitForInit(page);
    const pane = await openAgentTab(page);
    await send(pane, 'say PONG');
    await expect(pane).toHaveAttribute('data-state', 'done', { timeout: 15000 });
    await expect(pane.locator('.agp-limits')).toContainText('44%', { timeout: 10000 });
    /**
     * **개수를 박지 않는다.** 접수의 내용은 *"텍스트는 여러 주기를 말하는데 게이지는
     * 하나"* 라는 **비대칭**이므로, 재는 것도 그 둘의 일치여야 한다. 수를 적어 두면
     * 어댑터가 주기를 하나 더 낼 때 이 검사가 그 비대칭을 놓친다.
     */
    const periods = await pane.locator('.agp-limit').count();
    expect(periods, '한도 줄이 주기를 말하지 않는다').toBeGreaterThan(1);

    const bars = pane.locator('.agp-limbar');
    await expect(bars, `주기는 ${periods} 인데 게이지가 그 수만큼 서지 않았다`).toHaveCount(periods);
    // **각 바가 자기 주기를 말한다** — 이름이 없으면 하나만 선 것과 다를 바 없다.
    const labels = await bars.evaluateAll((ns) => ns.map((n) => n.getAttribute('aria-label') || ''));
    expect(new Set(labels).size, `바 이름이 겹친다: ${labels}`).toBe(periods);
    for (const l of labels) expect(l, `빈 이름: ${labels}`).not.toBe('');
    // 값도 각자 달린다.
    const nows = await bars.evaluateAll((ns) => ns.map((n) => n.getAttribute('aria-valuenow')));
    for (const v of nows) expect(v, `valuenow: ${nows}`).toMatch(/^\d+$/);
  });

  test('V-M11-37: 모를 때는 바 하나가 서고 값이 없다 (FR-M11-19 · FR-M11-16)', async ({ page }) => {
    await waitForInit(page);
    const pane = await openAgentTab(page);
    await expect(pane.locator('.agp-acct')).toContainText('fake@example', { timeout: 15000 });
    // **주기를 모르면 개수도 모른다** — 자리는 하나만 세우고 값은 달지 않는다.
    await expect(pane.locator('.agp-limbar')).toHaveCount(1);
    await expect(pane.locator('.agp-limbar')).not.toHaveAttribute('aria-valuenow', /.*/);
  });

  /**
   * M11_SRS FR-M11-17 (M11-B14) — **다른 탭에 다녀와도 대화는 그 자리다.**
   *
   * 접수: *"gui 에서 다른곳에 다녀오면 스크롤이 최상단으로 이동해. 유지해야해."*
   * 요소가 문서에서 떨어지면 브라우저가 `scrollTop` 을 버리므로 돌아왔을 때 0 이다.
   *
   * **맨 위로 올려 두고 재면 안 된다** — 고침이 없어도 0 이 되어 초록이 된다
   * (M11_PROGRESS §2-3 이 두 번 겪은 함정이다). 그래서 **중간**으로 올린다.
   */
  /**
   * M11_SRS FR-M11-26 (M11-B24) — **바닥에 있을 때만 따라간다.**
   *
   * 접수: *"새 글이 있으면 무조건 스크롤을 아래로 내린다. 현재위치 고정해야한다."*
   * 사용자 결정(§2.6b)은 **바닥 판정**이다 — 최신을 보던 사람은 계속 최신을 보고,
   * 올려서 읽던 사람은 끌려가지 않는다.
   *
   * **둘 다 재야 한다.** 따라가는 쪽만 재면 "아무것도 안 함" 도 초록이고, 지키는
   * 쪽만 재면 "영영 안 따라감" 도 초록이다.
   */
  test('V-M11-48: 바닥이면 따라가고, 올려 두었으면 그 자리다 (FR-M11-26)', async ({ page }) => {
    await waitForInit(page);
    const pane = await openAgentTab(page);
    const log = pane.locator('.agp-log');

    for (let i = 0; i < 6; i++) {
      await send(pane, `say PONG ${i}`);
      await expect(pane).toHaveAttribute('data-state', 'done', { timeout: 15000 });
    }
    const room = await log.evaluate((n) => n.scrollHeight - n.clientHeight);
    expect(room, '대화가 스크롤될 만큼 길지 않다').toBeGreaterThan(40);

    // ① **올려 두면 지킨다.** 중간으로 올린다 — 맨 위(0)는 고침 없이도 0 이라 못 가른다.
    const mid = Math.floor(room / 2);
    await log.evaluate((n, y) => { n.scrollTop = y; }, mid);
    await send(pane, 'say PONG again');
    await expect(pane).toHaveAttribute('data-state', 'done', { timeout: 15000 });
    expect(await log.evaluate((n) => n.scrollTop),
      '읽는 중에 새 글이 와서 끌려갔다 (M11-B24)').toBe(mid);

    // ② **바닥이면 따라간다.** 최신을 보던 사람까지 멈추면 그것도 결함이다.
    await log.evaluate((n) => { n.scrollTop = n.scrollHeight; });
    await send(pane, 'say PONG last');
    await expect(pane).toHaveAttribute('data-state', 'done', { timeout: 15000 });
    const gap = await log.evaluate((n) => n.scrollHeight - n.scrollTop - n.clientHeight);
    expect(gap, `바닥을 보고 있었는데 새 글을 따라가지 않았다 (gap=${gap})`).toBeLessThanOrEqual(4);
  });

  /**
   * M11_SRS FR-M11-36 (M11-B34) — **에이전트의 내용은 선택·복사된다.**
   *
   * 전역 `body{user-select:none}` 을 터미널만 xterm 안에서 되살리고 있었다. 조작
   * 자리(버튼·탭)는 **그대로 막혀 있어야 한다** — 드래그가 그쪽의 뜻이다.
   */
  test('V-M11-42: 대화는 선택되고 조작 자리는 막혀 있다 (FR-M11-36)', async ({ page }) => {
    await waitForInit(page);
    const pane = await openAgentTab(page);
    await send(pane, 'say PONG');
    await expect(pane).toHaveAttribute('data-state', 'done', { timeout: 15000 });

    const us = (sel: string) => pane.locator(sel).first()
      .evaluate((n) => getComputedStyle(n).userSelect || getComputedStyle(n).webkitUserSelect);
    expect(await us('.agp-log'), '대화를 선택할 수 없다 — 복사가 막힌다').toBe('text');
    expect(await us('.agp-dash'), '하단 값을 선택할 수 없다').toBe('text');
    // 조작 자리는 그대로 막혀 있다.
    expect(await pane.locator('.agp-send, .agp-stop').first()
      .evaluate((n) => getComputedStyle(n).userSelect || getComputedStyle(n).webkitUserSelect),
    '버튼까지 선택된다 — 드래그가 그쪽의 뜻이다').not.toBe('text');
  });

  /**
   * M11_SRS FR-M11-22 (M11-B20) — **좌우 이동이 터미널과 같다.**
   *
   * 접수는 *"ctrl + 좌우화살표"* 로 왔고 사용자가 **`cmd` 로 정정했다**. 터미널은
   * `Cmd+좌우`=줄 처음·끝, `Alt+좌우`=단어 이동이다 (`term-pane.js`). macOS 의
   * `Ctrl+좌우` 는 OS 가 가져가므로 두지 않는다.
   */
  test('V-M11-45: Cmd·Alt 좌우가 터미널과 같은 일을 한다 (FR-M11-22)', async ({ page }) => {
    await waitForInit(page);
    const pane = await openAgentTab(page);
    const ta = pane.locator('.agp-ta');
    await ta.click();
    const text = 'hello world\nsecond line';
    await ta.fill(text);
    const head = text.indexOf('\n') + 1;   // 둘째 줄의 시작
    const at = () => ta.evaluate((n: HTMLTextAreaElement) => n.selectionStart);

    // Cmd+← : **그 줄**의 처음 (여러 줄이므로 문서 처음이 아니다)
    await ta.press('Meta+ArrowLeft');
    expect(await at(), 'Cmd+← 가 줄 처음으로 가지 않았다').toBe(head);
    // Cmd+→ : 그 줄의 끝
    await ta.press('Meta+ArrowRight');
    expect(await at(), 'Cmd+→ 가 줄 끝으로 가지 않았다').toBe(text.length);
    // Alt+← : 한 단어 앞 ('line' 의 시작)
    await ta.press('Alt+ArrowLeft');
    expect(await at(), 'Alt+← 가 단어 단위로 움직이지 않았다').toBe(text.lastIndexOf('line'));
  });

  /**
   * M11_SRS FR-M11-21 (M11-B19) — **입력창은 자라고 1/3 에서 멈춘다.**
   *
   * 접수가 상한을 지정했다 — *"탭 크기의 1/3 까지는 커지게 하고 그 이후로 스크롤"*.
   * **둘 다 재야 한다**: 자라지 않으면 접수 그대로이고, 끝없이 자라면 대화가 밀린다.
   */
  test('V-M11-44: 입력창이 자라고 패널의 1/3 에서 멈춘다 (FR-M11-21)', async ({ page }) => {
    await waitForInit(page);
    const pane = await openAgentTab(page);
    const ta = pane.locator('.agp-ta');
    const h = () => ta.evaluate((n) => n.clientHeight);

    const before = await h();
    await ta.click();
    await ta.fill('one\ntwo\nthree\nfour\nfive');
    const grown = await h();
    expect(grown, `자라지 않았다 (${before} → ${grown})`).toBeGreaterThan(before);

    // 아주 길게 — 상한에 닿아야 한다.
    await ta.fill('x\n'.repeat(60));
    const capped = await h();
    const paneH = await pane.evaluate((n) => n.clientHeight);
    expect(capped, `1/3 을 넘었다 (${capped} > ${paneH}/3)`).toBeLessThanOrEqual(Math.round(paneH / 3) + 2);
    expect(await ta.evaluate((n) => getComputedStyle(n).overflowY),
      '상한에 닿았는데 스크롤이 서지 않았다').toBe('auto');

    // 비우면 되돌아간다 — `height` 를 비우고 다시 재지 않으면 갇힌다.
    await ta.fill('');
    expect(await h(), '지웠는데 줄어들지 않았다').toBeLessThan(capped);
  });

  /**
   * M11_SRS FR-M11-23 (M11-B21) — **md 로 그리되 원문으로 되돌 수 있다.**
   *
   * 원본도 md 를 **렌더한다** (§2.10 (8) — 표를 박스 드로잉으로 그렸다). 다만 출력이
   * 늘 md 인 것은 아니므로(로그·표·ASCII 아트) **되돌릴 길**을 함께 둔다 — 사용자
   * 결정(§2.6b)이 그 짝을 요구했다.
   *
   * **정화를 지나는지도 잰다.** 여기 오는 문자열은 에이전트가 준 것이다.
   */
  test('V-M11-46: 출력이 md 로 그려지고 원문 토글이 되돌린다 (FR-M11-23)', async ({ page }) => {
    await waitForInit(page);
    const pane = await openAgentTab(page);
    await send(pane, 'MARKDOWN please');
    await expect(pane).toHaveAttribute('data-state', 'done', { timeout: 15000 });

    const body = pane.locator('.agp-msg.agp-assistant .agp-body').last();
    // ① md 가 **요소**가 되었다 — 글자로 남지 않았다.
    await expect(body.locator('h1')).toHaveText('Title', { timeout: 15000 });
    await expect(body.locator('li')).toHaveCount(2);
    await expect(body.locator('table td')).toHaveCount(2);
    expect(await body.textContent(), 'md 기호가 글자로 남았다').not.toContain('# Title');

    // ② 원문 토글이 되돌린다.
    const msg = pane.locator('.agp-msg.agp-assistant').last();
    await msg.locator('.agp-raw-toggle').click();
    expect(await body.textContent(), '원문으로 돌아가지 않았다').toContain('# Title');
    expect(await body.locator('h1').count(), '원문인데 요소가 남았다').toBe(0);

    // ③ 다시 누르면 md 다 — 왕복한다.
    await msg.locator('.agp-raw-toggle').click();
    await expect(body.locator('h1')).toHaveText('Title');
  });

  /**
   * M11_SRS FR-M11-27 (M11-B25) — **접힌 채로도 무엇인지 보인다.**
   *
   * 접수: *"접히는 출력에서 요약정도는 해줘라 뭔지는 알아야지. n 줄 이내면 그냥
   * 출력해도좋다."* 사용자 결정(§2.6b): **5줄 이내는 그대로, 넘으면 앞뒤 2줄씩**.
   *
   * **끝줄이 보이는지가 요점이다** — 도구 출력은 결론이 끝에 있다. 앞만 보이는
   * 구현도 "요약이 있다" 는 말은 만족시키므로, 그것을 가르는 단언을 둔다.
   */
  test('V-M11-49: 접힌 도구가 앞뒤와 남은 줄 수를 보인다 (FR-M11-27)', async ({ page }) => {
    await waitForInit(page);
    const pane = await openAgentTab(page);
    await send(pane, 'LONGTOOL please');
    const dlg = page.locator('.ui-modal.agp-modal .ui-modal-box');
    await expect(dlg).toBeVisible({ timeout: 15000 });
    await dlg.locator('.agp-choice[data-choice="allow"]').click();

    const card = pane.locator('.agp-tool').first();
    await expect(card).toBeVisible({ timeout: 15000 });
    // 머리가 **무엇을 했는지** 말한다 — 인자를 담는다 (원본의 `Bash(seq 1 40)`).
    await expect(card.locator('.agp-tool-head')).toContainText('seq 1 40');

    const peek = card.locator('.agp-tool-peek');
    await expect(peek).toBeVisible({ timeout: 15000 });
    const text = (await peek.textContent()) || '';
    expect(text, `앞이 안 보인다: ${text}`).toContain('line-01');
    expect(text, `**끝이 안 보인다** — 결론은 끝에 있다: ${text}`).toContain('line-40');
    expect(text, `남은 줄 수를 말하지 않는다: ${text}`).toMatch(/36/);
    // 가운데는 접혔다.
    expect(text, `접히지 않았다: ${text}`).not.toContain('line-20');

    // 펼치면 전문이 서고 엿보기는 물러난다 — 같은 글이 두 번 서지 않는다.
    await card.locator('.agp-tool-head').click();
    await expect(card.locator('.agp-tool-res')).toContainText('line-20');
    await expect(peek).toBeHidden();
  });

  /**
   * 짧은 출력은 **접지 않는다** — *"n 줄 이내면 그냥 출력해도좋다"*. 접는 쪽만 재면
   * "언제나 접음" 도 초록이다.
   */
  test('V-M11-49b: 짧은 출력은 그대로 보인다 (FR-M11-27)', async ({ page }) => {
    await waitForInit(page);
    const pane = await openAgentTab(page);
    await send(pane, 'please APPROVE this');
    const dlg = page.locator('.ui-modal.agp-modal .ui-modal-box');
    await expect(dlg).toBeVisible({ timeout: 15000 });
    await dlg.locator('.agp-choice[data-choice="allow"]').click();

    const peek = pane.locator('.agp-tool').first().locator('.agp-tool-peek');
    await expect(peek).toBeVisible({ timeout: 15000 });
    expect((await peek.textContent()) || '', '짧은 출력을 접었다').not.toMatch(/줄 더|more lines/);
  });

  test('V-M11-51: 다른 탭에 다녀와도 대화 스크롤이 그 자리다 (FR-M11-17)', async ({ page }) => {
    await waitForInit(page);
    const pane = await openAgentTab(page);
    const log = pane.locator('.agp-log');

    // 스크롤이 생길 만큼 쌓는다 — 긴 출력을 내는 시나리오가 없으므로 턴을 돈다.
    for (let i = 0; i < 6; i++) {
      await send(pane, `say PONG ${i}`);
      await expect(pane).toHaveAttribute('data-state', 'done', { timeout: 15000 });
    }
    const room = await log.evaluate((n) => n.scrollHeight - n.clientHeight);
    expect(room, '대화가 스크롤될 만큼 길지 않다 — 이 검사는 그때 아무것도 재지 못한다')
      .toBeGreaterThan(40);

    // **중간**으로 올린다. 사용자가 과거를 읽는 자리다.
    const mid = Math.floor(room / 2);
    await log.evaluate((n, y) => { n.scrollTop = y; }, mid);
    await expect.poll(() => log.evaluate((n) => n.scrollTop), { timeout: 5000 }).toBe(mid);

    // 다른 탭을 만들어 다녀온다 — 접수한 그 경로다.
    const tabs = page.locator('#area .pn.focused .pn-tab');
    const n = await tabs.count();
    await page.locator('#area .pn.focused .pn-tab-add').click();
    await expect(tabs).toHaveCount(n + 1, { timeout: 10000 });
    await tabs.nth(n - 1).click();
    await expect(pane).toBeVisible({ timeout: 10000 });

    expect(await log.evaluate((el) => el.scrollTop),
      '다른 곳에 다녀오니 대화가 맨 위로 갔다 (M11-B14)').toBe(mid);
  });

  test('V-M11-34: 아는 0 은 0 으로 적는다 (FR-M11-16 · FR-CBG-5)', async ({ page }) => {
    await waitForInit(page);
    const pane = await openAgentTab(page);
    await expect(pane.locator('.agp-acct')).toContainText('fake@example', { timeout: 15000 });

    await expect(pane.locator('.agp-open')).toBeVisible();
    await expect(pane.locator('.agp-open')).toContainText('0');
    await expect(pane.locator('.agp-open'),
      '세어서 아는 0 을 모름으로 덮었다').not.toContainText('알 수 없음');
  });

  test('V-M11-8: 도구 사용은 접힌 채 서고 눌러야 펴진다 (FR-M11-4)', async ({ page }) => {
    await waitForInit(page);
    const pane = await openAgentTab(page);
    await send(pane, 'please APPROVE this');
    const dlg = page.locator('.ui-modal.agp-modal .ui-modal-box');
    await expect(dlg).toBeVisible({ timeout: 15000 });
    await dlg.locator('.agp-choice[data-choice="allow"]').click();
    const card = pane.locator('.agp-tool').first();
    await expect(card).toBeVisible({ timeout: 15000 });
    // `details` 여야 하고, 접혀 있어야 한다.
    expect(await card.evaluate((n) => n.tagName)).toBe('DETAILS');
    await expect(card).not.toHaveAttribute('open', /.*/);
    await expect(pane.locator('.agp-tool .agp-tool-res').first()).toBeHidden();
    // 머리를 누르면 펴진다.
    await card.locator('.agp-tool-head').click();
    await expect(pane.locator('.agp-tool .agp-tool-res').first()).toBeVisible();
  });
});

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
    /**
     * **계약이 바뀌었다** (FR-M11-41 / M11-B41, 사용자 결정 2026-09-15): `FR-APS-6` 은
     * *"Esc 는 답이 아니다 — 요청은 열린 채 남는다"* 였고, 실제로 쓰니 **되돌릴 길보다
     * 멈출 길이 급했다**(접수: *"무한정 기다림"*). 이제 **닫는 것은 거절 후 끊기**이며
     * 그 갈래는 `V-M11-77` 이 잰다 — 여기서 닫으면 요청이 사라져 아래를 재지 못한다.
     *
     * 여기 남는 계약은 다른 것이다: **답하지 않은 요청은 재생을 넘어 다시 열린다**
     * (FR-ABG-5). 그래서 닫지 않고 그대로 새로고침한다.
     */
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
    // **계약이 바뀌었다** (M11_SRS FR-M11-31 / V-M11-63): 목록의 마지막에 *직접 입력*
    // 항목이 선다 (원본 TUI 의 `Type something.` — §2.10 (9)). 그래서 세는 것은
    // **에이전트가 준 선택지**이며, 그 수는 값을 가진 것들이다.
    await expect(dlg.locator('.agp-q input[value="Red"], .agp-q input[value="Blue"]')).toHaveCount(2);
    await dlg.locator('.agp-q input[value="Blue"]').check();
    // **계약이 바뀌었다** (FR-M11-45 / V-M11-70): 질문은 하나씩 서고 **확인 화면**을
    // 지나야 제출이 열린다. `다음` 이 그 자리로 넘긴다 — 원본이 마지막에 한 번
    // 묻는 것과 같다.
    await dlg.locator('.agp-q-next').click();
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
     *
     * **목록을 통째로 박지 않는다** (2026-09-16): 종전에는 `['/compact']` 라고 적었고,
     * 흉내에 `config` 를 더하자(M12_SRS FR-M12-4 — 실측한 `initialize` 는 그 명령을
     * 싣는다) 떨어졌다. **재려던 것은 목록의 내용이 아니라 걸러진다는 사실**이므로
     * 그것을 잰다 — 흉내가 원본에 가까워질 때마다 검사가 떨어지면 안 된다.
     */
    await ta.fill('/co');
    const names = pane.locator('.agp-sugg .agp-sugg-item .agp-sugg-name');
    await expect(names.first()).toHaveText('/compact');
    // 걸러졌다: `/co` 로 시작하지 않는 것이 목록에 없다.
    for (const n of await names.allTextContents()) expect(n).toContain('co');
    await pane.locator('.agp-sugg .agp-sugg-item').first().click();
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
  /**
   * **계약이 바뀌었다** (FR-M11-43 / M11-B43, 사용자 접수 2026-09-15): `D-M9-20` 은
   * *"터미널 탭은 남는다"* 였다. 실제로 쓰니 **같은 세션이 두 자리에 보이고 하나는
   * 이미 끝난 셸**이라, 접수가 *"tab 이름 가져오고, 원래 탭 지우는걸로 변경"* 으로 왔다.
   * 올리기는 **옮기는 일**이지 복제하는 일이 아니다.
   */
  test('V-M9-33/36 (FR-M9-33·36 · FR-M11-43): 셸의 세션을 GUI 로 올리고 원래 탭은 닫힌다', async ({ page }) => {
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
    // **자리를 옮긴다** — 하나가 서고 하나가 닫히므로 수는 그대로다 (FR-M11-43).
    await expect(page.locator(AGENT_PANE_READY)).toBeVisible({ timeout: 15000 });
    await expect(tabs, '탭 수가 변했다 — 올리기는 옮기는 일이다').toHaveCount(after, { timeout: 15000 });
    // 그리고 **원래 터미널 도구의 탭은 없다.**
    const ids = await page.evaluate(() => {
      const app: any = (window as any).app;
      const out: string[] = [];
      const walk = (n: any) => { if (!n) return; (n.tabs || []).forEach((t: any) => t.toolId && out.push(t.toolId)); (n.children || []).forEach(walk); };
      walk(app.aw() && app.aw().layout);
      return out;
    });
    expect(ids, '원래 터미널 탭이 남았다 — FR-M11-43 은 그것을 닫는다').not.toContain(toolId);
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
    /**
     * 머리에서 사라졌다 — **남는 것은 이름과 버튼뿐이다.**
     *
     * **계약이 바뀌었다** (M12_SRS FR-M12-15, 2026-09-16): 종전에는 `.agp-state` 도
     * 머리에 남았다. 접수(*"작업 중 표시 … 잘 안보이네"*)로 대화와 입력창 사이로
     * 내려갔으므로 그것도 여기서 센다.
     */
    expect(await pane.locator('.agp-head .agp-state').count(), '도는 중 표시가 머리에 남았다').toBe(0);
    expect(await pane.locator('.agp-input .agp-state').count(), '도는 중 표시가 입력 묶음에 없다').toBe(1);
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
      // **계약이 바뀌었다** (M11_SRS FR-M11-31 / V-M11-63): 목록의 마지막에 *직접 입력*
      // 항목이 선다 (원본 TUI 의 `Type something.` — §2.10 (9)). 그래서 세는 것은
      // **에이전트가 준 선택지**이며, 그 수는 값을 가진 것들이다.
      await expect(dlg.locator('.agp-q input[value="Red"], .agp-q input[value="Blue"]')).toHaveCount(2);
      await dlg.locator('.agp-q input[value="Blue"]').check();
      // **계약이 바뀌었다** (FR-M11-45 / V-M11-70): 질문은 하나씩 서고 **확인 화면**을
      // 지나야 제출이 열린다. `다음` 이 그 자리로 넘긴다 — 원본이 마지막에 한 번
      // 묻는 것과 같다.
      await dlg.locator('.agp-q-next').click();
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

    /**
     * M12_SRS V-M12-3 (FR-M12-1) — **도구 카드 머리에 인자가 선다.**
     *
     * **이것이 누수 L2 의 검사다.** 종전에는 화면이 `tool_start` 의 `detail` 을 버리고
     * (`_toolCard(id, tool, null)`) claude 의 `message` 스냅샷 경로로만 인자를 얻었다 —
     * 그래서 codex·omp 의 카드에는 **도구 이름뿐이었다.** 어댑터는 그 값을 처음부터
     * 싣고 있었다.
     */
    test(`V-M12-3/${agent}: 도구 카드가 어댑터가 준 인자를 그린다 (FR-M12-1)`, async ({ page }) => {
      await waitForInit(page);
      const pane = await openAgentTab(page, agent);
      await send(pane, 'TOOLARG please');
      await expect(pane).toHaveAttribute('data-state', 'done', { timeout: 20000 });
      const head = pane.locator('.agp-tool .agp-tool-title').first();
      await expect(head).toContainText('seq 1 3', { timeout: 15000 });
      // 펼치면 본문에도 같은 값이 있다 — 머리는 잘린 것이고 본문이 온전한 것이다.
      await pane.locator('.agp-tool .agp-tool-head').first().click();
      await expect(pane.locator('.agp-tool .agp-tool-in').first()).toContainText('seq 1 3');
    });
  });
}

/**
 * M12_SRS V-M12-26 (FR-M12-10) — **글 쓰던 중간의 `/` 도 명령을 찾는다.**
 *
 * 사용자 지시: *"글 쓰던 중간의 `/` 도 명령을 찾아 넣는다."*
 *
 * 재는 것 둘이다: 목록이 **서는가**, 그리고 고른 것이 **문장을 날리지 않는가**.
 * 뒤쪽이 요구의 절반이다 — 통째로 덮으면 사용자가 쓴 앞글이 함께 사라진다.
 */
test.describe('에이전트 슬래시 — 문장 중간 (M12)', () => {
  test('V-M12-26: 문장 중간의 `/` 로 고른 명령이 앞글을 날리지 않는다 (FR-M12-10)', async ({ page }) => {
    await waitForInit(page);
    const pane = await openAgentTab(page);
    const ta = pane.locator('.agp-ta');
    await ta.click();
    // 먼저 문장을 쓰고, 그 뒤에 `/` 를 친다.
    await ta.pressSequentially('이걸 고쳐줘 /mod');
    const sugg = pane.locator('.agp-sugg:not([hidden]) .agp-sugg-item');
    await expect(sugg.first()).toBeVisible({ timeout: 10000 });
    await expect(sugg.first().locator('.agp-sugg-name')).toHaveText('/model');
    await ta.press('Tab');
    // **앞글이 살아 있고 그 토큰만 갈렸다.**
    await expect(ta).toHaveValue('이걸 고쳐줘 /model ');
  });

  test('V-M12-26b: 경로의 `/` 는 목록을 세우지 않는다 (FR-M12-10)', async ({ page }) => {
    await waitForInit(page);
    const pane = await openAgentTab(page);
    const ta = pane.locator('.agp-ta');
    await ta.click();
    await ta.pressSequentially('web/js 를 봐');
    await expect(pane.locator('.agp-sugg:not([hidden])')).toHaveCount(0);
  });
});

/**
 * M12_SRS V-M12-5 (FR-M12-2) — **codex 는 경로만 준다. 줄을 지어내지 않는다.**
 *
 * `fileChange` 의 `changes` 는 바뀌는 경로만 싣는다 (D-M11-4). 종전에는 화면이
 * `old_string`/`new_string` 을 찾았으므로 **diff 자체가 서지 않았다** — 편집이라는
 * 사실조차 보이지 않았다. 지금은 머리가 서고 **몸은 서지 않는다**: 빈 몸을 세우면
 * *"바뀐 줄이 없다"* 로 읽힌다.
 */
test.describe('에이전트 도구 — codex 의 편집 (M12)', () => {
  test('V-M12-5: codex 의 편집은 머리만 선다 — 줄을 지어내지 않는다 (FR-M12-2)', async ({ page }) => {
    await waitForInit(page);
    const pane = await openAgentTab(page, 'codex');
    await send(pane, 'EDITDIFF please');
    await expect(pane).toHaveAttribute('data-state', 'done', { timeout: 20000 });
    const diff = pane.locator('.agp-tool .agp-diff').first();
    await expect(diff).toBeVisible({ timeout: 15000 });
    await expect(diff.locator('.agp-diff-head')).toContainText('sample.txt');
    // 줄을 주지 않는 어댑터에서 몸을 세우지 않는다.
    await expect(diff.locator('.agp-diff-body')).toHaveCount(0);
    await expect(diff.locator('.agp-diff-add')).toHaveCount(0);
    await expect(diff.locator('.agp-diff-del')).toHaveCount(0);
  });
});

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

    /**
     * **계약이 바뀌었다** (FR-M11-48 / M11-B51): 목록은 이제 **부분 일치**도 찾으므로
     * `/m` 에 여럿이 선다 (접두가 앞이다). 그리고 설명은 **툴팁이 아니라 항목에**
     * 보인다 — 가리켜야 나오는 것은 *"보인다"* 가 아니다.
     */
    const sugg = pane.locator('.agp-sugg .agp-sugg-item').first();
    await expect(sugg).toBeVisible({ timeout: 10000 });
    await expect(sugg.locator('.agp-sugg-name')).toHaveText('/model');
    // 인자 문법이 그대로 선다 — 이것이 없으면 무엇을 칠지 알 수 없다.
    await expect(sugg.locator('.agp-sugg-hint'), '인자 문법이 보이지 않는다').toHaveText('<model>');
    await expect(sugg.locator('.agp-sugg-desc'), '설명이 보이지 않는다').toHaveText('Set the AI model');

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

  /**
   * **계약이 바뀌었다** (FR-M11-46 / M11-B46, 사용자 결정 2026-09-15): 하단 글꼴은
   * 이제 터미널과 **같지 않다.** `FR-M11-15` 는 9px 이 읽히지 않아 터미널(14px)에
   * 맞췄던 것이고, 실제로 쓰니 이번엔 커서 **그 사이**로 왔다.
   *
   * 그러므로 재는 것은 *같은가* 가 아니라 **그 사이에 있는가** 다. V-M11-79 가
   * 색이 갈리는 쪽을 잰다.
   */
  test('V-M11-35: 하단 글꼴이 9 와 터미널 사이다 (FR-M11-46 · FR-M11-15 개정)', async ({ page }) => {
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
    // 종전은 `--fs-xs`(9px) 였다 — 접수는 그것이 읽히지 않는다는 말이었다.
    expect(dashFs, `하단 글꼴이 9 이하다: ${dashFs}`).toBeGreaterThan(9);
    // 그리고 터미널(14)보다는 작다 — 두 번째 접수가 그것이다.
    expect(dashFs, `하단 ${dashFs} · 터미널 ${termFs}`).toBeLessThan(termFs);
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

    /**
     * ① **에이전트가 말할 때는 지킨다.** 중간으로 올린다 — 맨 위(0)는 고침 없이도 0 이라
     * 못 가른다.
     *
     * **계약이 바뀌었다** (FR-M11-39 / M11-B38): *보낼 때는* 따라간다. `FR-M11-26` 의
     * 규칙은 **에이전트가 말할 때**의 것이고, 엔터는 사용자의 조작이다. 그래서 여기서는
     * 보내지 않고, 이미 도는 턴의 델타가 오는 동안을 잰다.
     */
    const mid = Math.floor(room / 2);
    await send(pane, 'SLOW');
    await expect(pane).toHaveAttribute('data-state', 'working', { timeout: 15000 });
    await log.evaluate((n, y) => { n.scrollTop = y; }, mid);
    const grew = await log.evaluate((n) => n.scrollHeight);
    // 새 글이 실제로 들어올 때까지 기다린다 — 들어오지 않으면 아무것도 재지 못한다.
    await expect.poll(() => log.evaluate((n) => n.scrollHeight), { timeout: 20000 })
      .toBeGreaterThan(grew);
    expect(await log.evaluate((n) => n.scrollTop),
      '읽는 중에 새 글이 와서 끌려갔다 (M11-B24)').toBe(mid);
    await expect(pane).toHaveAttribute('data-state', 'done', { timeout: 30000 });

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
   * **계약이 바뀌었다** (V-M11-56 · D-M11-5, 사용자 결정 2026-09-15): 긴 쪽의 엿보기가
   * *앞 2줄·뒤 2줄* 에서 **한 문장**으로 왔다. 원본이 `Searched for 1 pattern (ctrl+o
   * to expand)` 로 그렇게 하며(§2.10 (3)), 앞뒤 두 줄은 접힌 머리를 네 줄로 만들어
   * 접은 뜻을 스스로 없앤다.
   *
   * **본문이 새지 않는지가 요점이다** — 한 문장이라고 하면서 줄을 함께 보이면 그것은
   * 옛 계약이다. 그래서 규모(줄 수)는 있고 본문 줄은 **없어야** 한다.
   */
  test('V-M11-56: 접힌 도구가 한 문장으로 말한다 (FR-M11-27 개정 · D-M11-5)', async ({ page }) => {
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
    expect(text, `규모를 말하지 않는다: ${text}`).toMatch(/40/);
    expect(text, `**본문이 샜다** — 한 문장이어야 한다: ${text}`).not.toContain('line-01');
    expect(text, `본문이 샜다: ${text}`).not.toContain('line-40');
    expect(text.split('\n').length, `한 줄이 아니다: ${text}`).toBe(1);

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

    /**
     * **창을 오가는 경로도 재야 한다** (사용자 접수 2026-09-15 — 고쳤다는 뒤에도
     * 남아 있었다).
     *
     * 탭만 오갈 때는 pane 요소가 재사용되어 **이미 문서에 붙어 있다.** 창이 바뀌면
     * 그렇지 않고, 그때 `_mountTabBody` 에서 복원하면 `scrollHeight:0` 인 요소에
     * `scrollTop` 을 쓰게 되어 **조용히 무시된다.** 탭 경로만 재는 동안 이 결함은
     * 초록 뒤에 숨어 있었다.
     */
    await log.evaluate((el, y) => { el.scrollTop = y; }, mid);
    await expect.poll(() => log.evaluate((el) => el.scrollTop), { timeout: 5000 }).toBe(mid);
    await page.keyboard.press('Control+Shift+Digit2');
    await expect(page.locator('#area .pn.focused .agent-pane.vis')).toHaveCount(0, { timeout: 10000 });
    await page.keyboard.press('Control+Shift+Digit1');
    const back = page.locator('#area .pn.focused .agent-pane.vis .agp-log');
    await expect(back).toBeVisible({ timeout: 10000 });
    await expect.poll(() => back.evaluate((el) => el.scrollTop), { timeout: 5000 })
      .toBe(mid);
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
  /**
   * M11_SRS FR-M11-24 (M11-B22) — **말 블록이 자기 요소로 선다.**
   *
   * 접수: *"출력이 하나의 텍스트 블럭이 맞나? 실제 출력처럼 잘 잘려서 나뉘어 나오면
   * 좋을꺼같다"*. **경계는 프로토콜이 이미 준다** (§2.11 (2) 실측 — `assistant` 프레임
   * 하나가 블록 하나다). 우리가 `_message()` 에서 **지우고 다시 그리며** 버리고 있었다.
   *
   * **앞 블록이 사는지가 요점이다.** 마지막 블록만 재면 지우는 구현도 초록이다.
   */
  test('V-M11-52: 말 블록이 각자 서고 앞 블록이 지워지지 않는다 (FR-M11-24)', async ({ page }) => {
    await waitForInit(page);
    const pane = await openAgentTab(page);
    await send(pane, 'SPLIT please');
    await expect(pane).toHaveAttribute('data-state', 'done', { timeout: 15000 });

    const bodies = pane.locator('.agp-msg.agp-assistant .agp-body');
    // 도구를 사이에 낀 턴에서 말이 둘이다 — 한 덩이가 아니다.
    await expect(bodies.filter({ hasText: 'FIRST' })).toHaveCount(1);
    await expect(bodies.filter({ hasText: 'SECOND' })).toHaveCount(1);
    // 그리고 **둘이 같은 요소가 아니다** — 나뉘었다는 말의 뜻이 그것이다.
    const all = (await pane.locator('.agp-msg.agp-assistant').allTextContents()).join('|');
    expect(all, `앞말이 사라졌다: ${all}`).toContain('FIRST');
    expect(all, `끝말이 없다: ${all}`).toContain('SECOND');
    // 도구 카드도 남아 있다 — 지우는 손이 카드까지 걷어 가지 않았다.
    await expect(pane.locator('.agp-tool')).toHaveCount(1);
  });

  /**
   * M11_SRS FR-M11-28 (M11-B26) — **내용을 주지 않아도 추론은 보인다.**
   *
   * 실측(§2.11 (1)): claude 의 `thinking_delta.thinking` 은 **언제나 빈 문자열**이고
   * `estimated_tokens` 만 움직인다. 원본이 `thought for 2s` 로 시간만 말하는 이유다.
   *
   * **스냅샷이 와도 사라지지 않는지가 요점이다** — 종전 결함이 정확히 그것이었다
   * (빈 `thinking` 스냅샷이 세워 둔 칸을 지웠다).
   */
  test('V-M11-53: 내용 없는 추론이 시간·토큰으로 선다 (FR-M11-28)', async ({ page }) => {
    await waitForInit(page);
    const pane = await openAgentTab(page);
    await send(pane, 'THINKTOKENS please');
    await expect(pane).toHaveAttribute('data-state', 'done', { timeout: 15000 });

    const note = pane.locator('.agp-think.agp-think-note');
    await expect(note, '빈 추론이 자리를 잃었다 — 스냅샷이 지운다').toBeVisible({ timeout: 15000 });
    const text = (await note.textContent()) || '';
    expect(text, `토큰을 말하지 않는다: ${text}`).toMatch(/120/);
    expect(text, `시간을 말하지 않는다: ${text}`).toMatch(/\d/);
    // 펼칠 것이 없으므로 `details` 가 아니다 — 눌러도 아무것도 없으면 고장으로 읽힌다.
    expect(await note.evaluate((n) => n.tagName), '빈 추론을 펼치게 두었다').not.toBe('DETAILS');
    // 말은 말대로 선다 — 추론이 본문을 가로채지 않았다.
    await expect(pane.locator('.agp-msg.agp-assistant .agp-body').last()).toContainText('THOUGHT');
  });

  /**
   * 내용을 **주는** 어댑터에서는 그 내용이 선다 (codex·omp). 없는 쪽만 재면 값을 버리는
   * 구현도 초록이다 — `FR-CBG-5` 의 반대 방향이 여기서 갈린다.
   */
  test('V-M11-54: 내용이 오면 그 내용이 접힌 채 선다 (FR-M11-28)', async ({ page }) => {
    await waitForInit(page);
    const pane = await openAgentTab(page);
    await send(pane, 'THINKTEXT please');
    await expect(pane).toHaveAttribute('data-state', 'done', { timeout: 15000 });

    const det = pane.locator('details.agp-think');
    await expect(det).toBeVisible({ timeout: 15000 });
    await expect(det).not.toHaveAttribute('open', /.*/);
    await expect(det.locator('.agp-think-body')).toContainText('한 줄 생각');
    await expect(det.locator('.agp-think-body')).toContainText('두 줄 생각');
  });

  /**
   * M11_SRS FR-M11-37 (M11-B36) — **편집은 그 자리에서 무엇이 바뀌었는지 보인다.**
   *
   * 재료는 **도구 입력**이다 (§2.11 (3) 실측 — 결과에는 "updated successfully" 한 줄뿐).
   * 줄번호는 **달지 않는다**: 파일 내용을 알아야 나오는 값이고 프로토콜은 주지 않는다
   * (D-M11-4).
   */
  test('V-M11-64: 편집 diff 가 도구 카드 안에 선다 (FR-M11-37)', async ({ page }) => {
    await waitForInit(page);
    const pane = await openAgentTab(page);
    await send(pane, 'EDITDIFF please');
    await expect(pane).toHaveAttribute('data-state', 'done', { timeout: 15000 });

    const card = pane.locator('.agp-tool').first();
    await expect(card).toBeVisible({ timeout: 15000 });
    // **별도 창이 아니라 그 자리다** — 원본과 같은 자리 (§2.10 (2)).
    const diff = card.locator('.agp-diff');
    await expect(diff).toHaveCount(1);
    const head = (await diff.locator('.agp-diff-head').textContent()) || '';
    expect(head, `파일이 없다: ${head}`).toContain('sample.txt');
    expect(head, `늘고 준 줄 수가 없다: ${head}`).toContain('+2');
    expect(head, `늘고 준 줄 수가 없다: ${head}`).toContain('-1');
    await expect(diff.locator('.agp-diff-del')).toHaveText(['-world']);
    await expect(diff.locator('.agp-diff-add')).toHaveText(['+WORLD', '+plus']);
    // 줄번호를 지어내지 않았다 (D-M11-4).
    const body = (await diff.locator('.agp-diff-body').textContent()) || '';
    expect(body, `줄번호를 지어냈다: ${body}`).not.toMatch(/^\s*\d+\s/m);
  });

  /**
   * 편집이 **아닌** 도구에는 서지 않는다 — 모르는 도구의 입력을 diff 로 읽으면 없는
   * 변경을 그린다 (FR-M11-37 · FR-CBG-5).
   */
  test('V-M11-64b: 편집이 아닌 도구에는 diff 가 없다 (FR-M11-37)', async ({ page }) => {
    await waitForInit(page);
    const pane = await openAgentTab(page);
    await send(pane, 'SPLIT please');
    await expect(pane).toHaveAttribute('data-state', 'done', { timeout: 15000 });
    await expect(pane.locator('.agp-tool')).toHaveCount(1);
    await expect(pane.locator('.agp-diff')).toHaveCount(0);
  });
  /**
   * M11_SRS FR-M11-29 (M11-B27 · B15 · B35) — **턴 중의 입력은 쌓이고 보인다.**
   *
   * 원본을 §2.10 (5) 에서 쟀다: 대기 중인 프롬프트가 `❯ <본문>` 으로 입력창 **위에**
   * 줄줄이 서고, 입력창의 안내가 *"Press up to edit queued messages"* 로 바뀐다.
   *
   * **나가지 않는지가 요점이다** — 화면에 세우기만 하고 서버로도 보내면 접수한 증상
   * (*"추론중에 입력하면 그대로 입력된다"*)이 그대로 남는다.
   */
  test('V-M11-57: 턴 중의 프롬프트가 나가지 않고 쌓인다 (FR-M11-29)', async ({ page }) => {
    await waitForInit(page);
    const pane = await openAgentTab(page);
    await send(pane, 'SLOW');
    await expect(pane).toHaveAttribute('data-state', 'working', { timeout: 15000 });

    await send(pane, '큐테스트A');
    await send(pane, '큐테스트B');
    const q = pane.locator('.agp-queue .agp-queue-item');
    await expect(q).toHaveCount(2);
    await expect(q.nth(0)).toContainText('큐테스트A');
    await expect(q.nth(1)).toContainText('큐테스트B');
    // 표식이 원본과 같다.
    await expect(q.nth(0).locator('.agp-queue-mark')).toHaveText('\u276f');
    // **대화에는 서지 않았다** — 나갔다면 사용자 말풍선이 생긴다.
    const said = (await pane.locator('.agp-msg.agp-user').allTextContents()).join('|');
    expect(said, `큐가 그대로 나갔다: ${said}`).not.toContain('큐테스트A');
  });

  /** 안내와 손이 원본 그대로인가 — 입력창이 말하고, **위 화살표**가 꺼낸다. */
  test('V-M11-58: 큐가 있으면 안내가 바뀌고 위 화살표가 꺼낸다 (FR-M11-29)', async ({ page }) => {
    await waitForInit(page);
    const pane = await openAgentTab(page);
    const ta = pane.locator('.agp-ta');
    await send(pane, 'SLOW');
    await expect(pane).toHaveAttribute('data-state', 'working', { timeout: 15000 });
    await send(pane, '큐테스트A');

    await expect(ta).toHaveAttribute('placeholder', '위로 올려 고칩니다');
    await ta.click();
    await ta.press('ArrowUp');
    // **마지막 큐**가 입력창으로 온다 — 그대로 두면 취소이고 고쳐 보내면 수정이다.
    await expect(ta).toHaveValue('큐테스트A');
    await expect(pane.locator('.agp-queue .agp-queue-item')).toHaveCount(0);
    // 큐가 비면 안내도 돌아온다.
    await expect(ta).not.toHaveAttribute('placeholder', '위로 올려 고칩니다');
  });

  /**
   * FR-M11-29: **`Esc` 는 끊고 한 번에 보낸다** (사용자 실측: *"esc 누르면 현재 동작
   * 취소되고 큐가 한번에 들어가"*). 위 화살표와 **다른 일**이다.
   */
  test('V-M11-59: Esc 가 턴을 끊고 큐를 한 번에 보낸다 (FR-M11-29)', async ({ page }) => {
    await waitForInit(page);
    const pane = await openAgentTab(page);
    await send(pane, 'SLOW');
    await expect(pane).toHaveAttribute('data-state', 'working', { timeout: 15000 });
    await send(pane, '큐테스트A');
    await send(pane, '큐테스트B');

    await pane.locator('.agp-ta').press('Escape');
    // 도는 턴이 끊겼다.
    await expect(pane.locator('.agp-line.agp-err')).toBeVisible({ timeout: 15000 });
    // 큐는 **한 프롬프트로** 나갔다 — 둘이 한 말풍선에 든다.
    const merged = pane.locator('.agp-msg.agp-user').filter({ hasText: '큐테스트A' });
    await expect(merged).toHaveCount(1, { timeout: 15000 });
    await expect(merged).toContainText('큐테스트B');
    await expect(pane.locator('.agp-queue .agp-queue-item')).toHaveCount(0);
  });

  /**
   * M12_SRS V-M12-28 (FR-M12-12) — **끊김이 먼저 서고 큐가 뒤에 선다.**
   *
   * 접수: *"큐가 들어갈때 큐가 들어가고 이후 턴 중단이 선언된다. 순서가 반대이다.
   * 턴중단 후 큐가 들어가는것이다."*
   *
   * `/api/agent/interrupt` 의 응답은 *"끊는 프레임을 썼다"* 이지 *"턴이 끝났다"* 가
   * 아니다. 그 사이에 큐가 나가면 끊김 표시가 **새 프롬프트 뒤에** 서고, 사용자는
   * 그것을 *방금 보낸 프롬프트가 0초 만에 중단됐다* 로 읽는다.
   *
   * **재는 것은 DOM 의 순서다** — 둘 다 결국 서므로 유무로는 가를 수 없다
   * (`V-M11-59` 가 유무만 재어 이 결함을 덮고 있었다).
   */
  test('V-M12-28: 끊김이 큐보다 먼저 선다 (FR-M12-12)', async ({ page }) => {
    await waitForInit(page);
    const pane = await openAgentTab(page);
    await send(pane, 'SLOW');
    await expect(pane).toHaveAttribute('data-state', 'working', { timeout: 15000 });
    await send(pane, '큐순서A');

    await pane.locator('.agp-ta').press('Escape');
    const merged = pane.locator('.agp-msg.agp-user').filter({ hasText: '큐순서A' });
    await expect(merged).toHaveCount(1, { timeout: 15000 });
    await expect(pane.locator('.agp-line.agp-err')).toBeVisible({ timeout: 15000 });

    // 대화 안에서 **끊김 표시가 큐 말풍선보다 앞**이어야 한다.
    const order = await pane.evaluate((el) => {
      const nodes = [...el.querySelectorAll('.agp-line.agp-err, .agp-msg.agp-user')];
      return nodes.map((n) => (n.classList.contains('agp-err') ? 'ABORT' : 'USER:' + (n.textContent || '').trim()));
    });
    const abortAt = order.indexOf('ABORT');
    const queuedAt = order.findIndex((x) => x.startsWith('USER:') && x.includes('큐순서A'));
    expect(abortAt, `끊김 표시가 없다: ${order.join(' | ')}`).toBeGreaterThanOrEqual(0);
    expect(abortAt, `큐가 먼저 섰다 — 사용자는 새 프롬프트가 중단된 것으로 읽는다: ${order.join(' | ')}`)
      .toBeLessThan(queuedAt);
  });

  /** 큐가 비어 있으면 `Esc` 는 **종전 그대로** 다 — 더해진 것은 큐가 있을 때의 갈래다. */
  test('V-M11-59b: 큐가 없으면 Esc 는 종전대로 끊기만 한다 (FR-M11-29)', async ({ page }) => {
    await waitForInit(page);
    const pane = await openAgentTab(page);
    await send(pane, 'SLOW');
    await expect(pane).toHaveAttribute('data-state', 'working', { timeout: 15000 });
    await pane.locator('.agp-ta').press('Escape');
    await expect(pane.locator('.agp-line.agp-err')).toBeVisible({ timeout: 15000 });
    await expect(pane).toHaveAttribute('data-state', 'done');
    await expect(pane.locator('.agp-msg.agp-user')).toHaveCount(1);
  });

  /** 턴이 끝나면 **맨 앞 하나**가 나간다 (원본: *"앞 턴이 끝난 뒤 처리된다"*). */
  test('V-M11-60: 턴이 끝나면 큐의 맨 앞이 나간다 (FR-M11-29)', async ({ page }) => {
    await waitForInit(page);
    const pane = await openAgentTab(page);
    await send(pane, 'SLOW');
    await expect(pane).toHaveAttribute('data-state', 'working', { timeout: 15000 });
    await send(pane, 'PONG-큐1');
    // **먼저 쌓였다는 것**을 확인한다. 이것 없이 끝만 재면 큐 없이 곧바로 보내는
    // 구현도 초록이다 (무력화 프로브가 그것을 보였다).
    await expect(pane.locator('.agp-queue .agp-queue-item')).toHaveCount(1);
    await expect(pane.locator('.agp-msg.agp-user').filter({ hasText: 'PONG-큐1' })).toHaveCount(0);

    // 턴이 스스로 끝나기를 기다린다 — 끊지 않는다.
    await expect(pane.locator('.agp-msg.agp-user').filter({ hasText: 'PONG-큐1' }))
      .toHaveCount(1, { timeout: 30000 });
    await expect(pane.locator('.agp-queue .agp-queue-item')).toHaveCount(0);
  });
  /**
   * M11_SRS FR-M11-30 (M11-B28) — **이미지를 붙일 수 있다.**
   *
   * 손은 원본과 같다 — **붙여넣기**다 (§2.10 (6): `Image in clipboard · ctrl+v to
   * paste`). 본문에는 원본이 적는 그대로 `[Image #1]` 이 선다.
   *
   * 클립보드 이미지는 브라우저가 만들 수 없으므로 `DataTransfer` 로 **실제 paste
   * 이벤트**를 만든다 — 핸들러를 직접 부르면 등록 여부가 재어지지 않는다.
   */
  test('V-M11-62: 붙여넣은 이미지가 프롬프트에 실린다 (FR-M11-30)', async ({ page }) => {
    await waitForInit(page);
    const pane = await openAgentTab(page);
    const ta = pane.locator('.agp-ta');
    await ta.click();
    await ta.fill('이 색은? ');

    // 8×8 PNG 한 장 — 실측 프로브가 쓴 것과 같은 크기다.
    const sent = await page.evaluate(async () => {
      const png = 'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAIAQMAAAD+wSzIAAAABlBMVEX///+/v7+jQ3Y5AAAADklEQVQI12P4AIX8EAgALgAD/aNpbtEAAAAASUVORK5CYII=';
      const bin = atob(png);
      const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      const file = new File([arr], 'x.png', { type: 'image/png' });
      const dt = new DataTransfer();
      dt.items.add(file);
      const ta = document.querySelector('.agent-pane .agp-ta') as HTMLTextAreaElement;
      ta.focus();
      ta.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
      return true;
    });
    expect(sent).toBeTruthy();

    // 본문에 원본과 같은 표식이 선다.
    await expect(ta).toHaveValue(/\[Image #1\]/, { timeout: 10000 });

    // 보내면 서버까지 간다 — 프레임이 거절되면 턴이 서지 않는다.
    await ta.press('Enter');
    await expect(pane).toHaveAttribute('data-state', 'done', { timeout: 20000 });
    await expect(pane.locator('.agp-msg.agp-user').last()).toContainText('[Image #1]');
    // 보낸 뒤에는 첨부가 비어 다음 프롬프트에 딸려 가지 않는다.
    await ta.fill('두 번째');
    await ta.press('Enter');
    await expect(pane.locator('.agp-msg.agp-user').last()).not.toContainText('[Image #');
  });
  /**
   * M11_SRS FR-M11-31 (M11-B29) — **질문에는 직접 적어 답할 수 있다.**
   *
   * 원본을 쟀다 (§2.10 (9)): TUI 는 자유 입력을 `3. Type something.` 으로 **선택지와
   * 같은 목록**에 둔다. 사용자 결정(2026-09-15)이 그 모양을 골랐다 — 항상 보이는 칸을
   * 두면 라디오를 고른 채 칸에도 적은 상태가 만들어지고, 무엇이 답인지 화면이 말하지
   * 못한다.
   */
  test('V-M11-63: 질문 모달의 마지막 선택지가 직접 입력이다 (FR-M11-31)', async ({ page }) => {
    await waitForInit(page);
    const pane = await openAgentTab(page);
    await send(pane, 'QUESTION please');
    const dlg = page.locator('.ui-modal.agp-modal .ui-modal-box');
    await expect(dlg).toBeVisible({ timeout: 15000 });

    // 선택지 셋 — 에이전트가 준 둘 + **직접 입력**. 목록의 마지막이다.
    const opts = dlg.locator('.agp-q .agp-q-opt');
    await expect(opts).toHaveCount(3);
    await expect(opts.last()).toHaveClass(/agp-q-own/);

    // 고르기 전에는 칸이 없다 — 고르는 손과 적는 손이 하나다.
    const box = dlg.locator('.agp-q-text');
    await expect(box).toBeHidden();
    await opts.last().locator('input').check();
    await expect(box).toBeVisible();

    await box.fill('초록');
    // **계약이 바뀌었다** (FR-M11-45 / V-M11-70): 질문은 하나씩 서고 **확인 화면**을
    // 지나야 제출이 열린다. `다음` 이 그 자리로 넘긴다 — 원본이 마지막에 한 번
    // 묻는 것과 같다.
    await dlg.locator('.agp-q-next').click();
    await dlg.locator('.ui-modal-foot .ui-btn-primary').click();
    await expect(dlg).toBeHidden({ timeout: 10000 });
    // 적은 그대로 간다 — fakeagent 가 받은 답을 그대로 되읊는다.
    await expect(pane.locator('.agp-msg.agp-assistant .agp-body').last())
      .toHaveText('초록', { timeout: 15000 });
  });

  /** 고른 선택지로 답하는 길은 **그대로다** — 더해진 것이 종전을 밀어내지 않았다. */
  test('V-M11-63b: 선택지로 답하는 길은 그대로다 (FR-M11-31)', async ({ page }) => {
    await waitForInit(page);
    const pane = await openAgentTab(page);
    await send(pane, 'QUESTION please');
    const dlg = page.locator('.ui-modal.agp-modal .ui-modal-box');
    await expect(dlg).toBeVisible({ timeout: 15000 });
    await dlg.locator('.agp-q input[value="Blue"]').check();
    // **계약이 바뀌었다** (FR-M11-45 / V-M11-70): 질문은 하나씩 서고 **확인 화면**을
    // 지나야 제출이 열린다. `다음` 이 그 자리로 넘긴다 — 원본이 마지막에 한 번
    // 묻는 것과 같다.
    await dlg.locator('.agp-q-next').click();
    await dlg.locator('.ui-modal-foot .ui-btn-primary').click();
    await expect(pane.locator('.agp-msg.agp-assistant .agp-body').last())
      .toHaveText('Blue', { timeout: 15000 });
  });
  /**
   * M11_SRS FR-M11-14 (M11-B11) — **`/model` 은 고르는 화면을 연다.**
   *
   * 접수: *"여전히 /model, /config 같은 tui 들은 사용이 불가"*. **막힌 것은 명령이
   * 아니다** (실측 §2.11 (5)) — 둘 다 정상 응답하고 `init` 의 TUI 전용 목록에도 없다.
   * 막힌 것은 고를 자리이며, 원본 TUI 가 그 자리에서 여는 것이 선택 화면이다.
   */
  test('V-M11-65: 인자 없는 /model 이 고르는 화면을 연다 (FR-M11-14)', async ({ page }) => {
    await waitForInit(page);
    const pane = await openAgentTab(page);
    // 모델 목록은 `initialize` 가 준다 — 한 턴을 돌려 그것이 앉기를 기다린다.
    await send(pane, 'PONG');
    await expect(pane).toHaveAttribute('data-state', 'done', { timeout: 15000 });
    await expect(pane.locator('.agp-model')).toContainText('fake-model-1', { timeout: 15000 });

    await send(pane, '/model');
    const dlg = page.locator('.ui-modal.agp-pick-modal .ui-modal-box');
    await expect(dlg).toBeVisible({ timeout: 10000 });
    // **계약이 바뀌었다** (M12_SRS FR-M12-14): 고르는 화면의 항목은 질문 모달의
    // `.agp-q-opt` 와 다른 자리다 — 이름과 설명이 두 줄로 서는 `.agp-pick-opt` 다.
    await expect(dlg.locator('.agp-pick-opt')).toHaveCount(2);

    // **명령이 대화로 나가지 않았다** — 고르는 화면이 그 자리를 대신한다.
    const said = (await pane.locator('.agp-msg.agp-user').allTextContents()).join('|');
    expect(said, `명령이 그대로 나갔다: ${said}`).not.toContain('/model');

    await dlg.locator('.agp-pick-opt input[value="fast"]').check();
    // 고르는 화면에는 **마법사가 없다** — 질문이 아니라 값 하나를 고르는 자리다
    // (FR-M11-45 는 질문 모달의 것이다).

    /**
     * **계약이 바뀌었다** (M12_SRS FR-M12-4 / 누수 L7, 2026-09-16).
     *
     *   이전 동작: 고른 값이 `/model <name>` 이라는 **프롬프트 문자열**로 나갔다.
     *              같은 일을 하는 메뉴는 `control('set_model')` 로 나갔다 — 한 일에
     *              손이 둘이고, codex 처럼 슬래시 명령이 없는 에이전트에서는
     *              앞쪽이 그냥 프롬프트로 샌다
     *   새  동작: 어댑터의 선언(`cmd.form.control`)을 따라 **제어로** 간다
     *   이유:     *"두 자리가 다른 문장으로 답하면 그 차이가 곧 결함이다"*
     *
     * **나가는 요청을 잰다** (M11 §3 의 교훈): 화면에는 아무것도 서지 않는 것이
     * 새 계약이므로, 화면으로는 *고쳐졌다* 와 *아무 일도 안 일어났다* 를 가를 수 없다.
     */
    const ctl = page.waitForRequest((r) =>
      r.url().includes('/api/agent/control') && r.method() === 'POST', { timeout: 10000 });
    await dlg.locator('.ui-modal-foot .ui-btn-primary').click();
    const req = await ctl;
    expect(JSON.parse(req.postData() || '{}')).toMatchObject({ kind: 'set_model', value: 'fast' });

    // 그리고 **대화에는 아무것도 남지 않는다** — 명령을 보내지 않았으므로.
    const after = (await pane.locator('.agp-msg.agp-user').allTextContents()).join('|');
    expect(after, `제어로 갔는데 대화에도 남았다: ${after}`).not.toContain('/model');
    // 머리의 모델이 고른 값으로 갈린다 — 제어가 실제로 닿았다는 증거다.
    await expect(pane.locator('.agp-model')).toContainText('fast', { timeout: 15000 });
  });

  /**
   * M12_SRS V-M12-29 (FR-M12-14) — **고르는 화면은 읽히고, 엔터로 끝난다.**
   *
   * 접수: *"선택 모달 좀 가시성이 안좋은거같아. 가독성 높게 디자인하고 줄바꿈도 하고
   * 엔터도 치고 해줘."*
   *
   * 재는 것 둘: 설명이 **보이는가**(종전에는 `title` 이라 가리켜야 했다), 그리고
   * **엔터로 확정되는가**(종전에는 마우스가 반드시 필요했다).
   */
  test('V-M12-29: 고르는 화면이 설명을 보이고 엔터로 확정된다 (FR-M12-14)', async ({ page }) => {
    await waitForInit(page);
    const pane = await openAgentTab(page);
    await send(pane, 'PONG');
    await expect(pane).toHaveAttribute('data-state', 'done', { timeout: 15000 });
    await expect(pane.locator('.agp-model')).toContainText('fake-model-1', { timeout: 15000 });

    await send(pane, '/model');
    const dlg = page.locator('.ui-modal.agp-pick-modal .ui-modal-box');
    await expect(dlg).toBeVisible({ timeout: 10000 });
    // 설명이 **보인다** — `title` 이 아니라 글로 선다.
    await expect(dlg.locator('.agp-pick-desc').first()).toBeVisible();
    await expect(dlg.locator('.agp-pick-desc').first()).toHaveText(/fake/);
    // 고른 것이 **테두리로** 갈린다 — 라디오 점 하나보다 멀리서 읽힌다.
    await expect(dlg.locator('.agp-pick-opt[data-on="1"]')).toHaveCount(1);

    // 엔터가 확정이다 — 마우스 없이 끝난다.
    const ctl = page.waitForRequest((r) =>
      r.url().includes('/api/agent/control') && r.method() === 'POST', { timeout: 10000 });
    await dlg.locator('.agp-pick-opt input[value="fast"]').check();
    await dlg.locator('.agp-pick-opt input[value="fast"]').press('Enter');
    const req = await ctl;
    expect(JSON.parse(req.postData() || '{}')).toMatchObject({ kind: 'set_model', value: 'fast' });
    await expect(page.locator('.ui-modal.agp-pick-modal')).toBeHidden({ timeout: 10000 });
    expect(await axeViolations(page)).toEqual([]);
  });

  /** 인자가 있으면 **가로채지 않는다** — 사용자가 이미 고른 것이다 (FR-M11-14). */
  test('V-M11-65b: 인자가 있는 /model 은 그대로 나간다 (FR-M11-14)', async ({ page }) => {
    await waitForInit(page);
    const pane = await openAgentTab(page);
    await send(pane, '/model fast');
    await expect(pane.locator('.agp-msg.agp-user').last()).toContainText('/model fast', { timeout: 15000 });
    await expect(page.locator('.ui-modal.agp-pick-modal')).toHaveCount(0);
  });

  /**
   * FR-M11-14: `/config` 의 키·선택지는 **응답이 준다** — 우리가 목록을 지어내지 않는다.
   * 응답 한 줄이 `key=a|b|c` 이며 파싱은 결정적이다 (실측 §2.11 (5)).
   */
  test('V-M11-66: /config 응답이 폼이 된다 (FR-M11-14)', async ({ page }) => {
    await waitForInit(page);
    const pane = await openAgentTab(page);
    await send(pane, '/config');

    const dlg = page.locator('.ui-modal.agp-cfg-modal .ui-modal-box');
    await expect(dlg).toBeVisible({ timeout: 15000 });
    // fakeagent 가 내는 목록 셋 (autoCompact · editor · theme).
    await expect(dlg.locator('.agp-cfg-row')).toHaveCount(3);
    await expect(dlg.locator('.agp-cfg-key').first()).toHaveText('autoCompact');

    await dlg.locator('.agp-cfg-row', { hasText: 'editor' }).locator('select').selectOption('vim');
    await dlg.locator('.ui-modal-foot .ui-btn-primary').click();
    await expect(pane.locator('.agp-msg.agp-user').last()).toContainText('/config editor=vim', { timeout: 15000 });
  });

  /**
   * FR-M11-14: **고른 것이 여럿이면 여럿이 나간다.** 사용법이 `key=value [key=value ...]`
   * 이므로 폼도 여럿을 세우는데, 한 자리만 기억하면 **마지막에 만진 것만** 나간다 —
   * 그것은 폼이 셋을 보이면서 하나만 보내는 거짓이다. 되돌린 키가 옆 자리를 함께
   * 지우지 않는지도 같은 자리에서 잰다.
   */
  test('V-M11-66c: 여러 키를 고르면 전부 나가고, 되돌린 것만 빠진다 (FR-M11-14)', async ({ page }) => {
    await waitForInit(page);
    const pane = await openAgentTab(page);
    await send(pane, '/config');
    const dlg = page.locator('.ui-modal.agp-cfg-modal .ui-modal-box');
    await expect(dlg).toBeVisible({ timeout: 15000 });

    await dlg.locator('.agp-cfg-row', { hasText: 'editor' }).locator('select').selectOption('vim');
    await dlg.locator('.agp-cfg-row', { hasText: 'theme' }).locator('select').selectOption('dark');
    // 셋째를 골랐다가 **되돌린다** — 이 키만 빠져야 한다.
    const auto = dlg.locator('.agp-cfg-row', { hasText: 'autoCompact' }).locator('select');
    await auto.selectOption('true');
    await auto.selectOption('');

    await dlg.locator('.ui-modal-foot .ui-btn-primary').click();
    const sent = pane.locator('.agp-msg.agp-user').last();
    await expect(sent).toContainText('editor=vim', { timeout: 15000 });
    await expect(sent, '둘째 선택이 사라졌다').toContainText('theme=dark');
    await expect(sent, '되돌린 키가 나갔다').not.toContainText('autoCompact');
  });

  /** 응답이 그 모양이 아니면 **열지 않는다** — 텍스트가 그대로 선다 (FR-M11-14). */
  test('V-M11-66b: 목록이 아닌 응답에는 폼을 열지 않는다 (FR-M11-14)', async ({ page }) => {
    await waitForInit(page);
    const pane = await openAgentTab(page);
    // `/clear` 는 목록을 주지 않는다 — 같은 슬래시 경로인데 폼이 서면 안 된다.
    await send(pane, '/clear');
    await expect(pane).toHaveAttribute('data-state', 'done', { timeout: 15000 });
    await expect(page.locator('.ui-modal.agp-cfg-modal')).toHaveCount(0);
  });
  /**
   * M11_SRS FR-M11-29 + FR-M11-14 — **고르는 화면도 큐를 지난다.**
   *
   * `send()` 만 큐를 보면 턴 중에 고른 값이 곧바로 나가고, 그것은 접수한 증상
   * (*"추론중에 입력하면 그대로 입력된다"*)이 **한 경로에만 남는 것**이다. 보내는 문이
   * 하나여야 한다는 요구가 여기서 재어진다.
   */
  test('V-M11-67: 턴 중에 고른 /config 값도 큐에 쌓인다 (FR-M11-29 · FR-M11-14)', async ({ page }) => {
    await waitForInit(page);
    const pane = await openAgentTab(page);
    await send(pane, 'SLOW');
    await expect(pane).toHaveAttribute('data-state', 'working', { timeout: 15000 });

    // 턴 중에 `/config` 를 친다 — 명령 자체가 큐에 쌓인다.
    await send(pane, '/config');
    await expect(pane.locator('.agp-queue .agp-queue-item')).toHaveCount(1);
    const said = (await pane.locator('.agp-msg.agp-user').allTextContents()).join('|');
    expect(said, `고르는 명령이 큐를 건너뛰었다: ${said}`).not.toContain('/config');
  });

  /**
   * M11_SRS FR-M11-30 — **본문이 가리키는 첨부만 간다.**
   *
   * 표식(`[Image #n]`)을 지우는 것이 붙인 것을 무르는 손이다. 남겨 두면 화면이 말하지
   * 않는 바이트가 실리고, 보낸 뒤 비우지 않으면 다음 프롬프트에 **몰래** 실린다.
   */
  test('V-M11-62b: 표식을 지우면 첨부도 가지 않는다 (FR-M11-30)', async ({ page }) => {
    await waitForInit(page);
    const pane = await openAgentTab(page);
    const ta = pane.locator('.agp-ta');
    await ta.click();

    const paste = async () => page.evaluate(() => {
      const png = 'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAIAQMAAAD+wSzIAAAABlBMVEX///+/v7+jQ3Y5AAAADklEQVQI12P4AIX8EAgALgAD/aNpbtEAAAAASUVORK5CYII=';
      const bin = atob(png);
      const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      const dt = new DataTransfer();
      dt.items.add(new File([arr], 'x.png', { type: 'image/png' }));
      const el = document.querySelector('.agent-pane .agp-ta') as HTMLTextAreaElement;
      el.focus();
      el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    });

    // **나가는 요청을 잰다.** 화면으로는 가를 수 없다 — 본문 글자는 첨부가 실리든
    // 말든 같고, 그래서 무력화 프로브가 화면 단언을 그대로 통과했다.
    const bodies: any[] = [];
    page.on('request', (r) => {
      if (!r.url().includes('/api/agent/prompt')) return;
      try { bodies.push(JSON.parse(r.postData() || '{}')); } catch { /* 본문 없음 */ }
    });

    await paste();
    await expect(ta).toHaveValue(/\[Image #1\]/, { timeout: 10000 });
    // 표식을 지우고 다른 말을 보낸다 — 첨부는 따라가지 않아야 한다.
    await ta.fill('표식을 지웠다');
    await ta.press('Enter');
    await expect(pane).toHaveAttribute('data-state', 'done', { timeout: 20000 });
    await expect(pane.locator('.agp-msg.agp-user .agp-body').last()).toHaveText('표식을 지웠다');
    expect(bodies.length, '프롬프트가 나가지 않았다').toBeGreaterThan(0);
    expect(bodies[bodies.length - 1].attachments,
      '표식을 지웠는데 바이트가 실렸다 — 화면이 말하지 않는 첨부다').toBeUndefined();

    // 그리고 **다음 프롬프트에도 남지 않는다** — 붙였던 것이 몰래 실리지 않는다.
    await ta.fill('두 번째');
    await ta.press('Enter');
    await expect(pane).toHaveAttribute('data-state', 'done', { timeout: 20000 });
    expect(bodies[bodies.length - 1].attachments,
      '보낸 뒤에도 남아 다음 프롬프트에 몰래 실렸다').toBeUndefined();

    // 표식이 있으면 **실린다** — 거르는 손이 넓어져 전부 버리는 것이 아니다.
    await paste();
    await expect(ta).toHaveValue(/\[Image #1\]/, { timeout: 10000 });
    await ta.press('Enter');
    await expect(pane).toHaveAttribute('data-state', 'done', { timeout: 20000 });
    expect(bodies[bodies.length - 1].attachments, '표식이 있는데 실리지 않았다').toHaveLength(1);
  });
  /**
   * M11_SRS FR-M11-28 + FR-CBG-5 — **재생된 추론에는 시간이 없다.**
   *
   * 시간은 프로토콜이 주지 않고 **우리가 재는** 값이다 (추론 블록의 시작~끝). 그런데
   * 재생은 지난 이벤트를 순식간에 흘리므로 거기서 재면 `0.0초` 가 나오고, 그것은
   * 모름이 아니라 **거짓**이다. 토큰은 프로토콜이 준 값이라 재생에서도 참이므로 남는다.
   */
  test('V-M11-53b: 재생된 추론에는 시간이 없고 토큰은 남는다 (FR-M11-28 · FR-CBG-5)', async ({ page }) => {
    await waitForInit(page);
    const pane = await openAgentTab(page);
    await send(pane, 'THINKTOKENS please');
    await expect(pane).toHaveAttribute('data-state', 'done', { timeout: 15000 });
    // 살아 있는 턴에서는 시간이 적힌다.
    await expect(pane.locator('.agp-think.agp-think-note')).toContainText(/\d+\.\d/, { timeout: 15000 });

    // 새로고침 = 재생. 같은 자리가 다시 그려진다.
    await page.reload();
    await waitForInit(page, { readyFor: { selector: AGENT_PANE_READY } });
    const note = page.locator('#area .pn.focused .agent-pane.vis .agp-think.agp-think-note');
    await expect(note).toBeVisible({ timeout: 15000 });
    const text = (await note.textContent()) || '';
    expect(text, `토큰이 사라졌다: ${text}`).toContain('120');
    expect(text, `재지 못한 시간을 적었다: ${text}`).not.toMatch(/\d+\.\d/);
  });
  /**
   * M11_SRS FR-M11-14 — **기다림은 나가는 순간에 선다.**
   *
   * `/config` 가 **큐에 쌓이면** 그 사이 도는 턴의 말이 먼저 도착한다. 기다림을
   * 명령을 친 자리에서 세우면 그 말을 `/config` 의 답으로 읽고 **엉뚱한 폼**이 서거나,
   * 진짜 답이 왔을 때 아무것도 열리지 않는다.
   */
  test('V-M11-68: 큐에 쌓인 /config 는 남의 답을 가로채지 않는다 (FR-M11-14 · FR-M11-29)', async ({ page }) => {
    await waitForInit(page);
    const pane = await openAgentTab(page);
    await send(pane, 'SLOW');
    await expect(pane).toHaveAttribute('data-state', 'working', { timeout: 15000 });

    await send(pane, '/config');
    await expect(pane.locator('.agp-queue .agp-queue-item')).toHaveCount(1);

    // 도는 턴이 스스로 끝나면 그 말이 먼저 온다 — 그것으로 폼이 서면 안 된다.
    // 그 다음 큐의 `/config` 가 나가고, **그때** 진짜 목록으로 폼이 선다.
    const dlg = page.locator('.ui-modal.agp-cfg-modal .ui-modal-box');
    await expect(dlg).toBeVisible({ timeout: 40000 });
    await expect(dlg.locator('.agp-cfg-row')).toHaveCount(3);
    await expect(dlg.locator('.agp-cfg-key').first()).toHaveText('autoCompact');
  });
  /**
   * M11_SRS FR-M11-29 + FR-M11-30 — **큐에서 꺼내면 첨부도 함께 돌아온다.**
   *
   * 글만 돌려주면 다시 보낼 때 그림이 빠지고, 남아 있던 것 **뒤에 이어 붙이면** 꺼낸
   * 글의 `[Image #1]` 이 다른 그림을 가리킨다. 갈아 끼우는 것이 그 때문이다.
   */
  test('V-M11-58b: 큐에서 꺼낸 첨부가 그 글과 함께 다시 나간다 (FR-M11-29 · FR-M11-30)', async ({ page }) => {
    await waitForInit(page);
    const pane = await openAgentTab(page);
    const ta = pane.locator('.agp-ta');
    const bodies: any[] = [];
    page.on('request', (r) => {
      if (!r.url().includes('/api/agent/prompt')) return;
      try { bodies.push(JSON.parse(r.postData() || '{}')); } catch { /* 본문 없음 */ }
    });

    await send(pane, 'SLOW');
    await expect(pane).toHaveAttribute('data-state', 'working', { timeout: 15000 });

    // 턴 중에 이미지를 붙여 보낸다 — 큐에 쌓인다.
    await ta.click();
    await page.evaluate(() => {
      const png = 'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAIAQMAAAD+wSzIAAAABlBMVEX///+/v7+jQ3Y5AAAADklEQVQI12P4AIX8EAgALgAD/aNpbtEAAAAASUVORK5CYII=';
      const bin = atob(png);
      const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      const dt = new DataTransfer();
      dt.items.add(new File([arr], 'x.png', { type: 'image/png' }));
      const el = document.querySelector('.agent-pane .agp-ta') as HTMLTextAreaElement;
      el.focus();
      el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    });
    await expect(ta).toHaveValue(/\[Image #1\]/, { timeout: 10000 });
    await ta.press('Enter');
    await expect(pane.locator('.agp-queue .agp-queue-item')).toHaveCount(1);

    // 위 화살표로 꺼내고 그대로 다시 보낸다 — 그림이 따라와야 한다.
    await ta.click();
    await ta.press('ArrowUp');
    await expect(ta).toHaveValue(/\[Image #1\]/);
    await ta.press('Enter');

    await expect.poll(() => bodies.filter((b) => b.attachments).length, { timeout: 30000 })
      .toBeGreaterThan(0);
    const withAtt = bodies.filter((b) => b.attachments).pop();
    expect(withAtt.text, `꺼낸 글이 아니다: ${withAtt.text}`).toContain('[Image #1]');
    expect(withAtt.attachments, '첨부가 따라오지 않았다').toHaveLength(1);
  });
  /**
   * M11_SRS FR-M11-49 (M11-B49) — **서브에이전트의 것은 부모 카드 안에 산다.**
   *
   * 실측(§2.13): 서브에이전트의 진행은 **같은 스트림**으로 오고 `parent_tool_use_id`
   * 만이 그것을 가른다. 버리면 서브에이전트가 **받은 프롬프트**가 사용자가 친 말로,
   * 그 도구가 부모의 도구로 선다 — `FR-M11-25` 와 같은 부류다.
   */
  test('V-M11-71: 서브에이전트의 진행이 부모 카드 안에 모인다 (FR-M11-49)', async ({ page }) => {
    await waitForInit(page);
    const pane = await openAgentTab(page);
    await send(pane, 'SUBAGENT please');
    await expect(pane).toHaveAttribute('data-state', 'done', { timeout: 20000 });

    // 부모 도구 카드 안에 자기 자리가 선다.
    const sub = pane.locator('.agp-tool .agp-sub');
    await expect(sub).toHaveCount(1, { timeout: 15000 });
    await expect(sub.locator('.agp-sub-prompt')).toHaveText('SUBPROMPT');
    await expect(sub.locator('.agp-sub-tool')).toContainText('Bash');

    // **본 대화에 섞이지 않았다** — 이것이 요점이다.
    const said = (await pane.locator('.agp-msg.agp-user .agp-body').allTextContents()).join('|');
    expect(said, `서브에이전트의 프롬프트가 사용자의 말로 섰다: ${said}`).not.toContain('SUBPROMPT');
    // 부모의 도구 카드는 **하나**다 — 자식의 도구가 본 대화의 카드가 되지 않았다.
    await expect(pane.locator('.agp-tool')).toHaveCount(1);
    // 부모의 말은 부모의 자리에 그대로 선다.
    await expect(pane.locator('.agp-msg.agp-assistant .agp-body').last()).toContainText('PARENTDONE');
  });

  /**
   * FR-M11-50 (M11-B50) — **백그라운드는 머리에서 말한다.**
   *
   * 실측(§2.13): `run_in_background` 는 평범한 도구 호출이고 프로토콜이 진행을 따로
   * 알려 주지 않는다. 우리가 아는 것은 **입력이 스스로 말하는 사실** 하나다.
   */
  test('V-M11-72: 백그라운드 도구가 머리에서 그 사실을 말한다 (FR-M11-50)', async ({ page }) => {
    await waitForInit(page);
    const pane = await openAgentTab(page);
    await send(pane, 'BGTOOL please');
    await expect(pane).toHaveAttribute('data-state', 'done', { timeout: 20000 });
    const head = pane.locator('.agp-tool .agp-tool-head').first();
    await expect(head).toContainText('백그라운드', { timeout: 15000 });

    // 백그라운드가 **아닌** 도구에는 붙지 않는다 — 지어내지 않는다.
    const pane2 = pane;
    await send(pane2, 'SPLIT please');
    await expect(pane2).toHaveAttribute('data-state', 'done', { timeout: 20000 });
    const heads = await pane2.locator('.agp-tool .agp-tool-head').allTextContents();
    expect(heads.filter((h) => h.includes('백그라운드')).length,
      `백그라운드가 아닌 도구에 표시가 붙었다: ${heads.join(' | ')}`).toBe(1);
  });

  /**
   * M11_SRS FR-M11-48 (M11-B51) — **`/글자` 는 검색이고 키로 고른다.**
   */
  test('V-M11-73: 슬래시 목록이 검색되고 방향키로 골라진다 (FR-M11-48)', async ({ page }) => {
    await waitForInit(page);
    const pane = await openAgentTab(page);
    await send(pane, 'PONG');
    await expect(pane).toHaveAttribute('data-state', 'done', { timeout: 15000 });

    const ta = pane.locator('.agp-ta');
    const sugg = pane.locator('.agp-sugg');
    await ta.click();
    await ta.fill('/mod');
    await expect(sugg).toBeVisible({ timeout: 10000 });
    const items = sugg.locator('.agp-sugg-item');
    await expect(items.first()).toContainText('/model');
    // 설명이 **보인다** — `title` 은 가리켜야 나온다.
    await expect(items.first().locator('.agp-sugg-desc')).toHaveText(/./);
    // 첫 항목이 현재다.
    await expect(items.first()).toHaveAttribute('data-cur', '1');

    // **부분 일치**로도 찾는다 — 접두만이면 이 글자로는 아무것도 서지 않는다.
    await ta.fill('/ode');
    await expect(sugg).toBeVisible({ timeout: 10000 });
    await expect(sugg.locator('.agp-sugg-item').first()).toContainText('/model');

    // 방향키로 고르고 엔터로 넣는다 — 엔터가 프롬프트를 보내지 않는다.
    await ta.fill('/');
    await expect(sugg).toBeVisible({ timeout: 10000 });
    const n = await sugg.locator('.agp-sugg-item').count();
    expect(n).toBeGreaterThan(1);
    await ta.press('ArrowDown');
    await expect(sugg.locator('.agp-sugg-item').nth(1)).toHaveAttribute('data-cur', '1');
    const want = (await sugg.locator('.agp-sugg-item').nth(1).locator('.agp-sugg-name').textContent()) || '';
    await ta.press('Enter');
    await expect(ta).toHaveValue(new RegExp('^' + want.replace(/[/\\]/g, '\\$&')));
    await expect(sugg).toBeHidden();
  });
  /** FR-M11-38 (M11-B37): **편집의 diff 는 펼친 채** 선다 — 그 턴이 한 일 자체다. */
  test('V-M11-70: 편집 카드는 펼친 채 서고 다른 도구는 접힌다 (FR-M11-38)', async ({ page }) => {
    await waitForInit(page);
    const pane = await openAgentTab(page);
    await send(pane, 'EDITDIFF please');
    await expect(pane).toHaveAttribute('data-state', 'done', { timeout: 20000 });
    const card = pane.locator('.agp-tool').first();
    await expect(card).toHaveAttribute('open', '', { timeout: 15000 });
    await expect(card.locator('.agp-diff')).toBeVisible();

    // **편집이 아닌 도구는 그대로 접힌다** — 긴 출력까지 펼치면 접기가 푼 문제가 돌아온다.
    await send(pane, 'SPLIT please');
    await expect(pane).toHaveAttribute('data-state', 'done', { timeout: 20000 });
    await expect(pane.locator('.agp-tool').last()).not.toHaveAttribute('open', /.*/);
  });

  /** FR-M11-39 (M11-B38·B39): 보내면 바닥으로 · 바닥이 아닐 때만 서는 버튼. */
  test('V-M11-74: 보내면 바닥으로 가고 되돌아갈 버튼이 선다 (FR-M11-39)', async ({ page }) => {
    await waitForInit(page);
    const pane = await openAgentTab(page);
    const log = pane.locator('.agp-log');
    for (let i = 0; i < 6; i++) {
      await send(pane, `say PONG ${i}`);
      await expect(pane).toHaveAttribute('data-state', 'done', { timeout: 15000 });
    }
    const room = await log.evaluate((n) => n.scrollHeight - n.clientHeight);
    expect(room, '대화가 스크롤될 만큼 길지 않다').toBeGreaterThan(40);

    // 중간으로 올리면 되돌아갈 버튼이 선다.
    await log.evaluate((n, y) => { n.scrollTop = y; }, Math.floor(room / 2));
    const btn = pane.locator('.agp-to-bottom');
    await expect(btn).toBeVisible({ timeout: 5000 });

    // 누르면 바닥이고 버튼은 물러난다.
    await btn.click();
    await expect.poll(() => log.evaluate((n) => n.scrollHeight - n.scrollTop - n.clientHeight),
      { timeout: 5000 }).toBeLessThanOrEqual(4);
    await expect(btn).toBeHidden();

    // **엔터로 보내면 따라간다** — 읽던 자리에 머물면 내 말이 안 보인다.
    await log.evaluate((n, y) => { n.scrollTop = y; }, Math.floor(room / 2));
    await expect(btn).toBeVisible();
    await send(pane, 'say PONG last');
    await expect.poll(() => log.evaluate((n) => n.scrollHeight - n.scrollTop - n.clientHeight),
      { timeout: 10000 }).toBeLessThanOrEqual(4);
  });

  /** FR-M11-40 (M11-B40): 고르는 화면이 서면 **내 말도 답도** 대화에 남지 않는다. */
  test('V-M11-75: /config 는 고르는 화면만 남긴다 (FR-M11-40)', async ({ page }) => {
    await waitForInit(page);
    const pane = await openAgentTab(page);
    await send(pane, '/config');
    const dlg = page.locator('.ui-modal.agp-cfg-modal .ui-modal-box');
    await expect(dlg).toBeVisible({ timeout: 15000 });

    const all = (await pane.locator('.agp-log').textContent()) || '';
    expect(all, `내 말이 남았다: ${all.slice(0, 200)}`).not.toContain('/config');
    expect(all, `사용법 텍스트가 남았다: ${all.slice(0, 200)}`).not.toContain('key=value');
  });

  /** FR-M11-42 (M11-B42·B47): `Esc` 는 **패널에 포커스가 있으면** 걸린다. */
  test('V-M11-76: 대화를 클릭한 뒤에도 Esc 가 턴을 끊는다 (FR-M11-42)', async ({ page }) => {
    await waitForInit(page);
    const pane = await openAgentTab(page);
    await send(pane, 'SLOW');
    await expect(pane).toHaveAttribute('data-state', 'working', { timeout: 15000 });

    // **포커스를 입력창 밖으로** 옮긴다 — 접수한 그 자리다.
    await pane.locator('.agp-log').click({ position: { x: 5, y: 5 } });
    await page.keyboard.press('Escape');
    await expect(pane.locator('.agp-line.agp-err')).toBeVisible({ timeout: 15000 });
    await expect(pane).toHaveAttribute('data-state', 'done');
  });

  /** FR-M11-41 (M11-B41): 모달을 닫으면 **거절 후 끊기** — 무한 대기가 남지 않는다. */
  test('V-M11-77: 모달을 닫으면 요청이 닫히고 턴이 끊긴다 (FR-M11-41)', async ({ page }) => {
    await waitForInit(page);
    const pane = await openAgentTab(page);
    await send(pane, 'please APPROVE this');
    const dlg = page.locator('.ui-modal.agp-modal .ui-modal-box');
    await expect(dlg).toBeVisible({ timeout: 15000 });
    await expect(pane.locator('.agp-open')).toContainText('1');

    await page.keyboard.press('Escape');
    // 열린 요청이 **닫힌다** — interrupt 만으로는 남는다 (§2.12 의 실측 ④).
    await expect(pane.locator('.agp-open')).toContainText('0', { timeout: 15000 });
    await expect(pane).toHaveAttribute('data-state', 'done', { timeout: 15000 });
  });

  /** FR-M11-47 (M11-B48): 대화를 열면 **바로 칠 수 있다**. */
  test('V-M11-78: 에이전트 탭을 열면 입력창이 포커스를 받는다 (FR-M11-47)', async ({ page }) => {
    await waitForInit(page);
    const pane = await openAgentTab(page);
    await expect.poll(() => page.evaluate(() =>
      !!(document.activeElement && document.activeElement.classList.contains('agp-ta'))),
      { timeout: 10000 }).toBe(true);
    // 그대로 칠 수 있다 — 한 번 더 누를 필요가 없다.
    await page.keyboard.type('바로 친다');
    await expect(pane.locator('.agp-ta')).toHaveValue('바로 친다');
  });

  /** FR-M11-46 (M11-B46): 하단은 **읽히는 크기와 갈리는 색**이다. */
  test('V-M11-79: 하단 글꼴이 줄고 색이 갈린다 (FR-M11-46)', async ({ page }) => {
    await waitForInit(page);
    const pane = await openAgentTab(page);
    const dash = pane.locator('.agp-dash');
    await expect(dash).toBeVisible({ timeout: 15000 });
    const px = await dash.evaluate((n) => parseFloat(getComputedStyle(n).fontSize));
    // 9(이전)와 14(직전) **사이**다 — 사용자가 지정한 범위.
    expect(px, `하단 글꼴이 범위 밖이다: ${px}`).toBeGreaterThan(9);
    expect(px, `하단 글꼴이 범위 밖이다: ${px}`).toBeLessThan(14);

    // 색이 **한 벌이 아니다** — 성질로 갈린다.
    const colors = await pane.evaluate(() => {
      const q = (sel: string) => {
        const el = document.querySelector('.agent-pane.vis ' + sel);
        return el ? getComputedStyle(el).color : '';
      };
      return { model: q('.agp-model'), ctx: q('.agp-ctx'), lim: q('.agp-limits'), cwd: q('.agp-cwd') };
    });
    const uniq = new Set(Object.values(colors).filter(Boolean));
    expect(uniq.size, `하단 색이 한 벌이다: ${JSON.stringify(colors)}`).toBeGreaterThan(2);
  });
  /**
   * M11_SRS FR-M11-51 (M11-B52) — **도는 중이면 화면이 움직인다.**
   *
   * 접수: *"idel, waiting 이 아니고 뭔가를 하고있을 떄 tui 에서는 애니메이션이 있잖아"*.
   * 원본은 `✢ Tinkering… 60` 으로 스피너·경과를 함께 돌린다 (§2.10 (4)).
   *
   * **`waiting` 에는 붙지 않는 것이 요점이다** — 그때는 사람을 기다리는 것이라 움직이면
   * 거짓이 된다. 접수가 그 둘을 이름으로 갈랐다.
   */
  test('V-M11-80: 도는 중에만 움직이고 경과가 보인다 (FR-M11-51)', async ({ page }) => {
    await waitForInit(page);
    const pane = await openAgentTab(page);
    const st = pane.locator('.agp-state');

    await send(pane, 'SLOW');
    await expect(pane).toHaveAttribute('data-state', 'working', { timeout: 15000 });
    // 경과가 적힌다 — 멈춘 글자가 아니다.
    await expect(st).toHaveText(/\d/, { timeout: 10000 });
    // 그리고 실제로 **움직인다** (CSS 애니메이션이 붙는다).
    const anim = await st.evaluate((n) => getComputedStyle(n, '::before').animationName);
    expect(anim, `도는 중인데 움직이지 않는다: ${anim}`).not.toBe('none');
    // 경과가 **늘어난다** — 한 번 적고 마는 것이 아니다.
    const first = (await st.textContent()) || '';
    await expect.poll(async () => (await st.textContent()) || '', { timeout: 15000 })
      .not.toBe(first);

    await pane.locator('.agp-ta').press('Escape');
    await expect(pane).toHaveAttribute('data-state', 'done', { timeout: 15000 });
    // 멈추면 움직임도 멎는다.
    const after = await st.evaluate((n) => getComputedStyle(n, '::before').animationName);
    expect(after, `끝났는데 계속 움직인다: ${after}`).toBe('none');
  });

  /** `waiting` 은 **사람을 기다리는** 것이다 — 움직이면 거짓이 된다 (FR-M11-51). */
  test('V-M11-80b: 승인을 기다릴 때는 움직이지 않는다 (FR-M11-51)', async ({ page }) => {
    await waitForInit(page);
    const pane = await openAgentTab(page);
    await send(pane, 'please APPROVE this');
    await expect(page.locator('.ui-modal.agp-modal .ui-modal-box')).toBeVisible({ timeout: 15000 });
    await expect(pane).toHaveAttribute('data-state', 'waiting');
    const anim = await pane.locator('.agp-state')
      .evaluate((n) => getComputedStyle(n, '::before').animationName);
    expect(anim, `기다리는 중인데 움직인다: ${anim}`).toBe('none');
  });

  /** 턴이 끝나면 **얼마였는지** 남는다 — 원본의 `Brewed for 14s` 자리다 (FR-M11-51). */
  test('V-M11-80c: 턴이 끝나면 걸린 시간이 남는다 (FR-M11-51)', async ({ page }) => {
    await waitForInit(page);
    const pane = await openAgentTab(page);
    await send(pane, 'say PONG');
    await expect(pane).toHaveAttribute('data-state', 'done', { timeout: 15000 });
    await expect(pane.locator('.agp-took').last()).toHaveText(/\d/, { timeout: 10000 });
  });
});

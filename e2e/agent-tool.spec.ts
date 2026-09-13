import AxeBuilder from '@axe-core/playwright';
import { Page } from '@playwright/test';

import { test, expect, waitForInit, waitSettled } from './fixtures';

/**
 * M8_UNIFIED_SRS 묶음 T — 에이전트 도구의 브라우저 몫 (V-2·V-3·V-5·V-6·V-10·V-12,
 * FR-AGT-1·4·4a·5·7·9·10·12). 에이전트는 가짜다 (`global-setup` 이 `DONGMINAL_AGENT_BIN_DIR`
 * 에 놓는다, D-C-7·9) — 시나리오는 프롬프트 본문이 고른다.
 *
 * 어댑터 id `claude` 는 등록부의 것이다. e2e 는 Go 를 읽지 못하므로 여기 적는다.
 */
const AGENT = 'claude';
const MENU_ITEM = `.ui-menu .ui-menu-item[data-id="agent:${AGENT}"]`;
// 새로고침 뒤의 준비 판정 — `waitForInit` 의 기본은 포커스 칸의 xterm 이고, 활성 탭이
// 에이전트 탭이면 그것은 서지 않는다 (InitOpts.readyFor).
const AGENT_PANE_READY = '#area .pn.focused .agent-pane.vis';

async function openAgentTab(page: Page) {
  const before = await page.locator('#area .pn.focused .pn-tab').count();
  await page.locator('#area .pn.focused .pn-tab-add').click({ button: 'right' });
  await expect(page.locator(MENU_ITEM)).toBeVisible({ timeout: 10000 });
  const [resp] = await Promise.all([
    page.waitForResponse((r) => r.url().includes('/api/tools?kind=agent') && r.request().method() === 'POST'),
    page.locator(MENU_ITEM).click(),
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
    const sid = await pane.getAttribute('data-sessionid');
    expect(sid).toBeTruthy();
    const tab = page.locator('#area .pn.focused .pn-tab.active');
    const before = await page.locator('#area .pn.focused .pn-tab').count();
    await tab.click({ button: 'right' });
    await expect(page.locator('.ui-menu .ui-menu-item[data-id="agent-tui"]')).toBeVisible();
    await page.locator('.ui-menu .ui-menu-item[data-id="agent-tui"]').click();
    await expect(page.locator('#area .pn.focused .pn-tab')).toHaveCount(before + 1, { timeout: 10000 });
    // 새 터미널 탭에 `--resume <sid>` 가 타이핑됐다.
    await expect(page.locator('#area .pn.focused .tp.vis')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('#area .pn.focused .tp.vis .xterm-rows')).toContainText('--resume ' + sid, { timeout: 15000 });
  });

  test('TC-AGT-7: 프로세스가 죽으면 종료 상태로 보이고 입력이 막힌다 (V-8 P3 몫)', async ({ page }) => {
    await waitForInit(page);
    const pane = await openAgentTab(page);
    await send(pane, 'DIE');
    await expect(pane).toHaveAttribute('data-state', 'ended', { timeout: 15000 });
    await expect(pane.locator('.agp-line.agp-exit')).toBeVisible();
    await expect(pane.locator('.agp-ta')).toBeDisabled();
    // 탭은 닫힌다 — 같은 닫기 길 (FR-AGT-7).
    const before = await page.locator('#area .pn.focused .pn-tab').count();
    await page.locator('#area .pn.focused .pn-tab.active .pn-tab-x').click();
    await expect(page.locator('#area .pn.focused .pn-tab')).toHaveCount(before - 1, { timeout: 10000 });
  });
});

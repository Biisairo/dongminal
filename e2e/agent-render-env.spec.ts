import { test, expect, waitForInit } from './fixtures';

/**
 * 에이전트가 화면을 망가뜨리지 않게 띄운다 (AGENT_RENDER_ENV_SRS · V-ARE-5).
 *
 * Claude Code 는 터미널 폭이 바뀌면 옛 프레임을 스크롤백에 남긴다. 그 잔재를
 * 터미널 쪽에서 되살릴 수 없다는 것이 조사로 확정됐고(`M11_SRS` §2.4e·2.4f),
 * 앱의 fullscreen 렌더링이 유일한 해법이다. 이 스위치가 그것을 켜 준다.
 *
 * 여기서 재는 것은 **스위치가 서고 그 값이 서버에 남는가** 다. 값이 환경으로
 * 옮는 일은 Go 가 잰다 (V-ARE-1~3) — 그쪽이 PTY 없이 결정적으로 재진다.
 */

const settings = async (request: any) =>
  (await (await request.get('/api/settings')).json());

test('V-ARE-5: Settings ▸ Terminal 의 스위치가 기본 켬이고, 끄면 저장된다', async ({ page, request }) => {
  await waitForInit(page);

  await page.click('#settings-btn');
  await page.click('.mtab[data-tab="terminal"]');

  const cb = page.locator('#ds-claudefs');
  await expect(cb).toBeVisible();
  // FR-ARE-3: 기본은 **켬**이다. 설정을 한 번도 저장하지 않은 사용자가 가장
  // 많고, 그들이 이 결함을 겪지 않아야 한다.
  await expect(cb).toBeChecked();

  await cb.uncheck();
  await expect.poll(() => settings(request).then((s: any) => s.claudeFullscreen),
    { timeout: 10000 }).toBe(false);

  // 다시 켜면 그 값도 남는다 — 되돌릴 수 있어야 스위치다.
  await cb.check();
  await expect.poll(() => settings(request).then((s: any) => s.claudeFullscreen),
    { timeout: 10000 }).toBe(true);

  await page.click('#modal-close');
});

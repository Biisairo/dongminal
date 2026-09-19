import { test, expect, waitForInit, waitSettled } from './fixtures';

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

/**
 * V-ARE-9 — 스크롤 속도 (FR-ARE-8·10·11).
 *
 * 값이 환경으로 옮는 일은 Go 가 잰다 (V-ARE-6·7·8). 여기서 재는 것은 **입력란이
 * 서고 그 값이 서버에 남는가** 이며, 위 스위치와 같은 경계다.
 */
test('V-ARE-9: Settings ▸ Terminal 의 스크롤 속도가 기본 3 이고, 바꾸면 남는다',
  async ({ page, request }) => {
    await waitForInit(page);

    await page.click('#settings-btn');
    await page.click('.mtab[data-tab="terminal"]');

    const num = page.locator('#ds-scrollspeed');
    await expect(num).toBeVisible();
    // FR-ARE-9: 기본은 3 이다 — dongminal 은 xterm.js 기반이라 Claude Code 가
    // 스스로 고르는 값과 같고, 그래서 기본값에서 화면이 바뀌지 않는다.
    await expect(num).toHaveValue('3');

    await num.fill('12');
    await num.blur();
    await expect.poll(() => settings(request).then((s: any) => s.claudeScrollSpeed),
      { timeout: 10000 }).toBe(12);

    // 앞 저장의 **왕복이 끝나기를 기다린다.** 설정을 저장하면 방송이 돌아
    // `_settingsRestore` 가 값을 다시 얹는데(app-settings.js — *"방송은 다시
    // 받으라는 신호"*), 그 스냅샷이 다음 입력보다 늦게 닿으면 입력란을 옛 값으로
    // 덮는다. 기존 설정 전반의 성질이며(`tabWidthPx` 도 같다) 사람의 입력
    // 속도에서는 드러나지 않는다 — 연달아 치는 것은 검사뿐이다.
    await waitSettled(page);
    await expect(num).toHaveValue('12');

    // FR-FSS-19 와 같은 손: 범위 밖은 **자른다**. 잘린 사실이 보여야 한다.
    await num.fill('99');
    await num.blur();
    await expect(num).toHaveValue('20');
    await expect.poll(() => settings(request).then((s: any) => s.claudeScrollSpeed),
      { timeout: 10000 }).toBe(20);

    await page.click('#modal-close');

    // 새로고침 뒤에도 남는다 — 기기를 옮겨도 따라와야 하는 값이다.
    await page.reload();
    await waitForInit(page);
    await page.click('#settings-btn');
    await page.click('.mtab[data-tab="terminal"]');
    await expect(page.locator('#ds-scrollspeed')).toHaveValue('20');
    await page.click('#modal-close');
  });

/** 다음 spec 이 20 을 물려받지 않게 되돌린다 (`font-size.spec.ts` 와 같은 근거). */
test.afterEach(async ({ request }) => {
  const cur = await settings(request);
  await request.put('/api/settings', { data: { ...cur, claudeScrollSpeed: 3 } });
});

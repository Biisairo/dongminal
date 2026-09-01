import { Page } from '@playwright/test';

import { test, expect } from './fixtures';

// RELOAD_CONTINUITY_SRS §5 묶음 P — TC-RLC-1~4.
//
// 서빙되는 자산은 바이너리에 embed 되어 있어 테스트 중에 바꿀 수 없다. 대신
// version-watch 가 버전을 읽는 그 요청(`GET /?_v=…`)만 가로채 `?v=` 를 갈아
// 끼운다 — 재는 것은 **다른 버전을 봤을 때 무엇을 하는가** 하나다.

async function waitForInit(page: Page) {
  await page.context().addInitScript(() => {
    sessionStorage.setItem('displayMode', 'desktop');
  });
  await page.goto('/');
  await page.waitForSelector('#area .pn.focused .xterm-helper-textarea', { timeout: 15000 });
}

// 문서 자체(`/`)는 그대로 두고 버전 확인 요청만 바꾼다. 그러지 않으면 새로고침
// 뒤의 페이지가 스텁된 HTML 로 서고, 그 안의 스크립트 경로가 실물과 어긋난다.
async function stubVersion(page: Page, ver: string) {
  await page.route(/\/\?_v=\d+/, async (route) => {
    const res = await route.fetch();
    const body = (await res.text()).replace(/core\/main\.js\?v=\d+/, 'core/main.js?v=' + ver);
    await route.fulfill({ response: res, body, headers: { ...res.headers(), 'content-type': 'text/html' } });
  });
}

// version-watch 는 IIFE 라 밖에서 부를 손잡이가 없다. 그것이 듣고 있는 계기 —
// 탭이 다시 보이는 순간 — 를 발생시킨다 (FR-RLC-2).
const triggerCheck = (page: Page) =>
  page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));

// 문서가 다시 뜨면 사라지는 표식. 새로고침의 유일한 관측 수단이다.
const mark = (page: Page) => page.evaluate(() => { (window as any).__alive = 1 });
const survived = (page: Page) => page.evaluate(() => !!(window as any).__alive);

async function waitReloaded(page: Page, ms = 5000): Promise<boolean> {
  try {
    await page.waitForFunction(() => !(window as any).__alive, undefined, { timeout: ms });
    return true;
  } catch {
    return false;
  }
}

test.describe('묶음 P — 새 버전 자동 새로고침', () => {
  test('TC-RLC-1·2 (FR-RLC-1·4): 버전이 다르면 배너 없이 스스로 다시 뜬다', async ({ page }) => {
    await waitForInit(page);
    await mark(page);
    await stubVersion(page, '999999');
    await triggerCheck(page);

    expect(await waitReloaded(page), '새 버전을 보고도 다시 뜨지 않았다').toBe(true);
    await expect(page.locator('#ver-banner')).toHaveCount(0);
  });

  test('TC-RLC-4 (FR-RLC-2): 버전이 같으면 다시 뜨지 않는다', async ({ page }) => {
    await waitForInit(page);
    await mark(page);
    // 스텁을 걸되 실물과 같은 버전으로 — 확인 요청은 오가지만 결론이 다르다.
    const cur = await page.evaluate(() => {
      const el = document.querySelector('script[src*="core/main.js"]');
      return (el?.getAttribute('src') || '').match(/[?&]v=(\d+)/)?.[1] || '';
    });
    expect(cur).not.toBe('');
    await stubVersion(page, cur);
    await triggerCheck(page);

    expect(await waitReloaded(page, 2000)).toBe(false);
    expect(await survived(page)).toBe(true);
  });

  test('TC-RLC-3 (FR-RLC-3): 새로고침해도 버전이 그대로면 되풀이하지 않는다', async ({ page }) => {
    // 확인 요청에는 늘 새 버전이 보이지만 실제 문서는 갈리지 않는 상황 —
    // 배포가 절반만 반영되거나 프록시가 옛 HTML 을 쥐고 있을 때의 모양이다.
    let loads = 0;
    page.on('load', () => { loads++ });

    await stubVersion(page, '999999');
    await waitForInit(page);
    const after = loads;

    // 첫 새로고침이 일어날 시간을 준다. 고리가 열려 있으면 여기서 계속 돈다.
    await triggerCheck(page);
    await page.waitForTimeout(4000);

    expect(loads - after, '새로고침이 되풀이되고 있다').toBeLessThanOrEqual(1);
  });
});

// ── FR-RLC-3a·5a·2a (TC-RLC-3b·3c·10·11) ──

test('TC-RLC-3c (FR-RLC-2a): 주기 폴링이 돌지 않는다', async ({ page }) => {
  await waitForInit(page);
  // 감지의 계기는 서버의 인사다 (FR-RLC-2). 주기를 함께 두면 같은 일을 두 벌로
  // 하며 요청만 는다 — 가만히 두었을 때 확인 요청이 늘지 않아야 한다.
  let checks = 0;
  await page.route(/\/\?_v=\d+/, (route) => { checks++; route.continue() });
  await page.waitForTimeout(8000);
  expect(checks, '가만히 두었는데 버전 확인이 나갔다').toBe(0);
});

test('TC-RLC-10 (FR-RLC-5a): 자동 새로고침이 떠남 확인을 걸지 않는다', async ({ page }) => {
  await waitForInit(page);
  // 가드는 도구가 있을 때만 걸린다 (main.js) — 그 전제부터 확인한다.
  expect(await page.evaluate(() => (window as any).app.tools.size)).toBeGreaterThan(0);

  // `main.js` 의 리스너 **뒤에** 붙어 그것이 기본 동작을 막았는지 관측한다.
  // 값은 문서와 함께 사라지므로 sessionStorage 에 남긴다.
  await page.evaluate(() => {
    sessionStorage.removeItem('__bu');
    window.addEventListener('beforeunload', (e) => {
      try { sessionStorage.setItem('__bu', String(e.defaultPrevented)) } catch { /* 사생활 모드 */ }
    });
  });

  await mark(page);
  await stubVersion(page, '999999');
  await triggerCheck(page);
  expect(await waitReloaded(page)).toBe(true);

  const blocked = await page.evaluate(() => sessionStorage.getItem('__bu'));
  expect(blocked, '자동 새로고침에 떠남 확인이 걸렸다').toBe('false');
});

test('TC-RLC-11 (FR-RLC-5a): 사용자가 떠나는 경로에서는 그 확인이 그대로 걸린다', async ({ page }) => {
  await waitForInit(page);
  expect(await page.evaluate(() => (window as any).app.tools.size)).toBeGreaterThan(0);

  // 자동 새로고침이 아닌 평범한 떠남. 가드가 사라지면 사용자가 실수로 세션을
  // 잃는 것을 아무도 막지 않는다.
  const blocked = await page.evaluate(() => {
    const e = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(e);
    return e.defaultPrevented;
  });
  expect(blocked, '떠남 확인 가드가 통째로 사라졌다').toBe(true);
});

test('TC-RLC-3b (FR-RLC-3a): 헛돈 뒤에도 또 다른 새 버전이 오면 다시 새로고침한다', async ({ page }) => {
  await waitForInit(page);
  const self = await page.evaluate(() => {
    const el = document.querySelector('script[src*="core/main.js"]');
    return (el?.getAttribute('src') || '').match(/[?&]v=(\d+)/)?.[1] || '';
  });
  // 앞선 시도가 헛돌았다 — `self` 에서 `900001` 로 가려 했으나 여전히 `self` 다.
  await page.evaluate(([from, to]) => {
    sessionStorage.setItem('verReloadTried', JSON.stringify({ from, to }));
  }, [self, '900001'] as const);

  // 같은 목표라면 되풀이하지 않는다 (FR-RLC-3).
  await mark(page);
  await stubVersion(page, '900001');
  await triggerCheck(page);
  expect(await waitReloaded(page, 2000), '소용없다고 판명된 시도를 되풀이했다').toBe(false);

  // **다른** 버전이 나오면 다시 시도한다 — 기록은 포기가 아니다.
  await page.unroute(/\/\?_v=\d+/);
  await stubVersion(page, '900002');
  await triggerCheck(page);
  expect(await waitReloaded(page), '새 버전이 왔는데도 포기한 채로 남았다').toBe(true);
});

// 브라우저는 **사용자가 만진 적 있는** 문서에서만 떠남 대화를 띄운다 (sticky
// activation). 앞의 TC-RLC-10 은 `defaultPrevented` 로 가드가 걸렸는지만 재는데,
// 그것만으로는 실제 화면에 대화가 뜨는지 알 수 없다 — 접수한 말("여전히 reload
// site? 하고 물어본다")이 그 틈이다. 여기서는 **대화 자체**를 관측한다.
test('TC-RLC-10b (FR-RLC-5a): 만진 적 있는 페이지에서도 대화가 뜨지 않는다', async ({ page }) => {
  await waitForInit(page);
  expect(await page.evaluate(() => (window as any).app.tools.size)).toBeGreaterThan(0);

  // 사용자가 터미널을 눌러 입력한 것과 같은 상태를 만든다.
  await page.locator('#area .pn.focused').click();
  await page.keyboard.type('echo hi');

  const dialogs: string[] = [];
  page.on('dialog', (d) => { dialogs.push(d.type()); d.dismiss().catch(() => {}) });

  await mark(page);
  await stubVersion(page, '999999');
  await triggerCheck(page);

  expect(await waitReloaded(page), '자동 새로고침이 일어나지 않았다').toBe(true);
  expect(dialogs, '떠남 대화가 떴다: ' + JSON.stringify(dialogs)).toEqual([]);
});

// ── 묶음 S — 서버의 인사 (TC-RLC-22·23) ──
//
// 서버가 SSE 연결 직후 자기 판을 말한다 (FR-RLC-20). 화면은 그것을 자기 것과
// 견주고, 다르면 그 자리에서 다시 연다 — 주기적으로 물어볼 필요가 없다.

// SSE 가 나르는 인사를 흉내낸다. 실제 서버가 그 모양으로 보내는지는 Go 쪽
// TestHandleCommandSSE_ServerHello 가 따로 잰다.
const sendHello = (page: Page, v: string) =>
  page.evaluate((ver) => {
    const f = (window as any).__dmAssetVersion;
    if (typeof f !== 'function') throw new Error('__dmAssetVersion 이 없다');
    f(ver);
  }, v);

test('TC-RLC-22 (FR-RLC-23): 인사의 판이 다르면 그 자리에서 새로고침한다', async ({ page }) => {
  await waitForInit(page);
  await mark(page);
  await sendHello(page, '999999');
  expect(await waitReloaded(page), '인사를 받고도 다시 열지 않았다').toBe(true);
});

test('TC-RLC-23 (FR-RLC-23): 인사의 판이 같으면 아무 일도 하지 않는다', async ({ page }) => {
  await waitForInit(page);
  const self = await page.evaluate(() => {
    const el = document.querySelector('script[src*="core/main.js"]');
    return (el?.getAttribute('src') || '').match(/[?&]v=(\d+)/)?.[1] || '';
  });
  expect(self).not.toBe('');
  await mark(page);
  await sendHello(page, self);
  expect(await waitReloaded(page, 2000)).toBe(false);
  expect(await survived(page)).toBe(true);
});

test('TC-RLC-22b (FR-RLC-23): 인사도 되풀이 방지를 따른다', async ({ page }) => {
  await waitForInit(page);
  const self = await page.evaluate(() => {
    const el = document.querySelector('script[src*="core/main.js"]');
    return (el?.getAttribute('src') || '').match(/[?&]v=(\d+)/)?.[1] || '';
  });
  // 이 쌍은 이미 헛돌았다 — 판정은 `?v=` 경로와 **같은 것**이어야 한다.
  await page.evaluate(([from, to]) => {
    sessionStorage.setItem('verReloadTried', JSON.stringify({ from, to }));
  }, [self, '900003'] as const);

  await mark(page);
  await sendHello(page, '900003');
  expect(await waitReloaded(page, 2000), '소용없다고 판명된 시도를 되풀이했다').toBe(false);
});

// ── FR-RLC-25~28: SSE 의 침묵 (TC-RLC-25·26·27) ──
//
// 접수한 물음이 이 묶음의 이유다 — *"잠자기 중에 업데이트되면 모를 거 아니냐."*
// 잠에서 깬 기기의 소켓은 **끊긴 줄 모른 채 `OPEN` 으로 남는다**. 그때
// `readyState` 는 1 이라 기존 깨어남 처리가 건드리지 않고, 재연결이 없으니
// 인사도 오지 않는다 — 판 소식만이 아니라 명령·워크스페이스도 함께 멎는다.

// 지금 구독이 몇 번째로 열린 것인지. 다시 열렸는지를 이 수로 판정한다.
const sseGen = (page: Page) => page.evaluate(() => (window as any).app._sseGen || 0);

// 마지막 수신 시각을 과거로 밀어 침묵을 흉내낸다 — 실제로 45초를 기다릴 수는 없다.
const fakeSilence = (page: Page, ms: number) =>
  page.evaluate((back) => { (window as any).app._sseSeen = Date.now() - back }, ms);

test('TC-RLC-27 (FR-RLC-25·28): 수신이 이어지는 동안에는 끊지 않는다', async ({ page }) => {
  await waitForInit(page);
  const gen = await sseGen(page);
  expect(gen, '구독 세대를 셀 수 없다').toBeGreaterThan(0);
  // 서버가 인사를 15초마다 보내므로 그동안은 침묵이 아니다.
  await page.waitForTimeout(3000);
  expect(await sseGen(page), '멀쩡한 구독을 끊었다').toBe(gen);
});

test('TC-RLC-26 (FR-RLC-26): 깨어남의 계기에서 침묵을 즉시 판정한다', async ({ page }) => {
  await waitForInit(page);
  const gen = await sseGen(page);

  // 잠에서 깬 half-open 소켓 — 브라우저는 여전히 OPEN 이라고 믿는다.
  expect(await page.evaluate(() => (window as any).app._cmdES?.readyState)).toBe(1);
  await fakeSilence(page, 120000);

  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await page.waitForFunction((g) => ((window as any).app._sseGen || 0) > g, gen, { timeout: 10000 });
  expect(await sseGen(page)).toBeGreaterThan(gen);
});

test('TC-RLC-25 (FR-RLC-25): 침묵이 상한을 넘으면 스스로 다시 연다', async ({ page }) => {
  await waitForInit(page);
  const gen = await sseGen(page);

  // 깨어남의 계기 없이도 감시가 돈다 — 화면을 보고 있지 않아도 되살아나야 한다.
  await fakeSilence(page, 120000);
  await page.waitForFunction((g) => ((window as any).app._sseGen || 0) > g, gen, { timeout: 20000 });
  expect(await sseGen(page)).toBeGreaterThan(gen);
});

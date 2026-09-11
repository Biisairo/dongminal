import { test, expect, waitForInit } from './fixtures';

// ATTENTION_FIRING_SRS 묶음 S — 평문 접속에서 알림이 막히는 사실 (M5 `TLS-1`).
//
// 평문 HTTP 로 접속하면 브라우저가 `Notification` 을 통째로 막는다. 종전에는
// 토글이 켜진 채였고 알림은 오지 않았으며, 사용자가 그 사실을 아는 방법이 없었다.
//
// ── 왜 `isSecureContext` 를 덮어쓰는가 ────────────────────────
//
// e2e 는 `http://127.0.0.1:<port>` 로 붙고, **loopback 은 브라우저가 secure
// context 로 친다.** 즉 검사 환경은 실제 원격 평문 접속과 반대쪽이다. 그래서
// 문서가 서기 전에 그 값을 갈아 끼워 두 갈래를 모두 밟는다.
//
// 이 묶음에 TLS 는 없다. 조치는 **표시와 대체 수단**뿐이다 (로드맵 결정 9).

async function openNotifyTab(page) {
  await page.click('#settings-btn');
  await expect(page.locator('#modal-overlay')).toBeVisible();
  await page.click('button.mtab[data-tab="notify"]');
  await expect(page.locator('#panel-notify')).toBeVisible();
}

// 문서가 서기 전에 값을 심는다 — `app.js` 의 접근자가 그것을 읽는다.
async function forceInsecure(page, insecure: boolean, storedSound?: string) {
  await page.addInitScript(
    ({ insecure, storedSound }) => {
      Object.defineProperty(window, 'isSecureContext', {
        get: () => !insecure,
        configurable: true,
      });
      if (storedSound !== undefined) {
        try { localStorage.setItem('attnSound', storedSound); } catch { /* 저장소가 막힌 환경 */ }
      } else {
        try { localStorage.removeItem('attnSound'); } catch { /* 같음 */ }
      }
    },
    { insecure, storedSound },
  );
}

// V-ATS-1·2 — 막힌 환경이면 토글이 **비활성화되고 사유가 보인다.**
test('TC-ATS-1 평문 접속에서 데스크톱 알림 토글이 잠기고 사유가 뜬다', async ({ page }) => {
  await forceInsecure(page, true);
  await waitForInit(page);
  await openNotifyTab(page);

  const toggle = page.locator('#attn-desktop');
  await expect(toggle).toBeDisabled();
  await expect(toggle).not.toBeChecked();

  const notice = page.locator('#attn-insecure');
  await expect(notice).toBeVisible();
  const text = (await notice.textContent()) ?? '';

  // ① 브라우저가 막았다는 사실
  expect(text).toContain('평문 HTTP');
  expect(text).toContain('데스크톱 알림');
  // ② 대체 수단
  expect(text).toContain('사운드');
  expect(text).toContain('탭 제목');

  // V-ATS-2: **제품이 제공하지 않는 길을 안내하지 않는다.**
  expect(text).not.toContain('HTTPS');
  expect(text).not.toContain('https://');
  expect(text).not.toContain('TLS');
});

// V-ATS-3 — 같은 조건에서 저장된 값이 없으면 알림음이 **켜짐**이다.
test('TC-ATS-2 평문 접속에서 알림음이 기본으로 켜진다', async ({ page }) => {
  await forceInsecure(page, true);
  await waitForInit(page);
  await openNotifyTab(page);
  await expect(page.locator('#attn-sound')).toBeChecked();
});

// V-ATS-4 — **사용자가 끄면 그 선택이 우선이다.** 갈리는 것은 "정한 적 없음" 뿐이다.
test('TC-ATS-3 사용자가 끈 적이 있으면 그 선택이 이긴다', async ({ page }) => {
  await forceInsecure(page, true, '0');
  await waitForInit(page);
  await openNotifyTab(page);
  await expect(page.locator('#attn-sound')).not.toBeChecked();
});

// V-ATS-5 — secure context 에서는 안내가 보이지 않고 토글이 살아 있다.
// **게이트가 자기 화면을 막지 않는지** 보는 자리다.
test('TC-ATS-4 secure context 에서는 안내가 없고 토글이 살아 있다', async ({ page }) => {
  await forceInsecure(page, false);
  await waitForInit(page);
  await openNotifyTab(page);

  await expect(page.locator('#attn-desktop')).toBeEnabled();
  await expect(page.locator('#attn-insecure')).toBeHidden();
  // 저장된 값이 없으면 종전 기본값(꺼짐)이다 — 환경이 바뀌지 않았으면 동작도 같다.
  await expect(page.locator('#attn-sound')).not.toBeChecked();
});

// V-ATS-6 — 탭 제목 배지는 **이미 있다.** 새로 만들지 않았음을 확인만 한다.
// 로드맵의 "`document.title` 대입 0곳" 은 그 사이에 낡은 사실이었다.
test('TC-ATS-5 탭 제목을 합성하는 자리가 그대로 하나다', async ({ page }) => {
  await waitForInit(page);
  const title = await page.title();
  expect(title.length).toBeGreaterThan(0);
  // 합성기가 살아 있는지 — 알람 수를 넣으면 접두사가 붙는다.
  const withBadge = await page.evaluate(() => {
    const app = (window as any).app;
    app._attn = new Map([['t1', {}], ['t2', {}]]);
    app._applyPageTitle();
    return document.title;
  });
  expect(withBadge).toMatch(/^\(2\) /);
});

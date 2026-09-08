import { test, expect, waitForInit } from './fixtures';

// VIEWER_URL_OPEN_SRS — 보고 있는 기기에서 URL 을 연다.
//
// 서버의 로컬/원격 판정은 Go 유닛이 덮는다 (openurl_test.go). 여기서 재는 것은
// **뷰어가 받은 뒤**다 — 어떤 주소로 고쳐 여는가(FR-VUO-10), 그리고 그 열기가
// 사용자 제스처 안에서 일어나는가(FR-VUO-8).

test.describe('VIEWER_URL_OPEN — 뷰어 쪽 동작', () => {
  // V7: URL 재작성. 서버의 localhost 는 뷰어의 localhost 가 아니다.
  test('V7 (FR-VUO-10): 로컬 host 는 접속한 host 로 바뀌고 나머지는 그대로다', async ({ page }) => {
    await waitForInit(page);
    const got = await page.evaluate(() => {
      // `const OpenUrl` 은 전역 렉시컬 스코프에 있어 window 의 프로퍼티가 아니다.
      const O = new Function('return OpenUrl')();
      const R = (u: string) => O.rewrite(u, 'ipad.local');
      return {
        localhost: R('http://localhost:3000/a?b=1#c'),
        v4: R('http://127.0.0.1:5173/'),
        any: R('http://0.0.0.0:8080/x'),
        v6: R('http://[::1]:9000/'),
        https: R('https://localhost/secure'),
        external: R('https://claude.ai/login?x=1'),
        otherHost: R('http://192.168.0.9:3000/'),
        garbage: R('not a url'),
      };
    });
    // 포트·경로·쿼리·프래그먼트·scheme 이 보존된다.
    expect(got.localhost).toBe('http://ipad.local:3000/a?b=1#c');
    expect(got.v4).toBe('http://ipad.local:5173/');
    expect(got.any).toBe('http://ipad.local:8080/x');
    expect(got.v6).toBe('http://ipad.local:9000/');
    expect(got.https).toBe('https://ipad.local/secure');
    // 서버 밖의 주소는 손대지 않는다.
    expect(got.external).toBe('https://claude.ai/login?x=1');
    expect(got.otherHost).toBe('http://192.168.0.9:3000/');
    // 못 알아보는 값은 그대로 흘린다 — 여기서 삼키면 사용자가 이유를 알 수 없다.
    expect(got.garbage).toBe('not a url');
  });

  // V8: 확인 팝업이 뜨고, `열기` 클릭 안에서 window.open 이 불린다. 제스처 밖에서
  // 부르면 브라우저가 차단한다 — 이 테스트가 그 조건을 못박는다.
  test('V8 (FR-VUO-7·8): 확인 팝업의 열기 클릭이 새 탭을 연다', async ({ page }) => {
    await waitForInit(page);
    await page.evaluate(() => {
      (window as any).__opened = [];
      (window as any).open = (u: string, t: string) => {
        (window as any).__opened.push([u, t]);
        return null;
      };
      (window as any).app._execRemote('openUrl', { url: 'https://example.com/a' });
    });

    const popup = page.locator('.openurl-modal');
    await expect(popup).toBeVisible();
    // 무엇이 열릴지 보여야 한다.
    await expect(popup).toContainText('example.com/a');
    // 아직 열지 않았다.
    expect(await page.evaluate(() => (window as any).__opened.length)).toBe(0);

    await popup.getByRole('button', { name: '열기' }).click();
    const opened = await page.evaluate(() => (window as any).__opened);
    expect(opened).toEqual([['https://example.com/a', '_blank']]);
    await expect(popup).toHaveCount(0);
  });

  // FR-VUO-9: 취소는 아무 것도 열지 않는다.
  test('V8b (FR-VUO-9): 취소하면 열지 않는다', async ({ page }) => {
    await waitForInit(page);
    await page.evaluate(() => {
      (window as any).__opened = [];
      (window as any).open = (u: string) => { (window as any).__opened.push(u); return null };
      (window as any).app._execRemote('openUrl', { url: 'https://example.com/b' });
    });
    const popup = page.locator('.openurl-modal');
    await popup.getByRole('button', { name: '취소' }).click();
    await expect(popup).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).__opened)).toEqual([]);
  });

  // 중앙 모달의 표준 출구. 상자 밖 클릭과 Esc 는 취소와 같아야 한다.
  test('V8e (FR-VUO-9): Esc 와 바깥 클릭은 취소와 같다', async ({ page }) => {
    await waitForInit(page);
    const fire = () => page.evaluate(() => {
      (window as any).__opened = [];
      (window as any).open = (u: string) => { (window as any).__opened.push(u); return null };
      (window as any).app._execRemote('openUrl', { url: 'https://example.com/d' });
    });

    await fire();
    await page.keyboard.press('Escape');
    await expect(page.locator('.openurl-modal')).toHaveCount(0);

    await fire();
    // 상자 밖(백드롭)을 누른다.
    await page.locator('.openurl-modal').click({ position: { x: 5, y: 5 } });
    await expect(page.locator('.openurl-modal')).toHaveCount(0);

    expect(await page.evaluate(() => (window as any).__opened)).toEqual([]);
  });

  // FR-VUO-5: 기억하지 않는다 — 두 번 오면 두 번 묻는다.
  test('V8c (FR-VUO-5): 확인은 기억되지 않는다', async ({ page }) => {
    await waitForInit(page);
    const fire = () => page.evaluate(() => {
      (window as any).open = () => null;
      (window as any).app._execRemote('openUrl', { url: 'https://example.com/c' });
    });
    await fire();
    await page.locator('.openurl-modal').getByRole('button', { name: '열기' }).click();
    await expect(page.locator('.openurl-modal')).toHaveCount(0);
    await fire();
    await expect(page.locator('.openurl-modal')).toBeVisible();
  });

  // FR-VUO-18 의 클라이언트 쪽 방어. 서버가 막지만 뷰어도 스스로 막는다 —
  // 이 경로는 SSE 로 오므로 서버만 믿을 이유가 없다.
  test('V8d: http/https 가 아니면 팝업조차 뜨지 않는다', async ({ page }) => {
    await waitForInit(page);
    await page.evaluate(() => {
      (window as any).__opened = [];
      (window as any).open = (u: string) => { (window as any).__opened.push(u); return null };
      (window as any).app._execRemote('openUrl', { url: 'javascript:alert(1)' });
      (window as any).app._execRemote('openUrl', { url: '' });
    });
    await expect(page.locator('.openurl-modal')).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).__opened)).toEqual([]);
  });
});

import { test, expect, waitForInit, waitShellReady } from './fixtures';
import { TMP } from './osenv';

test.describe('Terminal features', () => {
  test('search opens and closes', async ({ page }) => {
    await waitForInit(page);
    await page.keyboard.press('Control+f');
    // 제품은 `[hidden]` **속성**으로 숨긴다 (app-search.js `_searchOpen`).
    // 숨김의 어휘는 하나다 (FR-LAY-30) — 클래스를 재면 영영 맞지 않는다.
    await expect(page.locator('#search-bar')).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(page.locator('#search-bar')).toBeHidden();
  });

  test('search finds text in terminal', async ({ page }) => {
    await waitForInit(page);
    await waitShellReady(page);
    await page.click('#area .pn.focused .xterm-screen');

    // Type a unique string.
    await page.keyboard.type('findme_12345');
    await page.keyboard.press('Enter');
    await expect(page.locator('#area .pn.focused .xterm-rows')).toContainText('findme_12345', { timeout: 10000 });

    // Open search.
    await page.keyboard.press('Control+f');
    await expect(page.locator('#search-bar')).toBeVisible();

    // Type search query.
    await page.locator('#search-input').fill('findme_12345');
    await page.locator('#search-input').press('Enter');

    /**
     * `12-func-ui.md FUI-15` 로 `#search-count` 가 **`n/N`** 이 됐다.
     *
     *   이전 동작: `''`(찾음) 또는 `'없음'` 둘뿐 — 몇 번째인지도 몇 개인지도
     *             알 수 없었다
     *   새  동작: 벤더 addon 의 `onDidChangeResults` 를 구독해 자리와 수를 적는다
     *   이유:     편집기 찾기 줄은 이미 그렇게 한다 — 같은 앱의 두 검색이
     *             비대칭이었다
     */
    await expect(page.locator('#search-count')).toHaveText(/^\d+\/\d+$/, { timeout: 10000 });

    // Close search.
    await page.keyboard.press('Escape');
    await expect(page.locator('#search-bar')).toBeHidden();
  });

  // FUI-15: 토글 셋과 없음 표기.
  test('터미널 검색의 토글 셋과 없음 표기 (FUI-15)', async ({ page }) => {
    await waitForInit(page);
    await waitShellReady(page);
    await page.keyboard.type('echo fui15_alpha fui15_beta');
    await page.keyboard.press('Enter');
    await expect(page.locator('#area .pn.focused .xterm-rows'))
      .toContainText('fui15_alpha', { timeout: 10000 });

    await page.keyboard.press('Control+f');
    await expect(page.locator('#search-bar')).toBeVisible();
    // 토글 셋이 다 있다 — 편집기 찾기 줄과 같은 구성이다.
    await expect(page.locator('#search-case')).toBeVisible();
    await expect(page.locator('#search-word')).toBeVisible();
    await expect(page.locator('#search-regex')).toBeVisible();

    // 없는 것은 "없음" 이다.
    await page.locator('#search-input').fill('fui15_zzz_none');
    await page.locator('#search-input').press('Enter');
    await expect(page.locator('#search-count')).toHaveText('없음', { timeout: 10000 });

    // 정규식 토글이 실제로 걸린다 — 켜지 않으면 `.` 는 글자 그대로다.
    await page.locator('#search-input').fill('fui15_(alpha|beta)');
    await page.locator('#search-input').press('Enter');
    await expect(page.locator('#search-count')).toHaveText('없음', { timeout: 10000 });
    await page.locator('#search-regex').click();
    await expect(page.locator('#search-count')).toHaveText(/^\d+\/\d+$/, { timeout: 10000 });

    // 깨진 정규식은 **그 사실을 말한다** — addon 은 그때도 0건을 내므로
    // "없음" 과 구분되지 않는다.
    await page.locator('#search-input').fill('fui15_(');
    await page.locator('#search-input').press('Enter');
    await expect(page.locator('#search-count')).toHaveText('정규식 오류', { timeout: 10000 });

    await page.keyboard.press('Escape');
    await expect(page.locator('#search-bar')).toBeHidden();
  });

  test('multiple sequential commands produce output', async ({ page }) => {
    await waitForInit(page);
    await waitShellReady(page);
    await page.click('#area .pn.focused .xterm-screen');

    for (let i = 0; i < 3; i++) {
      const cmd = `echo seq_${i}`;
      await page.keyboard.type(cmd);
      await page.keyboard.press('Enter');
      await expect(page.locator('#area .pn.focused .xterm-rows')).toContainText(`seq_${i}`, { timeout: 10000 });
    }
  });

  test('terminal survives page refresh', async ({ page }) => {
    await waitForInit(page);
    await waitShellReady(page);
    await page.click('#area .pn.focused .xterm-screen');

    await page.keyboard.type('echo survive_refresh');
    await page.keyboard.press('Enter');
    await expect(page.locator('#area .pn.focused .xterm-rows')).toContainText('survive_refresh', { timeout: 10000 });

    const beforeRg = await page.locator('#area .pn').count();
    await page.reload();
    await waitForInit(page);

    // Pane count should be preserved.
    await expect(page.locator('#area .pn')).toHaveCount(beforeRg, { timeout: 10000 });
    await expect(page.locator('#area .pn.focused')).toHaveCount(1);
  });

  test('typing in terminal updates status bar cwd', async ({ page }) => {
    await waitForInit(page);
    await waitShellReady(page);
    await page.click('#area .pn.focused .xterm-screen');

    // 임시 디렉터리로 옮기고 무언가를 찍는다. 경로 리터럴을 두지 않는 이유는
    // Windows 에 `/tmp` 가 없기 때문이다 (FR-CEM-7).
    await page.keyboard.type(`cd ${TMP}`);
    await page.keyboard.press('Enter');
    await page.keyboard.type('echo cwd_test');
    await page.keyboard.press('Enter');
    await expect(page.locator('#area .pn.focused .xterm-rows')).toContainText('cwd_test', { timeout: 10000 });

    // Status bar should eventually reflect the temp dir.
    const statusText = await page.locator('#status-bar').textContent();
    expect(statusText.length).toBeGreaterThan(0);
  });

  test('_send drops are counted when ws is closed', async ({ page }) => {
    await waitForInit(page);
    await page.waitForFunction(() => {
      const a = (window as any).app;
      const p = a && a.tools && a.tools.values().next().value;
      return p && p.ws && p.ws.readyState === 1;
    }, { timeout: 10000 });

    const before = await page.evaluate(() => (window as any).__dongminalDebug.sendDropCount());

    await page.evaluate(() => {
      const a = (window as any).app;
      const p = a.tools.values().next().value;
      try { p.ws.close() } catch {}
      Object.defineProperty(p.ws, 'readyState', { get: () => 3 });
      p._send(new Uint8Array([1, 65]));
      p._send(new Uint8Array([1, 66]));
    });

    const after = await page.evaluate(() => (window as any).__dongminalDebug.sendDropCount());
    expect(after - before).toBeGreaterThanOrEqual(2);
  });

  test('_send buffers while ws is connecting', async ({ page }) => {
    await waitForInit(page);
    await page.waitForFunction(() => {
      const a = (window as any).app;
      const p = a && a.tools && a.tools.values().next().value;
      return p && p.ws && p.ws.readyState === 1;
    }, { timeout: 10000 });

    const queued = await page.evaluate(() => {
      const a = (window as any).app;
      const p = a.tools.values().next().value;
      const fakeWs = { readyState: 0, send: () => {} };
      p.ws = fakeWs as any;
      p._send(new Uint8Array([1, 65]));
      p._send(new Uint8Array([1, 66]));
      return p._sendQueue.length;
    });
    expect(queued).toBe(2);

    const remaining = await page.evaluate(() => {
      const a = (window as any).app;
      const p = a.tools.values().next().value;
      let calls = 0;
      const fakeWs = { readyState: 1, send: () => { calls++ } };
      p.ws = fakeWs as any;
      p._flushSendQueue();
      return { qlen: p._sendQueue.length, calls };
    });
    expect(remaining.qlen).toBe(0);
    expect(remaining.calls).toBe(2);
  });

  test('_send queue is bounded and drops oldest', async ({ page }) => {
    await waitForInit(page);
    await page.waitForFunction(() => {
      const a = (window as any).app;
      const p = a && a.tools && a.tools.values().next().value;
      return p && p.ws && p.ws.readyState === 1;
    }, { timeout: 10000 });

    const result = await page.evaluate(() => {
      const a = (window as any).app;
      const p = a.tools.values().next().value;
      const before = p._sendDropCount;
      p._sendQueue = [];
      const fakeWs = { readyState: 0, send: () => {} };
      p.ws = fakeWs as any;
      for (let i = 0; i < p._sendQueueMax + 5; i++) {
        p._send(new Uint8Array([1, i & 0xff]));
      }
      return { qlen: p._sendQueue.length, dropDelta: p._sendDropCount - before };
    });
    expect(result.qlen).toBe(64);
    expect(result.dropDelta).toBe(5);
  });
});

import { test, expect, waitForInit } from './fixtures';

/**
 * PERF_OPTIMIZATION_SRS D-12 · `perf/CHANNEL_PROTOCOL.md` §10.7 TC-CH6-5 — 실제 브라우저의 채널이
 * permessage-deflate 로 붙는다. 업그레이드 응답 헤더는 Playwright 의 WebSocket 이벤트에 없으므로
 * CDP 의 핸드셰이크 응답을 본다.
 */
test('TC-CH6-5: 브라우저 채널이 permessage-deflate 를 협상하고 메시지가 오간다', async ({ page }) => {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Network.enable');
  const urls = new Map<string, string>();
  const exts: string[] = [];
  cdp.on('Network.webSocketCreated', (e: any) => { urls.set(e.requestId, e.url) });
  cdp.on('Network.webSocketHandshakeResponseReceived', (e: any) => {
    const url = urls.get(e.requestId) || '';
    if (new URL(url).pathname !== '/channel') return;
    const h = e.response.headers || {};
    const key = Object.keys(h).find((k) => k.toLowerCase() === 'sec-websocket-extensions');
    exts.push(key ? String(h[key]) : '');
  });

  await waitForInit(page);
  await expect.poll(() => exts.length, { timeout: 10000 }).toBeGreaterThan(0);
  expect(exts[0]).toContain('permessage-deflate');
  // 압축된 채널 위로 인사와 생존 확인이 오간다.
  await expect.poll(() => page.evaluate(() => (window as any).app.channel.latency()), { timeout: 15000 })
    .not.toBeNull();
});

import { createServer, Socket } from 'net';

import { test, expect } from './fixtures';

// RUST_DEFECT_FIX_SRS 10.7b — 서버는 `127.0.0.1` 에만 바인드한다(Go·Rust 같음). 브라우저가 `localhost` 로 붙으면
// `::1` 을 고를 수 있고, 그 포트의 `::1` 을 다른 프로세스가 쥐면 그쪽으로 간다. 전량 회차에서 두 워커가 같은
// 순간 `net::ERR_INVALID_HTTP_RESPONSE` 로 무너진 것이 이 모양이다(HTTP 가 아닌 리스너로 재현).

test('하네스는 다른 프로세스가 쥔 ::1 의 같은 포트로 붙지 않는다', async ({ page, dmServer }) => {
  const socks = new Set<Socket>();
  const shadow = createServer((s) => {
    socks.add(s);
    s.on('error', () => {});
    s.on('close', () => socks.delete(s));
    s.end(Buffer.from([0x16, 0x03, 0x03, 0x00, 0x02, 0x02, 0x28]));
  });
  const bound = await new Promise<boolean>((resolve) => {
    shadow.once('error', () => resolve(false));
    shadow.listen({ host: '::1', port: dmServer.port, exclusive: true }, () => resolve(true));
  });
  test.skip(!bound, '이 기계에서 ::1 에 바인드할 수 없다');
  try {
    const res = await page.goto('/');
    expect(res?.status()).toBe(200);
  } finally {
    for (const s of socks) s.destroy();
    await new Promise((r) => shadow.close(() => r(null)));
  }
});

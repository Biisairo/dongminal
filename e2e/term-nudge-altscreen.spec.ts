import { test, expect, waitForInit, waitShellReady } from './fixtures';

/**
 * 넛지는 alt screen 인 앱에만 건다 (TERMINAL_RESUME_SRS FR-TRS-18a · V-TRS-17a·17b).
 *
 * 접수된 렌더 잔재(`M11-B1`)의 원인이 이것이었다. 넛지는 `SIGWINCH` 를 두 번
 * 일으켜 앱을 두 번 그리게 하는데, **화면을 지우지 않고 커서만 올려 덮어쓰는 앱**은
 * 그때마다 어긋난 그림을 하나씩 더 쌓는다 (`M11_SRS` §2.4f: 표식 6 대 2).
 *
 * 그렇다고 걷을 수는 없다 — 넛지가 막는 영구 desync 는 alt screen 앱에서만
 * 일어나기 때문이다 (`§2.4`). 그래서 **갈라서** 잰다.
 */

const paneEval = (page: any, fn: string) => page.evaluate(`(() => {
  const p = [...window.app.tools.values()][0];
  return (${fn})(p);
})()`);

const runIn = (page: any, line: string) =>
  paneEval(page, `p => { p._sendText(${JSON.stringify(line + '\r')}) }`);

/** 이 뒤로 나가는 `OpResize` 프레임을 센다. 넛지는 그것을 둘 더한다. */
const watchResize = (page: any) => paneEval(page, `p => {
  window.__rs = 0;
  const orig = p._sendResize.bind(p);
  p._sendResize = (c, r) => { window.__rs++; orig(c, r) };
}`);

const resizeCount = (page: any) => page.evaluate(() => (window as any).__rs as number);

/** 소켓만 끊어 재접속시킨다 — 전량 재생을 타는 길이다. */
const dropSocket = (page: any) => paneEval(page, 'p => { p._seq = -1; p.ws.close() }');

// main screen 으로 흘러가는 앱 — claude 가 이 방식이다.
const MAIN_APP = 'node -e "process.stdout.write(\'main-ready\\n\');setInterval(()=>{},1000)"';
// alt screen 으로 들어가는 앱 — vim·top 이 이 방식이다.
const ALT_APP = 'node -e "process.stdout.write(\'\\x1b[?1049h\'+\'alt-ready\\n\');setInterval(()=>{},1000)"';

async function ready(page: any) {
  await waitForInit(page);
  await waitShellReady(page);
}

/** 전량 재생을 한 번 태우고, 그 뒤 나간 resize 수를 준다. */
async function resizesAfterReplay(page: any): Promise<number> {
  await watchResize(page);
  await dropSocket(page);
  // 재접속이 끝난 것을 좌표로 확인한다 — 넛지는 그 뒤 한 tick 에 온다.
  await expect.poll(() => paneEval(page, 'p => p._seq'), { timeout: 20000 }).toBeGreaterThan(0);
  // **예외 (`TEST-16`)**: 넛지가 **오지 않음**도 재야 하므로 한 박자 준다.
  await page.waitForTimeout(1500);
  return resizeCount(page);
}

test('V-TRS-17a: main screen 앱은 전량 재생 뒤에도 넛지를 받지 않는다', async ({ page }) => {
  await page.goto('/');
  await ready(page);
  await runIn(page, MAIN_APP);
  await expect.poll(() => paneEval(page, `p => p.term.buffer.active.length > 0`),
    { timeout: 20000 }).toBe(true);

  // `_onWsOpen` 의 크기 보고 한 번은 정상이다 (넛지가 아니다). 넛지는 둘을 더하므로
  // 셋 이상이면 걸린 것이다 — `V-TRS-17` 이 쓰는 것과 같은 셈이다.
  expect(await resizesAfterReplay(page)).toBeLessThan(3);
});

test('V-TRS-17b: alt screen 앱은 전량 재생 뒤 넛지를 받는다', async ({ page }) => {
  await page.goto('/');
  await ready(page);
  await runIn(page, ALT_APP);
  // 서버가 그 모드를 관측할 때까지 기다린다 — PTY 를 왕복한 뒤라야 안다.
  await expect.poll(() => paneEval(page, `p => p.term.buffer.active.length > 0`),
    { timeout: 20000 }).toBe(true);
  await page.waitForTimeout(1000);

  expect(await resizesAfterReplay(page)).toBeGreaterThanOrEqual(3);
});

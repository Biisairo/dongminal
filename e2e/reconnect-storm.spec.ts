import { join } from 'path';

import { Page } from '@playwright/test';

import { test, expect } from './fixtures';

// RECONNECT_STORM_SRS 묶음 R — 재연결 폭주 차단. 검증 V-RCS-1~6.
//
// 이 저장소에 JS 단위 테스트 러너가 없으므로 web/js/ui/term-pane.js 를 빈 페이지에
// 넣고 page.evaluate 로 계약만 시험한다 (repaint.spec.ts·git-lanes.spec.ts 와 같은
// 방식). 실서버를 태우지 않는 이유는 이 결함이 **소켓을 몇 개 여는가**로만 판정되고,
// 그것은 WebSocket 생성자를 세는 것으로 결정적으로 관측되기 때문이다.

const TERM_PANE_JS = join(process.cwd(), 'web', 'js', 'ui', 'term-pane.js');

// term-pane.js 가 기대하는 전역 중 재연결 경로가 쓰는 것만 세운다.
// WebSocket 은 생성 횟수를 세고 마지막 인스턴스를 노출하는 가짜다.
async function loadTermPane(page: Page) {
  await page.setContent('<!doctype html><title>term-pane</title><div id="area"></div>');
  await page.evaluate(() => {
    (window as any).OP = { INPUT: 0, RESIZE: 1, OUTPUT: 0, ERROR: 1, EXIT: 2, TOOLID: 3 };
    (window as any).dec = new TextDecoder();
    (window as any).enc = new TextEncoder();
    (window as any).WS_HEALTHY_MS = 3000;
    (window as any).OSC_CARRY_MS = 50;

    const opened: any[] = [];
    (window as any).__opened = opened;
    class FakeWS {
      static OPEN = 1;
      url: string;
      binaryType = '';
      readyState = 0;
      onopen: any = null;
      onclose: any = null;
      onerror: any = null;
      onmessage: any = null;
      constructor(url: string) {
        this.url = url;
        opened.push(this);
      }
      send() {}
      close() {
        this.readyState = 3;
      }
    }
    (window as any).WebSocket = FakeWS;
  });
  await page.addScriptTag({ path: TERM_PANE_JS });
  // `class` 선언은 전역 렉시컬 환경에 들어가고 window 에는 붙지 않는다
  // (repaint.js 의 `function` 선언과 다른 점). 이름으로 꺼내 올려둔다.
  // eval 의 인자는 고정 리터럴이고 외부 입력이 닿지 않는다 — 테스트 전용 배선이다.
  await page.evaluate(() => {
    (window as any).TerminalTool = eval('TerminalTool');
  });
}

// 패널 하나를 만들어 connect 시키고, 마지막 소켓을 열린 상태로 만든다.
// 반환은 그때까지 열린 소켓 수다.
async function connectPane(page: Page) {
  return page.evaluate(() => {
    const t = new (window as any).TerminalTool('tool-1', 'Shell');
    (window as any).__pane = t;
    document.getElementById('area')!.appendChild(t.el);
    t.connect();
    const ws = (window as any).__opened.at(-1);
    ws.readyState = 1;
    ws.onopen();
    return (window as any).__opened.length;
  });
}

// 서버가 OP.EXIT 을 보내고 소켓을 닫는 장면. 실서버의 handlers_ws.go 가
// 없는 도구에 대해 정확히 이 순서로 행동한다.
const sendExitThenClose = (page: Page) =>
  page.evaluate(() => {
    const ws = (window as any).__opened.at(-1);
    ws.onmessage({ data: new Uint8Array([(window as any).OP.EXIT]).buffer });
    ws.readyState = 3;
    ws.onclose();
  });

const socketCount = (page: Page) => page.evaluate(() => (window as any).__opened.length);

test.describe('재연결 폭주 차단 (RECONNECT_STORM_SRS 묶음 R)', () => {
  // V-RCS-1: OP.EXIT 을 받은 패널은 다시 붙지 않는다 (FR-RCS-1).
  test('V-RCS-1 OP.EXIT 뒤에는 새 소켓을 열지 않는다', async ({ page }) => {
    await loadTermPane(page);
    expect(await connectPane(page)).toBe(1);

    await sendExitThenClose(page);
    // 즉시 재연결(지연 0)이 걸렸다면 이 대기 안에 소켓이 수십 개 생긴다.
    await page.waitForTimeout(500);
    expect(await socketCount(page)).toBe(1);

    // 명시적으로 눌러도 서지 않는다 — 판정은 영구적이다.
    await page.evaluate(() => (window as any).__pane._scheduleReconnect());
    await page.waitForTimeout(300);
    expect(await socketCount(page)).toBe(1);
  });

  // V-RCS-2: 재연결로 붙은 소켓에서 OP.EXIT 이 와도 같은 판정이 선다.
  // 최초 연결과 재연결이 수신 처리를 나눠 갖던 것이 이 결함의 자리였다.
  test('V-RCS-2 재연결 경로의 OP.EXIT 도 종단이다', async ({ page }) => {
    await loadTermPane(page);
    await connectPane(page);

    // 유효 판정이 서기 전에 끊는다 → 재연결이 걸린다.
    await page.evaluate(() => {
      const ws = (window as any).__opened.at(-1);
      ws.readyState = 3;
      ws.onclose();
    });
    await expect.poll(() => socketCount(page), { timeout: 3000 }).toBe(2);

    await page.evaluate(() => {
      const ws = (window as any).__opened.at(-1);
      ws.readyState = 1;
      ws.onopen();
    });
    await sendExitThenClose(page);
    await page.waitForTimeout(500);
    expect(await socketCount(page)).toBe(2);
  });

  // V-RCS-3: onopen 만으로는 백오프가 리셋되지 않는다 (FR-RCS-3).
  // 리셋되면 지연이 매번 0 이 되어 무한 루프가 된다 — 이 결함의 증폭기다.
  test('V-RCS-3 즉시 끊기는 연결은 백오프를 되돌리지 않는다', async ({ page }) => {
    await loadTermPane(page);
    await connectPane(page);

    const delays: number[] = [];
    for (let i = 0; i < 4; i++) {
      await page.evaluate(() => {
        const ws = (window as any).__opened.at(-1);
        ws.readyState = 3;
        ws.onclose();
      });
      await expect.poll(() => socketCount(page), { timeout: 5000 }).toBe(i + 2);
      delays.push(await page.evaluate(() => (window as any).__pane._retryDelay));
      await page.evaluate(() => {
        const ws = (window as any).__opened.at(-1);
        ws.readyState = 1;
        ws.onopen();
      });
    }
    // 매 사이클 자란다. 하나라도 0 이면 백오프가 리셋된 것이다.
    expect(delays[0]).toBeGreaterThan(0);
    for (let i = 1; i < delays.length; i++) {
      expect(delays[i]).toBeGreaterThan(delays[i - 1]);
    }
  });

  // V-RCS-4: WS_HEALTHY_MS 이상 유지된 연결이 끊기면 백오프가 0 으로 돌아간다.
  // 정상 사용 중의 짧은 끊김은 즉시 되붙어야 한다.
  test('V-RCS-4 유지된 연결이 끊기면 백오프가 리셋된다', async ({ page }) => {
    await loadTermPane(page);
    await connectPane(page);
    await page.evaluate(() => {
      (window as any).__pane._retryDelay = 5000;
    });
    // healthy 타이머가 깨어날 때까지 기다린다 (WS_HEALTHY_MS=3000).
    await expect
      .poll(() => page.evaluate(() => (window as any).__pane._retryDelay), { timeout: 6000 })
      .toBe(0);
  });

  // V-RCS-6: 종료는 "재연결 중"과 구별되는 오버레이로 남는다 (FR-RCS-2).
  // 본문의 `── exited ──` 한 줄은 스크롤 밖으로 밀려 사라진다.
  test('V-RCS-6 종료된 패널은 종료 오버레이를 보인다', async ({ page }) => {
    await loadTermPane(page);
    await connectPane(page);
    await sendExitThenClose(page);

    const ov = page.locator('.tp-overlay .tp-ov-title');
    await expect(ov).toHaveText('도구 종료됨');
    expect(await page.evaluate(() => (window as any).__pane._exited)).toBe(true);
  });
});

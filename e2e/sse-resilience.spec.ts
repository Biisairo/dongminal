import { join } from 'path';

import { Page } from '@playwright/test';

import { test, expect } from './fixtures';

// RECONNECT_STORM_SRS FR-RCS-6 — 커맨드 SSE 는 포기하지 않는다. 검증 V-RCS-7·8.
//
// 이 구독이 끊긴 채로 남으면 `_applyRemoteWorkspace` 의 죽은 도구 정리가 돌지
// 않고, 그러면 없어진 도구를 향한 재접속이 영원히 계속된다 (§2.5 실측: 그 상태의
// 브라우저 둘이 초당 91연결). 그래서 "포기하지 않는다"가 요구사항이다.
//
// term-pane 과 같은 방식으로 빈 페이지에 얹고 계약만 시험한다.

const APP_CMD_JS = join(process.cwd(), 'web', 'js', 'core', 'app-cmd.js');

async function loadAppCmd(page: Page) {
  await page.setContent('<!doctype html><title>app-cmd</title>');
  await page.evaluate(() => {
    // 백오프를 밀리초 단위로 줄여 재시도 25회를 한 호흡에 관측한다.
    // 계약은 "포기하지 않는다"이지 특정 지연값이 아니다.
    (window as any).SSE_RETRY_MIN_MS = 5;
    (window as any).SSE_RETRY_MAX_MS = 10;

    const made: any[] = [];
    (window as any).__made = made;
    class FakeES {
      static CLOSED = 2;
      url: string;
      readyState = 0;
      onopen: any = null;
      onerror: any = null;
      onmessage: any = null;
      constructor(url: string) {
        this.url = url;
        made.push(this);
      }
      close() {
        this.readyState = 2;
      }
    }
    (window as any).EventSource = FakeES;
    // app-cmd.js 는 App.prototype 에 메서드를 얹는다. 껍데기만 세운다.
    // onopen 이 부르는 스냅샷 복원 다섯은 다른 파일에 있으므로 여기서 무해하게 막는다.
    (window as any).App = class {
      clientId = 'test-client';
      _attnRestore() {}
      _activityRestore() {}
      _bgRefresh() {}
      _focusRestore() {}
      _fgRestore() {}
    };
  });
  await page.addScriptTag({ path: APP_CMD_JS });
  await page.evaluate(() => {
    const a = new (window as any).App();
    (window as any).__app = a;
    a._subscribeCommands();
  });
}

// 마지막 EventSource 를 실패시킨다 — 서버가 죽었거나 네트워크가 끊긴 장면.
const failLatest = (page: Page) =>
  page.evaluate(() => {
    const es = (window as any).__made.at(-1);
    es.readyState = 2;
    es.onerror();
  });

const esCount = (page: Page) => page.evaluate(() => (window as any).__made.length);

test.describe('커맨드 SSE 복원력 (RECONNECT_STORM_SRS FR-RCS-6)', () => {
  // V-RCS-7: 종전 구현은 20회에서 영구히 포기했다. 25회를 넘겨 확인한다.
  test('V-RCS-7 연속 실패 25회 뒤에도 계속 재시도한다', async ({ page }) => {
    await loadAppCmd(page);
    expect(await esCount(page)).toBe(1);

    for (let i = 0; i < 25; i++) {
      await failLatest(page);
      await expect.poll(() => esCount(page), { timeout: 3000 }).toBe(i + 2);
    }
    // 여기까지 왔다는 것이 곧 포기하지 않았다는 뜻이다.
    expect(await esCount(page)).toBe(26);
  });

  // V-RCS-8: 네트워크가 돌아오면 백오프를 기다리지 않고 즉시 되붙는다.
  // 원격(Tailscale) 사용에서 끊김의 대부분이 잠·네트워크 전환이다.
  test('V-RCS-8 online 이벤트에 즉시 되붙는다', async ({ page }) => {
    await loadAppCmd(page);
    // 백오프를 길게 만들어 "기다렸다면 안 붙었을" 상태로 둔다.
    await page.evaluate(() => {
      (window as any).SSE_RETRY_MAX_MS = 60000;
    });
    for (let i = 0; i < 6; i++) {
      await failLatest(page);
      await expect.poll(() => esCount(page), { timeout: 3000 }).toBe(i + 2);
    }
    await failLatest(page);
    const before = await esCount(page);

    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await expect.poll(() => esCount(page), { timeout: 1000 }).toBe(before + 1);
  });

  // 살아 있는 구독에 online 이 와도 중복 구독하지 않는다 — 중복은 명령을
  // 두 번 실행시킨다 (단일 실행자 규약 FR-SXE-2 를 깨뜨린다).
  test('V-RCS-8b 살아 있는 구독은 online 에 중복되지 않는다', async ({ page }) => {
    await loadAppCmd(page);
    await page.evaluate(() => {
      const es = (window as any).__made.at(-1);
      es.readyState = 1;
      es.onopen();
    });
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await page.waitForTimeout(200);
    expect(await esCount(page)).toBe(1);
  });
});

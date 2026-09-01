import { test, expect } from './fixtures';

// RESTORE_FLIGHT_SRS e2e: 복원 비행 중에 도착한 갱신은 스냅숏보다 새롭다.
// 비행(요청 출발 ~ 응답 적용) 안에서 상태가 바뀌면, 그 응답은 그 id 를 추가도
// 삭제도 하지 않아야 한다 — 방향 A(새 것이 지워짐)·방향 B(없앤 것이 되살아남).
//
// 실제 레이스를 기다리면 재현되지 않으므로 fetch 를 게이트로 붙잡아 창을
// 결정론적으로 연다 (attention.spec.ts 의 V-ATL-7 과 같은 기법).

async function waitForInit(page) {
  await page.context().addInitScript(() => {
    sessionStorage.setItem('displayMode', 'desktop');
  });
  await page.goto('/');
  await page.waitForSelector('#area .pn.focused .xterm-helper-textarea', { timeout: 15000 });
}

// 비행을 연다. match 에 걸리는 요청만 붙잡아 두었다가 body 로 응답한다.
// during() 이 비행 중에 일어나는 일이고, 그 뒤 응답이 풀린다.
const GATE = `
  (match, body) => {
    const real = window.fetch;
    let release;
    const gate = new Promise(r => { release = r });
    window.fetch = (u, o) => {
      if (match(String(u))) {
        return gate.then(() => new Response(JSON.stringify(body),
          { headers: { 'Content-Type': 'application/json' } }));
      }
      return real(u, o);
    };
    return { release: () => release(), restore: () => { window.fetch = real } };
  }
`;

test.describe('복원 비행 (RESTORE_FLIGHT_SRS)', () => {
  // TC-RSF-1
  test('활동 방향 A — 비행 중 도착한 활동이 남는다', async ({ page }) => {
    await waitForInit(page);
    const has = await page.evaluate(async (gateSrc) => {
      const app = (window as any).app;
      app._activity.clear();
      const g = eval(gateSrc)((u: string) => u.includes('/api/tools/activity') && !u.includes('/set'),
        { activities: [] });                                   // 스냅숏은 비어 있다
      app._activityRestore();
      app._onToolActivity({ toolId: 'late', state: 'working', tool: 'Bash', detail: 'A' });
      g.release();
      await new Promise(r => setTimeout(r, 150));
      g.restore();
      return app._activity.has('late');
    }, GATE);
    expect(has, '복원 응답이 비행 중 도착한 활동을 지웠다').toBe(true);
  });

  // TC-RSF-2
  test('활동 방향 B — 비행 중 끝난 활동이 되살아나지 않는다', async ({ page }) => {
    await waitForInit(page);
    const has = await page.evaluate(async (gateSrc) => {
      const app = (window as any).app;
      app._activity.clear();
      app._onToolActivity({ toolId: 'dying', state: 'working', tool: 'Bash', detail: 'B' });
      // 스냅숏은 아직 살아 있다고 말한다 — 요청 시점의 진실이다.
      const g = eval(gateSrc)((u: string) => u.includes('/api/tools/activity') && !u.includes('/set'),
        { activities: [{ toolId: 'dying', state: 'working', tool: 'Bash', detail: 'B', updatedAt: 1 }] });
      app._activityRestore();
      app._onToolActivity({ toolId: 'dying', state: 'ended' });
      g.release();
      await new Promise(r => setTimeout(r, 150));
      g.restore();
      return app._activity.has('dying');
    }, GATE);
    expect(has, '낡은 스냅숏이 끝난 활동을 되살렸다').toBe(false);
  });

  // TC-RSF-3 — 묶음 A(FG_RESTORE_RACE_SRS)가 고친 자리. 회귀 방지선이다.
  test('전경 이름 방향 A — 비행 중 붙은 이름이 남는다', async ({ page }) => {
    await waitForInit(page);
    const name = await page.evaluate(async (gateSrc) => {
      const app = (window as any).app;
      app._fgMap().clear();
      const g = eval(gateSrc)((u: string) => u.includes('/api/state'), { tools: [] });
      app._fgRestore();
      app._onToolForeground({ toolId: 'late', name: 'vim' });
      g.release();
      await new Promise(r => setTimeout(r, 150));
      g.restore();
      return app._fgMap().get('late') || null;
    }, GATE);
    expect(name, '복원 응답이 비행 중 붙은 이름을 지웠다').toBe('vim');
  });

  // TC-RSF-4
  test('전경 이름 방향 B — 비행 중 지운 이름이 되살아나지 않는다', async ({ page }) => {
    await waitForInit(page);
    const name = await page.evaluate(async (gateSrc) => {
      const app = (window as any).app;
      app._fgMap().clear();
      app._onToolForeground({ toolId: 'dying', name: 'vim' });
      // 스냅숏은 vim 이 아직 떠 있다고 말한다.
      const g = eval(gateSrc)((u: string) => u.includes('/api/state'),
        { tools: [{ id: 'dying', fgName: 'vim' }] });
      app._fgRestore();
      app._onToolForeground({ toolId: 'dying', name: '' });     // 프로그램이 끝났다
      g.release();
      await new Promise(r => setTimeout(r, 150));
      g.restore();
      return app._fgMap().get('dying') || null;
    }, GATE);
    expect(name, '낡은 스냅숏이 지운 이름을 되살렸다').toBe(null);
  });

  // TC-RSF-5
  test('알람 방향 A — 비행 중 올라온 알람이 남는다', async ({ page }) => {
    await waitForInit(page);
    const has = await page.evaluate(async (gateSrc) => {
      const app = (window as any).app;
      app._attn.clear();
      const g = eval(gateSrc)((u: string) => u.includes('/api/tools/attention') && !u.includes('clear'),
        { toolIds: [] });
      app._attnRestore();
      app._onToolAttention({ toolId: 'late', reason: 'done' });
      g.release();
      await new Promise(r => setTimeout(r, 150));
      g.restore();
      return app._attn.has('late');
    }, GATE);
    expect(has, '복원 응답이 비행 중 올라온 알람을 지웠다').toBe(true);
  });

  // TC-RSF-6 — _attn 만 사용자 조작으로도 바뀐다 (SRS §2.1).
  test('알람 방향 B — 비행 중 사용자가 거둔 알람이 되살아나지 않는다', async ({ page }) => {
    await waitForInit(page);
    const has = await page.evaluate(async (gateSrc) => {
      const app = (window as any).app;
      app._attn.clear();
      app._onToolAttention({ toolId: 'seen', reason: 'done' });
      // 스냅숏은 알람이 아직 서 있다고 말한다.
      const g = eval(gateSrc)((u: string) => u.includes('/api/tools/attention') && !u.includes('clear'),
        { toolIds: ['seen'] });
      app._attnRestore();
      app._attnClear('seen', true);        // 사용자가 그 도구에 키를 눌렀다
      g.release();
      await new Promise(r => setTimeout(r, 150));
      g.restore();
      return app._attn.has('seen');
    }, GATE);
    expect(has, '낡은 스냅숏이 사용자가 거둔 알람을 되살렸다').toBe(false);
  });
});

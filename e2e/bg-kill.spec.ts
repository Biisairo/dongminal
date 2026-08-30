import { Page } from '@playwright/test';

import { test, expect } from './fixtures';

// 묶음 X (CONVENIENCE_SRS §3.2) — 백그라운드 도구 즉시 종료.
//
// 지금까지 백그라운드 도구를 없애려면 복귀시킨 뒤 탭을 닫아야 했다 — 두 단계이고
// 복귀가 화면을 바꾼다. 이 스펙은 모달 안에서 한 번에 끝나는 길을 고정한다.
//
// 여기서 다루지 않는 것: V-BGK-8(종료 후 목록에서 사라짐)·V-BGK-9(SIGTERM 무시
// 프로세스의 SIGKILL 승격)는 서버 계약이므로
// internal/webserver/httpapi/handlers_tools_kill_test.go 가 맡는다.

const MOBILE_VIEWPORT = { width: 375, height: 667 };

async function waitForInit(page: Page) {
  await page.context().addInitScript(() => {
    sessionStorage.setItem('displayMode', 'desktop');
  });
  await page.goto('/');
  await page.waitForSelector('#area .pn.focused .xterm-helper-textarea', { timeout: 15000 });
}

// 백그라운드 도구를 실제 경로(detachTab)로 만든다. background-ui.spec.ts 와 같은
// 수단이되 개수를 받는다 — 이 묶음은 "여럿을 정리하는 화면" 이 대상이므로
// 한 개짜리 목록으로는 확인 취소(V-BGK-5)를 볼 수 없다.
async function makeBackgroundTools(page: Page, request: any, n: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    // 창이 비지 않도록 항상 탭을 하나 더 만든 뒤 그 앞의 도구를 detach 한다.
    const target = await page.evaluate(() => {
      const app = (window as any).app;
      const w = app.ws.windows.find((x: any) => x.id === app.ws.activeWindow);
      const walk = (nd: any): string | null => {
        if (!nd) return null;
        for (const t of nd.tabs || []) if (t.toolId) return t.toolId;
        for (const c of nd.children || []) { const r = walk(c); if (r) return r; }
        return null;
      };
      return walk(w?.layout);
    });
    expect(target, '참조된 도구가 없다').toBeTruthy();

    const add = await request.post('/api/commands', { data: { action: 'newTab', args: {} } });
    expect(add.status()).toBe(200);
    await expect.poll(async () => page.evaluate(() => {
      const app = (window as any).app;
      const w = app.ws.windows.find((x: any) => x.id === app.ws.activeWindow);
      let c = 0;
      const walk = (x: any) => {
        if (!x) return;
        c += (x.tabs || []).length;
        for (const ch of x.children || []) walk(ch);
      };
      walk(w?.layout);
      return c;
    }), { timeout: 10000 }).toBeGreaterThan(1);

    const r = await request.post('/api/commands', { data: { action: 'detachTab', args: { toolId: target } } });
    expect(r.status(), `detachTab 이 ${r.status()} 로 거부됐다`).toBe(200);

    await expect.poll(
      async () => page.evaluate((tid) =>
        ((window as any).app._bg || []).some((b: any) => b.toolId === tid), target),
      { timeout: 10000 },
    ).toBe(true);
    ids.push(target as string);
  }
  return ids;
}

async function openModal(page: Page) {
  await page.click('#bg-btn');
  await expect(page.locator('#bg-modal .bg-box')).toBeVisible();
}

const row = (page: Page, id: string) => page.locator(`#bg-modal .bg-row[data-toolid="${id}"]`);

async function bgListHas(request: any, id: string): Promise<boolean> {
  const bg = await (await request.get('/api/tools/background')).json();
  return (bg.background || []).some((b: any) => b.toolId === id);
}

test.describe('FR-BGK-1..3: 종료 목표와 확인', () => {
  // V-BGK-1 · V-BGK-2 (FR-BGK-2 — hover 게이팅 금지)
  test('TC-BGK-1: 행마다 종료 버튼이 hover 없이 보인다', async ({ page, request }) => {
    await waitForInit(page);
    const ids = await makeBackgroundTools(page, request, 2);
    await openModal(page);

    for (const id of ids) {
      const btn = row(page, id).locator('.bg-kill');
      await expect(btn).toBeVisible();
      // 마우스를 올리지 않은 상태의 계산값이어야 한다 — .git-repo-x 의 opacity:0
      // 규약이 여기 새어 들어오면 터치 기기에서 닿을 수 없다.
      expect(await btn.evaluate((el) => getComputedStyle(el).opacity)).toBe('1');
      expect(await btn.evaluate((el) => getComputedStyle(el).visibility)).toBe('visible');
    }
  });

  // V-BGK-2
  test('TC-BGK-2: 종료 버튼은 인라인 확인으로 바꿀 뿐 아직 죽이지 않는다', async ({ page, request }) => {
    await waitForInit(page);
    const [a] = await makeBackgroundTools(page, request, 1);
    await openModal(page);

    await row(page, a).locator('.bg-kill').click();
    await expect(row(page, a).locator('.bg-confirm')).toBeVisible();
    await expect(row(page, a).locator('.bg-yes')).toBeVisible();
    await expect(row(page, a).locator('.bg-no')).toBeVisible();
    await expect(row(page, a).locator('.bg-kill')).toHaveCount(0);
    // FR-BGK-4: 모달 위의 모달이 아니다 — 확인은 행 **안**에 있다.
    expect(await page.locator('#bg-modal .bg-box').count()).toBe(1);
    expect(await row(page, a).locator('.bg-confirm').count()).toBe(1);

    expect(await bgListHas(request, a), '확인 단계에서 이미 죽었다').toBe(true);
  });
});

test.describe('FR-BGK-8..10: 종료의 결과', () => {
  // V-BGK-3 (FR-BGK-8)
  test('TC-BGK-3: 예 → 그 행만 사라지고 모달은 열린 채로 남는다', async ({ page, request }) => {
    await waitForInit(page);
    const [a, b] = await makeBackgroundTools(page, request, 2);
    await openModal(page);

    await row(page, a).locator('.bg-kill').click();
    await row(page, a).locator('.bg-yes').click();

    // 서버가 SIGTERM 유예(3초)를 기다린 뒤 응답한다 — 넉넉히 준다.
    await expect(row(page, a)).toHaveCount(0, { timeout: 15000 });
    await expect(page.locator('#bg-modal .bg-box')).toBeVisible();
    await expect(row(page, b)).toBeVisible();
    expect(await bgListHas(request, a)).toBe(false);
    expect(await bgListHas(request, b), '옆 행까지 죽었다').toBe(true);
  });

  // V-BGK-4
  test('TC-BGK-4: 아니오 → 원상 복귀', async ({ page, request }) => {
    await waitForInit(page);
    const [a] = await makeBackgroundTools(page, request, 1);
    await openModal(page);

    await row(page, a).locator('.bg-kill').click();
    await row(page, a).locator('.bg-no').click();

    await expect(row(page, a).locator('.bg-kill')).toBeVisible();
    await expect(row(page, a).locator('.bg-confirm')).toHaveCount(0);
    expect(await bgListHas(request, a)).toBe(true);
  });

  // V-BGK-7 (FR-BGK-9)
  // STATUS_BAR_REFLOW_SRS D-3: 진입점은 사라지지 않는다 — 하이라이트가 꺼진다.
  test('TC-BGK-7: 마지막 도구를 종료하면 "없음" 과 하이라이트 소멸', async ({ page, request }) => {
    await waitForInit(page);
    const [a] = await makeBackgroundTools(page, request, 1);
    await openModal(page);
    // 앞선 스펙이 남긴 도구가 없어야 "마지막" 이 성립한다.
    expect(await page.locator('#bg-modal .bg-row').count()).toBe(1);

    await row(page, a).locator('.bg-kill').click();
    await row(page, a).locator('.bg-yes').click();

    await expect(page.locator('#bg-modal .bg-empty')).toHaveText('없음', { timeout: 15000 });
    await expect(page.locator('#bg-btn')).toBeVisible();
    await expect(page.locator('#bg-btn')).not.toHaveClass(/\bon\b/);
  });

  // V-BGK-10
  test('TC-BGK-10: 종료 실패 시 행은 남고 오류가 인라인으로 뜬다', async ({ page, request }) => {
    await waitForInit(page);
    const [a] = await makeBackgroundTools(page, request, 1);
    await page.route('**/api/tools/kill', (route) =>
      route.fulfill({ status: 500, body: '종료 실패(강제)' }));
    await openModal(page);

    await row(page, a).locator('.bg-kill').click();
    await row(page, a).locator('.bg-yes').click();

    await expect(row(page, a).locator('.bg-err')).toBeVisible();
    await expect(page.locator('#bg-modal .bg-box')).toBeVisible();
    expect(await bgListHas(request, a), '실패했는데 도구가 사라졌다').toBe(true);
  });
});

test.describe('FR-BGK-1·5·11: 목표가 겹치지 않는다', () => {
  // V-BGK-5
  test('TC-BGK-5: 확인 중 다른 행을 건드리면 확인이 취소된다', async ({ page, request }) => {
    await waitForInit(page);
    const [a, b] = await makeBackgroundTools(page, request, 2);
    await openModal(page);

    await row(page, a).locator('.bg-kill').click();
    await expect(row(page, a).locator('.bg-confirm')).toBeVisible();

    await row(page, b).locator('.bg-name').click();

    await expect(row(page, a).locator('.bg-confirm')).toHaveCount(0);
    await expect(row(page, a).locator('.bg-kill')).toBeVisible();
    // 취소일 뿐이다 — 그 클릭이 복귀까지 하면 모달이 닫히고 화면이 바뀐다.
    await expect(page.locator('#bg-modal .bg-box')).toBeVisible();
    expect(await bgListHas(request, b)).toBe(true);
  });

  // V-BGK-5 (다른 행의 종료 버튼도 같은 취소다 — 확인은 한 번에 하나)
  test('TC-BGK-5b: 다른 행의 종료를 누르면 확인이 그 행으로 옮겨간다', async ({ page, request }) => {
    await waitForInit(page);
    const [a, b] = await makeBackgroundTools(page, request, 2);
    await openModal(page);

    await row(page, a).locator('.bg-kill').click();
    await row(page, b).locator('.bg-kill').click();

    await expect(row(page, b).locator('.bg-confirm')).toBeVisible();
    await expect(row(page, a).locator('.bg-confirm')).toHaveCount(0);
    expect(await page.locator('#bg-modal .bg-confirm').count()).toBe(1);
  });

  // V-BGK-5 (FR-BGK-5 — 모달 밖 클릭)
  test('TC-BGK-5c: 모달 밖을 클릭하면 확인이 남지 않는다', async ({ page, request }) => {
    await waitForInit(page);
    const [a] = await makeBackgroundTools(page, request, 1);
    await openModal(page);

    await row(page, a).locator('.bg-kill').click();
    await page.locator('#bg-modal').click({ position: { x: 5, y: 5 } });
    await expect(page.locator('#bg-modal')).toHaveCount(0);

    await openModal(page);
    await expect(row(page, a).locator('.bg-kill')).toBeVisible();
    await expect(row(page, a).locator('.bg-confirm')).toHaveCount(0);
  });

  // V-BGK-6
  test('TC-BGK-6: 행 본문 클릭은 복귀다 — 종료가 아니다', async ({ page, request }) => {
    await waitForInit(page);
    const [a] = await makeBackgroundTools(page, request, 1);
    await openModal(page);

    await row(page, a).locator('.bg-name').click();

    await expect(page.locator('#bg-modal')).toHaveCount(0);
    expect(await bgListHas(request, a), '복귀 대신 종료됐다').toBe(false);
    // 살아 있어야 한다 — 백그라운드에서 빠진 것이지 죽은 것이 아니다.
    const state = await (await request.get('/api/state')).json();
    expect((state.tools || []).some((t: any) => t.id === a), '복귀하려다 죽였다').toBe(true);
  });

  // V-BGK-11
  test('TC-BGK-11: 전체 종료 버튼이 없다', async ({ page, request }) => {
    await waitForInit(page);
    const ids = await makeBackgroundTools(page, request, 2);
    await openModal(page);

    // 종료 목표의 개수는 정확히 행의 개수다 — 행 밖의 종료 수단이 없다는 뜻이다.
    const rows = await page.locator('#bg-modal .bg-row').count();
    expect(await page.locator('#bg-modal .bg-kill').count()).toBe(rows);
    expect(rows).toBeGreaterThanOrEqual(ids.length);
    const outside = await page.evaluate(() =>
      Array.from(document.querySelectorAll('#bg-modal .bg-kill'))
        .filter((el) => !el.closest('.bg-row')).length);
    expect(outside, '행 밖에 종료 버튼이 있다').toBe(0);
    // 머리글에는 버튼이 없다 — "전체 종료" 가 놓일 유일한 자리다.
    expect(await page.locator('#bg-modal .bg-head button').count()).toBe(0);
    expect(await page.locator('#bg-modal .bg-box').innerText()).not.toContain('전체');
  });
});

test.describe('FR-BGK-2·12: 모바일 배치와 Run 소속', () => {
  // V-BGK-12 (배치). 실제 탭 입력은 hasTouch 프로젝트가 필요하므로
  // bg-kill-touch.spec.ts 가 맡는다 — 이 프로젝트는 Desktop Chrome 이다.
  test('TC-BGK-12: 모바일 폭에서 종료 버튼의 히트 영역이 규약을 지킨다', async ({ page, request }) => {
    await page.context().addInitScript(() => {
      sessionStorage.setItem('displayMode', 'mobile');
    });
    await page.setViewportSize(MOBILE_VIEWPORT);
    await page.goto('/');
    await page.waitForSelector('body.mobile', { timeout: 10000 });
    await page.waitForSelector('#area .pn.focused .xterm-helper-textarea', { timeout: 15000 });

    const [a] = await makeBackgroundTools(page, request, 1);
    await openModal(page);

    const btn = row(page, a).locator('.bg-kill');
    await expect(btn).toBeVisible();
    expect(await btn.evaluate((el) => getComputedStyle(el).opacity)).toBe('1');
    const box = await btn.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.height, '터치 타깃이 너무 낮다').toBeGreaterThanOrEqual(32);
  });

  // V-BGK-13. 실데이터 경로다 — Run 을 열고 헤드리스 멤버를 붙이면 그 도구가
  // ⏻ 목록에 **함께** 나타난다 (FR-HLM-2). 그러면 "떼어 둔 내 도구" 와 "Run 이
  // 만든 팀원" 이 한 목록에 섞이므로, 어느 쪽인지 말해 주지 않으면 구분할 수 없다.
  // 그래서 배지가 붙는 행과 붙지 않는 행을 **같은 목록에서** 함께 본다.
  //
  // 묶음 R·H 의 종단(POST /api/runs, /api/runs/members)에 의존한다.
  test('TC-BGK-13: Run 멤버 도구는 소속을 표시하고 확인 문구가 알린다', async ({ page, request }) => {
    await waitForInit(page);
    const plain = (await makeBackgroundTools(page, request, 1))[0];

    // isolation 은 기본값(none)이다 — 작업 트리를 만들지 않으므로 git 이 필요 없다.
    // projection 은 서버가 기본값을 채우지 않는다 — "투영을 정하지 않은 Run 은
    // 없다" 가 그 타입의 계약이다 (run.go Projection.Valid). isolation 만 none 으로
    // 채워진다.
    const runRes = await request.post('/api/runs', {
      data: { objective: '묶음 X 검증', projection: 'dedicated-window' },
    });
    expect(runRes.status(), 'Run 시작 실패 — 묶음 R 종단에 의존한다').toBe(200);
    const runId = (await runRes.json()).id as string;

    const memRes = await request.post('/api/runs/members', {
      data: { runId, role: '비평가', agent: 'claude', headless: true, cwd: '' },
    });
    expect(memRes.status(), '헤드리스 멤버 추가 실패 — 묶음 H 종단에 의존한다').toBe(200);
    const member = await memRes.json();
    const memberTool = member.toolId as string;
    expect(memberTool, '헤드리스 멤버에 도구가 없다').toBeTruthy();

    // 서버가 헤드리스 도구를 백그라운드로 등록한다 — 브라우저 목록에 오르길 기다린다.
    await expect.poll(
      async () => page.evaluate((tid) =>
        ((window as any).app._bg || []).some((b: any) => b.toolId === tid), memberTool),
      { timeout: 10000 },
    ).toBe(true);
    await openModal(page);

    // 주인 없는 도구에는 아무것도 붙지 않는다 — 계약의 반쪽이다.
    await expect(row(page, plain).locator('.bg-run')).toHaveCount(0);

    const short = runId.slice(0, 8);
    await expect(row(page, memberTool).locator('.bg-run')).toHaveText(`Run ${short} · 비평가`);

    // FR-BGK-12: 종료는 여전히 가능하되, 확인 문구가 그 사실을 알린다.
    await row(page, memberTool).locator('.bg-kill').click();
    const q = await row(page, memberTool).locator('.bg-q').innerText();
    expect(q).toContain(`Run ${short}`);
    expect(q).toContain('비평가');

    // 뒷정리 — 열린 Run 이 남으면 뒤 스펙의 목록에 그 멤버가 섞인다.
    await request.post('/api/runs/close', { data: { runId, force: true } });
  });
});

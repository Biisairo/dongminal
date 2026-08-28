import { Page } from '@playwright/test';

import { test, expect } from './fixtures';

// UX_REVISION_SRS §4 — 검증 V-DEL-*·V-FIT-*·V-CLS-*·V-MOV-*·V-NAM-*·V-BLP-*·V-KEY-*.
//
// 서버 쪽 검증(레코드 삭제·수거)은 Go 테스트가 본다. 여기는 **화면의 계약**만
// 본다 — 버튼이 있는가, 옮겨지는가, 엉뚱한 탭으로 떨어지지 않는가.

async function init(page: Page) {
  await page.context().addInitScript(() => {
    sessionStorage.setItem('displayMode', 'desktop');
  });
  await page.goto('/');
  await page.waitForSelector('#area .pn.focused .xterm-helper-textarea', { timeout: 15000 });
}

// ── 묶음 B — 사이드바 블루프린트 ──

test.describe('묶음 B — 사이드바 리스트 블루프린트 (FR-BLP-*)', () => {
  test('V-BLP-1: 두 패널의 첫 자식이 액션 버튼 행이다', async ({ page }) => {
    await init(page);
    for (const id of ['sb-panel-windows', 'sb-panel-git']) {
      const first = await page.evaluate(
        p => document.getElementById(p)?.firstElementChild?.className, id);
      expect(first, `${id} 의 첫 자식`).toBe('sb-actions');
    }
    // FR-BLP-8: `+ Add` 가 목록 위에 온다 — `+ New` 와 같은 자리.
    const addBeforeList = await page.evaluate(() => {
      const btn = document.getElementById('git-add-repo');
      const list = document.getElementById('git-repos');
      if (!btn || !list) return null;
      return !!(btn.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING);
    });
    expect(addBeforeList).toBe(true);
  });

  test('V-BLP-4: 기존 셀렉터가 그대로 산다', async ({ page }) => {
    await init(page);
    // 창 목록의 행·이름·삭제 표식은 이름이 바뀌지 않았다 (FR-BLP-6).
    await expect(page.locator('#windows .si').first()).toBeVisible();
    await expect(page.locator('#windows .si .si-name').first()).toBeVisible();
    expect(await page.locator('#windows .si .si-x').count()).toBeGreaterThan(0);
    // FR-BLP-7: 공통 클래스가 함께 붙는다.
    await expect(page.locator('#windows .si').first()).toHaveClass(/sbl-item/);
  });

  test('V-BLP-2: 창 재배치가 즉시 반영된다 (블루프린트 경로)', async ({ page }) => {
    await init(page);
    await page.evaluate(() => (window as any).app.addWindow());
    await expect(page.locator('#windows .si')).toHaveCount(2, { timeout: 10000 });
    const before = await page.evaluate(() => (window as any).app.ws.windows.map((w: any) => w.id));
    // 문서 전역 drop 이 쓰는 경로 그대로 — 항목 밖에서 놓은 경우다 (V-BLP-3).
    await page.evaluate(([src, tgt]) => {
      const app = (window as any).app;
      const def = (0, eval)('SB_TAB_DEFS').find((d: any) => d.id === 'windows');
      (0, eval)('SidebarList').commit(app, def, { type: 'window', src, target: tgt, before: true, done: false });
    }, [before[1], before[0]]);
    const after = await page.evaluate(() => (window as any).app.ws.windows.map((w: any) => w.id));
    expect(after[0]).toBe(before[1]);
    // 화면도 같은 회차에 바뀐다 — 폴링을 기다리지 않는다.
    const shown = await page.evaluate(() =>
      [...document.querySelectorAll('#windows .si')].map(e => (e as HTMLElement).dataset.sid));
    expect(shown).toEqual(after);
  });
});

// ── 묶음 C — 창 닫기 ──

test.describe('묶음 C — 창 닫기의 활성 창 (FR-CLS-*)', () => {
  test('V-CLS-1·2: 일반 창을 닫아도 Git 탭으로 떨어지지 않는다', async ({ page }) => {
    await init(page);
    // Git 창을 만든다 — 리포 없이도 창 자체는 선다 (FR-GIT-26).
    await page.evaluate(() => (window as any).app.openGitWindow());
    await expect
      .poll(() => page.evaluate(() => (window as any).app.ws.windows.filter((w: any) => w.type === 'git').length))
      .toBe(1);
    // 일반 창으로 돌아가 그 창을 닫는다. 남는 것은 Git 창뿐인 상황이다.
    const plain = await page.evaluate(() => {
      const app = (window as any).app;
      const w = app.ws.windows.find((x: any) => x.type !== 'git');
      app.switchWindow(w.id);
      return w.id;
    });
    await page.evaluate(id => (window as any).app.delWindow(id), plain);
    await expect
      .poll(() => page.evaluate(() => {
        const app = (window as any).app;
        const a = app.ws.windows.find((w: any) => w.id === app.ws.activeWindow);
        return (a && a.type) || 'terminal';
      }), { timeout: 10000 })
      .toBe('terminal');
    // FR-CLS-2: 일반 창이 새로 만들어졌고, 사이드바 탭은 Windows 다.
    expect(await page.evaluate(() => (window as any).app._sbTab)).toBe('windows');
  });
});

// ── 묶음 M — 탭의 창 간 이동 ──

test.describe('묶음 M — 탭을 다른 창으로 (FR-MOV-*)', () => {
  test('V-MOV-1·2·9: 탭이 대상 창으로 옮겨지고 도구가 따라간다', async ({ page }) => {
    await init(page);
    // 원본 창에 탭 하나를 더한다 — 마지막 탭은 옮길 수 없다 (FR-MOV-4).
    const src = await page.evaluate(async () => {
      const app = (window as any).app;
      await app.addTab(app.focused, 'terminal', {});
      const win = app.ws.windows.find((w: any) => w.id === app.ws.activeWindow);
      const pane = win.layout.type === 'pane' ? win.layout : null;
      return { winId: win.id, paneId: pane.id, tabId: pane.activeTab, toolId: pane.tabs.find((t: any) => t.id === pane.activeTab).toolId };
    });
    const dstId = await page.evaluate(async () => {
      const app = (window as any).app;
      const r = await app._mkWindow({ keepFocus: true });
      app.render();
      return r.win;
    });
    // 옮기기 전에 원본 창을 활성으로 되돌린다 — 이동은 활성 창에서 나간다.
    await page.evaluate(id => (window as any).app.switchWindow(id), src.winId);
    await page.evaluate(a => (window as any).app._moveTabToWindow(a.paneId, a.tabId, a.dst),
      { paneId: src.paneId, tabId: src.tabId, dst: dstId });

    const where = await page.evaluate(tabId => {
      const app = (window as any).app;
      for (const w of app.ws.windows) {
        let hit: any = null;
        const walk = (n: any) => {
          if (!n || hit) return;
          for (const t of n.tabs || []) if (t.id === tabId) hit = { win: w.id, toolId: t.toolId };
          for (const c of n.children || []) walk(c);
        };
        walk(w.layout);
        if (hit) return hit;
      }
      return null;
    }, src.tabId);
    expect(where?.win).toBe(dstId);
    // FR-MOV-9: 도구를 다시 만들지 않는다.
    expect(where?.toolId).toBe(src.toolId);
    // FR-MOV-8: 옮긴 창으로 따라간다.
    expect(await page.evaluate(() => (window as any).app.ws.activeWindow)).toBe(dstId);
  });

  test('V-MOV-3: 창의 마지막 탭은 옮겨지지 않는다', async ({ page }) => {
    await init(page);
    const src = await page.evaluate(() => {
      const app = (window as any).app;
      const win = app.ws.windows.find((w: any) => w.id === app.ws.activeWindow);
      return { winId: win.id, paneId: win.layout.id, tabId: win.layout.activeTab };
    });
    const dstId = await page.evaluate(async () => {
      const app = (window as any).app;
      const r = await app._mkWindow({ keepFocus: true });
      app.render();
      return r.win;
    });
    await page.evaluate(id => (window as any).app.switchWindow(id), src.winId);
    await page.evaluate(a => (window as any).app._moveTabToWindow(a.paneId, a.tabId, a.dst),
      { paneId: src.paneId, tabId: src.tabId, dst: dstId });
    const stillHome = await page.evaluate(a => {
      const app = (window as any).app;
      const w = app.ws.windows.find((x: any) => x.id === a.winId);
      return !!w && JSON.stringify(w.layout).includes(a.tabId);
    }, src);
    expect(stillHome).toBe(true);
  });
});

// ── 묶음 D — Runs 모달 삭제 버튼 ──

test.describe('묶음 D — Run 삭제 (FR-DEL-*)', () => {
  test('V-DEL-1·2·3: 삭제는 확인을 거치고, 버튼 클릭이 대시보드를 열지 않는다', async ({ page }) => {
    await init(page);
    const toolId = await page.evaluate(() => {
      const app = (window as any).app;
      const w = app.ws.windows.find((x: any) => x.id === app.ws.activeWindow);
      return w.layout.tabs[0].toolId;
    });
    // Run 하나를 연다. 조정자는 이 창의 도구다 — 살아 있으므로 수거되지 않는다.
    // 앞선 스펙이 남긴 Run 이 목록에 있을 수 있으므로 **이 Run 의 행**만 본다.
    const runId = await page.evaluate(async ([tid]) => {
      const r = await fetch('/api/runs', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ objective: 'e2e 삭제 대상', projection: 'dedicated-window', toolId: tid }),
      });
      return (await r.json()).id;
    }, [toolId]);

    await page.locator('#runs-btn').click();
    const row = page.locator(`#runs-modal .runs-row[data-runid="${runId}"]`);
    await expect(row).toBeVisible({ timeout: 10000 });
    const tabsBefore = await page.locator('.pn-tab').count();

    // FR-DEL-3: 첫 클릭은 확인이다.
    await row.locator('.runs-del').click();
    await expect(row.locator('.runs-confirm')).toBeVisible();
    // FR-DEL-2: 여기까지 탭이 하나도 늘지 않았다 — 대시보드가 열리지 않았다.
    expect(await page.locator('.pn-tab').count()).toBe(tabsBefore);

    await row.locator('.runs-yes').click();
    // FR-DEL-5: 그 행이 목록에서 사라진다.
    await expect(row).toHaveCount(0, { timeout: 10000 });
  });
});

// ── 묶음 F — 대시보드 맞춤 ──

test.describe('묶음 F — 대시보드 맞춤 (FR-FIT-*)', () => {
  test('V-FIT-2·3: 좁은 칸에서 축소되고, 넓은 칸에서 확대되지 않는다', async ({ page }) => {
    await init(page);
    const toolId = await page.evaluate(() => {
      const app = (window as any).app;
      const w = app.ws.windows.find((x: any) => x.id === app.ws.activeWindow);
      return w.layout.tabs[0].toolId;
    });
    const runId = await page.evaluate(async ([tid]) => {
      const r = await fetch('/api/runs', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ objective: 'e2e fit', projection: 'dedicated-window', toolId: tid }),
      });
      return (await r.json()).id;
    }, [toolId]);
    await page.evaluate(async ([id]) => {
      const app = (window as any).app;
      await app.addTab(app.focused, 'run', { runId: id, short: String(id).slice(0, 8) });
    }, [runId]);

    const svg = page.locator('.run-view .run-graph');
    await expect(svg).toBeVisible({ timeout: 10000 });
    // 멤버가 없으면 그래프 폭은 RUN_MIN_W(720)이다. 1280 뷰포트에서는 축소되지
    // 않아야 한다 (FR-FIT-3).
    await expect.poll(async () => Number(await svg.getAttribute('width')), { timeout: 10000 }).toBe(720);

    // 칸을 좁힌다 — 사이드바를 넓혀 콘텐츠를 줄인다.
    await page.setViewportSize({ width: 700, height: 720 });
    await expect
      .poll(async () => Number(await svg.getAttribute('width')), { timeout: 10000 })
      .toBeLessThan(720);
    // FR-FIT-2: 비율이 유지된다 (viewBox 는 그대로, width/height 가 같은 비로 준다).
    const [w, h] = await Promise.all([svg.getAttribute('width'), svg.getAttribute('height')]);
    const vb = (await svg.getAttribute('viewBox'))!.split(' ').map(Number);
    expect(Math.abs(Number(w) / vb[2] - Number(h) / vb[3])).toBeLessThan(0.02);
  });
});

// ── 묶음 N — 도구 이름의 단일 출처 ──

test.describe('묶음 N — 도구 이름 (FR-NAM-*)', () => {
  test('V-NAM-1·2·5: 백그라운드 모달이 파생 이름을 쓴다', async ({ page }) => {
    await init(page);
    // 탭 둘을 만든다 — 하나를 백그라운드로 보내도 창에 탭이 남아야 한다.
    const toolId = await page.evaluate(async () => {
      const app = (window as any).app;
      await app.addTab(app.focused, 'terminal', {});
      const win = app.ws.windows.find((w: any) => w.id === app.ws.activeWindow);
      const pane = app._flattenPanes(win.layout)[0];
      const tab = pane.tabs.find((t: any) => t.id === pane.activeTab);
      return tab.toolId;
    });
    // 서버의 tool_foreground SSE 를 흉내낸다 (FR-TAN-8) — 조회가 아니라 적용을 잰다.
    await page.evaluate(([id]) =>
      (window as any).app._onToolForeground({ toolId: id, name: 'vim' }), [toolId]);
    // 도구를 떼어 낸다 — 탭이 사라지므로 이름을 아는 자리는 파생 이름뿐이다.
    await page.evaluate(([id]) =>
      (window as any).app._execRemote('detachTab', { toolId: id }), [toolId]);

    await page.locator('#sb-bg-btn').click();
    const row = page.locator(`#bg-modal .bg-row[data-toolid="${toolId}"]`);
    await expect(row).toBeVisible({ timeout: 10000 });
    // FR-NAM-5: `Shell` 이 아니라 그 도구가 지금 돌리는 것의 이름이다.
    await expect(row.locator('.bg-name')).toHaveText('vim');
  });

  test('V-NAM-3: 수동으로 준 이름이 파생 이름을 이긴다', async ({ page }) => {
    await init(page);
    const toolId = await page.evaluate(async () => {
      const app = (window as any).app;
      await app.addTab(app.focused, 'terminal', { name: '비평가' });
      const win = app.ws.windows.find((w: any) => w.id === app.ws.activeWindow);
      const pane = app._flattenPanes(win.layout)[0];
      return pane.tabs.find((t: any) => t.id === pane.activeTab).toolId;
    });
    await page.evaluate(([id]) =>
      (window as any).app._onToolForeground({ toolId: id, name: 'vim' }), [toolId]);
    const shown = await page.evaluate(([id]) =>
      (window as any).app._toolName(id, 'Shell'), [toolId]);
    expect(shown).toBe('비평가');
  });
});

// ── 묶음 K — 브라우저 기본 키 차단 ──

test.describe('묶음 K — 브라우저 기본 키 차단 (FR-KEY-*)', () => {
  test('V-KEY-1·2·4: 매칭 없는 Ctrl 조합은 막고, 예외는 통과시킨다', async ({ page }) => {
    await init(page);
    const probe = (code: string, key: string, ctrl = true) => page.evaluate(([c, k, ctrlKey]) => {
      const e = new KeyboardEvent('keydown', { code: c as string, key: k as string, ctrlKey: !!ctrlKey, bubbles: true, cancelable: true });
      window.dispatchEvent(e);
      return e.defaultPrevented;
    }, [code, key, ctrl] as any);

    // Ctrl+S 는 어느 단축키에도 없다 — 브라우저 저장을 막는다.
    expect(await probe('KeyS', 's')).toBe(true);
    // FR-KEY-4: 복사·새로고침은 그대로 둔다.
    expect(await probe('KeyC', 'c')).toBe(false);
    expect(await probe('F5', 'F5', false)).toBe(false);
    // FR-KEY-2: 수식키 없는 글자는 대상이 아니다.
    expect(await probe('KeyS', 's', false)).toBe(false);

    // FR-KEY-6: 끄면 기본 동작이 돌아온다.
    await page.evaluate(() => { (0, eval)('blockBrowserKeys = false') });
    expect(await probe('KeyS', 's')).toBe(false);
    await page.evaluate(() => { (0, eval)('blockBrowserKeys = true') });
  });
});

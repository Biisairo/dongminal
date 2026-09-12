import {
  test, expect, waitForInit as fxWaitForInit, waitSettled, gotoSettled,
} from './fixtures';

/**
 * CONVENIENCE_SRS 묶음 N — 전경 프로세스 기반 탭 이름 (FR-TAN-*).
 *
 * 서버 절반(TIOCGPGRP · 캐시 · IPC · SSE)은 Go 테스트가 고정한다. 여기서 재는
 * 것은 **브라우저가 그 값으로 무엇을 하는가**다 — 누가 파생 이름을 받고, 누가
 * 받지 않으며, 무엇이 워크스페이스에 저장되는가.
 *
 * 전경 이름 자체를 실제 프로세스로 만들지 않고 SSE 를 직접 흉내내는 이유는
 * 결정론이다. `vim` 을 띄우고 2초 폴링을 기다리면 CI 에서 흔들린다 — 이 스펙이
 * 재려는 것은 조회가 아니라 적용이다. 조회는 toolhub 쪽 테스트가 이미 잡는다.
 */

/**
 * 이 스펙이 흉내내는 전경 이름의 **스냅숏 쪽**이다.
 *
 * 복원(`_fgRestore`)은 `/api/state` 를 진실로 삼아 그 밖의 이름을 지우고, SSE 가
 * 재연결될 때마다 다시 돈다. 이 스펙은 결정론을 위해 실제 프로세스를 띄우지
 * 않으므로(파일 머리 주석), SSE 만 흉내내면 두 진실이 어긋난다 — 재연결이 끼는
 * 순간 방금 넣은 이름이 지워지고, 그것이 이 스펙이 흔들리던 사유였다.
 *
 * 그래서 `pushForeground` 가 넣는 값을 스냅숏 응답에도 실어 준다. 서버를 고치는
 * 것이 아니라 **흉내를 두 경로에 일관되게** 내는 것이다.
 */
const fgStub = new Map<string, string>();

async function installStateStub(page) {
  fgStub.clear();
  await page.route('**/api/state', async (route) => {
    // 페이지가 닫히는 중이거나 요청이 취소되면 fetch 도 fulfill 도 던진다. 가로채기가
    // 검사를 죽이면 안 되므로, 실패하면 손대지 않고 원래 요청으로 흘려보낸다.
    let res: any, j: any;
    try {
      res = await route.fetch();
      j = await res.json();
    } catch {
      try { await route.fallback(); } catch { /* 이미 끝난 요청이다 */ }
      return;
    }
    for (const t of j.tools || []) {
      const n = fgStub.get(t.id);
      if (n) t.fgName = n;
    }
    try { await route.fulfill({ response: res, json: j }); } catch { /* 위와 같다 */ }
  });
}

async function waitForInit(page) {
  // stub 은 `page.route()` 이므로 goto 전에 Node 쪽에서 걸어야 한다 (FR-RST-15).
  await installStateStub(page);
  await fxWaitForInit(page);
}

// 활성 pane 의 첫 탭 정보를 꺼낸다.
async function firstTab(page) {
  return page.evaluate(() => {
    const app = (window as any).app;
    const win = app.ws.windows.find((s: any) => s.id === app.ws.activeWindow);
    const pane = app.testing.flattenPanes(win.layout)[0];
    const tab = pane.tabs[0];
    return { id: tab.id, name: tab.name, nameSource: tab.nameSource, toolId: tab.toolId, paneId: pane.id };
  });
}

/**
 * 서버가 보내는 renameTab 명령을 흉내낸다.
 *
 * **좌표를 넘긴다.** dmctl 은 uuid 를 보내지만 서버의 `translateLocationUUID`
 * (commands.go)가 그것을 좌표(`W1.P1.T1`)로 바꿔 SSE 에 싣는다 — 브라우저의
 * `_resolveLocation` 이 푸는 것은 좌표뿐이다. 여기서 uuid 를 그대로 넣으면
 * 서버 한 단계를 건너뛴 채 "대상 없음" 으로 조용히 끝난다.
 */
async function renameRemote(page, coord: string, args: Record<string, unknown>) {
  await page.evaluate(([c, a]) =>
    (window as any).app.testing.execRemote('renameTab', Object.assign({ location: c }, a)),
    [coord, args] as any);
}

// 활성 창의 첫 pane 첫 탭을 가리키는 좌표. 서버가 내는 라벨과 같은 형식이다.
const FIRST_TAB_COORD = 'W1.P1.T1';

// 서버가 보내는 tool_foreground SSE 를 흉내낸다 (FR-TAN-8).
async function pushForeground(page, toolId: string, name: string) {
  // 스냅숏과 SSE 를 함께 움직인다 (installStateStub 참조).
  if (name) fgStub.set(toolId, name); else fgStub.delete(toolId);
  await page.evaluate(([id, n]) => (window as any).app.testing.onToolForeground({ toolId: id, name: n }),
    [toolId, name]);
}

function labelOf(page, tabId: string) {
  return page.locator(`.pn-tab[data-tab-id="${tabId}"] .pn-tab-label`);
}

test.describe('전경 프로세스 기반 탭 이름 (묶음 N)', () => {
  // V-TAN-1: auto 탭은 파생 이름을 받는다 (FR-TAN-15 + FR-TAN-17 탭 바).
  test('V-TAN-1 auto 탭이 파생 이름을 보인다', async ({ page }) => {
    await waitForInit(page);
    const tab = await firstTab(page);
    expect(tab.name).toBe('Shell');
    await pushForeground(page, tab.toolId, 'vim');
    await expect(labelOf(page, tab.id)).toHaveText('vim');
  });

  // V-TAN-2/3: 전경 프로그램이 끝나면 기본값으로 돌아간다 (FR-TAN-12).
  // 이름은 현재 상태의 표시이지 이력이 아니다.
  test('V-TAN-2 전경 프로그램이 끝나면 Shell 로 돌아간다', async ({ page }) => {
    await waitForInit(page);
    const tab = await firstTab(page);
    await pushForeground(page, tab.toolId, 'vim');
    await expect(labelOf(page, tab.id)).toHaveText('vim');
    await pushForeground(page, tab.toolId, '');
    await expect(labelOf(page, tab.id)).toHaveText('Shell');
  });

  // V-TAN-4: 에이전트가 준 이름(dmctl rename-tab)은 manual 이며 덮이지 않는다.
  test('V-TAN-4 rename 후 프로세스가 떠도 이름이 유지된다', async ({ page }) => {
    await waitForInit(page);
    const tab = await firstTab(page);
    await renameRemote(page, FIRST_TAB_COORD, { name: '비평가' });
    await expect(labelOf(page, tab.id)).toHaveText('비평가');
    await pushForeground(page, tab.toolId, 'vim');
    await expect(labelOf(page, tab.id)).toHaveText('비평가');
    expect((await firstTab(page)).nameSource).toBe('manual');
  });

  // V-TAN-5: UI 더블클릭 이름변경도 같은 자격이다 (FR-TAN-2).
  test('V-TAN-5 더블클릭 이름변경 후 프로세스가 떠도 이름이 유지된다', async ({ page }) => {
    await waitForInit(page);
    const tab = await firstTab(page);
    await labelOf(page, tab.id).dblclick();
    await page.locator('.rename-input').fill('내작업');
    await page.keyboard.press('Enter');
    await expect(labelOf(page, tab.id)).toHaveText('내작업');
    await pushForeground(page, tab.toolId, 'vim');
    await expect(labelOf(page, tab.id)).toHaveText('내작업');
  });

  // V-TAN-6: 빈 문자열은 거부가 아니라 **자동 복귀 명령**이다 (FR-TAN-21).
  test('V-TAN-6 빈 이름을 넣으면 auto 로 돌아가 다시 파생된다', async ({ page }) => {
    await waitForInit(page);
    const tab = await firstTab(page);
    await labelOf(page, tab.id).dblclick();
    await page.locator('.rename-input').fill('내작업');
    await page.keyboard.press('Enter');
    expect((await firstTab(page)).nameSource).toBe('manual');

    await labelOf(page, tab.id).dblclick();
    await page.locator('.rename-input').fill('');
    await page.keyboard.press('Enter');
    const back = await firstTab(page);
    expect(back.nameSource).toBeUndefined();
    expect(back.name).toBe('Shell');
    await pushForeground(page, tab.toolId, 'vim');
    await expect(labelOf(page, tab.id)).toHaveText('vim');
  });

  // V-TAN-6 (에이전트 경로) — FR-TAN-22.
  test('V-TAN-6 dmctl rename-tab --auto 가 같은 일을 한다', async ({ page }) => {
    await waitForInit(page);
    const tab = await firstTab(page);
    await renameRemote(page, FIRST_TAB_COORD, { name: '비평가' });
    expect((await firstTab(page)).nameSource).toBe('manual');
    await renameRemote(page, FIRST_TAB_COORD, { auto: true });
    const back = await firstTab(page);
    expect(back.nameSource).toBeUndefined();
    expect(back.name).toBe('Shell');
  });

  // V-TAN-7/8: nameSource 가 없는 구 워크스페이스를 읽는 규칙 (FR-TAN-4).
  // 로드가 아니라 **읽는 자리**에서 정하므로 순수 함수로 잰다.
  test('V-TAN-7/8 nameSource 없는 구 워크스페이스의 읽기 규칙', async ({ page }) => {
    await waitForInit(page);
    const got = await page.evaluate(() => ({
      shell: (window as any).tabNameSource({ type: 'terminal', name: 'Shell' }),
      named: (window as any).tabNameSource({ type: 'terminal', name: '내작업' }),
      // FR-TAN-3: editor·run 은 이름이 콘텐츠에서 파생되므로 manual 고정이다.
      editor: (window as any).tabNameSource({ type: 'editor', name: 'a.go' }),
      run: (window as any).tabNameSource({ type: 'run', name: 'Run 1234abcd' }),
    }));
    expect(got.shell).toBe('auto');
    expect(got.named).toBe('manual');
    expect(got.editor).toBe('manual');
    expect(got.run).toBe('manual');
  });

  // V-TAN-12: 설정을 끄면 **즉시** 전 탭이 복귀한다 (FR-TAN-19/20).
  test('V-TAN-12 설정을 끄면 즉시 복귀하고 켜면 다시 파생된다', async ({ page }) => {
    await waitForInit(page);
    const tab = await firstTab(page);
    await pushForeground(page, tab.toolId, 'vim');
    await expect(labelOf(page, tab.id)).toHaveText('vim');

    await page.click('#settings-btn');
    await page.click('.mtab[data-tab="display"]');
    await page.uncheck('#ds-fgnames');
    await expect(labelOf(page, tab.id)).toHaveText('Shell');
    await page.check('#ds-fgnames');
    await expect(labelOf(page, tab.id)).toHaveText('vim');
    await page.click('#modal-close');
  });

  // V-TAN-14: 파생 이름은 워크스페이스에 저장되지 않는다 (FR-TAN-16).
  // 저장하면 재시작 후 죽은 프로세스의 이름이 남고, 2초마다 바뀌는 값이
  // 워크스페이스 쓰기를 폭증시킨다.
  test('V-TAN-14 파생 이름이 workspace 에 저장되지 않는다', async ({ page, request }) => {
    await waitForInit(page);
    const tab = await firstTab(page);
    await pushForeground(page, tab.toolId, 'vim');
    await expect(labelOf(page, tab.id)).toHaveText('vim');
    // 파생 이후에 워크스페이스를 쓰게 만든다 — 저장 경로가 파생 이름을 집어
    // 가는지 보려면 저장이 한 번 일어나야 한다.
    await page.evaluate(() => (window as any).app.testing.save());
    await waitSettled(page);

    const r = await request.get('/api/workspace');
    const raw = await r.text();
    expect(raw).not.toContain('"name":"vim"');
    // 저장된 것은 사용자가 준 이름뿐이다.
    expect(raw).toContain('"name":"Shell"');
  });

  // V-TAN-15: 화면이 내는 이름과 상태가 같은 규칙에서 나온다 (FR-TAN-17).
  // 탭 바 라벨과 `tabName()` 이 어긋나면 dmctl(FR-TAN-18)도 같이 어긋난다.
  test('V-TAN-15 탭 바 라벨이 tabName 규칙과 일치한다', async ({ page }) => {
    await waitForInit(page);
    const tab = await firstTab(page);
    await pushForeground(page, tab.toolId, 'claude');
    const computed = await page.evaluate((tid) => {
      const app = (window as any).app;
      const win = app.ws.windows.find((s: any) => s.id === app.ws.activeWindow);
      const t = app.testing.flattenPanes(win.layout)[0].tabs.find((x: any) => x.id === tid);
      return (window as any).tabName(t, app.testing.fgNames);
    }, tab.id);
    expect(computed).toBe('claude');
    await expect(labelOf(page, tab.id)).toHaveText('claude');
  });

  // V-TAN-18: 이름을 위해 브라우저가 새 주기 요청을 만들지 않는다 (FR-TAN-8, C-3).
  // 값이 SSE 로 오는 동안 네트워크가 조용해야 한다.
  test('V-TAN-18 이름만을 위한 새 폴링 요청이 없다', async ({ page }) => {
    await waitForInit(page);
    const tab = await firstTab(page);
    const urls: string[] = [];
    page.on('request', (r) => urls.push(r.url()));
    await pushForeground(page, tab.toolId, 'vim');
    await expect(labelOf(page, tab.id)).toHaveText('vim');
    // **예외 (`TEST-16`)**: 그 창 동안 `/api/state` 를 **긁지 않음**을 잰다.
    await page.waitForTimeout(3000);
    // 파생 이름이 붙고 유지되는 동안 state 를 다시 긁지 않는다.
    expect(urls.filter((u) => u.includes('/api/state'))).toHaveLength(0);
  });
});

/**
 * 묶음 NAM — **파생 이름이 쓰이는 자리들** (FR-NAM-*).
 *
 * 이 파일이 재는 탭 이름과 같은 값이다 — 백그라운드 모달·에이전트 패널도 그것을
 * 쓰고, 수동으로 준 이름이 그것을 이긴다.
 *
 * `TEST-7` 로 `ux-revision` 에서 옮겨 왔다 — 납품 묶음이 아니라 **이 기능**이
 * 주제인 자리다. 단정은 옮기면서 바꾸지 않았다.
 */

test.describe('묶음 N — 도구 이름 (FR-NAM-*)', () => {
  test('V-NAM-1·2·5: 백그라운드 모달이 파생 이름을 쓴다', async ({ page }) => {
    await gotoSettled(page);
    // 탭 둘을 만든다 — 하나를 백그라운드로 보내도 창에 탭이 남아야 한다.
    const toolId = await page.evaluate(async () => {
      const app = (window as any).app;
      await app.addTab(app.focused, 'terminal', {});
      const win = app.ws.windows.find((w: any) => w.id === app.ws.activeWindow);
      const pane = app.testing.flattenPanes(win.layout)[0];
      const tab = pane.tabs.find((t: any) => t.id === pane.activeTab);
      return tab.toolId;
    });
    // 서버의 tool_foreground SSE 를 흉내낸다 (FR-TAN-8) — 조회가 아니라 적용을 잰다.
    await page.evaluate(([id]) =>
      (window as any).app.testing.onToolForeground({ toolId: id, name: 'vim' }), [toolId]);
    // 도구를 떼어 낸다 — 탭이 사라지므로 이름을 아는 자리는 파생 이름뿐이다.
    await page.evaluate(([id]) =>
      (window as any).app.testing.execRemote('detachTab', { toolId: id }), [toolId]);

    await page.locator('#bg-btn').click();
    const row = page.locator(`#bg-modal .bg-row[data-toolid="${toolId}"]`);
    await expect(row).toBeVisible({ timeout: 10000 });
    // FR-NAM-5: `Shell` 이 아니라 그 도구가 지금 돌리는 것의 이름이다.
    await expect(row.locator('.bg-name')).toHaveText('vim');
  });

  test('V-NAM-4: 에이전트 패널도 파생 이름을 쓴다', async ({ page }) => {
    await gotoSettled(page);
    const toolId = await page.evaluate(() => {
      const app = (window as any).app;
      const win = app.ws.windows.find((w: any) => w.id === app.ws.activeWindow);
      return win.layout.tabs[0].toolId;
    });
    // 에이전트 패널은 활동이 관측된 도구만 카드로 만든다.
    await page.evaluate(([id]) => {
      const app = (window as any).app;
      app.testing.onToolActivity({ toolId: id, state: 'working', tool: 'Bash' });
      if (!document.getElementById('agents-panel')!.classList.contains('open')) app.testing.agentsToggle();
    }, [toolId]);
    await expect(page.locator('#agents-panel .ag-card')).toHaveCount(1, { timeout: 10000 });

    await page.evaluate(([id]) =>
      (window as any).app.testing.onToolForeground({ toolId: id, name: 'claude' }), [toolId]);
    // 전경 이름이 바뀌면 카드가 **그 자리에서** 따라간다 — 폴링을 기다리지 않는다.
    await expect(page.locator('#agents-panel .ag-card .ag-loc')).toContainText('claude', { timeout: 5000 });
  });

  test('V-NAM-3: 수동으로 준 이름이 파생 이름을 이긴다', async ({ page }) => {
    await gotoSettled(page);
    const toolId = await page.evaluate(async () => {
      const app = (window as any).app;
      await app.addTab(app.focused, 'terminal', { name: '비평가' });
      const win = app.ws.windows.find((w: any) => w.id === app.ws.activeWindow);
      const pane = app.testing.flattenPanes(win.layout)[0];
      return pane.tabs.find((t: any) => t.id === pane.activeTab).toolId;
    });
    await page.evaluate(([id]) =>
      (window as any).app.testing.onToolForeground({ toolId: id, name: 'vim' }), [toolId]);
    const shown = await page.evaluate(([id]) =>
      (window as any).app.testing.toolName(id, 'Shell'), [toolId]);
    expect(shown).toBe('비평가');
  });
});

// ── 묶음 K — 브라우저 기본 키 차단 ──


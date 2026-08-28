import { test, expect } from './fixtures';

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

async function waitForInit(page) {
  await page.context().addInitScript(() => {
    sessionStorage.setItem('displayMode', 'desktop');
  });
  await page.goto('/');
  await page.waitForSelector('#area .pn.focused .xterm-helper-textarea', { timeout: 15000 });
}

// 활성 pane 의 첫 탭 정보를 꺼낸다.
async function firstTab(page) {
  return page.evaluate(() => {
    const app = (window as any).app;
    const win = app.ws.windows.find((s: any) => s.id === app.ws.activeWindow);
    const pane = app._flattenPanes(win.layout)[0];
    const tab = pane.tabs[0];
    return { id: tab.id, name: tab.name, nameSource: tab.nameSource, toolId: tab.toolId, paneId: pane.id };
  });
}

// 서버가 보내는 tool_foreground SSE 를 흉내낸다 (FR-TAN-8).
async function pushForeground(page, toolId: string, name: string) {
  await page.evaluate(([id, n]) => (window as any).app._onToolForeground({ toolId: id, name: n }),
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
    await page.evaluate(([tid, pid]) =>
      (window as any).app._execRemote('renameTab', { location: tid, name: '비평가' }),
      [tab.id, tab.paneId]);
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
    await page.evaluate((tid) =>
      (window as any).app._execRemote('renameTab', { location: tid, name: '비평가' }), tab.id);
    expect((await firstTab(page)).nameSource).toBe('manual');
    await page.evaluate((tid) =>
      (window as any).app._execRemote('renameTab', { location: tid, auto: true }), tab.id);
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
    await page.evaluate(() => (window as any).app._save());
    await page.waitForTimeout(500);

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
      const t = app._flattenPanes(win.layout)[0].tabs.find((x: any) => x.id === tid);
      return (window as any).tabName(t, app._fgNames);
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
    await page.waitForTimeout(3000);
    // 파생 이름이 붙고 유지되는 동안 state 를 다시 긁지 않는다.
    expect(urls.filter((u) => u.includes('/api/state'))).toHaveLength(0);
  });
});

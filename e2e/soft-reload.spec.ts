import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { APIRequestContext, Page } from '@playwright/test';

import { test, expect } from './fixtures';

// SOFT_RELOAD_SRS §5 — V-SRL-1~9.
//
// **재는 것은 "다시 가져왔는가" 와 "버리지 않았는가" 둘이다.** 페이지 새로고침과
// 다른 점이 후자에 있으므로(§2.3), xterm 인스턴스가 **그대로인지**가 이 기능의
// 정체를 가르는 검사다 (V-SRL-5).

const btn = (page: Page) => page.locator('#soft-reload-btn');

async function enter(page: Page) {
  await page.context().addInitScript(() => { sessionStorage.setItem('displayMode', 'desktop') });
  await page.goto('/');
  await page.waitForSelector('#area .pn.focused .xterm-helper-textarea', { timeout: 15000 });
  await page.waitForFunction(() => !!(window as any).app?.softReload, undefined, { timeout: 15000 });
}

test.describe('내부 새로고침 (SOFT_RELOAD_SRS)', () => {
  test('SR1 (V-SRL-1): 버튼을 누르면 서버 상태를 다시 받는다', async ({ page }) => {
    await enter(page);

    const asked: string[] = [];
    page.on('request', r => { if (r.url().includes('/api/state')) asked.push(r.url()) });

    await btn(page).click();
    await expect.poll(() => asked.length, { timeout: 15000 }).toBeGreaterThan(0);
  });

  test('SR2 (V-SRL-5): 터미널이 다시 붙되 **같은** xterm 인스턴스다', async ({ page }) => {
    await enter(page);

    // 인스턴스 동일성의 표식을 심는다. pane 을 다시 만들면 이 표식이 사라진다 —
    // 그것이 곧 페이지 새로고침과 같아졌다는 뜻이다 (D-3).
    const marked = await page.evaluate(() => {
      const app = (window as any).app;
      let n = 0;
      for (const p of app.tools.values()) { if (p && p.term) { (p as any).__mark = 'keep'; n++ } }
      return n;
    });
    expect(marked, '검사할 터미널이 없다').toBeGreaterThan(0);

    const opened: string[] = [];
    page.on('websocket', ws => opened.push(ws.url()));

    await btn(page).click();
    // V-SRL-4: 전부 다시 붙는다 (D-2).
    await expect.poll(() => opened.length, { timeout: 20000 }).toBeGreaterThan(0);

    // 표식이 남아 있어야 한다.
    const kept = await page.evaluate(() => {
      const app = (window as any).app;
      let n = 0;
      for (const p of app.tools.values()) { if ((p as any).__mark === 'keep') n++ }
      return n;
    });
    expect(kept, 'pane 이 다시 만들어졌다 — 페이지 새로고침과 다를 것이 없다').toBe(marked);
  });

  test('SR2b (V-SRL-10): 재연결 뒤 오버레이가 사라진다 — 화면이 실제로 돌아온다', async ({ page }) => {
    await enter(page);

    // **이 검사가 없어서 결함이 나갔다.** SR2 는 WS 가 열리는지만 봤고, 연결이
    // 붙었는데도 "다시 연결" 오버레이가 남는 것을 잡지 못했다 — 사용자에게는
    // 그것이 곧 "연결 안 됨" 이다.
    // 오버레이는 `.tp-overlay.visible` 로 선다.
    const overlays = () => page.evaluate(() => {
      const app = (window as any).app;
      let visible = 0;
      for (const p of app.tools.values()) {
        const ov = p?.el?.querySelector?.('.tp-overlay');
        if (ov && ov.classList.contains('visible')) visible++;
      }
      return visible;
    });

    await btn(page).click();

    // **재연결이 끝나기를 먼저 기다린다.** `expect.poll(…).toBe(0)` 만 걸면
    // 클릭 직후 오버레이가 뜨기도 전에 평가해 0 을 받고 그대로 통과한다 —
    // 그래서 이 검사가 처음에는 결함을 놓쳤다.
    await page.waitForFunction(() => {
      const app = (window as any).app;
      for (const p of app.tools.values()) { if (p?.ws?.readyState !== 1) return false }
      return true;
    }, undefined, { timeout: 20000 });
    // 붙은 뒤 오버레이를 지우는 타이머는 300ms 다. 넉넉히 지나고도 남아 있으면
    // 그것이 사용자에게는 "연결 안 됨" 이다.
    await page.waitForTimeout(2000);
    expect(await overlays(), '연결은 붙었는데 오버레이가 남아 있다').toBe(0);

    // 그리고 실제로 붙어 있어야 한다.
    const open = await page.evaluate(() => {
      const app = (window as any).app;
      let n = 0;
      for (const p of app.tools.values()) { if (p?.ws?.readyState === 1) n++ }
      return n;
    });
    expect(open, '재연결 뒤 열린 소켓이 없다').toBeGreaterThan(0);
  });

  test('SR3 (V-SRL-2): 도는 중에 다시 눌러도 한 번만 돈다', async ({ page }) => {
    await enter(page);

    const ran = await page.evaluate(async () => {
      const app = (window as any).app;
      // 두 번째 호출은 즉시 false 여야 한다 — 첫 번째가 아직 돌고 있다.
      const first = app.softReload();
      const second = await app.softReload();
      await first;
      return second;
    });
    expect(ran, '겹쳐 돌았다 — 낡은 응답이 새 것을 덮을 수 있다').toBe(false);
  });

  test('SR4 (V-SRL-3): SSE 가 닫혀 있으면 다시 연결한다', async ({ page }) => {
    await enter(page);
    await page.waitForFunction(() => (window as any).app?._sse?.readyState === 1, undefined, { timeout: 15000 });

    // 구독을 죽인다. 이 상태로 두면 화면은 다음 변화부터 다시 낡는다 (§2.2).
    await page.evaluate(() => { (window as any).app._sse.close() });
    expect(await page.evaluate(() => (window as any).app._sse.readyState)).toBe(2);

    await btn(page).click();
    await page.waitForFunction(
      () => (window as any).app?._sse?.readyState === 1, undefined, { timeout: 20000 });
  });

  test('SR5 (V-SRL-6): 사라진 도구로 판정된 pane 은 다시 붙지 않는다', async ({ page }) => {
    await enter(page);

    // FR-RCS-1 의 판정을 세운다. 되살리면 폭주가 돌아온다 (D-4).
    const n = await page.evaluate(() => {
      const app = (window as any).app;
      let k = 0;
      for (const p of app.tools.values()) { if (p) { p._exited = true; k++ } }
      return k;
    });
    expect(n).toBeGreaterThan(0);

    await page.evaluate(() => (window as any).app.softReload());
    const stillExited = await page.evaluate(() => {
      const app = (window as any).app;
      let k = 0;
      for (const p of app.tools.values()) { if (p && p._exited) k++ }
      return k;
    });
    expect(stillExited, '_exited 판정이 뒤집혔다 — 폭주가 되살아난다').toBe(n);
  });

  test('SR6 (V-SRL-7): 단축키가 앱의 기존 체계를 탄다 — 터미널 포커스에서도 동작한다', async ({ page }) => {
    await enter(page);

    // FR-SRL-9·10: 별도 리스너가 아니라 앱의 체계를 탄다. 그 사실은 두 자리에서
    // 보인다 — `executeAction` 이 그 이름을 알고, 설정의 Shortcuts 목록에 뜬다.
    // (`SHORTCUT_DEFAULTS` 는 고전 스크립트의 const 라 `window` 에 없다.)
    const known = await page.evaluate(() => {
      const app = (window as any).app;
      let called = false;
      const orig = app.softReload.bind(app);
      app.softReload = () => { called = true; return Promise.resolve(true) };
      app.executeAction('softReload');
      app.softReload = orig;
      return called;
    });
    expect(known, 'executeAction 이 softReload 를 모른다 — 체계 밖에 있다').toBe(true);

    await page.locator('#area .pn.focused .xterm-helper-textarea').focus();
    const asked: string[] = [];
    page.on('request', r => { if (r.url().includes('/api/state')) asked.push(r.url()) });

    await page.keyboard.press('Control+Shift+K');
    await expect.poll(() => asked.length, { timeout: 15000 }).toBeGreaterThan(0);
  });

  test('SR7 (V-SRL-8): 도는 동안 버튼이 그 사실을 보이고 끝나면 되돌아온다', async ({ page }) => {
    await enter(page);

    // busy 는 도는 동안만 선다. 끝난 뒤의 상태를 재는 것으로 "되돌아온다" 를 잡는다.
    await page.evaluate(() => (window as any).app.softReload());
    await expect(btn(page)).not.toHaveClass(/busy/, { timeout: 20000 });
    await expect(btn(page)).toBeEnabled();
  });

  // WORKBENCH_REVIEW_SRS FR-WBR-95 (검증 V-WBR-92).
  //
  // 이 단계는 **죽어 있었다** — `w.editor.refresh()` 를 불렀는데 `w.editor` 는 창
  // 레코드의 `{root, side, explorerWidth}` 라 `refresh` 가 없고, `typeof` 가드가
  // 그것을 조용히 삼켰다. 살아 있는 트리 뷰는 `_edTrees` 에 있다.
  test('SR8 (V-WBR-92 / FR-WBR-95): 내부 새로고침이 탐색기의 열린 겹을 다시 읽는다',
    async ({ page, request }) => {
      const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dm-srl-')));
      fs.mkdirSync(path.join(base, 'sub'));
      fs.writeFileSync(path.join(base, 'sub', 'a.txt'), 'A\n');
      const r = await request.post('/api/editors/add', { data: { path: base } });
      expect(r.ok(), `editors/add 실패: ${await r.text()}`).toBeTruthy();

      await enter(page);
      await page.waitForFunction(
        () => !!(window as any).app?._editors && (window as any).app._edWindows().length > 0,
        undefined, { timeout: 15000 });
      await page.evaluate((root) => {
        const a = (window as any).app;
        const win = a._edWindows().find((x: any) => x.editor && x.editor.root === root);
        a.switchWindow(win.id);
      }, base);
      await page.waitForSelector('.ed-win .ed-explorer .ed-tree', { timeout: 15000 });
      const sub = path.join(base, 'sub');
      await page.locator(`.ed-tree .ed-row[data-path="${sub}"]`).click();
      await expect(page.locator(`.ed-tree .ed-row[data-path="${path.join(sub, 'a.txt')}"]`))
        .toBeVisible({ timeout: 10000 });

      // 폴링을 세운다 — 3초 주기가 대신 읽어 주면 이 시험이 무엇을 재는지 알 수 없다.
      await page.evaluate(() => {
        const a = (window as any).app;
        if (a._edGitInterval) { clearInterval(a._edGitInterval); a._edGitInterval = null }
      });
      fs.writeFileSync(path.join(sub, 'b.txt'), 'B\n');
      // 폴링이 서 있으므로 저절로는 오지 않는다.
      await page.waitForTimeout(1000);
      await expect(page.locator(`.ed-tree .ed-row[data-path="${path.join(sub, 'b.txt')}"]`))
        .toHaveCount(0);

      await btn(page).click();
      // FR-EDT-64: 펼쳐진 겹만 다시 읽고 펼침은 보존된다.
      await expect(page.locator(`.ed-tree .ed-row[data-path="${path.join(sub, 'b.txt')}"]`))
        .toBeVisible({ timeout: 15000 });

      fs.rmSync(base, { recursive: true, force: true });
    });
});

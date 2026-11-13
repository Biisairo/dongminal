import { execFileSync } from 'child_process';
import { readFileSync, writeFileSync, mkdtempSync } from 'fs';
import { join } from 'path';

import { Page } from '@playwright/test';

import {
  test, expect, waitForInit, enterExplorer, rmTree, clickRow,
  makeCopyFx, openGit, gitFixture, cleanGitFixture,
} from './fixtures';
import { ED_SEL } from './editor';
import { TMP, realPath, tmpPath, cssPath } from './osenv';

/**
 * UX_BATCH10_SRS §4 — V-UXB-1·3·7·9·10·12·13.
 *
 * 접수된 일곱 건의 화면 쪽 검증이다. 저장소를 재는 것(어느 저장소에 닿는가)은
 * `web/js/test/window-local-state.test.mjs` 가 이미 센다 — 여기서 재는 것은
 * **사용자가 보는 결과**다. (서버의 반납은 걷혔다 — FOCUS_INITIAL_RESTORE_SRS.)
 */

const FIXTURES = tmpPath('dm-uxb10-fx-' + process.pid);
let BASE = '';
let ROOT = '';

test.beforeAll(() => {
  gitFixture(FIXTURES);
  BASE = realPath(mkdtempSync(join(TMP, 'dm-uxb10-')));
  ROOT = join(BASE, 'root');
  execFileSync('mkdir', ['-p', ROOT]);
  writeFileSync(join(ROOT, 'a.txt'), 'hello\n');
  ROOT = realPath(ROOT);
});
test.afterAll(() => {
  cleanGitFixture(FIXTURES);
  rmTree(BASE);
});

const copyFx = makeCopyFx(FIXTURES);
const git = (repo: string, ...args: string[]) =>
  execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });

// ─────────────────────────────────────────────────────────────────────
// 묶음 W — 창별 상태 (접수 1·7)
// ─────────────────────────────────────────────────────────────────────

test.describe('창의 치수는 창 밖으로 새지 않는다', () => {
  // V-UXB-1 · FR-UXB-1·2·3
  test('슬롯 방향은 같은 브라우저의 다른 창에 옮지 않는다', async ({ page }) => {
    await waitForInit(page);
    await page.evaluate(() => { (window as any).app.slotDir = 'vertical' });
    expect(await page.evaluate(() => sessionStorage.getItem('slotDir'))).toBe('vertical');
    // FR-UXB-1·4: 기기의 키에는 닿지 않는다.
    expect(await page.evaluate(() => localStorage.getItem('slotDir'))).toBeNull();

    // 같은 컨텍스트 = 같은 localStorage. 종전에는 이 창이 vertical 로 섰다.
    const p2 = await page.context().newPage();
    await p2.goto('/');
    await p2.waitForFunction(() => !!(window as any).app, undefined, { timeout: 15000 });
    expect(await p2.evaluate(() => (window as any).app.slotDir)).toBe('horizontal');

    // FR-UXB-3: 렌더가 몇 번 돌아도 첫 창의 값은 그대로다.
    await page.evaluate(() => { const a = (window as any).app; a.render(); a.render() });
    expect(await page.evaluate(() => (window as any).app.slotDir)).toBe('vertical');
    await p2.close();
  });

  // V-UXB-3 · FR-UXB-6·9·11
  test('사이드바 폭은 이 창의 것이고 서버로 가지 않는다', async ({ page, request }) => {
    await waitForInit(page);
    const sb = page.locator('#sb-handle');
    const box = (await sb.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + 90, box.y + box.height / 2, { steps: 8 });
    await page.mouse.up();

    const stored = await page.evaluate(() => sessionStorage.getItem('sidebarWidth'));
    expect(Number(stored)).toBeGreaterThan(150);

    // FR-UXB-6·8: 워크스페이스에는 실리지 않는다.
    expect(await page.evaluate(() => (window as any).app.ws.sidebarWidth)).toBeUndefined();
    const ws = await (await request.get('/api/workspace')).json();
    expect(ws.sidebarWidth, '폭이 서버에 올라갔다').toBeUndefined();

    // FR-UXB-9: 새 창은 기본 폭이다.
    const p2 = await page.context().newPage();
    await p2.goto('/');
    await p2.waitForFunction(() => !!(window as any).app, undefined, { timeout: 15000 });
    const w2 = await p2.evaluate(() => document.documentElement.style.getPropertyValue('--sb-w'));
    expect(w2, '다른 창이 이 창의 폭을 물려받았다').toBe('');
    await p2.close();

    // 같은 창의 새로고침은 그 값을 지킨다 — 첫 페인트 스크립트의 일이다.
    await page.reload();
    await page.waitForFunction(() => !!(window as any).app, undefined, { timeout: 15000 });
    expect(await page.evaluate(
      () => document.documentElement.style.getPropertyValue('--sb-w'))).toBe(stored + 'px');
  });

  // V-UXB-3 · FR-UXB-7
  test('탐색기 폭도 창의 것이다', async ({ page, request }) => {
    await waitForInit(page);
    await page.evaluate(() => (window as any).app.edSetSideWidth(300));
    expect(await page.evaluate(() => sessionStorage.getItem('repoSideWidth'))).toBe('300');
    expect(await page.evaluate(() => (window as any).app.ws.repoSideWidth)).toBeUndefined();
    expect(await page.evaluate(() => (window as any).app.edSideWidth())).toBe(300);
    const ws = await (await request.get('/api/workspace')).json();
    expect(ws.repoSideWidth, '탐색기 폭이 서버에 올라갔다').toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────
// 묶음 F — 포커스 (접수 6)
// ─────────────────────────────────────────────────────────────────────

/**
 * 크로스 기기 프록시는 `browser.newContext()` 다 — clientId 가 컨텍스트마다
 * 다르므로 서버 눈에 다른 기기다 (`focus-owner.spec.ts` 가 세운 규약).
 */
async function newClient(browser: any) {
  const ctx = await browser.newContext();
  await ctx.addInitScript(() => sessionStorage.setItem('displayMode', 'desktop'));
  const page = await ctx.newPage();
  await waitForInit(page);
  return { ctx, page };
}

const claim = (page: Page) =>
  page.evaluate(() => (window as any).app.setFocus((window as any).app.focused));

test.describe('놓은 창은 되찾을 수 있다', () => {
  /**
   * `FOCUS_INITIAL_RESTORE_SRS` 가 이 시험을 뒤집었다 (V-FIR-2).
   *
   *   이전 동작: B 가 blur 하면 소유권을 반납했고 A 의 dim 이 풀렸다 (FR-UXB-20~23)
   *   새  동작: blur 는 소유권을 놓지 않는다. A 는 dim 인 채이고, A 를 포커스하면
   *             그때 재획득해 다시 그리고 폭을 맞춘다 (초기 문서 FR-XDF-2 · E-7)
   *   이유:     반납이 만든 "주인 없는 창" 에서 A 는 dim 이 풀린 채 B 의 폭에 머물렀고
   *             (처음 접수된 결함), 그 구멍을 메우려던 돌려주기는 alt-tab 마다 폭을
   *             뒤집어 쓰기 어려웠다 (사용자, 2026-09-24). 초기 문서에는 둘 다 없었다
   *
   * 음의 단정을 시간으로 기다리지 않는다 (E2E_QUIESCENCE I-1). 반납은 blur 순간 B 의
   * **로컬 맵을 동기적으로** 지웠으므로, blur 직후 B 의 맵이 곧 판정이다.
   */
  test('빼앗아 간 쪽이 포커스를 잃어도 소유권은 그대로다 (FR-XDF-2)', async ({ browser, request }) => {
    const A = await newClient(browser);
    const B = await newClient(browser);
    const idB = await B.page.evaluate(() => (window as any).app.clientId);
    const w = await B.page.evaluate(() => (window as any).app.ws.activeWindow);

    await claim(A.page);
    await expect(B.page.locator('#area .pn.pn-dimmed')).toHaveCount(1, { timeout: 10000 });

    await claim(B.page);
    await expect(A.page.locator('#area .pn.pn-dimmed')).toHaveCount(1, { timeout: 10000 });

    const mine = await B.page.evaluate((win) => {
      window.dispatchEvent(new Event('blur'));
      return (window as any).app.testing.windowFocusOwner[win];
    }, w);
    expect(mine, 'blur 가 소유권을 놓았다 — 주인 없는 창이 다시 생긴다').toBe(idB);

    const r = await request.get('/api/focus');
    expect(((await r.json()).owners || {})[w], '서버가 소유권을 비웠다').toBe(idB);
    await expect(A.page.locator('#area .pn.pn-dimmed')).toHaveCount(1);

    await A.ctx.close();
    await B.ctx.close();
  });

  /**
   * V-UXB-8 · FR-UXB-26·27 — **돌아오면 곧바로 그리고, 곧바로 다시 묻는다.**
   *
   * 접수 2번("포커스가 돌아왔을 때 화면 재렌더 업데이트가 늦다")의 자리다. 두
   * 가지가 함께 비어 있었다: 포커스 복귀에 render 가 없었고, `TimerHub` 의
   * 되살림은 `visibilitychange` 에만 걸려 있어 **창을 오갈 때는 한 번도 돌지
   * 않았다** (`document.hidden` 이 양쪽 다 거짓이다).
   *
   * 그래서 재는 것도 둘이다 — 그린 횟수와, 멎어 있던 관측이 깨어났는가.
   */
  test('포커스가 돌아오면 그 자리에서 다시 그리고 폴링도 깨어난다', async ({ page }) => {
    await waitForInit(page);
    await page.evaluate(() => {
      const a = (window as any).app;
      (window as any).__renders = 0;
      const orig = a.render.bind(a);
      a.render = () => { (window as any).__renders++; orig() };
      // 주기가 아주 긴 job 하나. 다음 회차를 기다려서는 절대 돌지 않으므로,
      // 이것이 도는 것은 **되살림이 돌았다**는 뜻뿐이다.
      (window as any).__polls = 0;
      // `TIMERS` 는 전역 **어휘** 바인딩이라 `window` 에 없다 — 같은 realm 의
      // eval 로 집는다.
      const T = (globalThis as any).eval('TIMERS');
      T.every({
        id: 'uxb10-probe', every: () => 3600000, whenHidden: 'pause',
        run: () => { (window as any).__polls++ },
      });
    });

    const renders = () => page.evaluate(() => (window as any).__renders);
    const polls = () => page.evaluate(() => (window as any).__polls);
    expect(await polls()).toBe(0);
    const before = await renders();

    await page.evaluate(() => window.dispatchEvent(new Event('focus')));

    await expect.poll(renders, { timeout: 5000 }).toBeGreaterThan(before);
    await expect.poll(polls, { timeout: 5000 }).toBe(1);

    // 되살림은 회차마다 한 번이다 — 돌아올 때마다 같은 자리에서 한 번 더.
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect.poll(polls, { timeout: 5000 }).toBe(2);
  });

  // V-UXB-7 · FR-UXB-24 — 빼앗긴 쪽에 포커스가 돌아오면 다시 가져간다.
  // (반납을 걷은 뒤 중간 단정 "B 의 blur 로 A 의 dim 이 풀린다" 를 뺐다 —
  //  FOCUS_INITIAL_RESTORE_SRS. 되찾기의 계기는 포커스 하나다.)
  test('포커스가 돌아오면 이 창이 다시 주장한다', async ({ browser }) => {
    const A = await newClient(browser);
    const B = await newClient(browser);

    await claim(B.page);
    await expect(A.page.locator('#area .pn.pn-dimmed')).toHaveCount(1, { timeout: 10000 });

    await claim(A.page);
    await expect(B.page.locator('#area .pn.pn-dimmed')).toHaveCount(1, { timeout: 10000 });

    await B.page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(A.page.locator('#area .pn.pn-dimmed')).toHaveCount(1, { timeout: 10000 });
    await expect(B.page.locator('#area .pn.pn-dimmed')).toHaveCount(0);

    await A.ctx.close();
    await B.ctx.close();
  });
});

// ─────────────────────────────────────────────────────────────────────
// 묶음 D — diff 는 편집기다 (접수 4·5)
// ─────────────────────────────────────────────────────────────────────

const diffView = (page: Page) => page.locator('#area .pn-body .git-view.git-diff');
const tab = (page: Page, view: string) => page.locator(`#area .pn-tab[data-git-view="${view}"]`);
const changes = (page: Page) => page.locator('#area .ed-side .git-view.git-changes');

/**
 * 워킹 트리에서 고친 파일 하나의 Diff 탭을 연다.
 *
 * `clickRow` 로 누른다 — 목록은 관측이 닿을 때마다 다시 그려지고, 그 사이의
 * 클릭은 선택을 남기지 않는다 (FR-RST-12). 실제로 이 스펙이 혼자 돌 때는 되고
 * 앞선 검사와 함께 돌 때만 "파일을 선택하세요" 에서 멎었다 — 창이 늘수록
 * 관측이 잦아진 것뿐이며, 견디는 쪽은 테스트다.
 */
async function openDiff(page: Page, path: string) {
  // **탭을 먼저 세운다.** 행을 먼저 누르면 확인할 표면이 아직 본문에 없다.
  await tab(page, 'diff').click();
  await expect(diffView(page)).toHaveClass(/vis/);
  const row = changes(page).locator(`.git-file[data-path="${cssPath(path)}"]`).first();
  await expect(row).toBeVisible({ timeout: 15000 });
  await clickRow(page, row, async () => {
    await page.waitForFunction(
      () => edT.diffReady(edT.diffPanel()._diffView), undefined, { timeout: 8000 });
  });
}

async function openPanel(page: Page, tab: string) {
  await page.click('#settings-btn');
  await expect(page.locator('#modal-overlay')).toHaveClass(/open/, { timeout: 10000 });
  await page.click(`.mtab[data-tab="${tab}"]`);
  await expect(page.locator(`#panel-${tab}`)).toBeVisible({ timeout: 10000 });
}

async function closePanel(page: Page) {
  await page.click('#modal-close');
  await expect(page.locator('#modal-overlay')).not.toHaveClass(/open/, { timeout: 10000 });
}

/** 설정 스위치 하나를 켜고 끈다 — 사용자가 지나는 길 그대로다. */
async function setSwitch(page: Page, id: string, on: boolean) {
  await openPanel(page, 'code');
  const cb = page.locator('#' + id);
  if (on) await cb.check(); else await cb.uncheck();
  await closePanel(page);
}

const modOpt = (page: Page, key: string) => page.evaluate((k) => {
  return edT.option(edT.diffSide(edT.diffPanel()._diffView, 'mod'), k);
}, key);

test.describe('diff 는 편집기와 같은 것을 한다', () => {
  // V-UXB-10 · FR-UXB-40
  test('줄바꿈 설정을 따르고, 열어 둔 채로 바꿔도 따라온다', async ({ page }) => {
    const repo = copyFx('basic', 'wrap');
    writeFileSync(join(repo, 'w.txt'), 'x'.repeat(400) + '\n');
    git(repo, 'add', 'w.txt'); git(repo, 'commit', '-m', 'w');
    writeFileSync(join(repo, 'w.txt'), 'y'.repeat(400) + '\n');

    await waitForInit(page);
    await setSwitch(page, 'ds-wordwrap', true);
    await openGit(page, repo);
    await openDiff(page, 'w.txt');

    expect(await modOpt(page, 'wordWrap'), 'diff 가 줄바꿈 설정을 받지 않았다').toBe('on');

    // FR-UXB-40: 열어 둔 채로 꺼도 따라온다 — 모델도 스크롤도 잃지 않는다.
    await setSwitch(page, 'ds-wordwrap', false);
    await expect.poll(() => modOpt(page, 'wordWrap')).toBe('off');
  });

  // V-UXB-12 · FR-UXB-42 — CODEMIRROR_MIGRATION_SRS FR-CMR-56 개정 (§3.16): Diff 에는 미니맵이 없고, 켜는 설정도 없다.
  test('diff 에는 미니맵이 없고 켜는 스위치도 없다', async ({ page }) => {
    const repo = copyFx('basic', 'mini');
    writeFileSync(join(repo, 'm.txt'), 'a\n'); git(repo, 'add', 'm.txt'); git(repo, 'commit', '-m', 'm');
    writeFileSync(join(repo, 'm.txt'), 'b\n');

    await waitForInit(page);
    await openGit(page, repo);
    await openDiff(page, 'm.txt');

    const width = await page.evaluate(() => edT.minimapWidth(edT.diffSide(edT.diffPanel()._diffView, 'mod')));
    expect(width).toBe(0);
    await openPanel(page, 'code');
    await expect(page.locator('#ds-diffminimap')).toHaveCount(0);
    await closePanel(page);
  });

  /**
   * V-UXB-14 · FR-UXB-47·48 — **언어 기능도 같은 곳을 딛는다.**
   *
   * 실제 gopls 로 잰다 (CODEMIRROR_MIGRATION_SRS §4.3). 작업 트리에만 있는 심볼(`helper2`)의 타입이
   * 보이면, 수정본 쪽이 디스크의 그 파일로 언어 서버에 열렸다는 뜻이다.
   */
  test('편집 가능 축의 diff 에서 호버가 그 파일의 내용으로 답한다', async ({ page }) => {
    const repo = copyFx('basic', 'lsp');
    writeFileSync(join(repo, 'go.mod'), 'module example.com/uxb\n\ngo 1.21\n');
    writeFileSync(join(repo, 'main.go'), 'package main\n\nfunc main() {\n}\n');
    git(repo, 'add', 'go.mod', 'main.go'); git(repo, 'commit', '-m', 'go');
    writeFileSync(join(repo, 'main.go'),
      'package main\n\nfunc helper2() int { return 2 }\n\nfunc main() {\n\thelper2()\n}\n');

    // 통로를 실제 서버에 잇고, gopls 가 그 파일을 다 읽은 신호(첫 진단 알림)를 본다.
    let ready = false;
    await page.routeWebSocket(/\/api\/lsp\/ws/, (ws) => {
      const server = ws.connectToServer();
      ws.onMessage((m) => server.send(m));
      server.onMessage((m) => {
        const o = JSON.parse(String(m));
        if (o.method === 'textDocument/publishDiagnostics' && decodeURIComponent(String(o.params.uri)).endsWith('main.go')) ready = true;
        ws.send(m);
      });
    });

    await waitForInit(page);
    await openGit(page, repo);
    await openDiff(page, 'main.go');
    await expect.poll(() => ready, { timeout: 60000, message: '수정본 쪽이 언어 서버에 열리지 않았다' }).toBe(true);

    await page.evaluate(() => {
      const d = edT.diffPanel()._diffView;
      const ed = edT.diffSide(d, 'mod');
      edT.focus(ed);
      edT.setCursor(ed, 6, 3);
      edT.showHover(ed);
    });
    await expect(diffView(page).locator(`${ED_SEL.surface} ${ED_SEL.hover}`).first())
      .toContainText('func helper2() int', { timeout: 15000 });

    // FR-UXB-48: 왼쪽은 **디스크의 파일이 아니다** — 과거의 내용이고, 그 좌표로
    // 받은 답은 없는 답보다 나쁘다. 그래서 경로를 답하지 않는다.
    const sides = await page.evaluate(() => {
      const d = edT.diffPanel()._diffView;
      return edT.diffLspPaths(d);
    });
    expect(sides.mod).toBeTruthy();
    expect(sides.orig, '원본 쪽이 디스크의 경로를 답했다').toBe('');
  });

  // V-UXB-13 · FR-UXB-44·45·46
  test('Mod+F 가 엔진 기본 패널이 아니라 편집기와 같은 패널을 연다', async ({ page }) => {
    const repo = copyFx('basic', 'find');
    writeFileSync(join(repo, 'f.txt'), 'alpha needle one\nbeta two\n');
    git(repo, 'add', 'f.txt'); git(repo, 'commit', '-m', 'f');
    writeFileSync(join(repo, 'f.txt'), 'alpha needle one\nbeta needle two\n');

    await waitForInit(page);
    await openGit(page, repo);
    await openDiff(page, 'f.txt');

    await diffView(page).locator(`${ED_SEL.surface} ${ED_SEL.text}`).last().click();
    await page.keyboard.press('Control+f');

    const panel = diffView(page).locator('.fe-find.vis');
    await expect(panel).toBeVisible({ timeout: 5000 });
    await expect(page.locator(`${ED_SEL.surface} ${ED_SEL.builtinFind}`),
      '엔진 기본 패널이 떴다 — 편집기 탭에서 이미 닫은 길이다').toHaveCount(0);

    await panel.locator('.fe-find-q').fill('needle');
    await expect(panel.locator('.fe-find-count')).toContainText('2', { timeout: 5000 });

    await page.keyboard.press('Escape');
    await expect(panel).toBeHidden({ timeout: 5000 });
  });

  // CODEMIRROR_MIGRATION_SRS §3.16 (M9) — 엔진 기본 찾기 패널은 Diff 뷰에도 없다.
  // 편집기 칸의 같은 검사는 `editor-find-panel` V-EFP-4 다. 모든 편집 표면이 앱 패널 하나를 쓴다.
  test('Diff 뷰에서 F3 · Mod+G · Mod+H 로도 엔진 기본 찾기 패널이 뜨지 않는다', async ({ page }) => {
    const repo = copyFx('basic', 'find-keys');
    writeFileSync(join(repo, 'f.txt'), 'alpha needle one\nbeta two\n');
    git(repo, 'add', 'f.txt'); git(repo, 'commit', '-m', 'f');
    writeFileSync(join(repo, 'f.txt'), 'alpha needle one\nbeta needle two\n');

    await waitForInit(page);
    await openGit(page, repo);
    await openDiff(page, 'f.txt');

    const body = diffView(page).locator(`${ED_SEL.surface} ${ED_SEL.text}`).last();
    for (const key of ['F3', 'Control+g', 'Control+h']) {
      await body.click();
      await page.keyboard.press(key);
      // **예외 (`TEST-16`)**: 패널이 **뜨지 않음**을 잰다.
      await page.waitForTimeout(300);
      await expect(diffView(page).locator(ED_SEL.builtinFind), `${key} 로 엔진 패널이 떴다`).toHaveCount(0);
      await page.keyboard.press('Escape');
    }
  });

  // FR-UXB-49 — 원본 쪽은 읽기 전용이지만 찾기는 된다. 포커스가 원본에 있으면 원본을 찾는다.
  test('나란히 보기에서 원본 쪽에 포커스가 있으면 찾기가 원본을 찾고, 원본은 고쳐지지 않는다', async ({ page }) => {
    const repo = copyFx('basic', 'find-orig');
    writeFileSync(join(repo, 'f.txt'), 'alpha one\noldword two\n');
    git(repo, 'add', 'f.txt'); git(repo, 'commit', '-m', 'f');
    writeFileSync(join(repo, 'f.txt'), 'alpha one\nnew two\n');

    // 나란히 보기는 본문 폭이 GIT_DIFF_INLINE_BREAKPOINT(900) 이상일 때만 선다. 기본
    // 1280px 창의 본문은 그보다 좁으므로 폭을 시험이 정한다.
    await page.setViewportSize({ width: 1600, height: 720 });
    await waitForInit(page);
    await openGit(page, repo);
    await openDiff(page, 'f.txt');
    await expect(diffView(page).locator(ED_SEL.diffSurface)).toHaveClass(/side-by-side/);

    const orig = diffView(page).locator(`.git-diff-side-orig ${ED_SEL.text}`);
    await orig.click();
    await page.keyboard.type('x');
    await page.keyboard.press('Control+f');

    const panel = diffView(page).locator('.fe-find.vis');
    await expect(panel).toBeVisible({ timeout: 5000 });
    await panel.locator('.fe-find-q').fill('oldword');
    await expect(panel.locator('.fe-find-count')).toContainText('1', { timeout: 5000 });
    expect(await page.evaluate(() =>
      edT.text(edT.diffSide(edT.diffPanel()._diffView, 'orig'))), '원본이 고쳐졌다').toBe('alpha one\noldword two\n');

    await page.keyboard.press('Escape');
    await expect(panel).toBeHidden({ timeout: 5000 });
  });
});

// 묶음 X 는 **맨 뒤다.** `enterExplorer` 가 등록하는 편집기 루트는 서버에 남고,
// 그 뒤의 검사는 창이 하나 더 있는 화면에서 시작한다 — Git 검사의 "지금 보는
// 패널" 판정이 그 한 창 때문에 흔들렸다 (실측). 순서로 푸는 것이 정직하다:
// 이 검사가 재는 것은 아이콘 치수뿐이고, 남기는 것은 루트 하나뿐이다.
// ─────────────────────────────────────────────────────────────────────
// 묶음 X — 탐색기 아이콘 (접수 3)
// ─────────────────────────────────────────────────────────────────────

test.describe('탐색기 머리의 아이콘', () => {
  // V-UXB-9 · FR-UXB-30·31·32·33
  test('세 아이콘이 키트의 파생 치수를 받고 UI 배율을 탄다', async ({ page, request }) => {
    await enterExplorer(page, request, ROOT);
    const icons = page.locator('.ed-head .ed-head-btn svg');
    await expect(icons).toHaveCount(3);

    const sizeOf = async () => (await icons.first().boundingBox())!.width;
    const base = await sizeOf();
    // 26px 버튼 × .68 ≈ 17.7 — 종전의 14px 고정보다 크다.
    expect(base).toBeGreaterThan(16);

    // FR-UXB-33: 트리의 행 높이는 그대로다.
    const row = (await page.locator('.ed-tree .ed-row').first().boundingBox())!;
    expect(Math.round(row.height)).toBe(22);

    /**
     * FR-UXB-32: UI 글자 크기를 키우면 아이콘도 커진다.
     *
     * **키운 것은 되돌린다.** 이 값은 브라우저가 아니라 **인스턴스의 설정**에
     * 살므로 컨텍스트를 새로 열어도 남고, 같은 워커의 뒤 스펙이 그것을 물려받는다
     * — 워커 사이의 격리(E2E_PARALLEL_SRS FR-EPL-1)는 워커 **안**을 다루지 않는다.
     *
     * 실측: 20 이 남으면 `mobile-keybar-touch` 의 TC-MTB-6·7 이 진다. 키바 버튼이
     * 넓어져 `↑` 의 중심이 뷰포트(412px) 밖(414px)으로 나가고, 그 좌표로 쏜 터치는
     * `elementFromPoint` 가 `null` 인 자리에 떨어져 롱프레스가 시작되지 않는다.
     * 전량을 **샤드로** 돌 때만 보인다 — 한 프로세스로 돌면 파일 순서가 달라진다.
     */
    const uifsBefore = await num0(page, 'ds-uifs');
    await setUifs(page, 20);
    await expect.poll(sizeOf).toBeGreaterThan(base);
    await setUifs(page, uifsBefore);
    await expect.poll(sizeOf).toBe(base);
  });
});

/** 설정의 수 하나를 읽는다 — 되돌릴 값을 상수로 적지 않기 위해서다. */
const num0 = (page: Page, id: string) =>
  page.evaluate((i) => Number((document.getElementById(i) as HTMLInputElement).value), id);

/** UI 글자 크기를 사용자가 지나는 길 그대로 바꾼다. */
async function setUifs(page: Page, v: number) {
  await page.click('#settings-btn');
  await expect(page.locator('#modal-overlay')).toHaveClass(/open/, { timeout: 10000 });
  await page.click('.mtab[data-tab="display"]');
  const num = page.locator('#ds-uifs');
  await expect(num).toBeVisible({ timeout: 10000 });
  await num.fill(String(v));
  await num.blur();
  await page.click('#modal-close');
  await expect(page.locator('#modal-overlay')).not.toHaveClass(/open/, { timeout: 10000 });
}

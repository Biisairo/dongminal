import { appendFileSync, writeFileSync } from 'fs';
import { join } from 'path';

import { Page } from '@playwright/test';

import {
  test, expect, waitForInit, openGit, makeCopyFx, gitFixture, cleanGitFixture,
} from './fixtures';
import { tmpPath } from './osenv';

// UX_BATCH6_SRS — 접수한 결함 16건의 화면 절반.

const FIXTURES = tmpPath('dm-git-fx-b6-' + process.pid);

test.beforeAll(() => { gitFixture(FIXTURES) });
test.afterAll(() => { cleanGitFixture(FIXTURES) });

const copyFx = makeCopyFx(FIXTURES);

// ── 묶음 T — 표시 ────────────────────────────────────

test('V-DSP-1 (FR-DSP-1): Repo 창의 사이드 기본 탭은 Changes 다', async ({ page }) => {
  const repo = copyFx('basic', 'b6-side');
  await waitForInit(page);
  // `openGit` 은 사이드를 명시로 바꾸므로 여기서는 쓰지 않는다 — 재려는 것이
  // 바로 그 **기본값**이다.
  await page.evaluate((r: string) => (window as any).app.openGitWindow(r), repo);
  await page.waitForSelector('#area .ed-win .ed-side', { timeout: 15000 });
  await expect(page.locator('#area .ed-side .git-view.git-changes')).toBeVisible({ timeout: 20000 });
  const side = await page.evaluate(() => {
    const a = (window as any).app;
    return a._edSideOf(a._aw());
  });
  expect(side).toBe('changes');
});

// FR-DSP-2: 이미 저장된 선택은 기본값이 바뀌어도 그대로다.
test('V-DSP-1 (FR-DSP-2): 저장된 사이드 선택은 유지된다', async ({ page }) => {
  const repo = copyFx('basic', 'b6-side-keep');
  await waitForInit(page);
  await page.evaluate((r: string) => (window as any).app.openGitWindow(r), repo);
  await page.waitForSelector('#area .ed-win .ed-side', { timeout: 15000 });
  await page.evaluate(() => {
    const a = (window as any).app;
    a._edSetSide(a._aw(), 'explorer');
  });
  await expect(page.locator('#area .ed-side .ed-explorer')).toBeVisible({ timeout: 10000 });
  const side = await page.evaluate(() => {
    const a = (window as any).app;
    return a._edSideOf(a._aw());
  });
  expect(side).toBe('explorer');
});

// ── 묶음 R — 스크롤 ──────────────────────────────────

// V-SCR-1 (FR-SCR-1·2): 변경 하나를 클릭해도 목록의 자리가 남는다.
//
// 원인은 `_rSide` 가 매 render 마다 `.ed-side-body` 를 새로 만들고 캐시된
// `.git-view` 를 그리로 옮기는 것이었다 — 문서에서 떼는 순간 안쪽 `.git-files` 의
// scrollTop 이 0 이 된다.
test('V-SCR-1 (FR-SCR-1·2): 변경을 클릭해도 목록 스크롤이 남는다', async ({ page }) => {
  const repo = copyFx('many-files', 'b6-scroll');
  await waitForInit(page);
  await openGit(page, repo);
  const list = page.locator('#area .ed-side .git-view.git-changes .git-files');
  await expect(list).toBeVisible({ timeout: 20000 });
  await expect(page.locator('#area .ed-side .git-file').first()).toBeVisible({ timeout: 20000 });

  await list.evaluate((el: HTMLElement) => { el.scrollTop = 400 });
  const before = await list.evaluate((el: HTMLElement) => el.scrollTop);
  expect(before, '목록이 스크롤되지 않았다 — 전제가 깨졌다').toBeGreaterThan(0);

  // 화면 안에 있는 행 하나를 누른다 (diff 를 여는 사용자 경로).
  await page.evaluate(() => {
    const l = document.querySelector('#area .ed-side .git-files') as HTMLElement;
    const lb = l.getBoundingClientRect();
    const row = [...document.querySelectorAll('#area .ed-side .git-file')].find((r) => {
      const b = r.getBoundingClientRect();
      return b.top > lb.top + 20 && b.bottom < lb.bottom;
    }) as HTMLElement;
    row.click();
  });
  await page.waitForTimeout(1200);
  const after = await page.locator('#area .ed-side .git-files').evaluate((el: HTMLElement) => el.scrollTop);
  expect(after, '목록이 맨 위로 돌아갔다').toBe(before);
});

// V-SCR-2 (FR-SCR-3): 본문의 git 뷰도 같은 자리에서 같은 것을 잃었다.
test('V-SCR-2 (FR-SCR-3): 본문 git 뷰의 스크롤도 render 를 건넌다', async ({ page }) => {
  const repo = copyFx('many-files', 'b6-scroll-view');
  await waitForInit(page);
  await openGit(page, repo);
  const list = page.locator('#area .ed-side .git-view.git-changes .git-files');
  await expect(page.locator('#area .ed-side .git-file').first()).toBeVisible({ timeout: 20000 });
  await list.evaluate((el: HTMLElement) => { el.scrollTop = 400 });
  await page.evaluate(() => (window as any).app.render());
  await page.waitForTimeout(300);
  const after = await page.locator('#area .ed-side .git-files').evaluate((el: HTMLElement) => el.scrollTop);
  expect(after).toBe(400);
});

// ── 묶음 V — 실시간 갱신 ─────────────────────────────

// V-GLV-1 (FR-GLV-1·2): diff 를 연 채 파일을 고치면 화면이 따라온다.
//
// 파일 **내용**의 변화는 관측으로 알 수 없다 — `git status` 는 이미 수정된 파일이
// 또 수정돼도 같은 줄을 낸다. 그래서 열려 있는 diff 는 관측 회차마다 다시 받는다.
test('V-GLV-1 (FR-GLV-1·2): 열어 둔 diff 가 파일 수정을 따라온다', async ({ page }) => {
  const repo = copyFx('basic', 'b6-diff-live');
  await waitForInit(page);
  await openGit(page, repo);
  await page.evaluate(() => {
    const a = (window as any).app;
    a.gitPanel.openView('diff');
  });
  await page.evaluate(() => {
    const row = document.querySelector('#area .ed-side .git-file[data-path="tracked.txt"]') as HTMLElement;
    if (row) row.click();
  });
  await expect(page.locator('#area .pn-body .git-view.git-diff .monaco-diff-editor'))
    .toBeVisible({ timeout: 30000 });

  const seen = async () => page.evaluate(() => {
    const p = (window as any).app.gitPanel;
    const v = p && p._diffView;
    return v && v._mod ? v._mod.getValue() : '';
  });
  await expect.poll(seen, { timeout: 20000 }).toContain('two');

  appendFileSync(join(repo, 'tracked.txt'), 'BATCH6-LIVE\n');
  // 폴링이 나르는 자리다 — 예산은 실패 백오프 상한을 견딘다 (FR-CEM-31).
  await expect.poll(seen, { timeout: 45000 }).toContain('BATCH6-LIVE');
});

// V-GLV-2 (FR-GLV-4): 칸을 늘렸다 줄여도 관측이 계속된다.
//
// `GitPanel.destroy()` 의 `_stop()` 이 **관측자의 공유 타이머**를 껐고, 다시 거는
// 자리가 없었다 — 남은 칸의 Git 창이 눈앞에 있는데도 갱신이 멎었다.
test('V-GLV-2 (FR-GLV-4): 칸을 줄여도 남은 패널의 관측이 산다', async ({ page }) => {
  const repo = copyFx('basic', 'b6-resettle');
  await waitForInit(page);
  await openGit(page, repo);
  const on = () => page.evaluate((r: string) => {
    const a = (window as any).app;
    const p = a._gitPanel(r, 0);
    return { pollOn: !!p._pollOn, ok: !!p._pollOk() };
  }, repo);
  expect((await on()).pollOn, '전제가 깨졌다 — 처음부터 관측이 멎어 있다').toBe(true);

  await page.evaluate(() => {
    const a = (window as any).app;
    a.slotAdd();
    a.render();
  });
  await page.waitForTimeout(500);
  await page.evaluate(() => {
    const a = (window as any).app;
    a.slotRemove();
    a.render();
  });
  await page.waitForTimeout(800);
  const got = await on();
  expect(got.ok, '칸을 줄인 뒤 관측 조건이 거짓이 됐다').toBe(true);
  expect(got.pollOn, '남은 패널이 있는데 폴링이 멎었다').toBe(true);

  // 그리고 실제로 따라온다 — 조건뿐 아니라 결과를 잰다.
  writeFileSync(join(repo, 'resettle.txt'), 'x\n');
  await expect(page.locator('#area .ed-side .git-file[data-path="resettle.txt"]'))
    .toHaveCount(1, { timeout: 45000 });
});

// ── 묶음 P — 미리보기와 스크롤바 ─────────────────────

// V-MMP-1 (FR-MMP-1): 미니맵 슬라이더와 스크롤바 슬라이더가 같은 자리에 선다.
test('V-MMP-1 (FR-MMP-1): 편집기의 미리보기가 스크롤바와 맞는다', async ({ page }) => {
  const repo = copyFx('basic', 'b6-minimap');
  const long = join(repo, 'long.txt');
  writeFileSync(long, Array.from({ length: 900 }, (_, i) => `line ${i} — 한글도 섞는다`).join('\n') + '\n');
  await waitForInit(page);
  await openGit(page, repo);
  await page.evaluate((p: string) => (window as any).app._edOpenFile(p, { pin: true }), long);
  await page.waitForFunction(() => {
    const eds = [...(window as any).app.fileEditors.values()];
    return eds.some((e: any) => e._editor);
  }, undefined, { timeout: 30000 });

  const got = await page.evaluate(async () => {
    const ed = [...(window as any).app.fileEditors.values()].find((e: any) => e._editor) as any;
    const e = ed._editor;
    e.setScrollTop(e.getScrollHeight() * 0.45);
    await new Promise((r) => setTimeout(r, 400));
    const box = ed.el.getBoundingClientRect();
    const rect = (sel: string) => {
      const x = ed.el.querySelector(sel);
      if (!x) return null;
      const r = x.getBoundingClientRect();
      return { top: Math.round(r.top - box.top), h: Math.round(r.height) };
    };
    return { mini: rect('.minimap-slider'), bar: rect('.scrollbar.vertical > .slider') };
  });
  expect(got.mini, '미니맵 슬라이더가 없다').not.toBeNull();
  expect(got.bar, '스크롤바 슬라이더가 없다').not.toBeNull();
  expect(got.mini).toEqual(got.bar);
});

// ── 묶음 I — IME 전송 순서 ───────────────────────────
//
// 접수한 말: "한글을 치고 엔터를 누르면 마지막글자 전에 엔터가 들어간다."
//
// 원인은 xterm 의 `CompositionHelper.keydown` 이다 — 조합 중에 다른 키를 보면 그
// 자리에서 `_finalizeComposition(false)` 로 **아직 낡은** 조각을 내보내고
// (`_compositionPosition.end` 가 setTimeout 으로 갱신되므로 한 글자 뒤진다),
// 이어서 그 키의 데이터를 보낸다.

async function termReady(page: Page) {
  await page.waitForSelector('#area .pn.focused .xterm-helper-textarea', { timeout: 25000 });
  await page.evaluate(() => {
    const p = (window as any).app._focusedTerminal();
    (window as any).__sent = [];
    const orig = p._send.bind(p);
    p._send = (m: Uint8Array) => {
      if (m[0] === 0) {
        const t = new TextDecoder().decode(m.subarray(1));
        // 포커스 보고(CSI I·O)는 사용자가 보낸 키가 아니다 — OS 마다 시각이 다르다.
        if (t !== '\x1b[I' && t !== '\x1b[O') (window as any).__sent.push(t);
      }
      return orig(m);
    };
    (p.el.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement).focus();
  });
}

const sent = (page: Page) => page.evaluate(() => ((window as any).__sent as string[]).join(''));

test('V-IME-1·3 (FR-IME-1·2·3): 조합 중 Enter 는 조합 문자열 뒤에 나간다', async ({ page }) => {
  await waitForInit(page);
  await termReady(page);
  await page.evaluate(async () => {
    const p = (window as any).app._focusedTerminal();
    const ta = p.el.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement;
    ta.value = '';
    ta.dispatchEvent(new CompositionEvent('compositionstart', { data: '', bubbles: true }));
    for (const d of ['ㅇ', '여', '여ㅈ', '여전', '여전히']) {
      ta.dispatchEvent(new CompositionEvent('compositionupdate', { data: d, bubbles: true }));
      ta.value = d;
    }
    // 데스크톱 Chrome 은 조합 중 Enter 를 keyCode 13 으로 낸다.
    ta.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
      bubbles: true, cancelable: true,
    } as any));
    ta.dispatchEvent(new CompositionEvent('compositionend', { data: '여전히', bubbles: true }));
    await new Promise((r) => setTimeout(r, 300));
  });
  const out = await sent(page);
  // 이전 결함은 `여전\r히` 류였다 — 조합의 마지막 글자가 Enter 뒤로 밀렸다.
  expect(out).toContain('여전히');
  expect(out.endsWith('\r'), `순서가 뒤집혔다: ${JSON.stringify(out)}`).toBe(true);
});

test('V-IME-2 (FR-IME-1): IME 가 나르는 키와 수식키는 보류하지 않는다', async ({ page }) => {
  await waitForInit(page);
  await termReady(page);
  const held = await page.evaluate(async () => {
    const p = (window as any).app._focusedTerminal();
    const ta = p.el.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement;
    ta.dispatchEvent(new CompositionEvent('compositionstart', { data: '', bubbles: true }));
    for (const kc of [229, 16, 17, 18]) {
      ta.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Unidentified', keyCode: kc, which: kc, bubbles: true, cancelable: true,
      } as any));
    }
    await new Promise((r) => setTimeout(r, 50));
    return (p._imeQ || []).length;
  });
  expect(held, '조합을 나르는 키를 붙잡았다 — 조합 자체가 깨진다').toBe(0);
});

// **정리 창** — 접수한 모바일 증상의 자리다. `compositionend` 가 확정 문자보다
// 먼저 와도 xterm 의 전송은 setTimeout 뒤이므로, 그 사이에 보낸 문자는 조합보다
// 앞선다 (" 여전히").
test('V-IME-1 (FR-IME-3): compositionend 뒤에 온 확정 문자도 조합 뒤에 나간다', async ({ page }) => {
  await waitForInit(page);
  await termReady(page);
  await page.evaluate(async () => {
    const p = (window as any).app._focusedTerminal();
    const ta = p.el.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement;
    ta.value = '';
    ta.dispatchEvent(new CompositionEvent('compositionstart', { data: '', bubbles: true }));
    ta.dispatchEvent(new CompositionEvent('compositionupdate', { data: '여전히', bubbles: true }));
    ta.value = '여전히';
    // 조합이 먼저 닫히고, 확정 문자가 그 뒤에 온다.
    ta.dispatchEvent(new CompositionEvent('compositionend', { data: '여전히', bubbles: true }));
    ta.dispatchEvent(new KeyboardEvent('keydown', {
      key: ' ', code: 'Space', keyCode: 32, which: 32, bubbles: true, cancelable: true,
    } as any));
    await new Promise((r) => setTimeout(r, 300));
  });
  const out = await sent(page);
  expect(out).toContain('여전히');
  expect(out.startsWith(' '), `확정 문자가 조합보다 앞섰다: ${JSON.stringify(out)}`).toBe(false);
  expect(out.endsWith(' '), `확정 문자가 나가지 않았다: ${JSON.stringify(out)}`).toBe(true);
});

test('V-IME-3 (FR-IME-5): 포커스를 잃어도 보류분은 갇히지 않는다', async ({ page }) => {
  await waitForInit(page);
  await termReady(page);
  await page.evaluate(async () => {
    const p = (window as any).app._focusedTerminal();
    const ta = p.el.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement;
    ta.dispatchEvent(new CompositionEvent('compositionstart', { data: '', bubbles: true }));
    ta.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true,
    } as any));
    ta.dispatchEvent(new FocusEvent('blur', { bubbles: false }));
    await new Promise((r) => setTimeout(r, 300));
  });
  expect(await sent(page)).toContain('\r');
});

// ── 묶음 N — 슬롯을 인지하는 점프 ────────────────────

// V-RUN-1 (FR-RUN-1): 점프하면 **포커스 칸이 그 창을 받는다.**
//
// 종전에는 `ws.activeWindow` 만 바꿨다. 슬롯 모드에서 무엇이 보이는가는
// `_slots.windows` 가 정하므로 아무 일도 일어나지 않았다 — Run 카드 클릭이
// 그 길을 지난다 (접수 ⑧).
//
// **포커스 칸을 옮기지 않는 것**이 요점이다 — 사용자가 서 있는 칸에 떠야 한다
// (FR-SVS-12). `switchWindow` 와 같은 한 줄을 지난다.
test('V-RUN-1 (FR-RUN-1): 점프하면 포커스 칸이 그 창을 받는다',
  async ({ page }) => {
    await waitForInit(page);
    const info = await page.evaluate(async () => {
      const a = (window as any).app;
      await a.addWindow();            // 둘째 창
      const wins = a._plainWindows();
      const w0 = wins[0], w1 = wins[wins.length - 1];
      a.slotAdd();
      a.slotOpen(0, w0.id);
      a.slotOpen(1, w1.id);
      a.slotFocusTo(0);
      a.render();
      return {
        focusedBefore: a._slotFocused(),
        slot0Before: a._slots.windows[0],
        target: w1.layout.tabs[0].toolId, w0: w0.id, w1: w1.id,
      };
    });
    expect(info.focusedBefore).toBe(0);
    expect(info.slot0Before).toBe(info.w0);
    expect(info.target).toBeTruthy();

    const after = await page.evaluate((toolId: string) => {
      const a = (window as any).app;
      a._jumpToTool(toolId);
      return { focused: a._slotFocused(), slot0: a._slots.windows[0], active: a.ws.activeWindow };
    }, info.target);
    expect(after.focused, '포커스 칸이 옮겨졌다 — FR-SVS-12 가 깨진다').toBe(0);
    expect(after.slot0, '포커스 칸이 그 창을 받지 않았다 — 화면은 그대로다').toBe(info.w1);
    expect(after.active).toBe(info.w1);
  });

// 단일 슬롯의 동작은 종전과 같다 (FR-RUN-2).
test('V-RUN-1 (FR-RUN-2): 단일 슬롯의 점프는 종전과 같다', async ({ page }) => {
  await waitForInit(page);
  const got = await page.evaluate(async () => {
    const a = (window as any).app;
    await a.addWindow();
    const wins = a._plainWindows();
    const w1 = wins[wins.length - 1];
    a.switchWindow(wins[0].id);
    const toolId = w1.layout.tabs[0].toolId;
    a._jumpToTool(toolId);
    return { active: a.ws.activeWindow, want: w1.id, slots: !!a._slots };
  });
  expect(got.slots, '단일 슬롯 전제가 깨졌다').toBe(false);
  expect(got.active).toBe(got.want);
});

// V-GLV-3 (FR-GLV-6): 거부당한 대상은 폴링이 다시 받지 않는다.
//
// FR-GLV-1 을 넣고 실측했을 때 잘못된 대상의 `/api/git/diff-content` 가 **매초
// 400 을 냈다** — 자동 재적재가 실패를 그만큼 되풀이한 것이다.
test('V-GLV-3 (FR-GLV-6): 거부당한 diff 는 폴링이 되풀이하지 않는다', async ({ page }) => {
  const repo = copyFx('basic', 'b6-refused');
  let hits = 0;
  await page.route('**/api/git/diff-content**', (route) => {
    hits++;
    route.fulfill({
      status: 500, contentType: 'application/json',
      body: JSON.stringify({ error: 'internal' }),
    });
  });
  await waitForInit(page);
  await openGit(page, repo);
  await page.evaluate(() => (window as any).app.gitPanel.openView('diff'));
  await page.evaluate(() => {
    const row = document.querySelector('#area .ed-side .git-file[data-path="tracked.txt"]') as HTMLElement;
    if (row) row.click();
  });
  await page.waitForTimeout(1500);
  const first = hits;
  expect(first, '거부 응답이 한 번도 오지 않았다 — 전제가 깨졌다').toBeGreaterThan(0);
  // 관측 주기(기본 3초)를 두 바퀴 넘게 기다린다.
  await page.waitForTimeout(8000);
  expect(hits, `거부당한 대상을 되풀이해 받았다 (${first} → ${hits})`).toBe(first);
});

// ── 묶음 N — closeTab 의 지목 ────────────────────────

// V-RUN-4 (FR-RUN-6a): 서버가 방송하는 `closeTab` 은 **탭 uuid** 로 지목한다.
// 좌표는 자리라 앞의 탭이 닫히면 뒤의 것이 밀린다.
test('V-RUN-4 (FR-RUN-6a): uuid 로 지목한 탭이 닫힌다', async ({ page }) => {
  await waitForInit(page);
  const got = await page.evaluate(async () => {
    const a = (window as any).app;
    await a.addTab();
    const win = a._aw();
    const tabs = win.layout.tabs;
    const victim = tabs[0].id;
    a._execRemote('closeTab', { location: victim, force: true });
    await new Promise((r) => setTimeout(r, 600));
    const left = (a._aw().layout.tabs || []).map((t: any) => t.id);
    return { victim, left };
  });
  expect(got.left, 'uuid 로 지목한 탭이 닫히지 않았다').not.toContain(got.victim);
});

// V-RUN-4 (FR-RUN-6b): 없는 자리를 지목하면 **아무것도 닫지 않는다.**
//
// 종전에는 포커스 탭이 닫혔다 — 이미 닫힌 탭을 한 번 더 닫으라는 요청이 사용자의
// 터미널을 없앴다.
test('V-RUN-4 (FR-RUN-6b): 없는 자리를 지목한 closeTab 은 아무것도 닫지 않는다',
  async ({ page }) => {
    await waitForInit(page);
    const got = await page.evaluate(async () => {
      const a = (window as any).app;
      const before = (a._aw().layout.tabs || []).map((t: any) => t.id);
      a._execRemote('closeTab', { location: 'no-such-tab-uuid', force: true });
      await new Promise((r) => setTimeout(r, 600));
      const after = (a._aw().layout.tabs || []).map((t: any) => t.id);
      return { before, after };
    });
    expect(got.after, '엉뚱한 탭을 닫았다').toEqual(got.before);
  });

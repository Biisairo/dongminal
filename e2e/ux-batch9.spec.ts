import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

import { Page } from '@playwright/test';

import { test, expect, waitForInit, openGit, gitFixture, cleanGitFixture } from './fixtures';
import { tmpPath, realPath } from './osenv';

// UX_BATCH9_SRS — 손이 한 일이 화면에 닿지 않는 세 자리.
//   묶음 A: 편집기의 Cmd+S (FR-ESV-1~5)
//   묶음 C: 조합 중의 수식키 (FR-IMK-1~3)
// 묶음 B(git 자동 갱신)는 M3 이며 이 파일에 나중에 합류한다.

const ROOT = tmpPath('dm-b9-' + process.pid);
const fx = () => realPath(ROOT);

// 묶음 B 는 진짜 저장소가 필요하다 — 관측이 도는지를 재기 때문이다.
const GITFX = tmpPath('dm-b9-git-' + process.pid);
const gfx = (name: string) => realPath(join(GITFX, name));

test.beforeAll(() => {
  mkdirSync(ROOT, { recursive: true });
  writeFileSync(join(ROOT, 'one.txt'), 'ONE-0\n');
  writeFileSync(join(ROOT, 'two.txt'), 'TWO-0\n');
  gitFixture(GITFX);
});
test.afterAll(() => {
  cleanGitFixture(GITFX);
});

// ── 묶음 A — 저장 ─────────────────────────────────────

/**
 * 편집기 창을 세우고 파일 하나를 연다. 패턴은 editor-git-ux.spec.ts 의
 * `openTextFileInEditor` 와 같다 — 포커스를 **Monaco 의 API 로** 준다.
 * 어느 요소가 입력을 받는지는 판마다 다르다 (0.56 은 EditContext 다).
 */
async function openEditorWindow(page: Page) {
  await page.evaluate(async (p) => {
    await fetch('/api/editors/add', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: p }),
    });
  }, fx());
  await expect
    .poll(async () => page.evaluate(async (p) => {
      const app = (window as any).app;
      await app._edReconcile?.();
      await app._edOpenWindow(p);
      return app._edSearchRoot();
    }, fx()), { timeout: 15000 })
    .not.toBe('');
}

async function openFile(page: Page, name: string) {
  await page.evaluate((f) => (window as any).app._edOpenFile(f), join(fx(), name));
  await expect
    .poll(() => page.evaluate((n) => {
      const app = (window as any).app;
      return [...app.fileEditors.values()].some((v: any) =>
        String(v.filePath).replace(/\\/g, '/').endsWith(n) && !!v._editor);
    }, name), { timeout: 30000 })
    .toBe(true);
}

/**
 * 그 파일의 탭을 활성으로 만든다.
 *
 * **연 것과 보고 있는 것은 다르다.** 뒤에 연 파일이 활성 탭이므로, 앞의 파일을
 * 만지려면 먼저 그리로 옮겨야 한다 — 숨은 편집기(`display:none`)는 포커스를
 * 받지 못하고 `activeElement` 는 직전 편집기에 남는다.
 *
 * 이 함수는 **글자를 넣기 전에** 부른다. 파일을 다시 여는 경로는 디스크의 내용을
 * 다시 실을 수 있고, 그러면 방금 넣은 것이 지워져 dirty 가 풀린다.
 */
async function activateFile(page: Page, name: string) {
  await page.evaluate((f) => (window as any).app._edOpenFile(f), join(fx(), name));
  await page.waitForTimeout(200);
}

/**
 * 그 파일의 편집기에 포커스를 준다. 탭은 건드리지 않는다.
 *
 * 포커스가 **그 편집기 안**인지까지 확인한다 — `.file-editor` 아무 곳이나로는
 * 위의 함정을 그대로 통과한다.
 */
async function focusOnly(page: Page, name: string) {
  const ok = await page.evaluate((n) => {
    const app = (window as any).app;
    const v = [...app.fileEditors.values()]
      .find((x: any) => String(x.filePath).replace(/\\/g, '/').endsWith(n)) as any;
    if (!v || !v._editor) return false;
    v._editor.focus();
    return document.activeElement?.closest('.file-editor') === v.el;
  }, name);
  expect(ok, '그 파일의 편집기 안에 포커스가 있어야 이 검사가 뜻을 갖는다').toBe(true);
}

// 내용을 고쳐 dirty 로 만든다. 모델을 직접 만지면 `onDidChangeModelContent` 가
// 도므로 실제 편집과 같은 자리를 지난다.
async function typeInto(page: Page, name: string, text: string) {
  await page.evaluate(({ n, t }) => {
    const app = (window as any).app;
    const v = [...app.fileEditors.values()]
      .find((x: any) => String(x.filePath).replace(/\\/g, '/').endsWith(n)) as any;
    v._editor.setValue(t);
  }, { n: name, t: text });
}

const saveKey = () => (process.platform === 'darwin' ? 'Meta+s' : 'Control+s');

test.describe('묶음 A — 저장은 내가 보고 있는 편집기가 한다', () => {
  // TC-ESV-1·2: 종전에는 `addCommand` 가 **전역**이라 마지막에 만든 편집기가
  // Cmd+S 를 가져갔다. 그쪽이 dirty 가 아니면 아무 일도 일어나지 않는다.
  test('TC-ESV-1·2: 편집기가 둘일 때 포커스가 있는 쪽이 저장된다', async ({ page }) => {
    await waitForInit(page, { clearLocalStorage: true });
    await openEditorWindow(page);
    await openFile(page, 'one.txt');
    await openFile(page, 'two.txt');          // 마지막에 만들어진 편집기

    await activateFile(page, 'two.txt');
    await typeInto(page, 'two.txt', 'TWO-DIRTY\n');
    await activateFile(page, 'one.txt');
    await typeInto(page, 'one.txt', 'ONE-SAVED\n');
    await focusOnly(page, 'one.txt');
    await page.keyboard.press(saveKey());

    await expect
      .poll(() => readFileSync(join(ROOT, 'one.txt'), 'utf8'), { timeout: 10000 })
      .toBe('ONE-SAVED\n');
    // 남의 저장이 일어나지 않는다.
    expect(readFileSync(join(ROOT, 'two.txt'), 'utf8')).toBe('TWO-0\n');
  });

  // TC-ESV-5: dirty 가 아니면 쓰기가 나가지 않는다.
  test('TC-ESV-5: dirty 가 아니면 쓰기 요청이 나가지 않는다', async ({ page }) => {
    await waitForInit(page, { clearLocalStorage: true });
    await openEditorWindow(page);
    await openFile(page, 'one.txt');
    await activateFile(page, 'one.txt');
    await focusOnly(page, 'one.txt');

    let writes = 0;
    page.on('request', (r) => { if (r.url().includes('/api/file/write')) writes++ });
    await page.keyboard.press(saveKey());
    await page.waitForTimeout(500);
    expect(writes).toBe(0);
  });

  // TC-ESV-3: 조합은 설정의 것이다 — 바꾼 값이 Monaco 안에서도 듣는다.
  test('TC-ESV-3: 저장 조합을 바꾸면 그 조합이 저장한다', async ({ page }) => {
    await waitForInit(page, { clearLocalStorage: true });
    await openEditorWindow(page);
    await openFile(page, 'one.txt');
    await page.evaluate(() => { (window as any).shortcuts.edSave = 'Mod+KeyU' });

    await activateFile(page, 'one.txt');
    await typeInto(page, 'one.txt', 'BY-ALT-KEY\n');
    await focusOnly(page, 'one.txt');
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+u' : 'Control+u');

    await expect
      .poll(() => readFileSync(join(ROOT, 'one.txt'), 'utf8'), { timeout: 10000 })
      .toBe('BY-ALT-KEY\n');
  });
});

// ── 묶음 C — 조합 중의 수식키 ──────────────────────────

// 전송을 가로채 순서를 본다. 패턴은 ux-batch6.spec.ts 의 것과 같다.
async function termReady(page: Page) {
  await page.waitForSelector('#area .pn.focused .xterm-helper-textarea', { timeout: 25000 });
  await page.evaluate(() => {
    const p = (window as any).app._focusedTerminal();
    (window as any).__sent = [];
    const orig = p._send.bind(p);
    p._send = (m: Uint8Array) => {
      if (m[0] === 0) {
        const t = new TextDecoder().decode(m.subarray(1));
        if (t !== '\x1b[I' && t !== '\x1b[O') (window as any).__sent.push(t);
      }
      return orig(m);
    };
    (p.el.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement).focus();
  });
}

const sent = (page: Page) => page.evaluate(() => ((window as any).__sent as string[]).join(''));

// 조합을 열고 한 글자를 만든 뒤, 주어진 키를 누르고 조합을 닫는다.
async function composeThenKey(page: Page, key: string, code: string, mods: Record<string, boolean>) {
  await page.evaluate(async ({ key, code, mods }) => {
    const p = (window as any).app._focusedTerminal();
    const ta = p.el.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement;
    ta.focus();
    ta.dispatchEvent(new CompositionEvent('compositionstart', { data: '', bubbles: true }));
    for (const d of ['ㅎ', '하', '한']) {
      ta.dispatchEvent(new CompositionEvent('compositionupdate', { data: d, bubbles: true }));
      ta.value = d;
    }
    ta.dispatchEvent(new KeyboardEvent('keydown', {
      key, code, bubbles: true, cancelable: true, ...mods,
    } as any));
    ta.dispatchEvent(new CompositionEvent('compositionend', { data: '한', bubbles: true }));
    await new Promise((r) => setTimeout(r, 400));
  }, { key, code, mods });
}

test.describe('묶음 C — 조합 중에는 어떤 키도 앞지르지 않는다', () => {
  // TC-IMK-1: 종전에는 `box` 의 keydown 리스너가 조합 게이트 **밖**이라
  // Home(0x01)이 조합 문자보다 먼저 나갔다.
  test('TC-IMK-1: 조합 중 Cmd+← 는 조합 문자 뒤에 나가고 한 번만 나간다', async ({ page }) => {
    await waitForInit(page);
    await termReady(page);
    await composeThenKey(page, 'ArrowLeft', 'ArrowLeft', { metaKey: true });

    const s = await sent(page);
    expect(s, `전송 순서=${JSON.stringify(s)}`).toContain('한');
    expect(s.indexOf('한')).toBeLessThan(s.indexOf('\x01'));
    expect(s.split('\x01').length - 1, '두 번 움직이면 안 된다').toBe(1);
  });

  // TC-IMK-2: Alt+← 도 같은 자리다.
  test('TC-IMK-2: 조합 중 Alt+← 도 조합 문자 뒤에 한 번만 나간다', async ({ page }) => {
    await waitForInit(page);
    await termReady(page);
    await composeThenKey(page, 'ArrowLeft', 'ArrowLeft', { altKey: true });

    const s = await sent(page);
    expect(s).toContain('한');
    expect(s.indexOf('한')).toBeLessThan(s.indexOf('\x1bb'));
    expect(s.split('\x1bb').length - 1).toBe(1);
  });

  // TC-IMK-3: 조합이 없을 때의 동작은 그대로다.
  test('TC-IMK-3: 조합이 없으면 Cmd+←/→ 는 종전대로 즉시 나간다', async ({ page }) => {
    await waitForInit(page);
    await termReady(page);
    await page.evaluate(() => {
      const p = (window as any).app._focusedTerminal();
      const ta = p.el.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement;
      for (const key of ['ArrowLeft', 'ArrowRight']) {
        ta.dispatchEvent(new KeyboardEvent('keydown', {
          key, code: key, metaKey: true, bubbles: true, cancelable: true,
        } as any));
      }
    });
    await page.waitForTimeout(200);
    expect(await sent(page)).toBe('\x01\x05');
  });
});

// ── 묶음 B — 멈춘 관측은 스스로 되살아난다 ──────────────

// 활성 패널 하나를 브라우저 안에서 집어 온다.
const PANEL = `const p = window.app.gitPanel;`;

async function panelState(page: Page) {
  return await page.evaluate(`(() => {${PANEL}
    return { pollOn: !!p._pollOn, lastObsAt: p._lastObsAt, repo: p.repo };
  })()`);
}

test.describe('묶음 B — 자동 갱신은 스스로 되살아난다', () => {
  // TC-GLR-1: 종전에는 폴링이 한 번 멎으면 밖에서 알려 주기 전까지 영영 멎어
  // 있었고, 그 사이 서버의 관심 표명도 만료돼 방송까지 함께 끊겼다 (SRS §2.3·2.4).
  test('TC-GLR-1: 폴링이 멎어 있으면 그리기 한 번에 되살아난다', async ({ page }) => {
    await waitForInit(page, { clearLocalStorage: true });
    await openGit(page, gfx('basic'));
    await expect.poll(async () => (await panelState(page)).lastObsAt, { timeout: 15000 })
      .toBeGreaterThan(0);

    // 계기가 새어 폴링이 멎은 상태를 만든다 — 관측도 낡혀 둔다.
    // 워치독의 검사 문턱(GIT_WATCHDOG_CHECK_MS)을 연다 — 방금 그린 직후라 그
    // 문턱이 닫혀 있고, 이 검사가 재려는 것은 문턱이 아니라 되살리기다.
    await page.evaluate(`(() => {${PANEL} p._stop(); p._lastObsAt = Date.now() - 5 * 60 * 1000; window.app._gitWdAt = 0 })()`);
    expect((await panelState(page)).pollOn).toBe(false);

    // 워치독의 계기는 이미 도는 것에 얹혀 있다 (D-4).
    await page.evaluate('window.app.render()');
    await expect.poll(async () => (await panelState(page)).pollOn, { timeout: 10000 }).toBe(true);
    // 되살아난 뒤에는 관측이 실제로 갱신된다.
    await expect
      .poll(async () => Date.now() - (await panelState(page)).lastObsAt, { timeout: 15000 })
      .toBeLessThan(60000);
  });

  // TC-GLR-2: 되살아난 뒤에는 창 밖의 변화가 새로고침 없이 들어온다.
  test('TC-GLR-2: 되살아난 뒤 창 밖에서 만든 변경이 새로고침 없이 들어온다', async ({ page }) => {
    await waitForInit(page, { clearLocalStorage: true });
    await openGit(page, gfx('basic'));
    await expect.poll(async () => (await panelState(page)).lastObsAt, { timeout: 15000 })
      .toBeGreaterThan(0);

    await page.evaluate(`(() => {${PANEL} p._stop(); p._lastObsAt = Date.now() - 5 * 60 * 1000; window.app._gitWdAt = 0 })()`);
    await page.evaluate('window.app.render()');
    await expect.poll(async () => (await panelState(page)).pollOn, { timeout: 10000 }).toBe(true);

    writeFileSync(join(gfx('basic'), 'watchdog-made.txt'), 'x\n');
    await expect
      // 목록의 키 이름을 박지 않는다 — 재려는 것은 "그 변경이 관측에 들어왔는가"
      // 하나이고, 응답의 모양은 이 검사의 관심 밖이다.
      .poll(() => page.evaluate(`(() => {${PANEL}
        return JSON.stringify(p._status || {}).includes('watchdog-made');
      })()`), { timeout: 20000 })
      .toBe(true);
  });

  // TC-GLR-3: 아무도 보지 않는 저장소를 깨우지 않는다 (FR-GLR-3).
  test('TC-GLR-3: 표면이 보이지 않으면 워치독이 깨우지 않는다', async ({ page }) => {
    await waitForInit(page, { clearLocalStorage: true });
    await openGit(page, gfx('basic'));
    await expect.poll(async () => (await panelState(page)).lastObsAt, { timeout: 15000 })
      .toBeGreaterThan(0);

    // 표면 판정을 거짓으로 만든 채 멈춘다.
    const woke = await page.evaluate(`(() => {${PANEL}
      p._stop();
      p._lastObsAt = Date.now() - 5 * 60 * 1000;
      const orig = p._pollOk.bind(p);
      p._pollOk = () => false;
      window.app._gitWdAt = 0;
      const r = p._watchdog();
      p._pollOk = orig;
      return r;
    })()`);
    expect(woke, '보이지 않는 표면을 깨웠다').toBe(false);
    expect((await panelState(page)).pollOn).toBe(false);
  });

  // TC-GLR-4: 정상 상태에서는 요청이 늘지 않는다 (FR-GLR-7).
  test('TC-GLR-4: 정상 폴링 중 워치독은 요청을 더하지 않는다', async ({ page }) => {
    await waitForInit(page, { clearLocalStorage: true });
    await openGit(page, gfx('basic'));
    await expect.poll(async () => (await panelState(page)).lastObsAt, { timeout: 15000 })
      .toBeGreaterThan(0);

    let n = 0;
    page.on('request', (r) => { if (r.url().includes('/api/git/status')) n++ });
    // 그리기를 여러 번 낸다 — 워치독의 계기가 그것이다.
    for (let i = 0; i < 10; i++) {
      await page.evaluate('window.app.render()');
      await page.waitForTimeout(60);
    }
    await page.waitForTimeout(500);
    expect(n, 'render 만으로 status 요청이 나갔다').toBe(0);
  });
});

/**
 * **저장은 내가 보고 있는 편집기가 한다** — FR-ESV-1~5.
 *
 * 종전에는 Monaco 의 `addCommand` 가 **전역**이라, 편집기를 둘 세우면 마지막에
 * 만든 쪽이 `Cmd+S` 를 가져갔다 — 보고 있는 편집기가 아니라. 그래서 이 파일이
 * 재는 것은 "저장되는가" 가 아니라 **누가 저장하는가** 다.
 *
 * `TEST-7` 로 `ux-batch9` 의 묶음 A 에서 옮겨 왔다. 단정은 그대로다.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

import { Page } from '@playwright/test';

import { test, expect, waitForInit } from './fixtures';
import { tmpPath, realPath } from './osenv';

const ROOT = tmpPath('dm-esv-' + process.pid);
const fx = () => realPath(ROOT);

test.beforeAll(() => {
  mkdirSync(ROOT, { recursive: true });
  writeFileSync(join(ROOT, 'one.txt'), 'ONE-0\n');
  writeFileSync(join(ROOT, 'two.txt'), 'TWO-0\n');
});

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
      await app.testing.edReconcile?.();
      await app.testing.edOpenWindow(p);
      return app.testing.edSearchRoot();
    }, fx()), { timeout: 15000 })
    .not.toBe('');
}

async function openFile(page: Page, name: string) {
  await page.evaluate((f) => (window as any).app.testing.edOpenFile(f), join(fx(), name));
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
  await page.evaluate((f) => (window as any).app.testing.edOpenFile(f), join(fx(), name));
  // 그 파일의 편집기가 실제로 활성이 된 뒤 돌아간다 — 고정 대기로는 아직 앞
  // 파일이 서 있는 화면을 다음 단계가 받는다.
  await expect
    .poll(() => page.evaluate(() => {
      const ed = (window as any).app.testing.edActiveEditor();
      return String((ed && ed.filePath) || '');
    }), { timeout: 10000 })
    .toContain(name);
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
    // **예외 (`TEST-16`)**: 쓰기가 **나가지 않음**을 잰다.
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

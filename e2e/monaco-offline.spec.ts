import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';

import { Page } from '@playwright/test';

import {
  test, expect, waitForInit, addEditorRoot, switchToEditorRoot, freshDir, rmTree,
} from './fixtures';
import { tmpPath, realPath } from './osenv';

// MONACO_VENDORING_SRS §4.4 — TC-MVN-15·16·17.
//
// **편집기가 인터넷 없이 선다.** 종전에는 `cdn.jsdelivr.net` 에서 Monaco 를 받았고,
// 그래서 폐쇄망·Tailscale 전용 배치에서 편집기·Diff 뷰가 통째로 서지 않았다.
//
// 재는 방법은 "외부로 나가는 요청을 전부 끊는 것" 이다. `page.route` 로 자기
// 서버 밖의 모든 요청을 **거절**하고, 그 상태에서 편집기가 뜨는지 본다.
// 벤더링이 되돌려지면(상수가 다시 CDN 을 가리키면) 이 스펙이 먼저 실패한다.

const ROOT = tmpPath('dm-monaco-offline-' + process.pid);

test.beforeAll(() => { mkdirSync(ROOT, { recursive: true }) });
test.afterAll(() => { rmTree(ROOT) });

/**
 * 자기 서버 밖으로 나가는 모든 요청을 끊는다.
 *
 * 돌려주는 배열에 **끊긴 URL 이 쌓인다** — 비어 있어야 통과다. 거절만 하고 세지
 * 않으면 "요청은 갔지만 실패해도 화면이 살아남았다" 와 "요청 자체가 없었다" 를
 * 구별할 수 없고, 이 스펙이 재려는 것은 후자다.
 */
async function cutExternal(page: Page, baseURL: string): Promise<string[]> {
  const blocked: string[] = [];
  await page.route('**/*', (route) => {
    const url = route.request().url();
    if (url.startsWith(baseURL) || url.startsWith('data:') || url.startsWith('blob:')) {
      return route.continue();
    }
    blocked.push(url);
    return route.abort();
  });
  return blocked;
}

function mkfile(name: string, body: string): string {
  const d = join(ROOT, name);
  freshDir(d);
  writeFileSync(join(d, 'sample.ts'), body);
  return realPath(d);
}

// TC-MVN-15: 외부를 끊은 채 파일을 열면 편집기가 뜨고 내용이 보인다.
test('TC-MVN-15: 인터넷 없이 편집기가 선다', async ({ page, request, baseURL }) => {
  const root = mkfile('open', 'const a: number = 1;\nconst b: number = 2;\n');
  const key = await addEditorRoot(request, root);

  const blocked = await cutExternal(page, baseURL!);
  await page.goto('/');
  await waitForInit(page);
  await switchToEditorRoot(page, key);

  await page.evaluate((f) => (window as any).app.testing.edOpenFile(f), join(root, 'sample.ts'));
  await expect(page.locator('.file-editor .monaco-editor')).toHaveCount(1, { timeout: 30000 });

  // 떴다는 것과 **내용을 들고 있다**는 것은 다르다. 로더만 서고 모델이 비면
  // 사용자에게는 빈 편집기다.
  const text = await page.evaluate(() => {
    const ed = (window as any).monaco.editor.getEditors()
      .find((e: any) => e.getDomNode()?.closest('.file-editor'));
    return ed?.getModel()?.getValue() ?? '';
  });
  expect(text).toContain('const a: number = 1;');

  // TC-MVN-17: 밖으로 나간 요청이 **하나도 없다.**
  expect(blocked, `외부로 나간 요청: ${blocked.join(' · ')}`).toEqual([]);
});

// TC-MVN-16: 같은 조건에서 Diff 뷰가 선다. Diff 는 Monaco 의 **다른 진입점**
// (`createDiffEditor`)이라 편집기가 뜬 것만으로는 이것이 뜬다고 말할 수 없다.
test('TC-MVN-16: 인터넷 없이 Diff 뷰가 선다', async ({ page, request, baseURL }) => {
  const root = mkfile('diff', 'one\ntwo\nthree\n');
  const key = await addEditorRoot(request, root);

  const blocked = await cutExternal(page, baseURL!);
  await page.goto('/');
  await waitForInit(page);
  await switchToEditorRoot(page, key);

  await page.evaluate((f) => (window as any).app.testing.edOpenFile(f), join(root, 'sample.ts'));
  await expect(page.locator('.file-editor .monaco-editor')).toHaveCount(1, { timeout: 30000 });

  // Diff 편집기를 직접 세운다. 화면 경로(git 창)를 지나면 저장소 픽스처가 필요하고,
  // 여기서 재려는 것은 **Monaco 의 diff 진입점이 벤더본으로 서는가** 하나다.
  const ok = await page.evaluate(async () => {
    const m = (window as any).monaco;
    const host = document.createElement('div');
    host.style.cssText = 'position:absolute;left:-9999px;width:400px;height:200px';
    document.body.appendChild(host);
    const de = m.editor.createDiffEditor(host, { automaticLayout: false });
    de.setModel({
      original: m.editor.createModel('one\ntwo\n', 'plaintext'),
      modified: m.editor.createModel('one\ntwo\nthree\n', 'plaintext'),
    });
    const mounted = !!host.querySelector('.monaco-diff-editor');
    de.dispose();
    host.remove();
    return mounted;
  });
  expect(ok, 'createDiffEditor 가 DOM 을 세우지 못했다').toBeTruthy();

  expect(blocked, `외부로 나간 요청: ${blocked.join(' · ')}`).toEqual([]);
});

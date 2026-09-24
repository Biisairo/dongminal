/**
 * REPO_FIX 03 §3A-7 (E-6) — 탭의 dirty 는 파생이다.
 *
 * `tab.dirty` 를 워크스페이스에 저장하면 새로고침·다른 기기에서 가짜 ● 가 남는다
 * (#45, N1). 라벨의 ● 는 매 렌더 문서 dirty 에서 파생하고, 저장본에는 없다.
 */
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';

import { test, expect, waitForInit } from './fixtures';
import { tmpPath, realPath } from './osenv';

const ROOT = tmpPath('dm-edd-' + process.pid);
const fx = () => realPath(ROOT);

test.beforeAll(() => {
  mkdirSync(ROOT, { recursive: true });
  writeFileSync(join(ROOT, 'a.txt'), 'A\n');
});

async function openA(page: any) {
  await page.evaluate(async (p: string) => {
    await fetch('/api/editors/add', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: p }) });
  }, fx());
  await expect.poll(async () => page.evaluate(async (p: string) => {
    const app = (window as any).app;
    await app.testing.edReconcile?.();
    await app.testing.edOpenWindow(p);
    return app.testing.edSearchRoot();
  }, fx()), { timeout: 15000 }).not.toBe('');
  await page.evaluate((f: string) => (window as any).app.testing.edOpenFile(f), join(fx(), 'a.txt'));
  await expect.poll(() => page.evaluate(() => [...(window as any).app.fileEditors.values()]
    .some((v: any) => String(v.filePath).endsWith('a.txt') && !!v._editor)), { timeout: 30000 }).toBe(true);
}

const label = (page: any) => page.locator('.pn-tab-label', { hasText: 'a.txt' }).first();

test('dirty ● 는 라벨에만 있고 워크스페이스 저장본에 없다', async ({ page, request }) => {
  await waitForInit(page);
  await openA(page);
  await page.evaluate(() => {
    const v = [...(window as any).app.fileEditors.values()].find((x: any) => String(x.filePath).endsWith('a.txt')) as any;
    v._editor.setValue('B\n');
  });
  await expect(label(page)).toHaveText(/^● /);
  // 저장을 부른 뒤 서버 저장본을 본다.
  await page.evaluate(() => (window as any).app.save());
  await expect.poll(async () => JSON.stringify(await (await request.get('/api/workspace')).json()).includes('"dirty"'),
    { timeout: 10000 }).toBe(false);
  // 다른 렌더(창 다시 그리기)에서도 파생이 유지된다.
  await page.evaluate(() => (window as any).app.render());
  await expect(label(page)).toHaveText(/^● /);
  // 새로고침하면 문서가 새로 읽혀 dirty 가 없다 — 가짜 ● 가 남지 않는다.
  await page.reload();
  // 편집기 창이 활성이라 터미널을 기다리는 waitForInit 은 맞지 않는다.
  await page.waitForFunction(() => !!(window as any).app?.testing, undefined, { timeout: 15000 });
  await expect(label(page)).toBeVisible({ timeout: 15000 });
  await expect(label(page)).not.toHaveText(/^● /);
});

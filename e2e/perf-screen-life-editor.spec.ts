/**
 * PERF M3 3.5.3 (FR-SPA-3, M3_DESIGN §3.5, D-36) — 잠든 편집기는 타이머·구독이 0 이고 바깥 변경을 깰 때 받는다.
 *
 *   이전: 다른 탭 뒤에 가려진 편집기도 찾기를 끝까지 셌고, 그 문서는 바깥 변경을 감시해 곧바로 다시 읽었다
 *   새:   가려지고 2초 뒤 잠들면 놓는다. 다시 보이면 stamp 를 물어 바뀐 것을 받는다. dirty 문서는 지금처럼
 *         다시 읽지 않고, 저장할 때 경합 확인창이 뜬다. 편집본·실행 취소 기록은 그대로다
 *   이유: 잠든 화면은 구독·타이머·그리기를 하지 않고, 깨면 필요한 상태를 다시 받아 그린다
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

import { Page } from '@playwright/test';

import { test, expect, waitForInit, addEditorRoot, switchToEditorRoot, rmTree, selectTab } from './fixtures';
import { TMP, realPath } from './osenv';

let BASE = '';

test.beforeAll(() => { BASE = realPath(mkdtempSync(join(TMP, 'otter-sle-'))) });
test.afterAll(() => { rmTree(BASE) });

async function mkroot(request: any, page: Page, name: string, files: Record<string, string>) {
  const root = join(BASE, name);
  mkdirSync(root, { recursive: true });
  for (const [f, c] of Object.entries(files)) writeFileSync(join(root, f), c);
  const saved = await addEditorRoot(request, root);
  await waitForInit(page);
  await switchToEditorRoot(page, saved);
  return { root, saved };
}

async function openFile(page: Page, saved: string, rel: string) {
  await page.evaluate((p: string) => (window as any).app.testing.edOpenFile(p, { pin: true }), saved + '/' + rel);
  await page.waitForFunction((n: string) =>
    [...(window as any).app.fileEditors.values()].some((e: any) => edT.has(e) && e.name === n), rel, { timeout: 30000 });
}

const ed = (page: Page, name: string, fn: string) => page.evaluate(([n, f]: string[]) => {
  const v: any = [...(window as any).app.fileEditors.values()].find((e: any) => e.name === n);
  if (!v) return null;
  if (f === 'text') return edT.text(v);
  if (f === 'dirty') return !!v._dirty;
  if (f === 'asleep') return !!v.asleep;
  if (f === 'id') return v.id;
  if (f === 'undo') return (window as any).CM.undo(v._view);
  return null;
}, [name, fn]);

const editorSleepers = (page: Page) => page.evaluate(() =>
  (window as any).app.testing.sleepers().filter((s: any) => s.kind === 'FileEditor'));

async function show(page: Page, name: string) {
  const id = await ed(page, name, 'id');
  await selectTab(page.locator(`#area .pn-tab[data-tab-id="${id}"]`));
  await expect.poll(() => ed(page, name, 'asleep'), { timeout: 8000 }).toBe(false);
}

test('가려진 편집기는 2초 뒤 타이머·구독이 0 이고, 바깥 변경은 잠든 동안 받지 않다가 깰 때 받는다', async ({ page, request }) => {
  const big = 'before\n' + 'foo value line\n'.repeat(60000);
  const { root, saved } = await mkroot(request, page, 'watch', { 'a.txt': big, 'b.txt': 'b1\n' });
  await openFile(page, saved, 'a.txt');
  // 큰 파일 찾기를 걸어 두고 곧바로 다른 탭으로 간다.
  await page.evaluate(() => {
    const v: any = [...(window as any).app.fileEditors.values()].find((e: any) => e.name === 'a.txt');
    v.findOpen();
    const q = v.el.querySelector('.fe-find-q') as HTMLInputElement;
    q.value = 'foo';
    q.dispatchEvent(new Event('input'));
  });
  await openFile(page, saved, 'b.txt');

  await expect.poll(() => ed(page, 'a.txt', 'asleep'), { timeout: 8000 }).toBe(true);
  const asleep = await editorSleepers(page);
  expect(asleep.length).toBeGreaterThan(0);
  for (const s of asleep) expect(s).toEqual({ kind: 'FileEditor', timers: 0, subs: 0 });

  // 같은 디렉터리의 두 파일이 바뀐다 — 깬 b 는 따라가고, 잠든 a 는 따라가지 않는다.
  writeFileSync(join(root, 'a.txt'), 'after\n');
  writeFileSync(join(root, 'b.txt'), 'b2\n');
  await expect.poll(() => ed(page, 'b.txt', 'text'), { timeout: 15000 }).toBe('b2\n');
  expect((await ed(page, 'a.txt', 'text') as string).startsWith('before\n'), '잠든 편집기가 바깥 변경을 읽었다').toBe(true);

  await show(page, 'a.txt');
  await expect.poll(() => ed(page, 'a.txt', 'text'), { timeout: 15000 }).toBe('after\n');
});

test('잠든 dirty 편집기는 깨도 바깥 변경으로 덮이지 않고, 저장하면 경합 확인창이 뜨며 실행 취소 기록이 남는다',
  async ({ page, request }) => {
    const { root, saved } = await mkroot(request, page, 'dirty', { 'c.txt': 'before\n', 'd.txt': 'd\n' });
    await openFile(page, saved, 'c.txt');
    await page.evaluate(() => {
      const v: any = [...(window as any).app.fileEditors.values()].find((e: any) => e.name === 'c.txt');
      edT.replaceAll(v, 'mine\n');
    });
    await expect.poll(() => ed(page, 'c.txt', 'dirty')).toBe(true);
    await openFile(page, saved, 'd.txt');
    await expect.poll(() => ed(page, 'c.txt', 'asleep'), { timeout: 8000 }).toBe(true);

    writeFileSync(join(root, 'c.txt'), 'theirs\n');
    let reads = 0;
    page.on('request', (r) => { if (r.url().includes('/api/file/read')) reads++ });
    // 깰 때 묻는 stamp 요청 — 그 답이 온 뒤에도 dirty 문서는 다시 읽지 않는다.
    const stamped = page.waitForResponse((r) => r.url().includes('/api/fs/stamps'), { timeout: 8000 });
    await show(page, 'c.txt');
    await stamped;
    // **예외 (`TEST-16`)**: 다시 읽기가 "일어나지 않음" 을 잰다 — 기다릴 신호가 없다. 답을 받은 뒤 시간을 준다.
    await page.waitForTimeout(1000);
    expect(await ed(page, 'c.txt', 'text'), '편집본이 디스크 것으로 덮였다').toBe('mine\n');
    expect(await ed(page, 'c.txt', 'dirty')).toBe(true);
    expect(reads, 'dirty 인데 파일을 다시 읽었다').toBe(0);

    await page.evaluate(() => {
      const v: any = [...(window as any).app.fileEditors.values()].find((e: any) => e.name === 'c.txt');
      (window as any).__save = v.save();
    });
    const modal = page.locator('.ui-modal.fe-conflict');
    await expect(modal).toBeVisible({ timeout: 15000 });
    await modal.locator('.fe-conflict-cancel').click();
    await expect.poll(() => page.evaluate(() => (window as any).__save), { timeout: 15000 }).toBe(false);
    expect(readFileSync(join(root, 'c.txt'), 'utf8')).toBe('theirs\n');
    expect(await ed(page, 'c.txt', 'text')).toBe('mine\n');

    expect(await ed(page, 'c.txt', 'undo')).toBe(true);
    expect(await ed(page, 'c.txt', 'text'), '잠들었다 깬 편집기의 실행 취소 기록이 사라졌다').toBe('before\n');
  });

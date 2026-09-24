/**
 * REPO_FIX 03 §3A-1·3A-2 — 인코딩 왕복: 상태바 표시·다시 열기·UTF-8 변환 저장·표현 불가 거절.
 */
import { mkdirSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';

import { test, expect, waitForInit } from './fixtures';
import { tmpPath, realPath } from './osenv';

const ROOT = tmpPath('dm-enc-' + process.pid);
const fx = () => realPath(ROOT);
const P = (n: string) => join(fx(), n);
const HANGUL_CP949 = Buffer.from([0xC7, 0xD1, 0xB1, 0xDB]); // "한글"

test.beforeAll(() => {
  mkdirSync(ROOT, { recursive: true });
  for (const n of ['k1.txt', 'k2.txt', 'k3.txt']) writeFileSync(join(ROOT, n), Buffer.concat([HANGUL_CP949, Buffer.from('\n')]));
  writeFileSync(join(ROOT, 'e.txt'), Buffer.from('café\n', 'utf8'));
  writeFileSync(join(ROOT, 'w.txt'), Buffer.from([0xFF, 0xFE, 0x68, 0x00, 0x69, 0x00, 0x0A, 0x00]));
  writeFileSync(join(ROOT, 'bad.txt'), Buffer.from([0xFF, 0xFF, 0x80, 0x0A]));
});

async function enter(page: any) {
  await waitForInit(page);
  await page.evaluate(async (p: string) => {
    await fetch('/api/editors/add', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: p }) });
  }, fx());
  await expect.poll(async () => page.evaluate(async (p: string) => {
    const app = (window as any).app;
    await app.testing.edReconcile?.();
    await app.testing.edOpenWindow(p);
    return app.testing.edSearchRoot();
  }, fx()), { timeout: 15000 }).not.toBe('');
}

async function open(page: any, name: string) {
  await page.evaluate((f: string) => (window as any).app.testing.edOpenFile(f), P(name));
  await expect.poll(() => page.evaluate((f: string) => {
    const v = (window as any).app.testing.edActiveEditor();
    return !!(v && v.filePath === f && v._editor);
  }, P(name)), { timeout: 30000 }).toBe(true);
  await page.evaluate(() => (window as any).app.updateStatusBar());
}

const encItem = (page: any) => page.locator('#sb-items .sb-enc');
const model = (page: any, f: string) => page.evaluate((p: string) => (window as any).app.testing.edDocs.get(p).model.getValue(), f);
const setText = (page: any, f: string, s: string) => page.evaluate(({ p, s }: any) => (window as any).app.testing.edDocs.get(p).model.setValue(s), { p: f, s });
const save = (page: any) => page.evaluate(() => (window as any).app.testing.edActiveEditor().save());

test('CP949 파일: 상태바 표시, 편집·저장 뒤 CP949 바이트 보존', async ({ page }) => {
  await enter(page);
  await open(page, 'k1.txt');
  await expect(encItem(page)).toHaveText('CP949');
  expect(await model(page, P('k1.txt'))).toBe('한글\n');
  await setText(page, P('k1.txt'), '한글\n한\n');
  expect(await save(page)).toBe(true);
  expect(readFileSync(join(ROOT, 'k1.txt'))).toEqual(Buffer.concat([HANGUL_CP949, Buffer.from('\n'), HANGUL_CP949.subarray(0, 2), Buffer.from('\n')]));
});

test('표현할 수 없는 글자는 거절 — 파일 불변, 변환 버튼', async ({ page }) => {
  await enter(page);
  await open(page, 'k2.txt');
  const before = readFileSync(join(ROOT, 'k2.txt'));
  await setText(page, P('k2.txt'), '한글 😀\n');
  expect(await save(page)).toBe(false);
  expect(readFileSync(join(ROOT, 'k2.txt'))).toEqual(before);
  const note = page.locator('.file-editor .fe-note.vis');
  await expect(note).toContainText('😀');
  await expect(note.locator('.fe-note-btn')).toBeVisible();
  // 변환 저장을 누르면 확인 뒤 UTF-8 로 쓴다.
  await note.locator('.fe-note-btn').click();
  await page.locator('.fe-enc-confirm .fe-enc-go').click();
  await expect.poll(() => readFileSync(join(ROOT, 'k2.txt'), 'utf8'), { timeout: 10000 }).toBe('한글 😀\n');
  await page.evaluate(() => (window as any).app.updateStatusBar());
  await expect(encItem(page)).toHaveText('UTF-8');
});

test('다시 열기: 다른 인코딩으로 디스크에서 다시 디코드', async ({ page }) => {
  await enter(page);
  await open(page, 'e.txt');
  await expect(encItem(page)).toHaveText('UTF-8');
  await encItem(page).click();
  await page.locator('.sb-enc-menu [data-id="reopen-windows-1252"]').click();
  await expect.poll(() => model(page, P('e.txt'))).toBe('cafÃ©\n');
  await page.evaluate(() => (window as any).app.updateStatusBar());
  await expect(encItem(page)).toHaveText('Windows-1252');
  // dirty 면 먼저 묻는다 — 취소하면 그대로다.
  await setText(page, P('e.txt'), 'edited\n');
  await encItem(page).click();
  await page.locator('.sb-enc-menu [data-id="reopen-utf-8"]').click();
  await page.locator('.fe-enc-confirm .fe-enc-cancel').click();
  expect(await model(page, P('e.txt'))).toBe('edited\n');
});

test('변환 저장: 메뉴에서 CP949 → UTF-8', async ({ page }) => {
  await enter(page);
  await open(page, 'k3.txt');
  await encItem(page).click();
  await page.locator('.sb-enc-menu [data-id="to-utf8"]').click();
  await page.locator('.fe-enc-confirm .fe-enc-go').click();
  await expect.poll(() => readFileSync(join(ROOT, 'k3.txt'), 'utf8'), { timeout: 10000 }).toBe('한글\n');
});

test('UTF-16LE 파일이 열리고 저장 뒤 BOM·순서가 보존된다', async ({ page }) => {
  await enter(page);
  await open(page, 'w.txt');
  await expect(encItem(page)).toHaveText('UTF-16 LE');
  await setText(page, P('w.txt'), 'hi!\n');
  expect(await save(page)).toBe(true);
  expect(readFileSync(join(ROOT, 'w.txt'))).toEqual(Buffer.from([0xFF, 0xFE, 0x68, 0, 0x69, 0, 0x21, 0, 0x0A, 0]));
});

test('어느 인코딩으로도 풀리지 않으면 읽기 전용', async ({ page }) => {
  await enter(page);
  await open(page, 'bad.txt');
  await expect(encItem(page)).toContainText('읽기 전용');
  expect(await page.evaluate(() => (window as any).app.testing.edActiveEditor()._editor.getOption((window as any).monaco.editor.EditorOption.readOnly))).toBe(true);
});

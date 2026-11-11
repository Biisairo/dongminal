import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import { APIRequestContext, Page } from '@playwright/test';

import { test, expect, rmTree, switchToEditorRoot } from './fixtures';
import { ED_SEL } from './editor';
import { TMP, realPath, cssPath } from './osenv';

// REPO_FIX 05 §3A-3 (F-2) — git Diff 뷰의 작업 트리 쪽은 편집기 문서 모델이다.
//
// 같은 파일에 버퍼는 하나다: 편집기 탭과 Diff 뷰가 같은 모델을 보고, dirty·저장·
// 인코딩·경합 검사가 문서 하나에 있다.

let BASE = '';
let REPO = '';

const j = (...p: string[]) => path.join(...p);
const git = (d: string, ...a: string[]) => execFileSync('git', ['-C', d, ...a], { stdio: 'ignore' });
const HANGUL_CP949 = Buffer.from([0xC7, 0xD1, 0xB1, 0xDB]); // "한글"
const NL = Buffer.from('\n');

function makeRepo(base: string) {
  const d = j(base, 'repo');
  fs.mkdirSync(d, { recursive: true });
  git(d, 'init', '-q', '-b', 'main', '.');
  git(d, 'config', 'user.name', 'Fixture');
  git(d, 'config', 'user.email', 'fixture@example.invalid');
  git(d, 'config', 'commit.gpgsign', 'false');
  for (const n of ['a.txt', 'b.txt', 'c.txt', 'd.txt', 'e.txt', 'f.txt', 'g.txt', 'h.txt', 'm.txt', 'n.txt']) fs.writeFileSync(j(d, n), 'one\n');
  fs.writeFileSync(j(d, 'k.txt'), Buffer.concat([HANGUL_CP949, NL]));
  git(d, 'add', '-A');
  git(d, 'commit', '-qm', 'init');
  for (const n of ['a.txt', 'b.txt', 'c.txt', 'd.txt', 'e.txt', 'f.txt', 'g.txt', 'h.txt', 'm.txt', 'n.txt']) fs.appendFileSync(j(d, n), 'two\n');
  fs.appendFileSync(j(d, 'k.txt'), Buffer.concat([HANGUL_CP949, NL]));
  return realPath(d);
}

test.beforeAll(() => {
  BASE = realPath(fs.mkdtempSync(j(TMP, 'dm-gdd-')));
  REPO = makeRepo(BASE);
});
test.afterAll(() => { rmTree(BASE) });

async function enter(page: Page, request: APIRequestContext) {
  const r = await request.post('/api/editors/add', { data: { path: REPO } });
  expect(r.ok()).toBeTruthy();
  await page.context().addInitScript(() => { sessionStorage.setItem('displayMode', 'desktop') });
  await page.goto('/');
  await page.waitForSelector('#area .pn.focused .xterm-helper-textarea', { timeout: 15000 });
  await page.waitForFunction(
    () => !!(window as any).app?.testing.editors && (window as any).app.testing.edWindows().length > 0,
    undefined, { timeout: 15000 });
  await switchToEditorRoot(page, REPO);
  await page.waitForSelector('#area .ed-win .ed-side', { timeout: 10000 });
  await page.locator('.ed-side-tab[data-side="changes"]').click();
  await expect(page.locator('#area .ed-side .git-view.git-changes')).toBeVisible({ timeout: 10000 });
}

const row = (page: Page, p: string) =>
  page.locator(`#area .ed-side .git-group[data-group="working"] .git-file[data-path="${cssPath(p)}"]`);
const diffTab = (page: Page) => page.locator('#area .ed-area .pn-tab[data-git-view="diff"]');
const modified = (page: Page) => page.locator(`#area .ed-area .git-diff ${ED_SEL.diffModified}`);

async function openDiff(page: Page, name: string) {
  await row(page, name).click();
  await expect(diffTab(page)).toHaveCount(1, { timeout: 10000 });
  await expect(modified(page)).toBeVisible({ timeout: 20000 });
  await page.waitForFunction((abs: string) => {
    const v = edT.diffPanel()._diffView;
    return !!v && v._editTarget === abs && edT.diffHasMod(v);
  }, j(REPO, name), { timeout: 20000 });
}

/** Diff 뷰의 작업 트리 쪽 모델 끝에 한 줄을 붙인다 — 타이핑과 같은 경로(편집 연산). */
async function typeInDiff(page: Page, text: string) {
  await page.evaluate((s: string) => {
    edT.diffAppend(edT.diffPanel()._diffView, s);
  }, text);
}

const docOf = (page: Page, abs: string) => page.evaluate((p: string) => {
  const d = (window as any).app.testing.edDocs?.get(p);
  return d ? { dirty: !!d.dirty, views: d.views.size, value: edT.docHasModel(d) ? edT.docText(d) : null, encoding: d.encoding } : null;
}, abs);

test.describe('F-2 — Diff 뷰는 편집기 문서를 공유한다', () => {
  test('S1 (F-2.1·2.2·2.5): 편집기 탭과 같은 모델, 한 번 저장으로 둘 다 dirty 가 풀린다', async ({ page, request }) => {
    await enter(page, request);
    const abs = j(REPO, 'a.txt');
    await openDiff(page, 'a.txt');
    await page.evaluate((f: string) => (window as any).app.testing.edOpenFile(f), abs);
    await page.waitForFunction((p: string) => {
      const d = (window as any).app.testing.edDocs?.get(p);
      return !!d && d.views.size >= 2 && edT.docHasModel(d);
    }, abs, { timeout: 20000 });
    const same = await page.evaluate((p: string) =>
      edT.diffSharesDoc(edT.diffPanel()._diffView, (window as any).app.testing.edDocs.get(p)), abs);
    expect(same).toBe(true);

    await typeInDiff(page, 'from-diff\n');
    const edTab = page.locator('#area .ed-area .pn-tab', { hasText: 'a.txt' }).and(page.locator(':not([data-git-view])'));
    await expect(diffTab(page)).toContainText('●', { timeout: 10000 });
    await expect(edTab.first()).toContainText('●', { timeout: 10000 });

    const writes: string[] = [];
    page.on('request', (r) => { if (r.url().includes('/api/file/write')) writes.push(r.url()) });
    expect(await page.evaluate(() => edT.diffPanel()._diffView.save())).toBe(true);
    await expect(diffTab(page)).not.toContainText('●', { timeout: 10000 });
    await expect(edTab.first()).not.toContainText('●', { timeout: 10000 });
    expect(fs.readFileSync(abs, 'utf8')).toBe('one\ntwo\nfrom-diff\n');
    expect(writes.length).toBe(1);
  });

  test('S2 (F-2.3): CP949 파일을 Diff 뷰에서 고쳐 저장하면 CP949 바이트다', async ({ page, request }) => {
    await enter(page, request);
    const abs = j(REPO, 'k.txt');
    await openDiff(page, 'k.txt');
    await expect.poll(async () => (await docOf(page, abs))?.encoding, { timeout: 10000 }).toBe('cp949');
    // 원본 쪽도 문서 인코딩으로 풀려 있다 — 깨진 글자가 아니다.
    const orig = await page.evaluate(() => edT.diffText(edT.diffPanel()._diffView, 'orig'));
    expect(orig).toBe('한글\n');
    await typeInDiff(page, '한\n');
    expect(await page.evaluate(() => edT.diffPanel()._diffView.save())).toBe(true);
    expect(fs.readFileSync(abs)).toEqual(Buffer.concat([HANGUL_CP949, NL, HANGUL_CP949, NL, HANGUL_CP949.subarray(0, 2), NL]));
  });

  test('S3 (F-2.2 / E-3.1): 저장 왕복 중 친 글자는 남고 dirty 도 남는다', async ({ page, request }) => {
    await enter(page, request);
    const abs = j(REPO, 'c.txt');
    await openDiff(page, 'c.txt');
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r });
    await page.route('**/api/file/write', async (route) => { await gate; await route.continue() });
    await typeInDiff(page, 'first\n');
    await page.evaluate(() => { (window as any).__saveP = edT.diffPanel()._diffView.save() });
    await typeInDiff(page, 'second\n');
    release();
    expect(await page.evaluate(() => (window as any).__saveP)).toBe(true);
    const d = await docOf(page, abs);
    expect(d?.value).toBe('one\ntwo\nfirst\nsecond\n');
    expect(d?.dirty).toBe(true);
    expect(fs.readFileSync(abs, 'utf8')).toBe('one\ntwo\nfirst\n');
    await expect(diffTab(page)).toContainText('●');
  });

  /**
   * UX_BATCH12_SRS FR-RTB-14 (F-2.4 개정): 저장하지 않은 수정이 있는 **미리보기** Diff 는 대체되지 않는다.
   *
   *   이전 동작: Diff 탭이 창에 하나였고, 다른 파일을 고르면 그 탭이 대상을 갈아탔다 —
   *             마지막 뷰가 dirty 면 저장/버리기/취소를 물었다
   *   새  동작: 그 미리보기 탭을 고정하고 새 미리보기 Diff 를 세운다. 묻지 않고, 수정은 남는다
   *   이유:     Diff 탭이 여럿이 되면서(FR-RTB-7) 갈아탈 까닭이 없다 — 대체가 수정을 버리지 않는다
   */
  test('S4 (FR-RTB-14): dirty 인 미리보기 Diff 는 고정되고 다음 파일은 새 미리보기다', async ({ page, request }) => {
    await enter(page, request);
    const abs = j(REPO, 'd.txt');
    await openDiff(page, 'd.txt');
    await typeInDiff(page, 'keep\n');
    await row(page, 'e.txt').click();
    await expect.poll(() => page.evaluate(() => {
      const a = (window as any).app;
      const pn = a.testing.flattenPanes(a.testing.aw().layout).find((x: any) => x.id === a.focused);
      return pn.tabs.filter((x: any) => x.gitView === 'diff').map((x: any) => [x.name, !!x.preview]);
    })).toEqual([['d.txt', false], ['e.txt', true]]);
    await expect(page.locator('.confirm-overlay')).toHaveCount(0);
    const d = await docOf(page, abs);
    expect(d?.dirty).toBe(true);
    expect(d?.value).toBe('one\ntwo\nkeep\n');
    expect(fs.readFileSync(abs, 'utf8')).toBe('one\ntwo\n');
  });

  test('S5 (FR-RTB-14): 다른 뷰가 문서를 들고 있어도 dirty 미리보기 Diff 는 대체되지 않는다', async ({ page, request }) => {
    await enter(page, request);
    const abs = j(REPO, 'f.txt');
    await openDiff(page, 'f.txt');
    await page.evaluate((f: string) => (window as any).app.testing.edOpenFile(f), abs);
    await page.waitForFunction((p: string) => (window as any).app.testing.edDocs?.get(p)?.views.size >= 2, abs, { timeout: 20000 });
    await typeInDiff(page, 'stay\n');
    await row(page, 'g.txt').click();
    await expect.poll(() => page.evaluate(() => {
      const a = (window as any).app;
      const pn = a.testing.flattenPanes(a.testing.aw().layout).find((x: any) => x.id === a.focused);
      return pn.tabs.filter((x: any) => x.gitView === 'diff').map((x: any) => [x.name, !!x.preview]);
    })).toEqual([['f.txt', false], ['g.txt', true]]);
    await expect(page.locator('.confirm-overlay')).toHaveCount(0);
    const d = await docOf(page, abs);
    expect(d?.dirty).toBe(true);
    expect(d?.value).toBe('one\ntwo\nstay\n');
    expect(d?.views).toBe(2);
  });

  test('S6 (F-2.6): 모델을 여러 번 갈아도 Cmd+S 한 번은 쓰기 한 번이다', async ({ page, request }) => {
    await enter(page, request);
    await openDiff(page, 'b.txt');
    await openDiff(page, 'g.txt');
    await openDiff(page, 'b.txt');
    await typeInDiff(page, 'once\n');
    const writes: string[] = [];
    page.on('request', (r) => { if (r.url().includes('/api/file/write')) writes.push(r.url()) });
    await modified(page).click();
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+s' : 'Control+s');
    await expect.poll(() => fs.readFileSync(j(REPO, 'b.txt'), 'utf8'), { timeout: 10000 }).toBe('one\ntwo\nonce\n');
    await expect(diffTab(page)).not.toContainText('●', { timeout: 10000 });
    expect(writes.length).toBe(1);
  });

  test('S7 (§3A-3): 문서가 dirty 인 동안 hunk 동작은 사유와 함께 막힌다', async ({ page, request }) => {
    await enter(page, request);
    await openDiff(page, 'e.txt');
    await typeInDiff(page, 'dirty\n');
    const note = page.locator('#area .ed-area .git-diff .git-diff-hunk-note');
    await expect(note).toContainText('저장한 뒤', { timeout: 10000 });
    const patches: string[] = [];
    page.on('request', (r) => { if (r.url().includes('/api/git/patch')) patches.push(r.url()) });
    await page.evaluate(() => edT.diffPanel()._hunkAct('stage'));
    expect(patches.length).toBe(0);
  });

  // CODEMIRROR_MIGRATION_SRS FR-CMR-54 — 수정본 쪽은 contenteditable 이다. 위 검사들은 편집기에
  // 바로 dispatch 한다. 이 검사는 실제 키 입력이 문서에 닿고 편집기 탭에 보이고 저장되는지 잰다.
  test('S8 (FR-CMR-54): Diff 수정본 쪽에 키보드로 친 글자가 편집기 탭에 보이고 저장된다', async ({ page, request }) => {
    await enter(page, request);
    const abs = j(REPO, 'h.txt');
    await openDiff(page, 'h.txt');
    await page.evaluate((f: string) => (window as any).app.testing.edOpenFile(f), abs);
    await page.waitForFunction((p: string) => {
      const d = (window as any).app.testing.edDocs?.get(p);
      return !!d && d.views.size >= 2 && edT.docHasModel(d);
    }, abs, { timeout: 20000 });

    await diffTab(page).click();
    await modified(page).locator(ED_SEL.text).click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type('typed');
    await expect.poll(async () => (await docOf(page, abs))?.value, { timeout: 10000 }).toBe('one\ntwo\ntyped');
    const edTab = page.locator('#area .ed-area .pn-tab', { hasText: 'h.txt' }).and(page.locator(':not([data-git-view])'));
    await expect(edTab.first()).toContainText('●', { timeout: 10000 });

    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+s' : 'Control+s');
    await expect.poll(() => fs.readFileSync(abs, 'utf8'), { timeout: 10000 }).toBe('one\ntwo\ntyped');
    await expect(edTab.first()).not.toContainText('●', { timeout: 10000 });
  });

  test('V-ELR-16 (FR-ELR-38): Diff 가 다른 파일로 옮겨 가도 앞 문서의 버퍼에 파괴된 칸이 남지 않는다', async ({ page, request }) => {
    await enter(page, request);
    const abs = j(REPO, 'm.txt');
    await openDiff(page, 'm.txt');
    await page.evaluate((f: string) => (window as any).app.testing.edOpenFile(f), abs);
    await page.waitForFunction((p: string) => {
      const d = (window as any).app.testing.edDocs?.get(p);
      return !!d && d.views.size >= 2 && edT.docHasModel(d);
    }, abs, { timeout: 20000 });
    await openDiff(page, 'n.txt');
    const dead = await page.evaluate((p: string) => edT.docDeadSinks((window as any).app.testing.edDocs.get(p)), abs);
    expect(dead).toBe(0);
  });
});

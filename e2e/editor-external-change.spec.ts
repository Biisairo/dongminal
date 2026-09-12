/**
 * EDITOR_EXTERNAL_CHANGE_SRS — 편집기와 외부 변경 (V-EXC-1·2·3·9·10·11·12).
 *
 * 접수는 `U-22` 다. 재는 것은 두 가지다.
 *
 *   ① **clean 이면 따라가고 dirty 면 놔둔다** (FR-EXC-1·3·4). 지금 있는 갱신
 *      경로 — 이미 열린 파일을 다시 여는 것 — 가 `refresh()` 를 부르며, 그것이
 *      `_dirty` 를 보지 않아 편집본을 덮었다.
 *   ② **저장은 경합을 본다** (FR-EXC-5·9). 그 확인창에서 취소하면 탭이 닫히지
 *      않는다 (FR-EXC-13) — 경합을 들이면서 그 가드가 없으면 이 스펙 자체가
 *      손실 경로를 만든다.
 *
 * 서버는 실물이다. 표식은 불투명하므로(FR-EXC-11) 이 파일도 그 값을 만들어 보지
 * 않는다 — 밖에서 파일을 고치고 제품이 그것을 알아채는지만 잰다.
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

import { Page } from '@playwright/test';

import {
  test, expect, waitForInit, addEditorRoot, switchToEditorRoot, rmTree,
} from './fixtures';
import { TMP, realPath } from './osenv';

let BASE = '';

test.beforeAll(() => { BASE = realPath(mkdtempSync(join(TMP, 'dm-exc-'))) });
test.afterAll(() => { rmTree(BASE) });

// 검사마다 자기 루트를 판다 — 앞선 검사가 남긴 파일이 다음 검사의 화면을 바꾸는
// 것이 이 저장소가 "부하성 흔들림" 으로 오래 읽었던 것이다 (M2_PROGRESS §6.3).
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
  await page.evaluate((p: string) => (window as any).app.testing.edOpenFile(p, { pin: true }),
    saved + '/' + rel);
  await page.waitForFunction((n: string) => {
    const eds = [...(window as any).app.fileEditors.values()];
    return eds.some((e: any) => e._editor && e.name === n);
  }, rel, { timeout: 30000 });
}

// 이미 열린 파일을 **다시 여는** 것이 지금 있는 갱신 경로다 (SRS §2.2,
// `app-layout.js:480` → `editor.refresh()`). 가짜 호출이 아니라 이 길로 잰다.
async function reopen(page: Page, saved: string, rel: string) {
  await page.evaluate((p: string) => (window as any).app.testing.edOpenFile(p, { pin: true }),
    saved + '/' + rel);
}

async function valueOf(page: Page, name: string): Promise<string> {
  return page.evaluate((n: string) => {
    const v: any = [...(window as any).app.fileEditors.values()].find((e: any) => e.name === n);
    return v && v._editor ? v._editor.getValue() : '';
  }, name);
}

async function dirtyOf(page: Page, name: string): Promise<boolean> {
  return page.evaluate((n: string) => {
    const v: any = [...(window as any).app.fileEditors.values()].find((e: any) => e.name === n);
    return !!(v && v._dirty);
  }, name);
}

// 사용자의 타이핑과 같은 경로다 — `setValue` 는 isFlush 라 dirty 규약이 다르다
// (editor-dirty-diff.spec.ts 와 같은 근거).
async function typeInto(page: Page, name: string, text: string) {
  await page.evaluate(([n, t]: string[]) => {
    const v: any = [...(window as any).app.fileEditors.values()].find((e: any) => e.name === n);
    const m = v._editor.getModel();
    v._editor.executeEdits('test', [{ range: m.getFullModelRange(), text: t }]);
  }, [name, text]);
  await expect.poll(() => dirtyOf(page, name)).toBe(true);
}

test('V-EXC-1: clean 인 편집기는 외부 변경을 따라간다', async ({ page, request }) => {
  const { root, saved } = await mkroot(request, page, 'clean', { 'a.txt': 'before\n' });
  await openFile(page, saved, 'a.txt');
  expect(await valueOf(page, 'a.txt')).toBe('before\n');

  writeFileSync(join(root, 'a.txt'), 'after\n');
  await reopen(page, saved, 'a.txt');

  await expect.poll(() => valueOf(page, 'a.txt'), { timeout: 15000 }).toBe('after\n');
  expect(await dirtyOf(page, 'a.txt'), 'clean 이던 것이 dirty 가 됐다').toBe(false);
});

test('V-EXC-2: 내용이 같으면 setValue 하지 않는다 — 커서가 그 자리에 남는다',
  async ({ page, request }) => {
    const { saved } = await mkroot(request, page, 'samecontent',
      { 'b.txt': 'one\ntwo\nthree\nfour\n' });
    await openFile(page, saved, 'b.txt');

    await page.evaluate(() => {
      const v: any = [...(window as any).app.fileEditors.values()].find((e: any) => e.name === 'b.txt');
      v._editor.setPosition({ lineNumber: 3, column: 2 });
    });
    await reopen(page, saved, 'b.txt');
    // **예외 (`TEST-16`): 커서가 되돌아가지 **않음**을 잰다.** 다시 읽어 같은
    // 내용을 넣었다면 1,1 로 돌아간다 (FR-LSP-26b) — 기다릴 신호가 없다.
    await page.waitForTimeout(1000);
    const pos = await page.evaluate(() => {
      const v: any = [...(window as any).app.fileEditors.values()].find((e: any) => e.name === 'b.txt');
      const p = v._editor.getPosition();
      return { line: p.lineNumber, col: p.column };
    });
    expect(pos).toEqual({ line: 3, col: 2 });
  });

test('V-EXC-3: dirty 인 편집기는 refresh() 로 덮이지 않는다', async ({ page, request }) => {
  const { root, saved } = await mkroot(request, page, 'dirtykeep', { 'c.txt': 'before\n' });
  await openFile(page, saved, 'c.txt');
  await typeInto(page, 'c.txt', 'my edit\n');

  // 밖에서 바뀌었다.
  writeFileSync(join(root, 'c.txt'), 'external\n');

  // **읽기가 아예 일어나지 않는다** (FR-EXC-4). 요청 수를 세는 것이 이 단정의
  // 결정론이다 — 시간만 재면 "아직 안 왔다" 를 "안 덮었다" 로 읽는다.
  let reads = 0;
  page.on('request', (r) => { if (r.url().includes('/api/file/read')) reads++ });

  await reopen(page, saved, 'c.txt');
  // **예외 (`TEST-16`)**: 편집본이 디스크 것으로 **덮이지 않음**을 잰다.
  await page.waitForTimeout(1500);

  expect(await valueOf(page, 'c.txt'), '편집본이 디스크 것으로 덮였다').toBe('my edit\n');
  expect(await dirtyOf(page, 'c.txt')).toBe(true);
  expect(reads, 'dirty 인데 파일을 다시 읽었다 — 덮을 길이 열려 있다').toBe(0);
  expect(readFileSync(join(root, 'c.txt'), 'utf8'), '디스크가 바뀌었다').toBe('external\n');
});

test('V-EXC-9·10: 경합하면 확인창이 뜨고, 초기 포커스는 덮어쓰기다',
  async ({ page, request }) => {
    const { root, saved } = await mkroot(request, page, 'conflictgo', { 'd.txt': 'before\n' });
    await openFile(page, saved, 'd.txt');
    await typeInto(page, 'd.txt', 'mine\n');

    writeFileSync(join(root, 'd.txt'), 'theirs\n');

    // 저장은 확인창을 기다리므로 여기서 await 하면 멈춘다 — 약속만 걸어 둔다.
    await page.evaluate(() => {
      const v: any = [...(window as any).app.fileEditors.values()].find((e: any) => e.name === 'd.txt');
      (window as any).__save = v.save();
    });

    const modal = page.locator('.ui-modal.fe-conflict');
    await expect(modal).toBeVisible({ timeout: 15000 });
    // FR-EXC-9a / FR-PDA-1: 이 창이 뜬 까닭은 사용자가 저장을 눌렀기 때문이다.
    await expect(modal.locator('.fe-conflict-go')).toBeFocused();
    // FR-EXC-9: `디스크 것으로 덮기` 는 두지 않는다 (비목표 3).
    await expect(modal.locator('.ui-modal-foot .ui-btn')).toHaveCount(2);

    await modal.locator('.fe-conflict-go').click();
    await expect.poll(() => page.evaluate(() => (window as any).__save), { timeout: 15000 })
      .toBe(true);

    expect(readFileSync(join(root, 'd.txt'), 'utf8'), '덮어쓰기를 눌렀는데 디스크가 그대로다')
      .toBe('mine\n');
    expect(await dirtyOf(page, 'd.txt'), '저장했는데 dirty 가 남았다').toBe(false);
  });

test('V-EXC-11: 취소하면 디스크는 그대로고 편집기는 여전히 dirty 다',
  async ({ page, request }) => {
    const { root, saved } = await mkroot(request, page, 'conflictcancel', { 'e.txt': 'before\n' });
    await openFile(page, saved, 'e.txt');
    await typeInto(page, 'e.txt', 'mine\n');

    writeFileSync(join(root, 'e.txt'), 'theirs\n');

    await page.evaluate(() => {
      const v: any = [...(window as any).app.fileEditors.values()].find((e: any) => e.name === 'e.txt');
      (window as any).__save = v.save();
    });

    const modal = page.locator('.ui-modal.fe-conflict');
    await expect(modal).toBeVisible({ timeout: 15000 });
    await modal.locator('.fe-conflict-cancel').click();
    await expect.poll(() => page.evaluate(() => (window as any).__save), { timeout: 15000 })
      .toBe(false);

    expect(readFileSync(join(root, 'e.txt'), 'utf8'), '취소했는데 디스크가 바뀌었다')
      .toBe('theirs\n');
    expect(await valueOf(page, 'e.txt'), '취소했는데 편집본이 사라졌다').toBe('mine\n');
    expect(await dirtyOf(page, 'e.txt'), '쓰지 않았는데 dirty 가 내려갔다').toBe(true);
  });

test('V-EXC-12: 경합으로 저장이 막히면 "저장 후 닫기" 가 탭을 닫지 않는다',
  async ({ page, request }) => {
    const { root, saved } = await mkroot(request, page, 'closeguard', { 'f.txt': 'before\n' });
    await openFile(page, saved, 'f.txt');
    await typeInto(page, 'f.txt', 'mine\n');

    writeFileSync(join(root, 'f.txt'), 'theirs\n');

    const loc = await page.evaluate((p: string) => {
      const t = (window as any).app.testing.findEditorTab(p);
      return t ? { pane: t.pane.id, tab: t.tab.id, win: t.win.id } : null;
    }, saved + '/f.txt');
    expect(loc).not.toBeNull();

    await page.evaluate((l: any) => {
      (window as any).__close = (window as any).app.closeTab(l.pane, l.tab, l.win);
    }, loc);

    // dirty 확인창 → 저장 후 닫기
    await page.locator('.confirm-save').click();
    // 저장이 경합에 걸린다 → 경합 확인창 → 취소
    const modal = page.locator('.ui-modal.fe-conflict');
    await expect(modal).toBeVisible({ timeout: 15000 });
    await modal.locator('.fe-conflict-cancel').click();
    await page.evaluate(() => (window as any).__close);

    // FR-EXC-13: 저장한 줄 알고 닫는 것이 곧 손실이다.
    const still = await page.evaluate((p: string) => !!(window as any).app.testing.findEditorTab(p),
      saved + '/f.txt');
    expect(still, '저장이 막혔는데 탭이 닫혔다 — 편집을 잃었다').toBe(true);
    expect(await valueOf(page, 'f.txt')).toBe('mine\n');
    expect(readFileSync(join(root, 'f.txt'), 'utf8')).toBe('theirs\n');
  });

/**
 * V-EXC-13 (FR-EXC-14): **저장 왕복 중의 편집은 저장된 것으로 치지 않는다.**
 *
 * 접수는 `U-23` — *"한번씩 cmd+s 시 파일저장이 안된다. 파일을 닫고 다시열면
 * 가능해진다."*
 *
 * `save()` 는 시작 시점의 `getValue()` 를 담아 보낸다. 그 뒤는 망 왕복이고 그 사이의
 * 타이핑은 그 요청에 들어 있지 않은데, 성공 처리가 `dirty` 를 무조건 내렸다. 내리는
 * 순간 다음 `Ctrl+S` 는 `save()` 첫 줄의 `if (!this._dirty) return false` 에 걸려
 * **아무 말 없이** 되돌아간다 — 사용자에게는 "저장이 안 된다" 로 보이고, 실제로는
 * 그 사이 편집이 유실된다.
 *
 * 왕복을 늦춰 그 창을 연다. 원격 접속에서는 이 창이 저절로 열린다.
 */
test('V-EXC-13 (FR-EXC-14): 저장 왕복 중에 친 내용은 dirty 로 남는다',
  async ({ page, request }) => {
    const { root, saved } = await mkroot(request, page, 'exc-inflight', { 'a.txt': 'one\n' });
    await openFile(page, saved, 'a.txt');
    await typeInto(page, 'a.txt', 'SENT\n');

    // 쓰기 한 번을 늦춘다. 그 사이가 사용자가 계속 타이핑하는 구간이다.
    let release: (() => void) | null = null;
    const held = new Promise<void>((r) => { release = r });
    await page.route('**/api/file/write', async (route) => {
      await held;
      await route.continue();
    });

    const saving = page.evaluate(() => {
      const v: any = [...(window as any).app.fileEditors.values()].find((e: any) => e.name === 'a.txt');
      return v.save();
    });

    // **예외 (`TEST-16`): 경합을 만드는 대기다.** 요청이 날아간 뒤에 친다 —
    // 이 글자는 위 요청에 담기지 않았다.
    await page.waitForTimeout(150);
    await page.evaluate(() => {
      const v: any = [...(window as any).app.fileEditors.values()].find((e: any) => e.name === 'a.txt');
      const m = v._editor.getModel();
      v._editor.executeEdits('test', [{ range: m.getFullModelRange(), text: 'LATER\n' }]);
    });

    release!();
    expect(await saving).toBe(true);
    await page.unroute('**/api/file/write');

    // 디스크에는 담아 간 것이 들어갔다 — 그 저장 자체는 성공이다.
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('SENT\n');
    // 그러나 화면의 내용은 아직 저장되지 않았다. **dirty 가 남아야 한다.**
    expect(await dirtyOf(page, 'a.txt'),
      '왕복 중의 편집이 저장된 것으로 처리됐다 — 다음 Ctrl+S 가 조용히 무시된다').toBe(true);

    // 그리고 그 다음 저장이 실제로 나간다 (조용히 건너뛰지 않는다).
    const second = await page.evaluate(() => {
      const v: any = [...(window as any).app.fileEditors.values()].find((e: any) => e.name === 'a.txt');
      return v.save();
    });
    expect(second, '두 번째 저장이 조용히 건너뛰어졌다').toBe(true);
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('LATER\n');
    await expect.poll(() => dirtyOf(page, 'a.txt')).toBe(false);
  });

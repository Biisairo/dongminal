import * as fs from 'fs';
import * as path from 'path';

import { APIRequestContext, Page } from '@playwright/test';

import {
  test, expect, rmTree, switchToEditorRoot, openExplorerSide, gotoWithEditors, openExplorerAt, enterExplorer,
} from './fixtures';
import { TMP, realPath, cssPath } from './osenv';

// EXPLORER_ROOT_KEYS_SRS §5 — 검증 V-EXR-1~58.
//
// **서버를 목업하지 않는다.** 생성·삭제·복사 종단은 이미 서 있고, 이 스펙이
// 재는 것은 그 위의 클라이언트 규약이다 — 빈 여백·머리의 뜻(묶음 A·B), 생성
// 직후의 열기(묶음 C), 메모장의 폴더 금지(묶음 D), 탭 바 여백(묶음 E),
// 키보드 길(묶음 F). 실패를 만드는 하나(V-EXR-21)만 `page.route` 를 쓴다.
//
// **파괴적 조작을 재는 스펙이다.** 픽스처는 전부 `mkdtemp` 아래에 만들고
// 테스트마다 자기 루트를 새로 짓는다.

let BASE = '';

const j = (...p: string[]) => path.join(...p);
const w = (p: string, s: string) => fs.writeFileSync(p, s);

/**
 * 테스트 하나가 쓰는 루트. 조작이 파괴적이므로 **공유하지 않는다.**
 *
 *   <root>/sub/inner.txt   — 펼침이 순서를 바꾸는지 재는 자리 (V-EXR-53)
 *   <root>/a.txt · b.txt
 *
 * 이름이 `sub` < `a.txt` 인 것은 정렬이 폴더 먼저이기 때문이다 (FR-EDT-61).
 */
function mkRoot(tag: string) {
  const d = j(BASE, tag);
  fs.mkdirSync(j(d, 'sub'), { recursive: true });
  w(j(d, 'sub', 'inner.txt'), 'I\n');
  w(j(d, 'a.txt'), 'A\n');
  w(j(d, 'b.txt'), 'B\n');
  return realPath(d);
}

test.beforeAll(() => {
  BASE = realPath(fs.mkdtempSync(j(TMP, 'dm-exr-')));
});
test.afterAll(() => {
  rmTree(BASE);
});

// ── 진입 ────────────────────────────────────────────

const row = (page: Page, p: string) => page.locator(`.ed-tree .ed-row[data-path="${cssPath(p)}"]`);
const head = (page: Page) => page.locator('.ed-explorer .ed-head');
const input = (page: Page) => page.locator('.ed-tree .ed-input');
const notesRoot = (page: Page) => page.evaluate(() => (window as any).app.testing.edNotes() as string);
const sel = (page: Page) => page.evaluate(() => {
  const a = (window as any).app;
  const t = a.testing.edTree(a.testing.aw());
  return t ? t._sel : null;
});

/**
 * 트리의 **빈 여백**을 누른다. 마지막 행 아래에 실제로 여백이 있는지 먼저
 * 확인한다 — 행이 컨테이너를 채우면 이 손짓 자체가 성립하지 않으므로, 그
 * 경우를 조용히 통과시키면 검증이 뜻을 잃는다.
 */
async function clickBlank(page: Page, opts: { dbl?: boolean } = {}) {
  const gap = await page.evaluate(() => {
    const t = document.querySelector('.ed-explorer .ed-tree') as HTMLElement;
    const rs = [...t.querySelectorAll('.ed-row')] as HTMLElement[];
    const last = rs.length ? rs[rs.length - 1].getBoundingClientRect().bottom : t.getBoundingClientRect().top;
    return t.getBoundingClientRect().bottom - last;
  });
  expect(gap, '마지막 행 아래에 여백이 없다 — 이 검증이 성립하지 않는다').toBeGreaterThan(12);
  const box = (await page.locator('.ed-explorer .ed-tree').boundingBox())!;
  const at = { position: { x: Math.min(20, box.width / 2), y: box.height - 6 } };
  if (opts.dbl) await page.locator('.ed-explorer .ed-tree').dblclick(at);
  else await page.locator('.ed-explorer .ed-tree').click(at);
}

// ── 묶음 A — 빈 여백과 머리는 루트다 (U-4) ────────────────

test.describe('묶음 A — 빈 여백과 머리는 루트다 (FR-EXR-1~6)', () => {
  test('V-EXR-1 (FR-EXR-1): 빈 여백 클릭이 행의 선택을 거두고 루트를 고른다',
    async ({ page, request }) => {
      const root = mkRoot('a1');
      await enterExplorer(page, request, root);
      await row(page, j(root, 'a.txt')).click();
      await expect(row(page, j(root, 'a.txt'))).toHaveClass(/\bsel\b/);

      await clickBlank(page);

      await expect(row(page, j(root, 'a.txt'))).not.toHaveClass(/\bsel\b/);
      await expect(head(page)).toHaveClass(/\bsel\b/);
      expect(await sel(page)).toBe(root);
    });

  test('V-EXR-2 (FR-EXR-2): 머리 이름 클릭도 루트를 고른다', async ({ page, request }) => {
    const root = mkRoot('a2');
    await enterExplorer(page, request, root);
    await row(page, j(root, 'a.txt')).click();
    await page.locator('.ed-explorer .ed-head-name').click();
    await expect(head(page)).toHaveClass(/\bsel\b/);
    expect(await sel(page)).toBe(root);
  });

  test('V-EXR-3 (FR-EXR-2): 머리의 버튼 클릭은 루트를 고르지 않는다',
    async ({ page, request }) => {
      const root = mkRoot('a3');
      await enterExplorer(page, request, root);
      await row(page, j(root, 'a.txt')).click();
      await page.locator('.ed-explorer .ed-head-refresh').click();
      // 새로고침은 자기 일만 한다 — 선택은 그대로다.
      await expect(head(page)).not.toHaveClass(/\bsel\b/);
      expect(await sel(page)).toBe(j(root, 'a.txt'));
    });

  test('V-EXR-4 (FR-EXR-4): 빈 여백 클릭이 쓰다 만 인라인 입력을 버린다',
    async ({ page, request }) => {
      const root = mkRoot('a4');
      await enterExplorer(page, request, root);
      await page.locator('.ed-head-new-file').click();
      await expect(input(page)).toBeVisible();
      await input(page).fill('never.txt');

      await clickBlank(page);

      await expect(input(page)).toHaveCount(0);
      expect(fs.existsSync(j(root, 'never.txt')), '취소인데 파일이 만들어졌다').toBe(false);
    });

  test('V-EXR-5 (FR-EXR-5): 빈 여백 클릭 뒤 만들면 루트 직속이다', async ({ page, request }) => {
    const root = mkRoot('a5');
    await enterExplorer(page, request, root);
    // 하위 폴더를 골라 둔다 — 이것이 없으면 기본값과 구분되지 않는다.
    await row(page, j(root, 'sub')).click();
    expect(await sel(page)).toBe(j(root, 'sub'));

    await clickBlank(page);
    await page.locator('.ed-head-new-file').click();
    await input(page).fill('top.txt');
    await input(page).press('Enter');

    await expect(row(page, j(root, 'top.txt'))).toBeVisible({ timeout: 10000 });
    expect(fs.existsSync(j(root, 'top.txt'))).toBe(true);
    expect(fs.existsSync(j(root, 'sub', 'top.txt'))).toBe(false);
  });
});

// ── 묶음 B — 빈 여백 더블클릭 (U-12) ────────────────────

test.describe('묶음 B — 빈 여백 더블클릭은 루트에 파일을 만든다 (FR-EXR-10~12)', () => {
  test('V-EXR-10 (FR-EXR-10·11): 빈 여백 더블클릭 → 루트에 파일',
    async ({ page, request }) => {
      const root = mkRoot('b1');
      await enterExplorer(page, request, root);
      await clickBlank(page, { dbl: true });
      await expect(input(page)).toBeVisible();
      await input(page).fill('made.txt');
      await input(page).press('Enter');

      await expect(row(page, j(root, 'made.txt'))).toHaveAttribute('data-kind', 'file',
        { timeout: 10000 });
      expect(fs.statSync(j(root, 'made.txt')).isFile()).toBe(true);
    });

  test('V-EXR-11 (FR-EXR-12): 머리 더블클릭은 인라인 입력을 만들지 않는다',
    async ({ page, request }) => {
      const root = mkRoot('b2');
      await enterExplorer(page, request, root);
      await page.locator('.ed-explorer .ed-head-name').dblclick();
      await expect(input(page)).toHaveCount(0);
    });
});

// ── 묶음 C — 만든 파일은 즉시 연다 (U-13) ────────────────

// 탭에는 파일 경로를 담은 DOM 속성이 없다 — 짝짓기는 `_findEditorTab` 이
// 소유한다 (FR-EDT-101). 그 자리를 그대로 묻는다.
const edTab = (page: Page, p: string) =>
  page.evaluate((fp) => {
    const t = (window as any).app.testing.findEditorTab(fp);
    return t ? { id: t.tab.id, preview: !!t.tab.preview } : null;
  }, p);

// 열려 있는 editor 탭의 수. `flattenPanes` 가 layout 을 펴는 자리를 그대로 쓴다.
const edTabCount = (page: Page) =>
  page.evaluate(() => {
    const a = (window as any).app;
    let n = 0;
    for (const s of a.ws.windows || []) {
      if (!s || !s.layout) continue;
      for (const pn of a.testing.flattenPanes(s.layout)) {
        n += (pn.tabs || []).filter((t: any) => t && t.type === 'editor').length;
      }
    }
    return n;
  });

test.describe('묶음 C — 만든 파일은 즉시 연다 (FR-EXR-20~24)', () => {
  test('V-EXR-20 (FR-EXR-20·23): 툴바로 만든 파일이 고정 탭으로 열린다',
    async ({ page, request }) => {
      const root = mkRoot('c1');
      await enterExplorer(page, request, root);
      await page.locator('.ed-head-new-file').click();
      await input(page).fill('fresh.txt');
      await input(page).press('Enter');

      await expect.poll(() => edTab(page, j(root, 'fresh.txt')), { timeout: 10000 })
        .not.toBeNull();
      // 미리보기가 아니다 (D-3) — 다음 클릭에 대체되면 만들기가 실패로 읽힌다.
      expect((await edTab(page, j(root, 'fresh.txt')))!.preview).toBe(false);
    });

  test('V-EXR-21 (FR-EXR-21): 생성이 실패하면 탭이 열리지 않는다',
    async ({ page, request }) => {
      const root = mkRoot('c2');
      await enterExplorer(page, request, root);
      await page.route('**/api/fs/create', (r) =>
        r.fulfill({ status: 500, json: { code: 'io_failed', message: '실패' } }));

      const before = await edTabCount(page);
      await page.locator('.ed-head-new-file').click();
      await input(page).fill('ghost.txt');
      await input(page).press('Enter');

      // 낙관적 행은 되돌아간다 (FR-EDT-92).
      await expect(row(page, j(root, 'ghost.txt'))).toHaveCount(0, { timeout: 10000 });
      expect(await edTabCount(page), '없는 파일의 탭이 남았다').toBe(before);
      expect(await edTab(page, j(root, 'ghost.txt'))).toBeNull();
    });

  test('V-EXR-22 (FR-EXR-22): 폴더를 만들면 탭이 열리지 않는다', async ({ page, request }) => {
    const root = mkRoot('c3');
    await enterExplorer(page, request, root);
    const before = await edTabCount(page);
    await page.locator('.ed-head-new-dir').click();
    await input(page).fill('mydir');
    await input(page).press('Enter');

    await expect(row(page, j(root, 'mydir'))).toHaveAttribute('data-kind', 'dir',
      { timeout: 10000 });
    expect(await edTabCount(page)).toBe(before);
  });

  test('V-EXR-23 (FR-EXR-24): 빈 여백 더블클릭으로 만든 파일도 열린다',
    async ({ page, request }) => {
      const root = mkRoot('c4');
      await enterExplorer(page, request, root);
      await clickBlank(page, { dbl: true });
      await input(page).fill('viaBlank.txt');
      await input(page).press('Enter');
      await expect.poll(() => edTab(page, j(root, 'viaBlank.txt')), { timeout: 10000 })
        .not.toBeNull();
    });
});

// ── 묶음 D — 메모장에서는 폴더를 만들 수 없다 (U-16) ──────

test.describe('묶음 D — 메모장의 폴더 금지 (FR-EXR-30~35)', () => {
  test('V-EXR-30 (FR-EXR-31): 메모장에는 새 폴더 버튼이 없다. 다른 루트에는 있다',
    async ({ page, request }) => {
      const root = mkRoot('d1');
      await enterExplorer(page, request, root);
      await expect(page.locator('.ed-explorer .ed-head-new-dir')).toHaveCount(1);

      const notes = await notesRoot(page);
      expect(notes, '메모 루트가 없다').toBeTruthy();
      await openExplorerAt(page, notes);
      await expect(page.locator('.ed-explorer .ed-head-new-file')).toHaveCount(1);
      await expect(page.locator('.ed-explorer .ed-head-new-dir')).toHaveCount(0);
    });

  test('V-EXR-31 (FR-EXR-32): 메모장의 우클릭 메뉴에 newDir 이 없다',
    async ({ page, request }) => {
      const root = mkRoot('d2');
      await enterExplorer(page, request, root);
      const notes = await notesRoot(page);
      await openExplorerAt(page, notes);
      // 메뉴가 뜰 자리를 만든다 — 빈 메모장이면 행이 없다.
      await page.locator('.ed-explorer .ed-head-new-file').click();
      await input(page).fill('memo.md');
      await input(page).press('Enter');
      const made = page.locator('.ed-explorer .ed-tree .ed-row').first();
      await expect(made).toBeVisible({ timeout: 10000 });

      await made.click({ button: 'right' });
      await expect(page.locator('.git-menu')).toBeVisible();
      await expect(page.locator('.git-menu .git-menu-item[data-id="newFile"]')).toHaveCount(1);
      await expect(page.locator('.git-menu .git-menu-item[data-id="newDir"]')).toHaveCount(0);
    });

  test('V-EXR-32 (FR-EXR-30): 메모장에서 startCreate(true) 는 입력을 열지 않는다',
    async ({ page, request }) => {
      const root = mkRoot('d3');
      await enterExplorer(page, request, root);
      const notes = await notesRoot(page);
      await openExplorerAt(page, notes);
      await page.waitForFunction(() => {
        const a = (window as any).app;
        return !!a.testing.edTree(a.testing.aw());
      }, undefined, { timeout: 10000 });

      await page.evaluate(() => {
        const a = (window as any).app;
        a.testing.edTree(a.testing.aw()).startCreate(true);
      });
      await expect(input(page)).toHaveCount(0);

      // 파일 쪽은 그대로 열린다 — 막은 것은 dir 하나다 (FR-EXR-34).
      await page.evaluate(() => {
        const a = (window as any).app;
        a.testing.edTree(a.testing.aw()).startCreate(false);
      });
      await expect(input(page)).toBeVisible();
    });

  test('V-EXR-33 (FR-EXR-34): 메모장에서 파일은 그대로 만들어진다',
    async ({ page, request }) => {
      const root = mkRoot('d4');
      await enterExplorer(page, request, root);
      const notes = await notesRoot(page);
      await openExplorerAt(page, notes);
      const name = 'exr-' + Date.now() + '.md';
      await page.locator('.ed-explorer .ed-head-new-file').click();
      await input(page).fill(name);
      await input(page).press('Enter');
      await expect(row(page, j(notes, name))).toBeVisible({ timeout: 10000 });
    });
});

// ── 묶음 E — 탭 바 여백 더블클릭 (U-11) ──────────────────

/** 활성 pane 의 탭 바 **오른쪽 여백**. 마지막 탭보다 오른쪽에 자리가 있어야 한다. */
async function dblBlankTabs(page: Page, paneSel = '#area .pn.focused') {
  const gap = await page.evaluate((s) => {
    const bar = document.querySelector(`${s} .pn-tabs`) as HTMLElement;
    const ts = [...bar.querySelectorAll('.pn-tab, .pn-tab-add')] as HTMLElement[];
    const right = ts.length ? Math.max(...ts.map((t) => t.getBoundingClientRect().right))
      : bar.getBoundingClientRect().left;
    return bar.getBoundingClientRect().right - right;
  }, paneSel);
  expect(gap, '탭 바에 여백이 없다 — 이 검증이 성립하지 않는다').toBeGreaterThan(16);
  const box = (await page.locator(`${paneSel} .pn-tabs`).boundingBox())!;
  await page.locator(`${paneSel} .pn-tabs`)
    .dblclick({ position: { x: box.width - 6, y: box.height / 2 } });
}

test.describe('묶음 E — 탭 바 여백 더블클릭 (FR-EXR-40~43)', () => {
  test('V-EXR-40 (FR-EXR-40): 탭 바 여백 더블클릭이 그 pane 의 탭을 하나 늘린다',
    async ({ page }) => {
      await gotoWithEditors(page);
      const tabs = page.locator('#area .pn.focused .pn-tab');
      const before = await tabs.count();
      await dblBlankTabs(page);
      await expect(tabs).toHaveCount(before + 1, { timeout: 10000 });
    });

  test('V-EXR-41 (FR-EXR-41): 탭 라벨 더블클릭은 이름 변경이며 탭이 늘지 않는다',
    async ({ page }) => {
      await gotoWithEditors(page);
      const tabs = page.locator('#area .pn.focused .pn-tab');
      const before = await tabs.count();
      await page.locator('#area .pn.focused .pn-tab.active .pn-tab-label').dblclick();
      // 이름 변경의 입력이 선다 (FR-TAN-21).
      await expect(page.locator('#area .pn.focused .pn-tab input')).toBeVisible();
      expect(await tabs.count()).toBe(before);
    });

  test('V-EXR-42 (FR-EXR-42): 비활성 pane 의 여백을 눌러도 그 pane 에 탭이 선다',
    async ({ page }) => {
      await gotoWithEditors(page);
      // 분할하면 새 pane 이 활성이 된다 — 그러면 **원래 pane** 이 비활성이다.
      await page.evaluate(() => (window as any).app.executeAction('splitH'));
      await expect(page.locator('#area .pn')).toHaveCount(2, { timeout: 10000 });

      const idle = '#area .pn:not(.focused)';
      const before = await page.locator(`${idle} .pn-tab`).count();
      // pane 의 신원은 `data-paneid` 다 (renderer.js:823).
      const idleId = await page.locator(idle).getAttribute('data-paneid');
      expect(idleId).toBeTruthy();
      await dblBlankTabs(page, idle);

      await expect(page.locator(`#area .pn[data-paneid="${idleId}"] .pn-tab`))
        .toHaveCount(before + 1, { timeout: 10000 });
    });

  test('V-EXR-43 (FR-EXR-44): Editor 창의 탭 바 여백은 탭을 만들지 않는다',
    async ({ page, request }) => {
      const root = mkRoot('e4');
      await enterExplorer(page, request, root);
      // Editor 창은 파일을 열기 전까지 **pane 이 하나도 없다** (FR-EDT-55) —
      // 탭 바가 서려면 먼저 열어야 한다.
      await row(page, j(root, 'a.txt')).dblclick();
      await expect(page.locator('#area .pn.focused .pn-tabs')).toBeVisible({ timeout: 15000 });

      const tabs = page.locator('#area .pn.focused .pn-tab');
      const before = await tabs.count();
      // 그 창에는 `+` 자리도 없다 (FR-GIT-180·FR-EDT-54) — 같은 판정이어야 한다.
      await expect(page.locator('#area .pn.focused .pn-tab-add')).toHaveCount(0);

      await dblBlankTabs(page);

      await expect(tabs).toHaveCount(before);
    });
});

// ── 묶음 F — 탐색기의 키보드 길 (U-14) ───────────────────

async function focusTree(page: Page) {
  await page.locator('.ed-explorer .ed-head-name').click();
  await expect.poll(() => page.evaluate(() =>
    !!document.activeElement?.closest('.ed-explorer'))).toBe(true);
}

test.describe('묶음 F — 탐색기의 키보드 길 (FR-EXR-50~57)', () => {
  test('V-EXR-50 (FR-EXR-50): 탐색기를 클릭하면 포커스가 편집기에서 넘어온다',
    async ({ page, request }) => {
      const root = mkRoot('f1');
      await enterExplorer(page, request, root);
      // 편집기를 열어 Monaco 에 포커스를 준다.
      await row(page, j(root, 'a.txt')).dblclick();
      await expect(page.locator('.monaco-editor').first()).toBeVisible({ timeout: 15000 });
      await page.locator('.monaco-editor textarea').first().focus();
      expect(await page.evaluate(() => !!document.activeElement?.closest('.monaco-editor'))).toBe(true);

      await row(page, j(root, 'b.txt')).click();
      // 포커스 복원은 다음 프레임이다 (FR-EXR-58 / `_restoreOwnFocus`) — 클릭이
      // 미리보기를 열고 그 render 가 `.ed-win` 을 떼었다 붙이기 때문이다.
      await expect.poll(() => page.evaluate(() =>
        !!document.activeElement?.closest('.ed-explorer')), { timeout: 10000 }).toBe(true);
    });

  test('V-EXR-51 (FR-EXR-51): Mod+C · Mod+V 로 파일이 복제된다', async ({ page, request }) => {
    const root = mkRoot('f2');
    await enterExplorer(page, request, root);
    // 행 클릭 하나가 선택과 포커스를 함께 준다 (FR-EXR-50·58).
    await row(page, j(root, 'a.txt')).click();
    await expect.poll(() => page.evaluate(() =>
      !!document.activeElement?.closest('.ed-explorer'))).toBe(true);

    await page.keyboard.press('ControlOrMeta+KeyC');
    await page.keyboard.press('ControlOrMeta+KeyV');

    // 최종 이름은 서버가 정한다 (FR-WBR-62·63) — 개수로 잰다.
    await expect.poll(() => fs.readdirSync(root).filter((n) => n.startsWith('a')).length,
      { timeout: 10000 }).toBeGreaterThan(1);
  });

  test('V-EXR-52 (FR-EXR-51): F2 로 이름 입력이 열린다', async ({ page, request }) => {
    const root = mkRoot('f3');
    await enterExplorer(page, request, root);
    await row(page, j(root, 'a.txt')).click();
    await expect.poll(() => page.evaluate(() =>
      !!document.activeElement?.closest('.ed-explorer'))).toBe(true);
    await page.keyboard.press('F2');
    await expect(input(page)).toBeVisible();
    await expect(input(page)).toHaveValue('a.txt');
  });

  test('V-EXR-53 (FR-EXR-52): ArrowDown 이 보이는 순서를 따른다', async ({ page, request }) => {
    const root = mkRoot('f4');
    await enterExplorer(page, request, root);
    // `sub` 를 클릭하면 펼쳐지고 선택되고 포커스까지 온다 — 두 번 누르면
    // 접히므로(`_onClick` 의 `toggle`) 한 번만 누른다.
    await row(page, j(root, 'sub')).click();
    await expect(row(page, j(root, 'sub', 'inner.txt'))).toBeVisible({ timeout: 10000 });
    await expect.poll(() => page.evaluate(() =>
      !!document.activeElement?.closest('.ed-explorer'))).toBe(true);
    expect(await sel(page)).toBe(j(root, 'sub'));

    await page.keyboard.press('ArrowDown');
    expect(await sel(page)).toBe(j(root, 'sub', 'inner.txt'));
    await page.keyboard.press('ArrowDown');
    expect(await sel(page)).toBe(j(root, 'a.txt'));
    await page.keyboard.press('ArrowUp');
    expect(await sel(page)).toBe(j(root, 'sub', 'inner.txt'));
  });

  test('V-EXR-54 (FR-EXR-51): ArrowRight 가 펼치고 ArrowLeft 가 접는다',
    async ({ page, request }) => {
      const root = mkRoot('f5');
      await enterExplorer(page, request, root);
      await focusTree(page);
      await page.keyboard.press('ArrowDown');
      expect(await sel(page)).toBe(j(root, 'sub'));

      await page.keyboard.press('ArrowRight');
      await expect(row(page, j(root, 'sub', 'inner.txt'))).toBeVisible({ timeout: 10000 });
      await page.keyboard.press('ArrowLeft');
      await expect(row(page, j(root, 'sub', 'inner.txt'))).toHaveCount(0);
    });

  test('V-EXR-55 (FR-EXR-53): Delete 가 확인창을 띄운다. 취소하면 파일이 남는다',
    async ({ page, request }) => {
      const root = mkRoot('f6');
      await enterExplorer(page, request, root);
      await row(page, j(root, 'a.txt')).click();
      await expect.poll(() => page.evaluate(() =>
        !!document.activeElement?.closest('.ed-explorer'))).toBe(true);

      await page.keyboard.press('Delete');
      await expect(page.locator('.ed-confirm .confirm-msg')).toBeVisible({ timeout: 10000 });
      await page.locator('.ed-confirm .confirm-cancel').click();

      await expect(row(page, j(root, 'a.txt'))).toBeVisible();
      expect(fs.existsSync(j(root, 'a.txt')), '취소인데 지워졌다').toBe(true);
    });

  test('V-EXR-56 (FR-EXR-54): 루트가 선택된 동안 Delete·F2 는 아무 일도 하지 않는다',
    async ({ page, request }) => {
      const root = mkRoot('f7');
      await enterExplorer(page, request, root);
      await clickBlank(page);
      expect(await sel(page)).toBe(root);

      await page.keyboard.press('Delete');
      await expect(page.locator('.ed-confirm')).toHaveCount(0);
      await page.keyboard.press('F2');
      await expect(input(page)).toHaveCount(0);
      expect(fs.existsSync(root)).toBe(true);
    });

  test('V-EXR-57 (FR-EXR-55): 인라인 입력의 Delete 는 글자를 지운다',
    async ({ page, request }) => {
      const root = mkRoot('f8');
      await enterExplorer(page, request, root);
      await row(page, j(root, 'a.txt')).click();
      await page.locator('.ed-head-new-file').click();
      await input(page).fill('keep.txt');
      // 캐럿을 맨 앞에 두고 Delete — 입력의 것이면 `k` 가 지워진다.
      await page.evaluate(() => {
        (document.querySelector('.ed-input') as HTMLInputElement).setSelectionRange(0, 0);
      });
      await page.keyboard.press('Delete');

      await expect(input(page)).toHaveValue('eep.txt');
      expect(fs.existsSync(j(root, 'a.txt')), 'a.txt 가 지워졌다').toBe(true);
      await expect(page.locator('.ed-confirm')).toHaveCount(0);
      await input(page).press('Escape');
    });

  test('V-EXR-58 (FR-EXR-56): 탐색기에 포커스가 있어도 앱 단축키가 돈다',
    async ({ page, request }) => {
      const root = mkRoot('f9');
      await enterExplorer(page, request, root);
      await focusTree(page);
      // `newTab` 은 쓸 수 없다 — Editor 창에는 터미널 탭이 생기지 않는다
      // (FR-EDT-54). 어느 창에서나 도는 `sidebarToggle`(Ctrl+Shift+E)로 잰다.
      const collapsed = () => page.evaluate(() =>
        document.documentElement.classList.contains('sb-collapsed'));
      const before = await collapsed();
      await page.keyboard.press('Control+Shift+KeyE');
      await expect.poll(collapsed, { timeout: 10000 }).toBe(!before);
    });

  test('V-EXR-59 (FR-EXR-58): 한 번 클릭의 미리보기 뒤에도 포커스가 탐색기에 남는다',
    async ({ page, request }) => {
      const root = mkRoot('f10');
      await enterExplorer(page, request, root);
      await row(page, j(root, 'a.txt')).click();
      // 미리보기가 실제로 열렸음을 먼저 확인한다 — 열리지 않았다면 이 검증은
      // "포커스를 빼앗는 자리" 를 지나지 않는다 (FR-RTU-40).
      await expect.poll(() => edTab(page, j(root, 'a.txt')), { timeout: 15000 }).not.toBeNull();
      expect((await edTab(page, j(root, 'a.txt')))!.preview).toBe(true);

      expect(await page.evaluate(() => !!document.activeElement?.closest('.ed-explorer'))).toBe(true);
      // 그리고 방향키가 이어서 돈다 — 그것이 이 요구의 목적이다.
      await page.keyboard.press('ArrowDown');
      expect(await sel(page)).toBe(j(root, 'b.txt'));
    });

  test('V-EXR-59b (FR-EXR-59): 더블클릭은 포커스를 편집기로 넘긴다',
    async ({ page, request }) => {
      const root = mkRoot('f11');
      await enterExplorer(page, request, root);
      await row(page, j(root, 'a.txt')).dblclick();
      await expect.poll(() => edTab(page, j(root, 'a.txt')), { timeout: 15000 }).not.toBeNull();
      expect((await edTab(page, j(root, 'a.txt')))!.preview).toBe(false);

      await expect.poll(() => page.evaluate(() =>
        !!document.activeElement?.closest('.file-editor')), { timeout: 15000 }).toBe(true);
    });
});

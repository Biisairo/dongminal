import * as fs from 'fs';
import * as path from 'path';

import { APIRequestContext, Page } from '@playwright/test';

import { test, expect, addEditorRoot, rmTree, switchToEditorRoot } from './fixtures';
import { TMP, realPath, cssPath } from './osenv';

/**
 * **중첩된 Editor 루트** — 안쪽이 이긴다 (FR-EDT-95).
 *
 * 이 파일이 있는 이유는 CI_E2E_MATRIX_SRS R-6 이다. 앱은 사용자의 홈을 뿌리로 하는
 * 편집기를 늘 하나 세우고(FR-EDT-13), 그러면 **홈 아래의 모든 루트가 그 창에
 * 중첩된다.** Windows 의 임시 디렉터리는 홈 안이므로 그 OS 에서는 검사가 만든
 * 뿌리마다 이 상황이 되고, POSIX 의 `/tmp` 는 홈 밖이라 한 번도 되지 않았다 —
 * 즉 **두 OS 가 같은 조건에서 돌지 않았고, 그 조건을 재는 검사가 없었다.**
 *
 * 검사가 그 비대칭을 피해 가는 대신(러너에서는 `RUNNER_TEMP` 를 쓴다), 그 조건
 * 자체를 여기서 **어느 OS 에서나 똑같이** 만든다: 바깥 루트 하나와 그 **안쪽**
 * 루트 하나를 함께 등록하고, 안쪽 파일을 여는 모든 길이 안쪽 창으로 가는지 본다.
 *
 * 재는 것은 규칙 하나다 — 둘 이상이 그 경로를 품으면 **루트가 가장 깊은 것**이
 * 이긴다. 얕은 쪽이 이기면 사용자가 좁혀 두려고 만든 창이 한 번도 쓰이지 않는다.
 */

let BASE = '';
let OUTER = '';
let INNER = '';

const j = (...p: string[]) => path.join(...p);

test.beforeAll(() => {
  BASE = realPath(fs.mkdtempSync(j(TMP, 'dm-nest-')));
  OUTER = j(BASE, 'outer');
  INNER = j(OUTER, 'pkg', 'inner');
  fs.mkdirSync(j(INNER, 'deep'), { recursive: true });
  fs.writeFileSync(j(OUTER, 'outer.txt'), 'OUTER\n');
  fs.writeFileSync(j(INNER, 'inner.txt'), 'INNER\n');
  fs.writeFileSync(j(INNER, 'deep', 'nested.txt'), 'NESTED\n');
  OUTER = realPath(OUTER);
  INNER = realPath(INNER);
});
test.afterAll(() => { rmTree(BASE) });

/**
 * 둘을 **바깥부터** 등록한다. 순서가 뜻을 갖지 않아야 한다 — 규칙은 "깊은 것이
 * 이긴다" 이지 "나중에 더한 것이 이긴다" 가 아니다.
 */
async function enter(page: Page, request: APIRequestContext) {
  await addEditorRoot(request, OUTER);
  await addEditorRoot(request, INNER);
  await page.context().addInitScript(() => { sessionStorage.setItem('displayMode', 'desktop') });
  await page.goto('/');
  await page.waitForSelector('#area .pn.focused .xterm-helper-textarea', { timeout: 15000 });
  await page.waitForFunction(
    () => !!(window as any).app?._editors && (window as any).app._edWindows().length > 1,
    undefined, { timeout: 15000 });
  // 바깥 창에서 시작한다 — 안쪽 파일을 열었을 때 **옮겨 가는지**를 재려면 그렇다.
  await switchToEditorRoot(page, OUTER);
}

// 지금 활성 창의 Editor 루트.
const activeRoot = (page: Page) =>
  page.evaluate(() => {
    const a = (window as any).app;
    return String(a._edRootOf(a._aw()) || '');
  });

const key = (p: string) => String(p).replace(/\\/g, '/');

test.describe('중첩된 Editor 루트 — 안쪽이 이긴다 (FR-EDT-95)', () => {
  test('N1: 안쪽 파일을 열면 안쪽 창으로 간다 — 바깥이 품고 있어도', async ({ page, request }) => {
    await enter(page, request);
    expect(key(await activeRoot(page)), '바깥에서 시작하지 않았다').toBe(key(OUTER));

    await page.evaluate((p) => (window as any).app._edOpenFile(p), j(INNER, 'inner.txt'));
    await expect.poll(async () => key(await activeRoot(page)), { timeout: 15000 })
      .toBe(key(INNER));
  });

  test('N2: 여러 겹 아래의 파일도 안쪽 창이다', async ({ page, request }) => {
    await enter(page, request);
    await page.evaluate((p) => (window as any).app._edOpenFile(p), j(INNER, 'deep', 'nested.txt'));
    await expect.poll(async () => key(await activeRoot(page)), { timeout: 15000 })
      .toBe(key(INNER));
  });

  test('N3: 바깥에만 있는 파일은 바깥 창이다 — 안쪽이 가로채지 않는다', async ({ page, request }) => {
    await enter(page, request);
    await switchToEditorRoot(page, INNER);
    await page.evaluate((p) => (window as any).app._edOpenFile(p), j(OUTER, 'outer.txt'));
    await expect.poll(async () => key(await activeRoot(page)), { timeout: 15000 })
      .toBe(key(OUTER));
  });

  test('N4: 그 창의 탐색기가 연 파일을 펼쳐 보인다', async ({ page, request }) => {
    await enter(page, request);
    await page.evaluate((p) => (window as any).app._edOpenFile(p), j(INNER, 'deep', 'nested.txt'));
    await expect.poll(async () => key(await activeRoot(page)), { timeout: 15000 })
      .toBe(key(INNER));
    // 조상까지 펼쳐진다 (FR-EDT-63) — 중첩이어도 그 규약은 같다.
    for (const p of [j(INNER, 'deep'), j(INNER, 'deep', 'nested.txt')]) {
      await expect(page.locator(`.ed-tree .ed-row[data-path="${cssPath(p)}"]`))
        .toBeVisible({ timeout: 15000 });
    }
  });
});

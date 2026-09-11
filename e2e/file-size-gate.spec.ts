/**
 * FILE_API_BOUNDARY_SRS 묶음 S — 읽기 크기 상한 (TC-FAB-17).
 *
 * 값은 **10 MiB** 이고 서버와 클라이언트가 그것을 **한 벌로** 쓴다 —
 * `/api/file/probe` 가 `maxBytes` 를 실어 보내고 편집기가 그 값으로 판정한다
 * (FR-FAB-9). 상수를 두 벌로 두면 언젠가 한쪽만 고쳐지고, 그때 사용자는
 * "열린다고 했는데 안 열린다" 를 만난다.
 *
 * 그래서 이 검사는 **실물 파일**로 돈다. 가짜 probe 를 주입하면 정작 확인해야 할
 * 것 — 서버가 준 값이 그대로 판정에 쓰이는가 — 이 빠진다.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import { join } from 'path';

import {
  test, expect, waitForInit, addEditorRoot, switchToEditorRoot, rmTree,
} from './fixtures';
import { TMP, realPath } from './osenv';

let BASE = '';

test.beforeAll(() => {
  BASE = realPath(mkdtempSync(join(TMP, 'dm-fsz-')));
});
test.afterAll(() => { rmTree(BASE) });

test('TC-FAB-17: 상한을 넘는 텍스트 파일은 Monaco 를 세우지 않고 사유를 보인다', async ({ page, request }) => {
  const root = join(BASE, 'sizegate');
  mkdirSync(root, { recursive: true });
  // 10 MiB + 1 바이트. 상한과 **같은 크기**는 통과해야 하므로 경계 바로 위다.
  writeFileSync(join(root, 'big.txt'), Buffer.alloc(10 * 1024 * 1024 + 1, 0x61));
  writeFileSync(join(root, 'small.txt'), 'hello\n');

  const saved = await addEditorRoot(request, root);
  await waitForInit(page);
  await switchToEditorRoot(page, saved);

  await page.evaluate((p: string) => (window as any).app._edOpenFile(p, { pin: true }),
    saved + '/big.txt');

  // 사유가 보인다 — 크기와 상한을 함께 말한다.
  const gate = page.locator('.file-editor.vis .fe-unsupported');
  await expect(gate).toBeVisible({ timeout: 30000 });
  await expect(gate).toContainText('너무 커서');

  // **Monaco 가 서지 않았다.** 세우지 않으므로 저장 경로 자체가 생기지 않는다 —
  // 그것이 이 게이트의 목적이다.
  const built = await page.evaluate(() => {
    const v = [...(window as any).app.fileEditors.values()]
      .find((e: any) => e.name === 'big.txt') as any;
    return { hasEditor: !!(v && v._editor), dl: !!(v && v.el.querySelector('.fe-unsup-dl')) };
  });
  expect(built.hasEditor, 'Monaco 가 섰다 — 게이트를 지나쳤다').toBe(false);
  // 막기만 하면 사용자는 그 파일을 어떻게 보는지 모른 채 남는다 (FR-FAB-9).
  expect(built.dl, '나가는 길(내려받기)이 없다').toBe(true);

  // 같은 루트의 작은 파일은 그대로 열린다 — 게이트가 전부를 막으면 그것은 고장이다.
  await page.evaluate((p: string) => (window as any).app._edOpenFile(p, { pin: true }),
    saved + '/small.txt');
  await page.waitForFunction(() => {
    const eds = [...(window as any).app.fileEditors.values()];
    return eds.some((e: any) => e._editor && e.name === 'small.txt');
  }, undefined, { timeout: 30000 });
});

/**
 * CODEMIRROR_MIGRATION_SRS FR-CMR-74 — 편집기 칸의 세로 스크롤바는 직접 그린다.
 *
 * thumb 를 끌면 스크롤하고, track 을 누르면 thumb 의 가운데가 그 자리로 온다. 휠은 브라우저 동작이다.
 * thumb 와 미니맵 뷰포트 표시가 같은 자리에 서는 것은 `editor-minimap.spec.ts` 가 잰다.
 */
import { mkdtempSync } from 'fs';
import { join } from 'path';

import { Page } from '@playwright/test';

import { test, expect, rmTree, enterDocRoot, openDocFile } from './fixtures';
import { ED_SEL } from './editor';
import { TMP, realPath } from './osenv';

let BASE = '';
test.beforeAll(() => { BASE = realPath(mkdtempSync(join(TMP, 'dm-vsb-'))) });
test.afterAll(() => { rmTree(BASE) });
// 언어 서버 설치 제안 띠는 편집기 위쪽을 덮는 겹이다 — 그 기계에 markdown 서버가 없으면 띠가
// thumb 를 덮어 끌기가 띠에 먹힌다. 재려는 것은 스크롤바이므로 상태를 세워 띠를 빼고 잰다.
test.beforeEach(async ({ page }) => {
  await page.route('**/api/lsp/status', (r) => r.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify({ servers: [] }),
  }));
});

const scrollTop = (page: Page) => page.evaluate(() => {
  const v = [...(window as any).app.fileEditors.values()].find((e: any) => edT.has(e) && e.name === 'doc.md');
  return edT.scrollTop(edT.of(v));
});
const thumb = (page: Page) => page.locator(`.file-editor:visible ${ED_SEL.scrollThumb}`).first();

test('FR-CMR-74: thumb 를 끌면 스크롤하고, 브라우저 세로 스크롤바는 없다', async ({ page, request }) => {
  const root = await enterDocRoot(page, request, BASE, 'drag');
  await openDocFile(page, root);
  await expect(thumb(page)).toBeVisible();
  expect(await scrollTop(page)).toBe(0);
  // 브라우저 스크롤바가 남아 있으면 스크롤 영역의 폭과 안쪽 폭이 다르다.
  const native = await page.evaluate((sel) => {
    const s = document.querySelector('.file-editor ' + sel) as HTMLElement;
    return s.offsetWidth - s.clientWidth;
  }, ED_SEL.scroller);
  expect(native, '브라우저 세로 스크롤바가 보인다').toBe(0);

  const box = (await thumb(page).boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + 100, { steps: 5 });
  await page.mouse.up();
  await expect.poll(() => scrollTop(page)).toBeGreaterThan(0);
  // 끈 만큼 thumb 가 따라 내려왔다.
  await expect.poll(async () => Math.round((await thumb(page).boundingBox())!.y - box.y)).toBe(100);
});

test('FR-CMR-74: track 을 누르면 thumb 의 가운데가 그 자리로 온다', async ({ page, request }) => {
  const root = await enterDocRoot(page, request, BASE, 'track');
  await openDocFile(page, root);
  await expect(thumb(page)).toBeVisible();
  const track = (await page.locator(`.file-editor:visible ${ED_SEL.scrollTrack}`).first().boundingBox())!;
  const y = track.y + track.height * 0.6;
  await page.mouse.click(track.x + track.width / 2, y);
  await expect.poll(async () => {
    const b = (await thumb(page).boundingBox())!;
    // scrollTop 과 클릭 좌표가 정수로 맞춰지므로 1px 안이다.
    return Math.abs(b.y + b.height / 2 - y);
  }).toBeLessThanOrEqual(1);
  expect(await scrollTop(page)).toBeGreaterThan(0);
});

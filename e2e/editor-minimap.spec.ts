/**
 * 편집기의 **미리보기(미니맵)와 스크롤바가 같은 자리에 선다** — FR-MMP-1~3.
 *
 * 접수한 말은 "미니맵이 스크롤 위치와 안 맞는다" 였다. 원인은 `minimap.size` 의
 * 기본값 `'fit'` 이다: 문서가 편집기보다 짧으면 미니맵을 **편집기 높이에 맞춰
 * 늘리는데**, 스크롤바 슬라이더는 그러지 않는다 — 둘이 같은 비율을 딛지 않으니
 * 어긋난다. `'fill'` 은 두 표면을 같은 규칙 위에 세운다.
 *
 * `TEST-7` 로 `ux-batch6`(V-MMP-1)·`ux-batch8`(V-MMP-2·2b)에서 옮겨 왔다 —
 * 납품 묶음이 아니라 **이 기능**이 이 파일의 주제다. 단정은 그대로다.
 */
import { mkdtempSync, writeFileSync } from 'fs';
import { join } from 'path';

import { Page } from '@playwright/test';

import {
  test, expect, waitForInit, openGit, makeCopyFx, gitFixture, cleanGitFixture,
  rmTree, enterDocRoot, openDocFile, clickRow,
} from './fixtures';
import { ED_SEL } from './editor';
import { TMP, tmpPath, realPath, cssPath } from './osenv';

let BASE = '';
const FIXTURES = tmpPath('dm-mmp-fx-' + process.pid);

test.beforeAll(() => {
  BASE = realPath(mkdtempSync(join(TMP, 'dm-mmp-')));
  gitFixture(FIXTURES);
});
test.afterAll(() => {
  rmTree(BASE);
  cleanGitFixture(FIXTURES);
});

const copyFx = makeCopyFx(FIXTURES);


// V-MMP-1 (FR-MMP-1): 긴 문서 — 미니맵이 늘어날 일이 없는 쪽이다.
test('V-MMP-1 (FR-MMP-1): 편집기의 미리보기가 스크롤바와 맞는다', async ({ page }) => {
  const repo = copyFx('basic', 'mmp-long');
  const long = join(repo, 'long.txt');
  writeFileSync(long, Array.from({ length: 900 }, (_, i) => `line ${i} — 한글도 섞는다`).join('\n') + '\n');
  await waitForInit(page);
  await openGit(page, repo);
  await page.evaluate((p: string) => (window as any).app.testing.edOpenFile(p, { pin: true }), long);
  await page.waitForFunction(() => {
    const eds = [...(window as any).app.fileEditors.values()];
    return eds.some((e: any) => edT.has(e));
  }, undefined, { timeout: 30000 });

  const got = await page.evaluate(async () => {
    const ed = [...(window as any).app.fileEditors.values()].find((e: any) => edT.has(e)) as any;
    const e = edT.of(ed);
    edT.setScrollTop(e, edT.scrollHeight(e) * 0.45);
    await new Promise((r) => setTimeout(r, 400));
    const box = ed.el.getBoundingClientRect();
    const rect = (sel: string) => {
      const x = ed.el.querySelector(sel);
      if (!x) return null;
      const r = x.getBoundingClientRect();
      return { top: Math.round(r.top - box.top), h: Math.round(r.height) };
    };
    return { mini: rect(edT.sel.minimapSlider), bar: rect(edT.sel.scrollThumb) };
  });
  expect(got.mini, '미니맵 슬라이더가 없다').not.toBeNull();
  expect(got.bar, '스크롤바 슬라이더가 없다').not.toBeNull();
  expect(got.mini).toEqual(got.bar);
});

// V-MMP-2 (FR-MMP-2·3): **짧은 문서** — `'fit'` 이 덮지 못하던 구간이 여기다.
test('V-MMP-2: 짧은 문서에서도 미니맵이 스크롤바와 같은 자리에 선다', async ({ page, request }) => {
  const root = await enterDocRoot(page, request, BASE, 'mmp');
  await openDocFile(page, root);

  const got = await page.evaluate(async () => {
    const v = [...(window as any).app.fileEditors.values()]
      .find((e: any) => edT.has(e) && e.name === 'doc.md') as any;
    const ed = edT.of(v);
    const box = v.el.getBoundingClientRect();
    const rect = (sel: string) => {
      const x = v.el.querySelector(sel);
      if (!x) return null;
      const r = x.getBoundingClientRect();
      return { top: Math.round(r.top - box.top), h: Math.round(r.height) };
    };
    const H = edT.scrollHeight(ed), L = edT.viewHeight(ed);
    const out: any[] = [];
    for (const ratio of [0, 0.45, 1]) {
      edT.setScrollTop(ed, Math.round((H - L) * ratio));
      await new Promise((r) => setTimeout(r, 400));
      out.push({ ratio, mini: rect(edT.sel.minimapSlider), bar: rect(edT.sel.scrollThumb) });
    }
    return { out, size: edT.option(ed, 'minimapSize'),
      shorter: H < L * 2 };
  });

  expect(got.size, 'minimap.size 가 fill 이 아니다').toBe('fill');
  for (const s of got.out) {
    expect(s.mini, `미니맵 슬라이더가 없다 (${s.ratio})`).not.toBeNull();
    expect(s.bar, `스크롤바 슬라이더가 없다 (${s.ratio})`).not.toBeNull();
    expect(s.mini, `${s.ratio} 지점에서 두 슬라이더가 어긋난다`).toEqual(s.bar);
  }
});

/**
 * V-MMP-2b — **Diff 에는 미니맵이 없고, Diff 자신의 눈금은 있다** (FR-M9-5 / D-M9-5 · CODEMIRROR_MIGRATION_SRS FR-CMR-56·57).
 *
 * 종전에는 옛 엔진의 옵션 덩이(`GIT_DIFF_OPTIONS`)의 값을 읽었다. 그 덩이는 엔진과 함께 사라졌으므로
 * 화면을 잰다 — 편집기의 미니맵 설정이 켜져 있어도 Diff 칸에는 미니맵이 서지 않는다 (§3.16, M9).
 */
test('V-MMP-2b: Diff 에는 미니맵이 없고 Diff 의 눈금은 있다', async ({ page }) => {
  const repo = copyFx('basic', 'mmp-diff');
  await waitForInit(page);
  await openGit(page, repo);
  await page.locator('#area .pn-tab[data-git-view="diff"]').click();
  const view = page.locator('#area .pn-body .git-view.git-diff');
  await expect(view).toHaveClass(/vis/);
  const row = page.locator(`#area .ed-side .git-view.git-changes .git-file[data-path="${cssPath('tracked.txt')}"]`).first();
  await expect(row).toBeVisible({ timeout: 15000 });
  await clickRow(page, row, async () => {
    await page.waitForFunction(
      () => edT.diffReady((window as any).app?.gitPanel?._diffView), undefined, { timeout: 8000 });
  });

  await expect(view.locator(ED_SEL.diffRuler), 'Diff 의 눈금이 없다 (FR-DOR-1 을 잃는다)').toBeVisible();
  await expect(view.locator(ED_SEL.minimap), 'Diff 칸에 미니맵이 섰다').toHaveCount(0);
});

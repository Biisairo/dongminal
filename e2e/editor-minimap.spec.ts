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
  rmTree, enterDocRoot, openDocFile,
} from './fixtures';
import { TMP, tmpPath, realPath } from './osenv';

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

// 페이지의 전역 상수 — `<script>` 로 로드되므로 import 대상이 아니다.
declare const GIT_DIFF_OPTIONS: any;

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
    return eds.some((e: any) => e._editor);
  }, undefined, { timeout: 30000 });

  const got = await page.evaluate(async () => {
    const ed = [...(window as any).app.fileEditors.values()].find((e: any) => e._editor) as any;
    const e = ed._editor;
    e.setScrollTop(e.getScrollHeight() * 0.45);
    await new Promise((r) => setTimeout(r, 400));
    const box = ed.el.getBoundingClientRect();
    const rect = (sel: string) => {
      const x = ed.el.querySelector(sel);
      if (!x) return null;
      const r = x.getBoundingClientRect();
      return { top: Math.round(r.top - box.top), h: Math.round(r.height) };
    };
    return { mini: rect('.minimap-slider'), bar: rect('.scrollbar.vertical > .slider') };
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
      .find((e: any) => e._editor && e.name === 'doc.md') as any;
    const ed = v._editor;
    const box = v.el.getBoundingClientRect();
    const rect = (sel: string) => {
      const x = v.el.querySelector(sel);
      if (!x) return null;
      const r = x.getBoundingClientRect();
      return { top: Math.round(r.top - box.top), h: Math.round(r.height) };
    };
    const H = ed.getScrollHeight(), L = ed.getLayoutInfo().height;
    const out: any[] = [];
    for (const ratio of [0, 0.45, 1]) {
      ed.setScrollTop(Math.round((H - L) * ratio));
      await new Promise((r) => setTimeout(r, 400));
      out.push({ ratio, mini: rect('.minimap-slider'), bar: rect('.scrollbar.vertical > .slider') });
    }
    return { out, size: ed.getOption((window as any).monaco.editor.EditorOption.minimap).size,
      shorter: H < L * 2 };
  });

  expect(got.size, 'minimap.size 가 fill 이 아니다').toBe('fill');
  for (const s of got.out) {
    expect(s.mini, `미니맵 슬라이더가 없다 (${s.ratio})`).not.toBeNull();
    expect(s.bar, `스크롤바 슬라이더가 없다 (${s.ratio})`).not.toBeNull();
    expect(s.mini, `${s.ratio} 지점에서 두 슬라이더가 어긋난다`).toEqual(s.bar);
  }
});

// V-MMP-2b (FR-MMP-2): diff 도 같은 값을 딛는다.
//
// 좌표 일치는 위에서 이미 쟀다 — 두 표면은 같은 Monaco 규칙 위에 서므로 여기서
// 재는 것은 **옵션이 갈라지지 않았는가** 다. diff 는 짧은 것이 흔해서(한 파일의
// 몇 줄) `'fit'` 이 아무것도 하지 않는 구간에 가장 자주 놓인다.
test('V-MMP-2b: diff 편집기의 미니맵도 fill 이다', async ({ page }) => {
  await waitForInit(page);
  const size = await page.evaluate(() => GIT_DIFF_OPTIONS.minimap.size);
  expect(size, 'diff 옵션이 편집기와 갈라졌다').toBe('fill');
});

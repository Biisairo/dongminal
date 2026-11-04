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
 * V-ELS-13·14·15 (EDITOR_LINK_LSP_SRS FR-ELS-50~55) — 미니맵은 문서 전체를 스크롤 높이 비율로 그린다.
 *
 * 줄 `n` 의 미니맵 자리는 `lineBox(n).top × 보이는 높이 / 스크롤 높이` 다. 슬라이더(=thumb)의 위·아래 끝이
 * 곧 보이는 영역이므로, 보이는 첫 줄과 마지막 줄이 슬라이더 양 끝에 걸린다. 짧은 문서가 접수된 경우다.
 */
for (const lines of [120, 400]) {
  test(`V-ELS-13·14: ${lines}줄 문서 — 미니맵 줄 자리가 스크롤 비율이고, 슬라이더 양 끝이 보이는 줄이다`, async ({ page, request }) => {
    const root = await enterDocRoot(page, request, BASE, 'els-' + lines);
    writeFileSync(join(root, 'doc.md'), Array.from({ length: lines }, (_, i) => `line ${i + 1}`).join('\n') + '\n');
    await openDocFile(page, root);

    const got = await page.evaluate(async () => {
      const v = [...(window as any).app.fileEditors.values()].find((e: any) => edT.has(e) && e.name === 'doc.md') as any;
      const ed = edT.of(v);
      const mm = v.el.querySelector(edT.sel.minimap).getBoundingClientRect();
      const H = edT.scrollHeight(ed), L = edT.viewHeight(ed);
      const k = L / H;
      const n = edT.lineCount(ed);
      const rowOf = (line: number) => edT.minimapRows(ed).find((r: any) => r.line === line);
      const out: any[] = [];
      let before: any = null;
      for (const ratio of [0, 0.5, 1]) {
        edT.setScrollTop(ed, Math.round((H - L) * ratio));
        await new Promise((r) => setTimeout(r, 400));
        if (!before) before = JSON.stringify(edT.minimapRows(ed));
        const st = edT.scrollTop(ed);
        let first = 1, last = n;
        for (let i = 1; i <= n; i++) { const b = edT.lineBox(ed, i); if (b.top + b.h > st) { first = i; break } }
        for (let i = n; i >= 1; i--) { if (edT.lineBox(ed, i).top < st + L) { last = i; break } }
        const sl = v.el.querySelector(edT.sel.minimapSlider).getBoundingClientRect();
        const a = rowOf(first), z = rowOf(last);
        out.push({
          ratio,
          sliderTop: sl.top - mm.top, sliderBottom: sl.bottom - mm.top,
          firstY: a && a.y, firstEnd: a && a.y + a.h, lastY: z && z.y, lastEnd: z && z.y + z.h,
        });
      }
      const samples = [1, Math.ceil(n / 2), n].map((line) => {
        const r = rowOf(line);
        return { line, y: r ? r.y : null, want: edT.lineBox(ed, line).top * k };
      });
      return { out, samples, same: before === JSON.stringify(edT.minimapRows(ed)) };
    });

    for (const s of got.samples) {
      expect(s.y, `줄 ${s.line} 이 미니맵에 그려지지 않았다`).not.toBeNull();
      expect(Math.abs(s.y - s.want), `줄 ${s.line} 의 미니맵 자리 ${s.y} ≠ ${s.want}`).toBeLessThanOrEqual(2);
    }
    for (const o of got.out) {
      // 보이는 첫 줄이 슬라이더 top 에, 마지막 줄이 bottom 에 걸린다.
      expect(o.firstY! - 2, `${o.ratio}: 첫 줄이 슬라이더 위에 있다`).toBeLessThanOrEqual(o.sliderTop);
      expect(o.firstEnd! + 2, `${o.ratio}: 첫 줄이 슬라이더 top 보다 아래다`).toBeGreaterThanOrEqual(o.sliderTop);
      expect(o.lastY! - 2, `${o.ratio}: 마지막 줄이 슬라이더 bottom 보다 아래다`).toBeLessThanOrEqual(o.sliderBottom);
      expect(o.lastEnd! + 2, `${o.ratio}: 마지막 줄이 슬라이더 bottom 보다 위다`).toBeGreaterThanOrEqual(o.sliderBottom);
    }
    expect(got.same, 'V-ELS-14: 스크롤만으로 미니맵 내용이 바뀌었다').toBe(true);
  });
}

// V-ELS-21 (FR-ELS-53): 한 줄은 한 번만 그린다 — 스크롤이 없는 짧은 문서(비율이 정수)에서 줄마다 두 번 그리던 회귀.
for (const lines of [30, 400]) {
  test(`V-ELS-21: ${lines}줄 문서 — 미니맵이 줄마다 한 번만 그리고, 파일이 밖에서 바뀌어도 곧 따라온다`, async ({ page, request }) => {
    const root = await enterDocRoot(page, request, BASE, 'els-once-' + lines);
    writeFileSync(join(root, 'doc.md'), Array.from({ length: lines }, (_, i) => `line ${i + 1}`).join('\n') + '\n');
    await openDocFile(page, root);
    const rows = () => page.evaluate(() => {
      const v = [...(window as any).app.fileEditors.values()].find((e: any) => edT.has(e) && e.name === 'doc.md') as any;
      const ed = edT.of(v);
      return { lines: edT.lineCount(ed), rows: edT.minimapRows(ed).map((r: any) => r.line) };
    });
    const once = (r: number[]) => r.every((l, i) => i === 0 || l > r[i - 1]);
    await expect.poll(async () => (await rows()).rows.length).toBeGreaterThan(0);
    const a = await rows();
    expect(once(a.rows), '같은 줄을 두 번 그렸다').toBe(true);
    if (lines <= 30) expect(a.rows.length).toBe(a.lines);

    writeFileSync(join(root, 'doc.md'), Array.from({ length: 10 }, (_, i) => `disk ${i}`).join('\n') + '\n');
    await expect.poll(async () => (await rows()).lines, { timeout: 15000 }).toBe(11);
    await expect.poll(async () => (await rows()).rows.join(','), { timeout: 2000 })
      .toBe(Array.from({ length: 11 }, (_, i) => i + 1).join(','));
  });
}

// V-ELS-23 (FR-ELS-51·53): 줄바꿈이 켜져 있어도 열자마자 모든 줄을 그린다. 재지 않은 구간에서 높이로 줄을 물으면
// CM 이 글자 수 비율로 짐작한 줄을 돌려줘, 짧은 줄을 건너뛰고 스크롤해야 채워지던 회귀다 (2026-11-04 사용자 보고).
test('V-ELS-23: 줄바꿈이 켜진 문서도 열자마자 모든 줄을 그린다', async ({ page, request }) => {
  const root = await enterDocRoot(page, request, BASE, 'els-wrap');
  writeFileSync(join(root, 'doc.md'), Array.from({ length: 400 }, (_, i) => (i % 7 === 0 ? `para ${i} ` + 'word '.repeat(60) : `short ${i}`)).join('\n'));
  await page.evaluate(() => { (window as any).editorWordWrap = true });
  await openDocFile(page, root);
  const got = await page.evaluate(() => {
    const v = [...(window as any).app.fileEditors.values()].find((e: any) => edT.has(e) && e.name === 'doc.md') as any;
    const ed = edT.of(v);
    return { wrap: edT.option(ed, 'wordWrap'), lines: edT.lineCount(ed), rows: edT.minimapRows(ed).map((r: any) => r.line) };
  });
  expect(got.wrap).toBe('on');
  expect(got.rows.every((l: number, i: number) => i === 0 || l > got.rows[i - 1]), '같은 줄을 두 번 그렸다').toBe(true);
  expect(got.rows.length, '열자마자 그리지 않은 줄이 있다').toBe(got.lines);
});

// V-ELS-25 (FR-ELS-54): 줄바꿈이 꺼진 문서에서 스크롤만 하면 미니맵을 다시 그리지 않는다. 새 줄이 화면에 들어오면 CM 이
// 높이가 그대로여도 geometry·height 신호를 내므로, 신호가 아니라 그릴 결과로 판정해야 한다 (2026-11-04 사용자 보고).
test('V-ELS-25: 스크롤만 하면 미니맵을 다시 그리지 않는다', async ({ page, request }) => {
  const root = await enterDocRoot(page, request, BASE, 'els-noredraw');
  writeFileSync(join(root, 'doc.md'), Array.from({ length: 800 }, (_, i) => (i % 7 === 0 ? `# para ${i} ` + 'word '.repeat(60) : `- short ${i}`)).join('\n'));
  await openDocFile(page, root);
  // 한 바퀴의 다시 그리기 횟수를 잰다. 늦게 끝난 구문 강조가 첫 바퀴에 섞일 수 있으므로 0 이 될 때까지 다시 잰다.
  await expect.poll(() => page.evaluate(async () => {
    const v = [...(window as any).app.fileEditors.values()].find((e: any) => edT.has(e) && e.name === 'doc.md') as any;
    const ed = edT.of(v);
    edT.setScrollTop(ed, 0);
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    let last = edT.minimapRows(ed), n = 0;
    for (let i = 0; i < 60; i++) {
      edT.setScrollTop(ed, edT.scrollTop(ed) + 120);
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const cur = edT.minimapRows(ed);
      if (cur !== last) { n++; last = cur }
    }
    return n;
  }), { timeout: 15000 }).toBe(0);
});

// V-ELS-26·27·28 (FR-ELS-60~63): 줄바꿈이 켜진 문서 — 미니맵은 자체 배치라 스크롤로 꿈틀거리지 않고, 슬라이더는 보이는 줄에 맞는다.
const WRAP_DOC = Array.from({ length: 800 }, (_, i) => (i % 7 === 0 ? `# 문단 ${i} ` + '한글 낱말과 word 섞기 '.repeat(12) : `- 짧은 줄 ${i}`)).join('\n');
async function openWrapped(page: Page, request: any, name: string) {
  const root = await enterDocRoot(page, request, BASE, name);
  writeFileSync(join(root, 'doc.md'), WRAP_DOC);
  await page.evaluate(() => { (window as any).editorWordWrap = true });
  await openDocFile(page, root);
  await expect.poll(() => page.evaluate(() => {
    const v = [...(window as any).app.fileEditors.values()].find((e: any) => edT.has(e) && e.name === 'doc.md') as any;
    return edT.option(edT.of(v), 'wordWrap') === 'on' && edT.minimapRows(edT.of(v)).length > 0;
  })).toBe(true);
}

test('V-ELS-26: 줄바꿈이 켜져 있어도 스크롤만으로는 첫 바퀴부터 미니맵을 다시 그리지 않는다', async ({ page, request }) => {
  await openWrapped(page, request, 'els-wrap-still');
  const frames = (n: number) => `new Promise((r) => { let k = ${n}; const f = () => (--k ? requestAnimationFrame(f) : r(0)); requestAnimationFrame(f) })`;
  // 늦게 끝나는 구문 강조가 섞이지 않게, 미니맵이 20 프레임 동안 그대로인 것을 먼저 본다.
  await expect.poll(() => page.evaluate(async (wait: string) => {
    const v = [...(window as any).app.fileEditors.values()].find((e: any) => edT.has(e) && e.name === 'doc.md') as any;
    const a = edT.minimapRows(edT.of(v));
    await (0, eval)(wait);
    return a === edT.minimapRows(edT.of(v));
  }, frames(20)), { timeout: 15000 }).toBe(true);
  // 첫 바퀴 한 번만 잰다 — 다시 재면 CM 이 이미 높이를 다 재 둔 뒤라 고쳐진 것이 보이지 않는다.
  const n = await page.evaluate(async () => {
    const v = [...(window as any).app.fileEditors.values()].find((e: any) => edT.has(e) && e.name === 'doc.md') as any;
    const ed = edT.of(v);
    let last = edT.minimapRows(ed), c = 0;
    for (let i = 0; i < 80; i++) {
      edT.setScrollTop(ed, edT.scrollTop(ed) + 400);
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const cur = edT.minimapRows(ed);
      if (cur !== last) { c++; last = cur }
    }
    return c;
  });
  expect(n).toBe(0);
});

test('V-ELS-27: 줄바꿈이 켜져 있어도 슬라이더 양 끝이 보이는 첫 줄 · 끝 줄에 걸린다', async ({ page, request }) => {
  await openWrapped(page, request, 'els-wrap-slider');
  const got = await page.evaluate(async () => {
    const v = [...(window as any).app.fileEditors.values()].find((e: any) => edT.has(e) && e.name === 'doc.md') as any;
    const ed = edT.of(v);
    const out: any[] = [];
    for (const ratio of [0, 0.5, 1]) {
      const H = edT.scrollHeight(ed), L = edT.viewHeight(ed);
      edT.setScrollTop(ed, Math.round((H - L) * ratio));
      await new Promise((r) => setTimeout(r, 300));
      const st = edT.scrollTop(ed), n = edT.lineCount(ed);
      let first = 1, last = n;
      for (let i = 1; i <= n; i++) { const b = edT.lineBox(ed, i); if (b.top + b.h > st) { first = i; break } }
      for (let i = n; i >= 1; i--) { if (edT.lineBox(ed, i).top < st + edT.viewHeight(ed)) { last = i; break } }
      const mm = v.el.querySelector(edT.sel.minimap).getBoundingClientRect();
      const sl = v.el.querySelector(edT.sel.minimapSlider).getBoundingClientRect();
      const rows = edT.minimapRows(ed);
      const near = (line: number) => { let r = null; for (const x of rows) { if (x.line <= line) r = x; else break } return r };
      const a = near(first), z = near(last);
      out.push({ ratio, top: sl.top - mm.top, bottom: sl.bottom - mm.top, aY: a.y, aEnd: a.y + a.h, zY: z.y, zEnd: z.y + z.h });
    }
    return out;
  });
  for (const o of got) {
    expect(o.aY - 2, `${o.ratio}: 첫 줄이 슬라이더 top 아래다`).toBeLessThanOrEqual(o.top);
    expect(o.aEnd + 2, `${o.ratio}: 첫 줄이 슬라이더 top 위다`).toBeGreaterThanOrEqual(o.top);
    expect(o.zY - 2, `${o.ratio}: 끝 줄이 슬라이더 bottom 아래다`).toBeLessThanOrEqual(o.bottom);
    expect(o.zEnd + 2, `${o.ratio}: 끝 줄이 슬라이더 bottom 위다`).toBeGreaterThanOrEqual(o.bottom);
  }
});

/**
 * V-ELS-30 (EDITOR_LINK_LSP_SRS FR-ELS-64 개정) — 미니맵이 켜져 있으면 스크롤바도 미니맵 배치를 쓴다.
 *
 * 줄바꿈 문서에서 미니맵 배치(글자 수로 센 화면 줄)와 CM 의 높이는 다르다 — 한글이 섞인 긴 줄에서 그 차이가 크다
 * (사용자 문서 968줄에서 최대 15px). thumb 가 CM 의 높이를 따르면 슬라이더와 어긋난다.
 */
test('V-ELS-30: 줄바꿈이 켜져 있어도 스크롤바 thumb · ruler 가 미니맵 슬라이더 · 줄 자리와 같다', async ({ page, request }) => {
  await openWrapped(page, request, 'els-wrap-thumb');
  const got = await page.evaluate(async () => {
    const v = [...(window as any).app.fileEditors.values()].find((e: any) => edT.has(e) && e.name === 'doc.md') as any;
    const ed = edT.of(v);
    const rect = (sel: string) => v.el.querySelector(sel).getBoundingClientRect();
    const out: any[] = [];
    for (const ratio of [0, 0.3, 0.5, 0.8, 1]) {
      const H = edT.scrollHeight(ed), L = edT.viewHeight(ed);
      edT.setScrollTop(ed, Math.round((H - L) * ratio));
      await new Promise((r) => setTimeout(r, 300));
      const mm = rect(edT.sel.minimap), sl = rect(edT.sel.minimapSlider), th = rect(edT.sel.scrollThumb);
      out.push({ ratio, sl: [sl.top - mm.top, sl.bottom - mm.top], th: [th.top - mm.top, th.bottom - mm.top] });
    }
    // 그린 줄 하나에 커서를 둔다 — 그 줄의 미니맵 자리와 커서 ruler 표식의 자리를 견준다.
    const rows = edT.minimapRows(ed);
    const row = rows[Math.floor(rows.length * 0.6)];
    edT.setCursor(ed, row.line, 1);
    await new Promise((r) => setTimeout(r, 300));
    const mm = rect(edT.sel.minimap), track = rect('.cm-vscroll');
    const cur = edT.rulerItems(ed).find((x: any) => x.lane === 'full');
    const cursor = { line: row.line, mini: edT.minimapRows(ed).find((r: any) => r.line === row.line).y, ruler: cur ? cur.y + track.top - mm.top : null };
    // thumb 를 끝까지 끈다.
    const t = rect(edT.sel.scrollThumb);
    return { out, cursor, drag: { x: t.left + t.width / 2, y: t.top + t.height / 2, bottom: track.bottom } };
  });
  for (const o of got.out) {
    expect(Math.abs(o.th[0] - o.sl[0]), `${o.ratio}: thumb top ${o.th[0]} ≠ 슬라이더 top ${o.sl[0]}`).toBeLessThanOrEqual(1);
    expect(Math.abs(o.th[1] - o.sl[1]), `${o.ratio}: thumb bottom ${o.th[1]} ≠ 슬라이더 bottom ${o.sl[1]}`).toBeLessThanOrEqual(1);
  }
  expect(got.cursor.ruler, '커서 ruler 표식이 없다').not.toBeNull();
  expect(Math.abs(got.cursor.ruler! - got.cursor.mini), `줄 ${got.cursor.line}: ruler ${got.cursor.ruler} ≠ 미니맵 ${got.cursor.mini}`).toBeLessThanOrEqual(1);

  await page.mouse.move(got.drag.x, got.drag.y);
  await page.mouse.down();
  await page.mouse.move(got.drag.x, got.drag.bottom + 50, { steps: 8 });
  await page.mouse.up();
  await expect.poll(() => page.evaluate(() => {
    const v = [...(window as any).app.fileEditors.values()].find((e: any) => edT.has(e) && e.name === 'doc.md') as any;
    const ed = edT.of(v);
    const n = edT.lineCount(ed), b = edT.lineBox(ed, n);
    return b.top + b.h <= edT.scrollTop(ed) + edT.viewHeight(ed) + 1;
  }), { timeout: 5000, message: 'thumb 를 끝까지 끌어도 마지막 줄이 보이지 않는다' }).toBe(true);
});

test('V-ELS-28: 줄바꿈이 켜진 미니맵을 누르면 그 자리의 줄이 보인다', async ({ page, request }) => {
  await openWrapped(page, request, 'els-wrap-click');
  const target = await page.evaluate(() => {
    const v = [...(window as any).app.fileEditors.values()].find((e: any) => edT.has(e) && e.name === 'doc.md') as any;
    const ed = edT.of(v);
    const mm = v.el.querySelector(edT.sel.minimap).getBoundingClientRect();
    const y = mm.height * 0.75;
    const rows = edT.minimapRows(ed);
    let line = 1; for (const r of rows) { if (r.y <= y) line = r.line; else break }
    return { x: mm.left + mm.width / 2, y: mm.top + y, line };
  });
  await page.mouse.click(target.x, target.y);
  await expect.poll(() => page.evaluate((line: number) => {
    const v = [...(window as any).app.fileEditors.values()].find((e: any) => edT.has(e) && e.name === 'doc.md') as any;
    return edT.lineVisible(edT.of(v), line);
  }, target.line)).toBe(true);
});

test('V-ELS-29 (FR-ELS-66): 변경 표식이 화면 밖으로 나가도 본문 폭이 그대로다', async ({ page, request }) => {
  const root = await enterDocRoot(page, request, BASE, 'els-ddwidth');
  await openDocFile(page, root);
  await page.evaluate(() => {
    const v = [...(window as any).app.fileEditors.values()].find((e: any) => edT.has(e) && e.name === 'doc.md') as any;
    edT.insert(edT.of(v), 1, 1, 'changed\n');
  });
  const widths = await page.evaluate(async () => {
    const v = [...(window as any).app.fileEditors.values()].find((e: any) => edT.has(e) && e.name === 'doc.md') as any;
    const ed = edT.of(v);
    const content = v.el.querySelector(edT.sel.text) as HTMLElement;
    const out = new Set<number>();
    for (let i = 0; i < 20; i++) {
      out.add(content.clientWidth);
      edT.setScrollTop(ed, edT.scrollTop(ed) + 400);
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    }
    return [...out];
  });
  expect(widths).toHaveLength(1);
});

test('V-ELS-20 (FR-ELS-58): 파일을 열면 스크롤하지 않아도 미니맵이 그려진다', async ({ page, request }) => {
  const root = await enterDocRoot(page, request, BASE, 'els-open');
  await openDocFile(page, root);
  await expect.poll(() => page.evaluate(() => {
    const v = [...(window as any).app.fileEditors.values()].find((e: any) => edT.has(e) && e.name === 'doc.md') as any;
    const rows = edT.minimapRows(edT.of(v));
    return rows.length > 0 && rows[0].line === 1;
  }), { timeout: 5000 }).toBe(true);
});

test('V-ELS-22 (FR-ELS-55a): 마우스를 올리지 않아도 미니맵 슬라이더가 보인다', async ({ page, request }) => {
  const root = await enterDocRoot(page, request, BASE, 'els-always');
  await openDocFile(page, root);
  await page.mouse.move(5, 5);
  await expect.poll(() => page.evaluate(() => {
    const v = [...(window as any).app.fileEditors.values()].find((e: any) => edT.has(e) && e.name === 'doc.md') as any;
    const sl = v.el.querySelector(edT.sel.minimapSlider) as HTMLElement;
    const c = sl.parentElement as HTMLElement;
    return getComputedStyle(c).opacity + ' ' + getComputedStyle(c).display + ' ' + (sl.getBoundingClientRect().height > 0);
  })).toBe('1 block true');
});

test('V-ELS-15·24 (FR-ELS-55): 미니맵 슬라이더와 스크롤바 thumb 는 중립 회색 반투명이다 — 테마 색을 섞지 않는다', async ({ page, request }) => {
  const root = await enterDocRoot(page, request, BASE, 'els-color');
  await openDocFile(page, root);
  const got = await page.evaluate(() => {
    const v = [...(window as any).app.fileEditors.values()].find((e: any) => edT.has(e) && e.name === 'doc.md') as any;
    const sl = v.el.querySelector(edT.sel.minimapSlider) as HTMLElement;
    const th = v.el.querySelector(edT.sel.scrollThumb) as HTMLElement;
    return { sl: getComputedStyle(sl).backgroundColor, op: getComputedStyle(sl).opacity, th: getComputedStyle(th).backgroundColor };
  });
  const rgba = (c: string) => (/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/.exec(c) || []).slice(1).map(Number);
  const [sr, sg, sb, sa] = rgba(got.sl);
  const [tr, tg, tb, ta] = rgba(got.th);
  expect(sr === sg && sg === sb, '슬라이더가 회색이 아니다: ' + got.sl).toBe(true);
  expect(tr === tg && tg === tb, 'thumb 가 회색이 아니다: ' + got.th).toBe(true);
  expect(sa).toBeLessThan(1);
  expect(ta).toBeLessThan(1);
  expect(sa, '슬라이더는 thumb 보다 옅다').toBeLessThan(ta);
  expect(got.op).toBe('1');
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

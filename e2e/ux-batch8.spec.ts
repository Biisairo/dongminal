/**
 * UX_BATCH8_SRS — 접수한 4건의 검증.
 *
 * 접수한 넷 중 둘은 **이미 서 있던 것**이었다 — 닫기 팝업은 탭 닫기에 있었고
 * 미리보기 버튼은 DOM 에 있었다. 그러므로 이 파일이 재는 것은 "생겼는가" 가
 * 아니라 **닿지 않던 자리에 닿는가**, **보이지 않던 것이 보이는가** 다.
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

import { Page } from '@playwright/test';

import {
  test, expect, waitForInit, addEditorRoot, switchToEditorRoot, rmTree,
} from './fixtures';
import { TMP, realPath } from './osenv';

let BASE = '';

// 400줄 — **편집기 높이보다 짧은** 문서다. `size:'fit'` 이 덮지 못하던 구간이
// 바로 그것이므로(SRS §2.3), 이 길이가 V-MMP-2 의 본체다.
const SHORT_DOC = ['# 제목', '', '본문 하나.', '',
  ...Array.from({ length: 400 }, (_, i) => `line ${i + 1} 내용 ${i + 1}`)].join('\n') + '\n';

test.beforeAll(() => {
  BASE = realPath(mkdtempSync(join(TMP, 'dm-b8-')));
});
test.afterAll(() => { rmTree(BASE) });

/** 이 검사의 루트를 세우고 그 Editor 창으로 들어간다. */
async function enter(page: Page, request: any, name: string): Promise<string> {
  const root = join(BASE, name);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'doc.md'), SHORT_DOC);
  const saved = await addEditorRoot(request, root);
  await waitForInit(page);
  await switchToEditorRoot(page, saved);
  return saved;
}

/** 파일을 열고 Monaco 가 실제로 설 때까지 기다린다. */
async function openDoc(page: Page, root: string) {
  await page.evaluate((p: string) => (window as any).app._edOpenFile(p, { pin: true }),
    root + '/doc.md');
  await page.waitForFunction(() => {
    const eds = [...(window as any).app.fileEditors.values()];
    return eds.some((e: any) => e._editor && e.name === 'doc.md');
  }, undefined, { timeout: 30000 });
}

/** 열려 있는 문서를 dirty 로 만든다. */
async function makeDirty(page: Page, text = 'ZZ') {
  await page.evaluate((t: string) => {
    const v = [...(window as any).app.fileEditors.values()]
      .find((e: any) => e._editor && e.name === 'doc.md') as any;
    v._editor.executeEdits('spec', [{ range: new (window as any).monaco.Range(1, 1, 1, 1), text: t }]);
  }, text);
  await page.waitForFunction(
    () => [...(window as any).app.fileEditors.values()].some((e: any) => e._dirty),
    undefined, { timeout: 10000 });
}

const OVERLAY = '.confirm-overlay';

// 페이지의 전역 상수 — `editor-git-ux.spec.ts` 와 같은 규약이다.
declare const GIT_DIFF_OPTIONS: any;

// ── 묶음 A — 닫기 가드 ───────────────────────────────

// V-CLG-1 (FR-CLG-1·3)
test('V-CLG-1: dirty 인 창을 닫으면 묻고, 취소하면 창과 편집이 남는다', async ({ page, request }) => {
  const root = await enter(page, request, 'clg1');
  await openDoc(page, root);
  await makeDirty(page);

  const winId = await page.evaluate(() => (window as any).app._aw().id);
  await page.evaluate((id: string) => { (window as any).__del = (window as any).app.delWindow(id) }, winId);

  await expect(page.locator(OVERLAY)).toBeVisible({ timeout: 10000 });
  // 탭 닫기와 **같은 팝업**이다 — 문구도 버튼도 (FR-CLG-1).
  await expect(page.locator(OVERLAY + ' .confirm-msg')).toHaveText('저장되지 않은 변경사항이 있습니다.');
  await expect(page.locator(OVERLAY + ' .confirm-save')).toHaveText('저장 후 닫기');
  await expect(page.locator(OVERLAY + ' .confirm-ok')).toHaveText('닫기');
  await expect(page.locator(OVERLAY + ' .confirm-cancel')).toHaveText('취소');

  await page.click(OVERLAY + ' .confirm-cancel');
  await page.evaluate(() => (window as any).__del);
  const after = await page.evaluate((id: string) => ({
    there: !!(window as any).app.ws.windows.find((w: any) => w.id === id),
    dirty: [...(window as any).app.fileEditors.values()].some((e: any) => e._dirty),
  }), winId);
  expect(after.there, '취소했는데 창이 사라졌다').toBe(true);
  expect(after.dirty, '취소했는데 편집이 사라졌다').toBe(true);
});

// V-CLG-2 (FR-CLG-2)
test('V-CLG-2: 저장 후 닫기는 디스크에 쓰고 창을 닫는다', async ({ page, request }) => {
  const root = await enter(page, request, 'clg2');
  await openDoc(page, root);
  await makeDirty(page, 'SAVED');

  const winId = await page.evaluate(() => (window as any).app._aw().id);
  await page.evaluate((id: string) => { (window as any).__del = (window as any).app.delWindow(id) }, winId);
  await expect(page.locator(OVERLAY)).toBeVisible({ timeout: 10000 });
  await page.click(OVERLAY + ' .confirm-save');
  await page.evaluate(() => (window as any).__del);

  await expect.poll(
    () => readFileSync(join(root, 'doc.md'), 'utf8').slice(0, 5),
    { timeout: 15000, message: '저장 후 닫기가 디스크에 닿지 않았다' },
  ).toBe('SAVED');
  const gone = await page.evaluate((id: string) =>
    !(window as any).app.ws.windows.find((w: any) => w.id === id), winId);
  expect(gone, '저장했는데 창이 남았다').toBe(true);
});

// V-CLG-3 (FR-CLG-5·6)
//
// 가드가 `preventDefault()` 를 불렀는지로 잰다 — `leave-confirm.spec.ts` 와 같은
// 수단이다 (그 문서 §4: 실제 대화창은 headless 에서 결정론적이지 않다).
test('V-CLG-3: 도구가 없어도 dirty 면 떠남을 막는다 — 스위치 아래에서', async ({ page, request }) => {
  const root = await enter(page, request, 'clg3');
  await openDoc(page, root);

  const fires = () => page.evaluate(() => {
    const ev = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(ev);
    return ev.defaultPrevented;
  });
  const setLeave = (on: boolean) => page.evaluate((v: boolean) => { (window as any).confirmLeave = v }, on);

  // 전제: 스위치가 켜져 있고, 잃을 **도구**는 이 창에 없다.
  await setLeave(true);
  await page.evaluate((id: string) => {
    const a = (window as any).app;
    const w = a.ws.windows.find((x: any) => x.id === id);
    (window as any).__tools = a.tools;
    a.tools = new Map();
    return !!w;
  }, await page.evaluate(() => (window as any).app._aw().id));

  expect(await fires(), 'dirty 가 없는데 막았다').toBe(false);
  await makeDirty(page);
  expect(await fires(), 'dirty 인데 떠남을 막지 않았다').toBe(true);

  // FR-CLG-6: 스위치 아래에 산다 — 끈 사용자에게 새 사유로 다시 묻지 않는다.
  await setLeave(false);
  expect(await fires(), '스위치를 껐는데 막았다').toBe(false);

  await page.evaluate(() => { (window as any).app.tools = (window as any).__tools });
});

// ── 묶음 B — 간격 ───────────────────────────────────

// V-GAP-1 (FR-GAP-1·2)
test('V-GAP-1: 아이콘과 글자 사이가 키트의 간격이다', async ({ page }) => {
  await waitForInit(page);
  const got = await page.evaluate(() => {
    const px = (v: string) => parseFloat(v) || 0;
    const token = px(getComputedStyle(document.documentElement).getPropertyValue('--ui-gap'));
    const box = document.querySelector('#add-sandbox-window') as HTMLElement;
    const ctl = document.querySelector('.slot-ctl') as HTMLElement;
    return {
      token,
      boxGap: px(getComputedStyle(box).columnGap),
      boxDisplay: getComputedStyle(box).display,
      ctlGap: px(getComputedStyle(ctl).columnGap),
      // 간격이 **실제로** 벌어졌는가 — 아이콘의 오른쪽 변과 글자의 시작 사이.
      boxIconRight: (box.querySelector('svg') as SVGElement).getBoundingClientRect().right,
      boxRight: box.getBoundingClientRect().right,
    };
  });
  expect(got.token, '--ui-gap 토큰이 없다').toBeGreaterThan(0);
  // FR-GAP-3: 값을 px 로 적지 않는다 — 토큰과 같아야 한다.
  expect(got.boxGap).toBe(got.token);
  expect(got.ctlGap).toBe(got.token);
  // inline 이면 gap 이 걸리지 않는다 — 그것이 접수된 결함이었다.
  expect(got.boxDisplay).toContain('flex');
  expect(got.boxRight - got.boxIconRight).toBeGreaterThan(got.token);
});

// ── 묶음 C — 미니맵 ─────────────────────────────────

// V-MMP-2 (FR-MMP-2·3)
test('V-MMP-2: 짧은 문서에서도 미니맵이 스크롤바와 같은 자리에 선다', async ({ page, request }) => {
  const root = await enter(page, request, 'mmp');
  await openDoc(page, root);

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

// ── 묶음 D·E — 미리보기 버튼과 스크롤 ────────────────

// V-DRB-1 (FR-DRB-1·2) · V-SCR-1 (FR-SCR-2)
test('V-DRB-1: 미리보기 버튼에 라벨이 있고, 렌더 뷰는 공통 스크롤을 쓴다', async ({ page, request }) => {
  const root = await enter(page, request, 'drb');
  await openDoc(page, root);

  const btn = page.locator('.file-editor.vis .fe-render');
  await expect(btn).toHaveCount(1);
  // FR-DRB-1: **낱말 하나다** — 기호는 이름 앞의 장식이었다.
  await expect(btn).toHaveText('미리보기');
  const look = await page.evaluate(() => {
    const v = [...(window as any).app.fileEditors.values()]
      .find((e: any) => e._editor && e.name === 'doc.md') as any;
    const b = v.el.querySelector('.fe-render') as HTMLElement;
    const cs = getComputedStyle(b);
    const r = b.getBoundingClientRect();
    const box = v.el.getBoundingClientRect();
    return {
      w: r.width, opacity: parseFloat(cs.opacity), scroll: b.scrollWidth,
      // FR-DRB-3: 미니맵의 왼쪽 변보다 앞에 선다 — 그것이 "가리지 않는다" 의 뜻이다.
      right: Math.round(r.right - box.left),
      minimapLeft: v._editor.getLayoutInfo().minimap.minimapLeft,
    };
  });
  // 라벨을 담는 폭이다 — 22px 정사각이던 때의 폭으로는 글자가 들어가지 않는다.
  expect(look.w).toBeGreaterThan(40);
  // 라벨이 상자 밖으로 넘치지 않는다.
  expect(Math.round(look.w)).toBeGreaterThanOrEqual(look.scroll);
  expect(look.opacity).toBeGreaterThanOrEqual(0.85);
  expect(look.minimapLeft, '미니맵이 서지 않아 이 단언이 뜻을 잃는다').toBeGreaterThan(0);
  expect(look.right, '버튼이 미니맵·스크롤바를 덮는다').toBeLessThanOrEqual(look.minimapLeft);

  await btn.click();
  const body = page.locator('.doc-render .dr-body');
  await expect(body).toBeVisible({ timeout: 20000 });
  // FR-SCR-2: 스크롤 표면은 키트의 것이다.
  await expect(body).toHaveClass(/ui-scroll/);
});

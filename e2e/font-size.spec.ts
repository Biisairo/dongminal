import * as fs from 'fs';
import * as path from 'path';

import { Page } from '@playwright/test';

import { test, expect, waitForInit, rmTree, enterExplorer } from './fixtures';
import { TMP, realPath } from './osenv';

/**
 * FONT_SIZE_SETTING_SRS — 글자 크기 설정 (FR-FSS-1~23).
 *
 * 접수한 말은 "글자크기 변경 기능" 한 줄이고, 인터뷰가 그것을 **둘**로 갈랐다:
 * UI 는 배율 · 터미널은 px, 그리고 **서로 독립**이다.
 *
 * 그래서 이 파일의 중심은 `V-FSS-9` 다 — 한쪽을 움직였을 때 다른 쪽이 **안
 * 움직이는가**. 착수 시 터미널은 `--fs-lg` 를 읽었고(`FR-M11-15`), 그 결합이
 * 남아 있으면 UI 를 키울 때 터미널이 따라 커진다. 나머지 검사는 그 갈라짐이
 * 쓸 만한지를 본다 (상자가 함께 커지는가 · 열린 것이 따라오는가 · 남는가).
 */

const j = (...p: string[]) => path.join(...p);
let BASE = '';

function mkRoot(tag: string) {
  const d = j(BASE, tag);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(j(d, 'a.txt'), 'AAA\nBBB\nCCC\n');
  return realPath(d);
}

test.beforeAll(() => { BASE = realPath(fs.mkdtempSync(j(TMP, 'dm-fs-'))) });
test.afterAll(() => { if (BASE) rmTree(BASE) });

/**
 * **두 값을 기본으로 되돌리고 나간다.**
 *
 * 설정은 서버 블롭에 살고(FR-FSS-18) 워커의 서버는 테스트들이 함께 쓴다 — 이
 * 파일은 배율을 200 까지 올리므로, 되돌리지 않으면 다음 테스트가 그 값을 물려받는다
 * (실측: F3 이 남긴 180 을 F6 이 받아 편집기가 13 대신 23 으로 섰다).
 *
 * 블롭을 통째로 덮지 않고 **읽어서 두 키만 고친다** — 같은 워커의 다른 spec 이
 * 세워 둔 설정을 지우지 않기 위해서다.
 */
test.afterEach(async ({ request }) => {
  const cur = await (await request.get('/api/settings')).json();
  await request.put('/api/settings', {
    data: { ...cur, uiFontScale: 100, termFontSize: 14 },
  });
});

/**
 * 토큰 하나가 **실제로 몇 px 이 되는가**.
 *
 * `getPropertyValue('--fs-sm')` 을 쓰지 않는다 — 커스텀 프로퍼티는 계산 전
 * 문자열(`calc(11px * var(--fs-scale))`)로 나오고, 그것을 `parseFloat` 하면
 * `NaN` 이다. 값을 실제 속성에 얹어야 브라우저가 계산한다.
 *
 * 그래서 이 손이 재는 것은 토큰의 **정의**가 아니라 화면이 쓰는 **값**이다 —
 * 마침 그것이 우리가 재고 싶은 것이다.
 */
const cssPx = (page: Page, name: string, prop = 'font-size') =>
  page.evaluate(([n, p]) => {
    const el = document.createElement('div');
    el.style.position = 'absolute';
    el.style.visibility = 'hidden';
    el.style.setProperty(p, `var(${n})`);
    document.body.appendChild(el);
    const v = parseFloat(getComputedStyle(el).getPropertyValue(p));
    el.remove();
    return Math.round(v * 100) / 100;
  }, [name, prop]);

const cssRaw = (page: Page, name: string) => page.evaluate((n) =>
  getComputedStyle(document.documentElement).getPropertyValue(n).trim(), name);

const termFont = (page: Page) => page.evaluate(() => {
  const t = (window as any).app.testing.focusedTerminal();
  return t && t.term ? t.term.options.fontSize : null;
});

const termGrid = (page: Page) => page.evaluate(() => {
  const t = (window as any).app.testing.focusedTerminal();
  return t && t.term ? { cols: t.term.cols, rows: t.term.rows } : null;
});

const edFont = (page: Page) => page.evaluate(() => {
  const ed = [...(window as any).app.fileEditors.values()][0];
  return ed && ed._editor ? ed._editor.getRawOptions().fontSize : null;
});

async function openPanel(page: Page, tab: string) {
  await page.click('#settings-btn');
  await expect(page.locator('#modal-overlay')).toHaveClass(/open/, { timeout: 10000 });
  await page.click(`.mtab[data-tab="${tab}"]`);
  await expect(page.locator(`#panel-${tab}`)).toBeVisible({ timeout: 10000 });
}

async function closePanel(page: Page) {
  await page.click('#modal-close');
  await expect(page.locator('#modal-overlay')).not.toHaveClass(/open/, { timeout: 10000 });
}

/** 숫자 입력 하나를 채우고 확정한다 — `blur` 가 곧 확정이다 (FR-FSS-20). */
async function setNum(page: Page, sel: string, v: number) {
  const num = page.locator(sel);
  await expect(num).toBeVisible({ timeout: 10000 });
  await num.fill(String(v));
  await num.blur();
}

async function setUiScale(page: Page, v: number) {
  await openPanel(page, 'display');
  await setNum(page, '#ds-uifs', v);
  await closePanel(page);
}

async function setTermFont(page: Page, v: number) {
  await openPanel(page, 'terminal');
  await setNum(page, '#ds-termfs', v);
  await closePanel(page);
}

test.describe('글자 크기 설정 (FR-FSS-1~23)', () => {

  test('F1 (V-FSS-11 / FR-FSS-23): 기본값은 종전 화면을 낸다', async ({ page }) => {
    await waitForInit(page);
    // 배율 100 에서 다섯은 사상표의 값 그대로다 (DESIGN_TOKENS_SRS §3.3).
    expect(await cssPx(page, '--fs-xs')).toBe(9);
    expect(await cssPx(page, '--fs-sm')).toBe(11);
    expect(await cssPx(page, '--fs-md')).toBe(12);
    expect(await cssPx(page, '--fs-lg')).toBe(14);
    expect(await cssPx(page, '--fs-xl')).toBe(18);
    // 크기 토큰도 착수 시 실측 그대로다 (UI_KIT_SRS FR-UIK-2).
    expect(await cssPx(page, '--ui-btn-h', 'height')).toBe(26);
    expect(await cssPx(page, '--ui-tab-h', 'height')).toBe(30);
    // 터미널 기본은 14 — 종전 `--fs-lg` 가 주던 값과 같다.
    await expect.poll(() => termFont(page), { timeout: 15000 }).toBe(14);
  });

  test('F2 (V-FSS-5 / FR-FSS-4·5): 배율을 올리면 글꼴과 상자가 **함께** 커진다',
    async ({ page }) => {
      await waitForInit(page);
      await setUiScale(page, 150);
      // 글꼴 다섯.
      await expect.poll(() => cssPx(page, '--fs-sm'), { timeout: 10000 }).toBe(16.5);
      expect(await cssPx(page, '--fs-xs')).toBe(13.5);
      expect(await cssPx(page, '--fs-lg')).toBe(21);
      // 상자와 눈금. 글꼴만 커지면 버튼 안에서 글자가 넘친다 — 그것을 막는 것이
      // 이 단정이다 (§2.3).
      expect(await cssPx(page, '--ui-btn-h', 'height')).toBe(39);
      expect(await cssPx(page, '--ui-tab-h', 'height')).toBe(45);
      expect(await cssPx(page, '--ui-icon-md', 'width')).toBe(24);
      expect(await cssPx(page, '--ui-btn-px', 'padding-left')).toBe(15);
      // 실제로 그려진 버튼도 따라왔는가 — 토큰만 보면 쓰지 않는 토큰도 통과한다.
      const h = await page.locator('#settings-btn').evaluate((e) =>
        Math.round(e.getBoundingClientRect().height));
      expect(h).toBeGreaterThan(30);
    });

  test('F3 (V-FSS-6 / FR-FSS-6): 비율과 모서리는 배율을 따르지 않는다',
    async ({ page }) => {
      await waitForInit(page);
      const ratio0 = await cssRaw(page, '--ui-icon-ratio');
      const radius0 = await cssPx(page, '--ui-radius', 'border-top-left-radius');
      await setUiScale(page, 180);
      await expect.poll(() => cssPx(page, '--fs-sm'), { timeout: 10000 }).toBeGreaterThan(19);
      // 비율에 배율을 걸면 아이콘이 두 번 커진다. 모서리는 크기의 함수가 아니다.
      expect(await cssRaw(page, '--ui-icon-ratio')).toBe(ratio0);
      expect(await cssPx(page, '--ui-radius', 'border-top-left-radius')).toBe(radius0);
    });

  test('F4 (V-FSS-8 / FR-FSS-15·16): 터미널은 곧바로 따라오고 **다시 잰다**',
    async ({ page }) => {
      await waitForInit(page);
      await expect.poll(() => termFont(page), { timeout: 15000 }).toBe(14);
      const before = await termGrid(page);
      await setTermFont(page, 24);
      await expect.poll(() => termFont(page), { timeout: 10000 }).toBe(24);
      // 글자가 커지면 같은 상자에 들어가는 칸 수가 준다. 재지 않으면 화면이
      // 어긋난 채 남는다 (§2.5).
      const after = await termGrid(page);
      expect(after!.cols).toBeLessThan(before!.cols);
    });

  test('F5 (V-FSS-9 / FR-FSS-17): 둘은 **서로 움직이지 않는다** — FR-M11-15 의 결합이 끊겼다',
    async ({ page }) => {
      await waitForInit(page);
      await expect.poll(() => termFont(page), { timeout: 15000 }).toBe(14);

      // ① UI 만 키운다 → 터미널은 14 에 선다.
      await setUiScale(page, 200);
      await expect.poll(() => cssPx(page, '--fs-lg'), { timeout: 10000 }).toBe(28);
      expect(await termFont(page)).toBe(14);

      // ② 터미널만 키운다 → `--fs-lg` 는 28 에 선다.
      await setTermFont(page, 10);
      await expect.poll(() => termFont(page), { timeout: 10000 }).toBe(10);
      expect(await cssPx(page, '--fs-lg')).toBe(28);
    });

  test('F6 (V-FSS-7 / FR-FSS-9): 열려 있는 편집기가 배율을 따라온다',
    async ({ page, request }) => {
      const R = mkRoot('f6');
      await enterExplorer(page, request, R);
      await page.evaluate((p) => (window as any).app.testing.edOpenFile(p), j(R, 'a.txt'));
      await expect.poll(() => edFont(page), { timeout: 15000 }).toBe(13);

      // 편집 중인 내용과 커서를 잃지 않는다 — 재생성이 아니라 옵션 갱신이다
      // (FR-FSS-9, FR-MMT-4 와 같은 근거).
      await page.evaluate(() => {
        const ed = [...(window as any).app.fileEditors.values()][0];
        ed._editor.setValue('AAA\nBBB\nCCC\n');
        ed._editor.setPosition({ lineNumber: 2, column: 3 });
      });

      await setUiScale(page, 200);
      await expect.poll(() => edFont(page), { timeout: 10000 }).toBe(26);

      const after = await page.evaluate(() => {
        const ed = [...(window as any).app.fileEditors.values()][0];
        const p = ed._editor.getPosition();
        return { v: ed._editor.getValue(), ln: p.lineNumber, col: p.column };
      });
      expect(after.v).toBe('AAA\nBBB\nCCC\n');
      expect(after.ln).toBe(2);
      expect(after.col).toBe(3);
    });

  test('F7 (V-FSS-10 / FR-FSS-18): 두 값이 블롭에 실리고 새로고침 뒤에도 남는다',
    async ({ page, request }) => {
      await waitForInit(page);
      await setUiScale(page, 130);
      await setTermFont(page, 18);

      await expect.poll(async () => {
        const r = await request.get('/api/settings');
        const b = await r.json();
        return { u: b.uiFontScale, t: b.termFontSize };
      }, { timeout: 10000 }).toEqual({ u: 130, t: 18 });

      await page.reload();
      await waitForInit(page);
      await expect.poll(() => cssPx(page, '--fs-sm'), { timeout: 10000 }).toBe(14.3);
      await expect.poll(() => termFont(page), { timeout: 15000 }).toBe(18);
    });

  test('F9 (V-FSS-14 / FR-FSS-21): 설정 창을 열 때마다 입력란이 현재 값으로 다시 칠해진다',
    async ({ page }) => {
      await waitForInit(page);
      await setUiScale(page, 120);

      // 확정되지 않은 글자가 입력란에 남은 상태를 만든다. 이벤트를 내지 않으므로
      // 적용된 값은 120 그대로이고 **입력란만** 어긋난다 — 여는 순간이 그것을
      // 맞출 자리다 (FR-LVC-3 과 같은 근거).
      await openPanel(page, 'display');
      await page.evaluate(() => {
        (document.getElementById('ds-uifs') as HTMLInputElement).value = '999';
      });
      await closePanel(page);

      await openPanel(page, 'display');
      await expect(page.locator('#ds-uifs')).toHaveValue('120');
      await closePanel(page);
      // 화면은 내내 120 이었다 — 어긋난 것은 글자뿐이다.
      expect(await cssPx(page, '--fs-sm')).toBe(13.2);
    });

  test('F8 (V-FSS-4 / FR-FSS-19): 범위 밖은 자른다 — 거부하지 않는다',
    async ({ page }) => {
      await waitForInit(page);
      await openPanel(page, 'display');
      await setNum(page, '#ds-uifs', 999);
      // 잘린 사실이 **보여야** 사용자가 왜 그 크기인지 안다 (FR-TBW-4 와 같은 근거).
      await expect(page.locator('#ds-uifs')).toHaveValue('200', { timeout: 10000 });
      await closePanel(page);
      expect(await cssPx(page, '--fs-sm')).toBe(22);
    });
});

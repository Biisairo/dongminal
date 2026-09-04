import { execFileSync } from 'child_process';
import { mkdtempSync, writeFileSync, realpathSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { APIRequestContext, Page } from '@playwright/test';

import { test, expect } from './fixtures';

// 브라우저 쪽 전역 렉시컬 바인딩 (classic script 의 최상위 `const`).
declare const THEMES: Record<string, { ui: Record<string, string> }>;
declare const mixHex: (a: string, b: string, t: number) => string;
declare const SLOT_EDGE_MIX: number;

// 슬롯 제목과 경계 — SLOT_TITLE_BOUNDARY_SRS §5 TC-STB-*
//
// 두 가지를 잰다. ① 제목은 `<타입 라벨> · <창 이름>` 한 형식이고 그것을 만드는
// 자리가 하나다 (결함 A 는 자리가 둘이어서 생겼다). ② 슬롯 계층은 분할 계층과
// 다른 색·굵기로 그려진다.

function makeRepo(prefix: string) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  execFileSync('git', ['init', '-q', dir]);
  writeFileSync(join(dir, 'a.txt'), 'x');
  return dir;
}

async function pin(request: APIRequestContext, path: string) {
  const r = await request.post('/api/git/repos/pin', { data: { path } });
  expect(r.ok(), `pin 실패: ${await r.text()}`).toBeTruthy();
  return (await r.json()).root as string;
}

async function waitForInit(page: Page) {
  await page.context().addInitScript(() => { sessionStorage.setItem('displayMode', 'desktop') });
  await page.goto('/');
  await page.waitForSelector('#area .pn.focused .xterm-helper-textarea', { timeout: 15000 });
}

const topName = (page: Page) => page.locator('#window-name');
const head = (page: Page, i: number) => page.locator(`#area .slot[data-slot="${i}"] .slot-head`);
const listName = (page: Page, root: string) =>
  page.locator(`#repo-entries .git-repo.pinned[data-git-repo="${root}"] .git-repo-name`);

const slotAdd = (page: Page) => page.evaluate(() => (window as any).app.slotAdd());
const slotRemove = (page: Page) => page.evaluate(() => (window as any).app.slotRemove());
const focusSlot = (page: Page, i: number) => page.evaluate((n) => (window as any).app.slotFocusTo(n), i);
const openInSlot = (page: Page, i: number, id: string) =>
  page.evaluate(([n, w]) => (window as any).app.slotOpen(n, w), [i, id] as const);
const activeWindowOf = (page: Page) => page.evaluate(() => (window as any).app.ws.activeWindow);
const addWindow = (page: Page) =>
  page.evaluate(async () => {
    const r = await (window as any).app._mkWindow();
    (window as any).app.render();
    return r.win as string;
  });
const plainName = (page: Page, id: string) =>
  page.evaluate((w) => (window as any).app.ws.windows.find((x: any) => x.id === w).name, id);

test.describe('제목 — <타입 라벨> · <창 이름>', () => {
  // TC-STB-1
  test('터미널 창은 Windows 라벨을 단다', async ({ page }) => {
    await waitForInit(page);
    const id = await activeWindowOf(page);
    const name = await plainName(page, id);
    await expect(topName(page)).toHaveText(`Windows · ${name}`, { timeout: 10000 });
  });

  // TC-STB-2
  test('Git 창은 Git 라벨에 지금 보고 있는 리포를 단다', async ({ page, request }) => {
    const a = await pin(request, makeRepo('dm-stb-a-'));
    const b = await pin(request, makeRepo('dm-stb-b-'));
    await waitForInit(page);

    await page.evaluate((p) => (window as any).app.openGitWindow(p), a);
    const wantA = (await listName(page, a).textContent())!.trim();
    await expect(topName(page)).toHaveText(`Git · ${wantA}`, { timeout: 10000 });

    // 같은 창에서 리포만 바꾼다 — render 가 돌지 않는 경로다.
    await page.evaluate((p) => (window as any).app.openGitWindow(p), b);
    const wantB = (await listName(page, b).textContent())!.trim();
    expect(wantB).not.toBe(wantA);
    await expect(topName(page)).toHaveText(`Git · ${wantB}`, { timeout: 10000 });
  });

  // TC-STB-3 — 창 이름이 타입 라벨과 같으면 겹쳐 적지 않는다.
  test('리포를 고르지 않은 Git 창은 Git 하나만 적는다', async ({ page }) => {
    await waitForInit(page);
    await page.evaluate(() => (window as any).app.openGitWindow());
    await expect(topName(page)).toHaveText('Git', { timeout: 10000 });
  });

  // TC-STB-5 — 결함 A 회귀. 머리글과 토프바가 같은 이름을 써야 한다.
  test('Git 창의 머리글은 토프바와 같은 이름을 쓴다', async ({ page, request }) => {
    const a = await pin(request, makeRepo('dm-stb-c-'));
    await waitForInit(page);
    await page.evaluate((p) => (window as any).app.openGitWindow(p), a);
    const want = (await listName(page, a).textContent())!.trim();
    await expect(topName(page)).toHaveText(`Git · ${want}`, { timeout: 10000 });

    const gitWin = await activeWindowOf(page);
    await slotAdd(page);
    await openInSlot(page, 0, gitWin);
    await focusSlot(page, 0);
    // 머리글은 저장된 이름(`Git`)이 아니라 파생 이름을 쓴다.
    await expect(head(page, 0)).toHaveText(`Git · ${want}`, { timeout: 10000 });
    await expect(head(page, 0)).not.toHaveText('Git');
  });
});

test.describe('자리 분담 — 칸이 하나일 때와 여럿일 때', () => {
  // TC-STB-6
  test('칸이 둘이면 토프바는 비고 머리글이 제목을 낸다', async ({ page }) => {
    await waitForInit(page);
    const w0 = await activeWindowOf(page);
    const w1 = await addWindow(page);
    const n0 = await plainName(page, w0);
    const n1 = await plainName(page, w1);

    await slotAdd(page);
    await openInSlot(page, 0, w0);
    await openInSlot(page, 1, w1);
    await focusSlot(page, 0);

    await expect(topName(page)).toHaveText('', { timeout: 10000 });
    await expect(head(page, 0)).toHaveText(`Windows · ${n0}`);
    await expect(head(page, 1)).toHaveText(`Windows · ${n1}`);
  });

  // TC-STB-7
  test('칸을 하나로 줄이면 토프바가 다시 제목을 낸다', async ({ page }) => {
    await waitForInit(page);
    const w0 = await activeWindowOf(page);
    const n0 = await plainName(page, w0);
    await slotAdd(page);
    await openInSlot(page, 0, w0);
    await focusSlot(page, 0);
    await expect(topName(page)).toHaveText('', { timeout: 10000 });

    await slotRemove(page);
    await expect(topName(page)).toHaveText(`Windows · ${n0}`, { timeout: 10000 });
    await expect(page.locator('#area .slot-head')).toHaveCount(0);
  });

  // TC-STB-8
  test('빈 칸의 머리글은 창 없음이다', async ({ page }) => {
    await waitForInit(page);
    await slotAdd(page);
    await page.evaluate(() => (window as any).app.slotOpen(1, null));
    await expect(head(page, 1)).toHaveText('창 없음', { timeout: 10000 });
  });
});

test.describe('경계 — 슬롯 계층의 색과 굵기', () => {
  // TC-STB-9 — 54개 테마 전부에서 세 축의 거리를 확인한다 (FR-STB-23).
  test('모든 테마에서 slot-edge 가 border·accent·bg 와 구별된다', async ({ page }) => {
    await waitForInit(page);
    const bad = await page.evaluate(() => {
      // themes.js·helpers.js 는 classic script 다 — 최상위 `const` 는 window 의
      // 프로퍼티가 아니라 전역 렉시컬 스코프에 있으므로 이름으로 집는다.
      const T = THEMES;
      const mix = mixHex;
      const M = SLOT_EDGE_MIX;
      const rgb = (h: string) => ({
        r: parseInt(h.slice(1, 3), 16), g: parseInt(h.slice(3, 5), 16), b: parseInt(h.slice(5, 7), 16),
      });
      const d = (a: string, b: string) => {
        const x = rgb(a), y = rgb(b);
        return Math.sqrt((x.r - y.r) ** 2 + (x.g - y.g) ** 2 + (x.b - y.b) ** 2);
      };
      const out: string[] = [];
      for (const name of Object.keys(T)) {
        const u = T[name].ui;
        const edge = mix(u.border, u.accent, M);
        // 실측 최소값(SRS §3.2 FR-STB-23)보다 낮아지면 회귀다.
        if (d(edge, u.border) < 70) out.push(`${name}: border ${d(edge, u.border).toFixed(0)}`);
        if (d(edge, u.accent) < 55) out.push(`${name}: accent ${d(edge, u.accent).toFixed(0)}`);
        if (d(edge, u.bg) < 100) out.push(`${name}: bg ${d(edge, u.bg).toFixed(0)}`);
      }
      return out;
    });
    expect(bad, `구별되지 않는 테마: ${bad.join(', ')}`).toEqual([]);
  });

  // TC-STB-10
  test('슬롯 손잡이는 8px 이고 분할 손잡이와 다른 색이다', async ({ page }) => {
    await waitForInit(page);
    await slotAdd(page);
    const h = page.locator('#area .slot-handle').first();
    await expect(h).toHaveCount(1);

    const got = await h.evaluate((el) => {
      const cs = getComputedStyle(el);
      const root = getComputedStyle(document.documentElement);
      const px = (v: string) => v.trim();
      return {
        w: Math.round(el.getBoundingClientRect().width),
        bg: cs.backgroundColor,
        border: px(root.getPropertyValue('--border')),
        edge: px(root.getPropertyValue('--slot-edge')),
      };
    });
    expect(got.w).toBe(8);
    expect(got.edge).not.toBe('');
    expect(got.edge.toLowerCase()).not.toBe(got.border.toLowerCase());
  });

  // TC-STB-11 — 머리글의 기본색은 토프바 창 이름과 같고, 포커스만 accent 다.
  test('비포커스 머리글은 토프바와 같은 색, 포커스 머리글은 강조색이다', async ({ page }) => {
    await waitForInit(page);
    const w0 = await activeWindowOf(page);
    const w1 = await addWindow(page);
    await slotAdd(page);
    await openInSlot(page, 0, w0);
    await openInSlot(page, 1, w1);
    await focusSlot(page, 0);

    const colors = await page.evaluate(() => {
      const c = (sel: string) => {
        const el = document.querySelector(sel);
        return el ? getComputedStyle(el).color : '';
      };
      const root = getComputedStyle(document.documentElement);
      return {
        top: c('#window-name'),
        unfocused: c('#area .slot:not(.slot-focused) .slot-head'),
        focused: c('#area .slot.slot-focused .slot-head'),
        accent: root.getPropertyValue('--accent').trim(),
      };
    });
    expect(colors.unfocused).toBe(colors.top);
    expect(colors.focused).not.toBe(colors.unfocused);
  });

  // TC-STB-12 — 분할 손잡이는 손대지 않는다 (FR-STB-28).
  test('분할 손잡이는 종전대로다', async ({ page }) => {
    await waitForInit(page);
    await page.evaluate(() => (window as any).app.split('horizontal'));
    const sh = page.locator('#area .sp > .sh').first();
    await expect(sh).toHaveCount(1);
    const got = await sh.evaluate((el) => {
      const cs = getComputedStyle(el);
      const root = getComputedStyle(document.documentElement);
      return { w: Math.round(el.getBoundingClientRect().width), bg: cs.backgroundColor,
               border: root.getPropertyValue('--border').trim() };
    });
    expect(got.w).toBe(3);
    // 배경은 여전히 --border 다 — 슬롯만 색을 받는다.
    const asRgb = await page.evaluate((hex) => {
      const d = document.createElement('div');
      d.style.color = hex; document.body.appendChild(d);
      const v = getComputedStyle(d).color; d.remove(); return v;
    }, got.border);
    expect(got.bg).toBe(asRgb);
  });
});

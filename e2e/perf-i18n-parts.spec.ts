import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

import { Page } from '@playwright/test';

import { test, expect, waitForInit, openGit, clickGitView, gitFixture, cleanGitFixture } from './fixtures';
import { tmpPath, realPath } from './osenv';

// PERF 3.4.12.9 — 언어 카탈로그 조각 (D-46, perf/M3_BOOT_SCOPE.md §3·§6).
//
// 지연 묶음에서만 쓰는 키는 `js/i18n/<묶음>.<로케일>.js` 조각에 있고, `Screens.load` 가 묶음 JS 앞에 싣는다.
// 부팅은 조각을 받지 않는다. 설정·git·편집기를 처음 열었을 때 조각의 키가 `ns.key` 꼴 그대로 보이거나
// "없는 키" 경고를 내면 조각이 늦게 실렸거나 빠진 것이다. 언어를 바꾸면(새로고침) 그 언어의 조각을 받는다.

const FIXTURES = tmpPath('otter-git-fx-i18np-' + process.pid);
const EDROOT = tmpPath('otter-i18np-ed-' + process.pid);
test.beforeAll(() => {
  gitFixture(FIXTURES);
  mkdirSync(EDROOT, { recursive: true });
  writeFileSync(join(EDROOT, 'one.txt'), 'ONE-0\n');
});
test.afterAll(() => cleanGitFixture(FIXTURES));

const I18N_DIR = join(__dirname, '..', 'web', 'js', 'i18n');
const PART = /\/js\/i18n\/([a-z0-9_-]+)\.(ko|en)\.js(\?|$)/;
/** 조각에 든 키 전부 — 화면에 그대로 보이면 안 되는 문자열이다. */
const PART_KEYS = readdirSync(I18N_DIR).filter((n) => /^[a-z0-9_-]+\.ko\.js$/.test(n))
  .flatMap((n) => [...readFileSync(join(I18N_DIR, n), 'utf8').matchAll(/^\s*'([a-z0-9_.]+)'\s*:/gm)].map((m) => m[1]));

async function seedLocale(request: any, v: string | null) {
  const r = await request.get('/api/settings');
  const s = r.ok() ? await r.json() : {};
  if (v === null) delete s.locale;
  else s.locale = v;
  await request.put('/api/settings', { headers: { 'Content-Type': 'application/json' }, data: JSON.stringify(s) });
}

function watch(page: Page) {
  const seen = { parts: [] as string[], warned: [] as string[] };
  page.on('request', (r) => {
    const m = r.url().match(PART);
    if (m) seen.parts.push(m[1] + '.' + m[2]);
  });
  page.on('console', (m) => {
    if (m.type() === 'warning' && m.text().startsWith('[i18n]') && PART_KEYS.some((k) => m.text().includes(k))) seen.warned.push(m.text());
  });
  return seen;
}

/** 보이는 글·title·placeholder·aria-label 에 조각 키가 그대로 든 자리. */
const leaked = (page: Page) => page.evaluate((keys) => {
  const hay = [document.body.innerText];
  for (const el of document.querySelectorAll('[title],[placeholder],[aria-label]')) {
    for (const a of ['title', 'placeholder', 'aria-label']) { const v = el.getAttribute(a); if (v) hay.push(v) }
  }
  const all = hay.join('\n');
  return keys.filter((k) => all.includes(k));
}, PART_KEYS);

async function openSettingsEverywhere(page: Page) {
  await page.click('#settings-btn');
  await expect(page.locator('#modal-overlay')).toBeVisible();
  const tabs = await page.locator('button.mtab[data-tab]').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.tab));
  for (const tab of tabs) {
    await page.click(`button.mtab[data-tab="${tab}"]`);
    await expect(page.locator(`#panel-${tab}`)).toBeVisible();
    expect(await leaked(page), 'settings ▸ ' + tab).toEqual([]);
  }
  await page.click('#modal-close');
  await expect(page.locator('#modal-overlay')).toBeHidden();
}

async function openGitViews(page: Page) {
  await openGit(page, realPath(join(FIXTURES, 'basic')));
  await expect(page.locator('#area .ed-side .git-view.git-changes')).toBeVisible();
  expect(await leaked(page), 'git changes').toEqual([]);
  await clickGitView(page, 'history');
  expect(await leaked(page), 'git history').toEqual([]);
}

async function openEditor(page: Page) {
  const root = realPath(EDROOT);
  await page.evaluate(async (p) => {
    await fetch('/api/editors/add', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: p }) });
  }, root);
  await expect.poll(async () => page.evaluate(async (p) => {
    const app = (window as any).app;
    await app.testing.edReconcile?.();
    await app.testing.edOpenWindow(p);
    return app.testing.edSearchRoot();
  }, root), { timeout: 15000 }).not.toBe('');
  await page.evaluate((f) => (window as any).app.testing.edOpenFile(f), join(root, 'one.txt'));
  await expect(page.locator('#area .cm-editor').first()).toBeVisible({ timeout: 30000 });
  expect(await leaked(page), 'editor').toEqual([]);
}

/** 설정·git·편집기를 처음 열고, 그 언어의 조각을 한 번씩만 받았는지 본다. */
async function firstOpen(page: Page, seen: ReturnType<typeof watch>, loc: string) {
  expect(seen.parts, '부팅은 조각을 받지 않는다').toEqual([]);
  await openSettingsEverywhere(page);
  await openGitViews(page);
  await openEditor(page);
  for (const b of ['settings', 'git', 'cm', 'editor']) {
    expect(seen.parts.filter((p) => p === b + '.' + loc), b).toHaveLength(1);
  }
  expect(seen.parts.filter((p) => !p.endsWith('.' + loc)), '다른 언어의 조각').toEqual([]);
  expect(seen.warned).toEqual([]);
}

test.describe('PERF 3.4.12.9 언어 조각', () => {
  test.afterEach(async ({ request }) => { await seedLocale(request, null) });

  test('TC-I18P-1: ko — 부팅 조각 요청 0, 설정·git·편집기 첫 열기에 키 노출 0', async ({ page, request }) => {
    await seedLocale(request, null);
    const seen = watch(page);
    await waitForInit(page);
    await expect(page.locator('html')).toHaveAttribute('lang', 'ko');
    await firstOpen(page, seen, 'ko');
  });

  test('TC-I18P-2: en 으로 바꾼 뒤에도 — 부팅 조각 요청 0, 첫 열기에 키 노출 0', async ({ page, request }) => {
    await seedLocale(request, null);
    await waitForInit(page);
    await page.click('#settings-btn');
    await page.click('button.mtab[data-tab="display"]');
    const put = page.waitForResponse((r: any) => r.url().includes('/api/settings') && r.request().method() === 'PUT');
    const nav = page.waitForEvent('load');
    const seen = watch(page);
    await page.selectOption('#ds-locale', 'en');
    await put;
    await nav;
    await page.waitForSelector('#boot', { state: 'detached', timeout: 15000 });
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    // 바꾸기 전 페이지가 설정을 열며 받은 ko 조각은 세지 않는다 — 새 페이지의 요청만 본다.
    seen.parts.length = 0;
    seen.warned.length = 0;
    await page.reload();
    await page.waitForSelector('#boot', { state: 'detached', timeout: 15000 });
    await firstOpen(page, seen, 'en');
  });
});

import { readFileSync } from 'fs';
import { join } from 'path';

import { test, expect, waitForInit, waitSettled } from './fixtures';

// PERF 3.4.12.11 — 데스크톱 기본 부팅은 지연 묶음을 하나도 받지 않는다 (perf/M3_BOOT_SCOPE.md §1·§6, D-43~D-47).
//
// 지연 묶음 = `web/bundles.txt` 의 묶음 가운데 index.html 이 `<script src="b/…">` 로 싣지 않는 것. 언어 조각
// (`js/i18n/<묶음>.<로케일>.js`, D-46)도 그 묶음과 함께만 실린다. 묶음마다의 처음 쓸 때 동작은 perf-*-bundle 이 잰다.

const WEB = join(__dirname, '..', 'web');
const DEFS = readFileSync(join(WEB, 'bundles.txt'), 'utf8');
const HTML = readFileSync(join(WEB, 'index.html'), 'utf8');
const ALL = [...DEFS.matchAll(/^\[([^\]]+)\]$/gm)].map((m) => m[1]);
const PAGE = new Set([...HTML.matchAll(/<script\s+src="b\/([^/"?]+)\.js/g)].map((m) => m[1]));
const LAZY = ALL.filter((n) => !PAGE.has(n));

const BUNDLE = /\/b\/([^/?]+)\.js(\?|$)/;
const PART = /\/js\/i18n\/[^/?]+\.[^/?]+\.js(\?|$)/;

test('TC-BTL-1: 데스크톱 기본 부팅은 지연 묶음과 언어 조각을 받지 않는다', async ({ page }) => {
  expect(PAGE).toEqual(new Set(['pre', 'boot']));
  expect(LAZY.length).toBeGreaterThan(10);
  const bundles: string[] = [];
  const parts: string[] = [];
  page.on('request', (r) => {
    const b = r.url().match(BUNDLE);
    if (b) bundles.push(b[1]);
    if (PART.test(r.url())) parts.push(r.url());
  });
  await waitForInit(page);
  await waitSettled(page);
  expect(bundles.filter((n) => LAZY.includes(n))).toEqual([]);
  expect(parts).toEqual([]);
  expect(await page.evaluate((names) => names.filter((n) => Screens.ready(n)), LAZY)).toEqual([]);
});

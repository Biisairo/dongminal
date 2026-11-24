#!/usr/bin/env node
/**
 * 수달 SVG 에서 PNG 아이콘을 만든다 (OTTERMINAL_RENAME_SRS FR-AST-3).
 *
 *   앱 아이콘(PWA 192·512, Apple touch 180) ← web/assets/brand/otter-01.svg
 *   파비콘(16·32)                          ← web/assets/brand/otter-15.svg
 *
 * Apple touch 아이콘은 iOS 가 투명을 검게 칠하므로 판의 색으로 바탕을 채운다.
 *
 * 사용: node scripts/gen-brand-icons.mjs
 * 브라우저: PLAYWRIGHT_BROWSERS_PATH 의 chromium (e2e 와 같다).
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from '@playwright/test';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const BRAND = join(REPO, 'web/assets/brand');
const OUT = join(REPO, 'web/assets');
/** otter-01 판의 색. */
const PLATE = '#2e2b31';

const ICONS = [
  { src: 'otter-01.svg', out: 'icon-192.png', px: 192 },
  { src: 'otter-01.svg', out: 'icon-512.png', px: 512 },
  { src: 'otter-01.svg', out: 'apple-touch-icon.png', px: 180, bg: PLATE },
  { src: 'otter-15.svg', out: 'favicon-32.png', px: 32 },
  { src: 'otter-15.svg', out: 'favicon-16.png', px: 16 },
];

const browser = await chromium.launch();
const page = await browser.newPage({ deviceScaleFactor: 1 });
for (const { src, out, px, bg } of ICONS) {
  const svg = readFileSync(join(BRAND, src), 'utf8');
  await page.setViewportSize({ width: px, height: px });
  await page.setContent(
    `<html><body style="margin:0;background:${bg || 'transparent'}">` +
      `<div style="width:${px}px;height:${px}px;display:flex;align-items:center;justify-content:center">` +
      `<img style="max-width:100%;max-height:100%" src="data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}">` +
      '</div></body></html>',
  );
  await page.waitForFunction(() => document.images[0].complete);
  await page.screenshot({ path: join(OUT, out), omitBackground: !bg, clip: { x: 0, y: 0, width: px, height: px } });
  console.log(`✓ ${out} (${px}px ← ${src})`);
}
await browser.close();

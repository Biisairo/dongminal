import { Page } from '@playwright/test';
import { join } from 'path';

import { test, expect, waitForInit, openGit, gitFixture, cleanGitFixture } from './fixtures';
import { tmpPath, realPath } from './osenv';

/**
 * UI_KIT_SRS §4 — 아이콘 치수의 상시 검사 (V-1 / FR-UIK-3 · FR-GLY-5).
 *
 * 접수한 말은 **"모든 버튼안에는 아이콘이 꽉 차야한다"** 이고, 그 규칙은
 * "아이콘 변의 길이는 **버튼 높이에서** 파생한다" 다. 키트가 그 파생을
 * `--ui-btn-h` 로 하는데, 자기 하한을 따로 가진 표면이 있다 — git 표면의
 * `--git-hit`(30px)이 그렇다. 그 자리에 `.ui-btn-icon` 만 병기하면 26px 기준의
 * 아이콘이 30px 버튼에 앉아 **덜 찬다** (실측 0.59, 목표 0.68).
 *
 * 그 실수는 눈으로 보이지 않는다 — 아이콘은 멀쩡히 그려지고 조금 작을 뿐이다.
 * 그래서 자리마다 세는 대신 **화면에 있는 아이콘 버튼 전부**를 돌아 잰다:
 * 새 표면을 옮길 때 이 검사가 그 자리를 자동으로 포함한다.
 */

const FIXTURES = tmpPath('dm-git-fx-uikit-' + process.pid);
test.beforeAll(() => { gitFixture(FIXTURES) });
test.afterAll(() => { cleanGitFixture(FIXTURES) });
const fx = (name: string) => realPath(join(FIXTURES, name));

/** 보이는 아이콘 버튼 전부의 `아이콘 변 ÷ 버튼 높이`. */
async function offenders(page: Page) {
  return page.evaluate(() => {
    const want = parseFloat(getComputedStyle(document.documentElement)
      .getPropertyValue('--ui-icon-ratio'));
    const bad: { cls: string; h: number; icon: number; r: number }[] = [];
    for (const b of document.querySelectorAll('button.ui-btn-icon')) {
      const svg = b.querySelector('svg.ui-icon');
      if (!svg) continue;
      const rb = b.getBoundingClientRect(), rs = svg.getBoundingClientRect();
      // 보이지 않는 버튼은 재지 않는다 — 0 은 비율이 아니다.
      if (!(rb.height > 0 && rs.height > 0)) continue;
      const r = rs.height / rb.height;
      if (Math.abs(r - want) > 0.02) bad.push({
        cls: [...b.classList].filter(c => !c.startsWith('ui-')).join('.') || '(kit only)',
        h: Math.round(rb.height * 10) / 10,
        icon: Math.round(rs.height * 10) / 10,
        r: Math.round(r * 100) / 100,
      });
    }
    return bad;
  });
}

const report = (bad: any[]) =>
  `아이콘이 버튼을 덜 채운다 (목표 0.68 ±0.02): ${JSON.stringify(bad)}`;

test.describe('묶음 UIK — 아이콘이 버튼을 채운다 (V-1)', () => {
  test('UIK1: 기본 화면의 아이콘 버튼이 전부 비율을 지킨다', async ({ page }) => {
    await waitForInit(page);
    const bad = await offenders(page);
    expect(bad, report(bad)).toEqual([]);
  });

  // Agents 패널 머리의 둘(`refresh-cw`·`x`)이 이 화면에서만 선다.
  test('UIK2: Agents 패널을 열어도 지켜진다', async ({ page }) => {
    await waitForInit(page);
    await page.locator('#agents-toggle').click();
    await expect(page.locator('#agents-panel.open')).toBeVisible();
    const bad = await offenders(page);
    expect(bad, report(bad)).toEqual([]);
  });

  /**
   * git 표면이 이 검사가 생긴 이유다 — `--git-hit`(30px)이 키트의
   * `--ui-btn-h`(26px)와 달라, 병기만 하면 아이콘이 덜 찬다.
   */
  test('UIK3: git 표면(뷰 탭·행 동작·커밋)에서도 지켜진다', async ({ page }) => {
    await waitForInit(page);
    await openGit(page, fx('basic'));
    // 행 동작은 hover 에서만 보인다 (겹 규약) — 하나를 띄워 함께 잰다.
    const row = page.locator('#area .ed-side .git-file').first();
    if (await row.count()) await row.hover();
    const bad = await offenders(page);
    expect(bad, report(bad)).toEqual([]);
  });

  // 설정 모달은 닫기·프리셋·단축키 초기화가 아이콘 버튼이다.
  test('UIK4: 설정 모달에서도 지켜진다', async ({ page }) => {
    await waitForInit(page);
    await page.locator('#settings-btn').click();
    await expect(page.locator('#modal')).toBeVisible();
    for (const tab of ['theme', 'shortcuts', 'presets', 'polling']) {
      await page.locator(`.mtab[data-tab="${tab}"]`).click();
      const bad = await offenders(page);
      expect(bad, `${tab} 탭 — ` + report(bad)).toEqual([]);
    }
  });

  // FR-GLY-6 / FR-UIK-21: 아이콘만 있는 버튼은 이름을 가질 유일한 자리가 툴팁이다.
  test('UIK5 (FR-GLY-6): 아이콘만 있는 버튼은 전부 이름을 갖는다', async ({ page }) => {
    await waitForInit(page);
    await openGit(page, fx('basic'));
    const nameless = await page.evaluate(() =>
      [...document.querySelectorAll('button.ui-btn-icon')]
        .filter(b => {
          const r = b.getBoundingClientRect();
          if (!(r.height > 0)) return false;
          if ((b.textContent || '').trim()) return false;   // 글자가 있으면 그것이 이름이다
          return !b.getAttribute('title') && !b.getAttribute('aria-label');
        })
        .map(b => [...b.classList].filter(c => !c.startsWith('ui-')).join('.') || '(kit only)'));
    expect(nameless, '이름 없는 아이콘 버튼: ' + JSON.stringify(nameless)).toEqual([]);
  });
});


/**
 * 묶음 GAP — **아이콘과 글자 사이는 키트의 값이다** (FR-GAP-1·2·3).
 *
 * `TEST-7` 로 `ux-batch8` 에서 옮겨 왔다 — 아이콘의 생김새를 재는 이 파일과 같은
 * 주제다. 접수된 결함은 `display:inline` 이라 `gap` 이 아예 걸리지 않던 것이었다.
 */
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

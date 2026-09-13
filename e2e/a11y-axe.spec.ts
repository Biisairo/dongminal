import * as fs from 'fs';
import * as path from 'path';

import AxeBuilder from '@axe-core/playwright';
import { Page } from '@playwright/test';

import { test, expect, waitForInit, waitSettled } from './fixtures';

// ACCESSIBILITY_BASELINE_SRS §3.3 — TC-A11Y-1·2·3 (FR-A11Y-11~14 / M7 `G7-1`).
//
// **axe 초록이 AA 충족을 뜻하지 않는다** (FR-A11Y-15). 이 스펙이 재는 것은 규칙으로
// 단정할 수 있는 것뿐이고 나머지는 `a11y-*.spec.ts` 의 동작 단정이 맡는다.
//
// ## 손으로 적지 않는 것 (FR-A11Y-13·23 / D-A11Y-3)
//
// - 설정 모달의 탭은 `.mtab[data-tab]` 에서 파생한다 — 탭이 늘면 검사도 는다.
// - 제외(`exclude`)는 SRS §6 예외 등록부에서 **파생**한다: 아래 `EXEMPT_SELECTOR` 는
//   예외 번호 → 선택자의 사전일 뿐이고, 그 번호가 표에 **없으면 이 스펙이 빨개진다**
//   (등록부에서 지운 예외는 제외에서도 빠져야 한다). 반대로 표에 "전부" 로 등록된
//   벤더 표면에 선택자가 없어도 빨개진다 — 등록만 하고 연결하지 않은 예외다.

/** FR-A11Y-11: 규칙 태그 넷. 넓히거나 좁히는 것은 SRS 를 고치는 변경이다. */
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

const SRS = path.join(__dirname, '..', 'docs', 'internal', 'ACCESSIBILITY_BASELINE_SRS.md');

/** 예외 번호 → axe 가 뺄 선택자. 벤더 표면(§6 의 "전부")만 여기 온다. */
const EXEMPT_SELECTOR: Record<string, string> = {
  'E-1': '.xterm',
  'E-2': '.monaco-editor',
};

/** §6 예외 등록부의 행들 — `| E-n | 자리 | 무엇을 적용하지 않나 | …`. */
function exceptionRows(): { id: string; where: string; what: string }[] {
  const src = fs.readFileSync(SRS, 'utf8');
  const sec = src.split(/^## 6\. 예외 등록부/m)[1]?.split(/^## /m)[0] || '';
  return [...sec.matchAll(/^\|\s*(E-\d+)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|/gm)]
    .map((m) => ({ id: m[1], where: m[2], what: m[3] }));
}

/** FR-A11Y-23: 제외 목록은 표에서 나온다. */
function excludes(): string[] {
  const rows = exceptionRows();
  expect(rows.length, 'SRS §6 의 예외 표를 읽지 못했다').toBeGreaterThan(0);
  const vendor = rows.filter((r) => /^전부/.test(r.what));
  for (const r of vendor) {
    expect(EXEMPT_SELECTOR[r.id], `${r.id}(${r.where}) 가 §6 에 "전부" 로 등록됐는데 axe 제외 선택자가 없다`).toBeTruthy();
  }
  for (const id of Object.keys(EXEMPT_SELECTOR)) {
    expect(rows.some((r) => r.id === id), `${id} 를 제외하지만 §6 에 그 예외가 없다`).toBe(true);
  }
  return vendor.map((r) => EXEMPT_SELECTOR[r.id]);
}

/** 위반을 **읽을 수 있는 줄**로 — 규칙 · 노드 수 · 첫 대상. 빈 배열이 통과다. */
async function violations(page: Page) {
  let b = new AxeBuilder({ page }).withTags(TAGS);
  for (const sel of excludes()) b = b.exclude(sel);
  const r = await b.analyze();
  return r.violations.map((v) => {
    const first = v.nodes[0]?.target?.join(' ') || '';
    return `${v.id} (${v.impact}) ×${v.nodes.length}: ${v.help} — ${first}`;
  });
}

test.describe('접근성 — axe 스모크 (FR-A11Y-11~14)', () => {
  test('TC-A11Y-1: 첫 화면에 위반이 없다', async ({ page }) => {
    await waitForInit(page, { clearLocalStorage: true });
    await waitSettled(page);
    expect(await violations(page)).toEqual([]);
  });

  test('TC-A11Y-2: 설정 모달 — 탭 전부 (파생) 에 위반이 없다', async ({ page }) => {
    await waitForInit(page, { clearLocalStorage: true });
    await page.click('#settings-btn');
    await expect(page.locator('#modal-overlay')).toBeVisible();
    // FR-A11Y-13: 탭 목록은 DOM 에서 온다. 열 개 남짓이어야 한다 — 하나면 파생이 헛돈 것이다.
    const tabs = await page.locator('.modal-tabs .mtab[data-tab]').evaluateAll((els) =>
      els.map((e) => (e as HTMLElement).dataset.tab!));
    expect(tabs.length).toBeGreaterThan(5);
    const bad: string[] = [];
    for (const t of tabs) {
      await page.click(`.modal-tabs .mtab[data-tab="${t}"]`);
      await expect(page.locator(`#panel-${t}`)).toBeVisible();
      for (const v of await violations(page)) bad.push(`[${t}] ${v}`);
    }
    expect(bad).toEqual([]);
  });

  test('TC-A11Y-3: git 확인창에 위반이 없다', async ({ page }) => {
    await waitForInit(page, { clearLocalStorage: true });
    await page.evaluate(() => {
      (window as any).GitConfirm.open({
        action: 'discard', title: '변경을 폐기합니다', targets: ['a.txt'],
        hint: { note: '폐기 전에 아래를 실행하세요', command: 'git stash push -- a.txt' },
        run: async () => ({ ok: true }),
      });
    });
    await expect(page.locator('#git-confirm .gc-box')).toBeVisible({ timeout: 10000 });
    expect(await violations(page)).toEqual([]);
  });
});

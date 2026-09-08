import { Page } from '@playwright/test';

import { test, expect, waitForInit, openGit, gitFixture, cleanGitFixture, waitSettled } from './fixtures';
import { join } from 'path';
import { tmpPath, realPath } from './osenv';

/**
 * UI_KIT_SRS §3.4 — 크기조절 핸들의 실시간 표시 (FR-HSZ-1~11).
 *
 * 접수한 말: **"크기 조절하는 handle 에는 크기 조절 시 양쪽의 크기가 실시간으로
 * 표시되어야한다."** 여섯 핸들이 각자 `mousedown`→`mousemove`→`mouseup` 을 쓰고
 * 있었고, 여섯 중 어느 것도 끄는 동안 수치를 보이지 않았다 — 놓아 봐야 결과를
 * 알았다.
 *
 * 검증 V-6 ~ V-9.
 */

const FIXTURES = tmpPath('dm-git-fx-hud-' + process.pid);
test.beforeAll(() => { gitFixture(FIXTURES) });
test.afterAll(() => { cleanGitFixture(FIXTURES) });
const fx = (name: string) => realPath(join(FIXTURES, name));

const hud = (page: Page) => page.locator('#ui-size-hud');
const boxes = (page: Page) => page.locator('#ui-size-hud .ui-size-box');

/** 핸들을 잡고 `dx`·`dy` 만큼 끈 상태로 **놓지 않고** 멈춘다. */
async function grab(page: Page, sel: string, dx: number, dy: number) {
  const h = page.locator(sel).first();
  await expect(h).toBeVisible();
  const b = (await h.boundingBox())!;
  const cx = b.x + b.width / 2, cy = b.y + b.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + dx, cy + dy, { steps: 6 });
  await page.waitForTimeout(120);
}

/** 한 벌의 줄들. `[px, (C×R), %]` 이며 터미널이 아니면 가운데가 없다. */
async function lines(page: Page, i: number): Promise<string[]> {
  return boxes(page).nth(i).evaluate(el =>
    [...el.children].map(c => (c.textContent || '').trim()));
}

/**
 * FR-HSZ-10 / V-9: **여섯을 데이터로 둔다.** 새 핸들이 생기면 이 목록에 한 줄을
 * 더하는 것으로 끝난다 — 검사를 복사하지 않는다.
 *
 * `setup` 은 그 핸들이 화면에 서게 만드는 일이다. `terms` 는 그 핸들의 양쪽 중
 * 터미널인 쪽의 인덱스이며, 거기에만 `C×R` 줄이 붙어야 한다 (FR-HSZ-5).
 */
const HANDLES: {
  name: string; sel: string; dx: number; dy: number; terms: number[];
  setup: (page: Page) => Promise<void>;
}[] = [
  {
    name: '#sb-handle (사이드바 폭)', sel: '#sb-handle', dx: 60, dy: 0, terms: [1],
    setup: async () => {},
  },
  {
    name: '#agents-handle (Agents 폭)', sel: '#agents-handle', dx: -60, dy: 0, terms: [0],
    setup: async (page) => {
      await page.locator('#agents-toggle').click();
      await expect(page.locator('#agents-panel.open')).toBeVisible();
    },
  },
  {
    name: '.sh (분할 칸 비율)', sel: '#area .sh', dx: 60, dy: 0, terms: [0, 1],
    setup: async (page) => {
      await page.locator('#split-h').click();
      await expect(page.locator('#area .sh')).toHaveCount(1);
    },
  },
  {
    name: '.slot-handle (슬롯 비율)', sel: '#area .slot-handle', dx: 60, dy: 0, terms: [0, 1],
    setup: async (page) => {
      await page.locator('#slot-add').click();
      await expect(page.locator('#area .slot-handle')).toHaveCount(1);
      await waitSettled(page);
    },
  },
  {
    // FR-HSZ-4a: **세로 축의 자리.** 가로 핸들만 재면 `rows` 갈래가 검사를
    // 벗어난다 — 축이 값을 고르는 규약이므로 두 축을 다 봐야 한다.
    name: '.sh (분할 칸, 세로)', sel: '#area .sh', dx: 0, dy: 40, terms: [0, 1],
    setup: async (page) => {
      await page.locator('#split-v').click();
      await expect(page.locator('#area .sh')).toHaveCount(1);
    },
  },
  {
    name: '.ed-ex-handle (탐색기 폭)', sel: '#area .ed-ex-handle', dx: 60, dy: 0, terms: [],
    setup: async (page) => { await openGit(page, fx('basic')) },
  },
  {
    name: '.git-commit-resize (커밋 입력 높이)', sel: '#area .git-commit-resize', dx: 0, dy: 40, terms: [],
    setup: async (page) => { await openGit(page, fx('basic')) },
  },
];

test.describe('묶음 HSZ — 핸들의 크기 표시 (FR-HSZ-1~10)', () => {
  for (const h of HANDLES) {
    /**
     * V-6 (FR-HSZ-2·3·4·5): 끄는 동안 HUD **두 벌**이 보이고, 각 벌의 줄이
     * 규약과 맞다 — 터미널이면 셋(px·C×R·%), 아니면 둘(px·%).
     */
    test(`HSZ ${h.name}: 끄는 동안 양쪽 수치가 보인다`, async ({ page }) => {
      await waitForInit(page);
      await h.setup(page);
      await grab(page, h.sel, h.dx, h.dy);

      // FR-HSZ-2: 문서에 **하나뿐인** HUD 다.
      await expect(hud(page)).toHaveClass(/\bon\b/);
      await expect(hud(page)).toHaveCount(1);
      // FR-HSZ-3: 양쪽 각각에 하나씩, 두 벌이다.
      await expect(boxes(page)).toHaveCount(2);

      for (const i of [0, 1]) {
        const ls = await lines(page, i);
        const isTerm = h.terms.includes(i);
        // FR-HSZ-4: px → (터미널이면) C×R → % 를 **세로로** 쌓는다.
        expect(ls.length, `${h.name} 쪽 ${i} 의 줄 수: ${JSON.stringify(ls)}`)
          .toBe(isTerm ? 3 : 2);
        expect(ls[0]).toMatch(/^\d+px$/);
        /**
         * FR-HSZ-5: 격자 줄은 터미널일 때만 — 없는 값을 0 으로 적지 않는다.
         *
         * FR-HSZ-4a: **끄는 축의 값만** 나온다. 가로 핸들이면 `cols`, 세로면
         * `rows` 다 — `px`·`%` 가 축의 값인데 이 줄만 축 밖의 값을 함께 실으면
         * 변하지 않는 숫자가 변하는 숫자들 사이에 앉는다.
         */
        if (isTerm) expect(ls[1]).toMatch(h.dy !== 0 ? /^\d+ rows$/ : /^\d+ cols$/);
        expect(ls[ls.length - 1]).toMatch(/^\d+%$/);
      }

      /**
       * FR-HSZ-4b: 세 줄의 길이가 서로 다르므로 **핸들에 붙는 변**을 가지런히
       * 한다 — 왼쪽 상자는 오른쪽 정렬, 오른쪽 상자는 왼쪽 정렬. 세로 핸들의
       * 두 상자는 위/아래로 놓여 붙는 변이 상하이므로 가운데로 둔다.
       */
      const align = await boxes(page).evaluateAll(els =>
        els.map(e => getComputedStyle(e).textAlign));
      if (h.dy !== 0) expect(align).toEqual(['center', 'center']);
      else expect(align).toEqual(['right', 'left']);

      // FR-HSZ-8: 끌고 있는 손을 가로채지 않는다.
      const pe = await hud(page).evaluate(el => getComputedStyle(el).pointerEvents);
      expect(pe).toBe('none');

      await page.mouse.up();
      // FR-HSZ-2: 끝나면 숨는다.
      await expect(hud(page)).not.toHaveClass(/\bon\b/);
    });
  }

  /**
   * V-7 (FR-HSZ-6): 분할 칸의 `%` 는 **곧 저장되는 값**이다. 화면이 보인 수치와
   * 워크스페이스에 남는 수치가 어긋나면 그 숫자는 아무것도 말하지 않는다.
   */
  test('HSZ V-7: 분할 칸의 `%` 가 저장되는 비율과 같다', async ({ page }) => {
    await waitForInit(page);
    await page.locator('#split-h').click();
    await expect(page.locator('#area .sh')).toHaveCount(1);

    await grab(page, '#area .sh', 80, 0);
    const shown = (await lines(page, 0)).pop()!;
    await page.mouse.up();
    await waitSettled(page);

    const saved = await page.evaluate(() => {
      const app = (window as any).app;
      const w = app._aw();
      const find = (n: any): any => {
        if (!n) return null;
        if (n.type === 'split' && Array.isArray(n.sizes)) return n.sizes;
        for (const c of n.children || []) { const r = find(c); if (r) return r }
        return null;
      };
      return find(w.layout);
    });
    expect(saved, '분할 비율이 저장되지 않았다').toBeTruthy();
    const pct = Math.round(saved[0] / (saved[0] + saved[1]) * 100);
    expect(shown).toBe(pct + '%');
  });

  /**
   * V-8 (FR-HSZ-9): `C×R` 은 **예상값**이다. 끄는 동안 fit 을 돌리면 SIGWINCH 가
   * 이벤트 수만큼 나가고 TUI 가 매번 프레임 전체를 다시 그린다.
   */
  test('HSZ V-8: 끄는 동안 resize 요청이 나가지 않는다', async ({ page }) => {
    await waitForInit(page);
    await page.locator('#split-h').click();
    await expect(page.locator('#area .sh')).toHaveCount(1);

    let n = 0;
    page.on('request', r => { if (/\/resize/.test(r.url())) n++ });
    await grab(page, '#area .sh', 40, 0);
    await page.waitForTimeout(300);
    const during = n;
    await page.mouse.up();

    expect(during, '끄는 동안 fit 이 돌았다').toBe(0);
  });
});

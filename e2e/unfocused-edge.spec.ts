import { test, expect, waitForInit } from './fixtures';

/**
 * UNFOCUSED_EDGE_SRS 검증 (V-1 ~ V-5).
 *
 * 헤드리스 브라우저의 페이지는 포커스를 **가진 채** 뜬다 — 그래서 평상시 이
 * 표시는 없고(NFR-4), 잃은 상태는 `blur` 이벤트로 만든다. 앱이 보는 것도 그
 * 이벤트다 (`_initFocusSync`), 즉 재는 자리가 사는 자리와 같다.
 */

const setWindowFocus = (page: any, focused: boolean) =>
  page.evaluate((f: boolean) => {
    window.dispatchEvent(new Event(f ? 'focus' : 'blur'));
  }, focused);

const edgeOpacity = (page: any) =>
  page.evaluate(() => {
    const el = document.getElementById('focus-edge');
    return el ? Number(getComputedStyle(el).opacity) : -1;
  });

/**
 * 레인지를 그 레벨로 옮긴다 (0 이면 끔).
 *
 * `fill` 은 값을 넣고 `input` 만 낸다 — 사람이 손을 떼는 `change` 는 오지 않는다.
 * 저장은 그 `change` 에 걸려 있으므로 함께 보내고, **PUT 이 서버에 닿을 때까지**
 * 기다린다: 그러지 않으면 곧바로 이어지는 새로고침이 저장을 앞지른다.
 */
async function moveRange(page: any, level: number) {
  const sl = page.locator('#ds-focusedge');
  const saved = page.waitForResponse(
    (r: any) => r.url().includes('/api/settings') && r.request().method() === 'PUT',
  );
  await sl.fill(String(level));
  await sl.dispatchEvent('input');
  await sl.dispatchEvent('change');
  await saved;
}

// 설정을 열고 레벨을 맞춘 뒤 닫는다.
async function setLevel(page: any, level: number) {
  await page.click('#settings-btn');
  await page.click('#modal .mtab[data-tab="display"]');
  await moveRange(page, level);
  await page.click('#modal-close');
}

// 세기 슬라이더와 그 표시. 설정 ▸ Display 를 연 상태에서 쓴다.
const alphaVar = (page: any) =>
  page.evaluate(() =>
    Number(getComputedStyle(document.documentElement).getPropertyValue('--ufe-alpha').trim()),
  );

const midVar = (page: any) =>
  page.evaluate(() =>
    Number(getComputedStyle(document.documentElement).getPropertyValue('--ufe-alpha-mid').trim()),
  );

test.describe('Unfocused window edge', () => {
  test('V-1: 포커스를 잃으면 표시가 서고, 되찾으면 사라진다', async ({ page }) => {
    await waitForInit(page);

    // 포커스를 가진 동안에는 표시가 없다 (NFR-4).
    expect(await edgeOpacity(page)).toBe(0);
    await expect(page.locator('html')).not.toHaveClass(/win-unfocused/);

    await setWindowFocus(page, false);
    await expect(page.locator('html')).toHaveClass(/win-unfocused/);
    await expect.poll(() => edgeOpacity(page)).toBe(1);

    await setWindowFocus(page, true);
    await expect(page.locator('html')).not.toHaveClass(/win-unfocused/);
    await expect.poll(() => edgeOpacity(page)).toBe(0);
  });

  test('V-2·V-3: 조작을 가로채지 않고, 색은 아래 픽셀에서 파생한다', async ({ page }) => {
    await waitForInit(page);
    await setWindowFocus(page, false);
    await expect.poll(() => edgeOpacity(page)).toBe(1);

    const seen = await page.evaluate(() => {
      const el = document.getElementById('focus-edge')!;
      const cs = getComputedStyle(el);
      const hit = document.elementFromPoint(
        Math.round(window.innerWidth / 2),
        Math.round(window.innerHeight / 2),
      );
      return {
        pointer: cs.pointerEvents,
        blend: cs.mixBlendMode,
        bg: cs.backgroundImage,
        hitsOverlay: hit === el,
      };
    });
    expect(seen.pointer).toBe('none');
    expect(seen.hitsOverlay).toBe(false);
    expect(seen.blend).toBe('difference');
    // 네 변의 그라데이션이며, 어떤 정지점도 완전 불투명이 아니다 (FR-UFE-5).
    expect(seen.bg.match(/linear-gradient/g)?.length).toBe(4);
    const alphas = [...seen.bg.matchAll(/rgba?\([^)]*?,\s*([0-9.]+)\)/g)].map((m) => Number(m[1]));
    expect(alphas.length).toBeGreaterThan(0);
    expect(Math.max(...alphas)).toBeLessThan(1);

    await setWindowFocus(page, true);
  });

  test('V-4·V-5: 0 이면 끔이고, 고른 값은 새로고침을 넘긴다', async ({ page }) => {
    await waitForInit(page);
    // 저장된 적 없으면 기본 레벨이다 (FR-UFE-13).
    await page.click('#settings-btn');
    await page.click('#modal .mtab[data-tab="display"]');
    const def = await page.evaluate(() => UFE_LEVEL_DEFAULT);
    await expect(page.locator('#ds-focusedge')).toHaveValue(String(def));
    await expect(page.locator('#ds-focusedge-val')).toHaveText(String(def));
    await page.click('#modal-close');

    await setLevel(page, 0);
    await setWindowFocus(page, false);
    // 0 은 곧 끔이다 (FR-UFE-11).
    await expect.poll(() => edgeOpacity(page)).toBe(0);
    await expect(page.locator('html')).not.toHaveClass(/win-unfocused/);

    // 값은 서버에 남아 새로고침을 넘긴다 (FR-UFE-12).
    await page.reload();
    await waitForInit(page);
    await page.click('#settings-btn');
    await page.click('#modal .mtab[data-tab="display"]');
    await expect(page.locator('#ds-focusedge')).toHaveValue('0');
    await expect(page.locator('#ds-focusedge-val')).toHaveText('끔');
    await page.click('#modal-close');

    // 다시 올리면 그 자리에서 산다 — 새로고침을 요구하지 않는다.
    await setLevel(page, def);
    await setWindowFocus(page, false);
    await expect.poll(() => edgeOpacity(page)).toBe(1);
    await setWindowFocus(page, true);
  });

  test('V-6·V-7: 레벨에서 세기가 파생하고, 고르는 동안 보인다', async ({ page }) => {
    await waitForInit(page);
    await page.click('#settings-btn');
    await page.click('#modal .mtab[data-tab="display"]');

    const sl = page.locator('#ds-focusedge');
    await moveRange(page, 8);

    // FR-UFE-17: 알파도 중간 정지점도 레벨 하나에서 편다.
    const per = await page.evaluate(() => UFE_ALPHA_PER_LEVEL);
    const ratio = await page.evaluate(() => UFE_ALPHA_MID_RATIO);
    await expect.poll(() => alphaVar(page)).toBeCloseTo(8 * per, 4);
    expect(await midVar(page)).toBeCloseTo(8 * per * ratio, 4);
    await expect(page.locator('#ds-focusedge-val')).toHaveText('8');
    // FR-SCT-8: 채움 비율이 값과 함께 간다.
    expect(await page.evaluate(() =>
      document.getElementById('ds-focusedge')!.style.getPropertyValue('--fill'))).toBe('80%');
    // FR-UFE-18: 조절 중에는 포커스가 있어도 보인다.
    await expect.poll(() => edgeOpacity(page)).toBe(1);

    // 0 에서는 미리보기도 없다.
    await moveRange(page, 0);
    await expect.poll(() => edgeOpacity(page)).toBe(0);

    // 기본값으로 되돌린다 — 다음 스펙이 이 값을 전제하지 않도록.
    const def = await page.evaluate(() => UFE_LEVEL_DEFAULT);
    await moveRange(page, def);
    await page.click('#modal-close');
  });
});

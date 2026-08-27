import { join } from 'path';

import { Page } from '@playwright/test';

import { test, expect } from './fixtures';

// GIT_REVIEW4_SRS §3.2 — 바깥 계기의 다시 그리기 규약. 검증 V114 (FR-RPT-1~6).
//
// 이 저장소에 JS 단위 테스트 러너가 없으므로 web/js/ui/repaint.js 를 빈 페이지에
// 넣고 page.evaluate 로 계약만 시험한다 (git-lanes.spec.ts 와 같은 방식).

const REPAINT_JS = join(process.cwd(), 'web', 'js', 'ui', 'repaint.js');

async function loadRepaint(page: Page) {
  await page.setContent('<!doctype html><title>repaint</title><div id="box"></div>');
  await page.addScriptTag({ path: REPAINT_JS });
}

// 요소에 표식을 심고 다시 그린 뒤 남아 있는지 본다 — 요소가 새로 만들어졌는지를
// 그것으로 가른다. 값으로는 알 수 없다 (같은 값을 그리면 화면이 똑같다).
type Item = { id: string; v: string };

const reconcile = (page: Page, items: Item[]) =>
  page.evaluate((its: Item[]) => {
    const box = document.getElementById('box')!;
    reconcileList(box, its, {
      key: (i: Item) => i.id,
      sig: (i: Item) => i.v,
      build: (i: Item) => {
        const d = document.createElement('div');
        d.className = 'row';
        d.dataset.id = i.id;
        d.textContent = i.v;
        return d;
      },
    });
    return [...box.children].map(e => (e as HTMLElement).dataset.id!);
  }, items);

// 현재 자식마다 표식을 심는다. 반환은 심은 순서의 키 목록이다.
const mark = (page: Page) =>
  page.evaluate(() => {
    const box = document.getElementById('box')!;
    for (const e of [...box.children]) (e as any).__mark = 'kept';
    return [...box.children].map(e => (e as HTMLElement).dataset.id!);
  });

const marks = (page: Page) =>
  page.evaluate(() => {
    const box = document.getElementById('box')!;
    const out: Record<string, boolean> = {};
    for (const e of [...box.children]) out[(e as HTMLElement).dataset.id!] = (e as any).__mark === 'kept';
    return out;
  });

test.describe('FR-RPT — 다시 그리기 규약 (V114)', () => {
  test.beforeEach(async ({ page }) => {
    await loadRepaint(page);
  });

  // ── FR-RPT-1·2: 관측 동일성 ──

  test('R1 (FR-RPT-1): 첫 그리기는 언제나 그린다', async ({ page }) => {
    const n = await page.evaluate(() => {
      const box = document.getElementById('box')!;
      let calls = 0;
      paintIfChanged(box, 'a', () => { calls++ });
      return calls;
    });
    expect(n).toBe(1);
  });

  test('R2 (FR-RPT-1): 같은 근거면 draw 를 부르지 않는다', async ({ page }) => {
    const n = await page.evaluate(() => {
      const box = document.getElementById('box')!;
      let calls = 0;
      const draw = () => { calls++ };
      paintIfChanged(box, 'a', draw);
      paintIfChanged(box, 'a', draw);
      paintIfChanged(box, 'a', draw);
      return calls;
    });
    expect(n).toBe(1);
  });

  test('R3 (FR-RPT-2): 근거가 바뀌면 반드시 그린다 — 조용히 멈추지 않는다', async ({ page }) => {
    const n = await page.evaluate(() => {
      const box = document.getElementById('box')!;
      let calls = 0;
      const draw = () => { calls++ };
      paintIfChanged(box, 'a', draw);
      paintIfChanged(box, 'b', draw);
      paintIfChanged(box, 'a', draw);
      return calls;
    });
    expect(n).toBe(3);
  });

  test('R4 (FR-RPT-1): draw 가 던지면 근거를 남기지 않는다', async ({ page }) => {
    const n = await page.evaluate(() => {
      const box = document.getElementById('box')!;
      let calls = 0;
      const boom = () => { calls++; throw new Error('boom') };
      try { paintIfChanged(box, 'a', boom) } catch {}
      try { paintIfChanged(box, 'a', boom) } catch {}
      return calls;
    });
    expect(n).toBe(2);
  });

  test('R5: forgetPaint 는 다음 회차가 반드시 그리게 한다', async ({ page }) => {
    const n = await page.evaluate(() => {
      const box = document.getElementById('box')!;
      let calls = 0;
      const draw = () => { calls++ };
      paintIfChanged(box, 'a', draw);
      forgetPaint(box);
      paintIfChanged(box, 'a', draw);
      return calls;
    });
    expect(n).toBe(2);
  });

  // ── FR-RPT-3: 행 동일성 ──

  test('R6 (FR-RPT-3): 키·값이 같으면 같은 요소를 그대로 둔다', async ({ page }) => {
    await reconcile(page, [{ id: 'a', v: '1' }, { id: 'b', v: '1' }]);
    await mark(page);
    const order = await reconcile(page, [{ id: 'a', v: '1' }, { id: 'b', v: '1' }]);
    expect(order).toEqual(['a', 'b']);
    expect(await marks(page)).toEqual({ a: true, b: true });
  });

  test('R7 (FR-RPT-3): 값이 바뀐 항목만 다시 만든다', async ({ page }) => {
    await reconcile(page, [{ id: 'a', v: '1' }, { id: 'b', v: '1' }]);
    await mark(page);
    const order = await reconcile(page, [{ id: 'a', v: '1' }, { id: 'b', v: '2' }]);
    expect(order).toEqual(['a', 'b']);
    expect(await marks(page)).toEqual({ a: true, b: false });
    // 값이 실제로 화면에 반영됐다 (FR-RPT-2 — 갱신이 멈추지 않는다).
    expect(await page.locator('#box .row[data-id="b"]').textContent()).toBe('2');
  });

  test('R8 (FR-RPT-3): 순서가 바뀌면 요소를 옮긴다 — 다시 만들지 않는다', async ({ page }) => {
    await reconcile(page, [{ id: 'a', v: '1' }, { id: 'b', v: '1' }, { id: 'c', v: '1' }]);
    await mark(page);
    const order = await reconcile(page, [{ id: 'c', v: '1' }, { id: 'a', v: '1' }, { id: 'b', v: '1' }]);
    expect(order).toEqual(['c', 'a', 'b']);
    expect(await marks(page)).toEqual({ a: true, b: true, c: true });
  });

  test('R9 (FR-RPT-3): 새 항목은 제자리에 끼우고 이웃은 유지한다', async ({ page }) => {
    await reconcile(page, [{ id: 'a', v: '1' }, { id: 'c', v: '1' }]);
    await mark(page);
    const order = await reconcile(page, [
      { id: 'a', v: '1' }, { id: 'b', v: '1' }, { id: 'c', v: '1' },
    ]);
    expect(order).toEqual(['a', 'b', 'c']);
    expect(await marks(page)).toEqual({ a: true, b: false, c: true });
  });

  test('R10 (FR-RPT-3): 사라진 항목의 요소는 제거한다', async ({ page }) => {
    await reconcile(page, [{ id: 'a', v: '1' }, { id: 'b', v: '1' }, { id: 'c', v: '1' }]);
    await mark(page);
    const order = await reconcile(page, [{ id: 'b', v: '1' }]);
    expect(order).toEqual(['b']);
    expect(await marks(page)).toEqual({ b: true });
    expect(await page.locator('#box .row').count()).toBe(1);
  });

  test('R11: 규약을 지키지 않는 자식은 제거한다', async ({ page }) => {
    await page.evaluate(() => {
      const box = document.getElementById('box')!;
      const stray = document.createElement('div');
      stray.className = 'stray';
      box.appendChild(stray);
    });
    const order = await reconcile(page, [{ id: 'a', v: '1' }]);
    expect(order).toEqual(['a']);
    expect(await page.locator('#box .stray').count()).toBe(0);
  });

  test('R12: build 가 null 을 주면 그 항목을 건너뛴다', async ({ page }) => {
    const order = await page.evaluate(() => {
      const box = document.getElementById('box')!;
      reconcileList(box, ['a', 'b', 'c'], {
        key: (k: string) => k,
        sig: () => '1',
        build: (k: string) => {
          if (k === 'b') return null;
          const d = document.createElement('div');
          d.dataset.id = k;
          return d;
        },
      });
      return [...box.children].map(e => (e as HTMLElement).dataset.id!);
    });
    expect(order).toEqual(['a', 'c']);
  });

  test('R13: 요소를 옮기지 않아도 되면 DOM 을 건드리지 않는다', async ({ page }) => {
    // insertBefore 는 같은 자리라도 요소를 떼었다 붙인다 — 그것이 드래그를
    // 깨뜨리므로 자리가 같으면 부르지 않아야 한다. MutationObserver 로 확인한다.
    await reconcile(page, [{ id: 'a', v: '1' }, { id: 'b', v: '1' }]);
    const muts = await page.evaluate(async () => {
      const box = document.getElementById('box')!;
      let n = 0;
      const mo = new MutationObserver(recs => { for (const r of recs) n += r.addedNodes.length + r.removedNodes.length });
      mo.observe(box, { childList: true });
      reconcileList(box, [{ id: 'a', v: '1' }, { id: 'b', v: '1' }], {
        key: (i: any) => i.id, sig: (i: any) => i.v,
        build: () => document.createElement('div'),
      });
      await new Promise(r => setTimeout(r, 0));
      mo.disconnect();
      return n;
    });
    expect(muts).toBe(0);
  });
});

// 전역 선언 — repaint.js 는 <script> 로 로드되는 전역 스크립트다.
declare function paintIfChanged(el: Element, sig: string, draw: () => void): boolean;
declare function forgetPaint(el: Element): void;
declare function reconcileList(
  container: Element,
  items: any[],
  o: { key: (i: any) => string; sig: (i: any) => string; build: (i: any) => Element | null },
): number;

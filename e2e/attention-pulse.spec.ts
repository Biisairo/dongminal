import { Page } from '@playwright/test';

import { test, expect } from './fixtures';

// ATTENTION_PULSE_SRS — 주의 표식은 2초 주기로 숨쉰다.
//
// 여기서 재는 것은 **표식이 붙은 자리의 처신**이다. 무엇이 알람인지(=`.attn` 이
// 언제 붙는지)는 attention.spec.ts·activity.spec.ts 의 몫이고 이 스펙의 비목표다.
// 그래서 클래스는 이 파일이 직접 붙인다.
//
// 시각은 Web Animations 로 고정한다 — 2초 주기의 ease-in-out 을 벽시계로 재면
// 1초 간격의 두 표본이 같은 위상에 떨어질 수 있다(0.25 와 0.75 는 같은 값이다).

async function waitForInit(page: Page) {
  await page.context().addInitScript(() => {
    sessionStorage.setItem('displayMode', 'desktop');
  });
  await page.goto('/');
  await page.waitForSelector('#area .pn.focused .xterm-helper-textarea', { timeout: 15000 });
}

// §2.1 의 일곱 자리. 각 항목은 [이름, 표식을 붙일 selector, 읽을 속성, 겹(pseudo)].
//
// 분할 칸만 겹(`::after`)에 산다 — 링을 자식이 덮지 못하게 띄운 결과다(FR-ATP-8).
const TARGETS: Array<[string, string, string, string?]> = [
  ['분할 칸', '#area .pn', 'opacity', '::after'],
  ['탭', '#area .pn .pn-tab', 'boxShadow'],
  ['사이드바 창 항목', '#windows .sbl-item', 'boxShadow'],
  ['사이드바 항목의 점', '#windows .sbl-item .sbl-dot', 'backgroundColor'],
  ['에이전트 카드', '#agents-panel .ag-card', 'boxShadow'],
  ['상단바 배지', '#attn-badge', 'borderTopColor'],
  ['사이드바 탭 배지', '.sb-tab[data-panel="windows"] .sb-tab-badge', 'backgroundColor'],
];

// 알람이 없는 상태에서도 일곱 자리를 세운다 — 표식의 처신만 보기 때문이다.
async function markAll(page: Page) {
  await page.evaluate(() => {
    document.querySelector('#area .pn')!.classList.add('attn');
    document.querySelector('#area .pn .pn-tab')!.classList.add('attn');
    document.querySelector('#windows .sbl-item')!.classList.add('attn');
    // 에이전트 패널이 비어 있거나 닫혀 있을 수 있다. 닫힌 패널(display:none)
    // 안에서는 CSS 애니메이션이 아예 돌지 않으므로 열고 카드 하나를 세운다.
    const panel = document.getElementById('agents-panel')!;
    panel.classList.add('open');
    if (!panel.querySelector('.ag-card')) {
      const c = document.createElement('div');
      c.className = 'ag-card';
      c.textContent = 'probe';
      panel.appendChild(c);
    }
    panel.querySelector('.ag-card')!.classList.add('attn');
    // 배지 둘은 알람이 있을 때만 보인다 — 표식의 처신을 보려면 세워야 한다.
    const badge = document.getElementById('attn-badge') as HTMLElement;
    badge.style.display = '';
    const chip = document.querySelector('.sb-tab[data-panel="windows"] .sb-tab-badge') as HTMLElement;
    if (chip) { chip.hidden = false; chip.textContent = '1'; }
  });
}

// 애니메이션을 멈춰 세우고 원하는 위상의 계산값을 읽는다.
async function sampleAt(page: Page, sel: string, prop: string, t: number, pseudo?: string) {
  return page.evaluate(([s, p, ms, ps]) => {
    const el = document.querySelector(s as string)!;
    // 겹에 걸린 애니메이션은 subtree 로만 잡힌다.
    for (const a of el.getAnimations({ subtree: true })) { a.pause(); a.currentTime = ms as number; }
    return (getComputedStyle(el, (ps as string) || null) as any)[p as string] as string;
  }, [sel, prop, t, pseudo || ''] as const);
}

test.describe('주의 표식의 맥박', () => {
  // V-ATP-1
  test('일곱 자리 전부가 2초·무한·ease-in-out 으로 돈다', async ({ page }) => {
    await waitForInit(page);
    await markAll(page);

    for (const [name, sel, , pseudo] of TARGETS) {
      const got = await page.evaluate(([s, ps]) => {
        const cs = getComputedStyle(document.querySelector(s as string)!, (ps as string) || null);
        return {
          name: cs.animationName, dur: cs.animationDuration,
          ease: cs.animationTimingFunction, count: cs.animationIterationCount,
        };
      }, [sel, pseudo || ''] as const);
      expect(got.name, `${name}: 맥박이 없다`).toMatch(/^attn-pulse-/);
      expect(got.dur, `${name}: 주기`).toBe('2s');
      expect(got.ease, `${name}: 가감속`).toBe('ease-in-out');
      expect(got.count, `${name}: 반복`).toBe('infinite');
    }
  });

  // V-ATP-2 · V-ATP-5
  test('표식이 사라졌다 돌아오고, 그 사이 크기는 그대로다', async ({ page }) => {
    await waitForInit(page);
    await markAll(page);

    for (const [name, sel, prop, pseudo] of TARGETS) {
      const peak = await sampleAt(page, sel, prop, 0, pseudo);
      const trough = await sampleAt(page, sel, prop, 1000, pseudo);
      expect(trough, `${name}: 1초 뒤에도 표식이 그대로다`).not.toBe(peak);
      // 2초 뒤에는 처음 모습으로 돌아온다 (FR-ATP-1·7).
      expect(await sampleAt(page, sel, prop, 2000, pseudo), `${name}: 돌아오지 않는다`).toBe(peak);

      // FR-ATP-4: 색만 잃고 자리는 지킨다.
      const box = (t: number) => page.evaluate(([s, ms]) => {
        const el = document.querySelector(s as string)!;
        for (const a of el.getAnimations({ subtree: true })) { a.pause(); a.currentTime = ms as number; }
        const r = el.getBoundingClientRect();
        return [Math.round(r.width), Math.round(r.height)];
      }, [sel, t] as const);
      expect(await box(1000), `${name}: 표식이 사라진 순간 크기가 변했다`).toEqual(await box(0));
    }
  });

  // V-ATP-3: 글자는 어느 시점에도 읽을 수 있다 (D-2).
  test('맥박이 글자색을 건드리지 않는다', async ({ page }) => {
    await waitForInit(page);
    await markAll(page);
    for (const sel of ['#area .pn .pn-tab', '#attn-badge',
      '.sb-tab[data-panel="windows"] .sb-tab-badge']) {
      const at0 = await sampleAt(page, sel, 'color', 0);
      const at1 = await sampleAt(page, sel, 'color', 1000);
      expect(at1, `${sel}: 글자색이 흔들린다`).toBe(at0);
      // 사라지는 색이 아니다 — 투명이면 읽을 수 없다.
      expect(at1).not.toMatch(/rgba\(0, 0, 0, 0\)/);
    }
  });

  // ATTENTION_FIRING_SRS V-ATV-3: 활성이면서 알람인 탭. 알람이 활성 표시를
  // 빼앗으면 맥박의 반주기 동안 어느 탭이 열려 있는지 알 수 없게 된다.
  test('활성 탭의 알람은 활성 배경을 지우지 않는다 (V-ATV-3)', async ({ page }) => {
    await waitForInit(page);
    await markAll(page);
    await page.evaluate(() => document.querySelector('#area .pn .pn-tab')!.classList.add('active'));

    const sel = '#area .pn .pn-tab';
    // 밑줄은 숨쉰다.
    const peak = await sampleAt(page, sel, 'boxShadow', 0);
    const trough = await sampleAt(page, sel, 'boxShadow', 1000);
    expect(trough, '밑줄이 맥박하지 않는다').not.toBe(peak);
    // 배경은 어느 위상에서도 활성 색 그대로다.
    const bg0 = await sampleAt(page, sel, 'backgroundColor', 0);
    const bg1 = await sampleAt(page, sel, 'backgroundColor', 1000);
    expect(bg1, '활성 배경이 맥박에 실려 사라진다').toBe(bg0);
    expect(bg1).not.toMatch(/rgba\(0, 0, 0, 0\)/);
  });

  // V-ATP-6: 링이 면마다 다른 두께로 보이던 결함의 재발 방지 (FR-ATP-8).
  //
  // 원인은 링이 **두 곳**에서 나온 것이었다 — 2px 테두리와 안쪽 2px 그림자.
  // 안쪽 그림자는 요소의 배경 층에 그려져 자식(탭 줄·터미널)이 덮으므로, 덮이는
  // 정도가 면마다 달랐다(실측 위 2px·왼쪽 3px·아래 4px). 링의 출처가 하나이고
  // 그것이 자식 위에 떠 있는지를 본다.
  test('분할 칸의 링은 자식 위에 뜬 겹 하나에서만 나온다', async ({ page }) => {
    await waitForInit(page);
    await markAll(page);
    const got = await page.evaluate(() => {
      const pn = document.querySelector('#area .pn')!;
      const own = getComputedStyle(pn);
      const ring = getComputedStyle(pn, '::after');
      return {
        ownShadow: own.boxShadow, ownBorder: own.borderTopColor,
        ringShadow: ring.boxShadow, pos: ring.position,
        events: ring.pointerEvents, z: ring.zIndex,
      };
    });
    expect(got.ringShadow, '겹이 링을 그리지 않는다').toContain('inset');
    expect(got.pos).toBe('absolute');
    expect(got.events, '겹이 클릭을 먹는다').toBe('none');
    expect(Number(got.z)).toBeGreaterThan(30);
    // 두 번째 출처가 없어야 한다.
    expect(got.ownShadow, '요소 자신이 또 링을 그린다').not.toContain('inset');
  });

  // V-ATP-4
  test('알람이 걷히면 맥박도 없다', async ({ page }) => {
    await waitForInit(page);
    await markAll(page);
    const anim = ([sel, pseudo]: [string, string]) => page.evaluate(([s, ps]) =>
      getComputedStyle(document.querySelector(s as string)!, (ps as string) || null).animationName,
    [sel, pseudo] as const);

    for (const t of [['#area .pn', '::after'], ['#windows .sbl-item', '']] as Array<[string, string]>) {
      expect(await anim(t), `${t[0]}: 맥박이 없다`).toMatch(/^attn-pulse-/);
      await page.evaluate((s) => document.querySelector(s)!.classList.remove('attn'), t[0]);
      expect(await anim(t), `${t[0]}: 알람이 걷혔는데 맥박이 남았다`).toBe('none');
    }
  });
});

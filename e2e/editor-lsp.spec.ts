/**
 * EDITOR_LSP_SRS M1 (묶음 A) — V-LSP-3c.
 *
 * 이 기계에 `gopls` 가 있는지는 환경마다 다르다. 그래서 상태를 단정하지 않고
 * **서버의 관측과 화면이 일치하는지**를 잰다 — 그것이 FR-LSP-46 이 청한 것이고,
 * 어느 환경에서도 같은 답을 내는 유일한 검사다.
 */
import { test, expect, waitForInit } from './fixtures';

type Server = {
  id: string; langs: string[]; found: boolean;
  exe?: string; origin?: string; installer?: string;
  canInstall: boolean; installing?: boolean;
};

// 화면은 원시 값을 그대로 보이지 않는다 — 사용자에게 `path` 라고 쓸 이유가 없다.
//
// **검증이 자기 매핑을 갖는다.** 구현의 상수(`LSP_ORIGIN_LABEL`)를 읽으면 라벨이
// 잘못돼도 통과한다 — 검사가 검사를 멈춘다.
const ORIGIN_LABEL: Record<string, string> = {
  config: '설정에 적은 경로',
  path: 'PATH',
  managed: 'dongminal 이 받은 것',
};

async function fetchStatus(request: any): Promise<Server[]> {
  const r = await request.post('/api/lsp/status', {
    headers: { 'Content-Type': 'application/json' },
    data: '{}',
  });
  expect(r.ok(), `상태 조회 실패: ${r.status()}`).toBeTruthy();
  return (await r.json()).servers as Server[];
}

async function openCodePanel(page: any) {
  await page.click('#settings-btn');
  await expect(page.locator('#modal-overlay')).toBeVisible();
  await page.click('button.mtab[data-tab="code"]');
  await expect(page.locator('#panel-code')).toBeVisible();
}

test.describe('편집기 코드 탐색 — 언어 서버의 관측 (M1)', () => {
  // V-LSP-3c · FR-LSP-46: 설정에 언어별 행이 서고, 서버의 관측과 어긋나지 않는다.
  test('설정에 서술자마다 한 줄이 서고 서버의 관측과 일치한다', async ({ page, request }) => {
    const want = await fetchStatus(request);
    expect(want.length, '서술자가 하나도 없다').toBeGreaterThanOrEqual(3);

    await waitForInit(page);
    await openCodePanel(page);

    const rows = page.locator('#lsp-list .lsp-row');
    await expect(rows).toHaveCount(want.length, { timeout: 10000 });

    for (const s of want) {
      const row = page.locator(`#lsp-list .lsp-row[data-id="${s.id}"]`);
      await expect(row, `${s.id} 줄이 없다`).toHaveCount(1);
      // 있음/없음이 화면에 드러난다 — 그 사실이 곧 이 패널의 존재 이유다.
      await expect(row).toHaveAttribute('data-found', String(s.found));
      // 덮는 언어가 보인다. typescript-language-server 는 둘을 덮는다.
      for (const lang of s.langs) {
        await expect(row.locator('.lsp-name')).toContainText(lang);
      }
      if (s.found) {
        // FR-LSP-5: 어디서 찾았는지가 보인다 — 사용자가 "왜 저것이 쓰이는가" 를
        // 설명할 수 있어야 한다.
        const label = ORIGIN_LABEL[String(s.origin)];
        expect(label, `모르는 origin 이 왔다: ${s.origin}`).toBeTruthy();
        await expect(row.locator('.lsp-state')).toContainText(label);
        await expect(row.locator('.lsp-path')).toContainText(String(s.exe));
      }
    }
  });

  // FR-LSP-6·11: 못 찾은 서버에는 받는 길이 보이고, 받을 수 없으면 **무엇이 없어서**
  // 그런지가 이름으로 보인다. "설치 실패" 는 다음에 할 일을 알려주지 않는다.
  test('없는 서버에는 받는 길이 보이고, 받을 수 없으면 그 이유가 이름으로 보인다', async ({ page, request }) => {
    const want = await fetchStatus(request);
    const missing = want.filter((s) => !s.found);
    test.skip(missing.length === 0, '이 기계에는 세 서버가 다 있다 — 이 검사의 전제가 없다');

    await waitForInit(page);
    await openCodePanel(page);

    for (const s of missing) {
      const row = page.locator(`#lsp-list .lsp-row[data-id="${s.id}"]`);
      const btn = row.locator('.lsp-install');
      await expect(btn, `${s.id} 에 설치 버튼이 없다`).toHaveCount(1);
      if (s.canInstall) {
        await expect(btn).toBeEnabled();
      } else {
        // 받을 수 없으면 버튼이 눌리지 않고, 무엇이 없는지가 적혀 있다.
        await expect(btn).toBeDisabled();
        await expect(row.locator('.lsp-state')).toContainText(String(s.installer));
      }
    }
  });

  // FR-LSP-47: 상태는 캐시가 아니라 관측이다 — 패널을 다시 열면 다시 읽는다.
  test('패널을 다시 열면 다시 읽는다', async ({ page, request }) => {
    await waitForInit(page);
    await openCodePanel(page);
    await expect(page.locator('#lsp-list .lsp-row').first()).toBeVisible({ timeout: 10000 });

    let calls = 0;
    page.on('request', (r: any) => {
      if (r.url().includes('/api/lsp/status') && r.method() === 'POST') calls++;
    });

    // 다른 탭으로 갔다 돌아온다.
    await page.click('button.mtab[data-tab="display"]');
    await expect(page.locator('#panel-display')).toBeVisible();
    await page.click('button.mtab[data-tab="code"]');
    await expect(page.locator('#panel-code')).toBeVisible();

    await expect.poll(() => calls, { timeout: 10000 }).toBeGreaterThan(0);
  });
});

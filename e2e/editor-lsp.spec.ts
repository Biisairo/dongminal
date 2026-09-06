/**
 * EDITOR_LSP_SRS M1 (묶음 A) — V-LSP-3c · LSP_PLUGIN_SRS FR-EXT-5.
 *
 * 이 기계에 `gopls` 가 있는지는 환경마다 다르다. 그래서 상태를 단정하지 않고
 * **서버의 관측과 화면이 일치하는지**를 잰다 — 그것이 FR-LSP-46 이 청한 것이고,
 * 어느 환경에서도 같은 답을 내는 유일한 검사다.
 *
 * **줄의 단위는 팩이다** (FR-EXT-5). 조달이 팩 단위이므로 — 서버 다섯을 내는
 * 패키지를 서버마다 받으면 같은 것을 다섯 번 받는다 — 화면도 팩마다 한 줄이고
 * `data-id` 는 팩 id 다. 이 검사는 그 묶음을 **스스로 계산해서** 견준다: 구현의
 * 묶는 코드를 부르면 그 코드가 틀렸을 때 검사가 함께 틀린다.
 */
import { test, expect, waitForInit } from './fixtures';

type Server = {
  pack?: string; id: string; langs?: string[]; found: boolean;
  exe?: string; origin?: string; installer?: string; note?: string;
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

// 한 팩과 그 팩이 내는 서버들. 순서는 서버가 준 순서다 — 화면의 `head`(첫 서버)와
// 같은 것을 보기 위해서다.
type Pack = { id: string; servers: Server[] };

function byPack(servers: Server[]): Pack[] {
  const out: Pack[] = [];
  for (const s of servers) {
    const id = s.pack || s.id;
    const hit = out.find((p) => p.id === id);
    if (hit) hit.servers.push(s);
    else out.push({ id, servers: [s] });
  }
  return out;
}

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
  // V-LSP-3c · FR-LSP-46 · FR-EXT-5: 설정에 **팩마다** 한 줄이 서고, 그 줄이
  // 말하는 것이 서버의 관측과 어긋나지 않는다.
  test('설정에 팩마다 한 줄이 서고 서버의 관측과 일치한다', async ({ page, request }) => {
    const servers = await fetchStatus(request);
    expect(servers.length, '서술자가 하나도 없다').toBeGreaterThanOrEqual(3);
    const packs = byPack(servers);

    await waitForInit(page);
    await openCodePanel(page);

    const rows = page.locator('#lsp-list .lsp-row');
    await expect(rows).toHaveCount(packs.length, { timeout: 10000 });

    for (const pack of packs) {
      const row = page.locator(`#lsp-list .lsp-row[data-id="${pack.id}"]`);
      await expect(row, `${pack.id} 줄이 없다`).toHaveCount(1);
      const found = pack.servers.filter((x) => x.found);
      const all = found.length === pack.servers.length && found.length > 0;
      // 있음/없음이 화면에 드러난다 — 그 사실이 곧 이 패널의 존재 이유다.
      // 팩의 것이므로 **전부 섰을 때만** 있음이다.
      await expect(row).toHaveAttribute('data-found', String(all));
      // 덮는 언어가 보인다. 팩 하나가 여럿을 덮으면 그 전부다
      // (vscode-langservers 는 html·css·json·markdown 을 낸다).
      for (const s of pack.servers) {
        for (const lang of s.langs || []) {
          await expect(row.locator('.lsp-name')).toContainText(lang);
        }
      }
      if (all) {
        // FR-LSP-5 · FR-EXT-28: 어디서 찾았는지가 보인다 — 사용자가 "왜 저것이
        // 쓰이는가" 를 설명할 수 있어야 한다.
        const label = ORIGIN_LABEL[String(found[0].origin)];
        expect(label, `모르는 origin 이 왔다: ${found[0].origin}`).toBeTruthy();
        await expect(row.locator('.lsp-state')).toContainText(label);
        await expect(row.locator('.lsp-path')).toContainText(String(found[0].exe));
      } else if (found.length) {
        // 일부만 선 팩은 전부 없는 것과 **다른 말**이어야 한다.
        await expect(row.locator('.lsp-state'))
          .toContainText(`(${found.length}/${pack.servers.length})`);
      }
    }
  });

  // FR-LSP-6·11 · FR-EXT-29: 못 받은 팩에는 받는 길이 보이고, 받을 수 없으면
  // **무엇이 없어서** 그런지가 이름으로 보인다. "설치 실패" 는 다음에 할 일을
  // 알려주지 않는다.
  //
  // 대상이 팩인 것이 FR-EXT-31 이다 — 버튼 하나가 그 팩의 서버 전부를 받는다.
  test('못 받은 팩에는 받는 길이 보이고, 받을 수 없으면 그 이유가 이름으로 보인다', async ({ page, request }) => {
    const packs = byPack(await fetchStatus(request));
    const missing = packs.filter((p) => p.servers.some((s) => !s.found));
    test.skip(missing.length === 0, '이 기계에는 모든 팩이 서 있다 — 이 검사의 전제가 없다');

    await waitForInit(page);
    await openCodePanel(page);

    for (const pack of missing) {
      const row = page.locator(`#lsp-list .lsp-row[data-id="${pack.id}"]`);
      const btn = row.locator('.lsp-install');
      await expect(btn, `${pack.id} 에 설치 버튼이 없다`).toHaveCount(1);
      // 판정의 주인은 팩의 첫 서버다 — 조달이 팩 하나에 한 번이므로 그 자리에
      // 매니페스트의 답이 실린다.
      if (pack.servers[0].canInstall) {
        await expect(btn).toBeEnabled();
      } else {
        // 받을 수 없으면 버튼이 눌리지 않고, 무엇이 없는지가 적혀 있다.
        await expect(btn).toBeDisabled();
        await expect(row.locator('.lsp-state')).toContainText(String(pack.servers[0].note));
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

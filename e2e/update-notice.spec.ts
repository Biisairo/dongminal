import { test, expect, waitForInit, JSON_HDR } from './fixtures';

/**
 * 새 판 배지 (UPDATE_NOTICE_SRS 묶음 안내).
 *
 * **서버의 확인은 여기서 돌지 않는다.** 검사 환경은 `DONGMINAL_NO_UPDATE_CHECK=1`
 * 로 막혀 있고(fixtures.ts, TC-UPD-14), 그래서 이 스펙은 `/api/update` 를
 * 가로채 캐시가 무엇이든 될 수 있게 만든 뒤 **화면이 그것을 어떻게 읽는지**만
 * 잰다. 진짜 GitHub 으로 나가는 요청은 이 파일 전체에서 0건이다.
 */

type Snap = {
  enabled: boolean; current: string; latest?: string;
  newer: boolean; link?: string; checkedAt?: string; failed: boolean;
};

const NEWER: Snap = {
  enabled: true, current: 'v1.0.0', latest: 'v9.9.9', newer: true,
  link: 'https://example.invalid/rel/v9.9.9', checkedAt: '2026-09-16T00:00:00Z', failed: false,
};
const LATEST: Snap = { enabled: true, current: 'v9.9.9', latest: 'v9.9.9', newer: false, failed: false };

/** `/api/update` 를 고정 응답으로 바꾼다. PUT 은 `enabled` 만 갈아 돌려준다. */
async function stubUpdate(page: any, snap: Snap) {
  let cur = { ...snap };
  await page.route('**/api/update', async (route: any) => {
    if (route.request().method() === 'PUT') {
      const body = JSON.parse(route.request().postData() || '{}');
      cur = { ...cur, enabled: !!body.enabled };
    }
    await route.fulfill({ status: 200, headers: JSON_HDR, body: JSON.stringify(cur) });
  });
}

test.describe('Update notice', () => {
  // FR-UPD-9: 새 판이 있을 때만 보인다.
  test('badge shows the new version and links to the release', async ({ page }) => {
    await stubUpdate(page, NEWER);
    await waitForInit(page);

    const badge = page.locator('#update-badge');
    await expect(badge).toBeVisible();
    await expect(badge).toContainText('v9.9.9');
    await expect(badge).toHaveAttribute('href', NEWER.link!);
    // 새 창으로 연다 — 작업 중인 터미널을 릴리스 페이지가 덮으면 안 된다.
    await expect(badge).toHaveAttribute('target', '_blank');
  });

  // FR-UPD-9: 최신이면 **아무것도 보이지 않는다.**
  test('badge stays hidden when up to date', async ({ page }) => {
    await stubUpdate(page, LATEST);
    await waitForInit(page);
    await expect(page.locator('#update-badge')).toBeHidden();
  });

  // FR-UPD-9b: 견줄 기준이 없는 개발 빌드를 "뒤졌다" 로 말하면 거짓이다.
  test('badge stays hidden for a dev build', async ({ page }) => {
    await stubUpdate(page, { enabled: true, current: 'dev', latest: 'v9.9.9', newer: false, failed: false });
    await waitForInit(page);
    await expect(page.locator('#update-badge')).toBeHidden();
  });

  // FR-UPD-9: 확인에 실패했으면 오류를 띄우지 않고 그냥 보이지 않는다.
  test('badge stays hidden when the check failed', async ({ page }) => {
    await stubUpdate(page, { enabled: true, current: 'v1.0.0', newer: false, failed: true });
    await waitForInit(page);
    await expect(page.locator('#update-badge')).toBeHidden();
  });

  // FR-UPD-15: 토글은 설정 페이지에 있고, 그 값은 `/api/update` 로 간다.
  test('settings toggle turns the check off and hides the badge', async ({ page }) => {
    await stubUpdate(page, NEWER);
    await waitForInit(page);
    await expect(page.locator('#update-badge')).toBeVisible();

    const puts: any[] = [];
    page.on('request', (r: any) => {
      if (r.method() === 'PUT' && r.url().includes('/api/update')) puts.push(JSON.parse(r.postData() || '{}'));
    });

    await page.click('#settings-btn');
    await page.click('button.mtab[data-tab="notify"]');
    const cb = page.locator('#ds-update-check');
    await expect(cb).toBeVisible();
    await expect(cb).toBeChecked();

    await cb.uncheck();
    await expect(page.locator('#update-badge')).toBeHidden();
    expect(puts).toEqual([{ enabled: false }]);

    // **설정 블롭으로 새지 않는다** (D-UPD-2). 이 토글은 서버 설정이다.
    await expect(cb).not.toBeChecked();
    await page.click('#modal-close');
  });

  // 판 확인이 없는 서버(503)에서는 행 자체가 없다 — 누를 수 없는 것을 보여
  // 주는 것은 고장으로 읽힌다.
  test('settings row is hidden when the server has no update check', async ({ page }) => {
    await page.route('**/api/update', (route: any) =>
      route.fulfill({ status: 503, headers: JSON_HDR, body: JSON.stringify({ error: 'update check unavailable' }) }));
    await waitForInit(page);

    await expect(page.locator('#update-badge')).toBeHidden();
    await page.click('#settings-btn');
    await page.click('button.mtab[data-tab="notify"]');
    await expect(page.locator('#ds-update-check')).toBeHidden();
    await page.click('#modal-close');
  });

  // D-UPD-4 / FR-UPD-9a: **폴링이 없다.** 하루에 한 번 바뀌는 값에 주기를 붙이면
  // 3초마다 묻게 되고 그건 28,800배의 낭비다.
  test('the badge does not poll', async ({ page }) => {
    await stubUpdate(page, NEWER);
    await waitForInit(page);
    await expect(page.locator('#update-badge')).toBeVisible();

    let gets = 0;
    page.on('request', (r: any) => {
      if (r.method() === 'GET' && r.url().includes('/api/update')) gets++;
    });
    // **예외 (`TEST-16`)**: 요청이 **일어나지 않음**을 잰다. 일어나지 않는 일에는
    // 기다릴 사건이 없으므로 시간을 흘려 보는 것 말고는 재는 방법이 없다.
    // 8초는 `_pollStats` 의 3초 주기를 두 번 넘긴다 — 폴링이 붙었다면 그 안에 걸린다.
    await page.waitForTimeout(8000);
    expect(gets).toBe(0);
  });
});

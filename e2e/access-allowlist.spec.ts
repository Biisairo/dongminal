import { test, expect, waitForInit } from './fixtures';

// ACCESS_ALLOWLIST_SRS §4 — Settings ▸ Access 패널.
//
// 이 화면은 잘못 쓰면 자기 자신을 잠근다. 그래서 확인하는 것은 CRUD 가 도는지가
// 아니라, **위험이 사용자에게 보이는지**다: 지금 내 주소가 보이는가(FR-ACL-23),
// 자기를 자르는 저장에 확인이 붙는가(FR-ACL-24).

async function openAccessTab(page) {
  await page.click('#settings-btn');
  await expect(page.locator('#modal-overlay')).toBeVisible();
  await page.click('button.mtab[data-tab="access"]');
  await expect(page.locator('#panel-access')).toBeVisible();
  // 패널이 보이는 것과 서버에서 값을 받은 것은 다르다. "지금 내 주소" 가 채워져야
  // 자기 차단 판정이 설 수 있다 — 그 전에 저장하면 판정이 보류된다.
  await expect(page.locator('#acl-you')).not.toHaveText('');
  await expect(page.locator('#acl-you')).not.toHaveText('(알 수 없음)');
}

test.describe('접속 허용 목록', () => {
  test.beforeEach(async ({ page }) => {
    await waitForInit(page);
    // 목록은 서버에 남는다 — 앞 테스트가 남긴 항목 위에서 판정하면 무엇을
    // 검증했는지 알 수 없다. 매번 빈 목록에서 시작한다.
    // FR-ACL-36: `PUT` 은 전체 교체다 — `hosts` 를 함께 보내지 않으면 별명 목록이
    // 지워진다. 이 테스트들은 축①을 보므로 둘 다 비워 시작한다.
    await page.evaluate(() => fetch('/api/access', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: false, entries: [], hosts: [] }),
    }));
  });

  // FR-ACL-23: 무엇을 목록에 넣어야 하는지 알 방법이 이것뿐이다.
  test('지금 접속 중인 출발지를 보여준다', async ({ page }) => {
    await openAccessTab(page);
    const you = page.locator('#acl-you');
    await expect(you).not.toHaveText('');
    await expect(you).not.toHaveText('(알 수 없음)');
  });

  // FR-ACL-22: 추가 → 저장 → 다시 열기에서 값이 살아 있어야 한다. 저장이
  // 파일까지 갔는지를 UI 만으로 확인하는 유일한 경로다.
  test('항목을 더하고 저장하면 다시 열어도 남는다', async ({ page }) => {
    await openAccessTab(page);
    await page.click('#acl-add');
    const row = page.locator('#acl-list .acl-row').last();
    await row.locator('.acl-value').fill('192.168.77.0/24');
    await row.locator('.acl-label').fill('e2e');
    await page.click('#acl-save');
    await expect(page.locator('#acl-status')).toHaveText('저장했습니다');

    // 탭을 떠났다 돌아오면 서버에서 다시 읽는다.
    await page.click('button.mtab[data-tab="theme"]');
    await page.click('button.mtab[data-tab="access"]');
    await expect(page.locator('#acl-list .acl-value').last()).toHaveValue('192.168.77.0/24');
  });

  // FR-ACL-18: 거절 사유가 그대로 보여야 고칠 수 있다.
  test('유효하지 않은 값은 사유와 함께 거절된다', async ({ page }) => {
    await openAccessTab(page);
    await page.click('#acl-add');
    await page.locator('#acl-list .acl-row').last().locator('.acl-value').fill('10.0.0.300');
    await page.click('#acl-save');
    const status = page.locator('#acl-status');
    await expect(status).toHaveClass(/err/);
    await expect(status).toContainText('10.0.0.300');
  });

  // FR-ACL-24: 자기를 자르는 저장에는 한 걸음 확인이 붙는다. 확인 없이 저장되면
  // 원격 사용자가 스스로를 끊는다.
  test('자기 주소를 허용하지 않는 목록은 확인을 받는다', async ({ page }) => {
    await openAccessTab(page);
    // 목록에는 자기와 무관한 대역 하나만 두고 적용을 켠다.
    await page.click('#acl-add');
    await page.locator('#acl-list .acl-row').last().locator('.acl-value').fill('203.0.113.0/24');
    await page.locator('#acl-enabled').check();
    await page.click('#acl-save');

    const dialog = page.locator('.ui-modal');
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('차단');
    // 취소하면 저장되지 않는다 — 상태 문구가 저장을 말하지 않아야 한다.
    await dialog.getByRole('button', { name: '취소' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.locator('#acl-status')).not.toHaveText('저장했습니다');
  });

  // FR-ACL-37: 축② — "이 컴퓨터의 별명". 자리가 "지금 내 주소" 와 "허용 목록"
  // 사이여야 두 축이 나란히 읽힌다. 저장이 파일까지 갔는지는 재진입으로만 확인된다.
  test('별명을 더하고 저장하면 다시 열어도 남는다', async ({ page }) => {
    await openAccessTab(page);
    // 자리: 별명 칸은 "지금 내 주소" 뒤, "허용 목록" 앞이다.
    const order = await page.evaluate(() => {
      const ids = ['acl-you', 'acl-host-list', 'acl-list'];
      return ids.map((id) => {
        const el = document.getElementById(id);
        return el ? Array.prototype.indexOf.call(document.querySelectorAll('#panel-access *'), el) : -1;
      });
    });
    expect(order[0]).toBeLessThan(order[1]);
    expect(order[1]).toBeLessThan(order[2]);

    // 서버가 자기를 무엇으로 아는지가 보여야 무엇을 넣을지 알 수 있다 (FR-ACL-35).
    await expect(page.locator('#acl-hostname')).not.toHaveText('(알 수 없음)');

    await page.click('#acl-host-add');
    const row = page.locator('#acl-host-list .acl-row').last();
    await row.locator('.acl-value').fill('macmini-office');
    await row.locator('.acl-label').fill('e2e tailnet');
    await page.click('#acl-save');
    await expect(page.locator('#acl-status')).toHaveText('저장했습니다');

    await page.click('button.mtab[data-tab="theme"]');
    await page.click('button.mtab[data-tab="access"]');
    await expect(page.locator('#acl-host-list .acl-value').last()).toHaveValue('macmini-office');
  });

  // FR-ACL-29: 와일드카드는 보안 경계를 넓히므로 받지 않는다. 거절 사유가 그대로
  // 보여야 사용자가 고칠 수 있다 (`_aclSave` 규약).
  test('별명에 와일드카드는 사유와 함께 거절된다', async ({ page }) => {
    await openAccessTab(page);
    await page.click('#acl-host-add');
    await page.locator('#acl-host-list .acl-row').last().locator('.acl-value').fill('*.ts.net');
    await page.click('#acl-save');
    const status = page.locator('#acl-status');
    await expect(status).toHaveClass(/err/);
    await expect(status).toContainText('*.ts.net');
  });

  // FR-ACL-7: 토글이 꺼져 있으면 자기를 자르는 목록이라도 확인이 붙지 않는다 —
  // 적용되지 않는 목록은 아무도 끊지 않는다.
  test('적용이 꺼져 있으면 확인 없이 저장된다', async ({ page }) => {
    await openAccessTab(page);
    await page.click('#acl-add');
    await page.locator('#acl-list .acl-row').last().locator('.acl-value').fill('203.0.113.0/24');
    await page.locator('#acl-enabled').uncheck();
    await page.click('#acl-save');
    await expect(page.locator('#acl-status')).toHaveText('저장했습니다');
    await expect(page.locator('.ui-modal')).toHaveCount(0);
  });
});

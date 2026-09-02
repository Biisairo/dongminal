import { readFileSync } from 'fs';

import { test, expect } from './fixtures';

// SETTINGS_PORTABILITY_SRS §7 — 설정 내보내기·가져오기.
//
// 설정은 세 저장소에 흩어져 있다 (§2.1). 이 스펙이 지키는 것은 "한 파일로
// 전부 나가고, 그 파일로 전부 돌아온다" 이다.

async function waitForInit(page) {
  await page.context().addInitScript(() => {
    sessionStorage.setItem('displayMode', 'desktop');
  });
  await page.goto('/');
  await page.waitForSelector('#area .pn.focused .xterm-helper-textarea', { timeout: 15000 });
}

async function openBackupTab(page) {
  await page.click('#settings-btn');
  await expect(page.locator('#modal-overlay')).toBeVisible();
  await page.click('button.mtab[data-tab="backup"]');
  await expect(page.locator('#panel-backup')).toBeVisible();
}

async function exportEnvelope(page): Promise<any> {
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.click('#bk-export'),
  ]);
  const path = await download.path();
  return { envelope: JSON.parse(readFileSync(path!, 'utf8')), name: download.suggestedFilename() };
}

// 가져오기는 파일 선택 → 확인 → 교체 → 새로고침이다 (FR-SPT-10·11·13).
async function importFile(page, obj: any) {
  await page.setInputFiles('#bk-file', {
    name: 'settings.json',
    mimeType: 'application/json',
    buffer: Buffer.from(typeof obj === 'string' ? obj : JSON.stringify(obj)),
  });
}

// 파일을 고른 뒤 확인 영역이 서기를 기다렸다가 교체를 누른다. 실제 사용자도
// 그렇게 한다 — 파일 읽기는 비동기라 고르자마자 누를 수 있는 버튼이 아니다.
//
// 교체 뒤에는 페이지가 다시 열린다 (FR-SPT-13). 그것을 실제로 확인하려고 창에
// 표식을 심는다 — 다시 열리면 `window` 가 새로 서므로 표식이 없다. URL 은
// 그대로라 주소만으로는 다시 열렸는지 알 수 없다.
async function importAndApply(page, obj: any) {
  await page.evaluate(() => { (window as any).__bkMark = 1 });
  await importFile(page, obj);
  await expect(page.locator('#bk-confirm')).toBeVisible();
  await Promise.all([
    page.waitForEvent('load'),
    page.click('#bk-apply'),
  ]);
  await page.waitForSelector('#area .pn.focused .xterm-helper-textarea', { timeout: 15000 });
  expect(await page.evaluate(() => (window as any).__bkMark)).toBeUndefined();
}

test.describe('Settings export/import', () => {
  // FR-SPT-14: Settings 모달의 7번째 탭.
  test('backup tab exists with both actions', async ({ page }) => {
    await waitForInit(page);
    await openBackupTab(page);
    await expect(page.locator('#bk-export')).toBeVisible();
    await expect(page.locator('#bk-import')).toBeVisible();
    await page.click('#modal-close');
  });

  // V-1·V-2: 봉투가 세 계층을 담고, 블롭은 통째로 실린다 (FR-SPT-2·5).
  test('export writes an envelope carrying the whole server blob', async ({ page, request }) => {
    await waitForInit(page);
    await openBackupTab(page);

    const { envelope, name } = await exportEnvelope(page);
    expect(envelope.kind).toBe('dongminal-settings');
    expect(envelope.version).toBe(1);
    expect(typeof envelope.exportedAt).toBe('string');
    expect(envelope.server).toBeTruthy();
    expect(envelope.local).toBeTruthy();
    expect(envelope.session).toBeTruthy();

    // FR-SPT-6: 이름에 시각이 박힌다.
    expect(name).toMatch(/^dongminal-settings-\d{8}-\d{6}\.json$/);

    const blob = await (await request.get('/api/settings')).json();
    expect(envelope.server).toEqual(blob);
  });

  // V-3·V-4: 이식 표 안의 로컬 값은 실리고, 표 밖의 키는 실리지 않는다
  // (FR-SPT-1·3).
  test('export carries listed local keys only', async ({ page }) => {
    await waitForInit(page);
    await page.evaluate(() => {
      localStorage.setItem('attnSound', '1');
      localStorage.setItem('agentsPollMs', '10000');
      localStorage.setItem('sidebarWidth', '333'); // 표 밖 — 기기별 치수
    });
    await openBackupTab(page);

    const { envelope } = await exportEnvelope(page);
    expect(envelope.local.attnSound).toBe('1');
    expect(envelope.local.agentsPollMs).toBe('10000');
    expect(envelope.local.sidebarWidth).toBeUndefined();
    expect(envelope.session.displayMode).toBe('desktop');
  });

  // V-5·V-8: 가져오기가 블롭을 교체하고, 다시 연 화면이 그 설정으로 선다
  // (FR-SPT-11·13).
  test('import replaces the server blob and the page comes back with it', async ({ page, request }) => {
    await waitForInit(page);
    await openBackupTab(page);

    // 두 번째 테마를 골라 그 상태를 내보낸다.
    await page.click('button.mtab[data-tab="theme"]');
    await page.locator('#theme-list .tl-item').nth(1).click();
    const savedName = await page.evaluate(() => currentThemeName);
    await page.click('button.mtab[data-tab="backup"]');
    const { envelope } = await exportEnvelope(page);

    // 다른 테마로 옮긴다.
    await page.click('button.mtab[data-tab="theme"]');
    await page.locator('#theme-list .tl-item').nth(2).click();
    await expect.poll(async () => (await (await request.get('/api/settings')).json()).themeName)
      .not.toBe(savedName);

    // 가져오면 돌아온다.
    await page.click('button.mtab[data-tab="backup"]');
    await importAndApply(page, envelope);

    const blob = await (await request.get('/api/settings')).json();
    expect(blob.themeName).toBe(savedName);
    expect(await page.evaluate(() => currentThemeName)).toBe(savedName);
  });

  // V-6: 파일에 없는 이식 키는 지워져 기본값으로 돌아간다 (FR-SPT-11, D-6).
  test('import clears listed keys the file does not carry', async ({ page }) => {
    await waitForInit(page);
    await page.evaluate(() => localStorage.setItem('attnSound', '1'));
    await openBackupTab(page);

    const { envelope } = await exportEnvelope(page);
    delete envelope.local.attnSound;

    await importAndApply(page, envelope);

    expect(await page.evaluate(() => localStorage.getItem('attnSound'))).toBeNull();
  });

  // V-7: 잘못된 파일은 사유를 남기고 아무것도 바꾸지 않는다 (FR-SPT-9).
  test('a file of the wrong kind is rejected and nothing changes', async ({ page, request }) => {
    await waitForInit(page);
    await openBackupTab(page);

    const before = await (await request.get('/api/settings')).json();
    await importFile(page, { kind: 'something-else', version: 1, server: { themeName: 'x' } });

    await expect(page.locator('#bk-msg')).toContainText('dongminal 설정 파일이 아닙니다');
    await expect(page.locator('#bk-apply')).toBeHidden();

    const after = await (await request.get('/api/settings')).json();
    expect(after).toEqual(before);
  });

  test('a non-JSON file is rejected', async ({ page }) => {
    await waitForInit(page);
    await openBackupTab(page);
    await importFile(page, 'not json at all');
    await expect(page.locator('#bk-msg')).toContainText('JSON 파일이 아닙니다');
    await expect(page.locator('#bk-apply')).toBeHidden();
  });

  // FR-SPT-9: 아는 판보다 새로운 파일은 거부한다 — 모르는 키를 지울 수 없다.
  test('a newer envelope version is rejected', async ({ page }) => {
    await waitForInit(page);
    await openBackupTab(page);
    await importFile(page, { kind: 'dongminal-settings', version: 99, server: {} });
    await expect(page.locator('#bk-msg')).toContainText('더 새로운 판');
    await expect(page.locator('#bk-apply')).toBeHidden();
  });

  // FR-SPT-9: 봉투는 맞지만 내용이 없는 파일.
  test('an envelope without a server object is rejected', async ({ page }) => {
    await waitForInit(page);
    await openBackupTab(page);
    await importFile(page, { kind: 'dongminal-settings', version: 1 });
    await expect(page.locator('#bk-msg')).toContainText('설정 내용이 없습니다');
    await expect(page.locator('#bk-apply')).toBeHidden();
  });
});

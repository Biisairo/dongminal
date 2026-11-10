import { spawn, type ChildProcess } from 'child_process';
import { mkdirSync } from 'fs';

import { request as pwRequest, type APIRequestContext } from '@playwright/test';

import { E2E_BIN, E2E_HOME } from '../playwright.config';
import { stopDaemon } from './daemon-cleanup';
import { expect, hermeticEnv, pingUntilUp, test, waitForInit } from './fixtures';

// PEER_NETWORK_SRS FR-PNW-80~82 — 설정 ▸ Peers.
//
// 브라우저가 붙은 워커 서버가 B(초대하고 승인하는 쪽)다. A 는 이 스펙이 따로 띄우는
// 두 번째 서버다 (NFR-PNW-3: 한 기계에서 홈·포트가 다른 서버 둘). A 는 API 로만 다룬다.

// 노드 포트는 워커 UI 포트에서 떨어뜨려 고른다 — 샤드·워커마다 UI 포트가 다르므로 겹치지 않는다.
const B_NODE_OFFSET = 3000;
const A_UI_OFFSET = 3100;
const A_NODE_OFFSET = 3200;

let aProc: ChildProcess | null = null;
let aHome = '';
let a: APIRequestContext;
let aFp = '';

async function openPeersTab(page) {
  await page.click('#settings-btn');
  await expect(page.locator('#modal-overlay')).toBeVisible();
  await page.click('button.mtab[data-tab="peers"]');
  await expect(page.locator('#panel-peers')).toBeVisible();
  await expect(page.locator('#pn-port-state')).not.toHaveText('');
}

/** B 화면에서 초대를 만들고 그 코드를 돌려준다. 코드는 만든 응답에만 있다 (FR-PNW-95). */
async function makeInvite(page): Promise<string> {
  await page.click('#pn-inv-make');
  const code = page.locator('#pn-inv-code');
  await expect(code).toHaveValue(/^dmpeer1:/);
  return code.inputValue();
}

async function aAdds(code: string) {
  const r = await a.post('/api/peers/add', { data: { code } });
  expect(r.status(), await r.text()).toBe(200);
}

test.describe.serial('설정 ▸ Peers', () => {
  test.beforeAll(async ({ dmServer }) => {
    const aPort = dmServer.port + A_UI_OFFSET;
    aHome = E2E_HOME + '/peer-a-' + dmServer.port;
    mkdirSync(aHome + '/tool-home', { recursive: true });
    aProc = spawn(E2E_BIN, ['start', '--foreground'], {
      env: { ...hermeticEnv(), PORT: String(aPort), DONGMINAL_HOME: aHome, DONGMINAL_TOOL_HOME: aHome + '/tool-home' },
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    await pingUntilUp(`http://localhost:${aPort}/api/ping`, 90_000);
    a = await pwRequest.newContext({ baseURL: `http://localhost:${aPort}` });
    const node = (port: number, name: string) => ({
      enabled: true, port, bind: '127.0.0.1', name, advertise: '127.0.0.1', allowedDirs: [],
    });
    let r = await a.put('/api/peers/node', { data: node(dmServer.port + A_NODE_OFFSET, 'node-a') });
    expect(r.status(), await r.text()).toBe(200);
    aFp = (await r.json()).node.fingerprint;
    const b = await pwRequest.newContext({ baseURL: dmServer.baseURL });
    r = await b.put('/api/peers/node', { data: node(dmServer.port + B_NODE_OFFSET, 'node-b') });
    expect(r.status(), await r.text()).toBe(200);
    await b.dispose();
  });

  test.afterAll(async ({ dmServer }) => {
    // 워커 서버의 노드 포트를 다시 닫는다 — 뒤 스펙은 꺼진 노드를 전제로 한다 (NFR-PNW-1).
    const b = await pwRequest.newContext({ baseURL: dmServer.baseURL });
    await b.put('/api/peers/node', {
      data: { enabled: false, port: 58147, bind: '0.0.0.0', name: 'node-b', advertise: '', allowedDirs: [] },
    });
    await b.dispose();
    if (a) await a.dispose();
    if (aHome) stopDaemon(aHome);
    if (aProc) aProc.kill('SIGTERM');
  });

  // FR-PNW-80: 네 구역과 이 노드의 상태.
  test('네 구역이 서고 노드 포트 상태와 지문 앞 16자가 보인다', async ({ page }) => {
    await waitForInit(page);
    await openPeersTab(page);
    await expect(page.locator('#panel-peers .ds-sec')).toHaveCount(4);
    await expect(page.locator('#pn-enabled')).toBeChecked();
    await expect(page.locator('#pn-name')).toHaveValue('node-b');
    await expect(page.locator('#pn-port-state')).toContainText('127.0.0.1');
    await expect(page.locator('#pn-fp')).toHaveText(/^[0-9a-f]{16}$/);
    await expect(page.locator('#pn-pending')).not.toBeEmpty();
    await expect(page.locator('#pn-peers')).not.toBeEmpty();
  });

  // FR-PNW-80 초대 · FR-PNW-81 주의 알림 · 거절.
  test('초대를 만들고, 승인 대기가 생기면 알림이 뜨고, 누르면 탭이 열리고, 거절할 수 있다', async ({ page }) => {
    await waitForInit(page);
    await openPeersTab(page);
    const code = await makeInvite(page);
    await expect(page.locator('#pn-inv-remain')).toHaveText(/^\d+:\d\d$/);
    await page.keyboard.press('Escape');
    await expect(page.locator('#modal-overlay')).toBeHidden();

    await aAdds(code);
    const notice = page.locator('.toast.peer-attn');
    await expect(notice).toBeVisible();
    await notice.locator('.toast-act').click();
    await expect(page.locator('#panel-peers')).toBeVisible();
    const row = page.locator('#pn-pending .pn-item');
    await expect(row).toHaveCount(1);
    await expect(row).toContainText('node-a');
    await expect(row.locator('.pn-fp')).toHaveText(aFp.slice(0, 16));
    // 코드는 쓰였다 — 살아 있는 초대가 없으니 코드도 거둔다.
    await expect(page.locator('#pn-inv-box')).toBeHidden();

    await row.locator('.pn-reject').click();
    await expect(row).toHaveCount(0);
    await expect(notice).toHaveCount(0);
  });

  // FR-PNW-30 · FR-PNW-82: 이름이 겹치면 다른 이름으로 승인하고, 등록 알림이 남는다.
  test('이름이 겹치면 다른 이름으로 승인하고 "등록됨" 알림이 남는다', async ({ page }) => {
    await waitForInit(page);
    await openPeersTab(page);
    await aAdds(await makeInvite(page));
    const row = page.locator('#pn-pending .pn-item');
    await expect(row).toHaveCount(1);

    // 겹침은 Go 시험(TestPairApproveNameTaken)이 실제로 만든다. 여기서는 그 답을 받은 화면을 본다.
    await page.route('**/api/peers/approve', (route) => route.fulfill({
      status: 409,
      headers: { 'X-Error-Code': 'peer_name_taken' },
      json: { code: 'peer_name_taken', message: 'node-a' },
    }), { times: 1 });
    await row.locator('.pn-approve').click();
    const rename = row.locator('.pn-rename');
    await expect(rename).toBeVisible();
    await expect(page.locator('#pn-pending-status')).toHaveClass(/err/);
    await rename.fill('laptop');
    await row.locator('.pn-approve').click();

    await expect(page.locator('.toast.ok', { hasText: 'laptop' })).toBeVisible();
    await expect(row).toHaveCount(0);
    const peer = page.locator('#pn-peers .pn-item[data-name="laptop"]');
    await expect(peer).toBeVisible();
    await expect(peer).toContainText('127.0.0.1');
    // A 도 짝이 됐다 — B 의 승인 통지가 닿았다. A 가 붙인 이름은 I-5 가 정하므로 보지 않는다.
    const bFp = await page.locator('#pn-fp').textContent();
    const ap = await (await a.get('/api/peers')).json();
    expect(ap.peers.filter((p) => p.state === '' && p.fp.startsWith(bFp)).length).toBe(1);
  });

  // FR-PNW-80 짝: 주소 수정(FR-PNW-32)과 해제(FR-PNW-31).
  test('짝의 주소를 고치고 해제한다', async ({ page }) => {
    await waitForInit(page);
    await openPeersTab(page);
    const peer = page.locator('#pn-peers .pn-item[data-name="laptop"]');
    await expect(peer).toBeVisible();
    await peer.locator('.pn-edit').click();
    await peer.locator('.pn-addr').fill('127.0.0.2');
    await peer.locator('.pn-edit').click();
    await expect(peer.locator('.pn-who')).toContainText('127.0.0.2');
    await expect(peer.locator('.pn-addr')).toBeHidden();
    await peer.locator('.pn-remove').click();
    await page.locator('.pn-confirm .ui-btn-danger').click();
    await expect(peer).toHaveCount(0);
  });
});

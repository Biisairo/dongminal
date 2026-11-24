import { spawn, type ChildProcess } from 'child_process';
import { mkdirSync } from 'fs';
import { connect } from 'net';

import { request as pwRequest, type APIRequestContext } from '@playwright/test';

import { E2E_BIN, E2E_HOME, E2E_HOST } from '../playwright.config';
import { stopDaemon } from './daemon-cleanup';
import { expect, hermeticEnv, pingUntilUp, test, waitForInit } from './fixtures';

// PEER_NETWORK_SRS FR-PNW-80, EDGE_PAIRING_SRS FR-EPR-5·23·70·71 — 설정 ▸ Edges.
//
// 브라우저가 붙은 워커 서버가 B(초대하는 쪽)다. A 는 이 스펙이 따로 띄우는
// 두 번째 서버다 (NFR-PNW-3: 한 기계에서 홈·포트가 다른 서버 둘). A 는 API 로만 다룬다.

// 노드 포트는 워커 UI 포트에서 떨어뜨려 고른다 — 샤드·워커마다 UI 포트가 다르므로 겹치지 않는다.
const B_NODE_OFFSET = 3000;
const A_UI_OFFSET = 3100;
const A_NODE_OFFSET = 3200;
// 아무도 듣지 않는 포트 — 끊기 알림이 곧바로 거부되게 한다 (RUST_DEFECT_FIX_SRS 10.7c). 종전의 127.0.0.2 는
// 판마다 달랐다: macOS 는 3초 시한까지 매달리고 linux 는 곧바로 거부한다.
const CLOSED_OFFSET = 3300;

/** 그 포트에 붙으면 곧바로 거부되는가. */
function refused(port: number) {
  return new Promise<boolean>((resolve) => {
    const s = connect(port, E2E_HOST);
    s.setTimeout(3000, () => { s.destroy(); resolve(false) });
    s.on('connect', () => { s.destroy(); resolve(false) });
    s.on('error', (e: NodeJS.ErrnoException) => resolve(e.code === 'ECONNREFUSED'));
  });
}

let aProc: ChildProcess | null = null;
let aHome = '';
let a: APIRequestContext;
let aFp = '';

async function openEdgesTab(page) {
  await page.click('#settings-btn');
  await expect(page.locator('#modal-overlay')).toBeVisible();
  await page.click('button.mtab[data-tab="edges"]');
  await expect(page.locator('#panel-edges')).toBeVisible();
  await expect(page.locator('#eg-port-state')).not.toHaveText('');
}

/** B 화면에서 초대를 만들고 그 코드를 돌려준다. 코드는 만든 응답에만 있다 (FR-PNW-95). */
async function makeInvite(page): Promise<string> {
  await page.click('#eg-inv-make');
  const code = page.locator('#eg-inv-code');
  await expect(code).toHaveValue(/^dmedge1:/);
  return code.inputValue();
}

async function aAdds(code: string) {
  const r = await a.post('/api/edges/add', { data: { code } });
  expect(r.status(), await r.text()).toBe(200);
}

/** 화면을 거치지 않고 B 와 A 를 간선으로 맺는다. 앞 테스트의 상태에 기대지 않기 위해서다. */
async function pairViaApi(baseURL: string) {
  const b = await pwRequest.newContext({ baseURL });
  const r = await b.post('/api/edges/invite', { data: {} });
  expect(r.status(), await r.text()).toBe(200);
  await aAdds((await r.json()).code);
  await b.dispose();
}

/** B 에서 방송(edges_changed)을 하나 일으킨다. 초대를 만들면 서버가 민다. */
async function poke(baseURL: string) {
  const b = await pwRequest.newContext({ baseURL });
  expect((await b.post('/api/edges/invite', { data: {} })).status()).toBe(200);
  await b.dispose();
}

test.describe.serial('설정 ▸ Edges', () => {
  test.beforeAll(async ({ dmServer }) => {
    const aPort = dmServer.port + A_UI_OFFSET;
    aHome = E2E_HOME + '/peer-a-' + dmServer.port;
    mkdirSync(aHome + '/tool-home', { recursive: true });
    aProc = spawn(E2E_BIN, ['start', '--foreground', '--port', String(aPort)], {
      env: { ...hermeticEnv(), DONGMINAL_HOME: aHome, DONGMINAL_TOOL_HOME: aHome + '/tool-home' },
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    await pingUntilUp(`http://${E2E_HOST}:${aPort}/api/ping`, 90_000);
    a = await pwRequest.newContext({ baseURL: `http://${E2E_HOST}:${aPort}` });
    const node = (port: number, name: string) => ({
      enabled: true, port, bind: '127.0.0.1', name, advertise: '127.0.0.1',
    });
    let r = await a.put('/api/edges/node', { data: node(dmServer.port + A_NODE_OFFSET, 'node-a') });
    expect(r.status(), await r.text()).toBe(200);
    aFp = (await r.json()).node.fingerprint;
    const b = await pwRequest.newContext({ baseURL: dmServer.baseURL });
    r = await b.put('/api/edges/node', { data: node(dmServer.port + B_NODE_OFFSET, 'node-b') });
    expect(r.status(), await r.text()).toBe(200);
    await b.dispose();
  });

  test.afterAll(async ({ dmServer }) => {
    // 워커 서버의 노드 포트를 다시 닫는다 — 뒤 스펙은 꺼진 노드를 전제로 한다 (NFR-PNW-1).
    const b = await pwRequest.newContext({ baseURL: dmServer.baseURL });
    // 맺은 간선을 남기지 않는다 — 워커 데몬의 간선은 뒤 스펙의 화면(V-LAY-1 의 Edges 탭)에 그대로 보인다.
    if (aFp) await b.post('/api/edges/remove', { data: { fp: aFp } });
    await b.put('/api/edges/node', {
      data: { enabled: false, port: 58147, bind: '0.0.0.0', name: 'node-b', advertise: '' },
    });
    await b.dispose();
    if (a) await a.dispose();
    if (aHome) stopDaemon(aHome);
    if (aProc) aProc.kill('SIGTERM');
  });

  // FR-EPR-70, EDGE_MESH_SRS FR-EGM-50·55: 이 노드·초대·망·받은 초대·간선의 다섯 구역과 이 노드의 상태.
  // 승인 대기 구역은 없다.
  test('다섯 구역이 서고 노드 포트 상태와 지문 앞 16자가 보인다', async ({ page }) => {
    await waitForInit(page);
    await openEdgesTab(page);
    await expect(page.locator('#panel-edges .ds-sec')).toHaveCount(5);
    await expect(page.locator('#eg-pending')).toHaveCount(0);
    await expect(page.locator('#eg-add-name')).toHaveCount(0);
    await expect(page.locator('#eg-enabled')).toBeChecked();
    // PROFILE_NAME_SRS FR-PFN-31: 이름은 프로필에서 바꾸고 여기는 이름#번호를 보여 준다.
    await expect(page.locator('#eg-handle')).toHaveText(/^node-b#\d{4}$/);
    await expect(page.locator('#eg-port-state')).toContainText('127.0.0.1');
    await expect(page.locator('#eg-fp')).toHaveText(/^[0-9a-f]{16}$/);
    // 비어 있으면 "없음" 한 줄만 있다.
    await expect(page.locator('#eg-edges .eg-item')).toHaveCount(0);
    await expect(page.locator('#eg-edges .sbx-status')).toHaveCount(1);
  });

  // FR-EPR-4·5·32: 붙여 넣기 한 번으로 간선이 생기고 "맺었습니다" 알림이 남는다.
  test('초대를 만들고 상대가 붙여 넣으면 바로 간선이 생긴다', async ({ page }) => {
    await waitForInit(page);
    await openEdgesTab(page);
    const code = await makeInvite(page);
    await expect(page.locator('#eg-inv-remain')).toHaveText(/^\d+:\d\d$/);

    await aAdds(code);
    await expect(page.locator('.toast.ok', { hasText: 'node-a' })).toBeVisible();
    const peer = page.locator(`#eg-edges .eg-item[data-fp="${aFp}"]`);
    await expect(peer).toBeVisible();
    // PROFILE_NAME_SRS FR-PFN-22: 줄은 이름#번호이고, 지문 앞 16자는 툴팁이다.
    await expect(peer.locator('.eg-who')).toContainText(/node-a#\d{4}/);
    await expect(peer.locator('.eg-who')).toHaveAttribute('title', aFp.slice(0, 16));
    await expect(peer.locator('.eg-who')).toContainText('127.0.0.1');
    // 코드는 쓰였다 — 살아 있는 초대가 없으니 코드도 거둔다.
    await expect(page.locator('#eg-inv-box')).toBeHidden();
  });

  // FR-EPR-20·23: 상대가 끊으면 이쪽에서도 사라지고 알림이 뜬다.
  test('상대가 끊으면 간선이 사라지고 "끊겼습니다" 알림이 뜬다', async ({ page, dmServer }) => {
    await pairViaApi(dmServer.baseURL);
    await waitForInit(page);
    await openEdgesTab(page);
    const peer = page.locator(`#eg-edges .eg-item[data-fp="${aFp}"]`);
    await expect(peer).toBeVisible();
    const bFp = await page.locator('#eg-fp').textContent();
    const r = await a.post('/api/edges/remove', { data: { fp: bFp } });
    expect(r.status(), await r.text()).toBe(200);
    expect((await r.json()).notified).toBe(true);
    await expect(peer).toHaveCount(0);
    await expect(page.locator('.toast', { hasText: /끊겼습니다|was removed/ })).toContainText('node-a');
  });

  // FR-EPR-52·71: 주소 수정과 끊기. 듣지 않는 포트로 고쳤으므로 상대에게 알리지 못한다.
  test('간선의 주소를 고치고 끊는다', async ({ page, dmServer }) => {
    await pairViaApi(dmServer.baseURL);
    await waitForInit(page);
    await openEdgesTab(page);
    const peer = page.locator(`#eg-edges .eg-item[data-fp="${aFp}"]`);
    await expect(peer).toBeVisible();
    // M-7: 고치던 줄은 방송에 덮이지 않고, 취소하면 원래 값으로 돌아온다.
    await peer.locator('.eg-edit').click();
    await peer.locator('.eg-addr').fill('10.9.9.9');
    await poke(dmServer.baseURL);
    await expect(page.locator('#eg-inv-remain')).toHaveText(/^\d+:\d\d$/);
    await expect(peer.locator('.eg-addr')).toHaveValue('10.9.9.9');
    await peer.locator('.eg-edit-cancel').click();
    await expect(peer.locator('.eg-addr')).toBeHidden();
    await expect(peer.locator('.eg-edit-cancel')).toBeHidden();
    await expect(peer.locator('.eg-who')).toContainText('127.0.0.1');
    const closed = dmServer.port + CLOSED_OFFSET;
    expect(await refused(closed), `닫혀 있어야 할 포트 ${closed} 가 받는다`).toBe(true);
    await peer.locator('.eg-edit').click();
    await peer.locator('.eg-addr').fill('127.0.0.1');
    await peer.locator('.eg-port').fill(String(closed));
    await peer.locator('.eg-edit').click();
    await expect(peer.locator('.eg-who')).toContainText(`127.0.0.1:${closed}`);
    await expect(peer.locator('.eg-addr')).toBeHidden();
    await peer.locator('.eg-remove').click();
    await expect(page.locator('.eg-confirm')).toContainText(aFp.slice(0, 16));
    // 토스트의 근거(응답의 `notified`)를 먼저 본다 — 토스트만 보면 실패했을 때 무엇이 갈렸는지 알 수 없다.
    const removed = page.waitForResponse((r) => r.url().includes('/api/edges/remove'));
    await page.locator('.eg-confirm .ui-btn-danger').click();
    const res = await removed;
    const body = await res.text();
    expect(res.status(), body).toBe(200);
    expect(JSON.parse(body).notified, body).toBe(false);
    await expect(peer).toHaveCount(0);
    await expect(page.locator('.toast', { hasText: /알리지 못했습니다|Could not notify/ })).toBeVisible();
  });

  // EDGE_MESH_SRS FR-EGM-3·50~54: 맺으면 간선 연결이 서고, 망 그림에 나와 상대가 이어져 보인다.
  // 상대를 누르면 알리기가 나오고, 알리면 알렸다는 알림이 뜬다.
  test('망 그림에 간선 상대가 보이고 알리기가 된다', async ({ page, dmServer }) => {
    await pairViaApi(dmServer.baseURL);
    await waitForInit(page);
    await openEdgesTab(page);
    const node = page.locator(`#eg-mesh .eg-mesh-node[data-fp="${aFp}"]`);
    await expect(node).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('#eg-mesh .eg-mesh-node.self')).toHaveCount(1);
    await expect(page.locator('#eg-mesh .eg-mesh-link.mine')).toHaveCount(1);
    await expect(node).not.toHaveClass(/\boff\b/);
    await node.click();
    await expect(page.locator('#eg-mesh-act .eg-who')).toContainText(/node-a#\d{4}/);
    await page.locator('#eg-mesh-act .eg-mesh-notify').click();
    await expect(page.locator('.toast.ok', { hasText: 'node-a' })).toBeVisible();
    await expect(page.locator(`#eg-edges .eg-item[data-fp="${aFp}"] .eg-notify`)).toBeVisible();
    await expect(page.locator('#eg-invites .sbx-status')).toHaveCount(1);
  });
});

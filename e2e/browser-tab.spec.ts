import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { createServer, IncomingMessage, Server, ServerResponse } from 'http';
import { AddressInfo } from 'net';
import { tmpdir } from 'os';
import { join } from 'path';

import { chromium } from '@playwright/test';

import { test, expect, waitForInit, waitShellReady, JSON_HDR } from './fixtures';

// BROWSER_TAB_SRS §4.4~4.6 — 서버 기기의 Chrome 을 탭으로.
//
// 페이지 안의 사실(입력값·폭·새로고침)은 **시험 페이지가 시험 서버로 보고한다** —
// 뷰어는 픽셀만 받으므로 그 안을 들여다볼 길이 이것이다. Chrome 이 없으면 서버가
// 거절하고(FR-BRT-2) 스펙은 건너뛴다.

type Report = { k: string; v: string };

function startSite(): Promise<{ url: string; reports: Report[]; hits: Map<string, number>; close: () => void }> {
  const reports: Report[] = [];
  const hits = new Map<string, number>();
  const page = (body: string) => `<!doctype html><meta charset=utf-8><title>site</title>
<style>body{margin:0;font:16px sans-serif}#i{position:absolute;left:20px;top:20px;width:300px;height:40px}
#blank{position:absolute;left:20px;top:100px;display:block;width:300px;height:40px;background:#9cf}
#close{position:absolute;left:20px;top:180px;width:300px;height:40px}</style>
<script>const rep=(k,v)=>fetch('/report?k='+encodeURIComponent(k)+'&v='+encodeURIComponent(v));
addEventListener('load',()=>rep('width',innerWidth));addEventListener('resize',()=>rep('rw',innerWidth));
</script>${body}`;
  const srv: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const u = new URL(req.url || '/', 'http://x');
    hits.set(u.pathname, (hits.get(u.pathname) || 0) + 1);
    if (u.pathname === '/report') {
      reports.push({ k: u.searchParams.get('k') || '', v: u.searchParams.get('v') || '' });
      res.end('ok');
      return;
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (u.pathname === '/keys') { res.end(page(`<input id=i><script>addEventListener('keydown',e=>rep('key',(e.ctrlKey?'C-':'')+(e.shiftKey?'S-':'')+e.key))</script>`)); return }
    if (u.pathname === '/tip') { res.end(page(`<button id=close title="<img src=x onerror=alert(1)>">tip</button>`)); return }
    if (u.pathname === '/tone') { res.end(page(`<button id=close onclick="const c=new AudioContext();const o=c.createOscillator();o.connect(c.destination);o.start();c.resume().then(()=>rep('tone',c.state))">tone</button>`)); return }
    if (u.pathname === '/confirm') { res.end(page(`<button id=close onclick="rep('confirm',String(confirm('go?')))">ask</button>`)); return }
    if (u.pathname === '/file.bin') { res.setHeader('Content-Type', 'application/octet-stream'); res.setHeader('Content-Disposition', 'attachment; filename="file.bin"'); res.end('abc'); return }
    if (u.pathname === '/other') { res.end(page('<h1>other</h1><button id=close onclick="window.close()">close</button>')); return }
    res.end(page(`<input id=i oninput="rep('value',this.value)">
<a id=blank href="/other" target="_blank">new tab</a>
<button id=close onclick="window.close()">close</button>`));
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => {
    const port = (srv.address() as AddressInfo).port;
    resolve({ url: `http://127.0.0.1:${port}`, reports, hits, close: () => srv.close() });
  }));
}

/** 포커스 칸의 터미널 도구 id — 호출 칸의 근거다 (FR-BRT-32). */
async function focusedTool(page: any): Promise<string> {
  return page.evaluate(() => {
    const a = (window as any).app;
    const s = a.aw();
    const walk = (n: any): any => n && (n.type === 'pane' ? (n.id === a.focused ? n : null) : (n.children || []).map(walk).find(Boolean));
    const pn = walk(s.layout);
    const tab = pn.tabs.find((t: any) => t.id === a.paneTab(pn));
    return tab.toolId || '';
  });
}

/** 활성 창의 칸별 탭 종류. */
async function paneTypes(page: any): Promise<string[][]> {
  return page.evaluate(() => {
    const a = (window as any).app;
    const out: string[][] = [];
    const walk = (n: any) => { if (!n) return; if (n.type === 'pane') out.push(n.tabs.map((t: any) => t.type)); else (n.children || []).forEach(walk) };
    walk(a.aw().layout);
    return out;
  });
}

async function openTab(request: any, body: any): Promise<string> {
  const r = await request.post('/api/browser/open', { data: body, headers: JSON_HDR });
  if (r.status() === 409 && /Chrome/.test(await r.text())) test.skip(true, 'Chrome 없음');
  expect(r.status()).toBe(200);
  return (await r.json()).tab;
}

/** 보이는 뷰가 프레임을 그렸다 — 그 전에는 좌표를 페이지로 옮길 근거가 없다. */
async function waitFrame(page: any) {
  await page.waitForFunction(() => {
    const a = (window as any).app;
    return [...(a.testing.brvViews || new Map()).values()].some((v: any) => v.visible && v._rect && v.meta);
  }, null, { timeout: 20000 });
}

/** 캔버스 안의 페이지 CSS 좌표를 누른다 — 뷰포트가 칸 크기이므로 1:1 이다. */
async function clickPage(page: any, x: number, y: number) {
  await waitFrame(page);
  const box = await page.locator('.brv.vis .brv-canvas').boundingBox();
  await page.mouse.click(box.x + x, box.y + y);
}

async function waitReport(site: { reports: Report[] }, k: string, pred: (v: string) => boolean) {
  await expect.poll(() => site.reports.filter((r) => r.k === k).some((r) => pred(r.v)), { timeout: 20000 }).toBe(true);
}

test.describe('BROWSER_TAB — 브라우저 탭', () => {
  let site: Awaited<ReturnType<typeof startSite>>;
  test.beforeAll(async () => { site = await startSite() });
  test.afterAll(() => site.close());
  test.beforeEach(() => { site.reports.length = 0; site.hits.clear() });

  // TC-BRT-30·33: split — 오른쪽 칸이 없으면 나누고, 있으면 그 칸에 새 탭. 재사용하지 않는다.
  test('TC-BRT-30·33: 오른쪽 분할 뒤 같은 칸에 새 탭, 같은 URL 두 번 → 탭 둘', async ({ page, request }) => {
    await waitForInit(page);
    await waitShellReady(page);
    const tool = await focusedTool(page);
    await openTab(request, { url: site.url + '/', tool, split: 'right' });
    await expect.poll(() => paneTypes(page)).toEqual([['terminal'], ['browser']]);
    await openTab(request, { url: site.url + '/', tool, split: 'right' });
    await expect.poll(() => paneTypes(page)).toEqual([['terminal'], ['browser', 'browser']]);
  });

  // TC-BRT-31: tab — 호출 칸에 새 탭.
  test('TC-BRT-31: split none 은 호출 칸의 새 탭이다', async ({ page, request }) => {
    await waitForInit(page);
    await waitShellReady(page);
    const tool = await focusedTool(page);
    await openTab(request, { url: site.url + '/', tool, split: 'none' });
    await expect.poll(() => paneTypes(page)).toEqual([['terminal', 'browser']]);
  });

  // 화면·입력: 클릭 → 입력란, 글자 → 페이지 (FR-BRT-53·54). 한글 조합 (TC-BRT-43).
  test('TC-BRT-43: 클릭·타자·한글 조합이 페이지에 닿는다', async ({ page, request }) => {
    await waitForInit(page);
    await waitShellReady(page);
    await openTab(request, { url: site.url + '/', tool: await focusedTool(page), split: 'right', focus: true });
    await waitReport(site, 'width', () => true);
    await clickPage(page, 100, 40);
    await page.keyboard.type('ab');
    await waitReport(site, 'value', (v) => v === 'ab');
    // 조합 입력 — 바깥 Chrome 의 IME 를 흉내내 뷰어의 composition 이벤트를 일으킨다.
    const cdp = await page.context().newCDPSession(page);
    for (const s of ['ㅎ', '하', '한', '한ㄱ', '한그', '한글']) {
      await cdp.send('Input.imeSetComposition', { text: s, selectionStart: s.length, selectionEnd: s.length });
    }
    await cdp.send('Input.insertText', { text: '한글' });
    await waitReport(site, 'value', (v) => v === 'ab한글');
  });

  // TC-BRT-44: Mod+R 은 dongminal 을 새로고침하지 않고 탭을 새로고침한다.
  test('TC-BRT-44: Mod+R 은 탭의 새로고침이다', async ({ page, request }) => {
    await waitForInit(page);
    await waitShellReady(page);
    await openTab(request, { url: site.url + '/', tool: await focusedTool(page), split: 'right', focus: true });
    await waitReport(site, 'width', () => true);
    await page.evaluate(() => { (window as any).__stay = 1 });
    await clickPage(page, 400, 400);
    const before = site.hits.get('/') || 0;
    await page.keyboard.press('ControlOrMeta+KeyR');
    await expect.poll(() => site.hits.get('/') || 0, { timeout: 15000 }).toBeGreaterThan(before);
    expect(await page.evaluate(() => (window as any).__stay)).toBe(1);
  });

  // TC-BRT-46: 확대 Mod+= → innerWidth 가 1/z.
  test('TC-BRT-46: 확대하면 페이지의 CSS 폭이 줄어든다', async ({ page, request }) => {
    await waitForInit(page);
    await waitShellReady(page);
    await openTab(request, { url: site.url + '/', tool: await focusedTool(page), split: 'right', focus: true });
    await clickPage(page, 400, 400);
    // 기준 폭은 뷰포트가 칸 크기로 선 뒤에 잰다 — 첫 로드는 그 전일 수 있다.
    site.reports.length = 0;
    await page.keyboard.press('ControlOrMeta+KeyR');
    await waitReport(site, 'width', () => true);
    const w0 = Number(site.reports.filter((r) => r.k === 'width').pop()!.v);
    await page.keyboard.press('ControlOrMeta+Equal');
    await page.keyboard.press('ControlOrMeta+KeyR');
    await waitReport(site, 'width', (v) => Math.abs(Number(v) - w0 / 1.1) <= 2);
  });

  // TC-BRT-32: 페이지가 연 탭은 연 탭의 칸, 바로 뒤, 일반 클릭이면 앞으로.
  // TC-BRT-35: 페이지가 스스로 닫히면 탭도 닫힌다.
  test('TC-BRT-32·35: target=_blank 는 바로 뒤에 열리고 window.close 는 탭을 닫는다', async ({ page, request }) => {
    await waitForInit(page);
    await waitShellReady(page);
    const tab = await openTab(request, { url: site.url + '/', tool: await focusedTool(page), split: 'right', focus: true });
    await waitReport(site, 'width', () => true);
    await clickPage(page, 100, 120);
    await expect.poll(() => paneTypes(page)).toEqual([['terminal'], ['browser', 'browser']]);
    const order = await page.evaluate((id: string) => {
      const a = (window as any).app;
      const walk = (n: any): any => n && (n.type === 'pane' ? (n.tabs.some((t: any) => t.id === id) ? n : null) : (n.children || []).map(walk).find(Boolean));
      const pn = walk(a.aw().layout);
      return { ids: pn.tabs.map((t: any) => t.id), active: a.paneTab(pn) };
    }, tab);
    expect(order.ids[0]).toBe(tab);
    expect(order.active).toBe(order.ids[1]);
    // 스크립트는 기록이 한 칸인 창만 닫을 수 있다 — 새로 열린 탭에서 닫는다.
    await clickPage(page, 100, 200);
    await expect.poll(() => paneTypes(page)).toEqual([['terminal'], ['browser']]);
  });

  // TC-BRT-35: 탭을 닫으면 페이지가 닫힌다.
  test('TC-BRT-35: 탭 닫기는 페이지를 닫는다', async ({ page, request }) => {
    await waitForInit(page);
    await waitShellReady(page);
    const tab = await openTab(request, { url: site.url + '/', tool: await focusedTool(page), split: 'right' });
    await expect.poll(() => paneTypes(page)).toEqual([['terminal'], ['browser']]);
    await page.evaluate((id: string) => (window as any).app.testing.execRemote('closeTab', { location: id, force: true }), tab);
    await expect.poll(async () => {
      const r = await request.get('/api/browser/tabs');
      return (await r.json()).tabs.filter((t: any) => t.tab === tab && t.live).length;
    }).toBe(0);
  });

  // TC-BRT-53: 주소창은 허용된 scheme 만 연다.
  test('TC-BRT-53: 주소창의 javascript: 는 거절 안내다', async ({ page, request }) => {
    await waitForInit(page);
    await waitShellReady(page);
    await openTab(request, { url: site.url + '/', tool: await focusedTool(page), split: 'right', focus: true });
    // 탭이 놓이며 포커스가 캔버스로 가기 전에 치면 그 이동이 입력을 덮는다 — 첫 프레임 뒤에 친다.
    await waitReport(site, 'width', () => true);
    await waitFrame(page);
    const addr = page.locator('.brv.vis .brv-addr');
    await addr.fill('javascript:alert(1)');
    await addr.press('Enter');
    await expect(addr).toHaveClass(/brv-addr-bad/);
    await addr.fill(site.url + '/other');
    await addr.press('Enter');
    await expect.poll(() => site.hits.get('/other') || 0).toBeGreaterThan(0);
  });

  // TC-BRT-50: 쉘의 open 은 브라우저 탭을 연다 (실 셸). 경로 인자는 위임한다.
  test('TC-BRT-50: 터미널의 open <url> 이 브라우저 탭을 연다', async ({ page }) => {
    await waitForInit(page);
    await waitShellReady(page);
    await page.locator('#area .pn.focused .xterm-helper-textarea').focus();
    await page.keyboard.type(`open ${site.url}/other\n`);
    await expect.poll(() => paneTypes(page), { timeout: 20000 }).toEqual([['terminal'], ['browser']]);
    await expect.poll(() => site.hits.get('/other') || 0).toBeGreaterThan(0);
  });

  // TC-BRT-51·52: 링크 클릭은 설정을 따르고 수정키는 반대다. 프로그램 URL 은 언제나 내장.
  test('TC-BRT-51·52: 링크 라우팅 — 설정 두 값 × 수정키', async ({ page }) => {
    await waitForInit(page);
    await page.route('**/api/browser/open', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true,"tab":"x"}' }));
    const got = await page.evaluate(async () => {
      const w = window as any;
      const opened: string[] = [];
      w.open = (u: string) => { opened.push(u); return null };
      const posted: string[] = [];
      const orig = w.fetch;
      w.fetch = (u: string, o: any) => { if (String(u).includes('/api/browser/open')) posted.push(JSON.parse(o.body).url); return orig(u, o) };
      const run = async (target: string, flip: boolean) => {
        w.browserLinkTarget = target;
        opened.length = 0; posted.length = 0;
        w.app.openLink('https://example.com/', flip ? { shiftKey: true, metaKey: true, ctrlKey: false } : null);
        await new Promise((r) => setTimeout(r, 50));
        return (posted.length ? 'internal' : '') + (opened.length ? 'viewer' : '');
      };
      const out = {
        internal: await run('internal', false), internalFlip: await run('internal', true),
        viewer: await run('viewer', false), viewerFlip: await run('viewer', true),
      };
      w.browserLinkTarget = 'internal';
      return out;
    });
    expect(got).toEqual({ internal: 'internal', internalFlip: 'viewer', viewer: 'viewer', viewerFlip: 'internal' });
  });

  // TC-BRT-24·65: Playwright 가 CDP 프록시로 붙어 같은 브라우저를 쓴다. 도구가 만든 페이지는
  // 부른 도구의 칸에 탭이 되고, 닫으면 탭도 닫힌다. 새 컨텍스트의 페이지는 임시다.
  test('TC-BRT-24·65: connectOverCDP(ws·http) — newPage 는 탭, close 는 탭 닫기', async ({ page, request }) => {
    await waitForInit(page);
    await waitShellReady(page);
    const tool = await focusedTool(page);
    await openTab(request, { url: 'about:blank', tool, split: 'right' });
    await expect.poll(() => paneTypes(page)).toEqual([['terminal'], ['browser']]);
    const urls = await (await request.get('/api/browser/cdpurl?tool=' + tool)).json();
    const b = await chromium.connectOverCDP(urls.ws);
    const ctx = b.contexts()[0];
    const p = await ctx.newPage();
    await p.goto(site.url + '/');
    await p.fill('#i', 'from-playwright');
    await waitReport(site, 'value', (v) => v === 'from-playwright');
    await expect.poll(() => paneTypes(page)).toEqual([['terminal'], ['browser', 'browser']]);
    await p.close();
    await expect.poll(() => paneTypes(page)).toEqual([['terminal'], ['browser']]);
    const iso = await b.newContext();
    const ip = await iso.newPage();
    await ip.goto(site.url + '/other');
    await expect.poll(() => page.evaluate(() => {
      const a = (window as any).app;
      const out: boolean[] = [];
      const walk = (n: any) => { if (!n) return; if (n.type === 'pane') n.tabs.forEach((t: any) => out.push(!!t.isolated)); else (n.children || []).forEach(walk) };
      walk(a.aw().layout);
      return out.includes(true);
    })).toBe(true);
    await iso.close();
    await b.close();
    // http 형태 — 경로 접두사를 보존한 채 json/version/ 을 붙인다 (P8).
    const b2 = await chromium.connectOverCDP(urls.http);
    expect(b2.isConnected()).toBe(true);
    await b2.close();
  });

  // TC-BRT-72: confirm 은 탭 위의 대화상자이고 그 답이 페이지로 간다.
  test('TC-BRT-72: confirm 대화상자의 확인이 페이지에 닿는다', async ({ page, request }) => {
    await waitForInit(page);
    await waitShellReady(page);
    await openTab(request, { url: site.url + '/confirm', tool: await focusedTool(page), split: 'right', focus: true });
    await waitReport(site, 'width', () => true);
    await clickPage(page, 100, 200);
    const dlg = page.locator('.brv-dialog-modal');
    await expect(dlg).toContainText('go?', { timeout: 20000 });
    await dlg.locator('.ui-btn-primary').click();
    await waitReport(site, 'confirm', (v) => v === 'true');
  });

  // TC-BRT-70: 다운로드는 서버의 다운로드 폴더에 쌓이고 목록에 보인다.
  test('TC-BRT-70: 다운로드가 목록에 완료로 보인다', async ({ page, request }) => {
    await waitForInit(page);
    await waitShellReady(page);
    // 사용자의 ~/Downloads 를 더럽히지 않는다 — 폴더는 다운로드가 끝날 때 읽는다.
    const dir = mkdtempSync(join(tmpdir(), 'brt-dl-'));
    const cur = await (await request.get('/api/settings')).json();
    await request.put('/api/settings', { data: { ...cur, browserDownloadDir: dir } });
    const tab = await openTab(request, { url: site.url + '/', tool: await focusedTool(page), split: 'right', focus: true });
    await waitReport(site, 'width', () => true);
    await request.post('/api/browser/nav', { data: { tab, action: 'goto', url: site.url + '/file.bin' }, headers: JSON_HDR });
    await expect.poll(async () => {
      const r = await (await request.get('/api/browser/downloads')).json();
      return (r.downloads || []).some((d: any) => d.name === 'file.bin' && d.state === 'completed');
    }, { timeout: 20000 }).toBe(true);
    await expect(page.locator('.brv-dl .brv-dl-name')).toContainText('file.bin');
    expect(readFileSync(join(dir, 'file.bin'), 'utf8')).toBe('abc');
    await request.put('/api/settings', { data: cur });
    rmSync(dir, { recursive: true, force: true });
  });

  // TC-BRT-81: 소리를 이 기기로 — 시험 페이지의 톤이 뷰어의 WebRTC 트랙에 도착한다.
  test('TC-BRT-81: 탭의 소리가 뷰어에 도착한다', async ({ page, request }) => {
    await waitForInit(page);
    await waitShellReady(page);
    // 설정은 브라우저를 띄울 때 읽는다 — 새 프로필이 새 브라우저다.
    const cur = await (await request.get('/api/settings')).json();
    await request.put('/api/settings', { data: { ...cur, browserAudio: 'viewer' } });
    await page.evaluate(() => { (window as any).browserAudio = 'viewer' });
    await request.post('/api/browser/profiles', { data: { name: 'snd' }, headers: JSON_HDR });
    try {
      await openTab(request, { url: site.url + '/tone', profile: 'snd', tool: await focusedTool(page), split: 'right', focus: true });
      await waitReport(site, 'width', () => true);
      await clickPage(page, 100, 200);
      await waitReport(site, 'tone', (v) => v === 'running');
      await expect.poll(() => page.evaluate(async () => {
        const v = [...((window as any).app.testing.brvViews || new Map()).values()].find((x: any) => x.visible);
        const pc = v && v._audio && v._audio.pc;
        if (!pc) return 0;
        let e = 0;
        (await pc.getStats()).forEach((r: any) => { if (r.type === 'inbound-rtp' && r.kind === 'audio') e = r.totalAudioEnergy || 0 });
        return e;
      }), { timeout: 20000 }).toBeGreaterThan(0);
    } finally {
      await request.put('/api/settings', { data: cur });
      await page.evaluate(() => { (window as any).browserAudio = 'off' });
      await request.post('/api/browser/profiles/delete', { data: { name: 'snd' }, headers: JSON_HDR });
    }
  });

  /** 보이는 브라우저 탭의 레코드. */
  const brvRecord = (page: any, id: string) => page.evaluate((tid: string) => {
    const a = (window as any).app;
    let out: any = null;
    const walk = (n: any) => { if (!n || out) return; if (n.type === 'pane') out = n.tabs.find((t: any) => t.id === tid) || null; else (n.children || []).forEach(walk) };
    for (const w of a.ws.windows) walk(w.layout);
    return out && JSON.parse(JSON.stringify(out));
  }, id);

  // TC-BRT-44: 전역 단축키는 페이지에 가지 않고, 나머지 키는 간다.
  test('TC-BRT-44: 전역 단축키는 페이지로 가지 않는다', async ({ page, request }) => {
    await waitForInit(page);
    await waitShellReady(page);
    await openTab(request, { url: site.url + '/keys', tool: await focusedTool(page), split: 'right', focus: true });
    await waitReport(site, 'width', () => true);
    await clickPage(page, 100, 40);
    await page.keyboard.press('Control+Shift+KeyB');
    await expect(page.locator('#agents-panel.open')).toHaveCount(1);
    await page.keyboard.press('Control+Shift+KeyB');
    await clickPage(page, 100, 40);
    // 탭 단축키(새로고침·확대)도 페이지에 가지 않는다 — 짝 없는 keyup·엉뚱한 키도 없다.
    await page.keyboard.press('ControlOrMeta+Equal');
    await page.keyboard.press('ControlOrMeta+Digit0');
    await page.keyboard.press('x');
    await waitReport(site, 'key', (v) => v === 'x');
    const keys = site.reports.filter((r) => r.k === 'key').map((r) => r.v);
    expect(keys.filter((v) => !/^(C-)?(S-)?(Meta|Control|Shift|Alt)$/.test(v) && v !== 'x'), JSON.stringify(keys)).toEqual([]);
  });

  // TC-BRT-76: 이 기기의 붙여넣기가 페이지 입력란에 들어간다.
  test('TC-BRT-76: 붙여넣기가 페이지에 닿는다', async ({ page, request }) => {
    await waitForInit(page);
    await waitShellReady(page);
    await openTab(request, { url: site.url + '/', tool: await focusedTool(page), split: 'right', focus: true });
    await waitReport(site, 'width', () => true);
    await clickPage(page, 100, 40);
    await page.evaluate(() => {
      const v = [...(window as any).app.testing.brvViews.values()].find((x: any) => x.visible);
      const dt = new DataTransfer();
      dt.setData('text/plain', 'pasted-here');
      v.input.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    });
    await waitReport(site, 'value', (v) => v === 'pasted-here');
  });

  // TC-BRT-S3: 격리 world 가 보낸 문자열은 뷰어에서 마크업이 되지 않는다.
  test('TC-BRT-S3: 툴팁 문자열은 텍스트로만 그린다', async ({ page, request }) => {
    await waitForInit(page);
    await waitShellReady(page);
    await openTab(request, { url: site.url + '/tip', tool: await focusedTool(page), split: 'right', focus: true });
    await waitReport(site, 'width', () => true);
    await waitFrame(page);
    const box = await page.locator('.brv.vis .brv-canvas').boundingBox();
    await page.mouse.move(box!.x + 100, box!.y + 195);
    await page.mouse.move(box!.x + 110, box!.y + 200);
    const tip = page.locator('.brv.vis .brv-tip');
    await expect(tip).toHaveText('<img src=x onerror=alert(1)>', { timeout: 15000 });
    expect(await tip.locator('img').count()).toBe(0);
  });

  // TC-BRT-52: 프로그램이 연 URL 은 linkTarget=viewer 여도 브라우저 탭이다.
  test('TC-BRT-52: linkTarget=viewer 에서도 쉘의 open 은 브라우저 탭', async ({ page }) => {
    await waitForInit(page);
    await waitShellReady(page);
    await page.evaluate(() => { (window as any).browserLinkTarget = 'viewer' });
    try {
      await page.locator('#area .pn.focused .xterm-helper-textarea').focus();
      await page.keyboard.type(`open ${site.url}/other\n`);
      await expect.poll(() => paneTypes(page), { timeout: 20000 }).toEqual([['terminal'], ['browser']]);
    } finally {
      await page.evaluate(() => { (window as any).browserLinkTarget = 'internal' });
    }
  });

  // TC-BRT-32: Ctrl/⌘ 클릭으로 연 탭은 뒤에 열린다 — 보던 탭이 그대로 앞이다.
  test('TC-BRT-32: 수정키 클릭은 뒤 탭으로 연다', async ({ page, request }) => {
    await waitForInit(page);
    await waitShellReady(page);
    const tab = await openTab(request, { url: site.url + '/', tool: await focusedTool(page), split: 'right', focus: true });
    await waitReport(site, 'width', () => true);
    await waitFrame(page);
    const box = await page.locator('.brv.vis .brv-canvas').boundingBox();
    // 서버 OS 의 관례 — macOS 에서 Ctrl+클릭은 우클릭이다.
    const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
    await page.keyboard.down(mod);
    await page.mouse.click(box!.x + 100, box!.y + 120);
    await page.keyboard.up(mod);
    await expect.poll(() => paneTypes(page)).toEqual([['terminal'], ['browser', 'browser']]);
    const active = await page.evaluate((id: string) => {
      const a = (window as any).app;
      const walk = (n: any): any => n && (n.type === 'pane' ? (n.tabs.some((t: any) => t.id === id) ? n : null) : (n.children || []).map(walk).find(Boolean));
      return a.paneTab(walk(a.aw().layout));
    }, tab);
    expect(active).toBe(tab);
  });

  // TC-BRT-77·FR-BRT-84: F12 → DevTools 탭 — 대상 탭의 칸을 호출 칸으로 놓이고 이름이 "DevTools · <제목>".
  test('TC-BRT-77: F12 가 DevTools 탭을 연다', async ({ page, request }) => {
    await waitForInit(page);
    await waitShellReady(page);
    const tab = await openTab(request, { url: site.url + '/', tool: await focusedTool(page), split: 'right', focus: true });
    await waitReport(site, 'width', () => true);
    await clickPage(page, 300, 300);
    await page.keyboard.press('F12');
    await expect.poll(() => page.evaluate((id: string) => {
      const a = (window as any).app;
      let hit: any = null;
      const walk = (n: any) => { if (!n || hit) return; if (n.type === 'pane') hit = n.tabs.find((t: any) => t.devtoolsOf === id) || null; else (n.children || []).forEach(walk) };
      walk(a.aw().layout);
      return hit ? hit.name : '';
    }, tab), { timeout: 20000 }).toBe('DevTools · site');
    await expect.poll(() => paneTypes(page)).toEqual([['terminal'], ['browser'], ['browser']]);
  });

  // TC-BRT-41·FR-BRT-52: 탭 메뉴의 고정 크기 → 페이지 폭이 고정되고 탭 레코드에 남는다. 맞춤이 푼다.
  test('TC-BRT-41: 탭 메뉴의 고정 크기', async ({ page, request }) => {
    await waitForInit(page);
    await waitShellReady(page);
    const tab = await openTab(request, { url: site.url + '/', tool: await focusedTool(page), split: 'right', focus: true });
    await waitReport(site, 'width', () => true);
    await page.locator('.brv.vis .brv-bar button').last().click();
    await page.locator('.brv-menu [data-id="vp390x844"], .brv-menu .ui-menu-item:has-text("390")').first().click();
    await waitReport(site, 'rw', (v) => v === '390');
    await expect.poll(async () => (await brvRecord(page, tab))?.viewport).toEqual({ w: 390, h: 844 });
    await page.locator('.brv.vis .brv-bar button').last().click();
    await page.locator('.brv-menu .ui-menu-item:has-text("Fit"), .brv-menu .ui-menu-item:has-text("맞춤")').first().click();
    await expect.poll(async () => (await brvRecord(page, tab))?.viewport).toBeUndefined();
  });

  // TC-BRT-40: 다른 기기가 입력하면 그 기기가 창의 주인이 되고 페이지 크기가 그 기기를 따른다.
  test('TC-BRT-40: 창 주인이 바뀌면 뷰포트가 새 주인을 따른다', async ({ page, request, browser }) => {
    await waitForInit(page);
    await waitShellReady(page);
    const tab = await openTab(request, { url: site.url + '/', tool: await focusedTool(page), split: 'right', focus: true });
    await waitReport(site, 'width', () => true);
    await clickPage(page, 100, 40);
    const vpOf = (pg: any) => pg.evaluate(() => {
      const v = [...(window as any).app.testing.brvViews.values()].find((x: any) => x.visible);
      return v ? Number(String(v._lastVp || '').split('x')[0]) : 0;
    });
    const pageWidth = async () => {
      const r = await request.post('/api/browser/act', { data: { tab, op: 'eval', expr: 'innerWidth' }, headers: JSON_HDR });
      return (await r.json()).value;
    };
    await expect.poll(pageWidth).toBe(await vpOf(page));
    const ctx2 = await browser.newContext({ viewport: { width: 900, height: 700 } });
    const p2 = await ctx2.newPage();
    try {
      await p2.goto(page.url());
      await waitForInit(p2);
      await clickPage(p2, 60, 30);
      const w2 = await vpOf(p2);
      expect(w2).not.toBe(await vpOf(page));
      await expect.poll(pageWidth, { timeout: 20000 }).toBe(w2);
      await expect(page.locator('.brv.vis')).toHaveClass(/brv-dim/, { timeout: 15000 });
      await expect(p2.locator('.brv.vis')).not.toHaveClass(/brv-dim/);
    } finally {
      await ctx2.close();
    }
  });

});

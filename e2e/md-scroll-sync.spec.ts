import { test, expect } from '@playwright/test';
// @ts-ignore - node builtins, no @types/node installed
import * as fs from 'fs';
// @ts-ignore
import * as os from 'os';
// @ts-ignore
import * as path from 'path';

// SRS: MD_SCROLL_SYNC_SRS.md
//   FR-1/3: scroll → server 저장 → reload 시 복원
//   FR-4/5: PUT → SSE broadcast → 다른 컨텍스트에서 동기화

async function resetWorkspace(request) {
  const get = await request.get('/api/workspace');
  const rev = get.headers()['etag'] || '0';
  await request.put('/api/workspace', {
    headers: { 'If-Match': rev, 'Content-Type': 'application/json' },
    data: '{}',
  });
}

async function makeBigMd(prefix: string): Promise<string> {
  const fp = path.join(os.tmpdir(), `__mdscroll_${prefix}_${Date.now()}.md`);
  const lines: string[] = [];
  for (let i = 0; i < 400; i++) lines.push(`# Header ${i}\n\nSome paragraph text for line ${i} ${'lorem '.repeat(20)}\n`);
  fs.writeFileSync(fp, lines.join('\n'));
  return fp;
}

async function gotoFresh(page, request) {
  await resetWorkspace(request);
  await page.context().addInitScript(() => {
    sessionStorage.setItem('displayMode', 'desktop');
    try { localStorage.clear(); } catch {}
  });
  await page.goto('/');
  await page.waitForSelector('#area .rg.focused .xterm-helper-textarea', { timeout: 15000 });
}

async function openMdTab(page, fp: string): Promise<string> {
  await page.evaluate((fp_) => {
    const a = (window as any).app;
    a.addTab(a.focused, 'markdown', { name: fp_.split('/').pop(), filePath: fp_ });
  }, fp);
  await page.waitForTimeout(150);
  const tid = await page.evaluate(() => {
    const a = (window as any).app;
    const s = a.ws.sessions.find((x: any) => x.id === a.ws.activeSession);
    const walk = (n: any, out: any[]) => { if (!n) return; if (n.type === 'region') out.push(n); else if (n.children) n.children.forEach((c:any)=>walk(c,out)); };
    const regs: any[] = []; walk(s.layout, regs);
    for (const r of regs) {
      const t = r.tabs.find((x: any) => x.type === 'markdown');
      if (t) return t.id;
    }
    return null;
  });
  expect(tid).toBeTruthy();
  // wait for content to load (not the loading state)
  await page.waitForFunction((tabId) => {
    const a = (window as any).app;
    const v = a.mdViewers.get(tabId);
    return v && v._loaded;
  }, tid, { timeout: 10000 });
  return tid as string;
}

test.describe('MD scroll sync', () => {
  test('FR-1/3: scroll persisted and restored after reload', async ({ page, request }) => {
    await gotoFresh(page, request);
    const md = await makeBigMd('reload');
    const tid = await openMdTab(page, md);

    // Scroll to a known position.
    await page.evaluate((tabId) => {
      const a = (window as any).app;
      const v = a.mdViewers.get(tabId);
      v.el.scrollTop = 800;
      v.el.dispatchEvent(new Event('scroll'));
    }, tid);

    // Wait for debounce + PUT.
    await page.waitForResponse(
      (r) => r.url().endsWith('/api/md-scroll') && r.request().method() === 'PUT' && r.status() === 200,
      { timeout: 5000 }
    );

    // Reload — workspace持续, tabId 보존.
    await page.reload();
    await page.waitForFunction((tabId) => {
      const a = (window as any).app;
      const v = a && a.mdViewers && a.mdViewers.get(tabId);
      return v && v._loaded && v._restored;
    }, tid, { timeout: 10000 });

    const restored = await page.evaluate((tabId) => {
      const a = (window as any).app;
      return a.mdViewers.get(tabId).el.scrollTop;
    }, tid);
    expect(restored).toBeGreaterThan(0);
  });

  test('FR-4/5: scroll change broadcast to second browser context', async ({ browser, request }) => {
    await resetWorkspace(request);

    const ctxA = await browser.newContext();
    const pageA = await ctxA.newPage();
    await pageA.context().addInitScript(() => {
      sessionStorage.setItem('displayMode', 'desktop');
    });
    await pageA.goto('/');
    await pageA.waitForSelector('#area .rg.focused .xterm-helper-textarea', { timeout: 15000 });

    const md = await makeBigMd('sync');
    const tid = await openMdTab(pageA, md);

    // Wait for workspace persistence so pageB sees the md tab on load.
    await pageA.waitForResponse(
      (r) => r.url().endsWith('/api/workspace') && r.request().method() === 'PUT',
      { timeout: 5000 }
    ).catch(()=>{});
    await pageA.waitForTimeout(200);

    // Open same workspace in context B.
    const ctxB = await browser.newContext();
    const pageB = await ctxB.newPage();
    await pageB.context().addInitScript(() => {
      sessionStorage.setItem('displayMode', 'desktop');
    });
    await pageB.goto('/');
    await pageB.waitForFunction((tabId) => {
      const a = (window as any).app;
      const v = a && a.mdViewers && a.mdViewers.get(tabId);
      return v && v._loaded;
    }, tid, { timeout: 10000 });

    // A scrolls.
    await pageA.evaluate((tabId) => {
      const a = (window as any).app;
      const v = a.mdViewers.get(tabId);
      v.el.scrollTop = 1200;
      v.el.dispatchEvent(new Event('scroll'));
    }, tid);
    await pageA.waitForResponse(
      (r) => r.url().endsWith('/api/md-scroll') && r.request().method() === 'PUT' && r.status() === 200,
      { timeout: 5000 }
    );

    // B should receive SSE and apply scroll.
    await pageB.waitForFunction((tabId) => {
      const a = (window as any).app;
      const v = a.mdViewers.get(tabId);
      return v && v.el.scrollTop > 100;
    }, tid, { timeout: 5000 });

    await ctxA.close();
    await ctxB.close();
  });
});

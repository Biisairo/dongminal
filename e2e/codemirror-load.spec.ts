import { test, expect, waitForInit } from './fixtures';

// CODEMIRROR_MIGRATION_SRS 묶음 V (M1) — 벤더 묶음을 앱 안에서 읽을 수 있는가.

const ENTRY = '**/vendor/codemirror/cm.js';

test.describe('CodeMirror 벤더 묶음 (M1)', () => {
  test('FR-CMR-6: loadCodeMirror 가 전역 CM 을 세우고 편집기가 선다', async ({ page }) => {
    await waitForInit(page);
    const doc = await page.evaluate(async () => {
      await (window as any).loadCodeMirror();
      const CM = (window as any).CM;
      const host = document.createElement('div');
      document.body.appendChild(host);
      const view = new CM.EditorView({ doc: 'a', parent: host });
      view.dispatch({ changes: { from: 1, insert: 'bc' } });
      const text = view.state.doc.toString();
      view.destroy();
      host.remove();
      return text;
    });
    expect(doc).toBe('abc');
  });

  test('FR-CMR-3: 언어 청크는 쓸 때 받고 gzip 그대로 온다', async ({ page }) => {
    await waitForInit(page);
    await page.evaluate(() => (window as any).loadCodeMirror());
    const got: { url: string; enc: string; type: string }[] = [];
    page.on('response', (r) => {
      if (r.url().includes('/vendor/codemirror/')) {
        got.push({ url: r.url(), enc: r.headers()['content-encoding'] || '', type: r.headers()['content-type'] || '' });
      }
    });
    const ok = await page.evaluate(async () => {
      const CM = (window as any).CM;
      const desc = CM.LanguageDescription.matchFilename(CM.languages, 'main.go');
      const support = await desc.load();
      return !!support && !!support.language;
    });
    expect(ok).toBe(true);
    expect(got.length).toBeGreaterThan(0);
    for (const r of got) {
      expect(r.enc).toBe('gzip');
      expect(r.type).toContain('javascript');
    }
  });

  test('loadCodeMirror 는 실패를 기억하지 않는다', async ({ page }) => {
    await waitForInit(page);
    await page.route(ENTRY, (r) => r.abort());
    const first = await page.evaluate(() => (window as any).loadCodeMirror().then(() => 'ok', () => 'fail'));
    expect(first).toBe('fail');
    await page.unroute(ENTRY);
    // 같은 URL 의 실패한 모듈은 브라우저가 기억하므로 로더는 다시 받을 길을 가져야 한다.
    const second = await page.evaluate(() => (window as any).loadCodeMirror().then(() => 'ok', (e: Error) => 'fail:' + e.message));
    expect(second).toBe('ok');
  });
});

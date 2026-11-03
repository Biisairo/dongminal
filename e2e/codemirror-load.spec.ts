import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';

import { test, expect, waitForInit, addEditorRoot, switchToEditorRoot, rmTree } from './fixtures';
import { tmpPath, realPath } from './osenv';

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

// NFR-CMR-3 — 10,000줄 TypeScript 를 열어 첫 화면이 그려지기까지 300ms 이하 (언어 청크가 캐시된 상태, 로컬 Chromium).
// 재는 구간: `edOpenFile` 부터 그 칸이 첫 줄을 그리고 언어가 붙은 뒤의 다음 프레임까지. 파일 읽기 요청도 든다.
const NFR3_ROOT = tmpPath('dm-cm-nfr3-' + process.pid);
const NFR3_LINES = 10_000;
const NFR3_MAX_MS = 300;

test.describe('NFR-CMR-3 열기', () => {
  test.beforeAll(() => {
    mkdirSync(NFR3_ROOT, { recursive: true });
    const body = (tag: string) => Array.from({ length: NFR3_LINES },
      (_, i) => `export function ${tag}${i}(x: number): number { return x * ${i} + ${i % 7}; }`).join('\n') + '\n';
    writeFileSync(join(NFR3_ROOT, 'warm.ts'), body('w'));
    writeFileSync(join(NFR3_ROOT, 'big.ts'), body('f'));
  });
  test.afterAll(() => { rmTree(NFR3_ROOT) });

  test('NFR-CMR-3: 10,000줄 TypeScript 가 300ms 안에 첫 화면을 그린다', async ({ page, request }) => {
    const root = realPath(NFR3_ROOT);
    const key = await addEditorRoot(request, root);
    await page.goto('/');
    await waitForInit(page);
    await switchToEditorRoot(page, key);

    // 같은 언어의 다른 파일을 먼저 열어 언어 청크를 캐시한다.
    const open = (f: string) => page.evaluate(async (path) => {
      const app = (window as any).app;
      const t0 = performance.now();
      app.testing.edOpenFile(path);
      const name = path.split(/[\\/]/).pop();
      for (;;) {
        await new Promise((r) => requestAnimationFrame(r));
        const v = app.testing.edActiveEditor();
        const h = v && edT.of(v);
        if (!h || !String(v.filePath).endsWith(name)) continue;
        if (!edT.language(h)) continue;
        const first = edT.dom(h).querySelector(edT.sel.text + ' .cm-line');
        if (first && first.textContent && first.textContent.includes('(x: number)')) break;
      }
      await new Promise((r) => requestAnimationFrame(r));
      return performance.now() - t0;
    }, f);
    await open(join(root, 'warm.ts'));
    const ms = await open(join(root, 'big.ts'));
    test.info().annotations.push({ type: 'NFR-CMR-3 ms', description: ms.toFixed(1) });
    // NFR-CMR-3 의 기준은 **로컬 Chromium** 이다 (§3.17). CI 러너는 같은 구간이 두세 배 걸려(windows 696~851ms)
    // 상한을 판정하지 않고 값만 남긴다 — 회귀는 값의 추이로 본다.
    if (!process.env.CI) expect(ms, `첫 화면까지 ${ms.toFixed(1)}ms`).toBeLessThanOrEqual(NFR3_MAX_MS);
  });
});

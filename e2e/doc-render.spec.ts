/**
 * DOC_RENDER_VIEW_SRS §4 — M1~M5 의 검증.
 *
 * 재려는 것은 접수한 말 그대로다: **"image 만 이미지로 보이고 다른건 다 텍스트로
 * 보인다."** 그러므로 이 스펙의 본문은 "버튼을 누르면 옆 칸에 결과가 뜬다" 이며,
 * 나머지는 그 결과가 **안전한가**(FR-DRV-20)와 **살아 있는가**(FR-DRV-40)를 잰다.
 */
import * as fs from 'fs';
import * as path from 'path';

import { APIRequestContext, Page } from '@playwright/test';

import { test, expect, rmTree, switchToEditorRoot, openExplorerSide } from './fixtures';
import { TMP, realPath } from './osenv';

const j = (...p: string[]) => path.join(...p);
let BASE = '';
let ROOT = '';

// 본문 하나가 여러 요구를 동시에 잰다 — 코드 블록(FR-DRV-13b) · 인라인 HTML 의
// 정화(FR-DRV-20) · 원격 이미지(FR-DRV-27) · 상대 이미지(FR-DRV-25).
const DOC = [
  '# 제목 하나',
  '',
  '본문 **굵게** 그리고 `인라인`.',
  '',
  '```go',
  'func main() { println("hi") }',
  '```',
  '',
  '<script>window.__pwned=1</script>',
  '',
  '<img src="x" onerror="window.__pwned=2">',
  '',
  '[링크](javascript:window.__pwned=3)',
  '',
  '![배지](https://example.invalid/badge.svg)',
  '',
  '![그림](./pic.png)',
  '',
].join('\n');

test.beforeAll(() => {
  BASE = realPath(fs.mkdtempSync(j(TMP, 'dm-drv-')));
  ROOT = j(BASE, 'root');
  fs.mkdirSync(ROOT, { recursive: true });
  fs.writeFileSync(j(ROOT, 'doc.md'), DOC);
  // FR-DRV-2: 렌더 대상이 아닌 파일 — 버튼이 서면 안 된다.
  fs.writeFileSync(j(ROOT, 'plain.txt'), 'just text\n');
  // M3 — SVG. 스크립트를 심어 둔다: `<img>` 로 그리므로 돌지 않아야 한다 (FR-DRV-23).
  fs.writeFileSync(j(ROOT, 'icon.svg'),
    '<?xml version="1.0"?>\n' +
    '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="10">' +
    '<script>window.__svgPwned=1</script><rect width="20" height="10"/></svg>\n');
  // FR-DRV-24 ①: 이름만 `.svg` 인 HTML — 종단이 거절해야 한다.
  fs.writeFileSync(j(ROOT, 'evil.svg'), '<html><body><script>1</script></body></html>\n');
  // M4 — HTML. sandbox 이므로 이 스크립트는 부모에 닿지 못한다.
  fs.writeFileSync(j(ROOT, 'page.html'),
    '<html><body><h1 id="ttl">문서 제목</h1>' +
    '<script>parent.__htmlPwned=1</script></body></html>\n');
  // M4 — 표. 따옴표 안의 쉼표와 줄바꿈이 지켜져야 한다 (FR-DRV-16).
  fs.writeFileSync(j(ROOT, 'data.csv'),
    'name,note\nalpha,"쉼표, 포함"\nbeta,"줄\n바꿈"\n');
  fs.writeFileSync(j(ROOT, 'pic.png'), Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
    'base64'));
  // 루트 상대(`/`) 참조와 루트 밖 링크. 둘 다 조용히 어긋나기 쉬운 자리다.
  fs.mkdirSync(j(ROOT, 'img'), { recursive: true });
  fs.copyFileSync(j(ROOT, 'pic.png'), j(ROOT, 'img', 'root.png'));
  fs.mkdirSync(j(ROOT, 'sub'), { recursive: true });
  fs.writeFileSync(j(ROOT, 'sub', 'deep.md'),
    '# 깊은 문서\n\n![루트기준](/img/root.png)\n\n[밖으로](../../etc/hosts)\n');
  // M5 — 링크 셋: 상대 · 외부 · 앵커.
  fs.writeFileSync(j(ROOT, 'links.md'),
    '# 위\n\n[다른 문서](./doc.md)\n\n[바깥](https://example.invalid/x)\n\n' +
    '[아래로](#아래)\n\n' + Array.from({ length: 80 }, (_, i) => 'pad ' + i).join('\n\n') +
    '\n\n## 아래\n\n끝\n');
  ROOT = realPath(ROOT);
});
test.afterAll(() => {
  rmTree(BASE);
});

async function enter(page: Page, request: APIRequestContext) {
  const r = await request.post('/api/editors/add', { data: { path: ROOT } });
  expect(r.ok(), `editors/add 실패: ${await r.text()}`).toBeTruthy();
  await page.context().addInitScript(() => { sessionStorage.setItem('displayMode', 'desktop') });
  await page.goto('/');
  await page.waitForSelector('#area .pn.focused .xterm-helper-textarea', { timeout: 15000 });
  await page.waitForFunction(
    () => !!(window as any).app?._editors && (window as any).app._edWindows().length > 0,
    undefined, { timeout: 15000 });
  await switchToEditorRoot(page, ROOT);
  await openExplorerSide(page);
  await expect(page.locator('.ed-tree .ed-row').first()).toBeVisible({ timeout: 10000 });
}

// 파일을 열고 그 탭의 Monaco 가 실제로 설 때까지 기다린다. 편집기는 탭마다 하나가
// DOM 에 남으므로 **보이는 것**을 센다.
async function openFile(page: Page, name: string) {
  await page.locator('.ed-tree .ed-row', { hasText: name }).first().click();
  await expect(page.locator('.pn-body .file-editor.vis .monaco-editor').first())
    .toBeVisible({ timeout: 20000 });
}

const RENDER_BTN = '.file-editor.vis .fe-render';
const RENDER_BODY = '.doc-render.vis .dr-body';

test.describe('문서 렌더 뷰', () => {
  test.beforeEach(async ({ page, request }) => { await enter(page, request) });

  // V-DRV-1
  test('렌더 대상이 아닌 파일에는 버튼이 서지 않는다', async ({ page }) => {
    await openFile(page, 'plain.txt');
    await expect(page.locator(RENDER_BTN)).toHaveCount(0);
    await openFile(page, 'doc.md');
    await expect(page.locator(RENDER_BTN)).toHaveCount(1);
  });

  // V-DRV-2 · V-DRV-3
  test('버튼이 옆 칸에 렌더 탭을 열고, 소스 탭과 함께 산다', async ({ page }) => {
    await openFile(page, 'doc.md');
    await expect(page.locator('#area .pn')).toHaveCount(1);
    await page.locator(RENDER_BTN).click();
    // 형제 칸이 없었으므로 나뉜다 (FR-DRV-8).
    await expect(page.locator('#area .pn')).toHaveCount(2);
    await expect(page.locator(RENDER_BODY)).toBeVisible({ timeout: 15000 });
    // 소스도 여전히 보인다 — 대체가 아니라 나란히다.
    await expect(page.locator('.file-editor.vis .monaco-editor').first()).toBeVisible();
    const kinds = await page.evaluate(() => {
      const a = (window as any).app;
      const out: any[] = [];
      for (const pn of a._flattenPanes(a._aw().layout))
        for (const t of pn.tabs || []) out.push({ type: t.type, render: !!t.render });
      return out;
    });
    expect(kinds).toHaveLength(2);
    expect(kinds.filter(k => k.render)).toHaveLength(1);
    // FR-DRV-9: 새 탭 타입을 만들지 않았다.
    expect(kinds.every(k => k.type === 'editor')).toBeTruthy();
  });

  // V-DRV-4
  test('탐색기에서 다시 열면 소스가 뜬다 — 렌더 탭이 가로채지 않는다', async ({ page }) => {
    await openFile(page, 'doc.md');
    await page.locator(RENDER_BTN).click();
    await expect(page.locator(RENDER_BODY)).toBeVisible({ timeout: 15000 });
    await page.locator('.ed-tree .ed-row', { hasText: 'doc.md' }).first().click();
    const active = await page.evaluate(() => {
      const a = (window as any).app;
      const pn = a._flattenPanes(a._aw().layout).find((p: any) => p.id === a.focused);
      const t = (pn.tabs || []).find((x: any) => x.id === a.paneTab(pn, 0));
      return { render: !!t.render, path: t.filePath };
    });
    expect(active.render).toBeFalsy();
    expect(active.path.endsWith('doc.md')).toBeTruthy();
  });

  // V-DRV-5 (FR-DRV-40): 저장하지 않은 편집이 보인다
  test('저장하지 않은 편집이 렌더에 보인다', async ({ page }) => {
    await openFile(page, 'doc.md');
    await page.locator(RENDER_BTN).click();
    await expect(page.locator(RENDER_BODY)).toBeVisible({ timeout: 15000 });
    await page.evaluate(() => {
      const a = (window as any).app;
      const v = [...a.fileEditors.values()].find((x: any) => x._editor);
      v._editor.setValue('# 방금 쓴 제목\n');
    });
    await expect(page.locator(RENDER_BODY + ' h1')).toHaveText('방금 쓴 제목', { timeout: 15000 });
  });

  // V-DRV-6b · V-DRV-7 · V-DRV-7b
  test('코드는 색칠되고, 스크립트는 남지 않으며, 원격 이미지는 그려진다', async ({ page }) => {
    await openFile(page, 'doc.md');
    await page.locator(RENDER_BTN).click();
    await expect(page.locator(RENDER_BODY)).toBeVisible({ timeout: 15000 });

    // FR-DRV-13b: 코드 블록이 색칠된다 — 토큰 span 이 실제로 선다.
    await expect(page.locator(RENDER_BODY + ' pre code .hljs-keyword').first())
      .toBeVisible({ timeout: 15000 });

    // FR-DRV-20: 스크립트도 이벤트 핸들러도 javascript: 도 남지 않는다.
    await expect(page.locator(RENDER_BODY + ' script')).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).__pwned)).toBeUndefined();
    const onerr = await page.locator(RENDER_BODY + ' img[onerror]').count();
    expect(onerr).toBe(0);
    const jsHref = await page.locator(RENDER_BODY + ' a[href^="javascript:"]').count();
    expect(jsHref).toBe(0);

    // FR-DRV-27: 원격 이미지는 **그린다** (I-4).
    await expect(page.locator(RENDER_BODY + ' img[src^="https://example.invalid"]'))
      .toHaveCount(1);
    // FR-DRV-25: 상대 이미지는 우리 종단으로 바뀐다.
    //
    // **대상을 좁혀 센다.** 위의 `<img src="x" onerror=…>` 도 상대 경로이므로 같은
    // 규칙으로 바뀌며(정화는 `onerror` 만 걷고 태그는 남긴다 — `img` 자체는 위험한
    // 것이 아니다), 셋을 뭉뚱그려 세면 이 단정이 무엇을 재는지 흐려진다.
    await expect(page.locator(RENDER_BODY + ' img[src*="/api/file/raw"][src*="pic.png"]'))
      .toHaveCount(1);
  });

  // FR-DRV-6: 같은 버튼이 소스로 되돌린다
  test('렌더 탭의 같은 버튼이 소스 탭으로 되돌린다', async ({ page }) => {
    await openFile(page, 'doc.md');
    await page.locator(RENDER_BTN).click();
    await expect(page.locator(RENDER_BODY)).toBeVisible({ timeout: 15000 });
    await page.locator('.doc-render.vis .dr-source').click();
    const active = await page.evaluate(() => {
      const a = (window as any).app;
      const pn = a._flattenPanes(a._aw().layout).find((p: any) => p.id === a.focused);
      const t = (pn.tabs || []).find((x: any) => x.id === a.paneTab(pn, 0));
      return !!t.render;
    });
    expect(active).toBeFalsy();
  });

  // V-DRV-15
  test('소스 탭을 닫아도 렌더 탭은 산다', async ({ page }) => {
    await openFile(page, 'doc.md');
    await page.locator(RENDER_BTN).click();
    await expect(page.locator(RENDER_BODY)).toBeVisible({ timeout: 15000 });
    await page.evaluate(() => {
      const a = (window as any).app;
      for (const pn of a._flattenPanes(a._aw().layout)) {
        const t = (pn.tabs || []).find((x: any) => !x.render);
        if (t) { a.closeTab(pn.id, t.id); return }
      }
    });
    await expect(page.locator(RENDER_BODY + ' h1')).toHaveText('제목 하나', { timeout: 15000 });
  });

  // V-DRV-14
  test('새로고침 뒤 렌더 탭이 되살아난다', async ({ page }) => {
    await openFile(page, 'doc.md');
    await page.locator(RENDER_BTN).click();
    await expect(page.locator(RENDER_BODY)).toBeVisible({ timeout: 15000 });
    await page.waitForTimeout(700);   // 워크스페이스 저장이 나가도록
    await page.reload();
    await expect(page.locator(RENDER_BODY + ' h1')).toHaveText('제목 하나', { timeout: 25000 });
  });

  // ── M3: SVG ──

  // V-DRV-9 (FR-DRV-23): 스크립트가 든 SVG 를 그려도 실행되지 않는다.
  test('SVG 가 그림으로 그려지고 그 안의 스크립트는 돌지 않는다', async ({ page }) => {
    await openFile(page, 'icon.svg');
    await expect(page.locator(RENDER_BTN)).toHaveCount(1);
    await page.locator(RENDER_BTN).click();
    const img = page.locator('.doc-render.vis .dr-svg');
    await expect(img).toBeVisible({ timeout: 15000 });
    // 크기가 붙었다는 것은 브라우저가 실제로 디코드했다는 뜻이다.
    await expect(page.locator('.doc-render.vis .dr-svg-meta'))
      .toContainText('20×10', { timeout: 15000 });
    expect(await page.evaluate(() => (window as any).__svgPwned)).toBeUndefined();
    // FR-DRV-40: 바이트가 아니라 **문서**에서 왔다 — 그래서 blob 이다.
    expect((await img.getAttribute('src'))?.startsWith('blob:')).toBeTruthy();
  });

  test('SVG 도 저장하지 않은 편집을 따라온다', async ({ page }) => {
    await openFile(page, 'icon.svg');
    await page.locator(RENDER_BTN).click();
    await expect(page.locator('.doc-render.vis .dr-svg-meta'))
      .toContainText('20×10', { timeout: 15000 });
    await page.evaluate(() => {
      const a = (window as any).app;
      const v = [...a.fileEditors.values()].find((x: any) => x._editor);
      v._editor.setValue('<svg xmlns="http://www.w3.org/2000/svg" width="7" height="3"></svg>');
    });
    await expect(page.locator('.doc-render.vis .dr-svg-meta'))
      .toContainText('7×3', { timeout: 15000 });
  });

  // V-DRV-10 · V-DRV-11: 종단의 잠금장치. 브라우저를 거치지 않고 직접 잰다.
  test('raw 는 SVG 를 sandbox 로 내보내고, 이름만 SVG 인 HTML 은 거절한다', async ({ request }) => {
    const ok = await request.get('/api/file/raw?path=' + encodeURIComponent(j(ROOT, 'icon.svg')));
    expect(ok.status()).toBe(200);
    const h = ok.headers();
    expect(h['content-type']).toBe('image/svg+xml');
    expect(h['x-content-type-options']).toBe('nosniff');
    // 이 헤더가 없으면 사용자가 이 URL 을 직접 열었을 때 문서의 스크립트가
    // **우리 출처에서** 돈다 (FR-DRV-24 ③).
    expect(h['content-security-policy']).toBe('sandbox');

    const bad = await request.get('/api/file/raw?path=' + encodeURIComponent(j(ROOT, 'evil.svg')));
    expect(bad.status()).toBe(415);
  });

  // ── M4: HTML · 표 ──

  // V-DRV-8 (FR-DRV-22): sandbox 이므로 스크립트가 돌지 않고, 그 사실이 적힌다.
  test('HTML 은 sandbox 로 그려지고 스크립트가 돌지 않는다', async ({ page }) => {
    await openFile(page, 'page.html');
    await page.locator(RENDER_BTN).click();
    const fr = page.locator('.doc-render.vis iframe.dr-html');
    await expect(fr).toBeVisible({ timeout: 15000 });
    // **빈 값이어야 한다** — 값을 하나라도 적으면 그것이 곧 허용이다.
    expect(await fr.getAttribute('sandbox')).toBe('');
    await expect(fr.contentFrame().locator('#ttl')).toHaveText('문서 제목', { timeout: 15000 });
    expect(await page.evaluate(() => (window as any).__htmlPwned)).toBeUndefined();
    // 그 사실이 화면에 적혀 있다 — 침묵하면 빈 화면이 우리 버그로 읽힌다.
    await expect(page.locator('.doc-render.vis .dr-html-note')).toBeVisible();
  });

  // FR-DRV-16: 따옴표 안의 구분자와 줄바꿈을 지킨다.
  test('CSV 가 표로 그려지고 따옴표 안의 쉼표·줄바꿈이 지켜진다', async ({ page }) => {
    await openFile(page, 'data.csv');
    await page.locator(RENDER_BTN).click();
    const table = page.locator('.doc-render.vis table.dr-table');
    await expect(table).toBeVisible({ timeout: 15000 });
    await expect(table.locator('th')).toHaveCount(2);
    await expect(table.locator('tr')).toHaveCount(3);
    await expect(table.locator('tr').nth(1).locator('td').nth(1)).toHaveText('쉼표, 포함');
    await expect(table.locator('tr').nth(2).locator('td').nth(1)).toHaveText('줄\n바꿈');
  });

  // ── M5: 링크 ──

  // V-DRV-13 (FR-DRV-28): 상대 링크는 그 파일을 탭으로 연다.
  test('상대 링크를 누르면 그 문서가 탭으로 열린다', async ({ page }) => {
    await openFile(page, 'links.md');
    await page.locator(RENDER_BTN).click();
    await expect(page.locator(RENDER_BODY + ' h1')).toHaveText('위', { timeout: 15000 });
    await page.locator(RENDER_BODY + ' a', { hasText: '다른 문서' }).click();
    await expect.poll(async () => page.evaluate(() => {
      const a = (window as any).app;
      const out: string[] = [];
      for (const w of a.ws.windows)
        for (const pn of (w.layout ? a._flattenPanes(w.layout) : []))
          for (const t of pn.tabs || []) if (t.filePath && !t.render) out.push(t.filePath);
      return out.some((p: string) => p.endsWith('doc.md'));
    }), { timeout: 15000 }).toBeTruthy();
  });

  // FR-DRV-28: 외부 링크는 새 창으로 나가며 rel 을 단다.
  test('외부 링크에 noopener 가 붙는다', async ({ page }) => {
    await openFile(page, 'links.md');
    await page.locator(RENDER_BTN).click();
    const ext = page.locator(RENDER_BODY + ' a[href^="https://"]').first();
    await expect(ext).toBeVisible({ timeout: 15000 });
    expect(await ext.getAttribute('target')).toBe('_blank');
    expect((await ext.getAttribute('rel'))?.includes('noopener')).toBeTruthy();
  });

  // FR-DRV-28: 앵커는 렌더 뷰 안에서 움직인다 — 다른 문서를 열지 않는다.
  test('앵커 링크는 그 자리에서 스크롤한다', async ({ page }) => {
    await openFile(page, 'links.md');
    await page.locator(RENDER_BTN).click();
    await expect(page.locator(RENDER_BODY + ' h1')).toHaveText('위', { timeout: 15000 });
    await page.locator(RENDER_BODY + ' a', { hasText: '아래로' }).click();
    await expect.poll(async () =>
      page.locator(RENDER_BODY).evaluate((el) => el.scrollTop),
      { timeout: 15000 }).toBeGreaterThan(0);
  });

  // FR-DRV-44: 소스를 스크롤하면 렌더가 그 자리를 따라간다.
  test('소스를 스크롤하면 렌더가 따라간다', async ({ page }) => {
    await openFile(page, 'links.md');
    await page.locator(RENDER_BTN).click();
    await expect(page.locator(RENDER_BODY + ' h1')).toHaveText('위', { timeout: 15000 });
    expect(await page.locator(RENDER_BODY).evaluate((el) => el.scrollTop)).toBe(0);
    // 소스를 아래로 옮긴다 — 렌더가 그 줄의 블록으로 따라와야 한다.
    await page.evaluate(() => {
      const a = (window as any).app;
      const v = [...a.fileEditors.values()].find((x: any) => x._editor);
      v._editor.revealLineNearTop(70);
    });
    await expect.poll(async () =>
      page.locator(RENDER_BODY).evaluate((el) => el.scrollTop),
      { timeout: 15000 }).toBeGreaterThan(0);
  });

  // FR-DRV-25: `/` 로 시작하는 참조는 **문서의 디렉터리가 아니라 창의 루트**를
  // 기준으로 푼다. 디렉터리를 기준으로 삼으면 조용히 한 칸 어긋난다.
  test('루트 상대 이미지가 창의 루트를 기준으로 풀린다', async ({ page }) => {
    await page.locator('.ed-tree .ed-row', { hasText: 'sub' }).first().click();
    await openFile(page, 'deep.md');
    await page.locator(RENDER_BTN).click();
    const img = page.locator(RENDER_BODY + ' img').first();
    await expect(img).toBeVisible({ timeout: 15000 });
    const src = await img.getAttribute('src') || '';
    const got = decodeURIComponent(src.split('path=')[1] || '');
    // 서버가 푼 경로는 그 OS 의 구분자를 쓴다 (FR-CEM-11).
    expect(got).toBe(j(ROOT, 'img', 'root.png'));
    // 실제로 받아지는가 — 경로가 맞아야 200 이다.
    await expect.poll(async () =>
      img.evaluate((el: any) => el.naturalWidth), { timeout: 15000 }).toBeGreaterThan(0);
  });

  // FR-DRV-26: 루트 밖으로는 가지 않고, **막았다는 사실을 말한다.**
  test('루트 밖 링크는 열지 않고 사유를 보인다', async ({ page }) => {
    await page.locator('.ed-tree .ed-row', { hasText: 'sub' }).first().click();
    await openFile(page, 'deep.md');
    await page.locator(RENDER_BTN).click();
    await expect(page.locator(RENDER_BODY + ' h1')).toHaveText('깊은 문서', { timeout: 15000 });
    await page.locator(RENDER_BODY + ' a', { hasText: '밖으로' }).click();
    await expect(page.locator('.doc-render.vis .dr-note')).toBeVisible({ timeout: 10000 });
    const outside = await page.evaluate(() => {
      const a = (window as any).app;
      const out: string[] = [];
      for (const w of a.ws.windows)
        for (const pn of (w.layout ? a._flattenPanes(w.layout) : []))
          for (const t of pn.tabs || []) if (t.filePath) out.push(t.filePath);
      return out.some((p: string) => p.includes('/etc/'));
    });
    expect(outside).toBeFalsy();
  });

  /**
   * 브라우저를 띄우되 **화면을 거치지 않고 계산만 잰다.**
   *
   * 경로 해석과 구분자 파싱은 조용히 어긋나는 자리다 — 한 칸 잘못 푼 경로는
   * 깨진 이미지로만 보이고, 잘못 나뉜 표는 **그럴듯하게** 보인다. 그런 것은
   * 화면 단정으로 잡기 어려우므로 함수를 직접 부른다.
   */
  test('경로 해석과 표 파싱의 규칙', async ({ page }) => {
    const out = await page.evaluate(() => {
      const w = window as any;
      return {
        sameDir: w.docResolvePath('/r/docs', './a.png', '/r'),
        up: w.docResolvePath('/r/docs', '../img/a.png', '/r'),
        rootRel: w.docResolvePath('/r/docs', '/img/a.png', '/r'),
        noRoot: w.docResolvePath('/r/docs', '/img/a.png', ''),
        inside: w.docInsideRoot('/r/a.png', '/r'),
        outside: w.docInsideRoot('/etc/hosts', '/r'),
        prefixOnly: w.docInsideRoot('/rogue/a', '/r'),
        csv: w.docParseDelimited('a,"쉼표, 포함"\n', ','),
        nl: w.docParseDelimited('a,"줄\n바꿈"\n', ','),
        quoted: w.docParseDelimited('a,"큰""따옴"\n', ','),
        tsv: w.docParseDelimited('a\tb\n', '\t'),
        blankTail: w.docParseDelimited('a,b\n\n', ','),
        slug: w.docSlug('제목 하나'),
        kindUpper: w.docRenderKindOf('/a/b.SVG'),
      };
    });
    expect(out.sameDir).toBe('/r/docs/a.png');
    expect(out.up).toBe('/r/img/a.png');
    // `/` 로 시작하면 **창의 루트**가 기준이다 — 문서의 디렉터리가 아니다.
    expect(out.rootRel).toBe('/r/img/a.png');
    // 루트를 모르면 그 표기를 그대로 절대경로로 받는다. 디렉터리 뒤에 붙이면
    // 같은 이름의 엉뚱한 파일을 열 수 있고, 그 어긋남은 조용하다.
    expect(out.noRoot).toBe('/img/a.png');
    expect(out.inside).toBe(true);
    expect(out.outside).toBe(false);
    // 접두만 같은 다른 폴더는 밖이다 — `/r` 로 시작한다고 `/rogue` 가 안이 아니다.
    expect(out.prefixOnly).toBe(false);
    expect(out.csv).toEqual([['a', '쉼표, 포함']]);
    expect(out.nl).toEqual([['a', '줄\n바꿈']]);
    expect(out.quoted).toEqual([['a', '큰"따옴']]);
    expect(out.tsv).toEqual([['a', 'b']]);
    // 파일 끝의 빈 줄은 데이터가 아니라 여백이다.
    expect(out.blankTail).toEqual([['a', 'b']]);
    expect(out.slug).toBe('제목-하나');
    expect(out.kindUpper).toBe('svg');
  });

  // V-DRV-16 (FR-DRV-35): 렌더 탭은 dirty 가 되지 않는다
  test('렌더 탭은 저장할 것이 없다', async ({ page }) => {
    await openFile(page, 'doc.md');
    await page.locator(RENDER_BTN).click();
    await expect(page.locator(RENDER_BODY)).toBeVisible({ timeout: 15000 });
    const dirty = await page.evaluate(() => {
      const a = (window as any).app;
      return [...a.fileEditors.values()].some((v: any) => v._dirty && !v._editor);
    });
    expect(dirty).toBeFalsy();
  });
});

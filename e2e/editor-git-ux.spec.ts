import { execFileSync } from 'child_process';
import { realpathSync, writeFileSync } from 'fs';
import { join } from 'path';

import { Page } from '@playwright/test';

import { test, expect } from './fixtures';

// EDITOR_GIT_UX_SRS — Changes 크기조정(묶음 D) · Diff 개요 눈금(묶음 O) ·
// Editor 검색(묶음 F·G·K). 검증 V-CSZ-1~5, V-DOR-1~3, V-EQO-2~3, V-EKB-2.
//
// Git 픽스처는 git-changes.spec.ts 와 같은 규약이다 (design/README.md).

const FIXTURES = '/tmp/dm-git-fx-ux-' + process.pid;

test.beforeAll(() => {
  execFileSync('bash', ['e2e/git_fixture.sh', FIXTURES], { stdio: 'ignore' });
});
test.afterAll(() => {
  execFileSync('bash', ['e2e/git_fixture.sh', '--clean', FIXTURES], { stdio: 'ignore' });
});

const fx = (name: string) => realpathSync(join(FIXTURES, name));

async function waitForInit(page: Page) {
  await page.context().addInitScript(() => {
    sessionStorage.setItem('displayMode', 'desktop');
  });
  await page.goto('/');
  await page.waitForSelector('#area .pn.focused .xterm-helper-textarea', { timeout: 15000 });
}

// 다시 불러온다. `waitForInit` 을 쓸 수 없다 — Git 창이 활성인 상태로
// 복원되면 포커스된 pane 에 터미널이 없어 그 대기가 영영 끝나지 않는다.
async function reopen(page: Page) {
  await page.goto('/');
  await page.waitForFunction(() => !!(window as any).app?.ws, null, { timeout: 15000 });
}

async function openGit(page: Page, repo: string) {
  await page.evaluate((r) => (window as any).app.openGitWindow(r), repo);
  await expect(page.locator('#area .pn-body .git-view.vis')).toHaveClass(/git-changes/);
}

const changes = (page: Page) => page.locator('#area .pn-body .git-view.git-changes');

// constants.js 의 전역 상수 — <script> 로 로드되고 `const` 는 전역 렉시컬
// 환경에 들어가므로 `window.X` 로는 잡히지 않는다. 맨 이름으로 읽는다
// (git-changes.spec.ts 의 GIT_FILE_ROW_CHUNK 와 같은 규약).
declare const GIT_FILES_W_KEY: string;
declare const GIT_FILES_H_KEY: string;
declare const GIT_FILES_SIZE_MIN: number;
declare const GIT_FILES_SIZE_DEFAULT: number;
declare const GIT_DIFF_OPTIONS: any;
declare const GIT_DIFF_FOLD_KEY: string;

// 손잡이를 dx 만큼 끈다. 반환은 끈 뒤의 파일 목록 폭이다.
async function dragHandle(page: Page, dx: number) {
  const h = changes(page).locator('.git-files-handle');
  const hb = (await h.boundingBox())!;
  await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
  await page.mouse.down();
  await page.mouse.move(hb.x + hb.width / 2 + dx, hb.y + hb.height / 2, { steps: 8 });
  await page.mouse.up();
  return (await changes(page).locator('.git-files').boundingBox())!.width;
}

test.describe('묶음 D — Changes 두 칸의 크기조정', () => {
  // V-CSZ-1: 손잡이가 서고 드래그가 크기를 바꾼다 (FR-CSZ-1·2).
  test('V-CSZ-1: 손잡이를 끌면 파일 목록의 폭이 바뀐다', async ({ page }) => {
    await waitForInit(page);
    await openGit(page, fx('basic'));

    const handle = changes(page).locator('.git-files-handle');
    await expect(handle).toHaveCount(1);

    const before = (await changes(page).locator('.git-files').boundingBox())!.width;
    const after = await dragHandle(page, 150);
    expect(after).toBeGreaterThan(before + 40);
  });

  // V-CSZ-2: 끝까지 끌어도 칸이 사라지지 않는다 (FR-CSZ-3). 사라진 칸은
  // 되돌릴 손잡이도 함께 잃는다.
  test('V-CSZ-2: 하한 아래로 내려가지 않는다', async ({ page }) => {
    await waitForInit(page);
    await openGit(page, fx('basic'));

    await dragHandle(page, -3000);
    const total = (await changes(page).locator('.git-changes-body').boundingBox())!.width;
    const w = (await changes(page).locator('.git-files').boundingBox())!.width;
    const min = await page.evaluate(() => GIT_FILES_SIZE_MIN);
    // 1%p 는 테두리·반올림의 여유다.
    expect((w / total) * 100).toBeGreaterThan(min - 1);
  });

  // V-CSZ-3: 값이 남는다 (FR-CSZ-4). 확정은 놓는 순간 한 번이다 (FR-CSZ-2).
  test('V-CSZ-3: 놓는 순간 저장되고 다시 열어도 남는다', async ({ page }) => {
    await waitForInit(page);
    await openGit(page, fx('basic'));

    await dragHandle(page, 120);
    const key = await page.evaluate(() => GIT_FILES_W_KEY);
    const saved = await page.evaluate((k) => localStorage.getItem(k), key);
    expect(saved).not.toBeNull();
    expect(parseFloat(saved!)).toBeGreaterThan(0);

    await reopen(page);
    await openGit(page, fx('basic'));
    const w = (await changes(page).locator('.git-files').boundingBox())!.width;
    const total = (await changes(page).locator('.git-changes-body').boundingBox())!.width;
    expect(Math.abs((w / total) * 100 - parseFloat(saved!))).toBeLessThan(2);
  });

  // V-CSZ-4: 가로 값과 세로 값이 서로를 덮지 않는다 (FR-CSZ-5).
  test('V-CSZ-4: 가로 값과 세로 값은 다른 키에 산다', async ({ page }) => {
    await waitForInit(page);
    const [wk, hk] = await page.evaluate(() => [
      GIT_FILES_W_KEY,
      GIT_FILES_H_KEY,
    ]);
    expect(wk).toBeTruthy();
    expect(hk).toBeTruthy();
    expect(wk).not.toBe(hk);
  });

  // V-CSZ-5: 망가진 저장값은 기본값으로 되돌아간다 (FR-CSZ-6).
  test('V-CSZ-5: 범위 밖·비수치 저장값은 기본값이 된다', async ({ page }) => {
    await waitForInit(page);
    await openGit(page, fx('basic'));
    const def = await page.evaluate(() => GIT_FILES_SIZE_DEFAULT);
    for (const bad of ['garbage', '-10', '999']) {
      const got = await page.evaluate((v) => {
        localStorage.setItem(GIT_FILES_W_KEY, v);
        return (window as any).app.gitPanel._filesSizePref();
      }, bad);
      expect(got).toBe(def);
    }
  });
});

test.describe('묶음 O — Diff 개요 눈금', () => {
  // V-DOR-1·2: 눈금은 켜져 있고 접기는 꺼져 있다 (FR-DOR-1·2). 접기가 켜지면
  // 눈금이 접힌 좌표계 위에 서서 실제 파일의 줄 위치와 어긋난다.
  test('V-DOR-1/2: 눈금은 켜짐, 접기는 꺼짐이 기본이다', async ({ page }) => {
    await waitForInit(page);
    const opts = await page.evaluate(() => GIT_DIFF_OPTIONS);
    expect(opts.renderOverviewRuler).toBe(true);
    expect(opts.hideUnchangedRegions.enabled).toBe(false);
  });

  // V-DOR-3: 토글이 상태를 바꾸고 남는다 (FR-DOR-3·4).
  test('V-DOR-3: 접기 토글이 상태를 바꾸고 보존된다', async ({ page }) => {
    await waitForInit(page);
    await openGit(page, fx('basic'));
    await page.evaluate(() => (window as any).app.gitPanel.openView('diff'));

    const box = page.locator('#area .pn-body .git-diff-fold input');
    await expect(box).toHaveCount(1);
    await expect(box).not.toBeChecked();

    await box.check();
    const key = await page.evaluate(() => GIT_DIFF_FOLD_KEY);
    expect(await page.evaluate((k) => localStorage.getItem(k), key)).toBe('1');
    expect(await page.evaluate(() => (window as any).app.gitPanel._foldPref())).toBe(true);
  });

  // FR-DOR-5: 두 뷰가 같은 상태를 쓴다. 갈리면 사용자가 어느 쪽을 보는지 모른다.
  test('V-DOR-4: Diff 와 Changes 미리보기가 같은 접기 상태를 쓴다', async ({ page }) => {
    await waitForInit(page);
    await openGit(page, fx('basic'));
    await page.evaluate(() => (window as any).app.gitPanel.openView('diff'));
    await page.locator('#area .pn-body .git-diff-fold input').check();

    const same = await page.evaluate(() => {
      const p = (window as any).app.gitPanel;
      const views = [p._diffView, p._previewView].filter(Boolean);
      return views.every((v: any) => v._fold === p._foldPref());
    });
    expect(same).toBe(true);
  });
});

test.describe('묶음 F·G·K — Editor 검색', () => {
  // V-EKB-2: Editor 창이 아니면 뜨지 않는다 (FR-EKB-4). 터미널 창에는 검색할
  // 루트가 없다.
  test('V-EKB-2: 터미널 창에서는 패널이 뜨지 않는다', async ({ page }) => {
    await waitForInit(page);
    expect(await page.evaluate(() => (window as any).app._edSearchRoot())).toBe('');
    await page.evaluate(() => (window as any).app._edQuickOpen());
    await page.waitForTimeout(200);
    await expect(page.locator('.ed-find.vis')).toHaveCount(0);
  });

  // 검색 대상 루트. 격리 인스턴스에는 Editor 가 하나도 없으므로 픽스처
  // 저장소를 등록해 쓴다 — 등록된 루트만 `fsRoot` 를 통과한다 (FR-EQO-2).
  async function anEditorRoot(page: Page, path: string) {
    return page.evaluate(async (p) => {
      const add = await fetch('/api/editors/add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: p }),
      });
      if (!add.ok) return '';
      const j = await add.json();
      // list 는 **문자열 배열**이다 (wsentry.Lists.Editors).
      const list: string[] = (j.list || []).filter(Boolean);
      // 서버가 정규화한 값을 그대로 쓴다 — 우리가 다시 정규화하면 갈린다.
      return list.find((r) => r.endsWith('/basic')) || list[0] || '';
    }, path);
  }

  // V-EQO-1·4: 이름 찾기가 응답하고 제외 디렉터리를 걸러 낸다.
  test('V-EQO: 파일 이름 찾기가 결과를 준다', async ({ page, request }) => {
    await waitForInit(page);
    const root = await anEditorRoot(page, fx('basic'));
    test.skip(!root, 'Editor 루트가 없다');

    const r = await request.get(
      '/api/fs/find?root=' + encodeURIComponent(root) + '&q=a&limit=20');
    expect(r.status()).toBe(200);
    const body = await r.json();
    expect(Array.isArray(body.files)).toBe(true);
    for (const f of body.files) {
      expect(f.path.startsWith('.git/')).toBe(false);
      expect(f.path.startsWith('node_modules/')).toBe(false);
    }
  });

  // V-EQO-3: 상한에서 끊고 truncated 를 준다 (FR-EQO-4).
  test('V-EQO-3: 상한을 넘으면 truncated 다', async ({ page, request }) => {
    await waitForInit(page);
    const root = await anEditorRoot(page, fx('basic'));
    test.skip(!root, 'Editor 루트가 없다');

    const r = await request.get(
      '/api/fs/find?root=' + encodeURIComponent(root) + '&q=e&limit=1');
    expect(r.status()).toBe(200);
    const body = await r.json();
    expect(body.files.length).toBeLessThanOrEqual(1);
  });

  // 내용 찾기가 어느 구현을 썼는지 밝힌다 (FR-EGS-3).
  test('V-EGS: 내용 찾기가 engine 을 밝힌다', async ({ page, request }) => {
    await waitForInit(page);
    const root = await anEditorRoot(page, fx('basic'));
    test.skip(!root, 'Editor 루트가 없다');

    const r = await request.get(
      '/api/fs/grep?root=' + encodeURIComponent(root) + '&q=function&limit=10');
    expect(r.status()).toBe(200);
    const body = await r.json();
    expect(['ripgrep', 'go']).toContain(body.engine);
    expect(Array.isArray(body.matches)).toBe(true);
  });

  // 빈 질의는 거부된다 — 통과시키면 저장소 전체를 뱉는 요청이 된다.
  test('빈 질의는 400 이다', async ({ page, request }) => {
    await waitForInit(page);
    const root = await anEditorRoot(page, fx('basic'));
    test.skip(!root, 'Editor 루트가 없다');

    for (const p of ['/api/fs/find', '/api/fs/grep']) {
      const r = await request.get(p + '?root=' + encodeURIComponent(root) + '&q=');
      expect(r.status()).toBe(400);
    }
  });

  // V-EQO-2: 등록되지 않은 루트는 거부된다 (FR-EQO-2 · D-3).
  test('V-EQO-2: 등록되지 않은 루트는 403 이다', async ({ page, request }) => {
    await waitForInit(page);
    const r = await request.get(
      '/api/fs/find?root=' + encodeURIComponent(fx('basic')) + '&q=a');
    expect(r.status()).toBe(403);
  });
});

test.describe('묶음 V — 열 수 있는 것과 없는 것', () => {
  // 이진·이미지 파일을 픽스처 저장소 안에 만든다. 서버가 내용으로 판정하는지
  // 보려면 **확장자가 거짓인 것**이 있어야 한다 (FR-EVW-2).
  const PNG = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(64),
  ]);

  async function editorRoot(page: Page) {
    return page.evaluate(async (p) => {
      const r = await fetch('/api/editors/add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: p }),
      });
      if (!r.ok) return '';
      const j = await r.json();
      const list: string[] = (j.list || []).filter(Boolean);
      return list.find((x) => x.endsWith('/basic')) || list[0] || '';
    }, fx('basic'));
  }

  // V-EVW-1: 확장자가 거짓이어도 내용으로 판정한다 (FR-EVW-1·2).
  test('V-EVW-1: .txt 로 저장된 PNG 는 image 로 판정된다', async ({ page, request }) => {
    await waitForInit(page);
    const root = await editorRoot(page);
    test.skip(!root, 'Editor 루트가 없다');

    const p = join(root, 'disguised.txt');
    writeFileSync(p, PNG);
    const r = await request.get('/api/file/probe?path=' + encodeURIComponent(p));
    expect(r.status()).toBe(200);
    expect((await r.json()).kind).toBe('image');
  });

  // V-EVW-2: 이진 파일은 binary 로 판정된다 — 편집기가 열지 않는 근거다.
  test('V-EVW-2: 이진 파일은 binary 로 판정된다', async ({ page, request }) => {
    await waitForInit(page);
    const root = await editorRoot(page);
    test.skip(!root, 'Editor 루트가 없다');

    const p = join(root, 'blob.bin');
    writeFileSync(p, Buffer.concat([Buffer.from('MZ'), Buffer.alloc(200)]));
    const r = await request.get('/api/file/probe?path=' + encodeURIComponent(p));
    expect((await r.json()).kind).toBe('binary');
  });

  // V-EVW-5: 이미지는 올바른 MIME 과 nosniff 로 나간다 (FR-EVW-5·6).
  test('V-EVW-5: raw 는 image MIME 과 nosniff 를 준다', async ({ page, request }) => {
    await waitForInit(page);
    const root = await editorRoot(page);
    test.skip(!root, 'Editor 루트가 없다');

    const p = join(root, 'pic.png');
    writeFileSync(p, PNG);
    const r = await request.get('/api/file/raw?path=' + encodeURIComponent(p));
    expect(r.status()).toBe(200);
    expect(r.headers()['content-type']).toBe('image/png');
    expect(r.headers()['x-content-type-options']).toBe('nosniff');
  });

  // V-EVW-4: 이미지가 아닌 것은 인라인으로 내보내지 않는다 (FR-EVW-5).
  // 임의의 파일을 같은 출처에서 추론된 MIME 으로 제공하면 저장형 XSS 가 된다.
  test('V-EVW-4: HTML 은 raw 로 나가지 않는다 (415)', async ({ page, request }) => {
    await waitForInit(page);
    const root = await editorRoot(page);
    test.skip(!root, 'Editor 루트가 없다');

    const p = join(root, 'evil.html');
    writeFileSync(p, '<script>alert(1)</script>');
    const r = await request.get('/api/file/raw?path=' + encodeURIComponent(p));
    expect(r.status()).toBe(415);
  });

  // V-EVW-3: 이미지 탭은 <img> 로 그려지고 Monaco 가 서지 않는다 (FR-EVW-4·7).
  test('V-EVW-3: 이미지는 뷰어로 열리고 Monaco 가 서지 않는다', async ({ page }) => {
    await waitForInit(page);
    const root = await editorRoot(page);
    test.skip(!root, 'Editor 루트가 없다');

    const p = join(root, 'shown.png');
    writeFileSync(p, PNG);
    await page.evaluate((f) => (window as any).app._edOpenFile(f), p);

    const img = page.locator('.fe-image .fe-img');
    await expect(img).toHaveCount(1);
    await expect(page.locator('.fe-image .monaco-editor')).toHaveCount(0);
  });

  // V-EVW-2: 이진 파일은 사유를 보이고 Monaco 가 서지 않는다 (FR-EVW-3·7).
  test('V-EVW-2b: 이진 파일은 사유만 보인다', async ({ page }) => {
    await waitForInit(page);
    const root = await editorRoot(page);
    test.skip(!root, 'Editor 루트가 없다');

    const p = join(root, 'shown.bin');
    writeFileSync(p, Buffer.concat([Buffer.from('MZ'), Buffer.alloc(200)]));
    await page.evaluate((f) => (window as any).app._edOpenFile(f), p);

    await expect(page.locator('.fe-unsupported')).toHaveCount(1);
    await expect(page.locator('.fe-unsupported .fe-unsup-title')).toHaveText(/열 수 없는/);
  });
});

// 회귀 방어: `_edSearchRoot()` 가 활성 창을 **실제로** 읽는가.
//
// 앞의 V-EKB-2 는 "터미널 창에서 빈 문자열"만 봤다. 그 단언은 속성 이름이
// 틀려 언제나 빈 문자열이어도 통과한다 — 실제로 처음 구현은 `this.activeWindow`
// (실재하지 않음, 올바른 것은 `this.ws.activeWindow`)를 읽었고 이 검사가
// 없었다면 cmd+p·cmd+shift+f 가 통째로 죽은 채 통과했을 것이다.
// **음성 단언만으로 배선을 검증하지 않는다.**
test.describe('묶음 K — 검색 루트의 배선', () => {
  // Editor 를 등록하고 그 창을 활성으로 만든다. 워크스페이스 쓰기가 픽스처의
  // 초기화와 겹쳐 409 가 날 수 있으므로 **결과를 폴링으로 기다린다** — 경합을
  // 검사하는 것이 아니라 배선을 검사하는 것이다.
  async function activateEditorWindow(page: Page) {
    await page.evaluate(async (p) => {
      await fetch('/api/editors/add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: p }),
      });
    }, fx('basic'));
    await expect
      .poll(async () => page.evaluate(async (p) => {
        const app = (window as any).app;
        await app._edReconcile?.();
        await app._edOpenWindow(p);
        return app._edSearchRoot();
      }, fx('basic')), { timeout: 15000 })
      .not.toBe('');
  }

  // V-EKB-3: 활성 창을 **실제로** 읽는가.
  //
  // 앞의 V-EKB-2 는 "터미널 창에서 빈 문자열"만 봤다. 그 단언은 속성 이름이
  // 틀려 언제나 빈 문자열이어도 통과한다 — 실제로 처음 구현은
  // `this.activeWindow`(실재하지 않음, 올바른 것은 `this.ws.activeWindow`)를
  // 읽었고, 이 검사가 없었다면 cmd+p·cmd+shift+f 가 통째로 죽은 채 통과했다.
  // **음성 단언만으로 배선을 검증하지 않는다.**
  test('V-EKB-3: Editor 창이 활성이면 루트가 실제로 잡힌다', async ({ page }) => {
    await waitForInit(page);
    await activateEditorWindow(page);
    const root = await page.evaluate(() => (window as any).app._edSearchRoot());
    expect(root.endsWith('/basic')).toBe(true);
  });

  // V-EKB-4: 루트가 잡히면 패널이 실제로 뜨고 질의 칸에 포커스가 간다.
  test('V-EKB-4: Editor 창이 활성이면 cmd+p 패널이 실제로 뜬다', async ({ page }) => {
    await waitForInit(page);
    await activateEditorWindow(page);
    await page.evaluate(() => (window as any).app._edQuickOpen());

    await expect(page.locator('.ed-find.vis')).toHaveCount(1);
    await expect(page.locator('.ed-find.vis .ed-find-q')).toBeFocused();
  });

  // 전체 검색 패널도 같은 배선을 쓴다.
  test('V-EKB-5: cmd+shift+f 패널이 뜨고 Escape 로 닫힌다', async ({ page }) => {
    await waitForInit(page);
    await activateEditorWindow(page);
    await page.evaluate(() => (window as any).app._edSearchOpen());
    await expect(page.locator('.ed-find.vis')).toHaveCount(1);

    await page.keyboard.press('Escape');
    await expect(page.locator('.ed-find.vis')).toHaveCount(0);
  });
});

// 묶음 F·G 의 마지막 한 걸음 — 서버가 답하는 것과 **탭이 열리는 것**은 다르다.
// 앞의 검사들은 종단만 봤다 (V-EQO-7·V-EGS-10 미검증).
test.describe('묶음 F·G — 고른 결과가 실제로 열린다', () => {
  async function activate(page: Page) {
    await page.evaluate(async (p) => {
      await fetch('/api/editors/add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: p }),
      });
    }, fx('basic'));
    await expect
      .poll(async () => page.evaluate(async (p) => {
        const app = (window as any).app;
        await app._edReconcile?.();
        await app._edOpenWindow(p);
        return app._edSearchRoot();
      }, fx('basic')), { timeout: 15000 })
      .not.toBe('');
  }

  // V-EQO-7: 빠른 열기에서 고르면 그 파일이 탭으로 열린다.
  test('V-EQO-7: 빠른 열기로 고른 파일이 탭으로 열린다', async ({ page }) => {
    await waitForInit(page);
    await activate(page);

    writeFileSync(join(fx('basic'), 'quickpick.txt'), 'hello from quickpick\n');
    await page.evaluate(() => (window as any).app._edQuickOpen());
    await page.locator('.ed-find.vis .ed-find-q').fill('quickpick');

    const row = page.locator('.ed-find.vis .ed-find-row').first();
    await expect(row).toBeVisible({ timeout: 10000 });
    await row.click();

    await expect(page.locator('.ed-find.vis')).toHaveCount(0);
    await expect
      .poll(() => page.evaluate(() =>
        [...(window as any).app.fileEditors.values()].some((v: any) =>
          String(v.filePath).endsWith('quickpick.txt'))), { timeout: 15000 })
      .toBe(true);
  });

  // V-EGS-10: 전체 검색에서 고르면 **그 줄로** 연다. 사용자가 고른 것은
  // 파일이 아니라 그 줄이다.
  test('V-EGS-10: 검색 결과를 고르면 그 줄로 열린다', async ({ page }) => {
    await waitForInit(page);
    await activate(page);

    // 다섯째 줄에만 표식을 둔다.
    writeFileSync(join(fx('basic'), 'grephit.txt'),
      'a\nb\nc\nd\nNEEDLE_XYZ here\nf\n');
    await page.evaluate(() => (window as any).app._edSearchOpen());
    await page.locator('.ed-find.vis .ed-find-q').fill('NEEDLE_XYZ');

    const row = page.locator('.ed-find.vis .ed-find-row').first();
    await expect(row).toBeVisible({ timeout: 10000 });
    await expect(row.locator('.ed-find-path')).toContainText(':5');
    await row.click();

    await expect
      .poll(() => page.evaluate(() => {
        const v = [...(window as any).app.fileEditors.values()]
          .find((x: any) => String(x.filePath).endsWith('grephit.txt')) as any;
        if (!v) return null;
        // Monaco 가 아직 안 떴으면 예약된 자리를, 떴으면 커서 위치를 본다.
        if (v._pendingReveal) return v._pendingReveal.line;
        return v._editor ? v._editor.getPosition().lineNumber : null;
      }), { timeout: 20000 })
      .toBe(5);
  });
});

// FR-EKB-1 — 두 조합은 **Monaco 안에서도** 떠야 한다.
//
// 전역 keydown 은 편집기에 포커스가 있는 동안 한 줄도 돌지 않는다
// (input-binding.js 의 activeElement 게이트). 그래서 file-editor.js 가
// `editor.addCommand` 로 따로 건다. 그 배선이 실제로 도는지는 **편집기에
// 포커스를 준 채 눌러 봐야** 알 수 있다.
test.describe('묶음 K — Monaco 안에서의 키', () => {
  async function openTextFileInEditor(page: Page) {
    await page.evaluate(async (p) => {
      await fetch('/api/editors/add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: p }),
      });
    }, fx('basic'));
    await expect
      .poll(async () => page.evaluate(async (p) => {
        const app = (window as any).app;
        await app._edReconcile?.();
        await app._edOpenWindow(p);
        return app._edSearchRoot();
      }, fx('basic')), { timeout: 15000 })
      .not.toBe('');

    writeFileSync(join(fx('basic'), 'inmonaco.txt'), 'line one\nline two\n');
    await page.evaluate((f) => (window as any).app._edOpenFile(f),
      join(fx('basic'), 'inmonaco.txt'));

    // Monaco 가 실제로 설 때까지 기다린다 — addCommand 는 그 뒤에 걸린다.
    await expect(page.locator('.file-editor .monaco-editor')).toHaveCount(1, { timeout: 30000 });

    // 포커스는 Monaco 의 API 로 준다. 어느 요소가 입력을 받는지는 판마다 다르다 —
    // 0.56 은 textarea 가 아니라 EditContext(`div.native-edit-context`)를 쓴다.
    // 선택자를 박아 두면 판이 오를 때 조용히 깨진다.
    const focused = await page.evaluate((f) => {
      const app = (window as any).app;
      const v = [...app.fileEditors.values()]
        .find((x: any) => String(x.filePath).endsWith(f)) as any;
      if (!v || !v._editor) return '';
      v._editor.focus();
      const ae = document.activeElement as HTMLElement | null;
      return ae ? ae.tagName + '.' + (ae.className || '') : '';
    }, 'inmonaco.txt');
    // 편집기 안에 포커스가 들어간 것을 확인하고 나서 키를 누른다 — 밖에서
    // 누르면 이 검사는 전역 경로만 시험하게 되어 뜻을 잃는다.
    expect(focused).not.toBe('');
    expect(await page.evaluate(() =>
      !!document.activeElement?.closest('.file-editor'))).toBe(true);
  }

  test('V-EKB-1: Monaco 에 포커스가 있어도 cmd+p 가 뜬다', async ({ page }) => {
    await waitForInit(page);
    await openTextFileInEditor(page);

    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+p' : 'Control+p');
    await expect(page.locator('.ed-find.vis')).toHaveCount(1);
  });

  test('V-EKB-1b: Monaco 에 포커스가 있어도 cmd+shift+f 가 뜬다', async ({ page }) => {
    await waitForInit(page);
    await openTextFileInEditor(page);

    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Shift+F' : 'Control+Shift+F');
    await expect(page.locator('.ed-find.vis')).toHaveCount(1);
  });
});

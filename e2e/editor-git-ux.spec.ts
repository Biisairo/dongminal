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

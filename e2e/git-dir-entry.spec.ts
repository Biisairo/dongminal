import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { APIRequestContext, Page } from '@playwright/test';

import { test, expect } from './fixtures';

// GIT_DIR_ENTRY_SRS §4 — 디렉터리 상태 항목의 검증 V-DIR-10~42.
//
// **서버를 목업하지 않는다.** 이 SRS 가 고치는 것은 "git 이 실제로 무엇을 주는가"
// 위에 선 판정이므로, 픽스처를 진짜 디스크에 만들고 진짜 응답으로 잰다 —
// 서브모듈의 `S.MU` 도 중첩 저장소의 `nested/` 도 손으로 흉내 내면 그 흉내가
// 맞는지부터 다시 물어야 한다 (그 값은 §2 에서 실측으로 확정했다).

let BASE = '';
let PARENT = '';   // 서브모듈과 중첩 저장소를 담은 부모 저장소
let SUBDIR = '';   // 부모 저장소 **안**의 하위 폴더 (FR-DIR-40 의 대상)

const j = (...p: string[]) => path.join(...p);
const w = (p: string, s: string) => fs.writeFileSync(p, s);
const git = (d: string, ...a: string[]) =>
  execFileSync('git', ['-C', d, ...a], { stdio: 'ignore' });

function init(d: string) {
  fs.mkdirSync(d, { recursive: true });
  git(d, 'init', '-q', '-b', 'main', '.');
  git(d, 'config', 'user.name', 'Fixture');
  git(d, 'config', 'user.email', 'fixture@example.invalid');
  git(d, 'config', 'commit.gpgsign', 'false');
  // 파일 프로토콜 서브모듈은 git 2.38+ 에서 기본으로 막혀 있다.
  git(d, 'config', 'protocol.file.allow', 'always');
  return d;
}

/**
 * 부모 저장소 하나에 네 가지를 세운다.
 *
 *   sub/          등록된 서브모듈, 워킹 트리가 더럽다   → `1 .M S.MU … sub`
 *   nested/       등록되지 않은 중첩 저장소             → `? nested/`
 *   plaindir/     일반 미추적 폴더                      → 파일 단위로 펴진다
 *   src/          변경 파일이 든 추적 폴더              → FR-DIR-40 의 루트
 */
function makeParent(base: string) {
  const child = init(j(base, 'child'));
  w(j(child, 'a.txt'), 'hello\n');
  git(child, 'add', '-A');
  git(child, 'commit', '-qm', 'init');

  const d = init(j(base, 'parent'));
  w(j(d, 'r.txt'), 'root\n');
  fs.mkdirSync(j(d, 'src'));
  w(j(d, 'src', 'keep.txt'), 'one\n');
  git(d, 'add', '-A');
  git(d, 'commit', '-qm', 'init');
  git(d, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', '../child', 'sub');
  git(d, 'commit', '-qm', 'addsub');

  // 서브모듈의 워킹 트리를 더럽힌다 — 부모에게는 `sub` 한 줄로만 보인다.
  fs.appendFileSync(j(d, 'sub', 'a.txt'), 'more\n');
  // 중첩 저장소. `--untracked-files=all` 로도 펴지지 않는 유일한 종류다.
  const nested = init(j(d, 'nested'));
  w(j(nested, 'inner.txt'), 'x\n');
  // 대조군 — 일반 미추적 폴더는 파일 단위로 펴진다.
  fs.mkdirSync(j(d, 'plaindir'));
  w(j(d, 'plaindir', 'p.txt'), 'x\n');
  // 하위 루트에서 볼 변경 하나 (FR-DIR-40·41).
  fs.appendFileSync(j(d, 'src', 'keep.txt'), 'two\n');
  return fs.realpathSync(d);
}

test.beforeAll(() => {
  BASE = fs.realpathSync(fs.mkdtempSync(j(os.tmpdir(), 'dm-dir-')));
  PARENT = makeParent(BASE);
  SUBDIR = j(PARENT, 'src');
});
test.afterAll(() => {
  if (BASE) fs.rmSync(BASE, { recursive: true, force: true });
});

// ── 진입 ────────────────────────────────────────────

async function addEditor(request: APIRequestContext, p: string) {
  const r = await request.post('/api/editors/add', { data: { path: p } });
  expect(r.ok(), `editors/add 실패: ${await r.text()}`).toBeTruthy();
}

async function goto(page: Page) {
  await page.context().addInitScript(() => { sessionStorage.setItem('displayMode', 'desktop') });
  await page.goto('/');
  await page.waitForSelector('#area .pn.focused .xterm-helper-textarea', { timeout: 15000 });
  await page.waitForFunction(
    () => !!(window as any).app?._editors && (window as any).app._edWindows().length > 0,
    undefined, { timeout: 15000 });
}

async function openEditor(page: Page, root: string) {
  await page.evaluate((r) => {
    const a = (window as any).app;
    const win = a._edWindows().find((x: any) => x.editor && x.editor.root === r);
    if (!win) throw new Error('Editor 창이 없다: ' + r);
    a.switchWindow(win.id);
  }, root);
  await page.waitForSelector('.ed-win .ed-explorer .ed-tree', { timeout: 10000 });
}

async function enter(page: Page, request: APIRequestContext, root: string) {
  await addEditor(request, root);
  await goto(page);
  await openEditor(page, root);
  await expect(page.locator('.ed-tree .ed-row').first()).toBeVisible({ timeout: 10000 });
}

const row = (page: Page, p: string) =>
  page.locator(`.ed-tree .ed-row[data-path="${p}"]`);

// 상태 클래스는 CSS 색표의 키다 (FR-STC-3) — 색값이 아니라 이것으로 잰다.
const stClass = async (page: Page, p: string) =>
  page.evaluate((sel) => {
    const el = document.querySelector(`.ed-tree .ed-row[data-path="${sel}"]`);
    if (!el) return null;
    return [...el.classList].filter((c) => c.startsWith('st-')).join(' ');
  }, p);

// 폴더를 펼친다. 클릭은 조회를 부르므로 하위 행이 나타날 때까지 기다린다.
async function expand(page: Page, p: string) {
  await row(page, p).click();
  await page.waitForFunction(
    (sel) => [...document.querySelectorAll('.ed-tree .ed-row')]
      .some((e) => (e as HTMLElement).dataset.path!.startsWith(sel + '/')),
    p, { timeout: 10000 });
}

// ── 묶음 S — 서버가 확정한다 (FR-DIR-1~5) ────────────

test.describe('묶음 S — 디렉터리 항목의 확정', () => {
  test('S1 (V-DIR-1·2): 중첩 저장소가 dir:true 이고 경로에 끝 슬래시가 없다',
    async ({ request }) => {
      const r = await request.get('/api/git/status?repo=' + encodeURIComponent(PARENT));
      expect(r.ok()).toBeTruthy();
      const st = (await r.json()).status;
      const nested = (st.untracked || []).find((e: any) => e.path === 'nested');
      expect(nested, `nested 항목이 없다: ${JSON.stringify(st.untracked)}`).toBeTruthy();
      expect(nested.dir).toBe(true);
      // 중첩 저장소는 서브모듈이 아니다 — sub 필드가 비어 있다 (FR-DIR-3).
      expect(nested.sub || '').toBe('');
      // 끝 슬래시가 남아 있으면 탐색기의 어떤 노드와도 짝이 맞지 않는다 (§2.4).
      expect((st.untracked || []).some((e: any) => e.path.endsWith('/'))).toBe(false);
    });

  test('S2 (V-DIR-2·3): 서브모듈은 dir:true, 일반 파일은 dir 이 없다',
    async ({ request }) => {
      const r = await request.get('/api/git/status?repo=' + encodeURIComponent(PARENT));
      const st = (await r.json()).status;
      const sub = (st.changes || []).find((e: any) => e.path === 'sub');
      expect(sub, `sub 항목이 없다: ${JSON.stringify(st.changes)}`).toBeTruthy();
      expect(sub.dir).toBe(true);
      expect(String(sub.sub || '').startsWith('S')).toBe(true);
      // 대조군 — 일반 미추적 폴더는 파일 단위로 펴지고 그 항목은 파일이다.
      const p = (st.untracked || []).find((e: any) => e.path === 'plaindir/p.txt');
      expect(p, '일반 폴더가 파일로 펴지지 않았다').toBeTruthy();
      expect(!!p.dir).toBe(false);
    });

  test('S3 (V-DIR-6): rootMatch 가 루트에서 참, 하위에서 거짓이다',
    async ({ request }) => {
      const at = async (p: string) =>
        (await (await request.get('/api/git/status?repo=' + encodeURIComponent(p))).json());
      expect((await at(PARENT)).rootMatch).toBe(true);
      const sub = await at(SUBDIR);
      expect(sub.rootMatch).toBe(false);
      // 접두 계산의 근거 (FR-DIR-41·42).
      expect(sub.repo).toBe(PARENT);
      expect(sub.requestedResolved).toBe(SUBDIR);
    });
});

// ── 묶음 X — 탐색기의 색 (FR-DIR-10~15) ──────────────

test.describe('묶음 X — 디렉터리 항목의 색과 상속', () => {
  test('X1 (V-DIR-10): 서브모듈 폴더에 색이 나온다', async ({ page, request }) => {
    await enter(page, request, PARENT);
    // 서브모듈의 워킹 트리 변경은 부모에게 unstaged 수정(M)이다.
    await expect.poll(() => stClass(page, j(PARENT, 'sub')), { timeout: 10000 })
      .toContain('st-mod');
  });

  test('X2 (V-DIR-11): 중첩 저장소 폴더에 색이 나온다', async ({ page, request }) => {
    await enter(page, request, PARENT);
    // 미추적은 신규색이다 (`?` → new).
    await expect.poll(() => stClass(page, j(PARENT, 'nested')), { timeout: 10000 })
      .toContain('st-new');
  });

  test('X3 (V-DIR-12): 중첩 저장소 **안의 파일**이 상속 색을 갖는다',
    async ({ page, request }) => {
      await enter(page, request, PARENT);
      await expect.poll(() => stClass(page, j(PARENT, 'nested')), { timeout: 10000 })
        .toContain('st-new');
      await expand(page, j(PARENT, 'nested'));
      // 이 파일은 부모의 status 에 **결코 나오지 않는다** — 상속이 유일한 근거다.
      await expect.poll(() => stClass(page, j(PARENT, 'nested', 'inner.txt')), { timeout: 10000 })
        .toContain('st-new');
    });

  test('X4 (V-DIR-13): 하위의 자기 상태가 상속을 이긴다', async ({ page, request }) => {
    await enter(page, request, PARENT);
    await expand(page, j(PARENT, 'src'));
    // src 아래 keep.txt 는 자기 수정 상태를 갖는다 — 상속이 아니라 그것이 이긴다.
    await expect.poll(() => stClass(page, j(PARENT, 'src', 'keep.txt')), { timeout: 10000 })
      .toContain('st-mod');
  });
});

// ── 묶음 R·A — 판정과 저장소 안의 루트 (FR-DIR-30~43) ─

test.describe('묶음 A — 저장소 안의 루트도 색을 갖는다', () => {
  test('A1 (V-DIR-40·41): 하위 폴더를 루트로 삼아도 색이 나오고 접두가 맞는다',
    async ({ page, request }) => {
      await enter(page, request, SUBDIR);
      // 고치기 전에는 `repo !== root` 로 판정해 색이 통째로 꺼졌다 (FR-EDT-69).
      await expect.poll(() => stClass(page, j(SUBDIR, 'keep.txt')), { timeout: 10000 })
        .toContain('st-mod');
    });

  test('A2 (V-DIR-42): 루트 밖의 경로가 접어 올림에 새어 들지 않는다',
    async ({ page, request }) => {
      await enter(page, request, SUBDIR);
      await expect.poll(() => stClass(page, j(SUBDIR, 'keep.txt')), { timeout: 10000 })
        .toContain('st-mod');
      // 루트 밖(`sub`·`nested`)의 항목은 트리에 없다. 그것이 새어 들었다면
      // 루트 자신이나 엉뚱한 행이 색을 얻는다 — 트리의 행은 keep.txt 하나뿐이다.
      const painted = await page.evaluate(() =>
        [...document.querySelectorAll('.ed-tree .ed-row')]
          .filter((e) => [...e.classList].some((c) => c.startsWith('st-')))
          .map((e) => (e as HTMLElement).dataset.path));
      expect(painted).toEqual([j(SUBDIR, 'keep.txt')]);
    });
});

// ── 묶음 G — Git 패널의 디렉터리 행 (FR-DIR-20~24) ───

const changes = (page: Page) => page.locator('#area .pn-body .git-view.git-changes');
const diffView = (page: Page) => page.locator('#area .pn-body .git-view.git-diff');

async function openGit(page: Page, repo: string) {
  await goto(page);
  await page.evaluate((r) => (window as any).app.openGitWindow(r), repo);
  await expect(changes(page)).toBeVisible({ timeout: 10000 });
  // 첫 관측이 닿아야 행이 선다.
  await expect(changes(page).locator('.git-file').first()).toBeVisible({ timeout: 10000 });
}

const fileRow = (page: Page, p: string) =>
  changes(page).locator(`.git-file[data-path="${p}"]`);

test.describe('묶음 G — Git 패널의 디렉터리 행', () => {
  test('G1 (V-DIR-20·26): 디렉터리 행에 `/` 가 붙고 파일 행에는 붙지 않는다',
    async ({ page }) => {
      await openGit(page, PARENT);
      // 서브모듈과 중첩 저장소 둘 다 디렉터리 행이다.
      await expect(fileRow(page, 'sub')).toHaveClass(/dir-entry/, { timeout: 10000 });
      await expect(fileRow(page, 'sub').locator('.git-file-path-dirmark')).toHaveText('/');
      await expect(fileRow(page, 'nested')).toHaveClass(/dir-entry/);
      // 대조군 — 일반 파일에는 표시가 없다.
      await expect(fileRow(page, 'plaindir/p.txt')).not.toHaveClass(/dir-entry/);
      await expect(fileRow(page, 'plaindir/p.txt').locator('.git-file-path-dirmark'))
        .toHaveCount(0);
    });

  test('G2 (V-DIR-21): 서브모듈 행을 고르면 diff 대신 사유가 나온다',
    async ({ page }) => {
      await openGit(page, PARENT);
      await fileRow(page, 'sub').dblclick();
      const note = diffView(page).locator('.git-diff-note');
      await expect(note).toBeVisible({ timeout: 10000 });
      await expect(note).toContainText('서브모듈');
      // 사유 자리에 Monaco 를 세우지 않는다 — 그릴 것이 없기 때문이다.
      await expect(diffView(page).locator('.monaco-editor')).toHaveCount(0);
    });

  test('G3 (V-DIR-22): 중첩 저장소 행의 사유와 진입점', async ({ page }) => {
    await openGit(page, PARENT);
    await fileRow(page, 'nested').dblclick();
    const note = diffView(page).locator('.git-diff-note');
    await expect(note).toContainText('다른 저장소', { timeout: 10000 });
    // FR-DIR-22: 그 자리에서 저장소로 갈 수 있다.
    await expect(note.locator('.git-diff-note-act')).toHaveText('저장소로 추가');
  });

  test('G4 (V-DIR-23): `저장소로 추가` 가 Editor 행과 Git 핀을 함께 만든다',
    async ({ page, request }) => {
      await openGit(page, PARENT);
      await fileRow(page, 'nested').dblclick();
      const act = diffView(page).locator('.git-diff-note .git-diff-note-act');
      await expect(act).toHaveText('저장소로 추가', { timeout: 10000 });
      await act.click();

      const nested = j(PARENT, 'nested');
      await expect.poll(async () => {
        const r = await request.get('/api/editors');
        return (await r.json()).list || [];
      }, { timeout: 10000 }).toContain(nested);
      // FR-EDT-33·39: 연동이 핀까지 함께 만든다 — 여기서 두 목록을 각각 건드리지 않는다.
      const state = await (await request.get('/api/state')).json();
      expect(state?.workspace?.git?.pinned || []).toContain(nested);
    });
});

// ── 묶음 R — 판정의 수명 (FR-DIR-30~32) ──────────────

// 인스턴스가 굳었는지는 store 가 안다 — 같은 루트를 보는 칸이 그것을 나눠 쓴다.
const gitOff = (page: Page, root: string) =>
  page.evaluate((r) => {
    const a = (window as any).app;
    const s = a._edStore(r);
    return { off: !!s.gitOff, retry: s.gitRetryAt > 0 };
  }, root);

test.describe('묶음 R — _gitOff 는 사유마다 수명이 다르다', () => {
  test('R1 (V-DIR-31): 저장소가 아니면 굳지 않고, git init 뒤 색이 돌아온다',
    async ({ page, request }) => {
      const plain = fs.realpathSync(fs.mkdtempSync(j(BASE, 'plain-')));
      w(j(plain, 'f.txt'), 'x\n');
      await enter(page, request, plain);
      // 404 를 받아도 굳지 않는다 — `git init` 이 뒤집을 수 있는 사유다.
      await expect.poll(() => gitOff(page, plain), { timeout: 10000 })
        .toEqual({ off: false, retry: true });

      // 그 자리에서 저장소가 된다.
      init(plain);
      // 서버는 "저장소가 아니다" 도 캐시한다 (store.RepoRoot, TTL 2초) — 그것이
      // 풀리기 전에 물으면 방금 만든 저장소도 없는 것으로 답한다.
      await expect.poll(async () => {
        const r = await request.get('/api/git/status?repo=' + encodeURIComponent(plain));
        return r.status();
      }, { timeout: 10000 }).toBe(200);

      // FR-DIR-32: 창 활성화는 백오프를 넘긴다 — 다른 창에 들렀다 돌아온다.
      // 들르는 곳은 홈(`~`) 창이다 — 그것만이 언제나 있다 (FR-EDT-13).
      const home = await page.evaluate(() => (window as any).app._edHome());
      await openEditor(page, home);
      await openEditor(page, plain);
      await expect.poll(() => stClass(page, j(plain, 'f.txt')), { timeout: 10000 })
        .toContain('st-new');
    });

  test('R2 (V-DIR-32): 503 은 종전대로 굳는다', async ({ page, request }) => {
    await addEditor(request, PARENT);
    // git 자체가 없다는 답이다 — 다시 물어도 같으므로 굳히는 것이 옳다.
    await page.route('**/api/git/status**', (route) =>
      route.fulfill({ status: 503, contentType: 'application/json',
        body: JSON.stringify({ code: 'git_unavailable', message: 'no git' }) }));
    await goto(page);
    await openEditor(page, PARENT);
    await expect.poll(() => gitOff(page, PARENT), { timeout: 10000 })
      .toEqual({ off: true, retry: false });
  });
});

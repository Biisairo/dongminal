import { execFileSync } from 'child_process';
import { existsSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';

import { Page } from '@playwright/test';

import { test, expect } from './fixtures';

// GIT_ACTIONS_SRS §3.6 묶음 F — stash · 파일 · 미커밋 행.
// 검증 V199(FR-GIT-272) · V200(273) · V201(274·275) · V203(277).
//
// **Blame(FR-GIT-276, V202)은 이 스펙의 범위가 아니다.**
//
// 테스트 저장소는 e2e/git_fixture.sh 가 만든다 — 테스트 안에서 git init 을
// 되풀이하지 않는다. 상태를 바꾸는 스펙은 **복사본**에서 돈다.

const FIXTURES = '/tmp/dm-git-fx-fileact-' + process.pid;

test.beforeAll(() => {
  execFileSync('bash', ['e2e/git_fixture.sh', FIXTURES], { stdio: 'ignore' });
});
test.afterAll(() => {
  execFileSync('bash', ['e2e/git_fixture.sh', '--clean', FIXTURES], { stdio: 'ignore' });
});

function copyFx(name: string, tag: string) {
  const dst = join(FIXTURES, 'copy-' + tag);
  rmSync(dst, { recursive: true, force: true });
  execFileSync('cp', ['-R', join(FIXTURES, name), dst]);
  return realpathSync(dst);
}

const git = (repo: string, ...args: string[]) =>
  execFileSync('git', ['-C', repo, ...args]).toString().trim();

async function waitForInit(page: Page) {
  await page.context().addInitScript(() => {
    sessionStorage.setItem('displayMode', 'desktop');
  });
  await page.goto('/');
  await page.waitForSelector('#area .pn.focused .xterm-helper-textarea', { timeout: 15000 });
}

async function openGit(page: Page, repo: string) {
  await page.evaluate((r) => (window as any).app.openGitWindow(r), repo);
  await expect(page.locator('#area .pn-tab[data-git-view]')).toHaveCount(7);
}

async function openView(page: Page, view: string, cls: RegExp) {
  await page.click(`#area .pn-tab[data-git-view="${view}"]`);
  await expect(page.locator('#area .pn-body .git-view.vis')).toHaveClass(cls);
}

const changes = (page: Page) => page.locator('#area .pn-body .git-view.git-changes');
const group = (page: Page, key: string) => changes(page).locator(`.git-group[data-group="${key}"]`);
const st = (page: Page) => page.locator('#area .pn-body .git-view.git-stash');
const stashRow = (page: Page, i: number) => st(page).locator(`.git-stash-row[data-index="${i}"]`);
const hist = (page: Page) => page.locator('#area .pn-body .git-view.git-history');
const menu = (page: Page) => page.locator('.git-menu');
const item = (page: Page, id: string) => menu(page).locator(`.git-menu-item[data-id="${id}"]`);
const confirmBox = (page: Page) => page.locator('#git-confirm .gc-box');
const branchBox = (page: Page) => page.locator('#git-stash-branch .gsb-box');
const stashCreate = (page: Page) => page.locator('#git-stash-create .gsc-box');

// 우클릭은 합성 이벤트로 연다 — 좌표만 쓰므로 프레임워크가 그대로 뜬다.
async function ctx(page: Page, locator: ReturnType<Page['locator']>) {
  await locator.click({ button: 'right' });
  await expect(menu(page)).toBeVisible();
}

test.describe('묶음 F — stash · 파일 · 미커밋 행', () => {
  // ── FR-GIT-272 / V199 ──

  test('F1 (V199 / FR-GIT-272): stash 에서 브랜치를 만들면 그 stash 가 적용된 채 새 브랜치로 옮겨간다', async ({
    page,
  }) => {
    const repo = copyFx('stashes', 'f1');
    // 픽스처는 stash 와 **같은 파일**에 현재 변경을 갖고 있다 — 그대로 두면
    // checkout 이 덮어쓸 것을 막느라 stash branch 가 실패한다. 이 스펙이 보는 것은
    // 그 충돌이 아니므로 워킹 트리를 먼저 비운다.
    git(repo, 'checkout', '--', '.');
    const before = git(repo, 'stash', 'list').split('\n').filter((l) => l.trim()).length;
    await waitForInit(page);
    await openGit(page, repo);
    await openView(page, 'stash', /git-stash/);
    await expect(st(page).locator('.git-stash-row')).toHaveCount(2, { timeout: 20000 });

    await ctx(page, stashRow(page, 0));
    await item(page, 'branch-from').click();
    await expect(branchBox(page)).toBeVisible();

    // 어느 stash 에서 만드는지 다이얼로그가 말한다 (FR-GIT-91 의 정신).
    await expect(branchBox(page).locator('.gsb-note')).toContainText('stash@{0}');

    await branchBox(page).locator('.gsb-name').fill('from-stash');
    await branchBox(page).locator('.git-dialog-go').click();
    await expect(branchBox(page)).toHaveCount(0, { timeout: 20000 });

    // 새 브랜치로 옮겨갔고, 그 stash 는 적용된 뒤 사라졌다.
    expect(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('from-stash');
    expect(git(repo, 'stash', 'list').split('\n').filter((l) => l.trim()).length).toBe(before - 1);
    expect(git(repo, 'status', '--porcelain')).not.toBe('');
  });

  test('F2 (FR-GIT-272): 빈 이름으로는 실행되지 않는다 — 사유가 그 자리에 보인다', async ({ page }) => {
    const repo = copyFx('stashes', 'f2');
    await waitForInit(page);
    await openGit(page, repo);
    await openView(page, 'stash', /git-stash/);
    await expect(st(page).locator('.git-stash-row')).toHaveCount(2, { timeout: 20000 });

    await ctx(page, stashRow(page, 0));
    await item(page, 'branch-from').click();
    await expect(branchBox(page)).toBeVisible();
    await expect(branchBox(page).locator('.git-dialog-go')).toBeDisabled();
    await expect(branchBox(page).locator('.gsb-why')).not.toHaveText('');
  });

  test('F3 (FR-GIT-272): Copy name / hash 가 stash 의 ref 와 oid 를 복사한다', async ({ page }) => {
    const repo = copyFx('stashes', 'f3');
    await waitForInit(page);
    await openGit(page, repo);
    await openView(page, 'stash', /git-stash/);
    await expect(st(page).locator('.git-stash-row')).toHaveCount(2, { timeout: 20000 });

    // clipboard 는 헤드리스에서 막힐 수 있다 — copyText 를 가로채 인자만 본다.
    await page.evaluate(() => {
      const p = (window as any).app.gitPanel;
      (window as any).__copied = [];
      p.copyText = (t: string) => (window as any).__copied.push(t);
    });
    await ctx(page, stashRow(page, 1));
    await item(page, 'copy-name').click();
    await ctx(page, stashRow(page, 1));
    await item(page, 'copy-hash').click();

    const copied = (await page.evaluate(() => (window as any).__copied)) as string[];
    expect(copied[0]).toBe('stash@{1}');
    expect(copied[1]).toMatch(/^[0-9a-f]{40}$/);
  });

  test('F4 (FR-GIT-272): 메시지·branch 필터가 목록을 좁힌다 — stash 가 없는 것과 구분된다', async ({
    page,
  }) => {
    const repo = copyFx('stashes', 'f4');
    await waitForInit(page);
    await openGit(page, repo);
    await openView(page, 'stash', /git-stash/);
    await expect(st(page).locator('.git-stash-row')).toHaveCount(2, { timeout: 20000 });

    const filter = st(page).locator('.git-stash-filter');
    await filter.fill('첫 번째');
    await expect(st(page).locator('.git-stash-row')).toHaveCount(1);
    await expect(st(page).locator('.git-stash-row .git-stash-msg')).toContainText('첫 번째');

    // 기준 브랜치로도 걸린다.
    await filter.fill('main');
    await expect(st(page).locator('.git-stash-row')).toHaveCount(2);

    // 맞는 것이 없을 때는 "stash 가 없다" 가 아니라 "필터에 맞는 것이 없다" 다.
    await filter.fill('없는말zzz');
    await expect(st(page).locator('.git-stash-row')).toHaveCount(0);
    await expect(st(page).locator('.git-stash-empty')).toContainText('필터');

    await filter.fill('');
    await expect(st(page).locator('.git-stash-row')).toHaveCount(2);
  });

  // ── FR-GIT-273 / V200 ──

  test('F5 (V200 / FR-GIT-273): Add to .gitignore 가 루트의 .gitignore 에 한 줄을 넣는다', async ({
    page,
  }) => {
    const repo = copyFx('basic', 'f5');
    await waitForInit(page);
    await openGit(page, repo);
    await openView(page, 'changes', /git-changes/);

    const row = group(page, 'untracked').locator('.git-file[data-path="untracked.txt"]');
    await expect(row).toBeVisible({ timeout: 20000 });
    await ctx(page, row);
    await item(page, 'ignore').click();

    await expect
      .poll(() => (existsSync(join(repo, '.gitignore')) ? readFileSync(join(repo, '.gitignore'), 'utf8') : ''), {
        timeout: 15000,
      })
      .toBe('/untracked.txt\n');
    // 무시되었으므로 untracked 목록에서 사라진다 — 응답의 status 로 즉시 갱신된다.
    await expect(group(page, 'untracked').locator('.git-file[data-path="untracked.txt"]')).toHaveCount(0);
  });

  test('F6 (V200 / FR-GIT-273): 중복 줄을 더하지 않는다 — 이미 있음을 그 자리에 알린다', async ({
    page,
  }) => {
    const repo = copyFx('basic', 'f6');
    writeFileSync(join(repo, '.gitignore'), '/untracked.txt\n');
    await waitForInit(page);
    await openGit(page, repo);
    await openView(page, 'changes', /git-changes/);

    // .gitignore 자체가 새 untracked 파일이 된다 — 대상은 그것이 아니라 tracked 변경이다.
    const row = group(page, 'changes').locator('.git-file[data-path="tracked.txt"]');
    await expect(row).toBeVisible({ timeout: 20000 });

    for (let i = 0; i < 2; i++) {
      await ctx(page, row);
      await item(page, 'ignore').click();
      await page.waitForTimeout(300);
    }
    const body = readFileSync(join(repo, '.gitignore'), 'utf8');
    expect(body.split('\n').filter((l) => l === '/tracked.txt')).toHaveLength(1);
    await expect(changes(page).locator('.git-partial-note')).toContainText('이미');
  });

  test('F7 (V200 / FR-GIT-273): 저장소 밖을 대상으로 삼지 않는다 — 서버가 거부한다', async ({ page }) => {
    const repo = copyFx('basic', 'f7');
    await waitForInit(page);
    await openGit(page, repo);

    // 화면을 거치지 않고 API 를 직접 부른다 — 클라이언트만 막으면 이 경로가 우회한다.
    const res = (await page.evaluate(
      async (r) => {
        const out = await fetch('/api/git/ignore', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ repo: r, paths: ['../outside.txt'] }),
        });
        return { code: out.status, body: await out.json() };
      },
      repo,
    )) as { code: number; body: { error?: string } };

    expect(res.code).toBe(400);
    expect(res.body.error).toBe('unsafe_ignore_path');
    expect(existsSync(join(repo, '.gitignore'))).toBe(false);
  });

  // ── FR-GIT-274·275 / V201 ──

  test('F8 (V201 / FR-GIT-274): Open File (HEAD) 가 워킹 트리가 아닌 HEAD 내용을 연다', async ({
    page,
  }) => {
    const repo = copyFx('basic', 'f8');
    // tracked.txt 는 워킹 트리에 "one\ntwo\n", HEAD 에는 "one\n" 이다.
    const headBody = git(repo, 'show', 'HEAD:tracked.txt') + '\n';
    await waitForInit(page);
    await openGit(page, repo);
    await openView(page, 'changes', /git-changes/);

    const row = group(page, 'changes').locator('.git-file[data-path="tracked.txt"]');
    await expect(row).toBeVisible({ timeout: 20000 });
    await ctx(page, row);
    await item(page, 'openFileHead').click();

    // FR-GIT-179·185: Git 창이 아닌 창의 편집기 탭이다. 이름이 HEAD 의 것임을 말한다.
    const tab = page.locator('#area .pn-tab', { hasText: 'tracked.txt (HEAD)' });
    await expect(tab).toHaveCount(1, { timeout: 20000 });
    await expect(page.locator('#area .pn-body .git-view')).toHaveCount(0);

    // 연 것의 내용은 HEAD 의 것이다 — 워킹 트리의 "two" 가 없다.
    const opened = (await page.evaluate(() => {
      const w = (window as any).app;
      for (const s of w.ws.windows) {
        const walk = (n: any): any => {
          if (!n) return null;
          if (n.type === 'pane') return (n.tabs || []).find((t: any) => t.type === 'editor') || null;
          for (const c of n.children || []) {
            const r = walk(c);
            if (r) return r;
          }
          return null;
        };
        const t = walk(s.layout);
        if (t) return t.filePath as string;
      }
      return null;
    })) as string | null;
    expect(opened).not.toBeNull();
    expect(opened!.startsWith(repo)).toBe(false); // 저장소 안에 쓰지 않는다
    expect(readFileSync(opened!, 'utf8')).toBe(headBody);
  });

  test('F9 (V201 / FR-GIT-275): File history 가 path 필터를 채워 History 탭을 연다', async ({ page }) => {
    const repo = copyFx('basic', 'f9');
    await waitForInit(page);
    await openGit(page, repo);
    await openView(page, 'changes', /git-changes/);

    const row = group(page, 'changes').locator('.git-file[data-path="tracked.txt"]');
    await expect(row).toBeVisible({ timeout: 20000 });
    await ctx(page, row);
    await item(page, 'fileHistory').click();

    // 새 조회가 아니라 이미 있는 path 필터다 (FR-GIT-129).
    await expect(page.locator('#area .pn-body .git-view.vis')).toHaveClass(/git-history/);
    await expect(hist(page).locator('.git-hist-f[data-f="path"]')).toHaveValue('tracked.txt', {
      timeout: 20000,
    });
    // 그 경로를 건드린 커밋만 남는다 — basic 은 init 하나뿐이다.
    await expect(hist(page).locator('.git-hist-row[data-oid]')).toHaveCount(1, { timeout: 20000 });
  });

  // ── FR-GIT-277 / V203 ──

  test('F10 (V203 / FR-GIT-277): 미커밋 행의 Stash 는 생성 다이얼로그를 다시 쓴다', async ({ page }) => {
    const repo = copyFx('basic', 'f10');
    await waitForInit(page);
    await openGit(page, repo);
    await openView(page, 'history', /git-history/);

    const unc = hist(page).locator('.git-hist-row.uncommitted');
    await expect(unc).toBeVisible({ timeout: 20000 });
    await ctx(page, unc);
    await item(page, 'stash').click();

    // 19단계의 생성 다이얼로그 그대로다 — 새로 만들지 않는다.
    await expect(stashCreate(page)).toBeVisible();
    await stashCreate(page).locator('.gsc-msg').fill('미커밋 행에서');
    await stashCreate(page).locator('.git-dialog-go').click();
    await expect(stashCreate(page)).toHaveCount(0, { timeout: 20000 });
    expect(git(repo, 'stash', 'list')).toContain('미커밋 행에서');
  });

  test('F11 (V203 / FR-GIT-277): Reset 은 mixed 다 — index 만 되돌리고 워킹 트리는 남는다', async ({
    page,
  }) => {
    const repo = copyFx('basic', 'f11');
    await waitForInit(page);
    await openGit(page, repo);
    await openView(page, 'history', /git-history/);

    const unc = hist(page).locator('.git-hist-row.uncommitted');
    await expect(unc).toBeVisible({ timeout: 20000 });
    await ctx(page, unc);
    await item(page, 'reset').click();

    // staged 였던 것이 unstaged 로 내려오고, 파일 자체는 사라지지 않는다.
    await expect
      .poll(() => git(repo, 'diff', '--cached', '--name-only'), { timeout: 20000 })
      .toBe('');
    expect(existsSync(join(repo, 'renamed to.txt'))).toBe(true);
    expect(existsSync(join(repo, 'untracked.txt'))).toBe(true);
  });

  test('F12 (V203 / FR-GIT-277): Clean 은 2단계 확인 + `stash push -u` hint 를 준다', async ({ page }) => {
    const repo = copyFx('basic', 'f12');
    await waitForInit(page);
    await openGit(page, repo);
    await openView(page, 'history', /git-history/);

    const unc = hist(page).locator('.git-hist-row.uncommitted');
    await expect(unc).toBeVisible({ timeout: 20000 });
    await ctx(page, unc);
    await item(page, 'clean').click();

    // 파괴적이므로 프레임워크가 2단계로 올린다 (FR-GIT-89·92).
    await expect(confirmBox(page)).toBeVisible();
    await expect(confirmBox(page)).toHaveAttribute('data-stage', '1');
    await expect(confirmBox(page).locator('.gc-targets')).toContainText('untracked.txt');

    await confirmBox(page).locator('.gc-go').click();
    await expect(confirmBox(page)).toHaveAttribute('data-stage', '2');
    // recovery hint 는 2단계의 것이다. 되살릴 수 없으므로 **먼저 담아 두는** 명령이다.
    await expect(confirmBox(page).locator('.gc-hint')).toBeVisible();
    await expect(confirmBox(page).locator('.gc-hint-cmd')).toContainText('git stash push -u');

    await confirmBox(page).locator('.gc-go').click();
    await expect(page.locator('#git-confirm')).toHaveCount(0, { timeout: 20000 });

    // untracked 만 사라지고 tracked 변경은 남는다.
    //
    // **확인 창은 실행보다 먼저 닫힌다** — `GitMenu._pick` 은 확인이 resolve 한 뒤에
    // `run` 을 부른다. 그래서 창이 사라진 것은 시작 신호이지 완료 신호가 아니다.
    await expect.poll(() => existsSync(join(repo, 'untracked.txt')), { timeout: 15000 }).toBe(false);
    expect(git(repo, 'diff', '--name-only')).toContain('tracked.txt');
  });

  test('F13 (V203 / FR-GIT-277): Clean 은 confirm 없이 실행되지 않는다 — 서버가 마지막 방어선이다', async ({
    page,
  }) => {
    const repo = copyFx('basic', 'f13');
    await waitForInit(page);
    await openGit(page, repo);

    const res = (await page.evaluate(
      async (r) => {
        const out = await fetch('/api/git/uncommitted/clean', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ repo: r }),
        });
        return { code: out.status, body: await out.json() };
      },
      repo,
    )) as { code: number; body: { error?: string } };

    expect(res.code).toBe(400);
    expect(res.body.error).toBe('confirmation_required');
    expect(existsSync(join(repo, 'untracked.txt'))).toBe(true);
  });
});

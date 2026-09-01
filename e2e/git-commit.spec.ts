import { execFileSync } from 'child_process';
import { realpathSync } from 'fs';
import { join } from 'path';

import { Page } from '@playwright/test';

import { test, expect, makeCopyFx, waitForInit } from './fixtures';

// GIT_M2_STEP1011_CONTRACT §3 — 커밋 클라이언트. 검증 V33·V35·V36
// (E3·E4·E5·E6·E7·E9 + FR-GIT-74).

const FIXTURES = '/tmp/dm-git-fx-commit-' + process.pid;

test.beforeAll(() => {
  execFileSync('bash', ['e2e/git_fixture.sh', FIXTURES], { stdio: 'ignore' });
});
test.afterAll(() => {
  execFileSync('bash', ['e2e/git_fixture.sh', '--clean', FIXTURES], { stdio: 'ignore' });
});

const fx = (name: string) => realpathSync(join(FIXTURES, name));

const copyFx = makeCopyFx(FIXTURES);
const commits = (repo: string) =>
  Number(execFileSync('git', ['-C', repo, 'rev-list', '--count', 'HEAD'], { encoding: 'utf8' }).trim());
const head = (repo: string) =>
  execFileSync('git', ['-C', repo, 'log', '-1', '--pretty=%B'], { encoding: 'utf8' }).trim();

async function openGit(page: Page, repo: string) {
  await page.evaluate((r) => (window as any).app.openGitWindow(r), repo);
  await expect(page.locator('#area .pn-body .git-view.vis')).toHaveClass(/git-changes/);
  await expect(msg(page)).toBeEnabled({ timeout: 10000 });
}

const changes = (page: Page) => page.locator('#area .pn-body .git-view.git-changes');
const commit = (page: Page) => changes(page).locator('.git-commit');
const msg = (page: Page) => commit(page).locator('.git-commit-msg');
const btn = (page: Page) => commit(page).locator('.git-commit-btn');
const why = (page: Page) => commit(page).locator('.git-commit-why');
const toast = (page: Page) => page.locator('#git-undo');

// 커밋 응답의 undoToken 은 화면에 없다 — 응답에서 직접 받는다 (FR-GIT-81).
async function clickCommit(page: Page) {
  const wait = page.waitForResponse(
    (r) => r.url().includes('/api/git/commit') && r.request().method() === 'POST',
    { timeout: 15000 },
  );
  await btn(page).click();
  const res = await wait;
  return { status: res.status(), body: await res.json() };
}

test.describe('묶음 I — 커밋 (클라이언트)', () => {
  test('E3 (V33): draft 가 새로고침 후 보존되고 핀을 지우지 않는다', async ({ page, request }) => {
    const repo = fx('basic');
    const text = 'e3 작성 중인 메시지\n두 번째 줄';
    await waitForInit(page);
    await openGit(page, repo);

    // 핀을 먼저 만든다 — draft 저장이 git.pinned 를 지우지 않는지 함께 본다 (O1·O6).
    await page.evaluate((r) => (window as any).app._gitPin(r), repo);
    await msg(page).fill(text);
    // 입력이 멈춘 뒤 300ms 디바운스로 저장한다.
    await page.waitForFunction(
      (r) => {
        const g = (window as any).app.ws.git;
        return !!(g && g.drafts && g.drafts[r as string]);
      },
      repo,
      { timeout: 5000 },
    );
    await page.evaluate(() => (window as any).app._save());

    // 서버에 실제로 남았고, 같은 git 객체의 핀도 그대로다.
    const st = await (await request.get('/api/workspace')).json();
    expect(st.git.drafts[repo]).toBe(text);
    expect(st.git.pinned, 'draft 저장이 핀을 지웠다').toContain(repo);

    await page.reload();
    await page.waitForSelector('#area .pn-body .git-view.git-changes .git-commit-msg',
      { timeout: 15000 });
    await expect(msg(page)).toHaveValue(text);
    // 새로고침 뒤에도 핀은 남아 있다.
    expect(await page.evaluate(() => (window as any).app.ws.git.pinned)).toContain(repo);
  });

  test('E4 (V33): amend 토글 왕복이 메시지를 손실 없이 되돌린다', async ({ page }) => {
    const repo = fx('basic');
    await waitForInit(page);
    await openGit(page, repo);

    await msg(page).fill('e4 내가 쓰던 메시지');
    const amend = commit(page).locator('.git-commit-amend input');
    await amend.check();
    // 직전 커밋 메시지로 채운다 (FR-GIT-78).
    await expect(msg(page)).toHaveValue('init', { timeout: 10000 });

    await amend.uncheck();
    await expect(msg(page)).toHaveValue('e4 내가 쓰던 메시지');
  });

  test('E5 (V33): 커밋을 못 누르는 사유가 보인다', async ({ page }) => {
    const repo = fx('basic');
    await waitForInit(page);
    await openGit(page, repo);

    // 메시지가 비었다 (FR-GIT-84).
    await expect(btn(page)).toBeDisabled();
    await expect(why(page)).toBeVisible();
    await expect(why(page)).toHaveText('커밋 메시지를 입력하세요');
    await expect(btn(page)).toHaveAttribute('title', '커밋 메시지를 입력하세요');

    // staged 가 있고 메시지가 있으면 누를 수 있다.
    await msg(page).fill('e5');
    await expect(btn(page)).toBeEnabled();
    await expect(why(page)).toBeHidden();

    // 공백만 있는 메시지는 빈 메시지다.
    await msg(page).fill('   ');
    await expect(btn(page)).toBeDisabled();
  });

  test('E5b (V33): staged 가 없으면 그 사유를 보인다', async ({ page }) => {
    const repo = fx('detached'); // 변경이 하나도 없는 저장소
    await waitForInit(page);
    await openGit(page, repo);

    await msg(page).fill('e5b');
    await expect(btn(page)).toBeDisabled();
    await expect(why(page)).toContainText('staged 변경이 없습니다');
  });

  test('E6 (V35): 커밋 후 5초 안에 undo 가 동작하고 5초 뒤 진입점이 사라진다', async ({ page }) => {
    const repo = copyFx('basic', 'e6');
    const before = commits(repo);
    await waitForInit(page);
    await openGit(page, repo);

    await msg(page).fill('e6 첫 커밋');
    const res = await clickCommit(page);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(commits(repo)).toBe(before + 1);
    // FR-GIT-80: 입력을 비운다.
    await expect(msg(page)).toHaveValue('');
    await expect(toast(page)).toBeVisible();

    // FR-GIT-82: 상태와 메시지를 커밋 직전으로 되돌린다.
    await toast(page).locator('.git-undo-btn').click();
    await expect(toast(page)).toHaveCount(0);
    await expect(msg(page)).toHaveValue('e6 첫 커밋', { timeout: 10000 });
    expect(commits(repo)).toBe(before);

    // FR-GIT-83: 5초가 지나면 진입점이 DOM 에서 사라진다.
    await msg(page).fill('e6 두 번째 커밋');
    const res2 = await clickCommit(page);
    expect(res2.status, JSON.stringify(res2.body)).toBe(200);
    await expect(toast(page)).toBeVisible();
    await expect(toast(page)).toHaveCount(0, { timeout: 10000 });
    expect(commits(repo)).toBe(before + 1);
    expect(head(repo)).toBe('e6 두 번째 커밋');
  });

  test('E7 (V35): 진입점이 사라진 뒤에는 API 직접 호출도 409 다', async ({ page, request }) => {
    const repo = copyFx('basic', 'e7');
    const before = commits(repo);
    await waitForInit(page);
    await openGit(page, repo);

    await msg(page).fill('e7 커밋');
    const res = await clickCommit(page);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const token = res.body.undoToken as string;
    expect(token).toBeTruthy();

    // 토스트가 사라지는 것과 서버 토큰의 만료가 같은 5초다 — 두 겹으로 막힌다.
    await expect(toast(page)).toHaveCount(0, { timeout: 10000 });
    const undo = await request.post('/api/git/undo-last', { data: { repo, undoToken: token } });
    expect(undo.status()).toBe(409);
    expect((await undo.json()).error).toBe('undo_expired');
    // 커밋은 그대로 남는다 — 만료된 undo 는 실행되지 않았다.
    expect(commits(repo)).toBe(before + 1);
  });

  test('E9 (V36): identity 가 없으면 커밋이 차단되고 Fix 가 보인다', async ({ page }) => {
    const repo = copyFx('no-identity', 'e9');
    // 전역 설정에 흔들리지 않게 리포에서 빈 값으로 못박는다 — preflight 는
    // `git config --get` 의 값을 본다.
    execFileSync('git', ['-C', repo, 'config', 'user.name', '']);
    execFileSync('git', ['-C', repo, 'config', 'user.email', '']);
    const before = commits(repo);
    await waitForInit(page);
    await openGit(page, repo);

    await msg(page).fill('e9 막혀야 하는 커밋');
    const res = await clickCommit(page);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('preflight_blocked');

    // FR-GIT-88: 무엇이 왜 막혔고 어떻게 푸는지를 함께 보인다.
    const pf = commit(page).locator('.git-preflight');
    await expect(pf).toBeVisible();
    const block = pf.locator('.git-preflight-block[data-code="identity_missing"]');
    await expect(block).toBeVisible();
    await expect(block.locator('.git-preflight-reason')).toContainText('user.name');
    await expect(block.locator('.git-preflight-cmd')).toContainText('git config');
    // Fix 는 복사할 수 있다.
    await expect(block.locator('.git-preflight-copy')).toBeVisible();

    // **커밋이 만들어지지 않는다.**
    expect(commits(repo)).toBe(before);
    // 메시지는 남아 있다 — 막힌 커밋이 입력을 버리지 않는다.
    await expect(msg(page)).toHaveValue('e9 막혀야 하는 커밋');
  });

  test('E12 (FR-GIT-79): Commit ▾ 옵션 3개는 기본 off 이고 커밋 뒤 기억되지 않는다', async ({ page }) => {
    const repo = copyFx('basic', 'e12');
    await waitForInit(page);
    await openGit(page, repo);

    const menu = commit(page).locator('.git-commit-menu');
    await expect(menu).toBeHidden();
    await commit(page).locator('.git-commit-more').click();
    await expect(menu).toBeVisible();
    const opts = menu.locator('.git-commit-opt');
    await expect(opts).toHaveCount(3);
    // 기본은 전부 off 다.
    expect(await opts.locator('input').evaluateAll(
      (els) => els.every((e) => !(e as HTMLInputElement).checked))).toBe(true);

    await menu.locator('.git-commit-opt[data-opt="noVerify"] input').check();
    await msg(page).fill('e12 no-verify 커밋');
    const res = await clickCommit(page);
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    // **no-verify 가 기억되면 훅이 조용히 계속 꺼진다** — 커밋 뒤 다시 off 다.
    await commit(page).locator('.git-commit-more').click();
    await expect(menu.locator('.git-commit-opt[data-opt="noVerify"] input')).not.toBeChecked();
    // localStorage 에도 남지 않는다.
    const ls = await page.evaluate(() => JSON.stringify(localStorage));
    expect(ls).not.toContain('noVerify');
  });

  test('E13 (FR-GIT-76): commit.template 이 초기 내용으로 채워지고 draft 를 덮지 않는다', async ({ page }) => {
    const repo = copyFx('basic', 'e13');
    execFileSync('bash', ['-c', `printf 'tmpl: 제목\\n\\n본문\\n' > ${JSON.stringify(repo)}/.gitmessage`]);
    execFileSync('git', ['-C', repo, 'config', 'commit.template', '.gitmessage']);
    await waitForInit(page);
    await openGit(page, repo);

    await expect(msg(page)).toHaveValue(/tmpl: 제목/, { timeout: 10000 });

    // draft 가 있으면 덮지 않는다 — 새로고침 뒤에도 사용자가 쓴 것이 남는다.
    await msg(page).fill('e13 사용자가 쓴 것');
    await page.waitForFunction(
      (r) => {
        const g = (window as any).app.ws.git;
        return !!(g && g.drafts && g.drafts[r as string]);
      },
      repo,
      { timeout: 5000 },
    );
    await page.evaluate(() => (window as any).app._save());
    await page.reload();
    await page.waitForSelector('#area .pn-body .git-view.git-changes .git-commit-msg',
      { timeout: 15000 });
    await expect(msg(page)).toHaveValue('e13 사용자가 쓴 것');
  });

  test('E14 (V61 / FR-GIT-85): GPG 서명이 활성이면 그 사실을 보인다', async ({ page }) => {
    const repo = copyFx('basic', 'e14');
    execFileSync('git', ['-C', repo, 'config', 'commit.gpgsign', 'true']);
    await waitForInit(page);
    await openGit(page, repo);
    await expect(commit(page).locator('.git-commit-gpg')).toHaveText('서명 커밋', { timeout: 10000 });
  });

  test('E15 (FR-GIT-87): detached HEAD 의 커밋은 막지 않고 먼저 경고한다', async ({ page }) => {
    const repo = copyFx('detached', 'e15');
    execFileSync('bash', ['-c', `printf 'x\\n' > ${JSON.stringify(repo)}/e15.txt`]);
    execFileSync('git', ['-C', repo, 'add', 'e15.txt']);
    const before = commits(repo);
    await waitForInit(page);
    await openGit(page, repo);

    await msg(page).fill('e15 detached 커밋');
    await btn(page).click();

    // 막지 않되 결과를 명시적으로 알린다 — 파괴적이 아니므로 1단계다.
    const box = page.locator('#git-confirm .gc-box');
    await expect(box).toBeVisible({ timeout: 10000 });
    await expect(box.locator('.gc-head')).toHaveText('이 커밋은 어느 브랜치에도 속하지 않습니다');
    await expect(box.locator('.gc-go')).toHaveText('Run');
    await box.locator('.gc-cancel').click();
    await expect(box).toHaveCount(0);
    expect(commits(repo), '취소했는데 커밋이 만들어졌다').toBe(before);
    await expect(msg(page)).toHaveValue('e15 detached 커밋');

    const res = await (async () => {
      const wait = page.waitForResponse(
        (r) => r.url().includes('/api/git/commit') && r.request().method() === 'POST',
        { timeout: 15000 },
      );
      await btn(page).click();
      await page.locator('#git-confirm .gc-go').click();
      const r = await wait;
      return { status: r.status(), body: await r.json() };
    })();
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(commits(repo)).toBe(before + 1);
  });

  test('E11 (FR-GIT-74): 입력에 따라 높이가 늘고 상한에서 멈추며 드래그로 조정된다', async ({ page }) => {
    const repo = fx('basic');
    await waitForInit(page);
    await openGit(page, repo);

    const h = () => msg(page).evaluate((el) => el.getBoundingClientRect().height);
    const base = await h();

    await msg(page).fill('1\n2\n3\n4\n5\n6');
    const grown = await h();
    expect(grown, 'auto-grow 가 동작하지 않았다').toBeGreaterThan(base);

    // 상한(12줄)을 넘으면 내부 스크롤로 넘긴다.
    await msg(page).fill(Array.from({ length: 40 }, (_, i) => 'line ' + i).join('\n'));
    const capped = await h();
    expect(capped).toBeLessThan(base + 40 * 17);
    expect(await msg(page).evaluate((el) => el.scrollHeight > el.clientHeight),
      '상한을 넘겼는데 내부 스크롤이 없다').toBe(true);

    // 경계 드래그. 결과는 기기별로 localStorage 에 남는다.
    await msg(page).fill('x');
    const small = await h();
    // hover() 로 누른다 — 그것이 요소의 안정(actionability)을 기다린 뒤 그 위로
    // 마우스를 옮긴다. 앞의 fill() 이 auto-grow 로 높이를 줄이므로 핸들이 위로
    // 움직이는데, boundingBox() 를 먼저 읽고 그 좌표로 누르면 부하가 높을 때
    // 반영이 늦어 빗나간다. 그리고 이동은 여러 걸음으로 나눈다 — 한 번의 순간
    // 이동은 mousemove 를 한 번만 내고, 사람의 드래그와도 다르다.
    const handle = commit(page).locator('.git-commit-resize');
    await handle.hover();
    const bar = (await handle.boundingBox())!;
    await page.mouse.down();
    await page.mouse.move(bar.x + bar.width / 2, bar.y + bar.height / 2 + 60, { steps: 6 });
    await page.mouse.up();
    const dragged = await h();
    expect(dragged, '드래그가 높이를 바꾸지 않았다').toBeGreaterThan(small + 30);
    expect(await page.evaluate(() => localStorage.getItem('gitCommitHeight'))).toBeTruthy();
  });
});

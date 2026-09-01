import { execFileSync } from 'child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { Page } from '@playwright/test';

import { test, expect, makeCopyFx, waitForInit, GIT_VIEW_TABS } from './fixtures';

// GIT_ACTIONS_SRS §3.2 · §3.5 — 묶음 B 브랜치 동작 (FR-GIT-253~259 · 268).
// 검증 V177~V186 · V195.
//
// 접수한 말의 본체다: "branch 삭제, 이름변경 등 기본적인 기능들이 없다."
//
// 쓰기를 하는 스펙은 **복사본**에서 돈다 — 원본을 옮기면 뒤따르는 스펙이 다른
// 저장소를 본다 (git-branches.spec.ts 와 같은 규약). 충돌로 멈춘 저장소는 그 상태로
// 남는 것이 목적이므로 픽스처를 공유하지 않고 테스트마다 자기 것을 만든다
// (git-operation.spec.ts 의 repoWithConflictedMerge 와 같은 근거).

const FIXTURES = '/tmp/dm-git-fx-bra-' + process.pid;

test.beforeAll(() => {
  execFileSync('bash', ['e2e/git_fixture.sh', FIXTURES], { stdio: 'ignore' });
});
test.afterAll(() => {
  execFileSync('bash', ['e2e/git_fixture.sh', '--clean', FIXTURES], { stdio: 'ignore' });
});

const copyFx = makeCopyFx(FIXTURES);
const git = (repo: string, ...args: string[]) =>
  execFileSync('git', ['-C', repo, ...args]).toString().trim();

// 셸에서 그대로 실행할 수 있는 recovery hint 를 되돌림에 쓴다 — hint 가 **실제로
// 되살리는지**는 그것을 돌려 봐야만 알 수 있다 (FR-GIT-92, V179·V184).
function runHint(repo: string, cmd: string) {
  const parts = cmd.trim().split(/\s+/);
  expect(parts[0], 'hint 가 git 명령이 아니다: ' + cmd).toBe('git');
  return git(repo, ...parts.slice(1));
}

// 충돌하는 머지를 만들어 **멈춘 채로** 남긴다 (git-operation.spec.ts 와 같은 방식).
function repoWithConflictedMerge(tag: string) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'dm-git-bra-' + tag + '-')));
  git(dir, 'init', '-q', '-b', 'main', '.');
  git(dir, 'config', 'user.name', 'Fixture');
  git(dir, 'config', 'user.email', 'fixture@example.invalid');
  git(dir, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(dir, 'f.txt'), 'base\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'init');
  git(dir, 'checkout', '-q', '-b', 'side');
  writeFileSync(join(dir, 'f.txt'), 'side\n');
  git(dir, 'commit', '-qam', 'side');
  git(dir, 'checkout', '-q', 'main');
  writeFileSync(join(dir, 'f.txt'), 'main\n');
  git(dir, 'commit', '-qam', 'main');
  try {
    git(dir, 'merge', 'side');
  } catch {
    /* 의도한 충돌 — 이 픽스처의 목적이다 */
  }
  return dir;
}

// 충돌 **직전** 까지만 만든 저장소. 같은 줄이 갈라져 있으므로 머지하면 반드시 멈춘다.
function repoWithDivergedSide(tag: string) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'dm-git-bra-' + tag + '-')));
  git(dir, 'init', '-q', '-b', 'main', '.');
  git(dir, 'config', 'user.name', 'Fixture');
  git(dir, 'config', 'user.email', 'fixture@example.invalid');
  git(dir, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(dir, 'f.txt'), 'base\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'init');
  git(dir, 'checkout', '-q', '-b', 'side');
  writeFileSync(join(dir, 'f.txt'), 'side\n');
  git(dir, 'commit', '-qam', 'side');
  git(dir, 'checkout', '-q', 'main');
  writeFileSync(join(dir, 'f.txt'), 'main\n');
  git(dir, 'commit', '-qam', 'main');
  return dir;
}

async function openBranches(page: Page, repo: string) {
  await page.evaluate((r) => (window as any).app.openGitWindow(r), repo);
  await expect(page.locator('#area .pn-tab[data-git-view]')).toHaveCount(GIT_VIEW_TABS);
  await page.click('#area .pn-tab[data-git-view="branches"]');
  await expect(page.locator('#area .pn-body .git-view.vis')).toHaveClass(/git-branches/);
}

async function openChanges(page: Page, repo: string) {
  await page.evaluate((r) => (window as any).app.openGitWindow(r), repo);
  await expect(page.locator('#area .pn-body .git-view.vis')).toHaveClass(/git-changes/);
}

const br = (page: Page) => page.locator('#area .pn-body .git-view.git-branches');
const rows = (page: Page) => br(page).locator('.git-br-row');
const row = (page: Page, short: string) => br(page).locator(`.git-br-row[data-short="${short}"]`);
const menu = (page: Page) => page.locator('.git-menu');
const item = (page: Page, id: string) => menu(page).locator(`.git-menu-item[data-id="${id}"]`);
const confirm = (page: Page) => page.locator('#git-confirm .gc-box');
const choice = (page: Page) => page.locator('#git-choice .gch-box');
const rename = (page: Page) => page.locator('#git-br-rename .gbr-box');
const mergeBox = (page: Page) => page.locator('#git-br-merge .gbm-box');
const upstreamBox = (page: Page) => page.locator('#git-br-upstream .gbu-box');
const branchOf = (page: Page) =>
  page.evaluate(() => ((window as any).app.gitPanel.statusOf() || {}).branch || '');
const opKind = (page: Page) =>
  page.evaluate(() => (((window as any).app.gitPanel.statusOf() || {}).operation || {}).kind || '');

async function waitRefs(page: Page, min = 1) {
  await expect.poll(() => rows(page).count(), { timeout: 20000 }).toBeGreaterThanOrEqual(min);
}

// 파괴적 확인을 끝까지 진행한다. **한 번** 눌러야 실행되는 것이 요구사항이다
// (CONFIRM_ONE_STAGE_SRS FR-COS-1) — 그 사실 자체를 보는 테스트는 각자 따로
// 단언한다.
async function passConfirm(page: Page) {
  await expect(confirm(page)).toBeVisible({ timeout: 15000 });
  await confirm(page).locator('.gc-go').click();
  await expect(page.locator('#git-confirm')).toHaveCount(0, { timeout: 20000 });
}

test.describe('묶음 B — 브랜치 동작 (V177~V186 · V195)', () => {
  const dirs: string[] = [];
  test.afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  test('BR1 (V178 / FR-GIT-253): rename 이 목록·상태·status.branch 에 반영된다', async ({ page }) => {
    const repo = copyFx('with-remote', 'br1');
    await waitForInit(page);
    await openBranches(page, repo);
    await waitRefs(page, 2);

    await row(page, 'no-upstream').click({ button: 'right' });
    await item(page, 'rename').click();

    await expect(rename(page)).toBeVisible({ timeout: 15000 });
    // 처음 값은 현재 이름이다 — 그대로 두면 "이미 있다"로 실행이 막힌다.
    await expect(rename(page).locator('.gbr-name')).toHaveValue('no-upstream');
    await expect(rename(page).locator('.gbr-go')).toBeDisabled({ timeout: 15000 });

    // 이미 있는 이름은 **실행 전에** 거부된다 (생성과 같은 자리를 쓴다).
    await rename(page).locator('.gbr-name').fill('main');
    await expect(rename(page).locator('.gbr-why')).toHaveAttribute('data-why', 'exists',
      { timeout: 15000 });
    await expect(rename(page).locator('.gbr-go')).toBeDisabled();

    await rename(page).locator('.gbr-name').fill('renamed');
    await expect(rename(page).locator('.gbr-go')).toBeEnabled({ timeout: 15000 });
    await rename(page).locator('.gbr-go').click();

    await expect.poll(() => git(repo, 'branch', '--list', 'renamed'), { timeout: 20000 })
      .not.toBe('');
    expect(git(repo, 'branch', '--list', 'no-upstream')).toBe('');
    await expect(row(page, 'renamed')).toHaveCount(1, { timeout: 15000 });
    await expect(row(page, 'no-upstream')).toHaveCount(0);
  });

  test('BR2 (V178 / FR-GIT-253): 현재 브랜치의 rename 은 status.branch 를 따라 바꾼다', async ({ page }) => {
    const repo = copyFx('with-remote', 'br2');
    await waitForInit(page);
    await openBranches(page, repo);
    await waitRefs(page, 2);

    await row(page, 'main').click({ button: 'right' });
    await item(page, 'rename').click();
    await expect(rename(page)).toBeVisible({ timeout: 15000 });
    await rename(page).locator('.gbr-name').fill('trunk');
    await expect(rename(page).locator('.gbr-go')).toBeEnabled({ timeout: 15000 });
    await rename(page).locator('.gbr-go').click();

    await expect.poll(() => git(repo, 'branch', '--show-current'), { timeout: 20000 }).toBe('trunk');
    // 관측이 따라와야 한다 — 화면만 바뀐 것이 아니다 (FR-GIT-253).
    await expect.poll(() => branchOf(page), { timeout: 20000 }).toBe('trunk');
    await expect(row(page, 'trunk')).toHaveClass(/current/, { timeout: 15000 });
  });

  test('BR3 (V179 / FR-GIT-254·250.2): `-d` 는 확인을 거치고 hint 로 되살아난다', async ({ page }) => {
    const repo = copyFx('with-remote', 'br3');
    // main 에 합쳐진 브랜치를 만든다 — `-d` 가 받아들이는 상태다.
    git(repo, 'branch', 'merged-topic', 'main');
    const oid = git(repo, 'rev-parse', 'merged-topic');
    await waitForInit(page);
    await openBranches(page, repo);
    await waitRefs(page, 3);

    await row(page, 'merged-topic').click({ button: 'right' });
    await item(page, 'delete').click();

    // 한 화면이 대상과 hint 를 함께 보인다 (FR-COS-2).
    await expect(confirm(page)).toBeVisible({ timeout: 15000 });
    await expect(confirm(page)).toHaveAttribute('data-stage', '1');
    await expect(confirm(page).locator('.gc-target')).toHaveText('merged-topic');
    // 기본 포커스는 취소다 (FR-GIT-97·176).
    await expect(confirm(page).locator('.gc-cancel')).toBeFocused();

    // hint 는 **지우기 전 oid** 로 만든 되살릴 명령이다 (FR-GIT-250.2).
    const cmd = (await confirm(page).locator('.gc-hint-cmd').textContent())!.trim();
    expect(cmd).toContain(oid);
    expect(cmd).toContain('git branch merged-topic');

    await confirm(page).locator('.gc-go').click();
    await expect.poll(() => git(repo, 'branch', '--list', 'merged-topic'), { timeout: 20000 })
      .toBe('');
    await expect(row(page, 'merged-topic')).toHaveCount(0, { timeout: 15000 });

    // hint 의 명령으로 **실제로 되살아난다** — 안내문만이면 되살릴 수 없다.
    runHint(repo, cmd);
    expect(git(repo, 'rev-parse', 'merged-topic')).toBe(oid);
  });

  test('BR4 (V180 / FR-GIT-254): 미머지 `-d` 는 실패가 아니라 `-D` 로 올릴 선택지다', async ({ page }) => {
    const repo = copyFx('with-remote', 'br4');
    // no-upstream 에는 main 에 없는 커밋이 있다 — `git branch -d` 가 거부한다.
    await waitForInit(page);
    await openBranches(page, repo);
    await waitRefs(page, 2);

    await row(page, 'no-upstream').click({ button: 'right' });
    await item(page, 'delete').click();
    await passConfirm(page);

    // 거부는 실패로 끝나지 않는다 — 서버가 준 순서 그대로의 선택지가 뜬다.
    await expect(choice(page)).toBeVisible({ timeout: 20000 });
    const opts = choice(page).locator('.gch-opt');
    await expect(opts).toHaveCount(2);
    await expect(opts.nth(0)).toHaveAttribute('data-opt', 'force_delete');
    await expect(opts.nth(1)).toHaveAttribute('data-opt', 'cancel');
    // 기본은 취소다 (O14).
    await expect(choice(page).locator('.gch-opt[data-opt="cancel"]')).toBeFocused();
    // 아직 지워지지 않았다 — 선택지를 보이는 동안 저장소는 그대로다.
    expect(git(repo, 'branch', '--list', 'no-upstream')).not.toBe('');

    await opts.nth(0).click();
    await expect.poll(() => git(repo, 'branch', '--list', 'no-upstream'), { timeout: 20000 })
      .toBe('');
  });

  test('BR5 (V181 / FR-GIT-254): 현재 브랜치는 삭제 항목이 비활성이고 사유가 보인다', async ({ page }) => {
    const repo = copyFx('with-remote', 'br5');
    await waitForInit(page);
    await openBranches(page, repo);
    await waitRefs(page, 2);

    await row(page, 'main').click({ button: 'right' });
    await expect(item(page, 'delete')).toHaveClass(/disabled/);
    // 왜 못 누르는지 보이지 않으면 사용자는 고장으로 읽는다 (FR-GIT-180).
    await expect(item(page, 'delete')).toHaveAttribute('title', /현재 브랜치/);
    // rename 은 현재 브랜치에도 열려 있다 (FR-GIT-253).
    await expect(item(page, 'rename')).not.toHaveClass(/disabled/);
    await page.keyboard.press('Escape');

    // 원격 ref 에서는 로컬 전용 항목이 전부 비활성이고 사유가 다르다.
    git(repo, 'push', '-q', 'origin', 'no-upstream:feat');
    git(repo, 'fetch', '-q', 'origin');
    await page.evaluate(() => (window as any).app.gitPanel.refresh());
    await expect(row(page, 'origin/feat')).toHaveCount(1, { timeout: 20000 });
    await row(page, 'origin/feat').click({ button: 'right' });
    for (const id of ['delete', 'rename', 'push', 'upstream-set']) {
      await expect(item(page, id), id + ' 가 원격 ref 에서 열려 있다').toHaveClass(/disabled/);
      await expect(item(page, id)).toHaveAttribute('title', /로컬 브랜치/);
    }
  });

  test('BR6 (V181 / FR-GIT-254): 다중 선택 일괄 삭제는 `-D` 를 제공하지 않는다', async ({ page }) => {
    const repo = copyFx('with-remote', 'br6');
    git(repo, 'branch', 'topic-a', 'main');   // 합쳐졌다
    git(repo, 'branch', 'topic-b', 'no-upstream'); // 합쳐지지 않았다
    await waitForInit(page);
    await openBranches(page, repo);
    await waitRefs(page, 4);

    // Cmd/Ctrl + 클릭으로 둘을 고른다 — 고른 것이 눈에 보여야 한다.
    await row(page, 'topic-a').click({ modifiers: ['ControlOrMeta'] });
    await row(page, 'topic-b').click({ modifiers: ['ControlOrMeta'] });
    await expect(row(page, 'topic-a')).toHaveClass(/sel/);
    await expect(row(page, 'topic-b')).toHaveClass(/sel/);

    await row(page, 'topic-a').click({ button: 'right' });
    await item(page, 'delete').click();
    // 1단계 목록이 **고른 것 전부**를 보인다 — 보이는 것과 지워지는 것이 같아야 한다.
    await expect(confirm(page)).toBeVisible({ timeout: 15000 });
    await expect(confirm(page).locator('.gc-target')).toHaveCount(2);
    await passConfirm(page);

    // topic-b 가 미머지이므로 선택지가 뜨는데, **`-D` 는 없다** — 확인 하나가 여러
    // 개를 강제 삭제하는 자리를 만들지 않는다.
    await expect(choice(page)).toBeVisible({ timeout: 20000 });
    await expect(choice(page).locator('.gch-opt[data-opt="force_delete"]')).toHaveCount(0);
    await expect(choice(page).locator('.gch-opt[data-opt="cancel"]')).toHaveCount(1);
    // 아무것도 지워지지 않았다.
    expect(git(repo, 'branch', '--list', 'topic-a')).not.toBe('');
    expect(git(repo, 'branch', '--list', 'topic-b')).not.toBe('');
  });

  test('BR7 (V182 / FR-GIT-255): merge 다이얼로그가 영향 범위를 실행 전에 보인다', async ({ page }) => {
    const repo = repoWithDivergedSide('br7');
    dirs.push(repo);
    // 갈라지지 않은 브랜치도 하나 둔다 — ff 문구와 구분되어야 한다.
    git(repo, 'branch', 'ahead-only', 'main');
    git(repo, 'checkout', '-q', 'ahead-only');
    writeFileSync(join(repo, 'g.txt'), 'x\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'ahead');
    git(repo, 'checkout', '-q', 'main');

    await waitForInit(page);
    await openBranches(page, repo);
    await waitRefs(page, 3);

    // ff 로 끝나는 대상: 들어올 커밋 수와 "머지 커밋이 생기지 않습니다"가 함께 보인다.
    await row(page, 'ahead-only').click({ button: 'right' });
    await item(page, 'merge').click();
    await expect(mergeBox(page)).toBeVisible({ timeout: 15000 });
    const note = mergeBox(page).locator('.gbm-note');
    await expect(note).toContainText('fast-forward');
    await expect(note).toContainText('1개');
    // 방식은 넷이고 첫 선택지가 기본이며 그것이 git 의 기본이다 (FR-GIT-173).
    await expect(mergeBox(page).locator('input[data-key="mode"]')).toHaveCount(4);
    await expect(mergeBox(page).locator('input[data-key="mode"]').first()).toBeChecked();
    await page.keyboard.press('Escape');

    // 갈라진 대상: 머지 커밋이 생긴다는 사실과 양쪽 개수가 보인다.
    await row(page, 'side').click({ button: 'right' });
    await item(page, 'merge').click();
    await expect(mergeBox(page)).toBeVisible({ timeout: 15000 });
    await expect(mergeBox(page).locator('.gbm-note')).toContainText('갈라져');
    await page.keyboard.press('Escape');
    // 다이얼로그를 여는 것만으로 저장소가 바뀌지 않는다.
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(git(repo, 'rev-parse', 'main'));
  });

  test('BR8 (V182 / FR-GIT-255): squash 를 고르면 그 방식으로 실행된다', async ({ page }) => {
    const repo = repoWithDivergedSide('br8');
    dirs.push(repo);
    git(repo, 'branch', '-D', 'side');
    git(repo, 'checkout', '-q', '-b', 'side', 'main');
    writeFileSync(join(repo, 'g.txt'), 'one\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 's1');
    writeFileSync(join(repo, 'g.txt'), 'two\n');
    git(repo, 'commit', '-qam', 's2');
    git(repo, 'checkout', '-q', 'main');
    const before = git(repo, 'rev-parse', 'HEAD');

    await waitForInit(page);
    await openBranches(page, repo);
    await waitRefs(page, 2);

    await row(page, 'side').click({ button: 'right' });
    await item(page, 'merge').click();
    await expect(mergeBox(page)).toBeVisible({ timeout: 15000 });
    await mergeBox(page).locator('input[data-key="mode"][value="squash"]').check();
    await mergeBox(page).locator('.gbm-go').click();

    // squash 는 커밋을 만들지 않고 index 에만 얹는다 — HEAD 가 그대로여야 한다.
    await expect.poll(() => git(repo, 'status', '--porcelain'), { timeout: 20000 }).not.toBe('');
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(before);
  });

  test('BR9 (V183 / FR-GIT-255·251): 충돌 merge 는 실패가 아니라 진행 중 상태다', async ({ page }) => {
    const repo = repoWithDivergedSide('br9');
    dirs.push(repo);
    await waitForInit(page);
    await openBranches(page, repo);
    await waitRefs(page, 2);

    await row(page, 'side').click({ button: 'right' });
    await item(page, 'merge').click();
    await expect(mergeBox(page)).toBeVisible({ timeout: 15000 });
    await mergeBox(page).locator('.gbm-go').click();

    // 관측이 진행 중을 싣고(FR-GIT-251) 화면은 Changes 탭으로 옮겨 간다 (FR-GIT-111).
    await expect.poll(() => opKind(page), { timeout: 20000 }).toBe('merge');
    await expect(page.locator('#area .pn-body .git-view.vis')).toHaveClass(/git-changes/,
      { timeout: 15000 });
    await expect(page.locator('#area .pn-body .git-changes .git-op-bar')).toBeVisible();
    // 충돌 그룹이 펼쳐져 있다 — 해결 진입점이 접힌 채면 갈 곳이 없다.
    const conflicts = page.locator('#area .pn-body .git-changes .git-group[data-group="conflicts"]');
    await expect(conflicts).not.toHaveClass(/collapsed/, { timeout: 15000 });
    await expect(conflicts.locator('.git-file')).toHaveCount(1, { timeout: 15000 });
  });

  test('BR10 (V177 / FR-GIT-252): 진행 중이면 merge·rebase 가 비활성이고 사유가 보인다', async ({ page }) => {
    const repo = repoWithConflictedMerge('br10');
    dirs.push(repo);
    await waitForInit(page);
    await openChanges(page, repo);
    await expect.poll(() => opKind(page), { timeout: 20000 }).toBe('merge');

    await page.click('#area .pn-tab[data-git-view="branches"]');
    await waitRefs(page, 2);
    await row(page, 'side').click({ button: 'right' });

    // 새 작업을 시작하는 항목만 막힌다 — 사유는 진행 중인 작업의 이름을 담는다.
    // BRANCH_MENU_UNIFY_SRS FR-BMU-1: 옛 `remote-pull` 은 `merge` 에 합쳐졌다.
    for (const id of ['merge', 'rebase']) {
      await expect(item(page, id), id + ' 가 진행 중인데도 열려 있다').toHaveClass(/disabled/);
      await expect(item(page, id)).toHaveAttribute('title', /머지가 진행 중/);
    }
    // 진행 중과 무관한 항목은 그대로 열려 있다 — 전부 막으면 갈 곳이 없다.
    await expect(item(page, 'copy-name')).not.toHaveClass(/disabled/);
  });

  test('BR11 (V184 / FR-GIT-256): rebase 는 확인을 거치고 hint 로 되돌아간다', async ({ page }) => {
    const repo = repoWithDivergedSide('br11');
    dirs.push(repo);
    // 충돌 없이 얹히도록 다른 파일만 고친 side 를 다시 만든다.
    git(repo, 'branch', '-D', 'side');
    git(repo, 'checkout', '-q', '-b', 'side', 'main');
    writeFileSync(join(repo, 'g.txt'), 'side-only\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'side-only');
    git(repo, 'checkout', '-q', 'main');
    writeFileSync(join(repo, 'h.txt'), 'main-only\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'main-only');
    const before = git(repo, 'rev-parse', 'HEAD');

    await waitForInit(page);
    await openBranches(page, repo);
    await waitRefs(page, 2);

    await row(page, 'side').click({ button: 'right' });
    await item(page, 'rebase').click();

    await expect(confirm(page)).toBeVisible({ timeout: 15000 });
    await expect(confirm(page)).toHaveAttribute('data-stage', '1');
    // hint 는 rebase 전 HEAD 로 되돌리는 명령이다 (FR-GIT-250.2).
    const cmd = (await confirm(page).locator('.gc-hint-cmd').textContent())!.trim();
    expect(cmd).toBe('git reset --hard ' + before);
    await confirm(page).locator('.gc-go').click();

    await expect.poll(() => git(repo, 'rev-parse', 'HEAD'), { timeout: 20000 }).not.toBe(before);
    // hint 로 **실제로** 돌아온다.
    runHint(repo, cmd);
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(before);
  });

  test('BR12 (V185 / FR-GIT-257): upstream set/unset 이 목록의 표시와 ahead/behind 에 반영된다', async ({ page }) => {
    const repo = copyFx('with-remote', 'br12');
    await waitForInit(page);
    await openBranches(page, repo);
    await waitRefs(page, 3);

    // 처음에는 upstream 이 없다 — 그 자리가 비어 있다 (FR-GIT-153).
    await expect(row(page, 'no-upstream').locator('.git-br-up')).toHaveText('');
    // 열어 둔 메뉴는 목록 폴링이 닫는다 (GitMenu 는 scroll 을 capture 로 듣고,
    // 재렌더가 스크롤을 복원한다). 사람은 닫히면 다시 우클릭하므로, 검사도
    // 상자가 뜰 때까지 다시 연다 — 한 번의 클릭에 기대면 폴링과 겹치는
    // 회차에서만 무너진다.
    await expect(async () => {
      await row(page, 'no-upstream').click({ button: 'right' });
      await expect(item(page, 'upstream-unset')).toHaveClass(/disabled/);
      await expect(item(page, 'upstream-unset')).toHaveAttribute('title', /upstream/);
      await item(page, 'upstream-set').click();
      await expect(upstreamBox(page)).toBeVisible({ timeout: 3000 });
    }).toPass({ timeout: 30000 });
    // 목록에 없는 이름은 실행 전에 막힌다 — 후보는 이미 받아 둔 원격 ref 다.
    await upstreamBox(page).locator('.gbu-up').fill('origin/nope');
    await expect(upstreamBox(page).locator('.gbu-go')).toBeDisabled();
    await upstreamBox(page).locator('.gbu-up').fill('origin/main');
    await expect(upstreamBox(page).locator('.gbu-go')).toBeEnabled();
    await upstreamBox(page).locator('.gbu-go').click();

    // `rev-parse ...@{upstream}` 은 upstream 이 **없으면 0 이 아닌 코드로 끝난다.**
    // 아직 붙기 전에는 그것이 정상인데, `expect.poll` 은 콜백이 던지면 재시도하지
    // 않고 그 자리에서 실패한다 — 폴링이 첫 회차에 무너졌다. for-each-ref 는 같은
    // 값을 내면서 없을 때 빈 문자열과 exit 0 을 준다.
    await expect.poll(
      () => git(repo, 'for-each-ref', '--format=%(upstream:short)', 'refs/heads/no-upstream'),
      { timeout: 20000 }).toBe('origin/main');
    await expect(row(page, 'no-upstream').locator('.git-br-up')).toHaveText('(origin/main)',
      { timeout: 15000 });
    // ahead/behind 가 그 upstream 기준으로 선다 (FR-GIT-153).
    await expect(row(page, 'no-upstream').locator('.git-br-ab')).not.toHaveText('');

    // unset 은 파괴적이 아니다 — 확인 없이 바로 지나가고 표시가 사라진다.
    await expect(async () => {
      await row(page, 'no-upstream').click({ button: 'right' });
      await expect(item(page, 'upstream-unset')).not.toHaveClass(/disabled/);
      await item(page, 'upstream-unset').click();
      await expect(row(page, 'no-upstream').locator('.git-br-up')).toHaveText('', { timeout: 5000 });
    }).toPass({ timeout: 30000 });
    await expect(row(page, 'no-upstream').locator('.git-br-ab')).toHaveText('');
  });

  test('BR13 (V186 / FR-GIT-258): upstream 없는 브랜치의 push 는 publish 임을 실행 전에 알린다', async ({ page }) => {
    const repo = copyFx('with-remote', 'br13');
    await waitForInit(page);
    await openBranches(page, repo);
    await waitRefs(page, 3);

    // **대상이 현재 브랜치가 아니다** — main 이 현재이고 no-upstream 을 민다.
    expect(git(repo, 'branch', '--show-current')).toBe('main');
    await row(page, 'no-upstream').click({ button: 'right' });
    await item(page, 'push').click();

    // 무엇이 설정되는지가 대상에 보인다 (FR-GIT-100).
    await expect(confirm(page)).toBeVisible({ timeout: 15000 });
    await expect(confirm(page)).toHaveAttribute('data-stage', '1');
    await expect(confirm(page).locator('.gc-target')).toContainText('no-upstream');
    // 취소하면 아무것도 밀지 않는다 — 기본은 안전한 쪽이다 (O14).
    await page.keyboard.press('Escape');
    await expect(page.locator('#git-confirm')).toHaveCount(0, { timeout: 10000 });
    expect(git(repo, 'branch', '-r', '--list', 'origin/no-upstream')).toBe('');

    await row(page, 'no-upstream').click({ button: 'right' });
    await item(page, 'push').click();
    await expect(confirm(page)).toBeVisible({ timeout: 15000 });
    await confirm(page).locator('.gc-go').click();

    // 원격 작업이므로 job 경로를 탄다 — 진행이 Changes 탭의 `.git-job` 에 보인다.
    // upstream 이 아직 없으면 git 이 **실패로** 답한다 — `expect.poll` 은 예외를
    // 재시도가 아니라 실패로 읽으므로, 없음을 값으로 바꿔 준다.
    await expect.poll(() => {
      try {
        return git(repo, 'rev-parse', '--abbrev-ref', 'no-upstream@{upstream}');
      } catch {
        return '';
      }
    }, { timeout: 30000 }).toBe('origin/no-upstream');
  });

  test('BR14 (V195 / FR-GIT-268): 원격 브랜치의 세 항목이 각각 동작한다', async ({ page }) => {
    const repo = copyFx('with-remote', 'br14');
    git(repo, 'push', '-q', 'origin', 'no-upstream:feat');
    git(repo, 'fetch', '-q', 'origin');
    git(repo, 'branch', '-D', 'no-upstream');
    const oid = git(repo, 'rev-parse', 'origin/feat');
    await waitForInit(page);
    await openBranches(page, repo);
    await waitRefs(page, 3);

    // ① Fetch into local — 같은 이름의 로컬 ref 를 만든다.
    await row(page, 'origin/feat').click({ button: 'right' });
    await item(page, 'remote-fetch').click();
    await expect.poll(() => git(repo, 'branch', '--list', 'feat'), { timeout: 30000 }).not.toBe('');
    expect(git(repo, 'rev-parse', 'feat')).toBe(oid);

    // ② Merge into current — 그 원격 ref 를 현재 브랜치에 합치는 자리로 간다
    // (영향 범위 포함). BRANCH_MENU_UNIFY_SRS FR-BMU-1 로 옛 `remote-pull` 이
    // `merge` 에 합쳐졌다 — **검증의 뜻은 그대로다** (§5.1).
    await row(page, 'origin/feat').click({ button: 'right' });
    await item(page, 'merge').click();
    await expect(mergeBox(page)).toBeVisible({ timeout: 15000 });
    await expect(mergeBox(page).locator('.gbm-note')).toContainText('origin/feat');
    await page.keyboard.press('Escape');

    // ③ Delete remote branch — 파괴적이며 hint 는 **되살리는 push** 다.
    await row(page, 'origin/feat').click({ button: 'right' });
    await item(page, 'remote-delete').click();
    await expect(confirm(page)).toBeVisible({ timeout: 15000 });
    await expect(confirm(page)).toHaveAttribute('data-stage', '1');
    const cmd = (await confirm(page).locator('.gc-hint-cmd').textContent())!.trim();
    expect(cmd).toBe('git push origin ' + oid + ':refs/heads/feat');
    await confirm(page).locator('.gc-go').click();

    await expect.poll(() => git(repo, 'ls-remote', '--heads', 'origin', 'feat'),
      { timeout: 30000 }).toBe('');
    // hint 로 원격에 다시 선다.
    runHint(repo, cmd);
    expect(git(repo, 'ls-remote', '--heads', 'origin', 'feat')).toContain(oid);
  });

  test('BR15 (FR-GIT-259): Create Branch from 은 커밋 메뉴와 같은 다이얼로그를 연다', async ({ page }) => {
    const repo = copyFx('with-remote', 'br15');
    const start = git(repo, 'rev-parse', 'no-upstream');
    await waitForInit(page);
    await openBranches(page, repo);
    await waitRefs(page, 2);

    await row(page, 'no-upstream').click({ button: 'right' });
    await item(page, 'branch-from').click();

    const create = page.locator('#git-br-create .gbc-box');
    await expect(create).toBeVisible({ timeout: 15000 });
    // 시작점이 그 ref 로 **고정돼** 열린다 — 사용자가 다시 적지 않는다.
    await expect(create.locator('.gbc-start')).toHaveValue('no-upstream');
    await create.locator('.gbc-name').fill('from-branch');
    await expect(create.locator('.gbc-go')).toBeEnabled({ timeout: 15000 });
    await create.locator('.gbc-go').click();

    await expect.poll(() => git(repo, 'branch', '--list', 'from-branch'), { timeout: 20000 })
      .not.toBe('');
    expect(git(repo, 'rev-parse', 'from-branch')).toBe(start);
  });
});

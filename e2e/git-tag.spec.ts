import { execFileSync } from 'child_process';
import { realpathSync, rmSync } from 'fs';
import { join } from 'path';

import { Page } from '@playwright/test';

import { test, expect, makeCopyFx, waitForInit, GIT_VIEW_TABS } from './fixtures';

// GIT_ACTIONS_SRS §3.3 — 묶음 C 태그 동작. 검증 V187~V190 (FR-GIT-260~262).
//
// V187·V188 의 **argv·이름 검증 절반은 Go 단위 테스트**가 본다
// (internal/webserver/domain/git/write/tag_test.go, gitapi/handlers_git_tag_test.go).
// 여기서는 화면이 그 표면을 제대로 부르는지 — 종류별로 다른 요청이 나가는지, 중복이
// 실행 전에 막히는지, 삭제 둘이 서로를 겸하지 않는지, push 가 job 경로를 타는지 —
// 를 본다.
//
// 아래 선택자는 구현 소스를 직접 읽어 확인한 것이다(추측이 아니다):
//   태그 행       Branches 탭의 `.git-br-row[data-kind="tag"]` (branches.js:227-228).
//                 우클릭이 `GitMenu.open('tag', ref, ev)` 를 연다(branches.js:266-269).
//   메뉴          `.git-menu` / 항목은 `.git-menu-item[data-id]` (menu.js:_pick 경로).
//                 **확인은 항목이 구현하지 않는다** — `destructive:true` 인 항목은
//                 GitConfirm 확인을 프레임워크가 거친다(menu.js:_pick).
//   생성 다이얼로그 GitDialog.open({id:'git-tag-create',ns:'gtc'}) → 컨테이너는
//                 `#git-tag-create`, 상자 `.gtc-box`, 필드 `.gtc-name`·`.gtc-ref`·
//                 `.gtc-kind`(라디오)·`.gtc-msg`, 실행 `.gtc-go`, 사유 `.gtc-why`
//                 (dialog.js:150-172 의 ns 치환 규약). **일반 GitDialog 라 1클릭이면
//                 실행된다**(GitConfirm 을 지나지 않는다).
//   파괴적 확인    `#git-confirm .gc-box`/`.gc-go`/`.gc-cancel` — `tag_delete` 와
//                 `remote_ref_delete` 는 서버의 파괴적 목록(/api/git/policy)에 있으므로
//                 확인을 거친다. **걸음은 하나이며 `.gc-go` 한 번이 실행이다**
//                 (CONFIRM_ONE_STAGE_SRS FR-COS-1).
//   job 표시      Changes 탭의 `.git-job` — 태그 push 는 기존 원격 job 경로를 그대로
//                 탄다(FR-GIT-262·101~104, remote.js:_attach).

const FIXTURES = '/tmp/dm-git-fx-tag-' + process.pid;

test.beforeAll(() => {
  execFileSync('bash', ['e2e/git_fixture.sh', FIXTURES], { stdio: 'ignore' });
});
test.afterAll(() => {
  execFileSync('bash', ['e2e/git_fixture.sh', '--clean', FIXTURES], { stdio: 'ignore' });
});

const copyFx = makeCopyFx(FIXTURES);
// with-remote 픽스처는 bare origin 을 가진다 — 그 원격은 로컬 경로이므로 push 가
// 네트워크 없이 실제로 끝난다(FR-GIT-104 의 인증 안내 경로를 건드리지 않는다).
// 원격 경로가 복사본 밖(FIXTURES/remote.git)을 가리키므로 원격도 함께 복사해
// 각 테스트가 자기 원격만 건드리게 한다.
function copyRepoWithRemote(tag: string) {
  const repo = copyFx('with-remote', tag);
  const bare = join(FIXTURES, 'copy-' + tag + '-remote.git');
  rmSync(bare, { recursive: true, force: true });
  execFileSync('cp', ['-R', join(FIXTURES, 'remote.git'), bare]);
  execFileSync('git', ['-C', repo, 'remote', 'set-url', 'origin', bare], { stdio: 'pipe' });
  return { repo, bare: realpathSync(bare) };
}

const git = (repo: string, ...args: string[]) =>
  execFileSync('git', ['-C', repo, ...args]).toString().trim();

const tagList = (repo: string) =>
  git(repo, 'tag', '-l').split('\n').map((s) => s.trim()).filter(Boolean);

async function openBranches(page: Page, repo: string) {
  await page.evaluate((r: string) => (window as any).app.openGitWindow(r), repo);
  // REPO_TAB_UNIFY_SRS: 창의 모양이 바뀌었다 — `Changes` 는 **사이드**에 살고
  // 나머지 여섯 뷰는 **본문 탭**으로 필요할 때 열린다 (FR-RTU-30·32). 스펙들이
  // "탭을 클릭한다" 로 뷰를 고르므로 여기서 여섯을 미리 세운다.
  await page.waitForSelector('#area .ed-win .ed-side', { timeout: 15000 });
  await page.evaluate(() => {
    const a = (window as any).app;
    a._edSetSide(a._aw(), 'changes');
    const p = a.gitPanel;
    for (const v of ['diff', 'history', 'branches', 'stash', 'console', 'worktrees']) p.openView(v);
  });
  // FR-GIT-28(개정): 고정 탭은 7개다.
  await expect(page.locator('#area .pn-tab[data-git-view]')).toHaveCount(GIT_VIEW_TABS);
  await page.click('#area .pn-tab[data-git-view="branches"]');
  await expect(page.locator('#area .pn-body .git-view.vis')).toHaveClass(/git-branches/);
}

const br = (page: Page) => page.locator('#area .pn-body .git-view.git-branches');
const tagRow = (page: Page, short: string) =>
  br(page).locator(`.git-br-row[data-kind="tag"][data-short="${short}"]`);
const menu = (page: Page) => page.locator('.git-menu');
const item = (page: Page, id: string) => menu(page).locator(`.git-menu-item[data-id="${id}"]`);
const dlg = (page: Page) => page.locator('#git-tag-create .gtc-box');
const confirmBox = (page: Page) => page.locator('#git-confirm .gc-box');

// 태그 행의 우클릭 메뉴를 연다. 목록이 아직 안 왔을 수 있으므로 행을 기다린다.
async function openTagMenu(page: Page, short: string) {
  const row = tagRow(page, short);
  await expect(row, `태그 행 ${short} 가 목록에 없다`).toHaveCount(1, { timeout: 15000 });
  await row.click({ button: 'right' });
  await expect(menu(page), '태그 메뉴가 열리지 않았다').toBeVisible({ timeout: 5000 });
}

test.describe('묶음 C — 태그 생성 (FR-GIT-260)', () => {
  // V187: lightweight·annotated·signed 의 argv 가 다르고, 메시지는 annotated·signed
  // 에만 붙는다. **화면이 보내는 요청**으로 그것을 본다 — argv 자체는 Go 단위가
  // 보므로 여기서는 kind·message 가 종류대로 실려 나가는지가 판정이다.
  test('V187 (FR-GIT-260): 종류마다 다른 요청이 나가고 메시지는 annotated·signed 에만 실린다', async ({ page }) => {
    const repo = copyFx('basic', 'v187');
    const sent: Array<Record<string, unknown>> = [];
    await page.route('**/api/git/tag', async (route) => {
      sent.push(route.request().postDataJSON());
      await route.continue();
    });

    await waitForInit(page);
    await openBranches(page, repo);

    // ① lightweight — 메시지를 적어도 실리지 않는다 (뜻이 없다).
    // 다이얼로그의 promise 는 **닫힐 때 resolve 한다** — 기다리면 여는 쪽에서 멈춘다.
    await page.evaluate(() => { void (window as any).app.gitPanel.createTag(''); });
    await expect(dlg(page), '태그 생성 대화상자가 없다').toHaveCount(1, { timeout: 5000 });
    await dlg(page).locator('.gtc-name').fill('v-light');
    await dlg(page).locator('.gtc-msg').fill('무시되어야 한다');
    // 이름 검사는 왕복이므로 실행 버튼이 열릴 때까지 기다린다 (FR-GIT-250.3).
    await expect(dlg(page).locator('.gtc-go')).toBeEnabled({ timeout: 10000 });
    await dlg(page).locator('.gtc-go').click();
    await expect(page.locator('#git-tag-create')).toHaveCount(0, { timeout: 10000 });

    // ② annotated — 메시지가 실린다.
    // 다이얼로그의 promise 는 **닫힐 때 resolve 한다** — 기다리면 여는 쪽에서 멈춘다.
    await page.evaluate(() => { void (window as any).app.gitPanel.createTag(''); });
    await expect(dlg(page)).toHaveCount(1, { timeout: 5000 });
    await dlg(page).locator('.gtc-name').fill('v-annot');
    await dlg(page).locator('.gtc-kind[value="annotated"]').check();
    await dlg(page).locator('.gtc-msg').fill('릴리스 메모');
    await expect(dlg(page).locator('.gtc-go')).toBeEnabled({ timeout: 10000 });
    await dlg(page).locator('.gtc-go').click();
    await expect(page.locator('#git-tag-create')).toHaveCount(0, { timeout: 10000 });

    expect(sent.length, `보낸 요청 = ${JSON.stringify(sent)}`).toBe(2);
    expect(sent[0], 'lightweight 에 종류·메시지가 실렸다')
      .toMatchObject({ name: 'v-light', kind: '', message: '' });
    expect(sent[1], 'annotated 에 메시지가 안 실렸다')
      .toMatchObject({ name: 'v-annot', kind: 'annotated', message: '릴리스 메모' });

    // 실제로 만들어졌고 종류가 다르다 — lightweight 는 커밋을, annotated 는 태그
    // 객체를 가리킨다.
    expect(tagList(repo).sort()).toEqual(['v-annot', 'v-light']);
    expect(git(repo, 'cat-file', '-t', 'refs/tags/v-light')).toBe('commit');
    expect(git(repo, 'cat-file', '-t', 'refs/tags/v-annot')).toBe('tag');
    expect(git(repo, 'tag', '-l', '-n1', 'v-annot')).toContain('릴리스 메모');
  });

  // V188: 이름 검증이 `check-ref-format` 을 지나고 중복은 **실행 전에** 거부된다.
  // "실행 전"이 판정이므로 POST /api/git/tag 가 아예 나가지 않는 것을 본다.
  test('V188 (FR-GIT-260·250.3): 규칙 위반과 중복은 실행 전에 막힌다 — 요청조차 나가지 않는다', async ({ page }) => {
    const repo = copyFx('basic', 'v188');
    execFileSync('git', ['-C', repo, 'tag', 'v1.0'], { stdio: 'pipe' });

    let posted = 0;
    await page.route('**/api/git/tag', async (route) => {
      posted++;
      await route.continue();
    });

    await waitForInit(page);
    await openBranches(page, repo);

    // 다이얼로그의 promise 는 **닫힐 때 resolve 한다** — 기다리면 여는 쪽에서 멈춘다.
    await page.evaluate(() => { void (window as any).app.gitPanel.createTag(''); });
    await expect(dlg(page)).toHaveCount(1, { timeout: 5000 });
    const why = dlg(page).locator('.gtc-why');
    const go = dlg(page).locator('.gtc-go');

    // ① 규칙 위반 — git 이 판정한다(`bad name` 은 ref 이름이 될 수 없다).
    await dlg(page).locator('.gtc-name').fill('bad name');
    await expect(why, '규칙 위반 사유가 안 보인다').toBeVisible({ timeout: 10000 });
    await expect(go, '규칙 위반인데 실행이 열려 있다').toBeDisabled();

    // ② 중복 — 규칙 위반과 **다른 사유**여야 사용자가 무엇을 할지 안다.
    await dlg(page).locator('.gtc-name').fill('v1.0');
    await expect(why).toHaveAttribute('data-why', 'exists', { timeout: 10000 });
    await expect(go, '중복인데 실행이 열려 있다').toBeDisabled();

    // ③ annotated 인데 메시지가 없으면 그것도 막힌다 (FR-GIT-260).
    await dlg(page).locator('.gtc-name').fill('v2.0');
    await expect(go, '쓸 수 있는 이름인데 실행이 안 열린다').toBeEnabled({ timeout: 10000 });
    await dlg(page).locator('.gtc-kind[value="annotated"]').check();
    await expect(why).toHaveAttribute('data-why', 'message');
    await expect(go, '메시지 없는 annotated 인데 실행이 열려 있다').toBeDisabled();

    expect(posted, '막혔는데 서버로 요청이 나갔다').toBe(0);
    expect(tagList(repo), '막혔는데 태그가 생겼다').toEqual(['v1.0']);
  });

  // 커밋 메뉴의 진입점 — **같은 다이얼로그**를 대상만 고정해 연다.
  test('V187 (FR-GIT-260): 커밋 메뉴의 Create Tag 는 대상을 그 커밋으로 고정해 연다', async ({ page }) => {
    const repo = copyFx('basic', 'v187-commit');
    const head = git(repo, 'rev-parse', 'HEAD');

    await waitForInit(page);
    await page.evaluate((r: string) => (window as any).app.openGitWindow(r), repo);
  // REPO_TAB_UNIFY_SRS: 창의 모양이 바뀌었다 — `Changes` 는 **사이드**에 살고
  // 나머지 여섯 뷰는 **본문 탭**으로 필요할 때 열린다 (FR-RTU-30·32). 스펙들이
  // "탭을 클릭한다" 로 뷰를 고르므로 여기서 여섯을 미리 세운다.
  await page.waitForSelector('#area .ed-win .ed-side', { timeout: 15000 });
  await page.evaluate(() => {
    const a = (window as any).app;
    a._edSetSide(a._aw(), 'changes');
    const p = a.gitPanel;
    for (const v of ['diff', 'history', 'branches', 'stash', 'console', 'worktrees']) p.openView(v);
  });
    await expect(page.locator('#area .pn-tab[data-git-view]')).toHaveCount(GIT_VIEW_TABS);

    // 커밋 메뉴는 History 의 행에서 열린다. 메뉴 프레임워크의 항목만 보면 되므로
    // 합성 대상으로 연다 — 메뉴는 좌표만 쓴다(menu.js: "합성 객체로도 열 수 있어야
    // 검증이 프레임워크만 볼 수 있다", V52 의 선례).
    await page.evaluate((oid) => {
      (window as any).GitMenu.open('commit',
        { oid, abbrev: oid.slice(0, 7), subject: 'init' },
        { clientX: 10, clientY: 10 });
    }, head);
    await expect(item(page, 'tag-from'), '커밋 메뉴에 태그 생성 항목이 없다').toHaveCount(1);
    await item(page, 'tag-from').click();

    await expect(dlg(page), '태그 생성 대화상자가 없다').toHaveCount(1, { timeout: 5000 });
    await expect(dlg(page).locator('.gtc-ref'), '대상이 그 커밋으로 고정되지 않았다')
      .toHaveValue(head);
  });
});

test.describe('묶음 C — 태그 삭제 (FR-GIT-261)', () => {
  // V189: 로컬 삭제와 원격 삭제가 **다른 항목**이고 각각 확인을 거친다.
  // 하나가 다른 하나를 하지 않는다 — 그것이 이 테스트의 본체다.
  test('V189 (FR-GIT-261): 로컬 삭제와 원격 삭제는 다른 항목이고 각각 확인을 거친다 · 하나가 다른 하나를 하지 않는다', async ({ page }) => {
    const { repo, bare } = copyRepoWithRemote('v189');
    execFileSync('git', ['-C', repo, 'tag', '-a', '-m', '릴리스', 'v1.0'], { stdio: 'pipe' });
    execFileSync('git', ['-C', repo, 'push', '-q', 'origin', 'v1.0'], { stdio: 'pipe' });
    expect(tagList(bare), '원격에 태그가 안 올라갔다').toContain('v1.0');

    const hit = { local: 0, remote: 0 };
    await page.route('**/api/git/tag/delete', async (route) => {
      hit.local++; await route.continue();
    });
    await page.route('**/api/git/tag/delete-remote', async (route) => {
      hit.remote++; await route.continue();
    });

    await waitForInit(page);
    await openBranches(page, repo);

    // ① 두 항목이 **따로** 있다.
    await openTagMenu(page, 'v1.0');
    await expect(item(page, 'delete'), '로컬 삭제 항목이 없다').toHaveCount(1);
    await expect(item(page, 'delete-remote'), '원격 삭제 항목이 없다').toHaveCount(1);

    // ② 로컬 삭제 — 파괴적이므로 확인이 뜬다. 취소하면 아무 일도 없다.
    await item(page, 'delete').click();
    await expect(confirmBox(page), '삭제 확인 대화상자가 없다').toBeVisible({ timeout: 5000 });
    await page.locator('#git-confirm .gc-cancel').click();
    await expect(page.locator('#git-confirm')).toHaveCount(0);
    expect(hit.local, '취소했는데 요청이 나갔다').toBe(0);
    expect(tagList(repo), '취소했는데 지워졌다').toContain('v1.0');

    // 이번엔 끝까지 — `tag_delete` 는 파괴적이지만 확인은 한 걸음이다.
    await openTagMenu(page, 'v1.0');
    await item(page, 'delete').click();
    await expect(confirmBox(page)).toBeVisible({ timeout: 5000 });
    // 그 한 화면이 recovery hint 를 보인다 — **되살리는 명령**이고 지우기 전 oid 를
    // 싣는다 (FR-GIT-92·250.2, FR-COS-2).
    const oid = git(repo, 'rev-parse', 'refs/tags/v1.0');
    await expect(page.locator('#git-confirm .gc-hint'), 'recovery hint 에 지우기 전 oid 가 없다')
      .toContainText(oid, { timeout: 5000 });
    await page.locator('#git-confirm .gc-go').click();
    await expect(page.locator('#git-confirm'), '성공했는데 확인 상자가 안 닫혔다')
      .toHaveCount(0, { timeout: 10000 });

    await expect.poll(() => tagList(repo), { timeout: 10000 }).not.toContain('v1.0');
    // **원격은 그대로다** — 로컬 삭제가 원격 삭제를 하지 않는다.
    expect(tagList(bare), '로컬 삭제가 원격까지 지웠다').toContain('v1.0');
    expect(hit.remote, '로컬 삭제가 원격 라우트를 불렀다').toBe(0);
    expect(hit.local).toBe(1);
  });

  test('V189 (FR-GIT-261): 원격 삭제는 원격만 지운다 — 로컬은 그대로 남는다', async ({ page }) => {
    const { repo, bare } = copyRepoWithRemote('v189-remote');
    execFileSync('git', ['-C', repo, 'tag', 'v1.0'], { stdio: 'pipe' });
    execFileSync('git', ['-C', repo, 'push', '-q', 'origin', 'v1.0'], { stdio: 'pipe' });

    let localHit = 0;
    await page.route('**/api/git/tag/delete', async (route) => {
      localHit++; await route.continue();
    });

    await waitForInit(page);
    await openBranches(page, repo);
    await openTagMenu(page, 'v1.0');
    await item(page, 'delete-remote').click();

    // `remote_ref_delete` 도 파괴적 목록에 있다 — 확인 한 걸음을 거친다.
    await expect(confirmBox(page), '원격 삭제 확인 대화상자가 없다').toBeVisible({ timeout: 5000 });
    await page.locator('#git-confirm .gc-go').click();

    // 원격 작업이므로 job 경로다 — 끝나야 원격에서 사라진다.
    await expect.poll(() => tagList(bare), { timeout: 20000 }).not.toContain('v1.0');
    // **로컬은 그대로다** — 원격 삭제가 로컬 삭제를 하지 않는다.
    expect(tagList(repo), '원격 삭제가 로컬까지 지웠다').toContain('v1.0');
    expect(localHit, '원격 삭제가 로컬 라우트를 불렀다').toBe(0);
  });
});

test.describe('묶음 C — 태그 push (FR-GIT-262)', () => {
  // V190: 태그 push 가 job 경로를 타서 **진행·취소가 보인다.** 진행 표시가 없으면
  // 사용자는 분 단위 작업이 멈춘 것으로 읽는다.
  test('V190 (FR-GIT-262): 태그 push 가 job 경로를 탄다 — 진행·취소가 보이고 원격에 올라간다', async ({ page }) => {
    const { repo, bare } = copyRepoWithRemote('v190');
    execFileSync('git', ['-C', repo, 'tag', 'v9.0'], { stdio: 'pipe' });
    expect(tagList(bare), '원격에 이미 태그가 있다').not.toContain('v9.0');

    let jobBody: Record<string, unknown> | undefined;
    await page.route('**/api/git/tag/push', async (route) => {
      jobBody = route.request().postDataJSON();
      await route.continue();
    });

    await waitForInit(page);
    await openBranches(page, repo);
    await openTagMenu(page, 'v9.0');
    await expect(item(page, 'push'), 'push 항목이 없다').toHaveCount(1);
    // push 는 파괴적이 아니다 — 확인 없이 바로 실행된다(원격에 없던 ref 를 더할 뿐).
    await item(page, 'push').click();

    // 즉시 응답이 작업 식별자다 (FR-GIT-102) — 화면은 그것으로 job 에 붙는다.
    await expect.poll(() => jobBody, { timeout: 10000 }).toBeTruthy();
    expect(jobBody, 'push 요청이 태그 하나를 지목하지 않았다').toMatchObject({ name: 'v9.0' });
    // 원격 이름은 클라이언트가 정하지 않는다 (FR-GIT-100 과 같은 규약).
    expect(jobBody!.remote, '클라이언트가 원격 이름을 정했다').toBeUndefined();

    // 진행·취소 자리는 Changes 탭의 job 상자다 — 태그 push 도 같은 자리를 쓴다.
    await page.click('#area .pn-tab[data-git-view="changes"]');
    await expect(page.locator('.git-view.git-changes .git-job'), 'job 상자가 없다')
      .toHaveCount(1, { timeout: 10000 });

    await expect.poll(() => tagList(bare), { timeout: 20000 }).toContain('v9.0');
  });

  test('V190 (FR-GIT-262): Push all tags 는 --tags 로 전부를 민다', async ({ page }) => {
    const { repo, bare } = copyRepoWithRemote('v190-all');
    execFileSync('git', ['-C', repo, 'tag', 'v1.0'], { stdio: 'pipe' });
    execFileSync('git', ['-C', repo, 'tag', 'v2.0'], { stdio: 'pipe' });

    let jobBody: Record<string, unknown> | undefined;
    await page.route('**/api/git/tag/push', async (route) => {
      jobBody = route.request().postDataJSON();
      await route.continue();
    });

    await waitForInit(page);
    await openBranches(page, repo);
    await openTagMenu(page, 'v1.0');
    await item(page, 'push-all').click();

    await expect.poll(() => jobBody, { timeout: 10000 }).toBeTruthy();
    // 이름과 `all` 을 함께 보내면 서버가 무엇을 밀지 가릴 수 없어 거부한다.
    expect(jobBody, '전부 push 인데 이름이 실렸다').toMatchObject({ all: true });
    expect(jobBody!.name, '전부 push 인데 이름이 실렸다').toBeUndefined();

    await expect.poll(() => tagList(bare).sort(), { timeout: 20000 })
      .toEqual(['v1.0', 'v2.0']);
  });
});

import { execFileSync } from 'child_process';
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { APIRequestContext, Page } from '@playwright/test';

import { test, expect, makeCopyFx, waitForInit, GIT_VIEW_TABS } from './fixtures';

// GIT_REVIEW4_SRS §3.6.5 — I7 Worktrees 탭. 검증 V143~V152 (FR-GIT-28 개정·240~245).
// V145·V148·V159 는 Go 단위 테스트다(다른 담당). V153·V154·V157·V160 은 이미 끝났다.
//
// I1~I4(e2e/git-improve.spec.ts)와 다른 파일로 가른 이유: I7 은 별도 하위계(Worktrees
// 탭 하나)이고, 기존 저장소도 서브시스템 하나당 파일 하나 관례다(git-branches.spec.ts·
// git-stash.spec.ts·git-console.spec.ts 등). git-improve.spec.ts 를 계속 키우면 그
// 관례와 어긋난다.
//
// 구현이 이 시점에 올라와 web/js/git/worktrees.js 로 실재한다 — 아래 선택자는 그
// 소스를 직접 읽어 확인한 것이다(추측이 아니다):
//   탭/본문/행/동작    조정자 계약 그대로.
//   .git-wt-main       main worktree 행의 표식 요소, 행에는 .main 클래스도.
//   .git-wt-note[.vis] 안내·사유(.git-wt-note-msg/.git-wt-note-close), 생성 성공 시
//                      "만들어진 경로"가, 제거 실패(dirty 등) 시 사유가 여기 뜬다
//                      (worktrees.js:183-188·244-259).
//   .git-wt-empty[.vis] 빈 목록/로딩/오류.
//   생성 다이얼로그     GitDialog.open({id:'git-wt-create',ns:'gwc',...}) → 컨테이너는
//                      `#git-wt-create`, 상자는 `.gwc-box`, 필드는 `.gwc-name`·
//                      `.gwc-ref`·`.gwc-newbranch`(체크박스), 실행은 `.gwc-go`,
//                      검증 실패 메시지는 `.gwc-why` (dialog.js:150-172 의 ns 치환 규약).
//                      **일반 GitDialog 라 1클릭이면 실행된다** (GitConfirm 을 지나지 않는다).
//   제거 확인          GitDialog.confirm(...) = GitConfirm.open(...) 이므로 기존
//                      #git-confirm .gc-box/.gc-go/.gc-err 그대로다(worktrees.js:229-236,
//                      e2e/git-confirm.spec.ts 의 어휘). **`stages:2` 를 넘겨도 확인은
//                      한 걸음이며 `.gc-go` 한 번이 실행이다**(CONFIRM_ONE_STAGE_SRS
//                      FR-COS-1·2 — 걸음 수는 GitConfirm 이 정한다).
//   목록 재계기        폴링이 없다(worktrees.js:_load 는 mount 시 1회 + reload() 뿐).
//                      유일한 재계기는 I3 새로고침이며 panel.js:1396 이 이미 마운트된
//                      _worktreesView.reload() 를 부른다 — Changes 탭 DOM 안의
//                      .git-head-refresh 를 눌러야 한다(Worktrees 자체엔 새로고침
//                      버튼이 없다).
//   제거 실패          200 으로 온다(removed:false + residue). 4xx 가 아니다.
//   브랜치 삭제 옵션    **이 경로엔 없다** — _runRemove 가 deleteBranch:false 를 항상
//                      보낸다(worktrees.js:238-243, 주석: "파괴적 확인이 옵션 폼을
//                      받지 않는다" — dialog.js:45-46 "옵션 폼을 얹은 파괴적 동작은
//                      아직 없다"). 브랜치 삭제 자리는 Branches 탭이며 이 스펙 범위
//                      밖이다.
//   open 동작          활성 리포 행에는 안 붙는다(worktrees.js:119 `_canOpen`) —
//                      이미 그것이므로 여는 것이 아무 일도 안 한다(FR-GIT-180).

const FIXTURES = '/tmp/dm-git-fx-worktrees-' + process.pid;

test.beforeAll(() => {
  execFileSync('bash', ['e2e/git_fixture.sh', FIXTURES], { stdio: 'ignore' });
});
test.afterAll(() => {
  execFileSync('bash', ['e2e/git_fixture.sh', '--clean', FIXTURES], { stdio: 'ignore' });
});

const copyFx = makeCopyFx(FIXTURES);
async function openGit(page: Page, repo: string) {
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
  // FR-GIT-28(개정): 고정 탭이 Worktrees 를 더해 7개다.
  await expect(page.locator('#area .pn-tab[data-git-view]')).toHaveCount(GIT_VIEW_TABS);
  await expect(page.locator('#area .ed-side .git-view.git-changes')).toBeVisible({ timeout: 10000 });
}

async function openWorktrees(page: Page, repo: string) {
  await openGit(page, repo);
  await page.click('#area .pn-tab[data-git-view="worktrees"]');
  await expect(page.locator('#area .pn-body .git-view.vis')).toHaveClass(/git-worktrees/);
}

// openGitWindow 는 **창**을 활성화할 뿐 탭은 건드리지 않는다 — 이미 열려 있던 Git
// 창을 다시 활성화하면 마지막으로 보던 탭(여기선 worktrees) 그대로다. openGit() 은
// "새 Git 창은 Changes 로 열린다"를 확인하는 용도라 여기 쓰면 그 단정이 깨진다
// (V151 에서 실제로 겪었다 — 터미널 탭으로 Git 창을 벗어났다 돌아오는 자리).
async function backToWorktrees(page: Page, repo: string) {
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
  await page.click('#area .pn-tab[data-git-view="worktrees"]');
  await expect(page.locator('#area .pn-body .git-view.vis')).toHaveClass(/git-worktrees/);
}

const wt = (page: Page) => page.locator('#area .pn-body .git-view.git-worktrees');
const wtRows = (page: Page) => wt(page).locator('.git-wt-row');

// 새로 만든 임시 디렉터리에 git worktree add 로 "바깥 것"을 직접 만든다 — 관리
// 영역(user/run root) 밖이므로 소유는 무조건 outside 다. 서버 API 를 쓰지 않는다.
function addOutsideWorktree(repo: string, name: string, ref = 'main') {
  const dir = mkdtempSync(join(tmpdir(), 'dm-wt-outside-'));
  rmSync(dir, { recursive: true, force: true }); // git worktree add 가 직접 만들게 둔다
  execFileSync('git', ['-C', repo, 'worktree', 'add', '-b', name, dir, ref], { stdio: 'pipe' });
  // 서버가 rev-parse 로 정규화한 값과 비교해야 하므로 여기서도 realpath 한다
  // (macOS 의 /tmp → /private/tmp, e2e/git-changes.spec.ts:25 의 fx() 와 같은 이유).
  return realpathSync(dir);
}

// 실제 Run 오케스트레이션(§3.4, 기존 /api/runs)으로 "Run 것" worktree 를 만든다 —
// I7 의 새 worktree API 가 아니라, 이미 있고 이미 검증된 격리 경로를 그대로 쓴다.
async function addRunWorktree(request: APIRequestContext, repo: string) {
  const started = await request.post('/api/runs', {
    data: { objective: 'e2e git-worktrees', projection: 'inline', isolation: 'per-run', cwd: repo },
  });
  expect(started.ok(), `Run 생성 실패: ${await started.text()}`).toBeTruthy();
  const run = await started.json();
  expect(run.worktree?.path, 'Run 이 worktree 를 안 만들었다').toBeTruthy();
  return run.worktree.path as string;
}

// 사용자 worktree 하나. 목록 비교(V144)가 아닌 제거·동작 테스트(V149~V151)의
// 대상 준비이므로, 이미 구현·단위검증된 생성 API(POST /api/git/worktrees/create)를
// 직접 부른다 — 목록 픽스처 원칙("서버 API로 만들지 마라")은 V144/V146 처럼 목록
// **비교**가 걸린 곳에만 적용했다. 이 API 자체의 정확성은 V147·V148 의 몫이다.
async function createUserWorktree(
  request: APIRequestContext, repo: string, name: string, ref = 'main', newBranch = false,
) {
  const r = await request.post('/api/git/worktrees/create', { data: { repo, name, ref, newBranch } });
  expect(r.ok(), `사용자 worktree 생성 실패: ${await r.text()}`).toBeTruthy();
  return (await r.json()).path as string;
}

test.describe('묶음 M — I7 Worktrees 목록 (FR-GIT-240)', () => {
  test('V144 (FR-GIT-240): 목록이 git worktree list 와 같다 — main worktree 를 포함한다', async ({ page, request }) => {
    const repo = copyFx('basic', 'v144');
    addOutsideWorktree(repo, 'v144-extra');

    // 진실은 이미 구현된 읽기 API(GET /api/git/worktrees, domain/worktree.List 를
    // 그대로 감싼 것)다 — 이 값 자체의 정확성은 Go 단위(V145 인접)가 보장한다.
    // 여기서는 화면이 그 값과 같은지만 본다.
    const truth = await request.get('/api/git/worktrees?repo=' + encodeURIComponent(repo));
    expect(truth.ok(), await truth.text()).toBeTruthy();
    const truthList = (await truth.json()).worktrees as Array<{ path: string; main: boolean }>;
    expect(truthList.length, '픽스처가 2개(main+outside) 미만이다').toBeGreaterThanOrEqual(2);
    expect(truthList.some((e) => e.main), 'API 응답에 main worktree 가 없다').toBe(true);

    await waitForInit(page);
    await openWorktrees(page, repo);

    await expect.poll(() => wtRows(page).count(), { timeout: 15000 }).toBe(truthList.length);

    const shown = await wtRows(page).evaluateAll((els) => els.map((e) => {
      const p = e.querySelector('.git-wt-path') as HTMLElement | null;
      return (p?.getAttribute('title') || p?.textContent || '').trim();
    }));
    for (const e of truthList) {
      expect(shown.some((s) => s === e.path || e.path.endsWith(s) || s.endsWith(e.path)),
        `목록에 ${e.path} 가 없다: ${JSON.stringify(shown)}`).toBe(true);
    }
  });

  // 이 테스트가 **V163 의 e2e 절반**이다(조정자 판단, FR-WKT-13 전제). e2e 환경
  // 자체가 이미 심링크를 지나는 데이터 디렉터리 위에서 돈다 — playwright.config 의
  // E2E_HOME 이 `/tmp/dongminal-e2e-…` 이고 macOS 는 `/tmp` → `/private/tmp` 심링크다.
  // 따로 심링크 픽스처를 만들지 않았다: Run 것(runPath, addRunWorktree)의 소유가
  // `run`(=outside 로 잘못 떨어지지 않음)으로 정확히 나오는 것 자체가 심링크를 지나는
  // 환경에서 `gitWorktreeOwner`(handlers_git_worktree.go)의 소유 판정이 옳다는 증거다.
  test('V146 (FR-GIT-241 · V163): Run 것·바깥 것에 제거 진입점이 없다 — 비활성으로도 보이지 않는다', async ({ page, request }) => {
    const repo = copyFx('basic', 'v146');
    addOutsideWorktree(repo, 'v146-outside');
    const runPath = await addRunWorktree(request, repo);

    await waitForInit(page);
    await openWorktrees(page, repo);

    // main + outside + run = 최소 3행.
    await expect.poll(() => wtRows(page).count(), { timeout: 15000 }).toBeGreaterThanOrEqual(3);

    const rows = await wtRows(page).evaluateAll((els) => els.map((e) => ({
      path: (e.querySelector('.git-wt-path')?.getAttribute('title')
        || e.querySelector('.git-wt-path')?.textContent || '').trim(),
      own: e.querySelector('.git-wt-own')?.getAttribute('data-own') || '',
      hasRemove: !!e.querySelector('.git-wt-act[data-act="remove"]'),
    })));

    const runRow = rows.find((r) => r.own === 'run' || r.path === runPath || runPath.endsWith(r.path));
    const outsideRow = rows.find((r) => r.own === 'outside');
    expect(runRow, `Run 소유 행을 못 찾았다: ${JSON.stringify(rows)}`).toBeTruthy();
    expect(outsideRow, `바깥 소유 행을 못 찾았다: ${JSON.stringify(rows)}`).toBeTruthy();
    // 비활성 버튼조차 없다 — 누를 수 없는 버튼은 고장으로 읽힌다(FR-GIT-180).
    expect(runRow!.hasRemove, 'Run 것에 제거 버튼이 있다(비활성 포함)').toBe(false);
    expect(outsideRow!.hasRemove, '바깥 것에 제거 버튼이 있다(비활성 포함)').toBe(false);
  });

  test('V147 (FR-GIT-242): 이름 + ref 로 생성되고, 경로가 파생 규칙과 같으며 화면에 보인다', async ({ page }) => {
    const repo = copyFx('basic', 'v147');
    await waitForInit(page);
    await openWorktrees(page, repo);

    await wt(page).locator('.git-wt-head .git-wt-add').click();
    const dlg = page.locator('#git-wt-create .gwc-box');
    await expect(dlg, 'worktree 생성 대화상자(#git-wt-create .gwc-box)가 없다').toHaveCount(1, { timeout: 5000 });
    await dlg.locator('.gwc-name').fill('v147-made');
    await dlg.locator('.gwc-ref').fill('main');
    // 새 브랜치 옵션을 켠다 — 안 켜면 'main' 을 그대로 체크아웃하려 드는데, main
    // worktree(repo 자신)가 이미 그 브랜치를 물고 있어 git 이 거부한다(서버가 500
    // + git_failed 로 정직하게 실패한다 — 첫 시도에서 이 자기모순을 직접 겪었다).
    await dlg.locator('.gwc-newbranch').check();
    // 일반 GitDialog 다(GitConfirm 을 지나지 않는다) — 한 번으로 실행된다.
    await dlg.locator('.gwc-go').click();

    const row = wtRows(page).filter({ hasText: 'v147-made' });
    await expect(row, '생성된 worktree 행이 목록에 없다').toHaveCount(1, { timeout: 15000 });

    const path = await row.evaluate((r) => {
      const p = r.querySelector('.git-wt-path') as HTMLElement | null;
      return p?.getAttribute('title') || p?.textContent || '';
    });
    // FR-WKT-13: $DONGMINAL_HOME/git-worktrees/<베이스이름>-<해시8자>/<이름>. 절대
    // 경로 전체를 단정하지 않는다 — $DONGMINAL_HOME 은 이 테스트 프로세스에서 알 수
    // 없다(playwright.config 의 E2E_HOME 은 webServer 프로세스와 다시 계산되어
    // 어긋난다, e2e/skill-contract.spec.ts:671 의 선례와 같은 이유). 파생 규칙의
    // **모양**만 검증한다.
    expect(path, `경로가 파생 규칙(.../<repo>-<hash8>/이름)과 다르다: ${path}`)
      .toMatch(/\/git-worktrees\/[^/]+-[0-9a-f]{8}\/v147-made$/);
    expect(existsSync(path), '만들어진 경로가 실제로 없다').toBe(true);

    // "화면에 보인다" — 안내 자리(worktrees.js:305 GIT_WT_CREATED+path)에도 뜬다.
    await expect(wt(page).locator('.git-wt-note.vis .git-wt-note-msg'), '생성 경로 안내가 안 보인다')
      .toContainText(path);
  });
});

test.describe('묶음 N — I7 Worktrees 제거·동작 (FR-GIT-243·244)', () => {
  test('V149 (FR-GIT-243): 더러운 worktree 제거가 거부되고 사유가 보인다 — 사용자의 작업이 남는다', async ({ page, request }) => {
    const repo = copyFx('basic', 'v149');
    // newBranch:true 가 필요하다 — 'main' 은 이미 main worktree(repo 자신)가 물고
    // 있어서, 새 브랜치 없이 'main' 을 그대로 체크아웃하면 git 이 "이미 다른
    // worktree 가 쓰는 중"이라며 거부한다(같은 브랜치를 두 worktree 가 동시에
    // 체크아웃할 수 없다 — git 고유 제약이지 서버 버그가 아니다).
    const wtPath = await createUserWorktree(request, repo, 'v149-dirty', 'main', true);
    writeFileSync(join(wtPath, 'dirty.txt'), 'uncommitted\n');

    await waitForInit(page);
    await openWorktrees(page, repo);

    const row = wtRows(page).filter({ hasText: 'v149-dirty' });
    await expect(row, '만든 worktree 행이 안 보인다').toHaveCount(1, { timeout: 15000 });
    await row.hover();
    await row.locator('.git-wt-act[data-act="remove"]').click();

    // 파괴적 동작이므로 기존 GitConfirm 규약을 지난다(e2e/git-confirm.spec.ts 의
    // #git-confirm .gc-box·.gc-go 어휘). 확인은 한 걸음이다 (FR-COS-1).
    await expect(page.locator('#git-confirm .gc-box'), '제거 확인 대화상자가 없다')
      .toBeVisible({ timeout: 5000 });
    await page.locator('#git-confirm .gc-go').click();

    // 제거 실패는 200 으로 온다(removed:false + residue, worktrees.js:244-251) —
    // 4xx 가 아니라 뷰 자신의 안내 자리에 사유가 뜬다.
    await expect(wt(page).locator('.git-wt-note.vis'), '실패 사유(.git-wt-note.vis)가 보이지 않는다')
      .toBeVisible({ timeout: 10000 });
    expect(existsSync(wtPath), '더러운 worktree 가 실제로 지워졌다').toBe(true);
    await expect(wtRows(page).filter({ hasText: 'v149-dirty' }), '목록에서도 사라졌다').toHaveCount(1);
  });

  // 스펙 개정(조정자, 구현에서 드러난 사실): GitConfirm 은 옵션 폼을 받지 않는다
  // (dialog.js:45-46 "옵션 폼을 얹은 파괴적 동작은 아직 없다") — 그래서 제거는
  // **트리만** 지우고, 브랜치 삭제는 이 경로에 자리 자체가 없다(worktrees.js:224-243).
  // 판정은 ①확인을 거친다 ②취소하면 worktree 가 남는다 ③브랜치 삭제 옵션이
  // 이 경로에 없다(요청 본문의 deleteBranch 가 항상 false, 확인 상자에 체크박스도
  // 없다) 셋이다.
  //
  // 이 테스트가 **V163 의 e2e 절반**이다(조정자 판단, FR-WKT-13 전제) — 특히 더
  // 무거운 쪽이다: 실제 제거(`.gc-go` 한 번)가 성공해 `existsSync(wtPath)` 가
  // false 로 떨어지는 것 자체가, 심링크를 지나는 데이터 디렉터리 위에서
  // `Manager.checkPath`(worktree.go:501-522)가 정당한 사용자 worktree 를
  // `unsafe_path` 로 잘못 거부하지 않는다는 증거다(V146 발견 당시엔 이 자리가
  // 30초 타임아웃으로 막혀 있었다 — remove 버튼 자체가 안 떴다).
  test('V150 (FR-GIT-243 · V163): 제거는 확인을 거친다 · 취소하면 남는다 · 브랜치 삭제 옵션이 이 경로엔 없다', async ({ page, request }) => {
    const repo = copyFx('basic', 'v150');
    const wtPath = await createUserWorktree(request, repo, 'v150-remove', 'main', true);

    let sentDeleteBranch: unknown = 'unset';
    await page.route('**/api/git/worktrees/remove', async (route) => {
      const body = route.request().postDataJSON();
      sentDeleteBranch = body?.deleteBranch;
      await route.continue();
    });

    await waitForInit(page);
    await openWorktrees(page, repo);

    const row = wtRows(page).filter({ hasText: 'v150-remove' });
    await expect(row, '만든 worktree 행이 안 보인다').toHaveCount(1, { timeout: 15000 });
    await row.hover();
    await row.locator('.git-wt-act[data-act="remove"]').click();

    // ① 확인을 거친다 — 누르는 즉시 지워지지 않는다.
    const box = page.locator('#git-confirm .gc-box');
    await expect(box, '제거 확인 대화상자가 없다').toBeVisible({ timeout: 5000 });
    expect(existsSync(wtPath), '확인 전인데 이미 지워졌다').toBe(true);

    // ③ 브랜치 삭제 옵션 자리가 없다 — 확인 상자 안 어디에도 체크박스가 없다.
    await expect(box.locator('input[type=checkbox]'), '제거 확인에 체크박스(브랜치 삭제 옵션?)가 있다')
      .toHaveCount(0);

    // ② 취소하면 worktree 가 남는다.
    await page.locator('#git-confirm .gc-cancel').click();
    await expect(page.locator('#git-confirm')).toHaveCount(0);
    expect(existsSync(wtPath), '취소했는데 지워졌다').toBe(true);
    await expect(wtRows(page).filter({ hasText: 'v150-remove' }), '취소했는데 목록에서 사라졌다')
      .toHaveCount(1);

    // 이제 실제로 지운다 — 확인은 한 걸음이다.
    await row.hover();
    await row.locator('.git-wt-act[data-act="remove"]').click();
    await expect(page.locator('#git-confirm .gc-box')).toBeVisible({ timeout: 5000 });
    await page.locator('#git-confirm .gc-go').click();
    // 성공은 확인 상자를 닫는다 — 사유를 남기고 열려 있는 것은 실패의 표현이다
    // (dialog.js:348 `if(res&&res.ok){this._close(true);return}`). 열린 채로
    // 남으면 클라이언트가 성공을 실패로 오인했다는 뜻이다.
    await expect(page.locator('#git-confirm'), '성공했는데 확인 상자가 안 닫혔다').toHaveCount(0, { timeout: 10000 });
    await expect.poll(() => existsSync(wtPath), { timeout: 15000 }).toBe(false);
    await expect(wtRows(page).filter({ hasText: 'v150-remove' }), '지운 뒤에도 목록에 남아 있다')
      .toHaveCount(0, { timeout: 10000 });

    // ③ 서버에 보낸 요청도 deleteBranch:false 다 — UI 가 이 값을 켤 방법이 없다.
    expect(sentDeleteBranch, 'deleteBranch 가 false 로 안 보내졌다').toBe(false);
    const branches = execFileSync('git', ['-C', repo, 'branch', '--list', 'v150-remove'], { encoding: 'utf8' });
    expect(branches.trim(), '기본 제거인데 브랜치까지 지워졌다').toContain('v150-remove');
  });

  test('V151 (FR-GIT-244): 네 동작 각각 — 활성 리포로 열기 · 핀 추가 · 터미널 탭(Git 창이 아닌 창) · 제거', async ({ page, request }) => {
    const repo = copyFx('basic', 'v151');
    // newBranch:true — V149 주석과 같은 이유('main' 은 main worktree 가 이미 쓴다).
    const wtPath = await createUserWorktree(request, repo, 'v151-acts', 'main', true);

    await waitForInit(page);
    await openWorktrees(page, repo);

    const row = wtRows(page).filter({ hasText: 'v151-acts' });
    await expect(row, '만든 worktree 행이 안 보인다').toHaveCount(1, { timeout: 15000 });
    await row.hover();

    // 넷 다 여기서 봐야 한다 — open 은 **활성 리포 행에는 안 붙는다**
    // (worktrees.js:119 `_canOpen`, FR-GIT-180: 이미 그것인데 여는 건 아무 일도
    // 안 하는 버튼이라 고장으로 읽힌다). 지금 활성 리포는 openGit 이 연 main(repo)
    // 이고 v151-acts 는 그것과 다르므로, 이 시점의 v151-acts 행에는 4개가 다 있다.
    for (const a of ['open', 'pin', 'term', 'remove']) {
      await expect(row.locator(`.git-wt-act[data-act="${a}"]`), `${a} 동작 버튼이 없다`).toHaveCount(1);
    }

    /**
     * **순서를 바꿨다** (REPO_TAB_UNIFY_SRS FR-RTU-72 / FR-EDT-33).
     *
     * `open` 이 이제 **창 전환**이므로 그 뒤에는 Worktrees 뷰가 화면에 없다 —
     * 새 창의 본문에는 그 탭이 없다. 그리고 그 창이 서면 경로가 `editors.list` 에
     * 들어가고 저장소 루트이므로 **핀도 함께 생긴다** (`LinkEditorAdd`) — `pin`
     * 을 뒤에 두면 이미 핀된 것을 다시 핀하는 시험이 된다.
     *
     * 그래서 `pin` → `term` → `open` → `remove` 다. 재는 것은 그대로 넷이다.
     */
    // 핀 추가 — 기존 _gitAddRepo 경로(e2e/git-branches.spec.ts:177 과 같은 필드).
    await row.locator('.git-wt-act[data-act="pin"]').click();
    await expect.poll(async () => {
      const d = await (await request.get('/api/workspace')).json();
      return (d?.git?.pinned || []).includes(wtPath);
    }, { timeout: 10000 }).toBe(true);

    // 터미널 탭 — Repo 창이 아닌 창에 연다 (FR-GIT-41·185 와 같은 경로).
    const row2 = wt(page).locator('.git-wt-row').filter({ hasText: 'v151-acts' });
    await row2.locator('.git-wt-act[data-act="term"]').click();
    await expect.poll(() => page.evaluate(() => {
      const a = (window as any).app;
      const w = a.ws.windows.find((x: any) => x.id === a.ws.activeWindow);
      return !!w && !a._isGitWin(w) && !a._isEditorWin(w);
    }), { timeout: 20000 }).toBe(true);
    const hasTerminalInPlain = await page.evaluate(() => {
      const a = (window as any).app;
      const w = a.ws.windows.find((x: any) => x.id === a.ws.activeWindow);
      if (!w || a._isGitWin(w) || a._isEditorWin(w)) return false;
      const has = (n: any): boolean =>
        n.type === 'pane' ? (n.tabs || []).some((t: any) => t.type === 'terminal')
                          : (n.children || []).some(has);
      return has(w.layout);
    });
    expect(hasTerminalInPlain, '터미널 탭이 일반 창에 없다').toBe(true);

    // 활성 리포로 열기 — 그 경로의 Repo 창으로 간다 (FR-RTU-72).
    await backToWorktrees(page, repo);
    const rowOpen = wt(page).locator('.git-wt-row').filter({ hasText: 'v151-acts' });
    await rowOpen.hover();
    await rowOpen.locator('.git-wt-act[data-act="open"]').click();
    await expect.poll(() => page.evaluate(() => {
      const a = (window as any).app;
      return a._isEditorWin(a._aw()) ? a._edRootOf(a._aw()) : null;
    }), { timeout: 15000 }).toBe(wtPath);

    // 제거 — 앞의 `open` 이 다른 창으로 데려갔으므로 되돌아온다.
    await backToWorktrees(page, repo);
    const row3 = wt(page).locator('.git-wt-row').filter({ hasText: 'v151-acts' });
    await row3.hover();
    await row3.locator('.git-wt-act[data-act="remove"]').click();
    await expect(page.locator('#git-confirm .gc-box')).toBeVisible({ timeout: 5000 });
    // 확인은 한 걸음이다(V149/V150 과 같은 이유).
    await page.locator('#git-confirm .gc-go').click();
    // 성공은 확인 상자를 닫는다(V150 과 같은 이유) — 열린 채로 남으면 성공을
    // 실패로 오인했다는 뜻이다.
    await expect(page.locator('#git-confirm'), '성공했는데 확인 상자가 안 닫혔다').toHaveCount(0, { timeout: 10000 });
    await expect.poll(() => existsSync(wtPath), { timeout: 15000 }).toBe(false);
  });

  // Worktrees 목록은 폴링이 없다(worktrees.js: _load 는 mount 시 1회 + reload() 뿐,
  // 조정자 확인). 유일한 재계기는 I3 새로고침이고, 그 버튼(.git-head-refresh)은
  // Changes 탭 DOM 안에만 있다 — 그리로 갔다가 눌러 재계기를 일으킨 뒤 Worktrees 로
  // 돌아와 **바뀌지 않은 행의 표식이 남는지**를 본다(V134·git-repaint.spec.ts P1~P11
  // 과 같은 표식 기법, 계기만 다르다).
  test('V152 (FR-GIT-245 · RPT-1·3): 새로고침 뒤에도 바뀌지 않은 Worktrees 행의 표식이 남는다', async ({ page }) => {
    const repo = copyFx('basic', 'v152');
    await waitForInit(page);
    await openWorktrees(page, repo); // 한 번 마운트해야 reload() 대상이 된다(panel.js:1396).

    await expect.poll(() => wtRows(page).count(), { timeout: 15000 }).toBeGreaterThanOrEqual(1);

    const sel = '#area .pn-body .git-view.git-worktrees .git-wt-row';
    const n = await page.evaluate((s: string) => {
      const els = [...document.querySelectorAll(s)];
      for (const e of els) (e as any).__rptMark = 1;
      return els.length;
    }, sel);
    expect(n).toBeGreaterThan(0);

    // FR-RTU-32: Changes 는 사이드에 늘 있다 — 돌아갈 탭이 없다.
    const refreshBtn = page.locator('.git-view.git-changes .git-head-refresh');
    await expect(refreshBtn, '새로고침 버튼이 없다').toHaveCount(1, { timeout: 5000 });
    await refreshBtn.click();
    await expect(refreshBtn, '새로고침이 끝나지 않았다').toBeEnabled({ timeout: 15000 });
    await page.click('#area .pn-tab[data-git-view="worktrees"]');

    const kept = await page.evaluate((s: string) => {
      const els = [...document.querySelectorAll(s)];
      return els.filter((e) => (e as any).__rptMark === 1).length;
    }, sel);
    expect(kept).toBe(n);
  });
});

// ── GIT_REVIEW4_SRS §3.7.2 / FR-GIT-249 (V168~V170) ──
//
// E6: 서버의 pin 은 멱등이라 이미 있는 경로면 목록을 그대로 두고 200 을 준다.
// 버튼이 핀 상태를 보이지 않으니 사용자는 같은 문구("핀했습니다")만 다시 받고,
// 아무 일도 일어나지 않은 것을 고장으로 읽는다.
test.describe('묶음 N — Worktrees 행의 핀 토글 (FR-GIT-249)', () => {
  const pinned = async (request: APIRequestContext) =>
    ((await (await request.get('/api/workspace')).json())?.git?.pinned || []) as string[];
  const act = (page: Page, name: string, a: string) =>
    wtRows(page).filter({ hasText: name }).locator(`.git-wt-act[data-act="${a}"]`);

  test('V168 (FR-GIT-249): 핀 여부를 버튼이 보인다 — Pin ↔ Unpin 토글이다', async ({ page, request }) => {
    const repo = copyFx('basic', 'v168');
    const wtPath = await createUserWorktree(request, repo, 'v168-toggle', 'main', true);

    await waitForInit(page);
    await openWorktrees(page, repo);
    await expect(wtRows(page).filter({ hasText: 'v168-toggle' })).toHaveCount(1, { timeout: 15000 });

    // 핀되지 않은 경로는 Pin 이다.
    await expect(act(page, 'v168-toggle', 'pin')).toHaveCount(1);
    await expect(act(page, 'v168-toggle', 'unpin')).toHaveCount(0);

    await act(page, 'v168-toggle', 'pin').click();
    await expect.poll(async () => (await pinned(request)).includes(wtPath), { timeout: 10000 }).toBe(true);
    // 핀된 뒤에는 Unpin 이다 — 다른 계기 없이 그 자리에서 바뀐다.
    await expect(act(page, 'v168-toggle', 'unpin')).toHaveCount(1, { timeout: 15000 });
    await expect(act(page, 'v168-toggle', 'pin')).toHaveCount(0);

    // 그리고 그것이 실제로 핀을 푼다.
    await act(page, 'v168-toggle', 'unpin').click();
    await expect.poll(async () => (await pinned(request)).includes(wtPath), { timeout: 10000 }).toBe(false);
    await expect(act(page, 'v168-toggle', 'pin')).toHaveCount(1, { timeout: 15000 });
  });

  test('V169 (FR-GIT-249 · RPT-2·8): 바깥에서 핀이 바뀌어도 버튼이 따라온다', async ({ page, request }) => {
    const repo = copyFx('basic', 'v169');
    const wtPath = await createUserWorktree(request, repo, 'v169-outside-change', 'main', true);

    await waitForInit(page);
    await openWorktrees(page, repo);
    await expect(wtRows(page).filter({ hasText: 'v169-outside-change' })).toHaveCount(1, { timeout: 15000 });
    await act(page, 'v169-outside-change', 'pin').click();
    await expect(act(page, 'v169-outside-change', 'unpin')).toHaveCount(1, { timeout: 15000 });

    // 좌측 GIT 섹션의 × 로 푼다 — Worktrees 탭이 부른 것이 아니다. 상태 관측은
    // 그대로이므로, 판정이 그리기에 업혀 있으면 버튼이 낡은 채로 남는다 (FR-RPT-8).
    // FR-RTU-1: 목록 행은 `.ed-entry` 이고 제거는 `.ed-entry-x` 다 (D-RTU-2).
    const x = page.locator(`#repo-entries .ed-entry[data-git-repo="${wtPath}"] .ed-entry-x`);
    await expect(x, '사이드바에 핀 행이 없다').toHaveCount(1, { timeout: 15000 });
    await x.click();
    await expect.poll(async () => (await pinned(request)).includes(wtPath), { timeout: 10000 }).toBe(false);
    await expect(act(page, 'v169-outside-change', 'pin')).toHaveCount(1, { timeout: 15000 });
  });

  test('V170 (FR-GIT-249): 실패는 그 탭의 안내 줄에만 뜬다 — alert 을 띄우지 않는다', async ({ page, request }) => {
    const repo = copyFx('basic', 'v170');
    const wtPath = await createUserWorktree(request, repo, 'v170-gone', 'main', true);

    await waitForInit(page);
    let alerts = 0;
    page.on('dialog', (d) => { alerts += 1; void d.dismiss(); });
    await openWorktrees(page, repo);
    await expect(wtRows(page).filter({ hasText: 'v170-gone' })).toHaveCount(1, { timeout: 15000 });

    // 목록을 다시 받지 않은 채 대상만 사라지게 한다 — 서버의 rev-parse 가 실패한다.
    rmSync(wtPath, { recursive: true, force: true });
    await act(page, 'v170-gone', 'pin').click();

    const note = wt(page).locator('.git-wt-note.vis .git-wt-note-msg');
    await expect(note, '실패 사유가 탭에 안 보인다').toBeVisible({ timeout: 15000 });
    expect((await note.textContent())!.trim().length).toBeGreaterThan(0);
    expect(alerts, 'alert 이 떴다 — 같은 사실을 두 번 알린다').toBe(0);
    expect((await pinned(request)).includes(wtPath), '실패했는데 핀이 들어갔다').toBe(false);
  });
});

test.describe('행 동작은 hover 없이 보인다', () => {
  // hover 로만 드러나면 있는 줄 모르고, 터치에는 hover 가 없어 아예 누를 수 없다.
  // Changes 행과 Worktrees 행이 **같은 규약**을 쓰므로 둘을 함께 고정한다.
  test('W-VIS1: 마우스를 올리지 않아도 Worktrees 행과 Changes 행의 버튼이 보인다', async ({ page }) => {
    const repo = copyFx('basic', 'wtvis');
    await waitForInit(page);
    await openWorktrees(page, repo);
    await expect(wtRows(page).first()).toBeVisible({ timeout: 20000 });

    // 마우스를 목록 밖 먼 곳에 둔다 — 어느 행에도 hover 가 걸리지 않게.
    await page.mouse.move(0, 0);
    const wtActs = wtRows(page).first().locator('.git-wt-acts');
    await expect(wtActs).toHaveCSS('opacity', '1');
    await expect(wtActs.locator('.git-wt-act').first()).toBeVisible();

    // FR-RTU-32: Changes 는 사이드에 늘 있다 — 돌아갈 탭이 없다.
    const fileActs = page.locator('#area .ed-side .git-view.git-changes .git-file .git-file-acts').first();
    await expect(fileActs).toBeVisible({ timeout: 20000 });
    await page.mouse.move(0, 0);
    await expect(fileActs).toHaveCSS('opacity', '1');
    await expect(fileActs.locator('.git-file-act').first()).toBeVisible();
  });
});

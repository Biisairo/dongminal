import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import { Page } from '@playwright/test';

import { test, expect, openGit as fxOpenGit, rmTree, waitSettled, addEditorRoot } from './fixtures';
import { TMP, realPath, cssPath } from './osenv';

// SUBMODULE_DIRTY_NOTICE_SRS §5 — 검증 V-SDN-*.
//
// 접수한 말은 "서브모듈은 커밋이 안 되고 있는 거 같아" 였고, 확인 결과 **버그가
// 아니었다**: 부모 저장소가 커밋할 수 있는 것은 gitlink 하나뿐이라 서브모듈 안의
// 미커밋 변경은 `git add` 로 index 에 올라가지 않는다 (SRS §1.1 실측).
//
// 고칠 것은 동작이 아니라 침묵이므로, 여기서 재는 것은 **화면이 그 사실을
// 말하는가** 다.
//
// git-dir-entry.spec.ts 와 같은 이유로 서버를 목업하지 않는다 — 세 상태(`SC..`·
// `S.MU`·`SCM.`)를 진짜 디스크에 세우고 진짜 응답으로 잰다.

let BASE = '';
const REPO: Record<string, string> = {};

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
  git(d, 'config', 'protocol.file.allow', 'always');
  return d;
}

/**
 * 서브모듈 하나를 가진 부모 저장소를 만들고, 그 서브모듈을 요구한 상태로 둔다.
 *
 *   'commit'  기록된 커밋만 바뀜        → `SC..`
 *   'inner'   서브모듈 안만 더러움      → `S.MU`  (사용자가 부딪힌 상태)
 *   'both'    둘 다                     → `SCM.`
 */
function makeParent(base: string, kind: 'commit' | 'inner' | 'both') {
  const child = init(j(base, kind + '-child'));
  w(j(child, 'a.txt'), 'hello\n');
  git(child, 'add', '-A');
  git(child, 'commit', '-qm', 'init');

  const d = init(j(base, kind + '-parent'));
  w(j(d, 'r.txt'), 'root\n');
  git(d, 'add', '-A');
  git(d, 'commit', '-qm', 'init');
  git(d, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', '../' + kind + '-child', 'sub');
  git(d, 'commit', '-qm', 'addsub');

  const sub = j(d, 'sub');
  // 기록된 커밋을 바꾸려면 서브모듈 **안에서** 커밋해야 한다 — 그래야 gitlink 가
  // 부모의 HEAD 와 달라진다.
  if (kind === 'commit' || kind === 'both') {
    w(j(sub, 'b.txt'), 'second\n');
    git(sub, 'add', '-A');
    git(sub, 'commit', '-qm', 'bump');
  }
  // 안쪽 몫은 커밋하지 않고 남긴다.
  if (kind === 'inner') {
    fs.appendFileSync(j(sub, 'a.txt'), 'more\n');
    w(j(sub, 'untracked.txt'), 'x\n');   // u 자리를 채운다
  }
  if (kind === 'both') fs.appendFileSync(j(sub, 'a.txt'), 'more\n');
  return realPath(d);
}

test.beforeAll(() => {
  BASE = realPath(fs.mkdtempSync(j(TMP, 'dm-sdn-')));
  for (const k of ['commit', 'inner', 'both'] as const) REPO[k] = makeParent(BASE, k);
});
test.afterAll(() => {
  rmTree(BASE);
});

async function goto(page: Page) {
  await page.context().addInitScript(() => { sessionStorage.setItem('displayMode', 'desktop') });
  await page.goto('/');
  await page.waitForSelector('#area .pn.focused .xterm-helper-textarea', { timeout: 15000 });
  await waitSettled(page);
}

const changes = (page: Page) => page.locator('#area .ed-side .git-view.git-changes');
const diffView = (page: Page) => page.locator('#area .pn-body .git-view.git-diff');
const fileRow = (page: Page, p: string) =>
  changes(page).locator(`.git-file[data-path="${cssPath(p)}"]`);

async function openGit(page: Page, repo: string) {
  await goto(page);
  await fxOpenGit(page, repo);
  await expect(changes(page).locator('.git-file').first()).toBeVisible({ timeout: 10000 });
}

// ── 묶음 P — 판정 (FR-SDN-1~4) ────────────────────────

test.describe('묶음 P — sub 필드의 판정', () => {
  test('P1 (V-SDN-1~4): 세 상태와 비서브모듈이 갈린다', async ({ page }) => {
    await goto(page);
    const parts = (s: string) =>
      page.evaluate((x) => (window as any).gitSubParts(x), s);

    expect(await parts('SC..')).toEqual({ commit: true, inner: false });
    expect(await parts('S.M.')).toEqual({ commit: false, inner: true });
    expect(await parts('S..U')).toEqual({ commit: false, inner: true });
    expect(await parts('S.MU')).toEqual({ commit: false, inner: true });
    expect(await parts('SCM.')).toEqual({ commit: true, inner: true });
    // 성분이 없는 서브모듈. 무엇을 말할지 알지 못한다 (FR-SDN-7).
    expect(await parts('S...')).toEqual({ commit: false, inner: false });
    // 서브모듈이 아닌 것에 서브모듈의 사정을 말하지 않는다 (FR-SDN-3).
    expect(await parts('N...')).toEqual({ commit: false, inner: false });
    expect(await parts('')).toEqual({ commit: false, inner: false });
  });

  test('P2 (V-SDN-5): 자리 수가 모자란 문자열도 오류가 아니다', async ({ page }) => {
    await goto(page);
    const parts = (s: string) =>
      page.evaluate((x) => (window as any).gitSubParts(x), s);
    // FR-SDN-4: 없는 자리는 `.` 로 읽는다 — git 이 형식을 늘려도 깨지지 않아야 한다.
    expect(await parts('S')).toEqual({ commit: false, inner: false });
    expect(await parts('SC')).toEqual({ commit: true, inner: false });
    expect(await parts('S.M')).toEqual({ commit: false, inner: true });
    // 문자열이 아닌 값도 같은 자리에서 막힌다.
    expect(await page.evaluate(() => (window as any).gitSubParts(undefined)))
      .toEqual({ commit: false, inner: false });
  });
});

// ── 묶음 F — 픽스처가 의도한 상태인가 ──────────────────

test.describe('묶음 F — 세 상태의 관측', () => {
  test('F1: 세 저장소의 sub 필드가 각각 커밋·안쪽·둘 다이다', async ({ request }) => {
    /**
     * **묻기 직전에 등록한다** (FILE_API_BOUNDARY_SRS FR-FAB-14c, 2026-09-11).
     *
     * `repo` 도 이제 경계를 지난다. 제품의 UI 흐름은 `openGitWindow` 가 열기 전에
     * 등록하므로(FR-RTU-72) 이 계약을 이미 지키고, 이 묶음만 그 걸음을 건너뛴 채
     * API 를 직접 불렀다.
     *
     * **훅이 아니라 이 자리인 이유**: `describe` 의 `beforeAll` 에 두면 픽스처를
     * 만드는 바깥 훅과 순서로 엮인다 — 실제로 그렇게 두었다가 첫 회만 403 이 나고
     * 재시도에서 통과하는 흔들림을 만들었다. 등록은 멱등이므로 쓰는 자리에서
     * 하는 것이 순서에 기대지 않는 유일한 형태다.
     */
    const subOf = async (repo: string) => {
      await addEditorRoot(request, repo);
      const r = await request.get('/api/git/status?repo=' + encodeURIComponent(repo));
      // 실패하면 **응답 본문을 보여준다.** `false` 만 남으면 경계에 걸린 것인지
      // git 이 답을 못 준 것인지 가릴 수 없다.
      expect(r.ok(), `git status 실패 repo=${repo}: ${await r.text()}`).toBeTruthy();
      const st = (await r.json()).status;
      const all = [...(st.changes || []), ...(st.staged || [])];
      const e = all.find((x: any) => x.path === 'sub');
      expect(e, `sub 항목이 없다: ${JSON.stringify(all)}`).toBeTruthy();
      return String(e.sub || '');
    };
    // c 자리만 채워진다 — 안쪽은 깨끗하다.
    expect(await subOf(REPO.commit)).toBe('SC..');
    // 사용자가 부딪힌 상태: c 가 `.` 이라 `git add` 가 올릴 것이 없다 (SRS §1.1).
    expect(await subOf(REPO.inner)).toBe('S.MU');
    expect(await subOf(REPO.both)).toBe('SCM.');
  });
});

// ── 묶음 N — 화면이 말하는 것 (FR-SDN-5~11) ────────────

test.describe('묶음 N — 툴팁과 안내문', () => {
  test('N1 (V-SDN-6): 안쪽만 더러운 행은 "사라지지 않는다" 를 말한다',
    async ({ page }) => {
      await openGit(page, REPO.inner);
      await expect(fileRow(page, 'sub')).toHaveClass(/dir-entry/, { timeout: 10000 });
      // FR-SDN-8: 상태별 문장이 종전 문장을 대체한다 — "서브모듈" 이 한 툴팁에
      // 두 번 나오지 않아야 한다.
      const title = await fileRow(page, 'sub').getAttribute('title');
      expect(title).toMatch(/사라지지 않습니다/);
      expect(title!.match(/서브모듈/g)!.length).toBe(1);
    });

  test('N2 (V-SDN-7): 그 행의 안내문이 사실을 먼저 말하고 갈 길을 준다',
    async ({ page }) => {
      await openGit(page, REPO.inner);
      await fileRow(page, 'sub').dblclick();
      const note = diffView(page).locator('.git-diff-note');
      await expect(note).toBeVisible({ timeout: 10000 });
      // FR-SDN-6: 사라지지 않는다는 사실이 먼저다 — 순서가 뒤집히면 "먼저
      // 커밋하라" 가 조언으로 읽히고 눈앞의 행은 설명되지 않는다.
      await expect(note).toContainText('스테이지·커밋해도 이 행이 사라지지 않습니다');
      await expect(note).toContainText('그 안에서 먼저 커밋하세요');
      // FR-SDN-10: 갈 곳은 이미 그 자리에 있다.
      await expect(note.locator('.git-diff-note-act').first()).toBeVisible();
    });

  test('N3 (V-SDN-8): 기록된 커밋만 바뀐 행은 담긴다고 말한다', async ({ page }) => {
    await openGit(page, REPO.commit);
    await expect(fileRow(page, 'sub'))
      .toHaveAttribute('title', /스테이지하면 담깁니다/, { timeout: 10000 });
    await fileRow(page, 'sub').dblclick();
    const note = diffView(page).locator('.git-diff-note');
    await expect(note).toContainText('기록된 커밋이 바뀌었습니다', { timeout: 10000 });
    // 이 행에 "사라지지 않는다" 를 말해서는 안 된다 — 실제로 사라진다.
    await expect(note).not.toContainText('사라지지 않습니다');
  });

  test('N4 (V-SDN-8): 둘 다인 행은 담기는 몫과 남는 몫을 함께 말한다',
    async ({ page }) => {
      await openGit(page, REPO.both);
      await fileRow(page, 'sub').dblclick();
      const note = diffView(page).locator('.git-diff-note');
      await expect(note).toContainText('기록된 커밋이 바뀌었고', { timeout: 10000 });
      await expect(note).toContainText('안쪽 몫은 이 행에 남습니다');
    });

  /**
   * V-SDN-10 (FR-SDN-12·13, D-2a): **담을 몫이 없으면 버튼이 꺼진다.**
   *
   * 접수한 말은 "여전히 staging 조차 되지 않는다" 였다. 실측이 그 정체를 밝혔다:
   * 안쪽만 더러운 행에서 `git add` 는 index 에 올릴 것이 없어 요청은 200 이고
   * 화면은 그대로다 — 사용자는 툴팁을 열기 전에 버튼을 먼저 누른다.
   */
  test('N6 (V-SDN-10): 안쪽만 더러운 행의 Stage 는 꺼지고 사유를 말한다',
    async ({ page }) => {
      await openGit(page, REPO.inner);
      const stage = fileRow(page, 'sub').locator('.git-file-act[data-act="stage"]');
      await expect(stage).toBeDisabled();
      // 사유는 **영어**로 말한다 (FR-TIP-2) — 버튼의 `title` 이기 때문이다.
      // 말하는 내용은 FR-SDN-13 그대로다.
      await expect(stage).toHaveAttribute('title', /Nothing here for this repository to stage/);
      // Discard 는 그대로다 — gitlink 를 되돌리는 별개의 동작이다 (FR-SDN-14).
      await expect(fileRow(page, 'sub').locator('.git-file-act[data-act="discard"]')).toBeEnabled();
    });

  // A(커밋만)와 C(둘 다)는 실제로 담기는 것이 있다 (FR-SDN-14). 저장소마다
  // 테스트를 가르는 이유는 `openGit` 이 `goto` 를 품기 때문이다 — 한 테스트에서
  // 두 번 열면 두 번째 로드에서 터미널이 서지 않는다(실측).
  for (const kind of ['commit', 'both'] as const) {
    test(`N7-${kind} (V-SDN-10): 담을 몫이 있는 행의 Stage 는 살아 있다`, async ({ page }) => {
      await openGit(page, REPO[kind]);
      await expect(fileRow(page, 'sub').locator('.git-file-act[data-act="stage"]')).toBeEnabled();
    });
  }

  test('N5 (V-SDN-9): 중첩 저장소의 문구는 바뀌지 않았다', async ({ page }) => {
    // 중첩 저장소는 `sub` 가 비어 있어 가를 것이 없다 (FR-SDN-11). 서브모듈
    // 저장소 안에 하나 세워 같은 화면에서 확인한다.
    const nested = init(j(REPO.inner, 'nested'));
    w(j(nested, 'inner.txt'), 'x\n');
    try {
      await openGit(page, REPO.inner);
      await fileRow(page, 'nested').dblclick();
      const note = diffView(page).locator('.git-diff-note');
      await expect(note).toContainText('다른 저장소', { timeout: 10000 });
      await expect(note).not.toContainText('서브모듈');
    } finally {
      rmTree(nested);
    }
  });
});

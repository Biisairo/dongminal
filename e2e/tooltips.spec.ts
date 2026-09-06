import { execFileSync } from 'child_process';

import { Page } from '@playwright/test';

import { test, expect, makeCopyFx, waitForInit, GIT_BODY_VIEWS, clickGitView } from './fixtures';

/**
 * UX_BATCH5_SRS 묶음 C — 모든 버튼의 영어 툴팁 (FR-TIP-1·2·7).
 *
 * 접수한 말은 "모든 버튼에 오래 호버를 하면 영어로 이게 무슨 버튼인지 알리는
 * 안내가 나오면 좋겠어" 다. 브라우저의 기본 `title` 이 곧 그 동작이므로 커스텀
 * 툴팁을 만들지 않는다 (D-6).
 *
 * **이 파일이 회귀를 막는 자리다** (FR-TIP-7). 버튼마다 시험을 쓰지 않는 이유는
 * 그렇게 하면 다음에 추가되는 버튼에서 또 빠지기 때문이다 — 화면을 통째로 훑어
 * 두 가지만 단정한다: 비어 있지 않은가, 그리고 한글이 없는가.
 *
 * 바꾸는 것은 `title` 한 속성뿐이다 (FR-TIP-3). 라벨·안내·오류의 언어는 그대로다.
 */

const FIXTURES = '/tmp/dm-git-fx-tooltips-' + process.pid;

test.beforeAll(() => {
  execFileSync('bash', ['e2e/git_fixture.sh', FIXTURES], { stdio: 'ignore' });
});
test.afterAll(() => {
  execFileSync('bash', ['e2e/git_fixture.sh', '--clean', FIXTURES], { stdio: 'ignore' });
});

const copyFx = makeCopyFx(FIXTURES);

// 한글 음절과 자모. `title` 이 영어인지 판정하는 근거이며, 이 범위 밖의 라틴 문자와
// 기호는 통과시킨다 — 명령 문자열이나 경로가 섞이는 것은 정상이다.
const HANGUL = /[가-힣ㄱ-ㆎ]/;

/**
 * 지금 화면에 **보이는** 버튼 전부를 훑는다.
 *
 * 보이지 않는 것은 재지 않는다 — 접힌 패널이나 아직 안 뜬 모달의 버튼은 사용자가
 * 호버할 수 없고, 그것까지 세면 시험이 무엇을 재는지 흐려진다 (치수 시험
 * `git-ui-revision.spec.ts` 의 `vis` 와 같은 규약).
 */
async function scan(page: Page) {
  return page.evaluate(() => {
    const out: { where: string; text: string; cls: string; title: string }[] = [];
    for (const el of Array.from(document.querySelectorAll('button'))) {
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      // 어느 자리의 버튼인지 — 실패했을 때 찾아갈 수 있어야 한다.
      const host = el.closest('[id]');
      out.push({
        where: host ? '#' + host.id : '(no id)',
        text: (el.textContent || '').trim().slice(0, 24),
        cls: String(el.className).slice(0, 48),
        title: el.getAttribute('title') || '',
      });
    }
    return out;
  });
}

function check(found: { where: string; text: string; cls: string; title: string }[]) {
  const missing = found.filter((b) => !b.title.trim());
  const korean = found.filter((b) => HANGUL.test(b.title));
  return { missing, korean };
}

async function assertAll(page: Page, label: string) {
  const found = await scan(page);
  expect(found.length, label + ': 잰 버튼이 없다 — 시험이 뜻을 잃는다').toBeGreaterThan(0);
  const { missing, korean } = check(found);
  // FR-TIP-1
  expect(missing, label + ': title 이 없는 버튼\n' + JSON.stringify(missing, null, 1)).toEqual([]);
  // FR-TIP-2
  expect(korean, label + ': title 이 한국어인 버튼\n' + JSON.stringify(korean, null, 1)).toEqual([]);
}

async function openGitSurfaces(page: Page, repo: string) {
  await page.evaluate((r: string) => (window as any).app.openGitWindow(r), repo);
  await page.waitForSelector('#area .ed-win .ed-side', { timeout: 15000 });
  await page.evaluate((views: readonly string[]) => {
    const a = (window as any).app;
    a._edSetSide(a._aw(), 'changes');
    for (const v of views) a.gitPanel.openView(v);
  }, GIT_BODY_VIEWS);
  await expect(page.locator('#area .ed-side .git-view.git-changes')).toBeVisible({ timeout: 10000 });
}

test.describe('묶음 C — 모든 버튼의 영어 툴팁', () => {
  test('C1 (V-TIP-1 / FR-TIP-1·2): 기본 화면의 모든 버튼', async ({ page }) => {
    await waitForInit(page);
    await assertAll(page, '기본 화면');
  });

  test('C2 (V-TIP-2 / FR-TIP-1·2): 설정 창의 모든 탭', async ({ page }) => {
    await waitForInit(page);
    await page.click('#settings-btn');
    await expect(page.locator('#modal-overlay')).toHaveClass(/open/, { timeout: 10000 });
    // 탭마다 다른 버튼이 선다 — 하나만 보면 나머지 여덟이 검사를 벗어난다.
    for (const tab of ['theme', 'shortcuts', 'statusbar', 'presets', 'display',
      'code', 'notify', 'sandbox', 'backup']) {
      await page.click(`.mtab[data-tab="${tab}"]`);
      await page.waitForTimeout(120);
      await assertAll(page, '설정 · ' + tab);
    }
  });

  test('C3 (V-TIP-3 / FR-TIP-1·2): Git 창의 여덟 표면', async ({ page }) => {
    await waitForInit(page);
    await openGitSurfaces(page, copyFx('basic', 'tip3'));
    // 사이드(Changes)를 먼저 잰다 — 행 동작은 hover 없이도 늘 보인다
    // (`.git-file-acts` 는 항상 보인다).
    await expect(page.locator('#area .ed-side .git-file').first())
      .toBeVisible({ timeout: 15000 });
    await assertAll(page, 'Git · Changes');

    for (const v of GIT_BODY_VIEWS) {
      await clickGitView(page, v);
      await page.waitForTimeout(250);
      await assertAll(page, 'Git · ' + v);
    }
  });

  /**
   * FR-DBA-3 이 만든 자리지킴은 `<button>` 이 아니므로 이 요구의 대상이 아니다
   * (FR-TIP-6). 그것이 참인지 여기서 함께 단정한다 — 자리지킴이 버튼이 되는 날
   * 이 시험이 먼저 알린다.
   */
  test('C4 (V-TIP-4 / FR-TIP-6): 트리 보기의 폴더 행 — 자리지킴은 버튼이 아니다',
    async ({ page }) => {
      await waitForInit(page);
      await openGitSurfaces(page, copyFx('basic', 'tip4'));
      await page.locator('#area .ed-side .git-files-mode[data-mode="tree"]').click();
      await page.waitForTimeout(300);
      await assertAll(page, 'Git · Changes (tree)');

      const gaps = page.locator('#area .ed-side .git-act-gap');
      const n = await gaps.count();
      for (let i = 0; i < n; i++) {
        expect(await gaps.nth(i).evaluate((e) => e.tagName)).not.toBe('BUTTON');
      }
    });

  test('C5 (V-TIP-5 / FR-TIP-1·2): 파일 편집기와 찾기 패널', async ({ page }) => {
    await waitForInit(page);
    const repo = copyFx('basic', 'tip5');
    await page.evaluate((r: string) => (window as any).app.openGitWindow(r), repo);
    await page.waitForSelector('#area .ed-win .ed-side', { timeout: 15000 });
    await page.evaluate(() => {
      const a = (window as any).app;
      a._edSetSide(a._aw(), 'explorer');
    });
    await page.waitForTimeout(400);
    await assertAll(page, 'Editor · Explorer');
  });
});

/**
 * C6 — **모바일 화면.** 데스크톱만 훑으면 모바일에만 서는 버튼(키바·순회 바)이
 * 검사를 통째로 벗어난다. 접수한 말이 "모든 버튼" 이므로 그 화면도 대상이다.
 */
test.describe('묶음 C — 모바일 화면', () => {
  test('C6 (V-TIP-6 / FR-TIP-1·2): 모바일 화면의 모든 버튼', async ({ page }) => {
    await page.context().addInitScript(() => {
      sessionStorage.setItem('displayMode', 'mobile');
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');
    await page.waitForSelector('body.mobile', { timeout: 15000 });
    await assertAll(page, '모바일 기본 화면');
  });
});

/**
 * C7~C9 — **모달과 조건부 표면.** 기본 화면만 훑으면 확인창·다이얼로그처럼 띄워야
 * 보이는 버튼이 검사를 통째로 벗어난다. 접수한 말이 "모든 버튼" 이므로 그 자리도
 * 대상이다.
 */
test.describe('묶음 C — 모달과 조건부 표면', () => {
  test('C7 (V-TIP-7 / FR-TIP-1·2): 파괴적 확인창', async ({ page }) => {
    await waitForInit(page);
    await openGitSurfaces(page, copyFx('basic', 'tip7'));
    const changes = page.locator('#area .ed-side .git-view.git-changes');
    await expect(changes.locator('.git-file').first()).toBeVisible({ timeout: 15000 });
    // 그룹 일괄 폐기가 GitConfirm 을 띄운다 (CONFIRM_ONE_STAGE_SRS).
    await changes.locator('.git-group[data-group="changes"] .git-group-bulk[data-act="discard"]')
      .click();
    await expect(page.locator('#git-confirm .gc-box')).toBeVisible({ timeout: 10000 });
    await assertAll(page, '확인창');
  });

  test('C8 (V-TIP-8 / FR-TIP-1·2): 옵션 다이얼로그', async ({ page }) => {
    await waitForInit(page);
    await openGitSurfaces(page, copyFx('basic', 'tip8'));
    await clickGitView(page, 'branches');
    await expect(page.locator('#area .pn-body .git-view.git-branches'))
      .toBeVisible({ timeout: 10000 });
    await page.locator('#area .pn-body .git-branches .git-br-new').click();
    await expect(page.locator('#git-br-create')).toBeVisible({ timeout: 10000 });
    await assertAll(page, '브랜치 생성 다이얼로그');
  });

  test('C9 (V-TIP-9 / FR-TIP-1·2): 충돌 행의 동작', async ({ page }) => {
    await waitForInit(page);
    await openGitSurfaces(page, copyFx('conflict', 'tip9'));
    const row = page.locator('#area .ed-side .git-group[data-group="conflicts"] .git-file');
    await expect(row.first()).toBeVisible({ timeout: 15000 });
    // 진행 중 조작 바(`git-op-bar`)도 함께 선다 — 머지가 멈춘 상태다.
    await assertAll(page, '충돌 상태');

    /**
     * FR-TIP-5: 뜻이 **상태에 따라 갈리는** 툴팁은 그 상태를 반영해야 한다.
     * `ours`/`theirs` 는 진행 중 조작이 무엇이냐에 따라 어느 쪽이 내 것인지가
     * 뒤집힌다 (FR-GIT-224) — 영어로 옮기면서 그 갈림이 죽지 않았는지 본다.
     */
    await row.first().hover();
    const ours = row.first().locator('.git-file-act[data-act="ours"]');
    const theirs = row.first().locator('.git-file-act[data-act="theirs"]');
    const [to, tt] = [await ours.getAttribute('title'), await theirs.getAttribute('title')];
    expect(to, 'ours 툴팁이 비었다').toBeTruthy();
    expect(tt, 'theirs 툴팁이 비었다').toBeTruthy();
    expect(to, 'ours 와 theirs 의 툴팁이 같다 — 갈림이 죽었다').not.toBe(tt);
    /**
     * **구체적 문구를 단정하지 않는다.** 진행 중 조작은 preflight 가 알려 주는
     * 것이라, 그것이 도착하기 전에는 `_op()` 이 비고 그때는 **양쪽을 다 밝히는**
     * 기본 문구가 선다 — 틀린 한쪽을 단정하지 않는다는 FR-GIT-224 의 설계다.
     *
     * 그래서 재는 것은 어느 상태에서나 참인 것 둘이다: 두 쪽이 다른 말을 하고,
     * 각자 자기 이름(`ours`/`theirs`)을 담는다.
     */
    expect(to!.toLowerCase()).toContain('ours');
    expect(tt!.toLowerCase()).toContain('theirs');
  });
});

/**
 * C10~C11 — **상태바가 여는 것들.** 백그라운드 도구·주의 알림은 창을 띄워야 보이며,
 * 그 안의 버튼도 FR-TIP-1 의 대상이다.
 */
test.describe('묶음 C — 상태바가 여는 표면', () => {
  /**
   * 알림 배지는 알림이 하나라도 있어야 선다 (`#attn-badge` 는 기본이 `display:none`).
   * 그래서 **알림을 만들고** 연다 — skip 은 검증이 아니다.
   */
  test('C10 (V-TIP-10 / FR-TIP-1·2): 주의 알림 센터', async ({ page }) => {
    await waitForInit(page);
    const made = await page.evaluate(() => {
      const a = (window as any).app;
      const id = a.tools && a.tools.size ? [...a.tools.keys()][0] : null;
      if (!id) return false;
      a._attn.set(id, { reason: 'e2e' });
      // 배지를 세우는 것은 `_attnRefresh` 다 (app-attn.js:250).
      a._attnRefresh();
      return true;
    });
    expect(made, '알림을 걸 도구가 없다 — 시험이 뜻을 잃는다').toBeTruthy();
    const badge = page.locator('#attn-badge');
    await expect(badge).toBeVisible({ timeout: 10000 });
    await badge.click();
    await expect(page.locator('#attn-center')).toHaveClass(/open/, { timeout: 10000 });
    await assertAll(page, '주의 알림 센터');
  });

  // 진단 오버레이는 `?diag=1` 로 접속할 때만 선다 (diag.js 의 첫 줄).
  test('C11 (V-TIP-11 / FR-TIP-1·2): 진단 오버레이', async ({ page }) => {
    await page.context().addInitScript(() => { sessionStorage.setItem('displayMode', 'desktop') });
    await page.goto('/?diag=1');
    await page.waitForSelector('#diag-ov', { timeout: 15000 });
    await assertAll(page, '진단 오버레이');
  });
});

/**
 * C12~C15 — **띄워야 보이는 나머지.** 앞의 묶음들이 훑지 못한 자리다: 진행 중
 * 원격 작업의 바 · 부분 스테이징의 hunk 버튼 · 도구 닫기 확인 · 알림창.
 *
 * 붙였다는 것과 실제로 붙어 있다는 것은 다르다 — 각 표면을 실제로 띄워 확인한다.
 */
test.describe('묶음 C — 띄워야 보이는 표면', () => {
  test('C12 (V-TIP-12 / FR-TIP-1·2): 알림창(_notify)', async ({ page }) => {
    await waitForInit(page);
    await page.evaluate(() => (window as any).app._notify('e2e message'));
    await expect(page.locator('.confirm-overlay .notify-msg')).toBeVisible({ timeout: 10000 });
    await assertAll(page, '알림창');
  });

  test('C13 (V-TIP-13 / FR-TIP-1·2): 도구 닫기 확인창', async ({ page }) => {
    await waitForInit(page);
    // 세 갈래를 한 번에 세운다 — 저장·백그라운드 버튼은 옵션이 있어야 선다.
    await page.evaluate(() => {
      (window as any).app._confirmClose('e2e', { saveBtn: true, bgBtn: true });
    });
    await expect(page.locator('.confirm-overlay .confirm-btns')).toBeVisible({ timeout: 10000 });
    await assertAll(page, '도구 닫기 확인창');
  });

  test('C14 (V-TIP-14 / FR-TIP-1·2): 터미널 복사창', async ({ page }) => {
    await waitForInit(page);
    const opened = await page.evaluate(() => {
      const tc = (window as any).TermClipboard;
      // 여는 이름은 `prompt` 다 (term-clipboard.js:138) — 클립보드가 막힌 환경에서
      // 손으로 복사하도록 띄우는 창이다.
      if (!tc || typeof tc.prompt !== 'function') return false;
      tc.prompt('e2e copy text');
      return true;
    });
    expect(opened, 'TermClipboard 를 열 수 없다 — 시험이 뜻을 잃는다').toBeTruthy();
    await expect(page.locator('.tc-copy-row')).toBeVisible({ timeout: 10000 });
    await assertAll(page, '터미널 복사창');
  });

  /**
   * hunk 버튼은 **diff 를 열고 그 안의 조각에 hover 해야** 선다 (FR-GIT-278).
   * 부분 스테이징의 진입점이므로 파괴적인 것(`Revert hunk`)이 그 안에 있다.
   */
  test('C15 (V-TIP-15 / FR-TIP-1·2): diff 의 hunk 버튼', async ({ page }) => {
    await waitForInit(page);
    await openGitSurfaces(page, copyFx('basic', 'tip15'));
    const changes = page.locator('#area .ed-side .git-view.git-changes');
    const row = changes.locator('.git-group[data-group="changes"] .git-file').first();
    await expect(row).toBeVisible({ timeout: 15000 });
    await row.click();
    const diff = page.locator('#area .pn-body .git-view.git-diff');
    await expect(diff).toBeVisible({ timeout: 15000 });
    // 조각 머리가 서야 그 버튼도 선다 (`.git-hunk-head`, panel-diff.js:377).
    const hunk = diff.locator('.git-hunk-head').first();
    await expect(hunk).toBeVisible({ timeout: 20000 });
    await hunk.hover();
    await assertAll(page, 'diff · hunk');
  });
});

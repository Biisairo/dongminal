import { Page } from '@playwright/test';

import { test, expect } from './fixtures';

// GIT_M2_STEP9_CONTRACT §6 — 클라이언트 2단계 확인. 검증 V37·V38
// (FR-GIT-90·91·94·96·97·175·176·178).
//
// 10단계(discard)가 실제 파괴적 동작을 붙이기 전이므로 window.GitConfirm.open 을
// 직접 부른다.

const DESKTOP = { width: 1280, height: 720 };
const MOBILE = { width: 390, height: 640 };

async function waitForInit(page: Page, mode: 'desktop' | 'mobile') {
  await page.context().addInitScript((m) => {
    sessionStorage.setItem('displayMode', m as string);
  }, mode);
  await page.setViewportSize(mode === 'mobile' ? MOBILE : DESKTOP);
  await page.goto('/');
  await page.waitForSelector('#area', { timeout: 15000 });
  await page.waitForFunction(() => !!(window as any).GitConfirm, null, { timeout: 15000 });
}

type OpenArgs = {
  targets?: string[];
  hint?: { note?: string; command?: string } | null;
  fail?: { reason: string; stderrTail: string };
  ok?: boolean;
};

// open 의 promise 를 evaluate 가 await 하지 않게 한다 — 다이얼로그가 열린 채
// 검사해야 하므로 결과는 window 에 남긴다.
async function open(page: Page, a: OpenArgs = {}) {
  await page.evaluate((arg: OpenArgs) => {
    const w = window as any;
    w.__res = undefined;
    w.__ran = 0;
    const run = async () => {
      w.__ran++;
      if (arg.fail) return { ok: false, reason: arg.fail.reason, stderrTail: arg.fail.stderrTail };
      return { ok: arg.ok !== false };
    };
    w.GitConfirm.open({
      action: 'discard',
      title: '변경을 폐기합니다',
      targets: arg.targets || ['a.txt'],
      hint: arg.hint === undefined ? { note: '폐기 전에 아래를 실행하세요', command: 'git stash push -- a.txt' } : arg.hint,
      run,
    }).then((v: boolean) => {
      w.__res = v;
    });
  }, a);
  await expect(page.locator('#git-confirm .gc-box')).toBeVisible({ timeout: 10000 });
}

const box = (page: Page) => page.locator('#git-confirm .gc-box');
const cancel = (page: Page) => page.locator('#git-confirm .gc-cancel');
const go = (page: Page) => page.locator('#git-confirm .gc-go');

test.describe('묶음 J — 파괴적 동작의 2단계 확인', () => {
  test('J5 (V38): 초기 포커스가 취소 버튼이다', async ({ page }) => {
    await waitForInit(page, 'desktop');
    await open(page);

    await expect(cancel(page)).toBeFocused();
    // 2단계로 넘어가도 기본 선택지는 안전한 쪽이다 (FR-GIT-97).
    await go(page).click();
    await expect(box(page)).toHaveAttribute('data-stage', '2');
    await expect(cancel(page)).toBeFocused();
  });

  test('J6 (V38): 파괴적 다이얼로그에서 Enter 가 실행하지 않는다', async ({ page }) => {
    await waitForInit(page, 'desktop');
    await open(page);

    // 실행 버튼에 포커스를 옮긴 뒤에도 Enter 는 실행이 아니다 (FR-GIT-176).
    await go(page).focus();
    await expect(go(page)).toBeFocused();
    await page.keyboard.press('Enter');

    await expect(page.locator('#git-confirm')).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).__res)).toBe(false);
    expect(await page.evaluate(() => (window as any).__ran)).toBe(0);
  });

  test('J6b (V38): Esc 는 취소다', async ({ page }) => {
    await waitForInit(page, 'desktop');
    await open(page);
    await page.keyboard.press('Escape');
    await expect(page.locator('#git-confirm')).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).__res)).toBe(false);
  });

  test('J6c (V38): 실행은 탭 이동 후 Space 로 된다', async ({ page }) => {
    await waitForInit(page, 'desktop');
    await open(page);
    await go(page).focus();
    await page.keyboard.press('Space');
    await expect(box(page)).toHaveAttribute('data-stage', '2');
    await go(page).focus();
    await page.keyboard.press('Space');
    await expect(page.locator('#git-confirm')).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).__res)).toBe(true);
    expect(await page.evaluate(() => (window as any).__ran)).toBe(1);
  });

  test('J7 (V37): 1단계가 대상 목록을 보인다 (개수만이 아니다)', async ({ page }) => {
    const targets = ['a.txt', '디렉터리/한글 파일.txt', 'src/deep/nested/thing.bin'];
    await waitForInit(page, 'desktop');
    await open(page, { targets });

    await expect(box(page)).toHaveAttribute('data-stage', '1');
    await expect(page.locator('#git-confirm .gc-target')).toHaveCount(3);
    for (const t of targets) {
      await expect(page.locator('#git-confirm .gc-targets')).toContainText(t);
    }
    // 개수는 목록과 함께 보인다 (FR-GIT-91).
    await expect(page.locator('#git-confirm .gc-count')).toContainText('3');
    // 1단계에는 recovery hint 가 없다 — 2단계의 것이다.
    await expect(page.locator('#git-confirm .gc-hint')).toBeHidden();
  });

  test('J8 (V37): 2단계가 recovery hint 를 보인다', async ({ page }) => {
    await waitForInit(page, 'desktop');
    await open(page, {
      targets: ['a.txt', 'b.txt'],
      hint: { note: '폐기 전에 아래를 실행하세요', command: 'git stash push -- a.txt b.txt' },
    });

    await go(page).click();
    await expect(box(page)).toHaveAttribute('data-stage', '2');
    const hint = page.locator('#git-confirm .gc-hint');
    await expect(hint).toBeVisible();
    await expect(hint.locator('.gc-hint-note')).toContainText('폐기 전에 아래를 실행하세요');
    await expect(hint.locator('.gc-hint-cmd')).toHaveText('git stash push -- a.txt b.txt');
    // 무엇을 잃는지가 실행 직전에도 보인다.
    await expect(page.locator('#git-confirm .gc-target')).toHaveCount(2);
    await expect(go(page)).toHaveText('Run');
  });

  test('J8b (V37): hint 가 없으면 되돌릴 수 없다는 사실을 보인다', async ({ page }) => {
    await waitForInit(page, 'desktop');
    await open(page, { hint: null });
    await go(page).click();
    await expect(page.locator('#git-confirm .gc-hint-note')).toContainText('되돌릴 수 없습니다');
  });

  test('J9 (FR-GIT-94): 모바일 폭에서 실행 버튼이 목록과 분리돼 잘리지 않는다', async ({ page }) => {
    await waitForInit(page, 'mobile');
    const targets = Array.from({ length: 60 }, (_, i) => `pkg/module-${i}/very-long-file-name-${i}.ts`);
    await open(page, { targets });

    // app.isMobile 로 판정한다 — 호출자가 mobile 을 넘기지 않았다.
    await expect(box(page)).toHaveClass(/mobile/);

    const sep = await page.locator('#git-confirm .gc-actions').evaluate((el) => {
      const s = getComputedStyle(el);
      return { border: parseFloat(s.borderTopWidth), margin: parseFloat(s.marginTop) };
    });
    expect(sep.border, '목록과 버튼 사이에 구분선이 없다').toBeGreaterThanOrEqual(2);
    expect(sep.margin, '목록과 버튼 사이에 여백이 없다').toBeGreaterThan(0);

    // 목록은 스크롤되고 버튼을 화면 밖으로 밀지 않는다 (FR-GIT-177).
    const scrollable = await page
      .locator('#git-confirm .gc-targets')
      .evaluate((el) => el.scrollHeight > el.clientHeight && getComputedStyle(el).overflowY === 'auto');
    expect(scrollable, '목록이 스크롤되지 않는다').toBe(true);

    for (const stage of ['1', '2']) {
      if (stage === '2') {
        await go(page).click();
        await expect(box(page)).toHaveAttribute('data-stage', '2');
      }
      const list = await page.locator('#git-confirm .gc-targets').boundingBox();
      const btn = await go(page).boundingBox();
      expect(btn).not.toBeNull();
      expect(btn!.width).toBeGreaterThan(0);
      expect(btn!.y, `${stage}단계: 실행 버튼이 목록과 겹친다`).toBeGreaterThanOrEqual(
        list!.y + list!.height,
      );
      expect(btn!.y, `${stage}단계: 실행 버튼이 화면 위로 잘린다`).toBeGreaterThanOrEqual(0);
      expect(btn!.y + btn!.height, `${stage}단계: 실행 버튼이 화면 밖으로 밀렸다`).toBeLessThanOrEqual(
        MOBILE.height,
      );
    }
  });

  test('J10 (FR-GIT-175): 실패 시 stderr tail 과 복사 버튼이 보인다', async ({ page }) => {
    const tail = ['error: unable to unlink a.txt', 'fatal: 마지막 줄', 'hint: 권한을 확인하세요'].join('\n');
    await waitForInit(page, 'desktop');
    await open(page, { fail: { reason: '폐기에 실패했습니다', stderrTail: tail } });

    await go(page).click();
    await go(page).click();

    const err = page.locator('#git-confirm .gc-err');
    await expect(err).toBeVisible();
    await expect(err.locator('.gc-err-reason')).toHaveText('폐기에 실패했습니다');
    await expect(err.locator('.gc-err-tail')).toHaveText(tail);
    await expect(err.locator('.gc-copy-err')).toBeVisible();
    // 실패해도 다이얼로그는 닫히지 않는다 — 닫으면 복사할 자리가 사라진다.
    await expect(box(page)).toBeVisible();
    expect(await page.evaluate(() => (window as any).__res)).toBeUndefined();

    await err.locator('.gc-copy-err').click();
    await expect(err.locator('.gc-err-tail')).toHaveText(tail);
  });

  test('J11 (FR-GIT-178): 대상이 변경되면 목록 위에 알리고 실행은 막지 않는다', async ({ page }) => {
    await waitForInit(page, 'desktop');
    // 비교 기준은 다이얼로그를 열었을 때의 저장소 signature 다 — _applyStatus 가
    // 관측마다 넣는 값이다. 여기서는 그 상태만 만들어 둔다.
    await page.evaluate(() => ((window as any).app.gitPanel._lastSig = 'sig-A'));
    await open(page, { targets: ['a.txt'] });

    const note = page.locator('#git-confirm .gc-changed');
    await expect(note).toBeHidden();
    // 같은 signature 는 아무것도 알리지 않는다.
    await page.evaluate(() => (window as any).GitConfirm.notify('sig-A'));
    await expect(note).toBeHidden();
    // 폴링이 새 signature 를 물고 오는 경로다.
    await page.evaluate(() => (window as any).GitConfirm.notify('sig-B'));
    await expect(note).toBeVisible();
    await expect(note).toContainText('대상이 변경되었습니다');

    // 다시 열게 강제하지 않는다 — 실행 경로는 그대로 열려 있다.
    await expect(go(page)).toBeEnabled();
    await go(page).click();
    await go(page).click();
    await expect(page.locator('#git-confirm')).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).__res)).toBe(true);
  });

  test('J12 (FR-GIT-174): 실행 중에는 두 버튼이 disable 되고 진행을 보인다', async ({ page }) => {
    await waitForInit(page, 'desktop');
    await page.evaluate(() => {
      const w = window as any;
      w.__res = undefined;
      w.__done = null;
      w.GitConfirm.open({
        action: 'discard',
        title: '변경을 폐기합니다',
        targets: ['a.txt'],
        hint: { command: 'git stash push -- a.txt' },
        run: () => new Promise((res) => { w.__done = () => res({ ok: true }) }),
      }).then((v: boolean) => { w.__res = v });
    });
    await expect(box(page)).toBeVisible();

    await go(page).click();
    await go(page).click();
    await expect(go(page)).toBeDisabled();
    await expect(cancel(page)).toBeDisabled();
    await expect(page.locator('#git-confirm .gc-progress')).toContainText('Running');

    // 실행 중에는 Esc 도 취소하지 않는다.
    await page.keyboard.press('Escape');
    await expect(box(page)).toBeVisible();

    await page.evaluate(() => (window as any).__done());
    await expect(page.locator('#git-confirm')).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).__res)).toBe(true);
  });
});

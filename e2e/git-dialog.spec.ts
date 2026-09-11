import { writeFileSync } from 'fs';
import { join } from 'path';

import { Page } from '@playwright/test';

import { test, expect, makeCopyFx, GIT_VIEW_TABS, clickGitView, waitForInit as fxWaitForInit, openGit as fxOpenGit, gitFixture, cleanGitFixture } from './fixtures';
import { tmpPath } from './osenv';

// GIT_M5_STEP1821_CONTRACT §3 — 다이얼로그 공통 규약. 검증 V59
// (FR-GIT-171~178).
//
// 20단계는 새 다이얼로그를 만드는 단계가 아니라 이미 만든 것들을 하나의 골격 아래로
// 모으는 단계다. 그래서 여기서 재는 것은 **골격 자체**이고, 흡수한 다이얼로그가
// 그것을 쓰는지는 D1 이 가른다.

const FIXTURES = tmpPath('dm-git-fx-dialog-' + process.pid);

const DESKTOP = { width: 1280, height: 720 };
const MOBILE = { width: 390, height: 640 };

test.beforeAll(() => {
  gitFixture(FIXTURES);
});
test.afterAll(() => {
  cleanGitFixture(FIXTURES);
});

const copyFx = makeCopyFx(FIXTURES);
// 골격만 재는 스펙은 저장소가 필요 없다 — window.GitDialog 를 직접 부른다.
async function waitForInit(page: Page, mode: 'desktop' | 'mobile' = 'desktop') {
  await fxWaitForInit(page, {
    mode,
    viewport: mode === 'mobile' ? MOBILE : DESKTOP,
    readyFor: { fn: () => !!document.querySelector('#area') && !!(window as any).GitDialog },
  });
}

async function openGit(page: Page, repo: string) {
  // 이 스펙의 waitForInit 은 `GitDialog` 가 실린 것까지만 본다 — 터미널이 서는
  // 것은 여기서 기다린다 (FR-RST-15).
  await page.waitForSelector('#area .pn.focused .xterm-helper-textarea', { timeout: 15000 });
  await fxOpenGit(page, repo);
}

type OpenArgs = {
  destructive?: boolean;
  fail?: { reason: string; stderrTail: string };
  hold?: boolean;
  many?: number;
};

// open 의 promise 를 evaluate 가 await 하지 않게 한다 — 다이얼로그가 열린 채
// 검사해야 하므로 결과는 window 에 남긴다 (git-confirm.spec.ts 와 같은 규약).
async function open(page: Page, a: OpenArgs = {}) {
  await page.evaluate((arg: OpenArgs) => {
    const w = window as any;
    w.__res = undefined;
    w.__ran = 0;
    w.__done = null;
    const run = () => {
      w.__ran++;
      if (arg.hold) return new Promise((res) => { w.__done = () => res({ ok: true }) });
      if (arg.fail) return { ok: false, reason: arg.fail.reason, stderrTail: arg.fail.stderrTail };
      return { ok: true };
    };
    w.GitDialog.open({
      action: 'discard',
      title: '테스트 다이얼로그',
      body: '무엇을 할지 고르세요',
      runLabel: '실행',
      destructive: !!arg.destructive,
      targets: ['a.txt'],
      hint: { note: '되돌리는 방법', command: 'git stash push -- a.txt' },
      fields: [
        { key: 'msg', type: 'text', placeholder: '메시지' },
        { key: 'over', type: 'check', label: '덮어쓰기' },
        { key: 'mode', type: 'radio', label: '방식', opts: [
          { v: '', label: '기본' },
          { v: 'rebase', label: 'rebase' },
          { v: 'force', label: 'force' },
        ] },
      ].concat(Array.from({ length: arg.many || 0 }, (_unused, i) => ({
        key: 'extra' + i, type: 'check',
        label: 'pkg/module-' + i + '/아주 긴 이름의 옵션 항목 ' + i,
      })) as any),
      run,
    }).then((v: unknown) => { w.__res = v });
  }, a);
}

const box = (page: Page) => page.locator('#git-dialog .git-dialog-box');
const go = (page: Page) => box(page).locator('.git-dialog-go');
const cancel = (page: Page) => box(page).locator('.git-dialog-cancel');
const confirm = (page: Page) => page.locator('#git-confirm .gc-box');
const ran = (page: Page) => page.evaluate(() => (window as any).__ran);
const res = (page: Page) => page.evaluate(() => (window as any).__res);

// 골격의 자리들. 흡수한 다이얼로그가 이것을 하나도 빼놓지 않아야 한다 (FR-GIT-171).
async function hasSkeleton(page: Page, id: string) {
  const b = page.locator('#' + id + ' .git-dialog-box');
  await expect(b).toBeVisible({ timeout: 15000 });
  await expect(b.locator('.git-dialog-head')).toHaveCount(1);
  await expect(b.locator('.git-dialog-head')).not.toHaveText('');
  await expect(b.locator('.git-dialog-changed')).toHaveCount(1);
  await expect(b.locator('.git-dialog-fields')).toHaveCount(1);
  await expect(b.locator('.git-dialog-err')).toHaveCount(1);
  await expect(b.locator('.git-dialog-actions .git-dialog-progress')).toHaveCount(1);
  await expect(b.locator('.git-dialog-actions .git-dialog-cancel')).toHaveCount(1);
  await expect(b.locator('.git-dialog-actions .git-dialog-go')).toHaveCount(1);
}

test.describe('20단계 — 다이얼로그 공통 규약', () => {
  test('D1 (V59 / FR-GIT-171): 흡수한 다이얼로그가 같은 골격을 쓴다', async ({ page }) => {
    const repo = copyFx('basic', 'd1');
    await waitForInit(page);
    await openGit(page, repo);

    // 브랜치 생성 (FR-GIT-158)
    await clickGitView(page, 'branches');
    await page.click('#area .pn-body .git-view.git-branches .git-br-new');
    await hasSkeleton(page, 'git-br-create');
    await page.keyboard.press('Escape');
    await expect(page.locator('#git-br-create')).toHaveCount(0);

    // stash 생성 (FR-GIT-166)
    await clickGitView(page, 'stash');
    const newStash = page.locator('#area .pn-body .git-view.git-stash .git-stash-new');
    await expect(newStash).toBeEnabled({ timeout: 20000 });
    await newStash.click();
    await hasSkeleton(page, 'git-stash-create');
    await page.keyboard.press('Escape');
    await expect(page.locator('#git-stash-create')).toHaveCount(0);

    // 원격 `▾` 옵션 (FR-GIT-109·110)
    // FR-RTU-32: Changes 는 사이드에 늘 있다 — 돌아갈 탭이 없다.
    const more = page.locator('#area .ed-side .git-view.git-changes .git-head '
      + '.git-remote-more[data-remote="fetch"]');
    await expect(more).toBeEnabled({ timeout: 20000 });
    await more.click();
    await hasSkeleton(page, 'git-remote-opts');
    // 흡수해도 자기 이름은 잃지 않는다 — 앞선 단계의 e2e 가 그것으로 재고 있다.
    await expect(page.locator('#git-remote-opts .gro-box')).toHaveCount(1);
    await page.keyboard.press('Escape');
    await expect(page.locator('#git-remote-opts')).toHaveCount(0);
  });

  test('D2 (V59 / FR-GIT-172): 파괴적이면 확인에 위임한다', async ({ page }) => {
    await waitForInit(page);
    await open(page, { destructive: true });

    // 확인 로직은 9단계 GitConfirm 의 것 하나뿐이다 — 골격을 따로 세우지 않는다.
    await expect(confirm(page)).toBeVisible({ timeout: 15000 });
    await expect(page.locator('.git-dialog-box')).toHaveCount(0);
    await expect(confirm(page)).toHaveAttribute('data-stage', '1');
    // 확인을 지나야 실행된다 — 열려 있는 동안에는 아직 돌지 않았다.
    expect(await ran(page)).toBe(0);
    await confirm(page).locator('.gc-go').click();
    await expect(page.locator('#git-confirm')).toHaveCount(0);
    expect(await ran(page)).toBe(1);
    expect(await res(page)).toBe(true);
  });

  test('D3 (V59 / FR-GIT-173): 옵션 기본값이 안전한 쪽이다', async ({ page }) => {
    await waitForInit(page);
    await open(page);
    await expect(box(page)).toBeVisible();

    // 체크박스는 꺼짐이다 — force 도 삭제도 기본이 아니다.
    await expect(box(page).locator('.git-dialog-field[data-key="over"] input')).not.toBeChecked();
    // 라디오는 첫 선택지이고 그것이 안전한 쪽이다.
    const radios = box(page).locator('.git-dialog-field[data-key="mode"] input');
    await expect(radios).toHaveCount(3);
    await expect(radios.nth(0)).toBeChecked();
    await expect(radios.nth(1)).not.toBeChecked();
    await expect(radios.nth(2)).not.toBeChecked();
    // 자격증명을 받는 종류는 골격에 없다 (FR-GIT-104).
    await expect(box(page).locator('input[type="password"]')).toHaveCount(0);
    // FR-PDA-1 로 개정: 기본 포커스는 **목적 버튼**인 실행이다 (종전에는
    // 취소였다). 이 다이얼로그는 `focus` 를 주지 않아 폴백 자리를 잰다.
    await expect(go(page)).toBeFocused();
  });

  test('D4 (V59 / FR-GIT-174): 실행 중에는 중복 실행을 막고 진행을 보인다', async ({ page }) => {
    await waitForInit(page);
    await open(page, { hold: true });
    await expect(box(page)).toBeVisible();

    await go(page).click();
    // 버튼은 이미 disable 이고 키 경로도 함께 막힌다.
    await page.keyboard.press('Enter');
    expect(await ran(page)).toBe(1);
    await expect(box(page).locator('.git-dialog-progress')).toContainText('Running');
    await expect(go(page)).toBeDisabled();
    await expect(cancel(page)).toBeDisabled();
    // 옵션도 함께 막힌다 — 실행 중에 값이 바뀌면 무엇이 실행됐는지 알 수 없다.
    await expect(box(page).locator('.git-dialog-field[data-key="over"] input')).toBeDisabled();
    // 실행 중에는 Esc 도 취소하지 않는다.
    await page.keyboard.press('Escape');
    await expect(box(page)).toBeVisible();

    await page.evaluate(() => (window as any).__done());
    await expect(page.locator('#git-dialog')).toHaveCount(0);
    expect(await res(page)).toBe(true);
  });

  test('D5 (V59 / FR-GIT-175): 실패는 사유·stderr tail 과 복사 버튼을 남긴다', async ({ page }) => {
    await waitForInit(page);
    const tail = 'error: pathspec did not match\nfatal: 실패했습니다';
    await open(page, { fail: { reason: '동작이 실패했습니다', stderrTail: tail } });

    await go(page).click();
    const err = box(page).locator('.git-dialog-err');
    await expect(err).toBeVisible();
    await expect(err.locator('.git-dialog-err-reason')).toHaveText('동작이 실패했습니다');
    // 원문 그대로 보존한다 — 줄바꿈이 사라지면 stderr 가 아니다.
    await expect(err.locator('.git-dialog-err-tail')).toHaveText(tail);
    await expect(err.locator('.git-dialog-copy')).toBeVisible();
    // 닫아 버리면 복사할 자리가 사라진다 — 실패에도 열려 있다.
    await expect(box(page)).toBeVisible();
    await err.locator('.git-dialog-copy').click();
    await expect(err.locator('.git-dialog-err-tail')).toHaveText(tail);

    // 다시 실행할 수 있다.
    await expect(go(page)).toBeEnabled();
    await cancel(page).click();
    expect(await res(page)).toBe(false);
  });

  test('D6 (V59 / FR-GIT-176): Esc 는 취소, Enter 는 기본 동작이다', async ({ page }) => {
    await waitForInit(page);

    // Esc 는 실행하지 않고 닫는다.
    await open(page);
    await expect(box(page)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('#git-dialog')).toHaveCount(0);
    expect(await ran(page)).toBe(0);
    expect(await res(page)).toBe(false);

    // 파괴적이 아니면 Enter 의 기본 동작은 실행이다.
    await open(page);
    await expect(box(page)).toBeVisible();
    await page.keyboard.press('Enter');
    await expect(page.locator('#git-dialog')).toHaveCount(0);
    expect(await ran(page)).toBe(1);
    expect(await res(page)).toBe(true);

    // POPUP_DEFAULT_ACTION_SRS FR-PDA-2·21 로 **뜻이 뒤집혔다.**
    //   이전: 파괴적이면 Enter 의 기본 동작은 취소 — 실행 버튼에 포커스가 있어도
    //   지금: Enter 는 **포커스된 것**을 누른다. 파괴적이어도 다르지 않다
    await open(page, { destructive: true });
    await expect(confirm(page)).toBeVisible({ timeout: 15000 });
    await confirm(page).locator('.gc-go').focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('#git-confirm')).toHaveCount(0);
    expect(await ran(page)).toBe(1);
    expect(await res(page)).toBe(true);

    // 그리고 취소에 포커스를 두면 같은 키가 취소다.
    await open(page, { destructive: true });
    await expect(confirm(page)).toBeVisible({ timeout: 15000 });
    await confirm(page).locator('.gc-cancel').focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('#git-confirm')).toHaveCount(0);
    expect(await ran(page)).toBe(0);
    expect(await res(page)).toBe(false);
  });

  test('D7 (V59 / FR-GIT-177): 모바일 폭에서 옵션과 확인 버튼이 잘리지 않는다', async ({ page }) => {
    await waitForInit(page, 'mobile');
    // 옵션이 화면보다 길어야 "잘리지 않는다" 가 뜻을 가진다.
    await open(page, { many: 40 });
    await expect(box(page)).toBeVisible();
    // app.isMobile 로 판정한다 — 호출자가 mobile 을 넘기지 않았다.
    await expect(box(page)).toHaveClass(/mobile/);
    // 옵션은 스크롤되고 확인 버튼을 화면 밖으로 밀지 않는다.
    const scrollable = await box(page).locator('.git-dialog-fields').evaluate(
      (el) => el.scrollHeight > el.clientHeight && getComputedStyle(el).overflowY === 'auto');
    expect(scrollable, '옵션이 스크롤되지 않는다').toBe(true);

    // 확인 버튼이 화면 안에 있고 누를 수 있다.
    await expect(go(page)).toBeVisible();
    await expect(cancel(page)).toBeVisible();
    const b = await box(page).boundingBox();
    const gb = await go(page).boundingBox();
    const cb = await cancel(page).boundingBox();
    expect(b).not.toBeNull();
    expect(gb).not.toBeNull();
    expect(cb).not.toBeNull();
    expect(gb!.x).toBeGreaterThanOrEqual(0);
    expect(gb!.x + gb!.width).toBeLessThanOrEqual(MOBILE.width);
    expect(gb!.y + gb!.height).toBeLessThanOrEqual(MOBILE.height);
    expect(b!.y + b!.height).toBeLessThanOrEqual(MOBILE.height);

    // 옵션과 분리된 별도 행이다 — 구분선과 세로 배치로 목록에서 떼어 놓는다.
    const fields = await box(page).locator('.git-dialog-fields').boundingBox();
    const acts = await box(page).locator('.git-dialog-actions').boundingBox();
    expect(fields).not.toBeNull();
    expect(acts).not.toBeNull();
    expect(acts!.y).toBeGreaterThanOrEqual(fields!.y + fields!.height);
    const sep = await box(page).locator('.git-dialog-actions').evaluate((el) => {
      const cs = getComputedStyle(el);
      return { dir: cs.flexDirection, border: parseFloat(cs.borderTopWidth) };
    });
    expect(sep.dir).toBe('column');
    expect(sep.border).toBeGreaterThan(0);
    // 두 버튼이 겹치지 않고 세로로 쌓인다.
    expect(cb!.y + cb!.height).toBeLessThanOrEqual(gb!.y + 1);
  });

  test('D8 (V59 / FR-GIT-178): 열린 동안 대상이 변하면 알리고 실행은 막지 않는다', async ({ page }) => {
    const repo = copyFx('basic', 'd8');
    await waitForInit(page);
    await openGit(page, repo);
    // 상태 지문은 관측된 status 를 딛는다 — 그것이 오기 전에 열면 비교 기준이 없다.
    await expect(page.locator('#area .ed-side .git-view.git-changes .git-file').first())
      .toBeVisible({ timeout: 20000 });

    await open(page);
    const note = box(page).locator('.git-dialog-changed');
    await expect(note).toBeHidden();

    // 폴링은 다이얼로그가 열린 동안에도 계속된다 — 대상이 움직인 것을 알아낸다.
    writeFileSync(join(repo, 'while-open.txt'), 'changed under the dialog\n');
    await expect(note).toBeVisible({ timeout: 20000 });
    await expect(note).toContainText('대상이 변경되었습니다');

    // 다시 열게 강제하지 않는다 — 실행 경로는 그대로 열려 있다.
    await expect(go(page)).toBeEnabled();
    await go(page).click();
    await expect(page.locator('#git-dialog')).toHaveCount(0);
    expect(await res(page)).toBe(true);
  });
});

/**
 * 묶음 OV — 본문이 길어도 상자가 화면을 넘지 않는다 (사용자 보고 `U-26`).
 *
 * `FR-GIT-177` 은 *"옵션이 실행 버튼을 화면 밖으로 밀지 않는다"* 를 요구하고
 * `.git-dialog-fields` 에 그 대비가 있다. 그런데 **`.git-dialog-body` 에는 없었다** —
 * `flex`·`min-height`·`overflow` 가 셋 다 빠져 있어 줄어들지도 구르지도 못했다.
 *
 * 그 자리에 오는 것이 곧 사용자가 말한 "파일 목록" 이다: 병합·체크아웃이 충돌하면
 * `branches.js` 가 서버 메시지(`d.message` — 충돌 파일의 목록)를 그대로 `body` 로
 * 넘긴다. 파일이 많을수록 길어지고, 그만큼 버튼이 아래로 밀린다.
 */
test.describe('묶음 OV — 긴 본문의 넘침', () => {
  const longBody = (n: number) =>
    'CONFLICT (content): Merge conflict in\n' +
    Array.from({ length: n },
      (_, i) => `packages/server/src/deeply/nested/module-${i}/handler.spec.ts`).join('\n');

  async function openBody(page: Page, body: string) {
    await page.evaluate((b: string) => {
      const w = window as any;
      w.__res = undefined;
      w.GitDialog.open({
        id: 'git-ov', ns: 'gov', action: 'merge',
        title: '병합이 충돌했습니다', runLabel: '확인',
        body: b,
        fields: [],
        run: async () => ({ ok: true }),
      }).then((v: any) => { w.__res = v });
    }, body);
    await expect(page.locator('#git-ov .git-dialog-box')).toBeVisible({ timeout: 10000 });
  }

  async function fits(page: Page) {
    return page.evaluate(() => {
      const box = document.querySelector('#git-ov .git-dialog-box') as HTMLElement;
      const acts = document.querySelector('#git-ov .git-dialog-actions, #git-ov .gov-actions') as HTMLElement;
      const b = box.getBoundingClientRect();
      const a = acts ? acts.getBoundingClientRect() : null;
      const bd = document.querySelector('#git-ov .git-dialog-body') as HTMLElement;
      return {
        boxTop: Math.round(b.top), boxBottom: Math.round(b.bottom), boxRight: Math.round(b.right),
        vh: window.innerHeight, vw: window.innerWidth,
        actionsBottom: a ? Math.round(a.bottom) : -1,
        bodyScrolls: bd.scrollHeight > bd.clientHeight,
      };
    });
  }

  test('OV1: 충돌 파일이 아주 많아도 상자와 버튼이 화면 안에 있다', async ({ page }) => {
    await waitForInit(page);
    await openBody(page, longBody(400));

    const m = await fits(page);
    expect(m.boxTop, `상자 위가 화면 밖이다 (top=${m.boxTop})`).toBeGreaterThanOrEqual(0);
    expect(m.boxBottom, `상자 아래가 화면 밖이다 (bottom=${m.boxBottom} vh=${m.vh})`)
      .toBeLessThanOrEqual(m.vh);
    expect(m.boxRight, '상자가 가로로 넘쳤다').toBeLessThanOrEqual(m.vw);
    if (m.actionsBottom >= 0) {
      expect(m.actionsBottom, '실행 버튼이 화면 밖으로 밀렸다').toBeLessThanOrEqual(m.vh);
    }
    expect(m.bodyScrolls, '본문이 스스로 구르지 않는다 — 넘치는 것을 바깥으로 민다').toBe(true);
  });

  test('OV2: 좁은 화면에서도 같다', async ({ page }) => {
    await waitForInit(page, 'mobile');
    await openBody(page, longBody(400));

    const m = await fits(page);
    expect(m.boxTop).toBeGreaterThanOrEqual(0);
    expect(m.boxBottom, `상자 아래가 화면 밖이다 (bottom=${m.boxBottom} vh=${m.vh})`)
      .toBeLessThanOrEqual(m.vh);
    expect(m.boxRight, '상자가 가로로 넘쳤다').toBeLessThanOrEqual(m.vw);
  });
});

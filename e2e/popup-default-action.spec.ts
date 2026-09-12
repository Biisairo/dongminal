import { Page } from '@playwright/test';

import { test, expect, waitForInit as fxWaitForInit } from './fixtures';

// POPUP_DEFAULT_ACTION_SRS §5 — 검증 V-PDA-1~41.
//
// 규약은 한 줄로 준다 (FR-PDA-1·2): **기본 포커스가 목적 버튼에 있고, `Enter` 는
// 포커스된 것을 누른다.** 그래서 이 스펙이 재는 것도 둘이다 —
//   ① 열렸을 때 무엇이 포커스인가
//   ② 포커스를 **취소로 옮긴 뒤** 누른 `Enter` 가 취소인가 (가로채지 않는다는 증거)
//
// ②가 없으면 "Enter 로 실행" 을 가로채기로 구현해도 통과한다. D-1 이 그것을
// 기각한 근거가 이 자리다.
//
// 팝업 여덟 자리를 직접 부른다 — 실제 파괴적 동작을 태우는 것보다 결정론적이고,
// 재는 대상이 껍데기의 키·포커스 규약이기 때문이다 (background-ui.spec.ts 와
// 같은 규약).

const DESKTOP = { width: 1280, height: 720 };
const MOBILE = { width: 390, height: 640 };

async function waitForInit(page: Page, mode: 'desktop' | 'mobile' = 'desktop') {
  await fxWaitForInit(page, {
    mode,
    viewport: mode === 'mobile' ? MOBILE : DESKTOP,
    readyFor: {
      fn: () => !!document.querySelector('#area')
        && !!(window as any).GitConfirm && !!(window as any).GitDialog,
    },
  });
}

// `UIKit` 는 최상위 `const` 라 전역 **어휘** 환경에 산다 — `window.UIKit` 이
// 아니다 (`GitConfirm`·`GitDialog` 는 e2e 를 위해 window 에 따로 실린다).
// 테스트를 위해 프로덕션에 export 를 더하지 않고 맨 이름으로 참조한다.
declare const UIKit: {
  modal(spec: Record<string, unknown>): { el: HTMLElement; close(): void };
};

const ran = (page: Page) => page.evaluate(() => (window as any).__ran);
const res = (page: Page) => page.evaluate(() => (window as any).__res);

// ── GitConfirm (자리 1) ──────────────────────────────

type ConfirmArgs = { fail?: { reason: string; stderrTail: string }; hold?: boolean };

async function openConfirm(page: Page, a: ConfirmArgs = {}) {
  await page.evaluate((arg: ConfirmArgs) => {
    const w = window as any;
    w.__res = undefined; w.__ran = 0; w.__done = null;
    w.GitConfirm.open({
      action: 'discard',
      title: '변경을 폐기합니다',
      targets: ['a.txt'],
      hint: { note: '폐기 전에', command: 'git stash push -- a.txt' },
      run: () => {
        w.__ran++;
        if (arg.hold) return new Promise((r) => { w.__done = () => r({ ok: true }) });
        if (arg.fail) return { ok: false, reason: arg.fail.reason, stderrTail: arg.fail.stderrTail };
        return { ok: true };
      },
    }).then((v: boolean) => { w.__res = v });
  }, a);
  await expect(page.locator('#git-confirm .gc-box')).toBeVisible({ timeout: 10000 });
}

const gcGo = (page: Page) => page.locator('#git-confirm .gc-go');
const gcCancel = (page: Page) => page.locator('#git-confirm .gc-cancel');

test.describe('묶음 A — GitConfirm (FR-PDA-1~7)', () => {
  test('V-PDA-1 (FR-PDA-1): 기본 포커스가 실행 버튼이다', async ({ page }) => {
    await waitForInit(page);
    await openConfirm(page);
    await expect(gcGo(page)).toBeFocused();
  });

  test('V-PDA-2 (FR-PDA-2): 그 상태의 Enter 가 실행한다', async ({ page }) => {
    await waitForInit(page);
    await openConfirm(page);
    await page.keyboard.press('Enter');
    await expect(page.locator('#git-confirm')).toHaveCount(0);
    expect(await ran(page)).toBe(1);
    expect(await res(page)).toBe(true);
  });

  test('V-PDA-3 (FR-PDA-2): 취소로 포커스를 옮기면 Enter 가 취소한다',
    async ({ page }) => {
      await waitForInit(page);
      await openConfirm(page);
      await gcCancel(page).focus();
      await expect(gcCancel(page)).toBeFocused();

      await page.keyboard.press('Enter');

      await expect(page.locator('#git-confirm')).toHaveCount(0);
      // 가로챘다면 여기서 1 이 된다 — 이 단정이 D-1 의 자리다.
      expect(await ran(page), 'Enter 를 가로채 실행했다').toBe(0);
      expect(await res(page)).toBe(false);
    });

  test('V-PDA-4 (FR-PDA-3): Esc 는 동작 없이 닫는다', async ({ page }) => {
    await waitForInit(page);
    await openConfirm(page);
    await page.keyboard.press('Escape');
    await expect(page.locator('#git-confirm')).toHaveCount(0);
    expect(await ran(page)).toBe(0);
    expect(await res(page)).toBe(false);
  });

  test('V-PDA-5 (FR-PDA-4): 모바일 폭에서도 실행 버튼이 포커스다', async ({ page }) => {
    await waitForInit(page, 'mobile');
    await openConfirm(page);
    await expect(gcGo(page)).toBeFocused();
    // 레이아웃 분리는 그대로다 (FR-GIT-94 의 남는 절반).
    await expect(page.locator('#git-confirm .gc-box')).toHaveClass(/\bmobile\b/);
  });

  test('V-PDA-6 (FR-PDA-6): 실행 중에는 Enter 가 두 번째 실행을 만들지 않는다',
    async ({ page }) => {
      await waitForInit(page);
      await openConfirm(page, { hold: true });
      await page.keyboard.press('Enter');
      await expect(gcGo(page)).toBeDisabled();
      await expect(gcCancel(page)).toBeDisabled();

      await page.keyboard.press('Enter');
      await page.keyboard.press('Enter');
      expect(await ran(page)).toBe(1);

      await page.evaluate(() => (window as any).__done());
      await expect(page.locator('#git-confirm')).toHaveCount(0);
      expect(await ran(page)).toBe(1);
    });

  test('V-PDA-7 (FR-PDA-7): 실패로 남은 팝업의 포커스도 실행 버튼이다',
    async ({ page }) => {
      await waitForInit(page);
      await openConfirm(page, { fail: { reason: '거부됨', stderrTail: 'fatal: nope' } });
      await page.keyboard.press('Enter');
      await expect(page.locator('#git-confirm .gc-box')).toBeVisible();
      await expect(gcGo(page)).toBeFocused();
      expect(await ran(page)).toBe(1);
    });
});

// ── GitDialog (자리 2) ───────────────────────────────

type DialogArgs = { choices?: boolean; fields?: boolean };

async function openDialog(page: Page, a: DialogArgs = {}) {
  await page.evaluate((arg: DialogArgs) => {
    const w = window as any;
    w.__res = undefined; w.__ran = 0;
    const spec: Record<string, unknown> = {
      action: 'discard',
      title: '테스트 다이얼로그',
      body: '무엇을 할지 고르세요',
      runLabel: '실행',
      run: () => { w.__ran++; return { ok: true } },
    };
    if (arg.fields) spec.fields = [{ key: 'msg', type: 'text', placeholder: '메시지' }];
    if (arg.choices) {
      spec.choices = [{ id: 'a', label: '첫째' }, { id: 'b', label: '둘째' }];
      spec.def = 'a';
    }
    w.GitDialog.open(spec).then((v: unknown) => { w.__res = v });
  }, a);
  await expect(page.locator('#git-dialog .git-dialog-box')).toBeVisible({ timeout: 10000 });
}

const gdGo = (page: Page) => page.locator('#git-dialog .git-dialog-go');
const gdCancel = (page: Page) => page.locator('#git-dialog .git-dialog-cancel');

test.describe('묶음 B — GitDialog (FR-PDA-5·10)', () => {
  test('V-PDA-10 (FR-PDA-10): 실행형은 실행 버튼이 포커스다', async ({ page }) => {
    await waitForInit(page);
    await openDialog(page);
    await expect(gdGo(page)).toBeFocused();
  });

  test('V-PDA-11 (FR-PDA-5): 필드가 있으면 입력이 포커스이고 거기서 Enter 가 실행한다',
    async ({ page }) => {
      await waitForInit(page);
      await openDialog(page, { fields: true });
      const inp = page.locator('#git-dialog .git-dialog-field[data-key="msg"] input');
      await inp.focus();
      await expect(inp).toBeFocused();

      await page.keyboard.press('Enter');
      await expect(page.locator('#git-dialog')).toHaveCount(0);
      expect(await ran(page)).toBe(1);
    });

  test('V-PDA-12 (FR-PDA-10): 선택형은 기본 선택이 포커스다', async ({ page }) => {
    await waitForInit(page);
    await openDialog(page, { choices: true });
    await expect(page.locator('#git-dialog .git-dialog-opt[data-opt="a"]')).toBeFocused();
  });

  test('V-PDA-13 (FR-PDA-5): 취소로 포커스를 옮기면 Enter 가 취소한다',
    async ({ page }) => {
      await waitForInit(page);
      await openDialog(page);
      await gdCancel(page).focus();
      await expect(gdCancel(page)).toBeFocused();

      await page.keyboard.press('Enter');

      await expect(page.locator('#git-dialog')).toHaveCount(0);
      expect(await ran(page), 'Enter 를 무조건 가로채 실행했다').toBe(0);
      expect(await res(page)).toBe(false);
    });
});

// ── 탐색기 삭제 확인 (자리 4) ────────────────────────

async function openEdConfirm(page: Page) {
  await page.evaluate(() => {
    const w = window as any;
    w.__res = undefined;
    w.app.testing.edConfirm(['정말 지웁니다'], '삭제').then((v: boolean) => { w.__res = v });
  });
  await expect(page.locator('.ed-confirm .confirm-btns button').first())
    .toBeVisible({ timeout: 10000 });
}

test.describe('묶음 C — 탐색기 삭제 확인 (FR-PDA-10)', () => {
  test('V-PDA-20: 포커스가 삭제 버튼이고 Enter 가 지운다', async ({ page }) => {
    await waitForInit(page);
    await openEdConfirm(page);
    await expect(page.locator('.ed-confirm .confirm-ok')).toBeFocused();

    await page.keyboard.press('Enter');
    await expect(page.locator('.ed-confirm')).toHaveCount(0);
    expect(await res(page)).toBe(true);
  });

  test('V-PDA-21 (FR-PDA-3): Esc 는 지우지 않는다', async ({ page }) => {
    await waitForInit(page);
    await openEdConfirm(page);
    await page.keyboard.press('Escape');
    await expect(page.locator('.ed-confirm')).toHaveCount(0);
    expect(await res(page)).toBe(false);
  });
});

// ── 닫기 확인창 (자리 3) ─────────────────────────────

async function openClose(page: Page, opts: Record<string, unknown>) {
  await page.evaluate((o) => {
    const w = window as any;
    w.__res = undefined;
    w.app.testing.confirmClose('테스트', o).then((v: unknown) => { w.__res = v });
  }, opts);
  await page.waitForSelector('.confirm-overlay .confirm-btns button');
}

test.describe('묶음 D — 닫기 확인창 (FR-PDA-10 / D-4)', () => {
  test('V-PDA-30: 저장 버튼이 있으면 그것이 포커스다', async ({ page }) => {
    await waitForInit(page);
    await openClose(page, { saveBtn: true });
    await expect(page.locator('.confirm-overlay .confirm-save')).toBeFocused();

    await page.keyboard.press('Enter');
    await expect(page.locator('.confirm-overlay')).toHaveCount(0);
    expect(await res(page)).toBe('save');
  });

  test('V-PDA-31: 저장 버튼이 없으면 닫기가 포커스다', async ({ page }) => {
    await waitForInit(page);
    await openClose(page, { bgBtn: true });
    await expect(page.locator('.confirm-overlay .confirm-ok')).toBeFocused();

    await page.keyboard.press('Enter');
    await expect(page.locator('.confirm-overlay')).toHaveCount(0);
    expect(await res(page)).toBe(true);
  });

  test('V-PDA-32 (FR-PDA-2): 취소로 옮긴 Enter 는 취소다', async ({ page }) => {
    await waitForInit(page);
    await openClose(page, { saveBtn: true });
    await page.locator('.confirm-overlay .confirm-cancel').focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('.confirm-overlay')).toHaveCount(0);
    expect(await res(page)).toBe(false);
  });
});

// ── UIKit.modal (자리 7·8) ───────────────────────────

test.describe('묶음 E — UIKit.modal (FR-PDA-11)', () => {
  test('V-PDA-40: danger 액션이 목적 버튼이다', async ({ page }) => {
    await waitForInit(page);
    await page.evaluate(() => {
      const w = window as any;
      w.__picked = '';
      const body = document.createElement('div');
      body.textContent = '차단됩니다';
      const m = UIKit.modal({
        title: '이 브라우저가 차단됩니다',
        cls: 'acl-confirm',
        body,
        actions: [
          { label: '취소' },
          { label: '그래도 저장', kind: 'danger', onClick: () => { w.__picked = 'save' } },
        ],
      });
      document.body.appendChild(m.el);
    });
    const foot = page.locator('.acl-confirm .ui-modal-foot button');
    await expect(foot.nth(1)).toBeFocused();

    await page.keyboard.press('Enter');
    await expect(page.locator('.acl-confirm')).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).__picked)).toBe('save');
  });

  test('V-PDA-41: primary 액션이 목적 버튼이다 (종전대로)', async ({ page }) => {
    await waitForInit(page);
    await page.evaluate(() => {
      const w = window as any;
      w.__picked = '';
      const body = document.createElement('div');
      body.textContent = '여기서 엽니다';
      const m = UIKit.modal({
        title: '여기서 열기',
        cls: 'openurl-modal',
        body,
        actions: [
          { label: '취소' },
          { label: '열기', kind: 'primary', cls: 'openurl-go',
            onClick: () => { w.__picked = 'open' } },
        ],
      });
      document.body.appendChild(m.el);
    });
    await expect(page.locator('.openurl-modal .openurl-go')).toBeFocused();
  });
});

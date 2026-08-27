import { execFileSync } from 'child_process';
import { mkdtempSync, realpathSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { APIRequestContext, Page } from '@playwright/test';

import { test, expect } from './fixtures';

// GIT_REVIEW4_SRS §3.6.1~§3.6.4 — 개선 I1~I4. 검증 V132~V142
// (FR-GIT-236~239).
//
// 구현 전에 쓰는 RED 다 — web/ 은 아직 손대지 않았다. 관용구는 기존 파일들을
// 그대로 따른다: waitForInit·openGit·fx·rows 는 e2e/git-changes.spec.ts 와
// e2e/git-ui-revision.spec.ts, 모바일 폭 전환은 e2e/git-confirm.spec.ts, 테마
// 전환은 e2e/git-history.spec.ts(H4/V47), hover 생존은 e2e/git-repaint.spec.ts
// (P2/V106)를 본으로 삼았다.
//
// 이 파일의 테스트는 아직 정해지지 않은 선택자 세 벌을 **가정**한다 — 구현이
// 없으므로 스펙이 이름까지 고정하지 않았다. 리뷰에서 이름이 바뀌면 이 파일만
// 고치면 된다:
//   - `.git-file-act[data-act="openFile"]`  Open File 인라인 버튼 (I1)
//   - `.git-file-path-dir` / `.git-file-path-name`  디렉터리·파일명 분리 요소 (I2)
//   - `.git-head-refresh`                    Changes 헤더 새로고침 버튼 (I3)

const FIXTURES = '/tmp/dm-git-fx-improve-' + process.pid;

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

const DESKTOP = { width: 1280, height: 720 };
const MOBILE = { width: 390, height: 640 };

async function waitForInit(page: Page, mode: 'desktop' | 'mobile' = 'desktop') {
  await page.context().addInitScript((m) => {
    sessionStorage.setItem('displayMode', m as string);
  }, mode);
  await page.setViewportSize(mode === 'mobile' ? MOBILE : DESKTOP);
  await page.goto('/');
  await page.waitForSelector('#area .pn.focused .xterm-helper-textarea', { timeout: 15000 });
}

async function openGit(page: Page, repo: string) {
  await page.evaluate((r) => (window as any).app.openGitWindow(r), repo);
  // GIT_REVIEW4_SRS §3.6.5 FR-GIT-28(개정): 고정 탭이 Worktrees 를 더해 7개다.
  await expect(page.locator('#area .pn-tab[data-git-view]')).toHaveCount(7);
  await expect(page.locator('#area .pn-body .git-view.vis')).toHaveClass(/git-changes/);
}

const changes = (page: Page) => page.locator('#area .pn-body .git-view.git-changes');
const group = (page: Page, key: string) => changes(page).locator(`.git-group[data-group="${key}"]`);
const rows = (page: Page, key: string) => group(page, key).locator('.git-file');
const files = (page: Page) => page.locator('#area .pn-body .git-file');

// 파일 목록이 채워질 때까지 기다린다 — status 조회는 비동기다.
async function waitFiles(page: Page, min = 1) {
  await expect.poll(() => files(page).count(), { timeout: 20000 }).toBeGreaterThanOrEqual(min);
}

// 사이드바 핀 헬퍼 (e2e/git-sidebar.spec.ts 를 따른다).
// 서버는 rev-parse 로 정규화한 경로를 준다(macOS 의 /tmp → /private/tmp) —
// follow 행의 data-git-repo 와 직접 비교하려면 여기서도 realpathSync 해야 한다.
function makeRepoWithChange(prefix: string) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  execFileSync('git', ['init', '-q', dir]);
  execFileSync('bash', ['-c', `echo x > '${dir}/a.txt'`]);
  return realpathSync(dir);
}
async function pin(request: APIRequestContext, path: string) {
  const r = await request.post('/api/git/repos/pin', { data: { path } });
  expect(r.ok(), `pin 실패: ${await r.text()}`).toBeTruthy();
  return (await r.json()).root as string;
}
const pinned = (page: Page, root: string) =>
  page.locator(`#git-repos .git-repo.pinned[data-git-repo="${root}"]`);
async function cd(page: Page, dir: string) {
  await page.keyboard.type(`cd ${dir}`);
  await page.keyboard.press('Enter');
  await page.keyboard.type('echo moved_ok');
  await page.keyboard.press('Enter');
  await expect(page.locator('#area .pn.focused .xterm-rows')).toContainText('moved_ok', { timeout: 10000 });
}

test.describe('묶음 I — I1 Open File (FR-GIT-236)', () => {
  test('V132 (FR-GIT-236): 파일 행의 Open File 이 Git 창이 아닌 창에 그 파일의 편집기 탭을 열고 그 창을 활성화한다', async ({ page }) => {
    await waitForInit(page);
    await openGit(page, copyFx('basic', 'v132'));
    await waitFiles(page, 3);

    const btn = rows(page, 'changes').first().locator('.git-file-act[data-act="openFile"]');
    await expect(btn, 'Open File 인라인 버튼이 없다').toHaveCount(1, { timeout: 5000 });
    await btn.click();

    await expect.poll(() => page.evaluate(() => {
      const a = (window as any).app;
      const w = a.ws.windows.find((x: any) => x.id === a.ws.activeWindow);
      if (!w || w.type === 'git') return 'git-or-none';
      const has = (n: any): boolean =>
        n.type === 'pane' ? (n.tabs || []).some((t: any) => t.type === 'editor')
                          : (n.children || []).some(has);
      return has(w.layout) ? 'ok' : 'no-editor';
    }), { timeout: 20000 }).toBe('ok');

    // Git 창은 고정 탭 7개 그대로다 (FR-GIT-185 유지, V74 와 같은 방법).
    expect(await page.evaluate(() => {
      const g = (window as any).app.ws.windows.find((w: any) => w.type === 'git');
      return (g.layout.tabs || []).length;
    })).toBe(7);
  });

  test('V133 (FR-GIT-236): 디렉터리 행·그룹 머리에는 Open File 이 없고, 인라인 버튼과 우클릭 메뉴가 같은 함수를 지난다', async ({ page }) => {
    await waitForInit(page);
    const repo = copyFx('basic', 'v133');
    await openGit(page, repo);
    await waitFiles(page, 3);

    const filesBox = changes(page).locator('.git-files');
    await filesBox.locator('.git-files-mode[data-mode="tree"]').click();
    await expect(filesBox.locator('.git-dir').first()).toBeVisible({ timeout: 10000 });
    await expect(filesBox.locator('.git-dir .git-file-act[data-act="openFile"]'),
      '디렉터리 행에 Open File 이 있다').toHaveCount(0);
    await expect(changes(page).locator('.git-group-head .git-file-act[data-act="openFile"]'),
      '그룹 머리에 Open File 이 있다').toHaveCount(0);

    await filesBox.locator('.git-files-mode[data-mode="flat"]').click();
    const row = rows(page, 'changes').first();
    const btn = row.locator('.git-file-act[data-act="openFile"]');
    await expect(btn, '인라인 Open File 버튼이 없다').toHaveCount(1, { timeout: 5000 });

    // "같은 함수를 지난다"의 검증 가능한 형태: 인라인 버튼과 우클릭 메뉴 둘 다
    // 결국 app._gitOpenFile 을 같은 인자로 부른다(FR-GIT-41·185, menu.js:57).
    await page.evaluate(() => {
      const a = (window as any).app;
      (window as any).__openFileCalls = [];
      const orig = a._gitOpenFile.bind(a);
      a._gitOpenFile = (p: string) => { (window as any).__openFileCalls.push(p); return orig(p); };
    });

    await btn.click();

    // FR-GIT-41·185: Open File 은 대상 창을 활성화한다 — 그래서 인라인 버튼을
    // 누른 직후엔 **Git 창을 벗어나 있다**(V132 에서 이미 재현된 동작이다).
    // Changes 행은 그 사이 화면에 없으므로, 우클릭 전에 Git 창으로 돌아와야 한다.
    await expect.poll(() => page.evaluate(() => {
      const a = (window as any).app;
      return (a.ws.windows.find((w: any) => w.id === a.ws.activeWindow) || {}).type || 'terminal';
    }), { timeout: 20000 }).not.toBe('git');
    await openGit(page, repo);

    await row.click({ button: 'right' });
    await page.locator('.git-menu .git-menu-item[data-id="openFile"]').click();

    const calls = await page.evaluate(() => (window as any).__openFileCalls);
    expect(calls.length, `_gitOpenFile 이 두 경로에서 각각 불려야 한다: ${JSON.stringify(calls)}`).toBe(2);
    expect(calls[0]).toBe(calls[1]);
  });

  test('V134 (FR-GIT-236 · RPT-2, V106 확장): 행에 hover 한 채 3초 기다리면 동작 셋 전부의 opacity 가 유지된다', async ({ page }) => {
    await waitForInit(page);
    await openGit(page, copyFx('basic', 'v134'));
    await waitFiles(page, 3);

    const row = rows(page, 'changes').first();
    await expect(row).toBeVisible({ timeout: 10000 });
    await row.hover();

    const acts = row.locator('.git-file-act');
    // FR-GIT-236: Open File · Staging · 되돌리기 순 3개.
    await expect(acts, 'changes 행의 동작이 3개(Open File·stage·discard)가 아니다')
      .toHaveCount(3, { timeout: 5000 });
    const actKeys = await acts.evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.act));
    expect(actKeys).toEqual(['openFile', 'stage', 'discard']);
    for (let i = 0; i < 3; i++) await expect(acts.nth(i)).toHaveCSS('opacity', '1');

    // V106 과 같은 방법 — 요소에 표식을 심고 폴링 주기를 넘겨도 살아남는지 본다.
    const sel = '.git-view.git-changes .git-group[data-group="changes"] .git-file:first-child .git-file-act';
    const n = await page.evaluate((s: string) => {
      const els = [...document.querySelectorAll(s)];
      for (const e of els) (e as any).__rptMark = 1;
      return els.length;
    }, sel);
    expect(n).toBe(3);
    await page.waitForTimeout(2600); // GIT_STATUS_POLL_MS(1000) 를 두 회차 넘긴다
    const kept = await page.evaluate((s: string) => {
      const els = [...document.querySelectorAll(s)];
      return els.filter((e) => (e as any).__rptMark === 1).length;
    }, sel);
    expect(kept).toBe(n);
    for (let i = 0; i < 3; i++) await expect(acts.nth(i)).toHaveCSS('opacity', '1');
  });

  test('V161 (FR-GIT-236): 파일 셋을 고른 뒤 그 중 한 행의 Open File 을 누르면 편집기 탭이 하나만 열린다 — 누른 행의 파일이지 선택의 첫 항목이 아니다', async ({ page }) => {
    await waitForInit(page);
    const repo = copyFx('basic', 'v161');
    await openGit(page, repo);
    await waitFiles(page, 2);
    // 플랫 보기로 고정한다 — 트리는 행 순서가 디렉터리로 묶여 헷갈린다(V86 과 같은 이유).
    await changes(page).locator('.git-files-mode[data-mode="flat"]').click();

    // 다중 선택 방법은 e2e/git-ui-revision.spec.ts:726 V86(FR-GIT-208)을 그대로
    // 물려받는다: 첫 행 평클릭 + 나머지 ControlOrMeta 클릭.
    const changesRows = rows(page, 'changes');
    const n = await changesRows.count();
    expect(n, 'basic 픽스처의 changes 그룹이 2개 미만이다').toBeGreaterThanOrEqual(2);
    await changesRows.nth(0).click();
    for (let i = 1; i < n; i++) await changesRows.nth(i).click({ modifiers: ['ControlOrMeta'] });
    await expect(changes(page).locator('.git-file.sel'), '다중 선택이 되지 않았다').toHaveCount(n);

    const firstPath = await changesRows.nth(0).getAttribute('data-path');
    const lastPath = await changesRows.nth(n - 1).getAttribute('data-path');
    expect(lastPath).not.toBe(firstPath);

    await page.evaluate(() => {
      const a = (window as any).app;
      (window as any).__openFileCalls = [];
      const orig = a._gitOpenFile.bind(a);
      a._gitOpenFile = (p: string) => { (window as any).__openFileCalls.push(p); return orig(p); };
    });

    // 선택의 첫 항목(0번, 앵커)이 아니라 선택 안의 **마지막 행**에서 누른다 —
    // "첫 항목만 연다"는 잘못된 구현과 "누른 행을 연다"는 옳은 구현을 가른다.
    await changesRows.nth(n - 1).hover();
    const btn = changesRows.nth(n - 1).locator('.git-file-act[data-act="openFile"]');
    await expect(btn, 'Open File 인라인 버튼이 없다').toHaveCount(1, { timeout: 5000 });
    await btn.click();

    const calls = await page.evaluate(() => (window as any).__openFileCalls);
    expect(calls.length, `_gitOpenFile 호출이 1번이 아니다(선택 전체가 열렸을 수 있다): ${JSON.stringify(calls)}`)
      .toBe(1);
    expect(calls[0], '첫 항목이 열렸다 — 누른 행이 아니다').toBe(repo + '/' + lastPath);
    expect(calls[0]).not.toBe(repo + '/' + firstPath);
  });
});

test.describe('묶음 J — I2 경로 표시 분리 (FR-GIT-237)', () => {
  // 계산된 색과 배경의 대비(WCAG 상대휘도 공식). "밝다"로 재지 않는다 —
  // 라이트 테마에서는 강조가 더 어두운 쪽이라 밝기 비교는 스펙이 명시적으로
  // 금지한다(GIT_REVIEW4_SRS §3.6.2).
  async function contrastAgainstBg(loc: ReturnType<typeof rows>) {
    return loc.evaluate((el: HTMLElement) => {
      const parse = (c: string) => {
        const m = c.match(/rgba?\(([^)]+)\)/);
        if (!m) return [0, 0, 0];
        return m[1].split(',').slice(0, 3).map((x) => parseFloat(x));
      };
      const lum = ([r, g, b]: number[]) => {
        const f = (v: number) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
        const [rr, gg, bb] = [r, g, b].map(f);
        return 0.2126 * rr + 0.7152 * gg + 0.0722 * bb;
      };
      const bg = getComputedStyle(document.body).backgroundColor;
      const l1 = lum(parse(getComputedStyle(el).color));
      const l2 = lum(parse(bg));
      return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
    });
  }

  // THEMES 는 고전 스크립트의 const 라 window 프로퍼티가 아니다 — 문자열 평가로
  // 페이지의 전역 스코프에서 읽는다(e2e/git-ui-revision.spec.ts:541 의 선례와 같은
  // 함정). 테마는 설정으로 영속하므로(같은 선례:557) 앞선 테스트가 남긴 테마에
  // 기대면 전량 실행에서만 깨진다 — 실제로 GitHub Light(text===textBright) 가
  // 남아 있을 때 이 파일의 V135/V136 이 정확히 그렇게 깨졌다. 그래서 여기서부터는
  // **테스트가 테마를 스스로 정한다**(applyThemeName) — 어느 테마가 남아 있었든
  // 무관하다.
  async function applyThemeName(page: Page, name: string) {
    await page.evaluate(`applyThemeObj(THEMES[${JSON.stringify(name)}])`);
  }

  test('V135 (FR-GIT-237): 평평한 보기에서 디렉터리와 파일명이 다른 요소이고, 파일명의 font-weight 와 대비가 디렉터리보다 크다', async ({ page }) => {
    await waitForInit(page);
    await openGit(page, copyFx('basic', 'v135'));
    await waitFiles(page, 3);

    // text !== textBright 인 테마를 명시적으로 적용한다 — 45개 테마 중 12개는
    // 둘이 같아 색만으로는 대비를 볼 수 없다(조정자 확인, 예: Dracula·GitHub
    // Light). Tokyo Night 는 다르다(#a9b1d6 ≠ #c0caf5).
    await applyThemeName(page, 'Tokyo Night');

    const row = rows(page, 'changes').filter({ hasText: '디렉터리 한글/파일 이름.txt' });
    await expect(row, '중첩 경로 행을 찾지 못했다').toHaveCount(1, { timeout: 10000 });

    const dirLoc = row.locator('.git-file-path-dir');
    const nameLoc = row.locator('.git-file-path-name');
    await expect(dirLoc, '디렉터리 요소(.git-file-path-dir)가 없다').toHaveCount(1, { timeout: 5000 });
    await expect(nameLoc, '파일명 요소(.git-file-path-name)가 없다').toHaveCount(1, { timeout: 5000 });

    // FR-GIT-237: 행의 textContent 는 바뀌지 않는다 — 기존 단정
    // (git-changes.spec.ts:128·266)이 텍스트로 걸려 있다.
    const full = ((await row.locator('.git-file-path').textContent()) || '').trim();
    expect(full).toBe('디렉터리 한글/파일 이름.txt');

    // 구별을 **보장하는** 축은 font-weight 다 — 45개 테마 전부에서 참이어야
    // 하는 유일한 축이다(색은 12개 테마에서 갈리지 않는다). 색 대비는 보강 축이라
    // 아래에서 별도로 확인한다.
    const dirWeight = await dirLoc.evaluate((el) => parseInt(getComputedStyle(el).fontWeight, 10));
    const nameWeight = await nameLoc.evaluate((el) => parseInt(getComputedStyle(el).fontWeight, 10));
    expect(nameWeight, '파일명의 font-weight 가 디렉터리보다 크지 않다').toBeGreaterThan(dirWeight);

    const dirColor = await dirLoc.evaluate((el) => getComputedStyle(el).color);
    const nameColor = await nameLoc.evaluate((el) => getComputedStyle(el).color);
    expect(dirColor, '디렉터리·파일명 색이 같다').not.toBe(nameColor);

    const dirContrast = await contrastAgainstBg(dirLoc);
    const nameContrast = await contrastAgainstBg(nameLoc);
    expect(nameContrast, '파일명이 디렉터리보다 대비가 강하지 않다').toBeGreaterThan(dirContrast);
  });

  test('V136 (FR-GIT-237): 테마를 바꾸면 디렉터리·파일명 색이 따라 바뀌고 구별이 유지된다 (V119 와 같은 방법)', async ({ page }) => {
    await waitForInit(page);
    await openGit(page, copyFx('basic', 'v136'));
    await waitFiles(page, 3);

    const row = rows(page, 'changes').filter({ hasText: '디렉터리 한글/파일 이름.txt' });
    const dirLoc = row.locator('.git-file-path-dir');
    const nameLoc = row.locator('.git-file-path-name');
    await expect(dirLoc, '디렉터리 요소(.git-file-path-dir)가 없다').toHaveCount(1, { timeout: 5000 });
    await expect(nameLoc, '파일명 요소(.git-file-path-name)가 없다').toHaveCount(1, { timeout: 5000 });

    // 같은 값끼리 맞바꾸는 스왑은 text===textBright 인 테마(예: Dracula)에서
    // 아무것도 안 바꾼다(조정자 확인) — 그래서 스왑이 아니라 **테마 자체를
    // 갈아 낀다.** 둘 다 text!==textBright 인 서로 다른 테마 두 개를 순서대로
    // 적용한다.
    await applyThemeName(page, 'Tokyo Night');
    const dir1 = await dirLoc.evaluate((el) => getComputedStyle(el).color);
    const name1 = await nameLoc.evaluate((el) => getComputedStyle(el).color);
    expect(dir1, '테마 안에서도 디렉터리·파일명 색이 같다').not.toBe(name1);

    await applyThemeName(page, 'One Dark');
    await expect.poll(() => dirLoc.evaluate((el) => getComputedStyle(el).color), { timeout: 10000 })
      .not.toBe(dir1);
    await expect.poll(() => nameLoc.evaluate((el) => getComputedStyle(el).color), { timeout: 10000 })
      .not.toBe(name1);

    const dir2 = await dirLoc.evaluate((el) => getComputedStyle(el).color);
    const name2 = await nameLoc.evaluate((el) => getComputedStyle(el).color);
    expect(dir2, '테마를 바꾼 뒤에도 디렉터리·파일명 색이 같다').not.toBe(name2);

    // 테마는 설정으로 영속한다 — 뒤 테스트에 흘리지 않게 기본값으로 되돌린다
    // (e2e/git-ui-revision.spec.ts:557 과 같은 정리).
    await applyThemeName(page, 'Tokyo Night');
  });

  test('V137 (FR-GIT-237): 저장소 뿌리의 파일은 디렉터리 요소를 만들지 않는다', async ({ page }) => {
    await waitForInit(page);
    await openGit(page, copyFx('basic', 'v137'));
    await waitFiles(page, 3);

    const row = rows(page, 'changes').filter({ hasText: 'tracked.txt' });
    await expect(row, '뿌리 파일(tracked.txt) 행을 찾지 못했다').toHaveCount(1, { timeout: 10000 });

    const nameLoc = row.locator('.git-file-path-name');
    await expect(nameLoc, '파일명 요소(.git-file-path-name)가 없다').toHaveCount(1, { timeout: 5000 });
    await expect(nameLoc).toHaveText('tracked.txt');
    // 디렉터리가 없는 경로는 디렉터리 요소 자체를 만들지 않는다 — 빈 요소가
    // 자리를 먹으면 안 된다.
    await expect(row.locator('.git-file-path-dir'), '뿌리 파일에 디렉터리 요소가 생겼다').toHaveCount(0);
  });
});

test.describe('묶음 K — I3 새로고침 (FR-GIT-238)', () => {
  test('V138 (FR-GIT-238): 새로고침을 누르면 status · History · Branches · Console 이 전부 다시 요청된다', async ({ page }) => {
    await waitForInit(page);
    await openGit(page, copyFx('basic', 'v138'));
    await waitFiles(page, 3);

    // History·Branches·Console 뷰는 그 탭을 처음 열 때 지연 생성된다
    // (panel.js:659·680·700) — 한 번도 안 연 탭은 새로고침 대상이 아니다(보인 적
    // 없는 것은 낡을 수 없다, "보이지 않는 섹션을 위해 요청을 살 이유가 없다"는
    // FR-STAT-17 의 원칙과 같다). 셋 다 마운트시킨 뒤 Changes 로 돌아온다 — 그래야
    // "지금 보고 있는 탭과 무관하게 다시 받는다"까지 함께 검증된다.
    for (const v of ['history', 'branches', 'console']) {
      await page.click(`#area .pn-tab[data-git-view="${v}"]`);
      await page.waitForTimeout(300);
    }
    await page.click('#area .pn-tab[data-git-view="changes"]');
    await expect(page.locator('#area .pn-body .git-view.vis')).toHaveClass(/git-changes/);

    // 자리는 .git-head-spacer 뒤이며 .git-head-remote 밖이다(git-changes.spec.ts:70
    // 의 원격 버튼 카운트 3개 단정과 충돌하지 않아야 한다).
    const remoteBtnCountBefore = await changes(page).locator('.git-remote-btn').count();

    const seen = { status: 0, log: 0, refs: 0, records: 0 };
    page.on('request', (req) => {
      const u = req.url();
      if (u.includes('/api/git/status')) seen.status++;
      if (u.includes('/api/git/log')) seen.log++;
      if (u.includes('/api/git/refs')) seen.refs++;
      if (u.includes('/api/git/records')) seen.records++;
    });

    const btn = changes(page).locator('.git-head-refresh');
    await expect(btn, '새로고침 버튼(.git-head-refresh)이 .git-head 안에 없다').toHaveCount(1, { timeout: 5000 });
    // .git-head-remote 안에 들어가지 않았는지도 함께 확인한다 — 들어가면 기존
    // 단정(git-changes.spec.ts:70~73, .git-remote-btn count 3)이 깨진다.
    expect(await changes(page).locator('.git-remote-btn').count()).toBe(remoteBtnCountBefore);

    const before = { ...seen };
    await btn.click();

    await expect.poll(() => seen.status > before.status, { timeout: 10000 }).toBe(true);
    expect(seen.log, 'History(/api/git/log)가 다시 요청되지 않았다').toBeGreaterThan(before.log);
    expect(seen.refs, 'Branches(/api/git/refs)가 다시 요청되지 않았다').toBeGreaterThan(before.refs);
    expect(seen.records, 'Console(/api/git/records)이 다시 요청되지 않았다').toBeGreaterThan(before.records);
  });

  test('V139 (FR-GIT-238): 받는 동안 두 번 눌러도 요청이 두 벌 나가지 않고, 실패하면 사유가 보인다', async ({ page }) => {
    await waitForInit(page);
    await openGit(page, copyFx('basic', 'v139'));
    await waitFiles(page, 3);

    // status 는 1초 폴링도 쓰는 엔드포인트라(FR-GIT-18~24) 클릭이 두 벌 나갔는지
    // 가릴 계기로 못 쓴다 — 새로고침 경로에서만 나가는 /api/git/log 로 센다.
    // History 를 먼저 마운트해야 새로고침이 그것을 대상에 넣는다(V138 과 같은 이유).
    await page.click('#area .pn-tab[data-git-view="history"]');
    await page.waitForTimeout(300);
    await page.click('#area .pn-tab[data-git-view="changes"]');
    await expect(page.locator('#area .pn-body .git-view.vis')).toHaveClass(/git-changes/);

    const btn = changes(page).locator('.git-head-refresh');
    await expect(btn, '새로고침 버튼(.git-head-refresh)이 없다').toHaveCount(1, { timeout: 5000 });

    let logHits = 0;
    await page.route('**/api/git/log*', async (route) => {
      logHits++;
      await new Promise((r) => setTimeout(r, 1500));
      await route.continue();
    });

    await btn.click();
    await btn.click({ force: true }); // 받는 동안 다시 누른다 — 막혀 있어야 한다
    await page.waitForTimeout(2200);
    expect(logHits, '진행 중에 다시 눌러 log 요청이 두 벌 나갔다').toBe(1);
    await page.unroute('**/api/git/log*');

    // 실패는 조용히 지나가지 않는다 — 이미 있는 .git-stale-note 를 재사용한다
    // (panel.js:249·316, GIT_STALE_NOTE).
    await page.route('**/api/git/status*', (route) => route.abort());
    await btn.click();
    await expect(changes(page).locator('.git-stale-note.vis'), '새로고침 실패 사유가 보이지 않는다')
      .toBeVisible({ timeout: 10000 });
    await page.unroute('**/api/git/status*');
  });
});

test.describe('묶음 L — 핀 행 배지 자리 (FR-GIT-239 축소)', () => {
  // FR-GIT-239 는 follow 행과 핀 행의 오른쪽 끝을 맞추는 것이었다. follow 행이
  // 사라졌으므로(FR-FLW-1) 남는 계약은 **핀 행끼리** 어긋나지 않는 것이다 —
  // 자리 폭이 여전히 한 선언에서 나오는지를 본다.
  async function twoPinnedWithBadge(page: any, request: any, tag: string) {
    const a = await pin(request, makeRepoWithChange('dm-repo-' + tag + 'a-'));
    const b = await pin(request, makeRepoWithChange('dm-repo-' + tag + 'b-'));
    for (const r of [a, b]) {
      const st = await request.get('/api/git/status?repo=' + encodeURIComponent(r));
      expect(st.ok(), `status 실패: ${await st.text()}`).toBeTruthy();
    }
    await expect(pinned(page, a).locator('.git-badge')).toHaveText('1', { timeout: 15000 });
    await expect(pinned(page, b).locator('.git-badge')).toHaveText('1', { timeout: 15000 });
    const rightX = (root: string) =>
      pinned(page, root).locator('.git-badge').evaluate((el: Element) => el.getBoundingClientRect().right);
    return [await rightX(a), await rightX(b)];
  }

  test('V140 (FR-GIT-239): 핀 행들의 변경 개수 배지의 오른쪽 끝 x 가 같다', async ({ page, request }) => {
    await waitForInit(page);
    const [xa, xb] = await twoPinnedWithBadge(page, request, 'i140');
    expect(Math.abs(xa - xb), `배지 x = ${xa} / ${xb}`).toBeLessThan(1);
  });

  test('V141 (FR-GIT-239): 모바일 폭에서도 배지의 오른쪽 끝 x 가 같다 — 자리 폭이 한 곳에서 나온다', async ({
    page,
    request,
  }) => {
    await waitForInit(page, 'mobile');
    await expect(page.locator('body')).toHaveClass(/mobile/);
    const [xa, xb] = await twoPinnedWithBadge(page, request, 'i141');
    expect(Math.abs(xa - xb), `모바일: 배지 x = ${xa} / ${xb}`).toBeLessThan(1);
  });

  // V142 (follow 행에 × 가 생기지 않았다) 는 대상이 사라져 철회했다 — 행이 없다.
});

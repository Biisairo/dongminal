import { execFileSync } from 'child_process';
import { realpathSync, rmSync } from 'fs';
import { join } from 'path';

import { Page } from '@playwright/test';

import { test, expect } from './fixtures';

// GIT_UI_REVISION_SRS §4 — 검증 V70~V79.
//
// MVP 이후 사용자 검토로 확정한 UI 개정이다: Git 창을 **닫힌 창**으로 좁히고
// (FR-GIT-179~186), 파일 선택을 체크박스에서 행 클릭 + 보조키로 옮기고
// (FR-GIT-187~191), GIT 섹션의 이모지 표식을 없앤다 (FR-GIT-192~194).

const FIXTURES = '/tmp/dm-git-fx-uirev-' + process.pid;

test.beforeAll(() => {
  execFileSync('bash', ['scripts/git_fixture.sh', FIXTURES], { stdio: 'ignore' });
});
test.afterAll(() => {
  execFileSync('bash', ['scripts/git_fixture.sh', '--clean', FIXTURES], { stdio: 'ignore' });
});

const fx = (name: string) => realpathSync(join(FIXTURES, name));

function copyFx(name: string, tag: string) {
  const dst = join(FIXTURES, 'copy-' + tag);
  rmSync(dst, { recursive: true, force: true });
  execFileSync('cp', ['-R', join(FIXTURES, name), dst]);
  return realpathSync(dst);
}

async function waitForInit(page: Page) {
  await page.context().addInitScript(() => {
    sessionStorage.setItem('displayMode', 'desktop');
  });
  await page.goto('/');
  await page.waitForSelector('#area .pn.focused .xterm-helper-textarea', { timeout: 15000 });
}

async function openGit(page: Page, repo: string) {
  await page.evaluate((r) => (window as any).app.openGitWindow(r), repo);
  await expect(page.locator('#area .pn-tab[data-git-view]')).toHaveCount(6);
}

async function openChanges(page: Page, repo: string) {
  await openGit(page, repo);
  await page.evaluate(() => (window as any).app.gitPanel.openView('changes'));
  await expect(page.locator('#area .pn-body .git-view.vis')).toHaveClass(/git-changes/);
}

const files = (page: Page) => page.locator('#area .pn-body .git-file');
const gitRepos = (page: Page) => page.locator('#git-repos .git-repo');

// 파일 목록이 채워질 때까지 기다린다 — status 조회는 비동기다.
async function waitFiles(page: Page, min = 1) {
  await expect.poll(() => files(page).count(), { timeout: 20000 }).toBeGreaterThanOrEqual(min);
}

test.describe('UI 개정 — Git 창의 경계 (FR-GIT-179~186)', () => {
  test('V70 (FR-GIT-179·180): Git 창에는 분할·새 탭 진입점이 없고 단축키도 늘리지 않는다', async ({ page }) => {
    await waitForInit(page);
    await openGit(page, fx('basic'));

    // 상단 바의 분할 버튼과 탭 행의 `+` 는 **자리가 없다** — 눌리지만 아무 일도
    // 하지 않는 버튼은 고장으로 읽힌다.
    await expect(page.locator('#split-h:visible')).toHaveCount(0);
    await expect(page.locator('#split-v:visible')).toHaveCount(0);
    await expect(page.locator('#area .pn-tab-add')).toHaveCount(0);

    // 단축키 경로도 막힌다.
    const before = await page.evaluate(() => ({
      panes: document.querySelectorAll('#area .pn').length,
      tabs: document.querySelectorAll('#area .pn-tab').length,
    }));
    await page.evaluate(async () => {
      const a = (window as any).app;
      await a.executeAction('splitH');
      await a.executeAction('splitV');
      await a.executeAction('newTab');
    });
    await page.waitForTimeout(1500);
    const after = await page.evaluate(() => ({
      panes: document.querySelectorAll('#area .pn').length,
      tabs: document.querySelectorAll('#area .pn-tab').length,
    }));
    expect(after).toEqual(before);
    expect(after.tabs).toBe(6);
  });

  test('V71 (FR-GIT-181): Git 창은 드롭 대상이 되지 않는다', async ({ page }) => {
    await waitForInit(page);
    await openGit(page, fx('basic'));

    // 고정 탭은 드래그를 시작할 수 없다 (FR-GIT-28).
    const draggables = await page.evaluate(() =>
      [...document.querySelectorAll('#area .pn-tab[data-git-view]')].map(t => (t as HTMLElement).draggable));
    expect(draggables).toEqual([false, false, false, false, false, false]);

    // 드롭 경로를 직접 불러도 Git 창의 구조는 그대로다 — 드래그 시작을 막는 것과
    // 별개로 경로 자체가 막혀 있어야 한다.
    const after = await page.evaluate(() => {
      const a = (window as any).app;
      const git = a.ws.windows.find((w: any) => w.type === 'git');
      const pane = git.layout;
      const tabId = pane.tabs[0].id;
      a._moveTabToPane(pane.id, tabId, pane.id, null, false);
      a._splitPaneWithTab(pane.id, tabId, pane.id, 'right');
      return {
        layoutType: git.layout.type,
        tabTypes: (git.layout.tabs || []).map((t: any) => t.type),
        panes: document.querySelectorAll('#area .pn').length,
      };
    });
    expect(after.layoutType).toBe('pane');
    expect(after.tabTypes).toEqual(['git', 'git', 'git', 'git', 'git', 'git']);
    expect(after.panes).toBe(1);
  });

  test('V72 (FR-GIT-182): Git 창은 WINDOWS 목록에도 창 전환 순환에도 없다', async ({ page }) => {
    await waitForInit(page);
    await page.evaluate(() => (window as any).app.addWindow());
    await page.waitForTimeout(1500);
    await openGit(page, fx('basic'));

    // 목록에는 일반 창만 있다.
    const listed = await page.evaluate(() =>
      [...document.querySelectorAll('#windows .si')].map((e) => (e as HTMLElement).dataset.windowType));
    expect(listed).not.toContain('git');
    expect(listed.length).toBe(2);

    // 일반 창으로 나간 뒤 순환을 돌아도 Git 창에 닿지 않는다.
    await page.evaluate(() => {
      const a = (window as any).app;
      a.switchWindow(a.ws.windows.find((w: any) => w.type !== 'git').id);
    });
    await page.waitForTimeout(500);
    const seen: string[] = [];
    for (let i = 0; i < 3; i++) {
      await page.evaluate(() => (window as any).app.executeAction('windowNext'));
      await page.waitForTimeout(400);
      seen.push(await page.evaluate(() => {
        const a = (window as any).app;
        return (a.ws.windows.find((w: any) => w.id === a.ws.activeWindow) || {}).type || 'terminal';
      }));
    }
    expect(seen).not.toContain('git');
  });

  test('V73 (FR-GIT-183·184): Git 창은 자기 상단 바로 닫고, 열려 있어도 다른 창으로 나갈 수 있다', async ({ page }) => {
    await waitForInit(page);
    await openGit(page, fx('basic'));

    // 나가는 길: WINDOWS 목록의 일반 창 클릭.
    await page.click('#windows .si');
    await expect.poll(() => page.evaluate(() => {
      const a = (window as any).app;
      return (a.ws.windows.find((w: any) => w.id === a.ws.activeWindow) || {}).type || 'terminal';
    })).toBe('terminal');

    // 다시 들어가서 상단 바의 닫기로 닫는다.
    await openGit(page, fx('basic'));
    await expect(page.locator('#git-close:visible')).toHaveCount(1);
    await page.click('#git-close');
    await expect.poll(() => page.evaluate(() =>
      (window as any).app.ws.windows.filter((w: any) => w.type === 'git').length)).toBe(0);

    // 리포 항목을 다시 누르면 새로 만들어진다 (FR-GIT-26 유지).
    await openGit(page, fx('basic'));
    expect(await page.evaluate(() =>
      (window as any).app.ws.windows.filter((w: any) => w.type === 'git').length)).toBe(1);
  });

  test('V74 (FR-GIT-41·185): Open File 은 Git 창이 아닌 창에 열고 그 창을 활성화한다', async ({ page }) => {
    await waitForInit(page);
    await openChanges(page, copyFx('basic', 'v74'));
    await waitFiles(page);

    await files(page).first().click({ button: 'right' });
    await page.locator('.git-menu .git-menu-item', { hasText: 'Open File' }).click();

    // 편집기 탭이 생기고, 그 탭이 있는 창이 활성이며, 그 창은 Git 창이 아니다.
    await expect.poll(() => page.evaluate(() => {
      const a = (window as any).app;
      const w = a.ws.windows.find((x: any) => x.id === a.ws.activeWindow);
      if (!w || w.type === 'git') return 'git-or-none';
      const has = (n: any): boolean =>
        n.type === 'pane' ? (n.tabs || []).some((t: any) => t.type === 'editor')
                          : (n.children || []).some(has);
      return has(w.layout) ? 'ok' : 'no-editor';
    }), { timeout: 20000 }).toBe('ok');

    // Git 창은 고정 탭 6개 그대로다.
    expect(await page.evaluate(() => {
      const g = (window as any).app.ws.windows.find((w: any) => w.type === 'git');
      return (g.layout.tabs || []).length;
    })).toBe(6);
  });

  test('V75 (FR-GIT-186): 개정 이전 워크스페이스의 Git 창 안 탭은 일반 창으로 옮겨진다', async ({ page }) => {
    await waitForInit(page);
    const r = await page.evaluate(() => {
      // 개정 이전 모양: Git 창이 분할되어 있고 터미널·편집기 탭이 섞여 있다.
      const windows: any[] = [
        { id: 'w1', name: 'Window', layout: { type: 'pane', id: 'p1', tabs: [{ id: 't1', type: 'terminal', toolId: 'x' }], activeTab: 't1' } },
        {
          id: 'w2', name: 'Git', type: 'git',
          layout: {
            type: 'split', direction: 'horizontal', children: [
              { type: 'pane', id: 'p2', tabs: [
                { id: 'g1', type: 'git', gitView: 'changes' },
                { id: 'g2', type: 'git', gitView: 'diff' },
                { id: 'e1', type: 'editor', filePath: '/tmp/a.txt', name: 'a.txt' },
              ], activeTab: 'e1' },
              { type: 'pane', id: 'p3', tabs: [{ id: 't2', type: 'terminal', toolId: 'y' }], activeTab: 't2' },
            ],
          },
        },
      ];
      const moved = (window as any).migrateGitWindows(windows, () => {
        const w = { id: 'w3', name: 'Window', layout: { type: 'pane', id: 'p9', tabs: [], activeTab: null } };
        windows.push(w);
        return w;
      });
      const collect = (n: any): any[] =>
        n.type === 'pane' ? (n.tabs || []) : (n.children || []).flatMap(collect);
      return {
        moved,
        gitLayoutType: windows[1].layout.type,
        gitTabTypes: collect(windows[1].layout).map((t: any) => t.type),
        gitActiveTab: (windows[1].layout as any).activeTab,
        plainTabIds: collect(windows[0].layout).map((t: any) => t.id),
        windowCount: windows.length,
      };
    });
    // Git 창은 단일 칸 + 고정 탭만 남는다.
    expect(r.gitLayoutType).toBe('pane');
    expect(r.gitTabTypes).toEqual(['git', 'git']);
    // 활성 탭이 옮겨졌으므로 첫 고정 탭으로 되돌아온다.
    expect(r.gitActiveTab).toBe('g1');
    // 옮긴 탭은 사라지지 않는다 — 일반 창이 받는다.
    expect(r.moved).toBe(2);
    expect(r.plainTabIds).toEqual(['t1', 'e1', 't2']);
    expect(r.windowCount).toBe(2);
  });
});

test.describe('UI 개정 — 파일 선택 (FR-GIT-187~191)', () => {
  test('V76 (FR-GIT-187·188): 체크박스가 없고 클릭·Cmd·Shift 가 선택을 만든다', async ({ page }) => {
    await waitForInit(page);
    await openChanges(page, fx('basic'));
    await waitFiles(page, 5);

    // 체크박스는 사라졌다.
    await expect(page.locator('#area .pn-body .git-file-check')).toHaveCount(0);
    await expect(page.locator('#area .pn-body .git-file input[type=checkbox]')).toHaveCount(0);

    const sel = () => page.evaluate(() =>
      [...document.querySelectorAll('#area .pn-body .git-file.sel')].map(e => (e as HTMLElement).dataset.path));
    const cur = () => page.evaluate(() =>
      [...document.querySelectorAll('#area .pn-body .git-file.cur')].map(e => (e as HTMLElement).dataset.path));
    const preview = () => page.evaluate(() => ((window as any).app.gitPanel.previewFile || {}).path || null);

    // 클릭: 선택을 그 행 하나로 바꾸고 미리보기를 채운다.
    await files(page).nth(0).click();
    const p0 = await files(page).nth(0).getAttribute('data-path');
    await expect.poll(sel).toEqual([p0]);
    expect(await cur()).toEqual([p0]);
    await expect.poll(preview).toBe(p0);

    // Cmd/Ctrl + 클릭: 토글해 더한다. 미리보기는 그 행이다.
    await files(page).nth(2).click({ modifiers: ['ControlOrMeta'] });
    const p2 = await files(page).nth(2).getAttribute('data-path');
    expect((await sel()).sort()).toEqual([p0, p2].sort());
    expect(await cur()).toEqual([p2]);
    await expect.poll(preview).toBe(p2);

    // 같은 행을 다시 Cmd 클릭하면 빠진다.
    await files(page).nth(2).click({ modifiers: ['ControlOrMeta'] });
    await expect.poll(sel).toEqual([p0]);

    // Shift + 클릭: 앵커부터 그 행까지를 **범위로 바꾼다**. 앵커는 방금 누른
    // 행(2번)이므로 2~3 두 개다 — 더하지 않고 갈아치우므로 0번은 빠진다.
    await files(page).nth(3).click({ modifiers: ['Shift'] });
    expect((await sel()).length).toBe(2);
    expect(await cur()).toEqual([await files(page).nth(3).getAttribute('data-path')]);

    // 평클릭으로 앵커를 옮기면 범위의 기준도 함께 옮겨진다.
    await files(page).nth(1).click();
    await files(page).nth(4).click({ modifiers: ['Shift'] });
    expect((await sel()).length).toBe(4);
  });

  test('V77 (FR-GIT-189): 선택 표식과 포커스 표식이 서로 다르다', async ({ page }) => {
    await waitForInit(page);
    await openChanges(page, fx('basic'));
    await waitFiles(page, 3);

    await files(page).nth(0).click();
    await files(page).nth(1).click({ modifiers: ['ControlOrMeta'] });

    // 두 행 모두 선택이지만 포커스는 하나다 — 둘을 같게 그리면 미리보기가 어느
    // 행을 보이는지 알 수 없다.
    const marks = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('#area .pn-body .git-file')] as HTMLElement[];
      const selOnly = rows.find(r => r.classList.contains('sel') && !r.classList.contains('cur'))!;
      const focused = rows.find(r => r.classList.contains('cur'))!;
      const cs = (e: HTMLElement) => {
        const s = getComputedStyle(e);
        return { bg: s.backgroundColor, shadow: s.boxShadow, border: s.borderLeftWidth + ' ' + s.borderLeftColor };
      };
      return { selOnly: cs(selOnly), focused: cs(focused), plain: cs(rows.find(r => !r.classList.contains('sel'))!) };
    });
    // 선택은 배경으로 구분되고, 포커스는 배경 말고 다른 것으로 한 번 더 구분된다.
    expect(marks.selOnly.bg).not.toBe(marks.plain.bg);
    expect(marks.focused.shadow + '|' + marks.focused.border)
      .not.toBe(marks.selOnly.shadow + '|' + marks.selOnly.border);
  });

  test('V78 (FR-GIT-190): 일부만 스테이지된 파일은 상태 문자 색으로 구분된다', async ({ page }) => {
    await waitForInit(page);
    await openChanges(page, fx('basic'));
    await waitFiles(page, 5);

    // basic 픽스처의 `디렉터리 한글/파일 이름.txt` 는 staged + unstaged 다.
    const colors = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('#area .pn-body .git-file')] as HTMLElement[];
      const partial = rows.find(r => r.classList.contains('partial'));
      const plain = rows.find(r => !r.classList.contains('partial'));
      const st = (r?: HTMLElement) => r ? getComputedStyle(r.querySelector('.git-file-st')!).color : null;
      return { partial: st(partial), plain: st(plain), hasPartial: !!partial };
    });
    expect(colors.hasPartial).toBe(true);
    expect(colors.partial).not.toBe(colors.plain);
  });
});

// FR-GIT-195~198 의 하한 (FR-GIT-226 으로 개정). 기준은 VSCode 가 아니라 이 앱의
// WINDOWS 목록 행(`.si` 30px)이다. 여기 한 곳에만 둔다 — 흩어지면 한쪽만 고쳐진다.
const MIN_HIT = 30;      // 아이콘 버튼의 히트 영역
const MIN_LABELED = 30;  // 라벨을 가진 버튼의 높이
const MIN_ROW = 30;      // 목록 행
const MIN_FONT = 11;     // 컨트롤 라벨
const MIN_LIST_FONT = 12;

// Git 표면의 컨트롤 치수를 한 번에 잰다. 보이지 않는 것은 재지 않는다.
async function measure(page: Page, scope: string) {
  return page.evaluate((sc) => {
    const root = document.querySelector(sc);
    if (!root) return null;
    const vis = (e: Element) => {
      const r = e.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    const grab = (sel: string) => [...root.querySelectorAll(sel)].filter(vis).map((e) => {
      const r = e.getBoundingClientRect();
      const s = getComputedStyle(e);
      return {
        cls: String((e as HTMLElement).className).slice(0, 48),
        text: (e.textContent || '').trim().slice(0, 16),
        w: Math.round(r.width), h: Math.round(r.height),
        font: parseFloat(s.fontSize),
      };
    });
    return { buttons: grab('button'), rows: grab('.git-file, .git-br-row, .git-stash-row') };
  }, scope);
}

test.describe('UI 개정 — 컨트롤 치수 (FR-GIT-195~199)', () => {
  test('V80 (FR-GIT-195~198): Git 표면의 버튼과 목록 행이 VSCode 하한을 넘는다', async ({ page }) => {
    await waitForInit(page);
    await openChanges(page, fx('basic'));
    await waitFiles(page, 3);
    // 행 인라인 동작은 hover 로만 보인다 — 재려면 하나를 띄운다.
    await files(page).first().hover();

    const m = (await measure(page, '#area .pn-body'))!;
    expect(m.buttons.length).toBeGreaterThan(5);

    const tooSmall = m.buttons.filter((b) => b.w < MIN_HIT || b.h < MIN_HIT);
    expect(tooSmall, '히트 영역 ' + MIN_HIT + 'px 미만: ' + JSON.stringify(tooSmall)).toEqual([]);

    const labeled = m.buttons.filter((b) => b.text.length > 1);
    const shortLabeled = labeled.filter((b) => b.h < MIN_LABELED);
    expect(shortLabeled, '라벨 버튼 높이 ' + MIN_LABELED + 'px 미만: ' + JSON.stringify(shortLabeled)).toEqual([]);

    const smallFont = m.buttons.filter((b) => b.font < MIN_FONT);
    expect(smallFont, '글꼴 ' + MIN_FONT + 'px 미만: ' + JSON.stringify(smallFont)).toEqual([]);

    const shortRows = m.rows.filter((r) => r.h < MIN_ROW);
    expect(shortRows, '목록 행 높이 ' + MIN_ROW + 'px 미만: ' + JSON.stringify(shortRows)).toEqual([]);
    const smallRowFont = m.rows.filter((r) => r.font < MIN_LIST_FONT);
    expect(smallRowFont, '목록 글꼴 ' + MIN_LIST_FONT + 'px 미만: ' + JSON.stringify(smallRowFont)).toEqual([]);

    // GIT 섹션의 리포 행도 목록이다.
    const side = (await measure(page, '#sidebar'))!;
    const repos = await page.evaluate(() =>
      [...document.querySelectorAll('#git-repos .git-repo')].map(e => Math.round(e.getBoundingClientRect().height)));
    expect(Math.min(...repos)).toBeGreaterThanOrEqual(MIN_ROW);
    expect(side.buttons.filter(b => b.h < MIN_HIT)).toEqual([]);
  });

  test('V103 (FR-GIT-226): 하한이 WINDOWS 목록 행(.si)과 같은 값이다', async ({ page }) => {
    await waitForInit(page);
    await openChanges(page, fx('basic'));
    await waitFiles(page, 3);

    // 기준은 VSCode 가 아니라 이 앱 자신의 목록 행이다 — 숫자를 두 곳에 두지
    // 않았다는 증거로, 실제 `.si` 높이와 맞춰 본다.
    const si = await page.evaluate(() => {
      const e = document.querySelector('#windows .si') as HTMLElement | null;
      return e ? Math.round(e.getBoundingClientRect().height) : -1;
    });
    expect(si, 'WINDOWS 행이 없다').toBeGreaterThan(0);
    expect(MIN_ROW).toBe(si);
    expect(MIN_HIT).toBe(si);
    expect(MIN_LABELED).toBe(si);

    // 토큰이 실제로 그 값이다.
    const tok = await page.evaluate(() => {
      const cs = getComputedStyle(document.documentElement);
      return ['--git-hit', '--git-btn-h', '--git-row-min']
        .map((n) => parseFloat(cs.getPropertyValue(n)));
    });
    expect(tok).toEqual([si, si, si]);

    // History 의 가상 스크롤 행 높이도 같다 — CSS 와 어긋나면 목록이 틀어진다.
    await page.locator('#area .pn-tab[data-git-view="history"]').click();
    await expect(page.locator('#area .pn-body .git-hist-row').first())
      .toBeVisible({ timeout: 20000 });
    const rowH = await page.locator('#area .pn-body .git-hist-list')
      .evaluate((el) => parseFloat(getComputedStyle(el).getPropertyValue('--git-row-h')));
    expect(rowH).toBe(si);
  });

  test('V81 (FR-GIT-199): 모바일 폭에서도 하한이 지켜진다', async ({ page }) => {
    await waitForInit(page);
    await openChanges(page, fx('basic'));
    await waitFiles(page, 3);
    await page.setViewportSize({ width: 420, height: 800 });
    await page.waitForTimeout(1200);

    const m = (await measure(page, '#area .pn-body'))!;
    const tooSmall = m.buttons.filter((b) => b.w < MIN_HIT || b.h < MIN_HIT);
    expect(tooSmall, '모바일 히트 영역 미달: ' + JSON.stringify(tooSmall)).toEqual([]);
    const shortRows = m.rows.filter((r) => r.h < MIN_ROW);
    expect(shortRows, '모바일 행 높이 미달: ' + JSON.stringify(shortRows)).toEqual([]);
  });
});

test.describe('UI 개정 — 버튼 라벨 (FR-GIT-200~202)', () => {
  test('V82 (FR-GIT-200·201): Git 표면의 버튼 라벨에 한글이 없다', async ({ page }) => {
    await waitForInit(page);
    await openChanges(page, fx('basic'));
    await waitFiles(page, 3);
    await files(page).first().hover();     // 행 인라인 동작을 띄운다
    await files(page).first().click();     // 선택 동작 줄을 띄운다

    const hangul = /[가-힣]/;
    const labels = await page.evaluate(() =>
      [...document.querySelectorAll('#area .pn-body button')]
        .filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; })
        .map((e) => (e.textContent || '').trim()));
    expect(labels.length).toBeGreaterThan(5);
    expect(labels.filter((t) => hangul.test(t)), '한글 버튼 라벨이 남아 있다').toEqual([]);

    // dirty checkout 3선택도 버튼이다 (FR-GIT-201). 실제 경로로 띄운다 —
    // 라벨 목록을 테스트가 복제하면 소스가 바뀌어도 초록으로 남는다.
    await page.evaluate(() => {
      const w = window as any;
      w.GitBranches.checkout(w.app.gitPanel, 'main', {});
    });
    const choiceBox = page.locator('#git-choice .gch-box');
    await expect(choiceBox).toBeVisible({ timeout: 15000 });
    const opts = await choiceBox.locator('.gch-opt').allTextContents();
    expect(opts.length).toBe(3);
    expect(opts.filter((t) => hangul.test(t)), '한글 선택지 버튼이 남아 있다').toEqual([]);
    await page.keyboard.press('Escape');   // 기본은 취소다 (O14) — 아무것도 하지 않는다
  });
});

test.describe('UI 개정 — 폼 컨트롤의 테마 (FR-GIT-203~206)', () => {
  test('V83 (FR-GIT-203~206): 체크박스가 테마 토큰으로 그려지고 테마를 따라간다', async ({ page }) => {
    await waitForInit(page);
    await openGit(page, fx('basic'));
    // 다이얼로그의 체크박스를 쓴다 — Changes 의 amend 는 1초 폴링이 다시 칠해
    // 상태를 되돌리므로 렌더 결과를 겨누기 어렵다.
    await page.evaluate(() => {
      const w = window as any;
      w.GitBranches.create(w.app.gitPanel, {});
    });
    const box = page.locator('#git-br-create .gbc-box');
    await expect(box).toBeVisible({ timeout: 15000 });
    const cb = box.locator('.gbc-checkout');

    const read = () => cb.evaluate((el) => {
      const s = getComputedStyle(el);
      const root = getComputedStyle(document.documentElement);
      const r = el.getBoundingClientRect();
      return {
        appearance: s.appearance || (s as any).webkitAppearance,
        w: Math.round(r.width), h: Math.round(r.height),
        bg: s.backgroundColor, border: s.borderTopColor,
        accent: root.getPropertyValue('--accent').trim(),
      };
    });

    // 브라우저 기본 위젯을 쓰지 않는다 (FR-GIT-203) — 치수는 FR-GIT-206.
    const off = await read();
    expect(off.appearance).toBe('none');
    expect(off.w).toBeGreaterThanOrEqual(14);
    expect(off.h).toBeGreaterThanOrEqual(14);

    const hex = (rgb: string) => {
      const m = rgb.match(/\d+/g)!;
      return '#' + m.slice(0, 3).map((n) => (+n).toString(16).padStart(2, '0')).join('');
    };

    // 켜면 accent 로 채워진다 — 꺼짐과 다르다 (FR-GIT-204).
    await cb.check();
    await expect(cb).toBeChecked();
    await expect.poll(async () => hex((await read()).bg), { timeout: 5000 })
      .toBe(off.accent.toLowerCase());

    // 테마를 바꾸면 따라 바뀐다.
    // THEMES 는 고전 스크립트의 const 라 window 프로퍼티가 아니다 — 문자열 평가로
    // 페이지의 전역 스코프에서 읽는다 (constants.js 의 const 와 같은 함정).
    //
    // 테마 이름을 박아 두지 않는다: 테마는 설정으로 영속하므로 앞선 실행이 남긴
    // 값과 같은 것을 고르면 "바뀌었는지" 를 볼 수 없다. **지금과 다른 accent** 를
    // 가진 것을 그 자리에서 고른다.
    const other = await page.evaluate<string>(
      "(function(){" +
      "var cur=getComputedStyle(document.documentElement).getPropertyValue('--accent').trim().toLowerCase();" +
      "var n=Object.keys(THEMES).find(function(k){return THEMES[k].ui.accent.toLowerCase()!==cur});" +
      "applyThemeObj(THEMES[n]);" +
      "return getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()})()");
    expect(other.toLowerCase()).not.toBe(off.accent.toLowerCase());
    await expect.poll(async () => hex((await read()).bg), { timeout: 5000 }).toBe(other.toLowerCase());

    // 테마는 설정으로 영속한다 — 뒤 테스트에 흘리지 않게 되돌린다.
    await page.evaluate("applyThemeObj(THEMES['Tokyo Night'])");
  });
});

test.describe('UI 개정 — 라디오 (FR-GIT-203~206)', () => {
  test('V84 (FR-GIT-206): 라디오 상자가 정사각이다 — 타원이 되지 않는다', async ({ page }) => {
    await waitForInit(page);
    await openChanges(page, fx('with-remote'));
    // Pull 의 `▾` 옵션 다이얼로그가 라디오를 쓴다 (constants.js 의 pull 옵션).
    await page.locator('#area .pn-body .git-remote-more[data-remote="pull"]').click();
    const radios = page.locator('.git-dialog input[type="radio"]');
    await expect(radios.first()).toBeVisible({ timeout: 15000 });

    const boxes = await radios.evaluateAll((els) => els.map((e) => {
      const r = e.getBoundingClientRect();
      const s = getComputedStyle(e);
      return { w: Math.round(r.width), h: Math.round(r.height),
               appearance: s.appearance || (s as any).webkitAppearance,
               radius: s.borderTopLeftRadius };
    }));
    expect(boxes.length).toBeGreaterThan(1);
    for (const b of boxes) {
      expect(b.appearance).toBe('none');
      // 한 변만 늘어나면 타원이 된다 — 폭과 높이가 같아야 한다.
      expect(b.h, '라디오가 정사각이 아니다: ' + JSON.stringify(b)).toBe(b.w);
      expect(b.w).toBeGreaterThanOrEqual(14);
      expect(b.radius).toBe('50%');
    }
  });
});

test.describe('UI 개정 — 커밋 영역의 정렬 (FR-GIT-213)', () => {
  test('V90 (FR-GIT-213): 입력창이 폭을 다 쓰고 amend·Commit 이 그 아래 한 줄에 선다', async ({ page }) => {
    await waitForInit(page);
    await openChanges(page, fx('basic'));
    const area = page.locator('#area .pn-body .git-commit');
    await expect(area).toBeVisible({ timeout: 15000 });

    const read = () => page.evaluate(() => {
      const q = (s: string) => document.querySelector('#area .pn-body ' + s) as HTMLElement;
      const box = (s: string) => { const e = q(s); const r = e.getBoundingClientRect();
        return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
                 cy: Math.round(r.y + r.height / 2), bottom: Math.round(r.bottom) }; };
      return {
        main: box('.git-commit-main'),
        msg: box('.git-commit-msg'),
        amend: box('.git-commit-amend'),
        go: box('.git-commit-go'),
      };
    });

    const a = await read();
    // 입력창이 커밋 영역의 폭을 (거의) 다 쓴다 — 오른쪽에 세로 칸이 없다.
    expect(a.msg.w).toBeGreaterThan(a.main.w - 4);
    // amend·Commit 은 입력창 **아래**에 있다.
    expect(a.amend.y).toBeGreaterThanOrEqual(a.msg.bottom - 1);
    expect(a.go.y).toBeGreaterThanOrEqual(a.msg.bottom - 1);
    // 그리고 서로 같은 가로줄이다 (세로 중심이 어긋나지 않는다).
    expect(Math.abs(a.amend.cy - a.go.cy)).toBeLessThanOrEqual(1);
    // 둘은 왼쪽에 **붙어** 선다 — 양끝으로 밀면 한 벌인 것이 상관없어 보인다.
    expect(a.amend.x).toBeLessThan(a.go.x);
    const gap = a.go.x - (a.amend.x + a.amend.w);
    expect(gap, '두 컨트롤이 떨어져 있다: ' + gap + 'px').toBeLessThanOrEqual(16);
    expect(a.go.x).toBeLessThan(a.main.x + a.main.w / 2);

    // 입력창이 자라도 그 줄의 정렬은 그대로다 (FR-GIT-74 로 높이가 변한다).
    await page.locator('#area .pn-body .git-commit-msg').fill('a\nb\nc\nd\ne\nf');
    await page.waitForTimeout(600);
    const b = await read();
    expect(b.msg.h).toBeGreaterThan(a.msg.h);
    expect(Math.abs(b.amend.cy - b.go.cy)).toBeLessThanOrEqual(1);
    expect(b.msg.w).toBeGreaterThan(b.main.w - 4);
  });
});

test.describe('UI 개정 — 목록의 구조 (FR-GIT-211~212)', () => {
  test('V88 (FR-GIT-211): 트리 보기의 행이 깊이만큼 세로선을 갖는다', async ({ page }) => {
    await waitForInit(page);
    await openChanges(page, fx('basic'));
    await waitFiles(page, 3);
    await page.locator('#area .pn-body .git-files-mode[data-mode="tree"]').click();
    await page.waitForTimeout(600);

    const rows = () => page.evaluate(() =>
      [...document.querySelectorAll('#area .pn-body .git-file, #area .pn-body .git-dir')]
        .map((e) => {
          const s = getComputedStyle(e);
          return {
            depth: Number(s.getPropertyValue('--git-depth').trim() || 0),
            image: s.backgroundImage,
            width: s.backgroundSize.split(' ')[0],
          };
        }));

    const tree = await rows();
    // basic 픽스처는 `디렉터리 한글/` 아래에 파일이 있어 깊이 1 이상인 행이 있다.
    const deep = tree.filter((r) => r.depth > 0);
    expect(deep.length, '들여쓴 행이 없다').toBeGreaterThan(0);
    for (const r of deep) {
      expect(r.image, '세로선이 없다: ' + JSON.stringify(r)).toContain('gradient');
      // 선이 깊이만큼 그려진다 — 깊이 1 이면 한 칸(12px) 폭이다.
      expect(r.width).toBe(r.depth * 12 + 'px');
    }
    // 깊이 0 인 행에는 선이 없다 (폭 0).
    const flatRows = tree.filter((r) => r.depth === 0);
    expect(flatRows.length).toBeGreaterThan(0);
    for (const r of flatRows) expect(r.width).toBe('0px');

    // 플랫 보기에는 들여쓴 행 자체가 없다.
    await page.locator('#area .pn-body .git-files-mode[data-mode="flat"]').click();
    await page.waitForTimeout(600);
    expect((await rows()).every((r) => r.depth === 0)).toBe(true);
  });

  test('V89 (FR-GIT-212): 그룹이 선으로 나뉘고 첫 그룹 위에는 선이 없다', async ({ page }) => {
    await waitForInit(page);
    await openChanges(page, fx('basic'));
    await waitFiles(page, 3);

    const borders = await page.evaluate(() =>
      [...document.querySelectorAll('#area .pn-body .git-group')].map((e) => ({
        group: (e as HTMLElement).dataset.group,
        top: getComputedStyle(e).borderTopWidth,
      })));
    expect(borders.length).toBe(4);
    expect(borders[0].top, '첫 그룹 위에 선이 있다').toBe('0px');
    for (const b of borders.slice(1)) {
      expect(b.top, '구분선이 없다: ' + b.group).not.toBe('0px');
    }
  });
});

test.describe('UI 개정 — follow 의 근거 (FR-GIT-210)', () => {
  test('V87 (FR-GIT-210): Git 창에 들어가도 follow 가 서버 cwd 의 리포로 바뀌지 않는다', async ({ page }) => {
    const repo = fx('with-remote');
    await waitForInit(page);

    // 터미널을 그 리포로 옮긴다 — follow 가 그것을 가리켜야 한다.
    const ta = page.locator('#area .pn.focused .xterm-helper-textarea');
    await ta.fill('cd ' + repo);
    await ta.press('Enter');
    const followName = () => page.evaluate(() =>
      (document.querySelector('#git-repos .git-repo.follow .git-repo-name') as HTMLElement)?.textContent || '');
    await expect.poll(followName, { timeout: 20000 }).toBe('with-remote');

    // Git 창으로 들어간다 — 포커스가 터미널을 떠난다.
    await openGit(page, repo);
    await page.waitForTimeout(4000);   // GIT_REPOS_POLL_MS 를 넉넉히 넘긴다

    // follow 는 그대로다. 서버의 cwd(=dongminal 저장소)로 넘어가면 실패다.
    expect(await followName()).toBe('with-remote');
  });
});

test.describe('UI 개정 — 동작의 진입점 (FR-GIT-207~209)', () => {
  test('V85 (FR-GIT-207·209): 파일 목록 위에 선택 동작 줄이 없다', async ({ page }) => {
    await waitForInit(page);
    await openChanges(page, fx('basic'));
    await waitFiles(page, 3);
    // 여러 개를 골라도 줄이 생기지 않는다 — 진입점은 행 버튼 하나다.
    await files(page).nth(0).click();
    await files(page).nth(1).click({ modifiers: ['ControlOrMeta'] });
    await expect(page.locator('#area .pn-body .git-sel')).toHaveCount(0);
    await expect(page.locator('#area .pn-body .git-sel-act')).toHaveCount(0);
    await expect(page.locator('#area .pn-body .git-sel-clear')).toHaveCount(0);
    // 그룹 일괄은 남는다 (FR-GIT-66~68).
    await expect(page.locator('#area .pn-body .git-group-bulk').first()).toHaveCount(1);
  });

  test('V86 (FR-GIT-208): 선택 안의 행에서 누르면 선택 전체가, 밖이면 그 행만 대상이다', async ({ page }) => {
    const repo = copyFx('basic', 'v86');
    await waitForInit(page);
    await openChanges(page, repo);
    await waitFiles(page, 5);
    // 플랫 보기로 고정한다 — 트리는 행 순서가 디렉터리로 묶여 헷갈린다.
    await page.locator('#area .pn-body .git-files-mode[data-mode="flat"]').click();
    await page.waitForTimeout(500);

    const untracked = page.locator('#area .pn-body .git-group[data-group="untracked"] .git-file');
    await expect.poll(() => untracked.count(), { timeout: 15000 }).toBeGreaterThanOrEqual(1);

    // untracked 를 전부 고른 뒤, 그 중 한 행의 `+` 를 누른다.
    const n = await untracked.count();
    await untracked.nth(0).click();
    for (let i = 1; i < n; i++) await untracked.nth(i).click({ modifiers: ['ControlOrMeta'] });
    await expect(page.locator('#area .pn-body .git-file.sel')).toHaveCount(n);

    await untracked.nth(0).hover();
    await untracked.nth(0).locator('.git-file-act[data-act="stage"]').click();

    // 선택 전체가 스테이지된다 — 누른 행 하나가 아니다.
    await expect.poll(() =>
      page.locator('#area .pn-body .git-group[data-group="untracked"] .git-file').count(),
      { timeout: 20000 }).toBe(0);

    // 이번엔 선택 밖의 행에서 누른다 — 그 행만 대상이다.
    const changes = page.locator('#area .pn-body .git-group[data-group="changes"] .git-file');
    await expect.poll(() => changes.count(), { timeout: 15000 }).toBeGreaterThanOrEqual(2);
    const before = await changes.count();
    // 선택을 staged 쪽 한 행으로 옮겨 changes 행들이 선택 밖이 되게 한다.
    await page.locator('#area .pn-body .git-group[data-group="staged"] .git-file').first().click();
    await changes.nth(0).hover();
    await changes.nth(0).locator('.git-file-act[data-act="stage"]').click();
    await expect.poll(() =>
      page.locator('#area .pn-body .git-group[data-group="changes"] .git-file').count(),
      { timeout: 20000 }).toBe(before - 1);
  });
});

test.describe('UI 개정 — GIT 행 높이 (FR-GIT-219)', () => {
  test('V96 (FR-GIT-219): GIT 행이 WINDOWS 행과 같은 높이이고, 영역은 항목 수만큼만 자란다', async ({ page }) => {
    await waitForInit(page);
    await page.evaluate(async (p) => {
      await (window as any).app._gitPin(p);
    }, fx('basic'));
    await expect.poll(() => gitRepos(page).count(), { timeout: 20000 }).toBeGreaterThanOrEqual(1);

    const m = await page.evaluate(() => {
      const g = document.getElementById('git-repos')!;
      const row = g.querySelector('.git-repo') as HTMLElement;
      const si = document.querySelector('#windows .si') as HTMLElement | null;
      let content = 0;
      for (const c of [...g.children]) content += (c as HTMLElement).getBoundingClientRect().height;
      return {
        row: Math.round(row.getBoundingClientRect().height),
        si: si ? Math.round(si.getBoundingClientRect().height) : -1,
        box: Math.round(g.getBoundingClientRect().height),
        content: Math.round(content),
      };
    });
    expect(m.si, 'WINDOWS 행이 없다').toBeGreaterThan(0);
    expect(m.row, 'GIT 행이 WINDOWS 행과 다른 높이다').toBe(m.si);
    // 미리 영역을 키워 두지 않는다 — 항목 수만큼만이다.
    expect(m.box, '영역이 항목 수보다 크게 잡혔다').toBeLessThanOrEqual(m.content + 8);
  });
});

// FR-GIT-223: 핀 재배치. WINDOWS 목록·활동 카드와 **같은 native DnD** 경로다 —
// 하나의 DataTransfer 를 공유하는 합성 이벤트로 그 경로를 그대로 지난다.
async function dragPin(page: Page, src: string, dst: string, before = true) {
  await page.evaluate(({ s, d, b }) => {
    const dt = new DataTransfer();
    const from = document.querySelector(`#git-repos .git-repo[data-git-repo="${s}"]`)!;
    const to = document.querySelector(`#git-repos .git-repo[data-git-repo="${d}"]`)!;
    const r = to.getBoundingClientRect();
    const y = b ? r.top + 2 : r.bottom - 2;
    from.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
    to.dispatchEvent(new DragEvent('dragover', { bubbles: true, dataTransfer: dt, clientY: y }));
    to.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: dt, clientY: y }));
    from.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
  }, { s: src, d: dst, b: before });
}

const pinOrder = (page: Page) =>
  page.evaluate(() => [...document.querySelectorAll('#git-repos .git-repo')]
    .filter((e) => !e.classList.contains('follow'))
    .map((e) => (e as HTMLElement).dataset.gitRepo));

test.describe('UI 개정 — 핀 드래그 정렬 (FR-GIT-223)', () => {
  test('V100 (FR-GIT-223): 핀을 끌어 순서를 바꾸고 새로고침 후에도 남는다', async ({ page }) => {
    const a = fx('basic'), b = fx('with-remote'), c = fx('stashes');
    await waitForInit(page);
    for (const p of [a, b, c]) {
      await page.evaluate(async (x) => { await (window as any).app._gitPin(x) }, p);
    }
    await expect.poll(async () => (await pinOrder(page)).length, { timeout: 20000 }).toBe(3);
    expect(await pinOrder(page)).toEqual([a, b, c]);

    // 마지막을 맨 앞으로.
    await dragPin(page, c, a, true);
    await expect.poll(() => pinOrder(page), { timeout: 15000 }).toEqual([c, a, b]);

    // **항목 영역을 벗어난 release 도 커밋된다.** 창 목록이 이미 그렇게 한다 —
    // 문서 전역이 drop 을 받고 마지막 dragover 가 기록한 대상으로 커밋한다.
    await page.evaluate(({ s, d }) => {
      const dt = new DataTransfer();
      const from = document.querySelector(`#git-repos .git-repo[data-git-repo="${s}"]`)!;
      const to = document.querySelector(`#git-repos .git-repo[data-git-repo="${d}"]`)!;
      const r = to.getBoundingClientRect();
      from.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
      to.dispatchEvent(new DragEvent('dragover', { bubbles: true, dataTransfer: dt, clientY: r.bottom - 2 }));
      // 목록 밖(본문)에서 손을 뗀다.
      document.getElementById('area')!
        .dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: dt, clientY: 5 }));
      from.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
    }, { s: c, d: a });
    await expect.poll(() => pinOrder(page), { timeout: 15000 }).toEqual([a, c, b]);

    // 서버가 권위로 쓴다 (O1) — 새로고침해도 남는다.
    await page.reload();
    await page.waitForSelector('#area .pn.focused .xterm-helper-textarea', { timeout: 15000 });
    await expect.poll(() => pinOrder(page), { timeout: 20000 }).toEqual([a, c, b]);
  });

  test('V100 (FR-GIT-223): follow 항목은 끌 수 없다', async ({ page }) => {
    await waitForInit(page);
    await page.evaluate(async (x) => { await (window as any).app._gitPin(x) }, fx('basic'));
    await expect.poll(() => gitRepos(page).count(), { timeout: 20000 }).toBeGreaterThanOrEqual(1);

    const follow = page.locator('#git-repos .git-repo.follow');
    if (await follow.count()) {
      // 핀이 아니고 늘 최상단 1줄이다 (FR-GIT-193).
      await expect(follow).not.toHaveAttribute('draggable', 'true');
    }
    // 핀 항목은 끌 수 있다.
    await expect(page.locator('#git-repos .git-repo:not(.follow)').first())
      .toHaveAttribute('draggable', 'true');
  });
});

test.describe('UI 개정 — 그룹 머리글 높이 (FR-GIT-220)', () => {
  test('V97 (FR-GIT-220): 일괄 버튼이 없는 그룹도 머리글 높이가 같다', async ({ page }) => {
    await waitForInit(page);
    await openChanges(page, fx('conflict'));
    await expect.poll(async () =>
      (await page.locator('#area .pn-body .git-group').count()), { timeout: 20000 })
      .toBeGreaterThanOrEqual(2);

    const heads = await page.evaluate(() =>
      [...document.querySelectorAll('#area .pn-body .git-group')].map((g) => ({
        group: (g as HTMLElement).dataset.group,
        h: Math.round((g.querySelector('.git-group-head') as HTMLElement).getBoundingClientRect().height),
        bulk: !!g.querySelector('.git-group-bulk'),
      })));
    expect(heads.length).toBeGreaterThanOrEqual(2);
    // 일괄이 없는 그룹이 실제로 있어야 이 테스트가 뜻을 갖는다.
    expect(heads.some((x) => !x.bulk), '일괄 없는 그룹이 목록에 없다').toBe(true);
    const uniq = [...new Set(heads.map((x) => x.h))];
    expect(uniq, '머리글 높이가 그룹마다 다르다: ' + JSON.stringify(heads)).toHaveLength(1);
  });
});

// FR-GIT-216: 섹션 경계의 굵기 하한. 색은 테스트가 정하지 않는다 — 테마에서
// 파생하므로 "행 구분선과 다른가" 로만 판정한다.
const SEC_BORDER_W = 2;

// 경계선을 읽는다. **조회와 계산을 한 번의 evaluate 안에서** 한다 — 1초 폴링이
// 목록을 다시 그리므로 밖에서 잡은 요소는 계산 시점에 떨어져 나갈 수 있고,
// 떨어진 요소의 getComputedStyle 은 빈 값을 준다.
const edges = (page: Page, sel: string, side: 'top' | 'bottom') =>
  page.evaluate(([q, s]) => {
    return [...document.querySelectorAll(q)].map((el) => {
      const c = getComputedStyle(el);
      return {
        w: parseFloat(c.getPropertyValue(`border-${s}-width`)) || 0,
        color: c.getPropertyValue(`border-${s}-color`),
      };
    });
  }, [sel, side] as const);

const rootVar = (page: Page, name: string) =>
  page.evaluate((n) => getComputedStyle(document.documentElement)
    .getPropertyValue(n).trim(), name);

test.describe('UI 개정 — 섹션 경계 (FR-GIT-216)', () => {
  test('V93 (FR-GIT-216): 섹션 경계가 행 구분선과 다른 굵기·색으로 그려진다', async ({ page }) => {
    await waitForInit(page);
    await page.evaluate(async (p) => {
      await (window as any).app._gitPin(p);
    }, fx('basic'));
    await openChanges(page, fx('basic'));
    await waitFiles(page, 3);

    // 진한 색은 팔레트에서 빌리지 않고 border 를 text 쪽으로 섞어 만든다.
    const strong = await rootVar(page, '--border-strong');
    const plain = await rootVar(page, '--border');
    expect(strong, '--border-strong 이 없다').toBeTruthy();
    expect(strong.toLowerCase(), '섹션 색이 행 구분선과 같다').not.toBe(plain.toLowerCase());

    // ① Changes 그룹 — 첫 그룹 위에는 없고, 둘째부터 경계를 갖는다.
    await expect.poll(async () => (await edges(page, '#area .pn-body .git-group', 'top')).length,
      { timeout: 15000 }).toBeGreaterThanOrEqual(2);
    const groups = await edges(page, '#area .pn-body .git-group', 'top');
    expect(groups[0].w, '첫 그룹 위에 선이 있다').toBe(0);
    expect(groups[1].w).toBeGreaterThanOrEqual(SEC_BORDER_W);

    // 같은 화면의 행과 달라야 한다 — 굵기든 색이든.
    const rowLine = (await edges(page, '#area .pn-body .git-file', 'top'))[0];
    expect(groups[1].w + '/' + groups[1].color, '섹션 경계가 행과 구별되지 않는다')
      .not.toBe(rowLine.w + '/' + rowLine.color);

    // ② 사이드바 — WINDOWS ↔ GIT 경계와 follow ↔ 핀 경계.
    const secTitle = (await edges(page, '.git-sec-title', 'top'))[0];
    expect(secTitle.w).toBeGreaterThanOrEqual(SEC_BORDER_W);
    const follow = (await edges(page, '#git-repos .git-repo.follow', 'bottom'))[0];
    expect(follow.w).toBeGreaterThanOrEqual(SEC_BORDER_W);

    // ③ 테마를 바꾸면 따라 바뀐다 — 색을 하드코딩하지 않았다는 증거다.
    const before = groups[1].color;
    await page.evaluate<string>(
      '(function(){' +
      "var cur=getComputedStyle(document.documentElement).getPropertyValue('--border').trim().toLowerCase();" +
      'var n=Object.keys(THEMES).find(function(k){' +
      'return THEMES[k].ui.border.toLowerCase()!==cur});' +
      'customTheme=null;currentThemeName=n;applyThemeObj(THEMES[n]);return n})()');
    await expect.poll(async () =>
      (await edges(page, '#area .pn-body .git-group', 'top'))[1].color,
      { timeout: 10000 }).not.toBe(before);
  });

  test('V93 (FR-GIT-216): Branches 그룹과 refs 그룹도 같은 경계를 갖는다', async ({ page }) => {
    await waitForInit(page);
    await openGit(page, fx('with-remote'));

    // Branches — 로컬·원격·태그 그룹.
    await page.locator('#area .pn-tab[data-git-view="branches"]').click();
    await expect.poll(async () => (await edges(page, '#area .pn-body .git-br-group', 'top')).length,
      { timeout: 20000 }).toBeGreaterThanOrEqual(2);
    const br = await edges(page, '#area .pn-body .git-br-group', 'top');
    expect(br[0].w, '첫 그룹 위에 선이 있다').toBe(0);
    expect(br[1].w).toBeGreaterThanOrEqual(SEC_BORDER_W);
    // 접두사 묶음은 섹션이 아니다 — 있어도 경계를 갖지 않는다.
    const pfx = await edges(page, '#area .pn-body .git-br-pfx', 'top');
    expect(pfx.filter((p) => p.w >= SEC_BORDER_W), '접두사 묶음이 섹션처럼 그려졌다').toEqual([]);

    // History refs — 로컬·원격·태그 그룹.
    await page.locator('#area .pn-tab[data-git-view="history"]').click();
    await expect.poll(async () => (await edges(page, '#area .pn-body .git-refs-group', 'top')).length,
      { timeout: 20000 }).toBeGreaterThanOrEqual(2);
    const rf = await edges(page, '#area .pn-body .git-refs-group', 'top');
    expect(rf[0].w, '첫 refs 그룹 위에 선이 있다').toBe(0);
    expect(rf[1].w).toBeGreaterThanOrEqual(SEC_BORDER_W);
  });
});

// FR-GIT-214 의 간격 하한. 값은 여기 한 곳에만 둔다.
const MIN_GAP_LIST_ADD = 6;
const MIN_GAP_ADD_SETTINGS = 10;

// GIT 섹션의 세 덩이 사이 간격. 여백은 margin 이라 요소 사각형 사이의 빈 거리로
// 잰다 — 계산된 margin 값을 읽으면 서로 상쇄되는 경우를 놓친다.
const sectionGaps = (page: Page) =>
  page.evaluate(() => {
    const r = (id: string) => document.getElementById(id)!.getBoundingClientRect();
    const list = r('git-repos'), add = r('git-add-repo'), set = r('settings-btn');
    return { listAdd: add.top - list.bottom, addSettings: set.top - add.bottom };
  });

test.describe('UI 개정 — GIT 섹션의 간격 (FR-GIT-214)', () => {
  test('V91 (FR-GIT-214): 목록·+ Add·설정이 서로 붙지 않는다', async ({ page }) => {
    await waitForInit(page);
    await page.evaluate(async (p) => {
      await (window as any).app._gitPin(p);
    }, fx('basic'));
    await expect.poll(() => gitRepos(page).count(), { timeout: 20000 }).toBeGreaterThanOrEqual(1);

    const g = await sectionGaps(page);
    expect(g.listAdd, '목록과 + Add 가 붙어 있다').toBeGreaterThanOrEqual(MIN_GAP_LIST_ADD);
    expect(g.addSettings, '+ Add 와 설정이 붙어 있다').toBeGreaterThanOrEqual(MIN_GAP_ADD_SETTINGS);
    // ⚙ 은 GIT 섹션에 속하지 않는다 — 뒤쪽이 더 넓어야 세 덩이가 한 무리로 읽히지
    // 않는다.
    expect(g.addSettings, '설정이 GIT 섹션과 같은 무리로 읽힌다').toBeGreaterThan(g.listAdd);
  });

  test('V91 (FR-GIT-214): 모바일 폭에서도 간격이 지켜진다', async ({ page }) => {
    await waitForInit(page);
    await page.setViewportSize({ width: 420, height: 800 });
    await page.waitForTimeout(600);
    // 모바일은 드로어다 — 열어야 사이드바가 화면에 선다.
    await page.evaluate(() => (window as any).app.openDrawer && (window as any).app.openDrawer());
    await page.waitForTimeout(300);

    const g = await sectionGaps(page);
    expect(g.listAdd).toBeGreaterThanOrEqual(MIN_GAP_LIST_ADD);
    expect(g.addSettings).toBeGreaterThanOrEqual(MIN_GAP_ADD_SETTINGS);
  });
});

test.describe('UI 개정 — GIT 섹션 표식 (FR-GIT-192~194)', () => {
  test('V79 (FR-GIT-192·193·194): 이모지가 없고 점이 활성 리포를 나타내며 follow 아래에 구분선이 있다', async ({ page }) => {
    await waitForInit(page);
    await page.evaluate(async (p) => {
      await (window as any).app._gitPin(p);
    }, fx('basic'));
    await page.evaluate(async (p) => {
      await (window as any).app._gitPin(p);
    }, fx('with-remote'));
    await openGit(page, fx('basic'));
    await expect.poll(() => gitRepos(page).count(), { timeout: 20000 }).toBeGreaterThanOrEqual(3);

    // 이모지를 쓰지 않는다.
    const text = await page.evaluate(() => document.getElementById('git-repos')!.textContent || '');
    expect(text).not.toContain('📌');
    expect(text).not.toContain('⟳');

    // 표식은 WINDOWS 의 점과 같은 어휘다 — 활성 리포만 accent 로 채운다.
    const dots = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('#git-repos .git-repo')] as HTMLElement[];
      return rows.map(r => {
        const d = r.querySelector('.git-repo-dot') as HTMLElement | null;
        return {
          repo: (r.dataset.gitRepo || '').split('/').pop(),
          active: r.classList.contains('active'),
          follow: r.classList.contains('follow'),
          hasDot: !!d,
          bg: d ? getComputedStyle(d).backgroundColor : null,
        };
      });
    });
    const active = dots.find(d => d.active)!;
    const idle = dots.find(d => !d.active && !d.follow)!;
    expect(active.hasDot).toBe(true);
    expect(idle.hasDot).toBe(true);
    expect(active.bg).not.toBe(idle.bg);

    // follow 는 최상단 1줄이고 그 아래에 구분선이 있다 (표식이 아니라 배치로 나눈다).
    expect(dots[0].follow).toBe(true);
    expect(dots.filter(d => d.follow).length).toBe(1);
    const sep = await page.evaluate(() => {
      const f = document.querySelector('#git-repos .git-repo.follow') as HTMLElement;
      const s = getComputedStyle(f);
      return { w: s.borderBottomWidth, style: s.borderBottomStyle };
    });
    expect(sep.w).not.toBe('0px');
    expect(sep.style).not.toBe('none');
  });
});

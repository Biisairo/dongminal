import { execFileSync } from 'child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

import { Page } from '@playwright/test';

import { test, expect, waitForInit, openGit, freshDir, rmTree } from './fixtures';
import { tmpPath, realPath } from './osenv';

// constants-editor.js 의 전역 상수 — `const` 는 전역 렉시컬 환경에 들어가므로
// `window.X` 로는 잡히지 않는다. 맨 이름으로 읽는다 (editor-git-ux.spec.ts 의
// GIT_DIFF_OPTIONS 와 같은 규약).
declare const ED_DD_MAX_LINES: number;
declare function edDiffLines(a: string[], b: string[]): any;

// EDITOR_DIRTY_DIFF_SRS — 편집기의 변경 표시.
// 검증 V-EDD-1~16.
//
// 저장소는 이 스펙이 직접 세운다. git_fixture.sh 의 `basic` 은 상태가 이미
// 여럿(rename·유니코드·충돌)이라 "한 줄만 고쳤다" 를 재는 자리로는 잡음이 많다 —
// 여기서 재는 것은 조각 하나의 좌표이므로 입력이 정확해야 한다.

const ROOT = tmpPath('dm-dd-' + process.pid);

// 기준 파일. 줄 번호가 그대로 단언이 되므로 내용을 짧고 다르게 둔다.
const BASE = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight'];

function mkrepo(name: string, files: Record<string, string>): string {
  const d = join(ROOT, name);
  freshDir(d);
  execFileSync('git', ['-C', d, 'init', '-q', '-b', 'main', '.']);
  execFileSync('git', ['-C', d, 'config', 'user.name', 'Fixture']);
  execFileSync('git', ['-C', d, 'config', 'user.email', 'fixture@example.invalid']);
  execFileSync('git', ['-C', d, 'config', 'commit.gpgsign', 'false']);
  for (const [p, c] of Object.entries(files)) writeFileSync(join(d, p), c);
  execFileSync('git', ['-C', d, 'add', '-A']);
  execFileSync('git', ['-C', d, 'commit', '-qm', 'init']);
  return realPath(d);
}

const git = (repo: string, ...args: string[]) =>
  execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });

test.beforeAll(() => { mkdirSync(ROOT, { recursive: true }) });
test.afterAll(() => { rmTree(ROOT) });

// 편집기를 세우고 Monaco 가 뜰 때까지 기다린다. `openGit` 이 Repo 창을 세우므로
// 그 안의 편집기 탭이 이 파일을 연다 (FR-EDD-3 의 창 루트가 그 창의 것이다).
async function openFile(page: Page, repo: string, rel: string) {
  await openGit(page, repo);
  await page.evaluate((f) => (window as any).app._edOpenFile(f), join(repo, rel));
  await expect(page.locator('.file-editor .monaco-editor')).toHaveCount(1, { timeout: 30000 });
  // 기준을 받아 첫 계산이 끝날 때까지 — 그 전의 단언은 "아직 오지 않았다" 를
  // "변경이 없다" 로 읽는다.
  await page.waitForFunction((f) => {
    const dd = (window as any).app._edDirtyDiff && (window as any).app._edDirtyDiff(f);
    return !!(dd && dd.settled);
  }, join(repo, rel), { timeout: 20000 });
}

// 모델의 현재 값을 통째로 바꾼다. 사용자의 타이핑과 같은 경로(편집)이며
// `setValue` 가 아니다 — `setValue` 는 isFlush 라 dirty 규약이 다르다.
async function setLines(page: Page, lines: string[]) {
  await page.evaluate((text) => {
    const ed = (window as any).monaco.editor.getEditors()
      .find((e: any) => e.getDomNode()?.closest('.file-editor'));
    const m = ed.getModel();
    ed.executeEdits('test', [{ range: m.getFullModelRange(), text }]);
  }, lines.join('\n') + '\n');
}

const decos = (page: Page) => page.evaluate(() => {
  const ed = (window as any).monaco.editor.getEditors()
    .find((e: any) => e.getDomNode()?.closest('.file-editor'));
  const m = ed.getModel();
  return m.getAllDecorations()
    .filter((d: any) => (d.options.linesDecorationsClassName || '').startsWith('fe-dd-'))
    .map((d: any) => ({
      cls: d.options.linesDecorationsClassName,
      line: d.range.startLineNumber,
      end: d.range.endLineNumber,
      ruler: d.options.overviewRuler ? d.options.overviewRuler.color : null,
      minimap: d.options.minimap ? d.options.minimap.color : null,
    }))
    .sort((a: any, b: any) => a.line - b.line);
});

const bars = (page: Page, kind: string) =>
  page.locator(`.file-editor .margin-view-overlays .fe-dd-${kind}`);
const peek = (page: Page) => page.locator('.file-editor .fe-dd-peek');

test.describe('묶음 C — diff 계산 (FR-EDD-10~13)', () => {
  // 순수 함수이므로 브라우저 안에서 바로 잰다. e2e 를 한 벌 더 세우지 않고
  // 경계 조건을 싸게 덮는 자리다.
  test.beforeEach(async ({ page }) => {
    await waitForInit(page);
  });

  const run = (page: Page, a: string[], b: string[]) =>
    page.evaluate(([x, y]) => edDiffLines(x, y), [a, b]);

  test('같으면 조각이 없다', async ({ page }) => {
    const r = await run(page, BASE, BASE);
    expect(r.ok).toBe(true);
    expect(r.changes).toEqual([]);
  });

  test('한 줄 수정은 mod 하나다', async ({ page }) => {
    const cur = BASE.slice(); cur[2] = 'THREE';
    const r = await run(page, BASE, cur);
    expect(r.changes).toEqual([
      { type: 'mod', line: 3, count: 1, baseStart: 3, baseCount: 1 },
    ]);
  });

  test('가운데 삽입은 add 다', async ({ page }) => {
    const cur = [...BASE.slice(0, 3), 'new', ...BASE.slice(3)];
    const r = await run(page, BASE, cur);
    expect(r.changes).toEqual([
      { type: 'add', line: 4, count: 1, baseStart: 4, baseCount: 0 },
    ]);
  });

  test('삭제는 del 이고 줄 수가 0 이다', async ({ page }) => {
    const cur = [...BASE.slice(0, 2), ...BASE.slice(4)];
    const r = await run(page, BASE, cur);
    expect(r.changes).toEqual([
      { type: 'del', line: 3, count: 0, baseStart: 3, baseCount: 2 },
    ]);
  });

  test('빈 기준에서 전부 추가', async ({ page }) => {
    const r = await run(page, [], BASE);
    expect(r.changes).toEqual([
      { type: 'add', line: 1, count: 8, baseStart: 1, baseCount: 0 },
    ]);
  });

  test('전부 지우면 del 하나다', async ({ page }) => {
    const r = await run(page, BASE, []);
    expect(r.changes).toEqual([
      { type: 'del', line: 1, count: 0, baseStart: 1, baseCount: 8 },
    ]);
  });

  test('조각이 둘이면 둘 다 나온다', async ({ page }) => {
    const cur = BASE.slice(); cur[1] = 'TWO'; cur[6] = 'SEVEN';
    const r = await run(page, BASE, cur);
    expect(r.changes.map((c: any) => [c.type, c.line])).toEqual([['mod', 2], ['mod', 7]]);
  });

  test('상한을 넘으면 계산하지 않는다 (FR-EDD-13)', async ({ page }) => {
    const r = await page.evaluate(() => {
      const a = new Array(ED_DD_MAX_LINES + 1).fill('x');
      return edDiffLines(a, a.slice());
    });
    expect(r.ok).toBe(false);
    expect(r.changes).toEqual([]);
  });
});

test.describe('묶음 M — 표시 (FR-EDD-20~28)', () => {
  test('V-EDD-1·2: 저장 없이 고쳐도 막대와 눈금이 뜬다', async ({ page }) => {
    const repo = mkrepo('mark', { 'a.txt': BASE.join('\n') + '\n' });
    await waitForInit(page);
    await openFile(page, repo, 'a.txt');
    expect(await decos(page)).toEqual([]);

    const cur = BASE.slice(); cur[2] = 'THREE';
    await setLines(page, cur);

    await expect(bars(page, 'mod')).toHaveCount(1);
    const d = await decos(page);
    expect(d).toHaveLength(1);
    expect(d[0].line).toBe(3);
    // FR-EDD-21·22: 눈금과 미니맵에도 실린다. 색은 CSS 변수에서 온 값이므로
    // **무엇인지는 묻지 않고 있는지만** 본다 (FR-EDD-23 이 값을 박지 않는다).
    expect(d[0].ruler).toBeTruthy();
    expect(d[0].minimap).toBeTruthy();
  });

  test('V-EDD-3: 추가와 삭제가 각자의 표식을 갖는다', async ({ page }) => {
    const repo = mkrepo('addel', { 'a.txt': BASE.join('\n') + '\n' });
    await waitForInit(page);
    await openFile(page, repo, 'a.txt');

    await setLines(page, [...BASE.slice(0, 3), 'new', ...BASE.slice(3)]);
    await expect(bars(page, 'add')).toHaveCount(1);

    await setLines(page, [...BASE.slice(0, 2), ...BASE.slice(4)]);
    await expect(bars(page, 'del')).toHaveCount(1);
    await expect(bars(page, 'add')).toHaveCount(0);
  });

  test('V-EDD-4: 기준과 같아지면 표시가 사라진다', async ({ page }) => {
    const repo = mkrepo('back', { 'a.txt': BASE.join('\n') + '\n' });
    await waitForInit(page);
    await openFile(page, repo, 'a.txt');

    const cur = BASE.slice(); cur[0] = 'ONE';
    await setLines(page, cur);
    await expect(bars(page, 'mod')).toHaveCount(1);

    await setLines(page, BASE);
    await expect(bars(page, 'mod')).toHaveCount(0);
    expect(await decos(page)).toEqual([]);
  });

  test('V-EDD-5: untracked 파일에는 표시가 없다', async ({ page }) => {
    const repo = mkrepo('untracked', { 'a.txt': 'x\n' });
    writeFileSync(join(repo, 'new.txt'), BASE.join('\n') + '\n');
    await waitForInit(page);
    await openFile(page, repo, 'new.txt');
    await setLines(page, ['zzz', ...BASE]);
    await expect(bars(page, 'add')).toHaveCount(0);
    expect(await decos(page)).toEqual([]);
  });

  test('V-EDD-6: 저장소가 아닌 자리에서도 편집기는 그대로다', async ({ page }) => {
    const plain = join(ROOT, 'plain');
    freshDir(plain);
    writeFileSync(join(plain, 'a.txt'), BASE.join('\n') + '\n');
    await waitForInit(page);
    await page.evaluate((p) => (window as any).app._edMutate('/add', { path: p }), plain);
    await page.evaluate((f) => (window as any).app._edOpenFile(f), join(plain, 'a.txt'));
    await expect(page.locator('.file-editor .monaco-editor')).toHaveCount(1, { timeout: 30000 });
    const cur = BASE.slice(); cur[0] = 'ONE';
    await setLines(page, cur);
    // 편집은 그대로 된다 — 표시만 없다.
    await expect(bars(page, 'mod')).toHaveCount(0);
    expect(await page.evaluate(() => {
      const ed = (window as any).monaco.editor.getEditors()
        .find((e: any) => e.getDomNode()?.closest('.file-editor'));
      return ed.getModel().getLineContent(1);
    })).toBe('ONE');
  });

  test('V-EDD-12: 스테이지한 뒤 열면 표시가 없다 (기준은 index)', async ({ page }) => {
    const repo = mkrepo('staged', { 'a.txt': BASE.join('\n') + '\n' });
    const cur = BASE.slice(); cur[3] = 'FOUR';
    writeFileSync(join(repo, 'a.txt'), cur.join('\n') + '\n');
    git(repo, 'add', 'a.txt');
    await waitForInit(page);
    await openFile(page, repo, 'a.txt');
    // HEAD 기준이면 4번 줄에 막대가 섰을 것이다. index 기준이므로 없다.
    expect(await decos(page)).toEqual([]);
  });
});

test.describe('묶음 P·A — 팝업과 동작 (FR-EDD-30~49)', () => {
  test('V-EDD-8·9: 팝업의 되돌리기는 모델 편집이고 undo 로 돌아온다', async ({ page }) => {
    const repo = mkrepo('revert', { 'a.txt': BASE.join('\n') + '\n' });
    await waitForInit(page);
    await openFile(page, repo, 'a.txt');

    const cur = BASE.slice(); cur[2] = 'THREE';
    await setLines(page, cur);
    await bars(page, 'mod').first().click();

    await expect(peek(page)).toHaveCount(1);
    // FR-EDD-31: 기준 쪽 줄이 보인다.
    await expect(peek(page).locator('.fe-dd-peek-old')).toContainText('three');

    await peek(page).locator('.fe-dd-peek-act[data-act="revert"]').click();
    await expect(bars(page, 'mod')).toHaveCount(0);
    expect(await page.evaluate(() => {
      const ed = (window as any).monaco.editor.getEditors()
        .find((e: any) => e.getDomNode()?.closest('.file-editor'));
      return ed.getModel().getLineContent(3);
    })).toBe('three');
    // FR-EDD-41: 디스크는 그대로다 — 되돌리기가 저장하지 않는다.
    expect(readFileSync(join(repo, 'a.txt'), 'utf8')).toBe(BASE.join('\n') + '\n');
  });

  test('V-EDD-15: Escape 로 팝업이 닫힌다', async ({ page }) => {
    const repo = mkrepo('esc', { 'a.txt': BASE.join('\n') + '\n' });
    await waitForInit(page);
    await openFile(page, repo, 'a.txt');
    const cur = BASE.slice(); cur[1] = 'TWO';
    await setLines(page, cur);
    await bars(page, 'mod').first().click();
    await expect(peek(page)).toHaveCount(1);
    await page.keyboard.press('Escape');
    await expect(peek(page)).toHaveCount(0);
  });

  test('V-EDD-10: dirty 상태의 스테이지는 저장하고 올린다', async ({ page }) => {
    const repo = mkrepo('stage', { 'a.txt': BASE.join('\n') + '\n' });
    await waitForInit(page);
    await openFile(page, repo, 'a.txt');

    const cur = BASE.slice(); cur[4] = 'FIVE';
    await setLines(page, cur);
    await bars(page, 'mod').first().click();
    await peek(page).locator('.fe-dd-peek-act[data-act="stage"]').click();

    // ① 저장됐다 ② index 에 올라갔다 ③ 그래서 표시가 사라졌다
    await expect(bars(page, 'mod')).toHaveCount(0, { timeout: 20000 });
    expect(readFileSync(join(repo, 'a.txt'), 'utf8')).toBe(cur.join('\n') + '\n');
    expect(git(repo, 'diff', '--cached', '--name-only').trim()).toBe('a.txt');
    expect(git(repo, 'diff', '--name-only').trim()).toBe('');
  });

  test('V-EDD-11: 조각이 둘이면 고른 하나만 올라간다', async ({ page }) => {
    const repo = mkrepo('partial', { 'a.txt': BASE.join('\n') + '\n' });
    await waitForInit(page);
    await openFile(page, repo, 'a.txt');

    const cur = BASE.slice(); cur[1] = 'TWO'; cur[6] = 'SEVEN';
    await setLines(page, cur);
    await expect(bars(page, 'mod')).toHaveCount(2);
    await bars(page, 'mod').first().click();
    await peek(page).locator('.fe-dd-peek-act[data-act="stage"]').click();

    // 하나만 남는다 — 올라간 조각의 막대만 사라진다.
    await expect(bars(page, 'mod')).toHaveCount(1, { timeout: 20000 });
    const staged = git(repo, 'diff', '--cached', '-U0');
    expect(staged).toContain('+TWO');
    expect(staged).not.toContain('+SEVEN');
    expect(git(repo, 'diff', '-U0')).toContain('+SEVEN');
  });
});

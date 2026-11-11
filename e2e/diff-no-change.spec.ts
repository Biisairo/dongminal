/**
 * UX_BATCH12_SRS §3.5h FR-DNC — 변경이 없어진 Diff.
 *
 * TC-DNC-1: Diff(working) 를 연 채 변경을 전부 커밋 / 그 파일만 커밋 — 두 경우 모두 안내, 탭은 남는다.
 * TC-DNC-2: 접기를 켠 채 전부 커밋 — 본문이 접히지 않고 파일 전체다.
 * TC-DNC-3: 접기를 켠 채 원본 쪽(index)이 바뀌면 접을 범위가 남은 변경을 따른다. 다시 변경이 생기면
 *           안내가 걷히고 변경 색이 돌아온다 (FR-DNC-3·4).
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import { APIRequestContext, Page } from '@playwright/test';

import { test, expect, rmTree, switchToEditorRoot, gotoWithEditors } from './fixtures';
import { TMP, realPath } from './osenv';

const j = (...p: string[]) => path.join(...p);
const git = (d: string, ...a: string[]) => execFileSync('git', ['-C', d, ...a], { stdio: 'ignore' });
const N = 40;
const body = (edit: Record<number, string> = {}) =>
  Array.from({ length: N }, (_, i) => edit[i + 1] ?? 'row' + (i + 1)).join('\n') + '\n';

const repos: string[] = [];
function mkRepo(edit: Record<number, string>): string {
  const d = realPath(fs.mkdtempSync(j(TMP, 'dm-dnc-')));
  repos.push(d);
  git(d, 'init', '-q', '-b', 'main', '.');
  git(d, 'config', 'user.name', 'Fixture');
  git(d, 'config', 'user.email', 'fixture@example.invalid');
  git(d, 'config', 'commit.gpgsign', 'false');
  for (const f of ['a.txt', 'b.txt']) fs.writeFileSync(j(d, f), body());
  git(d, 'add', '-A');
  git(d, 'commit', '-qm', 'init');
  fs.writeFileSync(j(d, 'a.txt'), body({ 3: 'A-CHANGED' }));
  fs.writeFileSync(j(d, 'b.txt'), body(edit));
  return d;
}
test.afterAll(() => { for (const d of repos) rmTree(d) });

const diffEl = (page: Page, sel: string) => page.locator(`#area .ed-area .git-view.git-diff ${sel}`);
const changed = (page: Page) => diffEl(page, '.git-diff-side-mod .cm-changedLine');
const folds = (page: Page) => diffEl(page, '.cm-collapsedLines');
const line = (page: Page, text: string) => diffEl(page, '.git-diff-side-mod .cm-line').filter({ hasText: new RegExp('^' + text + '$') });

async function openDiff(page: Page, request: APIRequestContext, repo: string, fold: boolean) {
  const r = await request.post('/api/editors/add', { data: { path: repo } });
  expect(r.ok(), `editors/add 실패: ${await r.text()}`).toBeTruthy();
  await gotoWithEditors(page);
  await switchToEditorRoot(page, repo);
  const row = page.locator('#area .ed-side .git-view.git-changes .git-group[data-group="working"] .git-file[data-path="b.txt"]');
  await expect(row).toBeVisible({ timeout: 10000 });
  await row.click();
  await expect(diffEl(page, '.git-diff-path')).toHaveText('b.txt');
  await expect(changed(page).first()).toBeVisible({ timeout: 10000 });
  const box = diffEl(page, '.git-diff-fold input');
  if ((await box.isChecked()) !== fold) await box.click();
  await expect(box).toBeChecked({ checked: fold });
}

const tabCount = (page: Page) => page.evaluate(() => {
  const a = (window as any).app;
  const w = a.testing.aw();
  return w.layout ? a.testing.flattenPanes(w.layout)[0].tabs.length : 0;
});

test.describe('TC-DNC-1 — 변경이 없어지면 한 규칙으로 안내한다 (FR-DNC-1)', () => {
  for (const mode of ['all', 'one']) {
    test(`커밋(${mode === 'all' ? '전부' : '그 파일만'}) 뒤 "변경이 없습니다" 가 서고 탭은 남는다`, async ({ page, request }) => {
      const repo = mkRepo({ 20: 'B-CHANGED' });
      await openDiff(page, request, repo, false);
      await expect(diffEl(page, '.git-diff-gone')).not.toHaveClass(/vis/);
      if (mode === 'all') git(repo, 'commit', '-qam', 'c');
      else git(repo, 'commit', '-qm', 'c', '--', 'b.txt');
      await expect(diffEl(page, '.git-diff-gone')).toHaveClass(/vis/, { timeout: 15000 });
      await expect(diffEl(page, '.git-diff-gone')).toHaveText('변경이 없습니다 — 커밋됐거나 되돌려졌습니다');
      await expect(changed(page)).toHaveCount(0, { timeout: 15000 });
      expect(await tabCount(page)).toBe(1);
    });
  }
});

test.describe('TC-DNC-2 — 변경이 없으면 접지 않는다 (FR-DNC-2)', () => {
  test('접기를 켠 채 전부 커밋하면 본문이 파일 전체다', async ({ page, request }) => {
    const repo = mkRepo({ 20: 'B-CHANGED' });
    await openDiff(page, request, repo, true);
    await expect(folds(page).first()).toBeVisible({ timeout: 10000 });
    git(repo, 'commit', '-qam', 'c');
    await expect(diffEl(page, '.git-diff-gone')).toHaveClass(/vis/, { timeout: 15000 });
    await expect(folds(page)).toHaveCount(0, { timeout: 15000 });
    await expect(line(page, 'row1')).toHaveCount(1);
    await expect(line(page, 'B-CHANGED')).toHaveCount(1);
  });
});

test.describe('TC-DNC-3 — 접기는 지금 내용을 따른다 (FR-DNC-3·4)', () => {
  test('원본 쪽이 바뀌면 접을 범위가 다시 서고, 다시 변경이 생기면 돌아온다', async ({ page, request }) => {
    const repo = mkRepo({ 5: 'FIVE-X', 35: 'THIRTYFIVE-X' });
    await openDiff(page, request, repo, true);
    await expect(line(page, 'THIRTYFIVE-X')).toHaveCount(1, { timeout: 10000 });
    await expect(line(page, 'FIVE-X')).toHaveCount(1);

    // 35행 변경만 index 에 올린다 — Diff(working) 의 원본 쪽(index)만 바뀐다.
    fs.writeFileSync(j(repo, 'b.txt'), body({ 35: 'THIRTYFIVE-X' }));
    git(repo, 'add', 'b.txt');
    fs.writeFileSync(j(repo, 'b.txt'), body({ 5: 'FIVE-X', 35: 'THIRTYFIVE-X' }));
    // 35행은 이제 변경이 아니다 — 접힌다. 5행은 그대로 변경이다.
    await expect(line(page, 'THIRTYFIVE-X')).toHaveCount(0, { timeout: 15000 });
    await expect(line(page, 'FIVE-X')).toHaveCount(1);
    await expect(changed(page)).toHaveCount(1);

    // 전부 커밋 → 변경 없음(접지 않음) → 다시 변경 → 안내가 걷히고 색과 접기가 돌아온다.
    git(repo, 'commit', '-qam', 'c');
    await expect(folds(page)).toHaveCount(0, { timeout: 15000 });
    fs.writeFileSync(j(repo, 'b.txt'), body({ 5: 'FIVE-X', 35: 'THIRTYFIVE-X', 20: 'TWENTY-Y' }));
    await expect(diffEl(page, '.git-diff-gone')).not.toHaveClass(/vis/, { timeout: 15000 });
    await expect(changed(page)).toHaveCount(1, { timeout: 15000 });
    await expect(folds(page).first()).toBeVisible({ timeout: 15000 });
  });
});

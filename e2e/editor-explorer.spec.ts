import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { APIRequestContext, Page } from '@playwright/test';

import { test, expect } from './fixtures';

// EDITOR_TAB_SRS §4 — M3(파일 탐색기) · M4(탐색기의 git 색)의 검증 V-EDT-40~56.
//
// **여기서는 서버를 목업하지 않는다.** M1 의 `/api/fs/list` · `/api/editors/*` 와
// git 표면이 이미 서 있으므로, 픽스처를 진짜 디스크에 만들고 진짜 응답 위에서
// 잰다 — 정렬(D-20)·링크 판정(FR-EDT-60)·상태 문자(FR-EDT-72)가 전부 서버가
// 정하는 값이기 때문이다. 클라이언트 계약만 재는 둘(잘림·조회 실패)은 그 값을
// 디스크로 만들 수 없으므로 그 테스트에서만 `page.route` 로 응답을 세운다.

let PLAIN = '';   // 저장소가 아닌 루트 (FR-EDT-47 의 대상)
let REPO = '';    // 저장소 루트 (묶음 X 의 색)
let BASE = '';

const j = (...p: string[]) => path.join(...p);
const w = (p: string, s: string) => fs.writeFileSync(p, s);
const git = (d: string, ...a: string[]) => execFileSync('git', ['-C', d, ...a], { stdio: 'ignore' });

function makePlain(base: string) {
  const d = j(base, 'plain');
  fs.mkdirSync(d);
  // FR-EDT-58: dot 파일·dot 폴더도 전부 보인다. 숨김 규칙이 없다.
  fs.mkdirSync(j(d, '.dotdir'));
  w(j(d, '.dotdir', 'inner.txt'), 'x');
  w(j(d, '.dotfile'), 'x');
  // FR-EDT-61: 대소문자를 무시한 이름 오름차순임을 Bravo/alpha 로 가른다 —
  // 바이트 순서라면 'B' 가 'a' 를 앞선다.
  fs.mkdirSync(j(d, 'Bravo'));
  w(j(d, 'Bravo', 'b.txt'), 'x');
  fs.mkdirSync(j(d, 'alpha'));
  w(j(d, 'alpha', 'a1.txt'), 'x');
  fs.mkdirSync(j(d, 'deep'));
  w(j(d, 'deep', 'never.txt'), 'x');
  w(j(d, 'Zeta.txt'), 'x');
  w(j(d, 'apple.txt'), 'hello\n');
  // FR-EDT-60: 링크는 셋째 종류다. dir 은 Lstat 기준이라 언제나 false 이고
  // 대상 종류는 linkDir 이 알린다.
  fs.symlinkSync(j(d, 'alpha'), j(d, 'dlink'));
  fs.symlinkSync(j(d, 'apple.txt'), j(d, 'flink'));
  return fs.realpathSync(d);
}

/**
 * 색이 붙는 상태를 한 저장소에 모은다 (FR-EDT-71 — 근거는 status 하나다).
 *
 *   a.txt            수정            M
 *   moddir/          수정만          M
 *   mixdir/          수정 + 미추적   신규가 이긴다 (FR-EDT-74)
 *   confdir/         충돌            U 가 이긴다
 *   deldir/          삭제만          색 없음 (삭제는 전파하지 않는다)
 *   newdir/          미추적          ?
 *   stagedir/s2.txt  add 후 수정     XY=AM → unstaged 문자 M (FR-EDT-72)
 *   bulk/            변경 없음       색 없음. 스크롤 보존 검증용 60행
 */
function makeRepo(base: string) {
  const d = j(base, 'repo');
  fs.mkdirSync(d);
  git(d, 'init', '-q', '-b', 'main', '.');
  git(d, 'config', 'user.name', 'Fixture');
  git(d, 'config', 'user.email', 'fixture@example.invalid');
  git(d, 'config', 'commit.gpgsign', 'false');
  for (const dir of ['moddir', 'mixdir', 'deldir', 'confdir', 'bulk']) fs.mkdirSync(j(d, dir));
  w(j(d, 'a.txt'), 'one\n');
  w(j(d, 'moddir', 'm.txt'), 'one\n');
  w(j(d, 'mixdir', 'mm.txt'), 'one\n');
  w(j(d, 'deldir', 'keep.txt'), 'keep\n');
  w(j(d, 'deldir', 'd.txt'), 'gone\n');
  w(j(d, 'confdir', 'c.txt'), 'base\n');
  for (let i = 0; i < 60; i++) w(j(d, 'bulk', 'f' + String(i).padStart(2, '0') + '.txt'), 'x\n');
  git(d, 'add', '-A');
  git(d, 'commit', '-qm', 'base');

  // 충돌은 먼저 만든다 — 워킹 트리가 더러운 상태에서 merge 를 걸면 git 이 거부할
  // 여지가 있다.
  git(d, 'checkout', '-q', '-b', 'side');
  w(j(d, 'confdir', 'c.txt'), 'side\n');
  git(d, 'commit', '-qam', 'side');
  git(d, 'checkout', '-q', 'main');
  w(j(d, 'confdir', 'c.txt'), 'main\n');
  git(d, 'commit', '-qam', 'main');
  try { git(d, 'merge', 'side', '-q') } catch { /* 충돌로 멈추는 것이 목적이다 */ }

  fs.appendFileSync(j(d, 'a.txt'), 'two\n');
  fs.appendFileSync(j(d, 'moddir', 'm.txt'), 'two\n');
  fs.appendFileSync(j(d, 'mixdir', 'mm.txt'), 'two\n');
  w(j(d, 'mixdir', 'nn.txt'), 'new\n');
  fs.rmSync(j(d, 'deldir', 'd.txt'));
  fs.mkdirSync(j(d, 'newdir'));
  w(j(d, 'newdir', 'new.txt'), 'new\n');
  fs.mkdirSync(j(d, 'stagedir'));
  w(j(d, 'stagedir', 's2.txt'), 'a\n');
  git(d, 'add', 'stagedir/s2.txt');
  fs.appendFileSync(j(d, 'stagedir', 's2.txt'), 'b\n');
  return fs.realpathSync(d);
}

test.beforeAll(() => {
  BASE = fs.realpathSync(fs.mkdtempSync(j(os.tmpdir(), 'dm-edx-')));
  PLAIN = makePlain(BASE);
  REPO = makeRepo(BASE);
});
test.afterAll(() => {
  if (BASE) fs.rmSync(BASE, { recursive: true, force: true });
});

// ── 진입 ────────────────────────────────────────────

// Editor 목록은 서버가 권위다 (FR-EDT-20). 행을 만들면 재조정이 창을 만든다
// (FR-EDT-42) — 테스트가 창을 손으로 짓지 않는다.
async function addEditor(request: APIRequestContext, p: string) {
  const r = await request.post('/api/editors/add', { data: { path: p } });
  expect(r.ok(), `editors/add 실패: ${await r.text()}`).toBeTruthy();
}

async function goto(page: Page) {
  await page.context().addInitScript(() => { sessionStorage.setItem('displayMode', 'desktop') });
  await page.goto('/');
  await page.waitForSelector('#area .pn.focused .xterm-helper-textarea', { timeout: 15000 });
  await page.waitForFunction(
    () => !!(window as any).app?._editors && (window as any).app._edWindows().length > 0,
    undefined, { timeout: 15000 });
}

async function openEditor(page: Page, root: string) {
  await page.evaluate((r) => {
    const a = (window as any).app;
    const win = a._edWindows().find((x: any) => x.editor && x.editor.root === r);
    if (!win) throw new Error('Editor 창이 없다: ' + r);
    a.switchWindow(win.id);
  }, root);
  await page.waitForSelector('.ed-win .ed-explorer .ed-tree', { timeout: 10000 });
}

// 루트 하나를 세우고 그 Editor 창을 연다. 첫 행이 보이면 뿌리 조회가 끝난 것이다.
async function enter(page: Page, request: APIRequestContext, root: string) {
  await addEditor(request, root);
  await goto(page);
  await openEditor(page, root);
  await expect(page.locator('.ed-tree .ed-row').first()).toBeVisible({ timeout: 10000 });
}

const rows = (page: Page) => page.locator('.ed-tree .ed-row');
const row = (page: Page, p: string) => page.locator(`.ed-tree .ed-row[data-path="${p}"]`);
const names = (page: Page) =>
  page.evaluate(() => [...document.querySelectorAll('.ed-tree .ed-row')]
    .map((e) => (e as HTMLElement).dataset.path!.split('/').pop()));

// var(--x) 가 실제로 어떤 색으로 풀리는지. 테마가 값을 덮어써도 비교가 성립한다.
const varColor = (page: Page, name: string) =>
  page.evaluate((n) => {
    const d = document.createElement('div');
    d.style.color = `var(${n})`;
    document.body.appendChild(d);
    const c = getComputedStyle(d).color;
    d.remove();
    return c;
  }, name);

const nameColor = (page: Page, p: string) =>
  page.evaluate((sel) => {
    const el = document.querySelector(`.ed-tree .ed-row[data-path="${sel}"] .ed-name`);
    return el ? getComputedStyle(el).color : '';
  }, p);

// 요청 수로만 확인할 수 있는 요구가 셋 있다 (FR-EDT-59·76·78).
function counter(page: Page, pred: (url: string) => boolean) {
  const box = { n: 0 };
  const h = (req: { url(): string }) => { if (pred(req.url())) box.n++ };
  page.on('request', h as never);
  return box;
}

const isList = (u: string) => u.includes('/api/fs/list');
const isStatusOf = (repo: string) => (u: string) =>
  u.includes('/api/git/status') && u.includes(encodeURIComponent(repo));

test.describe('묶음 X — 파일 탐색기 (FR-EDT-57~68)', () => {
  test('X1 (V-EDT-40): dot 파일과 dot 폴더가 보인다', async ({ page, request }) => {
    await enter(page, request, PLAIN);
    await expect(row(page, j(PLAIN, '.dotdir'))).toBeVisible();
    await expect(row(page, j(PLAIN, '.dotfile'))).toBeVisible();
  });

  test('X2 (V-EDT-43): 폴더 먼저, 이름 오름차순(대소문자 무시)', async ({ page, request }) => {
    await enter(page, request, PLAIN);
    // 폴더 넷이 먼저, 그 다음 파일·링크 다섯. `Bravo` 가 `alpha` 뒤인 것이
    // 대소문자 무시의 증거다 (바이트 순서라면 앞선다).
    expect(await names(page)).toEqual([
      '.dotdir', 'alpha', 'Bravo', 'deep',
      '.dotfile', 'apple.txt', 'dlink', 'flink', 'Zeta.txt',
    ]);
  });

  test('X3 (V-EDT-41): 펼칠 때만 그 폴더가 조회된다', async ({ page, request }) => {
    await enter(page, request, PLAIN);
    const c = counter(page, isList);
    // 뿌리는 이미 읽혔다. 여기서부터 세는 것은 펼침이 만드는 조회뿐이다.
    await row(page, j(PLAIN, 'alpha')).click();
    await expect(row(page, j(PLAIN, 'alpha', 'a1.txt'))).toBeVisible();
    expect(c.n).toBe(1);
    // 펼치지 않은 `deep` 은 조회되지 않았다 (FR-EDT-59).
    await expect(row(page, j(PLAIN, 'deep', 'never.txt'))).toHaveCount(0);
    // 접었다 다시 펼치면 캐시를 쓴다 — 갱신 계기는 FR-EDT-67 의 셋뿐이다.
    await row(page, j(PLAIN, 'alpha')).click();
    await expect(row(page, j(PLAIN, 'alpha', 'a1.txt'))).toHaveCount(0);
    await row(page, j(PLAIN, 'alpha')).click();
    await expect(row(page, j(PLAIN, 'alpha', 'a1.txt'))).toBeVisible();
    expect(c.n).toBe(1);
  });

  test('X4 (V-EDT-42): 링크는 펼쳐지지도 열리지도 않고 linkDir 이 응답에 있다', async ({ page, request }) => {
    await enter(page, request, PLAIN);
    const d = await page.evaluate(async (r) => {
      const u = `/api/fs/list?root=${encodeURIComponent(r)}&path=${encodeURIComponent(r)}`;
      return (await fetch(u)).json();
    }, PLAIN);
    const find = (n: string) => d.entries.find((e: { name: string }) => e.name === n);
    expect(find('dlink')).toMatchObject({ dir: false, link: true, linkDir: true });
    expect(find('flink')).toMatchObject({ dir: false, link: true, linkDir: false });
    expect(find('alpha')).toMatchObject({ dir: true, link: false });

    const c = counter(page, isList);
    // 디렉터리 링크: 펼쳐지지 않는다 — 조회조차 나가지 않는다.
    await row(page, j(PLAIN, 'dlink')).click();
    await expect(row(page, j(PLAIN, 'dlink'))).toHaveClass(/sel/);
    expect(await names(page)).toHaveLength(9);
    // 파일 링크: 열리지 않는다.
    await row(page, j(PLAIN, 'flink')).click();
    expect(c.n).toBe(0);
    expect(await editorTabs(page)).toBe(0);
    // 대조군 — 일반 파일은 열린다 (FR-EDT-60 의 셋째 줄).
    await row(page, j(PLAIN, 'apple.txt')).click();
    await expect.poll(() => editorTabs(page)).toBe(1);
  });

  test('X5 (V-EDT-44): 조회 실패가 그 폴더 행에만 남는다', async ({ page, request }) => {
    await enter(page, request, PLAIN);
    // 권한 실패를 디스크로 만들면 실행 사용자에 따라 결과가 갈린다. 여기서 재는
    // 것은 **클라이언트가 실패를 어디에 담는가** 이므로 응답만 세운다.
    const bad = j(PLAIN, 'deep');
    await page.route('**/api/fs/list**', async (route) => {
      const u = new URL(route.request().url());
      if (u.searchParams.get('path') === bad) {
        await route.fulfill({ status: 403, json: { code: 'permission_denied', message: '거부' } });
        return;
      }
      await route.continue();
    });
    await row(page, bad).click();
    await expect(row(page, bad)).toHaveClass(/ed-err/);
    // 트리는 깨지지 않는다 — 형제 행은 그대로다.
    expect(await names(page)).toEqual([
      '.dotdir', 'alpha', 'Bravo', 'deep',
      '.dotfile', 'apple.txt', 'dlink', 'flink', 'Zeta.txt',
    ]);
  });

  test('X6 (V-EDT-45): 잘림을 표시하고 조회는 실패하지 않는다', async ({ page, request }) => {
    await addEditor(request, PLAIN);
    // FS_LIST_MAX 는 10000 이다 — 그 수의 픽스처를 만드는 대신 서버가 이미
    // 계약대로 주는 `truncated` 를 세우고 UI 만 잰다 (FR-EDT-65 / V-EDT-45 의 UI 절반).
    await page.route('**/api/fs/list**', async (route) => {
      const u = new URL(route.request().url());
      await route.fulfill({
        json: {
          path: u.searchParams.get('path'),
          entries: Array.from({ length: 20 }, (_, i) => ({
            name: 'f' + i, dir: false, link: false, linkDir: false,
          })),
          truncated: true,
        },
      });
    });
    await goto(page);
    await openEditor(page, PLAIN);
    await expect(page.locator('.ed-tree .ed-more')).toHaveText('20개 이상 — 잘림');
    await expect(rows(page)).toHaveCount(20);
  });

  test('X7 (V-EDT-46): 폴링이 돌아도 펼침·선택·스크롤이 유지된다', async ({ page, request }) => {
    test.setTimeout(60000);
    await enter(page, request, REPO);
    // 펼침과 선택을 한 번에 만든다. **파일을 고르지 않는다** — 편집기 열기는
    // 아직 root 에디터로 가고(M2 의 폴백, 라우팅은 FR-EDT-95~99 의 것이다) 그러면
    // 활성 창이 바뀌어 여기서 재려는 폴링 자체가 멈춘다 (FR-EDT-76).
    await row(page, j(REPO, 'bulk')).click();
    await expect(row(page, j(REPO, 'bulk', 'f59.txt'))).toHaveCount(1);
    await expect(row(page, j(REPO, 'bulk'))).toHaveClass(/sel/);
    // 두 번의 evaluate 사이에 render 가 끼면 값이 아니라 타이밍을 재게 된다 —
    // 쓰기와 읽기를 한 호출에 둔다.
    const before = 300;
    await expect.poll(() => page.evaluate(() => {
      const t = document.querySelector('.ed-tree')!;
      t.scrollTop = 300;
      return t.scrollTop;
    }), { timeout: 5000 }).toBe(before);
    const el = await page.evaluateHandle(
      (p) => document.querySelector(`.ed-tree .ed-row[data-path="${p}"]`),
      j(REPO, 'bulk', 'f10.txt'));

    const poll = await page.evaluate(() => EDITOR_GIT_POLL_MS);
    const c = counter(page, isStatusOf(REPO));
    await expect.poll(() => c.n, { timeout: poll * 3 + 5000 }).toBeGreaterThanOrEqual(2);

    await expect(row(page, j(REPO, 'bulk', 'f59.txt'))).toHaveCount(1);
    await expect(row(page, j(REPO, 'bulk'))).toHaveClass(/sel/);
    await expect.poll(
      () => page.evaluate(() => document.querySelector('.ed-tree')!.scrollTop),
      { timeout: 5000 }).toBe(before);
    // FR-EDT-68: 값이 그대로면 요소도 그대로여야 한다 — 다시 만들면 hover 와
    // 진행 중인 조작이 함께 사라진다.
    expect(await page.evaluate(
      (e) => e === document.querySelector(`.ed-tree .ed-row[data-path="${(e as HTMLElement).dataset.path}"]`),
      el)).toBe(true);
  });
});

test.describe('묶음 X — 탐색기의 git 색 (FR-EDT-69~78)', () => {
  test('X8 (V-EDT-48): --git-st-add 가 :root 에 있고 Git 패널의 색이 그대로다', async ({ page, request }) => {
    await enter(page, request, PLAIN);
    // 정의 자리는 **하나**다 (FR-EDT-70 / D-4).
    const css = await (await request.get('/style.css')).text();
    expect(css.match(/--git-st-add\s*:/g) || []).toHaveLength(1);
    expect(await page.evaluate(
      () => getComputedStyle(document.documentElement).getPropertyValue('--git-st-add').trim(),
    )).toBe('#9ece6a');
    // Git 패널의 상태문자는 조상이 `.git-files` 였을 때와 같은 색으로 풀린다.
    expect(await page.evaluate(() => {
      const box = document.createElement('div');
      box.className = 'git-files';
      const s = document.createElement('span');
      s.className = 'git-file-st st-new';
      box.appendChild(s);
      document.body.appendChild(box);
      const c = getComputedStyle(s).color;
      box.remove();
      return c;
    })).toBe(await varColor(page, '--git-st-add'));
  });

  test('X9 (V-EDT-47): 루트가 저장소가 아니면 색이 없다', async ({ page, request }) => {
    await addEditor(request, PLAIN);
    await goto(page);
    // 판정은 창을 여는 순간 한 번이므로(FR-EDT-69) 세는 자리가 그 앞이어야 한다.
    const c = counter(page, isStatusOf(PLAIN));
    await openEditor(page, PLAIN);
    await expect(page.locator('.ed-tree .ed-row').first()).toBeVisible({ timeout: 10000 });
    await expect.poll(() => c.n, { timeout: 10000 }).toBe(1);
    await expect(page.locator('.ed-tree .ed-row[data-st]')).toHaveCount(0);
    // 판정은 한 번이다 — 저장소가 아님을 안 뒤로는 다시 묻지 않는다 (FR-EDT-69).
    const seen = c.n;
    const poll = await page.evaluate(() => EDITOR_GIT_POLL_MS);
    await page.waitForTimeout(poll * 2);
    expect(c.n).toBe(seen);
  });

  test('X10 (V-EDT-49·50): 파일의 상태색과 unstaged 우선', async ({ page, request }) => {
    await enter(page, request, REPO);
    await expect(row(page, j(REPO, 'a.txt'))).toHaveAttribute('data-st', 'M', { timeout: 10000 });
    const [green, accent, danger] = await Promise.all([
      varColor(page, '--git-st-add'), varColor(page, '--accent'), varColor(page, '--danger'),
    ]);
    // 수정 = --accent (D-4 로 확정. 노랑 `--attn` 은 부분 스테이지의 색이다)
    expect(await nameColor(page, j(REPO, 'a.txt'))).toBe(accent);
    // 미추적 = 초록
    await row(page, j(REPO, 'newdir')).click();
    const nu = j(REPO, 'newdir', 'new.txt');
    await expect(row(page, nu)).toHaveAttribute('data-st', '?');
    expect(await nameColor(page, nu)).toBe(green);
    // 충돌 = --danger
    await row(page, j(REPO, 'confdir')).click();
    const cf = j(REPO, 'confdir', 'c.txt');
    await expect(row(page, cf)).toHaveAttribute('data-st', 'U');
    expect(await nameColor(page, cf)).toBe(danger);
    // FR-EDT-72: staged(A) + unstaged(M) 은 unstaged 쪽 문자를 쓴다.
    await row(page, j(REPO, 'stagedir')).click();
    const sg = j(REPO, 'stagedir', 's2.txt');
    await expect(row(page, sg)).toHaveAttribute('data-st', 'M');
    // FR-GIT-190 / FR-STC-4: **부분 스테이지는 상태색을 이긴다.** Git 패널이
    // `.git-file.partial` 을 `--attn` 으로 칠하므로 탐색기도 같아야 한다 —
    // 같은 사실을 두 화면이 다른 색으로 말하지 않는다. 문자는 M(unstaged)이고
    // 색만 노랑이다.
    const attn = await varColor(page, '--attn');
    await expect(row(page, sg)).toHaveClass(/st-partial/);
    expect(await nameColor(page, sg)).toBe(attn);
    expect(attn).not.toBe(accent);
    // 대조군 — 부분 스테이지가 아닌 순수 수정은 그대로 --accent 다.
    expect(await nameColor(page, j(REPO, 'a.txt'))).toBe(accent);
    await expect(row(page, j(REPO, 'a.txt'))).not.toHaveClass(/st-partial/);
  });

  test('X11 (V-EDT-51·52·53·54): 폴더의 접어 올림과 우선순위', async ({ page, request }) => {
    await enter(page, request, REPO);
    // FR-EDT-73: 근거가 status 의 경로들이므로 **펼치지 않은** 폴더에도 색이 있다.
    await expect(row(page, j(REPO, 'moddir'))).toHaveAttribute('data-st', 'M', { timeout: 10000 });
    await expect(row(page, j(REPO, 'moddir', 'm.txt'))).toHaveCount(0);
    // FR-EDT-74: 신규(?)가 수정(M)을 이긴다.
    await expect(row(page, j(REPO, 'mixdir'))).toHaveAttribute('data-st', '?');
    // 충돌(U)이 전부를 이긴다.
    await expect(row(page, j(REPO, 'confdir'))).toHaveAttribute('data-st', 'U');
    // 삭제(D)는 전파하지 않는다 — 하위에 삭제만 있는 폴더에는 색이 없다.
    await expect(row(page, j(REPO, 'deldir'))).not.toHaveAttribute('data-st', /./);
    // FR-EDT-75: 변경이 없는 폴더도 색이 없다.
    await expect(row(page, j(REPO, 'bulk'))).not.toHaveAttribute('data-st', /./);
  });

  test('X12 (V-EDT-55): 비활성 Editor 창은 폴링하지 않는다', async ({ page, request }) => {
    test.setTimeout(90000);
    await addEditor(request, REPO);
    await addEditor(request, PLAIN);
    await goto(page);
    // 저장소 창을 한 번 열어 트리를 살려 둔다 — 그래야 "살아 있지만 비활성" 이다.
    await openEditor(page, REPO);
    await expect(row(page, j(REPO, 'a.txt'))).toHaveAttribute('data-st', 'M', { timeout: 10000 });
    await openEditor(page, PLAIN);
    const poll = await page.evaluate(() => EDITOR_GIT_POLL_MS);
    const c = counter(page, isStatusOf(REPO));
    await page.waitForTimeout(poll * 3 + 1000);
    expect(c.n).toBe(0);
  });

  test('X13 (V-EDT-56): 창 활성화와 저장이 즉시 갱신을 부른다', async ({ page, request }) => {
    test.setTimeout(60000);
    await addEditor(request, REPO);
    await addEditor(request, PLAIN);
    await goto(page);
    await openEditor(page, REPO);
    await expect(row(page, j(REPO, 'a.txt'))).toHaveAttribute('data-st', 'M', { timeout: 10000 });
    await openEditor(page, PLAIN);

    const c = counter(page, isStatusOf(REPO));
    // ① 창 활성화
    await openEditor(page, REPO);
    await expect.poll(() => c.n, { timeout: 2000 }).toBeGreaterThanOrEqual(1);
    // 응답이 도착해야 다음 신호가 single-flight 에 막히지 않는다.
    await page.waitForTimeout(500);
    const base = c.n;
    // ② 저장. 진입점은 `FileEditor.save` 가 부르는 `_gitSignal('write')` 하나다
    //    (FR-EDT-78) — 그 자리를 그대로 두드린다.
    await page.evaluate(() => (window as any).app._gitSignal('write'));
    await expect.poll(() => c.n, { timeout: 1000 }).toBeGreaterThan(base);
  });
});

test.describe('묶음 X — 다시 그리기와 실패의 회복 (FR-EDT-66·69)', () => {
  test('X14 (FR-EDT-66): 바깥 render 가 인라인 입력의 포커스·선택을 깨뜨리지 않는다',
    async ({ page, request }) => {
      await enter(page, request, PLAIN);
      // FR-EDT-81 의 인라인 입력. `_rLayout` 은 매 render 마다 `.ed-win` 을
      // 떼었다 붙이므로(renderer.js) 그 순간 입력이 문서에서 떨어진다.
      await page.locator('.ed-head-new-file').click();
      const inp = page.locator('.ed-tree .ed-input');
      await expect(inp).toBeFocused();
      await inp.fill('note.txt');
      // 캐럿을 가운데 두 글자에 놓는다 — 끝에 두면 되돌아왔는지 알 수 없다.
      await page.evaluate(() => {
        (document.querySelector('.ed-input') as HTMLInputElement).setSelectionRange(1, 3);
      });

      // SSE·폴링이 부르는 것과 같은 자리다.
      await page.evaluate(() => (window as any).app.render());

      await expect(inp).toBeFocused();
      expect(await page.evaluate(() => {
        const el = document.querySelector('.ed-input') as HTMLInputElement;
        return [el.value, el.selectionStart, el.selectionEnd];
      })).toEqual(['note.txt', 1, 3]);

      // 그리고 입력은 여전히 살아 있다 — 이어 쳐서 만들 수 있다.
      await page.keyboard.press('Escape');
    });

  test('X15 (FR-EDT-69): 5xx 한 번이 창의 git 색을 영구히 죽이지 않는다',
    async ({ page, request }) => {
      test.setTimeout(60000);
      // 이 루트의 첫 status 만 500 이다. 판정이 아니라 **이번 회차 건너뛰기**여야
      // 하므로 다음 폴링이 색을 입힌다.
      let failed = false;
      await page.route('**/api/git/status**', async (route) => {
        if (!failed && route.request().url().includes(encodeURIComponent(REPO))) {
          failed = true;
          await route.fulfill({ status: 500, json: { code: 'git_failed', message: '일시 장애' } });
          return;
        }
        await route.continue();
      });

      await enter(page, request, REPO);
      expect(failed, '500 을 돌려줄 기회가 없었다').toBe(true);
      const poll = await page.evaluate(() => EDITOR_GIT_POLL_MS);
      await expect(row(page, j(REPO, 'a.txt')))
        .toHaveAttribute('data-st', 'M', { timeout: poll * 3 + 10000 });
      // 판정이 굳지 않았다는 사실 자체도 재둔다 — 색이 늦게 오는 것과 구분된다.
      expect(await page.evaluate(() => {
        const a = (window as any).app;
        return a._edTree(a._aw())._gitOff;
      })).toBe(false);
    });
  test('X16 (FR-EDT-42): 일반 창에 있는 동안 Editor 행을 지워도 그 창의 탐색기가 즉시 거둬진다', async ({ page, request }) => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-ed-reap-'));
    const root = makePlain(base);
    await enter(page, request, root);
    await expect.poll(() => page.evaluate(() => (window as any).app._edTrees?.size || 0)).toBeGreaterThan(0);

    // 일반 창으로 옮긴 뒤 행을 지운다. 회수가 `_edTree`(활성 창 렌더)에만
    // 얹혀 있으면 이 경로에서 트리와 분리된 DOM 이 남는다.
    const before = await page.evaluate(() => {
      const a = (window as any).app;
      const plain = a._plainWindows()[0];
      if (plain) a.switchWindow(plain.id);
      return a._edTrees.size;
    });
    expect(before).toBeGreaterThan(0);

    await page.evaluate(async (r) => { await (window as any).app._edRemove(r) }, fs.realpathSync(root));

    await expect.poll(() => page.evaluate(() => (window as any).app._edTrees.size)).toBeLessThan(before);
  });

});

// 편집기 탭 수. 링크를 눌러도 열리지 않았음을 재는 데 쓴다 (FR-EDT-60).
async function editorTabs(page: Page) {
  return page.evaluate(() => {
    let n = 0;
    const walk = (x: any) => {
      if (!x) return;
      for (const t of x.tabs || []) if (t && t.type === 'editor') n++;
      for (const c of x.children || []) walk(c);
    };
    for (const s of (window as any).app.ws.windows) walk(s.layout);
    return n;
  });
}

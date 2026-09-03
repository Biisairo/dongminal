/**
 * EDITOR_FIND_PANEL_SRS §4 — V-EFP-1~19.
 *
 * 재려는 결함은 이것이다 (그 SRS §2.4): `Mod+F` 를 누르면 Monaco 의 find 위젯이
 * 뜨는데 포커스는 편집기 본문에 남아, **타이핑한 글자가 파일에 삽입됐다.**
 * 검색하려고 누른 키가 문서를 편집한 것이다.
 *
 * 앞선 스펙에는 파일 내 검색의 실제 동작을 재는 검증이 하나도 없었다 (§2.5) —
 * 그것이 이 결함이 살아남은 이유다.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { APIRequestContext, Page } from '@playwright/test';

import { test, expect } from './fixtures';

const j = (...p: string[]) => path.join(...p);
let BASE = '';
let ROOT = '';

// 옵션 셋이 결과를 **갈라** 놓는 본문이어야 한다 — 세 토글이 같은 수를 내면
// 그 검증은 아무것도 재지 않는다.
//
//   needle   (소문자, 낱말)      1행 · 105행
//   Needle   (대문자 N)          2행
//   needleX  (낱말이 아니다)     3행
const LINES = [
  'alpha needle one',      // 1
  'beta Needle two',       // 2
  'gamma needleX three',   // 3
  'delta plain',           // 4
];
// 105행을 화면 밖으로 밀어낸다 (FR-EFP-15 의 스크롤).
const PAD = Array.from({ length: 100 }, (_, i) => `pad line ${i + 5}`);
const BODY = [...LINES, ...PAD, 'omega needle last', ''].join('\n');
const NEEDLE_LINE_LAST = LINES.length + PAD.length + 1; // 105

test.beforeAll(() => {
  BASE = fs.realpathSync(fs.mkdtempSync(j(os.tmpdir(), 'dm-efp-')));
  ROOT = j(BASE, 'root');
  fs.mkdirSync(ROOT, { recursive: true });
  fs.writeFileSync(j(ROOT, 'find.txt'), BODY);
  fs.writeFileSync(j(ROOT, 'other.txt'), 'needle elsewhere\n');
  // FR-EFP-13: 편집기가 서지 않는 탭. 1x1 PNG.
  fs.writeFileSync(j(ROOT, 'pic.png'), Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
    'base64'));
  ROOT = fs.realpathSync(ROOT);
});
test.afterAll(() => {
  if (BASE) fs.rmSync(BASE, { recursive: true, force: true });
});

async function enter(page: Page, request: APIRequestContext) {
  const r = await request.post('/api/editors/add', { data: { path: ROOT } });
  expect(r.ok(), `editors/add 실패: ${await r.text()}`).toBeTruthy();
  await page.context().addInitScript(() => { sessionStorage.setItem('displayMode', 'desktop') });
  // FR-EFP-23: 옵션은 기기별로 남는다 — 앞선 스펙이 켠 토글이 따라오면
  // 뒤의 스펙이 자기 전제를 잃는다.
  await page.context().addInitScript(() => { try { localStorage.removeItem('edFindOpts') } catch { /* 사생활 모드 */ } });
  await page.goto('/');
  await page.waitForSelector('#area .pn.focused .xterm-helper-textarea', { timeout: 15000 });
  await page.waitForFunction(
    () => !!(window as any).app?._editors && (window as any).app._edWindows().length > 0,
    undefined, { timeout: 15000 });
  await page.evaluate((root) => {
    const a = (window as any).app;
    const win = a._edWindows().find((x: any) => x.editor && x.editor.root === root);
    if (!win) throw new Error('Editor 창이 없다: ' + root);
    a.switchWindow(win.id);
  }, ROOT);
  await expect(page.locator('.ed-tree .ed-row').first()).toBeVisible({ timeout: 10000 });
}

// 파일을 열고 그 탭의 Monaco 가 실제로 설 때까지 기다린다.
//
// `.monaco-editor` 를 세지 않는 이유는 **탭마다 하나가 남기 때문이다** — 두 번째
// 탭을 열면 첫 편집기는 숨겨진 채 DOM 에 남고, `.first()` 는 그 숨은 것을 잡는다.
// 기다릴 대상은 "지금 활성인 편집기가 이 파일이고 화면에 있다" 는 사실이다.
async function openFile(page: Page, name: string) {
  await page.evaluate((p) => (window as any).app._edOpenFile(p), `${ROOT}/${name}`);
  await page.waitForFunction((n) => {
    const v = (window as any).app._edActiveEditor();
    return !!(v && v._editor && String(v.filePath).endsWith('/' + n) && v.el.offsetParent !== null);
  }, name, { timeout: 20000 });
}

// 사용자가 코드를 클릭한 상태 — 결함이 나던 그 자리다.
//
// **보이는** 편집기로 스코프한다. 탭을 둘 열면 숨은 편집기가 DOM 에 남고,
// 스코프 없는 `.first()` 는 그것을 클릭하려다 멎는다 (`openFile` 과 같은 함정).
async function focusBody(page: Page) {
  await page.locator('.file-editor:visible .monaco-editor .view-lines').first().click();
  await page.waitForFunction(
    () => !!document.activeElement?.closest('.monaco-editor'), undefined, { timeout: 5000 });
}

// **보이는** 패널을 가리킨다. 탭을 떠난 패널은 `vis` 를 유지한 채 숨은 편집기
// 안에 남는다 — 돌아오면 그 질의가 그대로 있어야 하기 때문이다 (FR-EFP-8).
// 그래서 `.fe-find.vis` 만으로는 탭이 둘일 때 둘을 함께 집는다.
const findPanel = (page: Page) => page.locator('.fe-find.vis:visible');
const q = (page: Page) => page.locator('.fe-find.vis:visible .fe-find-q');
const count = (page: Page) => page.locator('.fe-find.vis:visible .fe-find-count');
const opt = (page: Page, k: string) =>
  page.locator(`.fe-find.vis:visible .fe-find-opt[data-opt="${k}"]`);

// Monaco 자신의 위젯. 이것이 뜨면 이번 작업이 실패한 것이다 (FR-EFP-4).
const monacoWidget = (page: Page) => page.locator('.monaco-editor .find-widget.visible');

const docText = (page: Page) => page.evaluate(
  () => (window as any).app._edActiveEditor()?._editor?.getModel()?.getValue() ?? '');

async function openFind(page: Page) {
  await page.keyboard.press('Control+f');
  await expect(findPanel(page)).toBeVisible({ timeout: 5000 });
}

test.describe('편집기 파일 내 찾기 패널', () => {
  // V-EFP-1 · FR-EFP-1·2·4
  test('Mod+F 에 Monaco 위젯이 아니라 우리 패널이 뜬다', async ({ page, request }) => {
    await enter(page, request);
    await openFile(page, 'find.txt');
    await focusBody(page);

    await openFind(page);
    await expect(monacoWidget(page), 'Monaco find 위젯이 떴다').toHaveCount(0);
    await expect(q(page)).toBeFocused();
  });

  // V-EFP-2 — 이 결함이 접수한 요구의 정체다 (§2.4).
  test('찾기 중 타이핑이 문서를 바꾸지 않는다', async ({ page, request }) => {
    await enter(page, request);
    await openFile(page, 'find.txt');
    await focusBody(page);
    const before = await docText(page);

    await openFind(page);
    await page.keyboard.type('needle');
    await page.waitForTimeout(400);

    expect(await docText(page), '검색어가 문서에 삽입됐다').toBe(before);
  });

  // V-EFP-3 · FR-EFP-7·16
  test('타이핑이 질의 칸에 들어가고 일치 수가 나온다', async ({ page, request }) => {
    await enter(page, request);
    await openFile(page, 'find.txt');
    await focusBody(page);
    await openFind(page);

    // 질의가 비어 있으면 수를 말하지 않는다 — 아직 묻지 않은 것이다.
    await expect(count(page)).toHaveText('');

    await page.keyboard.type('needle');
    await expect(q(page)).toHaveValue('needle');
    // 대소문자 무시가 기본 — needle · Needle · needleX · needle = 4건.
    await expect(count(page)).toHaveText('1/4', { timeout: 5000 });
  });

  // V-EFP-4 · FR-EFP-4 — 길을 하나만 닫으면 나머지로 들어온다 (§2.6).
  test('Mod+H · Mod+E · F3 로도 Monaco 위젯이 뜨지 않는다', async ({ page, request }) => {
    await enter(page, request);
    await openFile(page, 'find.txt');

    for (const key of ['Control+h', 'Control+e', 'F3', 'Control+g']) {
      await focusBody(page);
      await page.keyboard.press(key);
      await page.waitForTimeout(300);
      await expect(monacoWidget(page), `${key} 로 위젯이 떴다`).toHaveCount(0);
      await page.keyboard.press('Escape');
    }
  });

  // V-EFP-5 · FR-EFP-3 — 가로채기가 넘긴 키는 편집기가 그대로 받아야 한다.
  test('검색 키가 아닌 입력은 편집기가 그대로 받는다', async ({ page, request }) => {
    await enter(page, request);
    await openFile(page, 'find.txt');
    await focusBody(page);
    const before = await docText(page);

    await page.keyboard.type('ZZ');
    await page.waitForTimeout(300);
    expect(await docText(page), '편집기가 글자를 받지 못했다').not.toBe(before);
    expect(await docText(page)).toContain('ZZ');
  });

  // V-EFP-6 · FR-EFP-11·19
  test('Enter 와 Shift+Enter 가 일치를 앞뒤로 옮기고 끝에서 감긴다', async ({ page, request }) => {
    await enter(page, request);
    await openFile(page, 'find.txt');
    await focusBody(page);
    await openFind(page);
    await page.keyboard.type('needle');
    await expect(count(page)).toHaveText('1/4', { timeout: 5000 });

    await page.keyboard.press('Enter');
    await expect(count(page)).toHaveText('2/4');
    await page.keyboard.press('Shift+Enter');
    await expect(count(page)).toHaveText('1/4');
    // 처음의 이전은 마지막이다.
    await page.keyboard.press('Shift+Enter');
    await expect(count(page)).toHaveText('4/4');
    // 마지막의 다음은 처음이다.
    await page.keyboard.press('Enter');
    await expect(count(page)).toHaveText('1/4');
  });

  // V-EFP-7 · FR-EFP-14 — 둘이 같으면 무엇이 옮겨졌는지 보이지 않는다.
  test('현재 일치와 나머지 일치가 다른 표시를 받는다', async ({ page, request }) => {
    await enter(page, request);
    await openFile(page, 'find.txt');
    await focusBody(page);
    await openFind(page);
    await page.keyboard.type('needle');
    await expect(count(page)).toHaveText('1/4', { timeout: 5000 });

    await expect(page.locator('.monaco-editor .fe-find-hit').first()).toBeVisible({ timeout: 5000 });
    await expect(page.locator('.monaco-editor .fe-find-hit-cur')).toHaveCount(1);
  });

  // V-EFP-8 · FR-EFP-15
  test('화면 밖 일치로 옮기면 스크롤이 따라온다', async ({ page, request }) => {
    await enter(page, request);
    await openFile(page, 'find.txt');
    await focusBody(page);
    await openFind(page);
    await page.keyboard.type('needle');
    await expect(count(page)).toHaveText('1/4', { timeout: 5000 });

    // 마지막 일치는 105행 — 처음 화면에 없다.
    await page.keyboard.press('Shift+Enter');
    await expect(count(page)).toHaveText('4/4');
    // `smoothScrolling` 이 켜져 있어 스크롤은 애니메이션이다 — 도착을 기다린다.
    await page.waitForFunction((ln) => {
      const ed = (window as any).app._edActiveEditor()._editor;
      return ed.getVisibleRanges().some(
        (x: any) => x.startLineNumber <= ln && ln <= x.endLineNumber);
    }, NEEDLE_LINE_LAST, { timeout: 5000 });
  });

  // V-EFP-9 · FR-EFP-10·18
  test('Escape 로 닫히고 포커스가 편집기로 돌아가며 하이라이트가 걷힌다', async ({ page, request }) => {
    await enter(page, request);
    await openFile(page, 'find.txt');
    await focusBody(page);
    await openFind(page);
    await page.keyboard.type('needle');
    await expect(page.locator('.monaco-editor .fe-find-hit').first()).toBeVisible({ timeout: 5000 });

    await page.keyboard.press('Escape');
    await expect(findPanel(page)).toBeHidden();
    await expect(page.locator('.monaco-editor .fe-find-hit')).toHaveCount(0);
    expect(await page.evaluate(() => !!document.activeElement?.closest('.monaco-editor')),
      '포커스가 편집기로 돌아오지 않았다').toBe(true);
  });

  // V-EFP-10 · FR-EFP-9
  test('선택 영역이 질의로 실린다', async ({ page, request }) => {
    await enter(page, request);
    await openFile(page, 'find.txt');
    await focusBody(page);
    // 1행의 `needle` 을 고른다 (7~13열).
    await page.evaluate(() => {
      const ed = (window as any).app._edActiveEditor()._editor;
      ed.setSelection({ startLineNumber: 1, startColumn: 7, endLineNumber: 1, endColumn: 13 });
      ed.focus();
    });

    await openFind(page);
    await expect(q(page)).toHaveValue('needle');
    // 전체 선택돼 있어야 바로 다른 말로 갈아 칠 수 있다.
    expect(await page.evaluate(() => {
      const i = document.querySelector('.fe-find.vis .fe-find-q') as HTMLInputElement;
      return i.selectionStart === 0 && i.selectionEnd === i.value.length;
    })).toBe(true);
  });

  // V-EFP-11 · FR-EFP-12
  test('열려 있을 때 같은 키를 다시 누르면 닫히지 않고 질의 칸을 다시 고른다', async ({ page, request }) => {
    await enter(page, request);
    await openFile(page, 'find.txt');
    await focusBody(page);
    await openFind(page);
    await page.keyboard.type('needle');
    await expect(q(page)).toHaveValue('needle');

    await page.keyboard.press('Control+f');
    await expect(findPanel(page), '같은 키가 패널을 닫았다').toBeVisible();
    await expect(q(page)).toBeFocused();
    // 다시 골라 놓았으므로 한 번의 타이핑이 질의를 갈아 치운다.
    await page.keyboard.type('delta');
    await expect(q(page)).toHaveValue('delta');
  });

  // V-EFP-12 · FR-EFP-20·21·22 — 셋이 각각 결과를 갈라야 한다.
  test('대소문자 · 정규식 · 단어 단위가 결과를 바꾼다', async ({ page, request }) => {
    await enter(page, request);
    await openFile(page, 'find.txt');
    await focusBody(page);
    await openFind(page);
    await page.keyboard.type('needle');
    await expect(count(page)).toHaveText('1/4', { timeout: 5000 });

    // 대소문자 구분 — `Needle`(2행)이 빠진다.
    await opt(page, 'case').click();
    await expect(count(page)).toHaveText('1/3', { timeout: 5000 });
    await opt(page, 'case').click();
    await expect(count(page)).toHaveText('1/4');

    // 단어 단위 — `needleX`(3행)가 빠진다.
    await opt(page, 'word').click();
    await expect(count(page)).toHaveText('1/3', { timeout: 5000 });
    await opt(page, 'word').click();
    await expect(count(page)).toHaveText('1/4');

    // 정규식 — `needle` 뒤에 낱말 글자가 붙은 것만: `needleX` 하나.
    await opt(page, 'regex').click();
    await q(page).fill('needle\\w');
    await expect(count(page)).toHaveText('1/1', { timeout: 5000 });
  });

  // V-EFP-13 · FR-EFP-23
  test('옵션은 다시 열 때까지 남는다', async ({ page, request }) => {
    await enter(page, request);
    await openFile(page, 'find.txt');
    await focusBody(page);
    await openFind(page);
    await opt(page, 'case').click();
    await expect(opt(page, 'case')).toHaveClass(/\bon\b/);
    await page.keyboard.press('Escape');

    await focusBody(page);
    await openFind(page);
    await expect(opt(page, 'case'), '켜 둔 옵션이 사라졌다').toHaveClass(/\bon\b/);
  });

  // V-EFP-14 · FR-EFP-24 — 조용히 0건이면 사용자가 없는 줄로 읽는다.
  test('잘못된 정규식은 그 사실로 보인다', async ({ page, request }) => {
    await enter(page, request);
    await openFile(page, 'find.txt');
    await focusBody(page);
    await openFind(page);
    await opt(page, 'regex').click();
    await q(page).fill('needle(');

    await expect(findPanel(page)).toHaveClass(/\bbad-re\b/, { timeout: 5000 });
    await expect(count(page)).not.toHaveText('1/0');
    await expect(page.locator('.monaco-editor .fe-find-hit')).toHaveCount(0);
  });

  // V-EFP-15 · FR-EFP-17 — 낡은 하이라이트가 남으면 그것이 거짓말이 된다.
  test('문서를 고치면 일치 수가 따라 바뀐다', async ({ page, request }) => {
    await enter(page, request);
    await openFile(page, 'find.txt');
    await focusBody(page);
    await openFind(page);
    await page.keyboard.type('needle');
    await expect(count(page)).toHaveText('1/4', { timeout: 5000 });

    // 편집기에 한 건을 더 넣는다 — 패널을 거치지 않고 모델을 직접 고친다.
    await page.evaluate(() => {
      const ed = (window as any).app._edActiveEditor()._editor;
      const m = ed.getModel();
      m.applyEdits([{
        range: { startLineNumber: 4, startColumn: 1, endLineNumber: 4, endColumn: 1 },
        text: 'needle added\n',
      }]);
    });
    await expect(count(page)).toHaveText(/\/5$/, { timeout: 5000 });
  });

  // V-EFP-16 · FR-EFP-8 — 패널은 **편집기 인스턴스마다** 하나다 (D-3).
  //
  // 분할 칸으로 재지 않는 이유는 FR-EDT-50·51 이다: Editor 창은 `split()` 을
  // 무시하고 분할은 드래그드롭으로만 생긴다. 인스턴스 둘을 얻는 실제 경로는
  // **탭 둘**이며, 그것이 이 요구가 걸리는 흔한 자리이기도 하다.
  test('탭마다 질의가 따로 남고 섞이지 않는다', async ({ page, request }) => {
    await enter(page, request);
    await openFile(page, 'find.txt');
    await focusBody(page);
    await openFind(page);
    await page.keyboard.type('needle');
    await expect(q(page)).toHaveValue('needle');
    await expect(count(page)).toHaveText('1/4', { timeout: 5000 });

    // 다른 파일 탭으로 옮겨 연다 — 앞 탭의 질의가 따라오지 않는다.
    await openFile(page, 'other.txt');
    await focusBody(page);
    await openFind(page);
    await expect(q(page)).toHaveValue('');
    // 열려 **보이는** 패널은 지금 탭의 것 하나다.
    await expect(page.locator('.fe-find.vis:visible')).toHaveCount(1);

    // 돌아오면 그 탭의 질의가 그대로 있다 — 패널이 인스턴스의 것이라는 증거다.
    await openFile(page, 'find.txt');
    await focusBody(page);
    await openFind(page);
    await expect(q(page)).toHaveValue('needle');
  });

  // V-EFP-21 · FR-EFP-4b / D-5b — 무효화가 **이 편집기에만** 걸린다.
  //
  // Git 의 diff 뷰도 Monaco 이고 그 뷰에는 우리 패널이 없다 (SRS §2.11). 전역
  // 규칙으로 막으면 거기서 되던 것을 아무것도 되지 않게 만든다 — 되던 것을
  // 조용히 없애지 않는다.
  test('무효화는 이 편집기에만 걸린다 — 다른 Monaco 는 자기 위젯을 갖는다', async ({ page, request }) => {
    await enter(page, request);
    await openFile(page, 'find.txt');
    await focusBody(page);
    // 우리 편집기에서는 닫혀 있다.
    await page.keyboard.press('Control+h');
    await page.waitForTimeout(300);
    await expect(monacoWidget(page)).toHaveCount(0);

    // 같은 페이지에 새로 세운 Monaco 는 그 규칙에 걸리지 않는다 — 전역으로
    // 걸었다면 이 에디터의 위젯도 함께 죽는다.
    const opened = await page.evaluate(async () => {
      const host = document.createElement('div');
      host.style.cssText = 'position:fixed;left:0;bottom:0;width:300px;height:120px;z-index:5';
      host.id = 'probe-monaco';
      document.body.appendChild(host);
      const ed = (window as any).monaco.editor.create(host, { value: 'needle probe\n' });
      ed.focus();
      ed.trigger('probe', 'actions.find', null);
      await new Promise((r) => setTimeout(r, 300));
      const on = !!host.querySelector('.find-widget.visible');
      ed.dispose();
      host.remove();
      return on;
    });
    expect(opened, '다른 Monaco 의 find 위젯까지 죽었다 (전역 규칙을 걸었다)').toBe(true);
  });

  // V-EFP-17 · FR-EFP-13 — 편집기가 없으면 열지도, 삼키지도 않는다.
  test('편집기가 없는 탭에서는 키를 삼키지 않는다', async ({ page, request }) => {
    await enter(page, request);
    await openFile(page, 'find.txt');
    // 이미지 탭으로 옮긴다 — Monaco 가 서지 않는다 (FR-EVW-4).
    await page.evaluate((p) => (window as any).app._edOpenFile(p), `${ROOT}/pic.png`);
    await expect(page.locator('.fe-image .fe-img')).toBeVisible({ timeout: 20000 });

    await page.keyboard.press('Control+f');
    await page.waitForTimeout(400);
    await expect(page.locator('.fe-find.vis:visible')).toHaveCount(0);
    await expect(monacoWidget(page)).toHaveCount(0);
  });
});

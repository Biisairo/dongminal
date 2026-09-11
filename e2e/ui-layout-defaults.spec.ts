import * as fs from 'fs';
import * as path from 'path';

import { APIRequestContext, Page } from '@playwright/test';

import { test, expect, makeCopyFx, openGit as fxOpenGit, waitForInit, clickGitView,
  GIT_BODY_VIEWS, gitFixture, cleanGitFixture, switchToEditorRoot, openExplorerSide } from './fixtures';
import { tmpPath, TMP, realPath } from './osenv';

// UI_LAYOUT_DEFAULTS_SRS §5 — 검증 V-LAY-1~33.
//
// **성공 판정은 "아무것도 달라지지 않는 것" 이다.** 이 저장소에 시각 회귀 기준선이
// 없으므로 **계산값 스냅샷**을 쓴다 — 이 변경이 만지는 속성은 넷뿐이므로
// (display·overflow·position·inset) 그 넷과 그것이 만드는 **잘림/스크롤 여부**를
// 떠서 전후를 대조한다. 스크린샷보다 이 변경에 정확하고 결정론적이다.
//
// **상자 기하(픽셀)는 뜨지 않는다.** 첫 판이 그것을 떴다가 회차마다 흔들렸다 —
// 커밋 제목·카운트 배지·검색 입력의 폭이 내용과 폴링 시점에 매인다(4회 중 2회
// 실패). 흔들리는 것은 검증 수단이 아니다.
//
// 기준선은 **변경 전에** 떠서 파일로 커밋한다. 나중에 뜨면 아무것도 검증하지
// 못한다 (§7 의 HIGH 위험 둘째).
//
//   기준선 갱신:  LAYOUT_BASELINE=write npx playwright test ui-layout-defaults
//   대조:         npx playwright test ui-layout-defaults

const FIXTURES = tmpPath('dm-lay-' + process.pid);
const BASELINE = path.join(__dirname, 'baseline', 'ui-layout.json');
const WRITE = process.env.LAYOUT_BASELINE === 'write';

let BASE = '';
let PLAIN = '';

test.beforeAll(() => {
  gitFixture(FIXTURES);
  BASE = realPath(fs.mkdtempSync(path.join(TMP, 'dm-lay-ed-')));
  PLAIN = path.join(BASE, 'plain');
  fs.mkdirSync(path.join(PLAIN, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(PLAIN, 'sub', 'inner.txt'), 'x\n');
  fs.writeFileSync(path.join(PLAIN, 'a.txt'), 'x\n');
  PLAIN = realPath(PLAIN);
});
test.afterAll(() => {
  cleanGitFixture(FIXTURES);
  fs.rmSync(BASE, { recursive: true, force: true });
});

const copyFx = makeCopyFx(FIXTURES);

type Row = Record<string, string | number | boolean>;

/**
 * 화면 하나의 계산값을 뜬다.
 *
 * **선택자로 키를 만든다** — DOM 순서는 폴링·재조정으로 흔들리므로 그것으로
 * 키를 잡으면 대조가 순서에 매인다. 같은 키가 여럿이면 첫 것만 남긴다:
 * 재는 대상이 "이 계열의 요소가 어떤 계산값을 갖는가" 이지 개수가 아니다.
 */
async function snap(page: Page, screen: string): Promise<Record<string, Row>> {
  return page.evaluate((sc) => {
    const out: Record<string, any> = {};
    const key = (el: Element) => {
      const cls = (el as HTMLElement).className;
      const c = typeof cls === 'string' && cls ? '.' + cls.trim().split(/\s+/).sort().join('.') : '';
      /**
       * **`[hidden]` 을 키에 넣는다.** C1 이 식별자를 클래스(`.gone`·`.git-hidden`)
       * 에서 **속성**으로 옮겼고, 키가 클래스로만 만들어지면 숨은 요소와 보이는
       * 요소가 같은 키로 합쳐진다 — 실측에서 27개 키가 그렇게 사라지고 대조가
       * 어긋났다. 속성을 키에 넣으면 그 구분이 유지된다.
       */
      const h = (el as HTMLElement).hidden ? '[hidden]' : '';
      return sc + '|' + el.tagName.toLowerCase() + c + h;
    };
    const SCROLLY = new Set(['auto', 'scroll', 'hidden']);
    for (const el of document.querySelectorAll<HTMLElement>('*')) {
      // xterm 내부는 벤더가 **인라인 스타일로** 정한다 — 헬퍼 textarea 의 위치는
      // 커서를 따라 움직이므로(실측: inset 이 회차마다 다르다) 우리 CSS 의 대상이
      // 아니고 이 스냅샷의 대상도 아니다.
      if (el.closest('.xterm')) continue;
      const k = key(el);
      if (out[k]) continue;
      const cs = getComputedStyle(el);
      /**
       * **내용 독립인 것만 뜬다.** 첫 판은 상자 기하(w·h·scrollH…)를 전부 떴는데
       * 회차마다 흔들렸다 — 커밋 제목·카운트 배지·검색 입력의 폭이 내용과 폴링
       * 시점에 따라 달라진다(실측: 4회 중 2회 실패). 아래 일곱은 **한 번도**
       * 흔들리지 않았다: 계산 결과가 내용에 매이지 않기 때문이다.
       */
      const row: any = {
        display: cs.display,
        overflowX: cs.overflowX,
        overflowY: cs.overflowY,
        position: cs.position,
        inset: [cs.top, cs.right, cs.bottom, cs.left].join(' '),
        flexDirection: cs.flexDirection,
        minHeight: cs.minHeight,
      };
      /**
       * 기하 대신 **잘림 여부**를 뜬다 — 그것이 U-7·U-8 이 재려는 사실이고
       * (§2.3 의 870px), 픽셀과 달리 내용에 따라 흔들리지 않는다.
       *
       * 스크롤러가 아닌 요소(overflow:visible)는 넘쳐도 보이므로 대상이 아니다.
       */
      if (SCROLLY.has(cs.overflowY) || SCROLLY.has(cs.overflowX)) {
        row.clippedY = el.scrollHeight > el.clientHeight + 1 && cs.overflowY === 'hidden';
        row.clippedX = el.scrollWidth > el.clientWidth + 1 && cs.overflowX === 'hidden';
        row.scrollsY = el.scrollHeight > el.clientHeight + 1 && SCROLLY.has(cs.overflowY) && cs.overflowY !== 'hidden';
      }
      out[k] = row;
    }
    return out;
  }, screen);
}

/** 터미널 화면 · Editor 창 · git 여덟 뷰를 훑는다. */
async function collect(page: Page): Promise<Record<string, Row>> {
  const all: Record<string, Row> = {};
  const merge = (o: Record<string, Row>) => { for (const k of Object.keys(o)) if (!all[k]) all[k] = o[k] };

  await page.waitForSelector('#area .pn.focused .xterm-helper-textarea', { timeout: 20000 });
  merge(await snap(page, 'terminal'));

  const repo = copyFx('with-remote', 'lay');
  await fxOpenGit(page, repo);
  // `changes` 는 본문 탭이 아니라 **사이드**다 — `openGit` 이 `_edSetSide` 로
  // 세운다. 그래서 탭 목록(GIT_BODY_VIEWS)에 없고, 여기서 따로 뜬다.
  merge(await snap(page, 'git:changes'));
  for (const v of GIT_BODY_VIEWS) {
    await clickGitView(page, v);
    await page.waitForTimeout(350);
    merge(await snap(page, 'git:' + v));
  }

  await page.evaluate((p) => (window as any).fetch('/api/editors/add', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: p }),
  }), PLAIN);
  await switchToEditorRoot(page, PLAIN);
  await openExplorerSide(page);
  await expect(page.locator('.ed-tree .ed-row').first()).toBeVisible({ timeout: 15000 });
  merge(await snap(page, 'editor'));

  return all;
}

/**
 * **기준선은 기본 설정에서 떴다 — 그 전제를 스스로 세운다.**
 *
 * 설정은 **서버에 저장되고 워커를 넘어 남는다.** 같은 워커에서 앞서 돈 스펙이
 * 그것을 바꿔 두면 이 검사는 다른 화면을 재게 된다 — `tab-width` 가
 * `tabFixedWidth` 를 저장하면 `body.tabfix` 가 켜지고, 그러면
 * `.pn-tab-label` 의 `overflow` 가 `visible`→`hidden` 이 된다 (실측 18자리,
 * 2026-09-11). 전량 실행에서만 빨갛던 이유가 부하가 아니라 **이 순서**였다.
 *
 * `PUT /api/settings` 는 **전체 교체**이므로(`apiSettingsPut`) 현재 값을 받아
 * 한 자리만 바꿔 되돌린다 — 다른 설정을 이 검사가 지우면 다음 스펙이 같은 함정에
 * 빠진다.
 */
async function resetToDefaults(request: APIRequestContext) {
  const r = await request.get('/api/settings');
  const cur = r.ok() ? await r.json().catch(() => ({})) : {};
  await request.put('/api/settings', { data: { ...cur, tabFixedWidth: false } });
}

test('V-LAY-1 (FR-LAY-50): 계산값이 기준선과 같다', async ({ page, request }) => {
  test.setTimeout(180000);
  await resetToDefaults(request);
  await waitForInit(page, { mode: 'desktop', viewport: { width: 1280, height: 720 } });
  const now = await collect(page);

  if (WRITE) {
    fs.mkdirSync(path.dirname(BASELINE), { recursive: true });
    fs.writeFileSync(BASELINE, JSON.stringify(now, null, 1) + '\n');
    console.log(`기준선을 썼다: ${Object.keys(now).length} 자리 → ${BASELINE}`);
    return;
  }

  expect(fs.existsSync(BASELINE),
    '기준선이 없다 — LAYOUT_BASELINE=write 로 먼저 떠라 (§8 의 1단계)').toBe(true);
  const base = JSON.parse(fs.readFileSync(BASELINE, 'utf8')) as Record<string, Row>;

  /**
   * FR-LAY-51: **달라져야 하는 자리를 명시한다.** "전부 같다" 로 뭉개면 결함
   * 수정이 회귀와 구별되지 않는다. 아래 셋 말고 달라지면 그것이 회귀다.
   */
  const EXPECTED_DIFF = [
    // §2.3 의 결함 수정 — 두 뷰가 `display:block` 으로 계산되던 것이 `flex` 가
    // 된다 (FR-LAY-22). **그 자손도 함께 달라진다**: `min-height:auto` 는 flex
    // 항목에서 `auto` 로 남고 블록 항목에서 `0` 으로 계산되므로, 부모가 flex 가
    // 되는 순간 자손의 `minHeight` 가 `0px`→`auto` 로 바뀐다. 별개의 회귀가
    // 아니라 `display` 수정의 직접 귀결이다.
    'git-worktrees', 'git-wt-',
    'git-submodules', 'git-sub-',
    // U-7 의 수정 — 스크롤 소유권이 바깥에서 안쪽 목록으로 옮겨진다 (FR-LAY-24).
    'git-blame',
  ];

  const diffs: string[] = [];
  for (const k of Object.keys(base)) {
    if (EXPECTED_DIFF.some((e) => k.includes(e))) continue;
    const a = base[k], b = now[k];
    /**
     * **양쪽에 있는 키만 대조한다.** 조건부로 뜨는 요소(`git-con-note` 같은
     * 안내줄)의 유무는 회차마다 다르고, 그것은 레이아웃 회귀가 아니다 —
     * 요소가 **있는가**는 다른 스펙 300여 건이 이미 단정한다. 이 스냅샷이 재는
     * 것은 "그 요소의 계산값이 달라졌는가" 하나다.
     */
    if (!b) continue;
    for (const p of Object.keys(a)) {
      if (String(a[p]) !== String(b[p])) diffs.push(`${k} :: ${p} ${a[p]} → ${b[p]}`);
    }
  }
  expect(diffs, `계산값이 달라진 자리 ${diffs.length}개:\n` + diffs.slice(0, 40).join('\n')).toEqual([]);
});

test('V-LAY-2 · V-LAY-12 (FR-LAY-20·22): 여덟 뷰가 전부 같은 기본을 쓴다',
  async ({ page }) => {
    test.setTimeout(120000);
    await waitForInit(page, { mode: 'desktop', viewport: { width: 1280, height: 720 } });
    await page.waitForSelector('#area .pn.focused .xterm-helper-textarea', { timeout: 20000 });
    const repo = copyFx('with-remote', 'lay2');
    await fxOpenGit(page, repo);

    const check = async (view: string) => {
      const r = await page.evaluate((v) => {
        const el = document.querySelector('.git-view.git-' + v) as HTMLElement;
        if (!el) return null;
        const c = getComputedStyle(el);
        return { display: c.display, flexDirection: c.flexDirection, overflowY: c.overflowY };
      }, view);
      expect(r, `${view} 뷰가 없다`).not.toBeNull();
      // 하나도 예외가 없다 — 그것이 이 검증의 전부다.
      expect(r, view).toEqual({ display: 'flex', flexDirection: 'column', overflowY: 'hidden' });
    };

    await check('changes');
    for (const v of GIT_BODY_VIEWS) {
      await clickGitView(page, v);
      await check(v);
    }
  });

test('V-LAY-10·11 (FR-LAY-22): 목록이 길어져도 잘리지 않는다', async ({ page }) => {
  test.setTimeout(120000);
  await waitForInit(page, { mode: 'desktop', viewport: { width: 1280, height: 720 } });
  await page.waitForSelector('#area .pn.focused .xterm-helper-textarea', { timeout: 20000 });
  const repo = copyFx('with-remote', 'lay3');
  await fxOpenGit(page, repo);

  for (const [view, prefix] of [['worktrees', 'wt'], ['submodules', 'sub']] as const) {
    await clickGitView(page, view);
    const r = await page.evaluate(({ v, p }) => {
      const el = document.querySelector('.git-view.git-' + v) as HTMLElement;
      const list = el.querySelector('.git-' + p + '-list') as HTMLElement;
      // 행 60개는 634px 상자를 반드시 넘긴다 — 픽스처의 항목 수로는 넘칠 일이 없어
      // 이 결함이 e2e 를 통과하고 있었다 (§2.3).
      for (let i = 0; i < 60; i++) {
        const d = document.createElement('div');
        d.style.height = '24px'; d.textContent = 'row ' + i;
        list.appendChild(d);
      }
      return {
        viewClipped: el.scrollHeight > el.clientHeight + 1,
        listScrolls: list.scrollHeight > list.clientHeight + 1,
      };
    }, { v: view, p: prefix });

    // 뷰는 넘치지 않고(잘릴 것이 없다), 목록이 자기 스크롤러가 된다.
    expect(r.viewClipped, `${view}: 뷰가 넘쳐 잘린다`).toBe(false);
    expect(r.listScrolls, `${view}: 목록이 자기 스크롤러가 아니다`).toBe(true);
  }
});

test('V-LAY-13 (FR-LAY-24 / U-7): blame 의 스크롤 소유권이 다른 뷰와 같다',
  async ({ page }) => {
    test.setTimeout(120000);
    await waitForInit(page, { mode: 'desktop', viewport: { width: 1280, height: 720 } });
    await page.waitForSelector('#area .pn.focused .xterm-helper-textarea', { timeout: 20000 });
    const repo = copyFx('with-remote', 'lay4');
    await fxOpenGit(page, repo);
    await clickGitView(page, 'diff');

    const r = await page.evaluate(() => {
      const box = document.querySelector('.git-blame') as HTMLElement;
      const rows = document.querySelector('.git-blame-rows') as HTMLElement;
      if (!box || !rows) return null;
      return {
        outer: getComputedStyle(box).overflowY,
        inner: getComputedStyle(rows).overflowY,
        innerMinHeight: getComputedStyle(rows).minHeight,
      };
    });
    expect(r, 'blame 의 골격이 없다').not.toBeNull();
    // 바깥은 구르지 않고 안쪽 목록만 구른다 — 나머지 일곱 뷰와 같은 형태다.
    expect(r!.outer).toBe('hidden');
    expect(r!.inner).toBe('auto');
    expect(r!.innerMinHeight).toBe('0px');
  });

/**
 * V-LAY-20~22 — C1 의 증명은 **스냅샷이 아니다.**
 *
 * C1 이 식별자를 클래스에서 속성으로 옮겼으므로 클래스로 만든 키가 합쳐진다
 * (그래서 이 단계에서 기준선을 다시 떴다). "아무것도 달라지지 않았다" 는 아래
 * 직접 검증과 회귀 넷이 답한다 — 네 종의 display 가 `hidden` 으로 정확히
 * 꺼지고 켜지는가, 그리고 옮긴 네 자리가 여전히 제 일을 하는가.
 */
test('V-LAY-20 (FR-LAY-1): [hidden] 이 네 종의 display 를 모두 이긴다', async ({ page }) => {
  await waitForInit(page, { mode: 'desktop', viewport: { width: 1280, height: 720 } });

  const r = await page.evaluate(() => {
    const out: Record<string, string[]> = {};
    for (const d of ['flex', 'block', 'inline-block', 'inline']) {
      const el = document.createElement('div');
      // 작성자 규칙으로 display 를 준다 — `[hidden]` 의 UA 기본이 지는 그 조건이다.
      el.style.setProperty('display', d);
      document.body.appendChild(el);
      const on = getComputedStyle(el).display;
      el.hidden = true;
      const off = getComputedStyle(el).display;
      el.hidden = false;
      const back = getComputedStyle(el).display;
      el.remove();
      out[d] = [on, off, back];
    }
    return out;
  });

  for (const d of ['flex', 'block', 'inline-block', 'inline']) {
    // 켜짐 → 꺼짐 → 되돌아옴. 되돌아오는 것이 요점이다 — `.vis` 규약이 켤 때의
    // 값을 CSS 에 다시 적어야 했던 이유가 그것이었다 (FR-LAY-1).
    expect(r[d], d).toEqual([d, 'none', d]);
  }
});

test('V-LAY-21 (FR-LAY-3): 옮긴 자리가 여전히 꺼지고 켜진다', async ({ page }) => {
  await waitForInit(page, { mode: 'desktop', viewport: { width: 1280, height: 720 } });
  await page.waitForSelector('#area .pn.focused .xterm-helper-textarea', { timeout: 20000 });

  const bar = page.locator('#search-bar');
  const disp = () => page.evaluate(() =>
    getComputedStyle(document.getElementById('search-bar')!).display);

  // 종전 `.hidden` 클래스 자리 — index.html 의 초기 상태도 함께 잰다.
  expect(await disp(), '처음에는 감춰져 있다').toBe('none');
  await page.evaluate(() => (window as any).app.toggleSearch());
  await expect(bar).toBeVisible();
  expect(await disp()).not.toBe('none');
  await page.evaluate(() => (window as any).app.closeSearch());
  expect(await disp()).toBe('none');
});

test('V-LAY-22 (FR-LAY-1b): 모바일에서 hidden 이 .mobile-only 를 이긴다',
  async ({ page }) => {
    test.setTimeout(120000);
    await waitForInit(page, { mode: 'mobile', viewport: { width: 390, height: 640 } });
    const repo = copyFx('with-remote', 'lay5');
    await fxOpenGit(page, repo).catch(() => {});
    await page.waitForTimeout(600);

    // FR-EDT-54: Editor·Git 창에는 새 탭 버튼의 대상이 없다. 종전에는
    // `body.mobile .mtbtn.mobile-only{display:flex!important}`(0-3-0)이
    // 숨김(0-1-0 !important)을 이겨 **아무 일도 하지 않는 버튼이 보였다.**
    const r = await page.evaluate(() => {
      const el = document.getElementById('m-add-tab');
      if (!el) return null;
      return { hidden: el.hidden, display: getComputedStyle(el).display };
    });
    expect(r, 'm-add-tab 이 없다').not.toBeNull();
    if (r!.hidden) expect(r!.display, 'hidden 인데 보인다').toBe('none');
  });

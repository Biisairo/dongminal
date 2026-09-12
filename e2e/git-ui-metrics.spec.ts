/**
 * git 표면의 **치수·라벨·테마** — FR-GIT-195~206.
 *
 * 버튼 높이·입력 높이·라디오의 생김새는 각각 다른 요구처럼 보이지만 **같은 토큰**
 * 을 딛는다. 한 자리에서 함께 재는 이유가 그것이다 — 한쪽이 어긋나면 나머지도
 * 같은 원인일 때가 많고, 흩어 놓으면 그 사실이 보이지 않는다.
 *
 * `TEST-7` 로 `git-ui-revision` 에서 옮겨 왔다.
 */
import { join } from 'path';

import { Page } from '@playwright/test';

import {
  test, expect, openGit, waitForInit, makeCopyFx, gitFixture, cleanGitFixture, clickGitView,
} from './fixtures';
import { tmpPath, realPath } from './osenv';

const GURFX = tmpPath('dm-gur-git-ui-metrics-' + process.pid);
test.beforeAll(() => { gitFixture(GURFX) });
test.afterAll(() => { cleanGitFixture(GURFX) });
const gurFx = (n: string) => realPath(join(GURFX, n));
const gurCopy = makeCopyFx(GURFX);
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

async function gurOpenChanges(page: Page, repo: string) {
  await openGit(page, repo);
  await page.evaluate(() => (window as any).app.gitPanel.openView('changes'));
  await expect(page.locator('#area .ed-side .git-view.git-changes')).toBeVisible({ timeout: 10000 });
}

const gurFiles = (page: Page) => page.locator('#area .ed-side .git-file');

async function gurWaitFiles(page: Page, min = 1) {
  await expect.poll(() => gurFiles(page).count(), { timeout: 20000 }).toBeGreaterThanOrEqual(min);
}

test.describe('UI 개정 — 컨트롤 치수 (FR-GIT-195~199)', () => {
  test('V80 (FR-GIT-195~198): Git 표면의 버튼과 목록 행이 VSCode 하한을 넘는다', async ({ page }) => {
    await waitForInit(page);
    await gurOpenChanges(page, gurFx('basic'));
    await gurWaitFiles(page, 3);
    // 행 인라인 동작은 hover 로만 보인다 — 재려면 하나를 띄운다.
    await gurFiles(page).first().hover();

    // **Git 표면이 둘이 됐다** (REPO_TAB_UNIFY_SRS FR-RTU-11): Changes 는 창의
    // 사이드, 나머지 뷰는 본문의 탭이다. 치수 하한은 표면의 자리와 무관하므로
    // 둘 다 잰다 — 사이드만 재면 뷰 탭의 버튼이 검사를 벗어난다.
    const m = (await measure(page, '#area .ed-win'))!;
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
      [...document.querySelectorAll('#repo-entries .ed-entry')].map(e => Math.round(e.getBoundingClientRect().height)));
    expect(Math.min(...repos)).toBeGreaterThanOrEqual(MIN_ROW);
    expect(side.buttons.filter(b => b.h < MIN_HIT)).toEqual([]);
  });

  test('V103 (FR-GIT-226): 하한이 WINDOWS 목록 행(.si)과 같은 값이다', async ({ page }) => {
    await waitForInit(page);

    // 기준은 VSCode 가 아니라 이 앱 자신의 목록 행이다 — 숫자를 두 곳에 두지
    // 않았다는 증거로, 실제 `.si` 높이와 맞춰 본다.
    //
    // **Git 창에 들어가기 전에 잰다.** 들어가면 사이드바가 `Git` 탭을 따라가므로
    // (FR-SBT-14) WINDOWS 목록이 숨고, 숨은 요소의 사각형은 0 이다.
    const si = await page.evaluate(() => {
      const e = document.querySelector('#windows .si') as HTMLElement | null;
      return e ? Math.round(e.getBoundingClientRect().height) : -1;
    });
    expect(si, 'WINDOWS 행이 없다').toBeGreaterThan(0);

    await gurOpenChanges(page, gurFx('basic'));
    await gurWaitFiles(page, 3);
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
    await clickGitView(page, 'history');
    await expect(page.locator('#area .pn-body .git-hist-row').first())
      .toBeVisible({ timeout: 20000 });
    const rowH = await page.locator('#area .pn-body .git-hist-list')
      .evaluate((el) => parseFloat(getComputedStyle(el).getPropertyValue('--git-row-h')));
    expect(rowH).toBe(si);

    // refs 그룹 머리글은 글자만 든 단순 컨테이너다 — 그 그룹에 값이 없으면
    // 줄어든다. 비어 있는 그룹도 자리를 알아볼 수 있어야 한다.
    const heads = await page.evaluate(() =>
      [...document.querySelectorAll('#area .pn-body .git-refs-head')]
        .map((e) => Math.round((e as HTMLElement).getBoundingClientRect().height)));
    expect(heads.length, 'refs 그룹 머리글이 없다').toBeGreaterThanOrEqual(1);
    expect(Math.min(...heads), '머리글이 하한 아래로 줄었다: ' + JSON.stringify(heads))
      .toBeGreaterThanOrEqual(si);
    // 비어 있는 그룹 자체도 그만큼은 된다.
    const groups = await page.evaluate(() =>
      [...document.querySelectorAll('#area .pn-body .git-refs-group')]
        .map((e) => Math.round((e as HTMLElement).getBoundingClientRect().height)));
    expect(Math.min(...groups), '빈 refs 그룹이 줄었다: ' + JSON.stringify(groups))
      .toBeGreaterThanOrEqual(si);
  });

  test('V81 (FR-GIT-199): 모바일 폭에서도 하한이 지켜진다', async ({ page }) => {
    await waitForInit(page);
    await gurOpenChanges(page, gurFx('basic'));
    await gurWaitFiles(page, 3);
    await page.setViewportSize({ width: 420, height: 800 });
    /**
     * **시간이 아니라 상태로 기다린다** (E2E_QUIESCENCE_SRS I-1).
     *
     * 종전에는 1200ms 를 세고 곧바로 쟀다. 모바일 셸로 갈아타는 일이 그 안에
     * 끝나지 않으면 `#area .pn-body` 가 아직 없고, `measure` 는 null 을 돌려
     * 다음 줄이 `Cannot read properties of null` 로 죽는다 — 간헐로 실제 관측됐다.
     * 재는 것은 "치수가 하한을 넘는가" 이지 "몇 밀리초에 다시 서는가" 가 아니다.
     *
     * `body.mobile` 을 기다리지 않는다 — 420px 는 **좁은 폭**일 뿐 이 앱의 모바일
     * 모드가 켜지는 조건이 아니다 (실측: 그 클래스는 붙지 않는다). 이 검사가
     * 재려는 것도 모바일 모드가 아니라 좁은 폭에서의 치수다.
     */
    await expect(page.locator('#area .pn-body')).toBeVisible();

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
    await gurOpenChanges(page, gurFx('basic'));
    await gurWaitFiles(page, 3);
    await gurFiles(page).first().hover();     // 행 인라인 동작을 띄운다
    await gurFiles(page).first().click();     // 선택 동작 줄을 띄운다

    const hangul = /[가-힣]/;
    // Git 표면은 사이드 + 본문 둘이다 (FR-RTU-11) — V80 과 같은 근거.
    const labels = await page.evaluate(() =>
      [...document.querySelectorAll('#area .ed-win button')]
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
    await openGit(page, gurFx('basic'));
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
    await gurOpenChanges(page, gurFx('with-remote'));
    // Pull 의 `▾` 옵션 다이얼로그가 라디오를 쓴다 (constants.js 의 pull 옵션).
    await page.locator('#area .ed-side .git-remote-more[data-remote="pull"]').click();
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


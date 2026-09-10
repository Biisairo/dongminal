import { test, expect, waitForInit } from './fixtures';

// SRS: PANE_DOM_RECONCILE_SRS.md
//   render 는 레이아웃 DOM 을 다시 짓지 않는다. 살아 있는 위젯이 DOM 에서
//   움직이지 않으므로, 스크롤을 갈무리했다 되돌릴 일 자체가 없어진다.

// 활성 pane 의 터미널을 브라우저 안에서 집어 오는 조각. 여러 검사가 같은 길을
// 쓰므로 한 곳에 둔다 — 경로가 갈리면 어느 pane 을 쟀는지 말할 수 없다.
const PICK = `
  const a = window.app;
  const s = a.ws.windows.find(x => x.id === a.ws.activeWindow);
  const find = (n, id) => {
    if (!n) return null;
    if (n.type === 'pane' && n.id === id) return n;
    if (n.children) for (const c of n.children) { const r = find(c, id); if (r) return r }
    return null;
  };
  const pn = find(s.layout, a.focused);
  const tab = pn.tabs.find(t => t.id === a.paneTab(pn));
  const pane = a.tools.get(tab.toolId);
`;

async function fillScrollback(page: any, lines = 300) {
  await page.evaluate(`(() => {${PICK}
    let payload = '';
    for (let i = 1; i <= ${lines}; i++) payload += 'LINE-' + i + '\\r\\n';
    pane.term.write(payload);
    pane.term.scrollToBottom();
  })()`);
  await page.waitForTimeout(120);
}

async function paneState(page: any) {
  return await page.evaluate(`(() => {${PICK}
    const buf = pane.term.buffer.active;
    const vp = pane.el.querySelector('.xterm-viewport');
    return {
      viewportY: buf.viewportY,
      baseY: buf.baseY,
      length: buf.length,
      scrollTop: vp ? vp.scrollTop : -1,
      atBottom: buf.viewportY >= buf.baseY,
    };
  })()`);
}

test.describe('Pane DOM reconcile', () => {
  // TC-PDR-1: TUI 는 출력을 멈추지 않는다. 그 도중에 render 가 끼어들어도
  // 뷰포트는 맨 아래에 붙어 있어야 한다 — 이것이 사용자가 겪은 결함이다.
  test('맨 아래를 보던 터미널은 출력 중 render 가 끼어들어도 맨 아래에 남는다', async ({ page }) => {
    await waitForInit(page, { clearLocalStorage: true });
    await fillScrollback(page);

    // 출력과 render 를 번갈아 낸다. render 는 SSE·포커스·상태 변화로 실제로
    // 이만큼 자주 불린다.
    for (let i = 0; i < 10; i++) {
      await page.evaluate(`(() => {${PICK}
        pane.term.write('TICK-' + ${i} + '\\r\\n');
        window.app.render();
      })()`);
      await page.waitForTimeout(40);
    }
    await page.waitForTimeout(200);

    const st = await paneState(page);
    expect(st.atBottom, `viewportY=${st.viewportY} baseY=${st.baseY}`).toBe(true);
  });

  // TC-PDR-2: 출력이 없으면 보던 자리가 그대로여야 한다(종전 요구의 계승).
  test('중간을 보던 스크롤은 render 뒤에도 그 자리다', async ({ page }) => {
    await waitForInit(page, { clearLocalStorage: true });
    await fillScrollback(page);
    await page.evaluate(`(() => {${PICK} pane.term.scrollLines(-40) })()`);
    await page.waitForTimeout(80);

    const before = await paneState(page);
    await page.evaluate('window.app.render()');
    await page.waitForTimeout(200);
    const after = await paneState(page);

    expect(after.viewportY).toBe(before.viewportY);
  });

  // TC-PDR-4: 같은 노드여야 한다. 이 하나가 참이면 스크롤은 저절로 따라온다.
  test('render 전후로 pane 과 터미널은 같은 DOM 노드다', async ({ page }) => {
    await waitForInit(page, { clearLocalStorage: true });
    const same = await page.evaluate(`(() => {${PICK}
      const pn0 = document.querySelector('#area .pn');
      const tp0 = pane.el;
      const parent0 = tp0.parentNode;
      window.app.render();
      const pn1 = document.querySelector('#area .pn');
      return { pane: pn0 === pn1, term: tp0 === pane.el, parent: parent0 === pane.el.parentNode };
    })()`);
    expect(same).toEqual({ pane: true, term: true, parent: true });
  });

  // TC-PDR-5: 레이아웃이 그대로면 노드를 만들지 않는다 (NFR-PDR-1).
  test('레이아웃이 바뀌지 않은 render 는 골격을 만들지 않는다', async ({ page }) => {
    await waitForInit(page, { clearLocalStorage: true });
    // 살아 있는 위젯 안에서는 노드가 늘 오간다 — xterm 은 화면을 그릴 때마다 행을
    // 다시 만들고, 셸이 프롬프트를 그리거나 커서가 깜빡이는 것만으로도 그렇다.
    // (Windows CI 에서 실측: 그 소음이 이 검사를 깨뜨렸다.)
    //
    // **재려는 것은 골격이다.** NFR-PDR-1 이 말하는 "노드를 만들지 않는다" 는
    // `_rLayout` 이 짓는 요소들에 대한 것이고, 위젯 안쪽은 그 요구의 대상이 아니다.
    // 그래서 클래스로 가린다 — 소음을 재우는 대신 무엇을 세는지 좁힌다.
    const added = await page.evaluate(`(async () => {${PICK}
      const LAYOUT = ['slot','slot-handle','sp','sc','pn','pn-tabs','pn-body',
        'pn-tab','pn-tab-add','ed-win','ed-area','ed-side'];
      const area = document.getElementById('area');
      let n = 0;
      const obs = new MutationObserver(rs => {
        for (const r of rs) for (const nd of r.addedNodes) {
          if (nd.nodeType !== 1) continue;
          if (LAYOUT.some(c => nd.classList.contains(c))) n++;
        }
      });
      obs.observe(area, { childList: true, subtree: true });
      // 위젯 안쪽을 일부러 시끄럽게 만든다 — 필터가 실제로 가리는지까지 잰다.
      pane.term.write('NOISE-FOR-OBSERVER' + String.fromCharCode(13, 10));
      window.app.render();
      await new Promise(r => setTimeout(r, 300));
      window.app.render();
      await new Promise(r => setTimeout(r, 300));
      obs.disconnect();
      return n;
    })()`);
    expect(added).toBe(0);
  });

  // TC-PDR-6: 요소를 재사용하면 핸들러가 겹치기 쉽다. 겹치면 클릭 한 번이
  // 두 번 동작한다.
  test('여러 번 render 해도 탭 클릭은 한 번만 동작한다', async ({ page }) => {
    await waitForInit(page, { clearLocalStorage: true });
    const calls = await page.evaluate(`(() => {
      for (let i = 0; i < 5; i++) window.app.render();
      const a = window.app;
      const orig = a.switchTab;
      let n = 0;
      a.switchTab = function (...args) { n++; return orig.apply(this, args) };
      document.querySelector('#area .pn.focused .pn-tab').click();
      a.switchTab = orig;
      return n;
    })()`);
    expect(calls).toBe(1);
  });

  // TC-PDR-7: 탭이 늘고 줄어도 남은 탭은 같은 요소다 (FR-PDR-4).
  test('탭을 더해도 이미 있던 탭 요소는 그대로다', async ({ page }) => {
    await waitForInit(page, { clearLocalStorage: true });
    const first = page.locator('#area .pn.focused .pn-tab').first();
    await first.evaluate((el) => ((el as any).__mark = 'keep-me'));

    await Promise.all([
      page.waitForResponse((r) => r.url().includes('/api/tools') && r.request().method() === 'POST'),
      page.click('#area .pn.focused .pn-tab-add'),
    ]);
    await expect(page.locator('#area .pn.focused .pn-tab')).toHaveCount(2, { timeout: 10000 });

    const kept = await page.locator('#area .pn.focused .pn-tab').first().evaluate((el) => (el as any).__mark);
    expect(kept).toBe('keep-me');
  });

  // TC-PDR-8: 분할은 트리를 바꾼다. 그래도 **영향받지 않은** pane 은 움직이지
  // 않아야 한다 — 분할의 반대편에서 돌던 TUI 가 그 순간 튀지 않는다.
  test('분할해도 원래 pane 의 터미널은 같은 노드이고 맨 아래에 남는다', async ({ page }) => {
    await waitForInit(page, { clearLocalStorage: true });
    await fillScrollback(page);
    await page.evaluate(`(() => {${PICK} window.__tp = pane.el; window.__term = pane })()`);

    await page.evaluate('window.app.split("horizontal")');
    await page.waitForTimeout(500);

    const r = await page.evaluate(`(() => {
      const p = window.__term;
      const buf = p.term.buffer.active;
      return { same: window.__tp === p.el, mounted: !!p.el.closest('.pn-body'), atBottom: buf.viewportY >= buf.baseY };
    })()`);
    expect(r).toEqual({ same: true, mounted: true, atBottom: true });
  });

  // TC-PDR-9: 창을 바꾸면 위젯이 실제로 옮겨진다 — 이동이 남는 경로다.
  // 그 경로에서도 떠날 때 맨 아래였으면 돌아와서 맨 아래여야 한다 (FR-PDR-11).
  test('창을 바꿨다 돌아와도 맨 아래를 보고 있던 터미널은 맨 아래다', async ({ page }) => {
    await waitForInit(page, { clearLocalStorage: true });
    await fillScrollback(page);
    const home = await page.evaluate('window.app.ws.activeWindow');

    await Promise.all([
      page.waitForResponse((r) => r.url().includes('/api/tools') && r.request().method() === 'POST'),
      page.click('#add-window'),
    ]);
    await page.waitForTimeout(400);
    await page.evaluate((sid) => (window as any).app.switchWindow(sid), home);
    await page.waitForTimeout(500);

    const st = await paneState(page);
    expect(st.atBottom, `viewportY=${st.viewportY} baseY=${st.baseY}`).toBe(true);
  });

  // TC-PDR-10: 대체 화면에는 되돌릴 스크롤이 없다. 손대면 해가 된다 (FR-PDR-12).
  test('대체 화면(TUI)에서 render 는 화면을 건드리지 않는다', async ({ page }) => {
    await waitForInit(page, { clearLocalStorage: true });
    await fillScrollback(page);
    await page.evaluate(`(() => {${PICK}
      pane.term.write('\\x1b[?1049h');      // 대체 화면 진입
      pane.term.write('ALT-SCREEN-BODY');
    })()`);
    await page.waitForTimeout(150);

    const before: { type: string; y: number } = await page.evaluate(`(() => {${PICK}
      const b = pane.term.buffer.active;
      return { type: b.type, y: b.viewportY };
    })()`);
    await page.evaluate('window.app.render()');
    await page.waitForTimeout(300);
    const after: { type: string; y: number } = await page.evaluate(`(() => {${PICK}
      const b = pane.term.buffer.active;
      return { type: b.type, y: b.viewportY };
    })()`);

    expect(before.type).toBe('alternate');
    expect(after).toEqual(before);
  });

  // TC-PDR-11: 칸을 더해도 남는 칸의 pane 은 같은 노드다 (FR-PDR-6).
  test('칸을 더해도 원래 칸의 터미널은 같은 노드다', async ({ page }) => {
    await waitForInit(page, { clearLocalStorage: true });
    await page.evaluate(`(() => {${PICK} window.__tp = pane.el })()`);

    await page.evaluate('window.app.slotAdd()');
    await page.waitForTimeout(600);
    await page.evaluate('window.app.slotFocusTo(0)');
    await page.waitForTimeout(400);

    const r = await page.evaluate(`(() => {${PICK}
      return { same: window.__tp === pane.el, mounted: !!pane.el.closest('.pn-body') };
    })()`);
    expect(r).toEqual({ same: true, mounted: true });
  });
});

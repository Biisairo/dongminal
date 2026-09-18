import { test, expect, waitForInit, waitShellReady } from './fixtures';

/**
 * 재접속이 앱의 터미널 모드를 잃지 않는다 (TERMINAL_MODE_RESTORE_SRS · V-TMR-9~11).
 *
 * 접수(`U-32`)의 증상은 **이미지 붙여넣기가 조용히 죽는 것**이었다. 그 사슬의
 * 끝은 여기서 재는 한 가지다 — 클립보드에 텍스트가 없는 붙여넣기에서 xterm 이
 * `ESC[200~ESC[201~` 를 내보내는가. 모드가 살아 있으면 내보내고, 죽었으면 빈
 * 문자열이라 프론트가 버린다. Claude Code 는 그 12바이트를 받아야 클립보드를
 * 스스로 뒤진다.
 *
 * 그래서 이 파일은 xterm 의 내부 상태를 읽지 않는다. **사용자가 하는 그 동작**을
 * 그대로 일으키고, 소켓으로 나가는 바이트를 센다.
 */

/** 화면에 서 있는 터미널 pane. `term-resume.spec.ts` 와 같은 손이다. */
const paneEval = (page: any, fn: string) =>
  page.evaluate(`(() => {
    const app = window.app;
    const pane = [...app.tools.values()].find(p => p.el.classList.contains('vis'));
    return (${fn})(pane);
  })()`);

/** 셸에 한 줄 보내고 실행시킨다. */
const runInShell = (page: any, line: string) =>
  paneEval(page, `p => { p._sendText(${JSON.stringify(line + '\r')}) }`);

/**
 * 나가는 입력을 기록하기 시작한다.
 *
 * `_sendText` 는 프론트가 소켓으로 내보내는 **모든 입력**이 지나는 자리다
 * (`term-resume.spec.ts` 가 `_handleOutput` 을 감싸는 것과 같은 방식).
 */
const watchSent = (page: any) =>
  paneEval(page, `p => {
    window.__sent = [];
    const orig = p._sendText.bind(p);
    p._sendText = s => { window.__sent.push(s); orig(s) };
  }`);

/**
 * **텍스트가 없는 붙여넣기.** 이미지를 Cmd+V 했을 때 브라우저가 주는 것과 같다 —
 * 관측으로 확인했다: `types: ['Files']`, `text: ""`.
 *
 * xterm 의 helper textarea 에 그대로 일으킨다. 키보드 단축키로는 클립보드 권한이
 * 필요하고, 그것은 이 검사가 재려는 것이 아니다.
 */
const pasteNothing = (page: any) =>
  paneEval(page, `p => {
    const ta = p.el.querySelector('.xterm-helper-textarea');
    ta.dispatchEvent(new ClipboardEvent('paste', {
      clipboardData: new DataTransfer(), bubbles: true, cancelable: true,
    }));
  }`);

const sentSince = (page: any) => page.evaluate(() => (window as any).__sent as string[]);

const BRACKET_EMPTY = '\x1b[200~\x1b[201~';

/**
 * 링버퍼(`bufMax`, 1MB)를 확실히 넘기는 출력. 이것이 이 결함의 방아쇠다.
 *
 * 끝을 표식으로 알린다. **`printf` 로 짜 맞추는 이유**는 명령줄 자체가 화면에
 * 에코되기 때문이다 — 검색어가 명령에 그대로 있으면 출력을 기다리지 않고 참이
 * 되어 새로고침이 출력과 겹친다.
 */
const FLOOD = `printf '\\033[?2004h'; seq 1 200000; printf 'DM_%s\\n' DONE; cat`;
const FLOOD_MARK = 'DM_DONE';

async function ready(page: any) {
  await waitForInit(page);
  await waitShellReady(page);
}

/**
 * V-TMR-9 (FR-TMR-20): **출력이 링버퍼를 넘긴 뒤 새로고침해도 모드가 살아 있다.**
 *
 * 수정 전에는 여기서 죽었다 — 재생의 재료인 링버퍼에서 앱이 시작할 때 보낸
 * `ESC[?2004h` 가 밀려나므로, 새 xterm 은 그 모드를 본 적이 없는 채로 선다.
 */
test('V-TMR-9: 링버퍼를 넘긴 뒤 새로고침해도 bracketed paste 가 살아 있다', async ({ page }) => {
  await page.goto('/');
  await ready(page);

  // 앱이 모드를 켠 것과 같다 — claude 가 시작할 때 보내는 그 바이트다.
  // **한 줄로 붙여 둔 것이 요점이다.**
  //
  //   ① 모드를 켠다 — claude 가 시작할 때 보내는 그 바이트다
  //   ② 링버퍼를 넘긴다 — ①이 재생에서 밀려난다
  //   ③ `cat` 이 돈다 — **프롬프트가 다시 그려지지 않는다**
  //
  // ③ 이 없으면 이 검사는 결함을 잡지 못한다. bash 5·zsh 는 프롬프트를 그릴
  // 때마다 `ESC[?2004h` 를 다시 보내므로, 복원을 통째로 들어내도 셸이 대신
  // 켜 준다 (실측: 들어낸 채로 통과했다). 접수된 증상이 claude 에서만 보였던
  // 이유가 정확히 이것이다 — 시작할 때 한 번 켜고 계속 도는 앱.
  await runInShell(page, FLOOD);
  // **끝났음을 표식으로 판정한다.** 버퍼 길이로는 잴 수 없다 — 스크롤백 상한이
  // 5만 줄이라 20만 줄을 쏟아도 길이는 그 언저리에서 멈춘다 (실측: 그 조건으로
  // 두 번 다 실패했다). 아직 쏟아지는 중에 새로고침하면 재생과 겹쳐 흔들린다.
  await expect.poll(() => paneEval(page, `p => {
    const b = p.term.buffer.active;
    for (let i = b.length - 1; i >= 0 && i > b.length - 40; i--)
      if ((b.getLine(i)?.translateToString(true) || '').includes(${JSON.stringify(FLOOD_MARK)})) return true;
    return false;
  }`), { timeout: 120000 }).toBe(true);

  await page.reload();
  await ready(page);
  // 재접속이 **끝난 뒤**에 붙여넣는다. 좌표 통보(`OpSeq`)는 재생과 모드 복원
  // 다음에 오므로, 그것이 서면 복원도 이미 도착해 있다 (FR-TMR-21 의 순서).
  await expect.poll(() => paneEval(page, `p => p._seq`), { timeout: 30000 })
    .toBeGreaterThan(0);

  await watchSent(page);
  await pasteNothing(page);
  await expect.poll(() => sentSince(page)).toContain(BRACKET_EMPTY);
});

/**
 * V-TMR-10 (FR-TMR-24): 마우스 프로토콜·인코딩도 같은 길로 돌아온다.
 *
 * 여기서는 **서버가 보낸 바이트**를 직접 본다. 마우스 보고는 화면에 흔적을 남기지
 * 않으므로 동작으로 재려면 좌표 계산까지 흉내 내야 하고, 그것은 이 요구가 정하는
 * 것(복원을 보내는가)보다 넓다.
 */
test('V-TMR-10: 재접속이 마우스 모드를 되세운다', async ({ page }) => {
  await page.goto('/');
  await ready(page);

  await runInShell(page, `printf '\\033[?1002h\\033[?1006h'`);
  // 모드가 서버에 관측될 틈을 준다 — PTY 를 왕복한 뒤라야 Tool 이 안다.
  await expect.poll(() => paneEval(page, `p => p.term.buffer.active.length`),
    { timeout: 15000 }).toBeGreaterThan(0);

  // 받은 출력을 기록하고 소켓만 끊는다. pane 이 남으므로 기록도 남는다.
  await paneEval(page, `p => {
    window.__rx = '';
    const orig = p._handleOutput.bind(p);
    p._handleOutput = d => { window.__rx += new TextDecoder().decode(d); orig(d) };
  }`);
  await paneEval(page, `p => { p.ws.close() }`);

  await expect.poll(() => page.evaluate(() => (window as any).__rx as string),
    { timeout: 20000 }).toContain('\x1b[?1002h');
  expect(await page.evaluate(() => (window as any).__rx as string)).toContain('\x1b[?1006h');
});

/**
 * V-TMR-11 (FR-TMR-22): **꺼 둔 모드는 되살아나지 않는다.**
 *
 * 켜진 것만 보내는 것이 요구이고, 그 반대편이 이것이다. 껐는데 복원이 켜면
 * 마우스의 경우 클릭이 앱으로 새어 가 사용자가 선택·복사를 못 한다.
 *
 * **마우스로 재는 이유가 있다.** bracketed paste 로 재려 했더니 실패했는데, 원인은
 * 제품이 아니라 셸이었다 — bash 5·zsh 는 **프롬프트를 그릴 때마다** `ESC[?2004h`
 * 를 다시 보낸다. 껐다고 적어도 다음 프롬프트가 되켠다.
 *
 * 그 관찰이 접수된 증상을 거꾸로 설명한다: 일반 셸에서 이 결함이 잘 드러나지
 * 않은 것은 셸이 끊임없이 모드를 되켜기 때문이고, **claude 처럼 시작할 때 한 번
 * 켜고 계속 도는 앱**에서만 조용히 죽는다.
 */
test('V-TMR-11: 앱이 끈 모드는 재접속 뒤에도 꺼진 채다', async ({ page }) => {
  await page.goto('/');
  await ready(page);

  await runInShell(page, `printf '\\033[?1002h'`);
  await runInShell(page, `printf '\\033[?1002l'`);
  await expect.poll(() => paneEval(page, `p => p.term.buffer.active.length`),
    { timeout: 15000 }).toBeGreaterThan(0);

  await paneEval(page, `p => {
    window.__rx = '';
    const orig = p._handleOutput.bind(p);
    p._handleOutput = d => { window.__rx += new TextDecoder().decode(d); orig(d) };
  }`);
  await paneEval(page, `p => { p.ws.close() }`);

  // 재접속이 끝난 것을 **다른 신호**로 확인한 뒤에 없음을 판정한다 — 재생이
  // 도착하면 좌표가 다시 선다.
  await expect.poll(() => paneEval(page, `p => p._seq`), { timeout: 20000 })
    .toBeGreaterThan(0);
  expect(await page.evaluate(() => (window as any).__rx as string)).not.toContain('\x1b[?1002h');
});

# 인계: TUI 화면 옆에 터미널 스크롤바가 생기는 문제

## 착수 블록 (이번 세션의 지시 전부)

1. `main` 브랜치에서 일한다. `git log --oneline -3` 으로 아래 두 커밋이 맨 위에 있는지 확인한다.
2. 아래 "다음 일" 을 조사하고 고친다. 순서는 조사 → 원인 확정 → 스펙(해당 SRS 개정 또는 새 FR) → 시험(RED) → 구현(GREEN) → 검사다.
3. 검사: `make gates` · `npm run -s typecheck` · `npm run -s unit` · `make lint` · 관련 e2e(`e2e/terminal.spec.ts` · `e2e/term-gpu.spec.ts` · `e2e/font-size.spec.ts` 와 고친 곳의 스펙).
4. **커밋은 사용자에게 확인을 받은 뒤 한다.** AI 서명을 넣지 않는다. push 하지 않는다. 사용자의 dongminal 을 재시작하지 않는다(데몬 포함).
5. 끝나면 아래 "사용자에게 보고할 것" 과 함께 보고한다.

## 다음 일

> **끝남 (2026-11-12, `ef9001db`).** 원인은 아래 후보가 아니었다. 전량 재생이 대체 화면을
> 되세우지 않아, 앱이 켠 `?1049h` 가 보유 창(1 MiB) 밖으로 밀린 TUI 가 주 화면에 그려졌다.
> 수정과 근거는 `TERMINAL_RESUME_SRS` FR-TRS-10a 에 있다.

**증상 (사용자 신고, 2026-11-12):** TUI(alt 화면, 예: Claude Code)를 띄운 터미널에서 브라우저 창을 줄인다. TUI 는 줄인 크기에 맞게 다시 그려진다. 그런데 TUI 옆에 **터미널(xterm) 스크롤바가 생긴다.** 다시 그리기만 돼야 하고 스크롤바가 생기면 안 된다.

아직 아무것도 조사하지 않았다. 아래는 확인할 후보다. 추측이므로 실측으로 가린다.

- `.xterm-viewport` 의 높이 대비 내용 높이가 커지는 경우. 창을 줄이는 동안 `fit` 이 늦거나, 행 수는 줄었는데 viewport 의 scrollHeight 가 이전 값으로 남는 경우
- 칸 높이의 소수점 반올림 때문에 `rows × 행 높이` 가 상자 높이를 몇 px 넘는 경우
- DOM 렌더러와 WebGL 렌더러의 칸 크기가 다른 경우(TERMINAL_GPU_RENDER_SRS FR-TGR-7a). 이번 세션의 커밋 `56435a84` 로 컨텍스트를 잃으면 곧바로 DOM 렌더러로 돌아가므로, 렌더러가 바뀐 뒤 크기를 다시 재는지 함께 본다
- alt 화면인데 일반 화면의 스크롤백 길이가 viewport 에 반영되는 경우
- 재현: 격리 e2e 서버에서 alt 화면 프로그램(예: `printf '\e[?1049h'` 뒤 화면 채우기, 또는 `less`·`vim`)을 띄우고 `page.setViewportSize` 로 줄인 뒤 `.xterm-viewport` 의 `scrollHeight > clientHeight` 를 잰다. GPU 를 켠 경우(`localStorage.termGpu='1'`)와 끈 경우(e2e 기본)를 둘 다 본다

먼저 읽을 것: `web/js/ui/term-pane.js`(`doFit`·`destroy`), `web/js/ui/renderer-layout.js`(`_afterLayout`), `web/js/ui/term-gpu.js`, `docs/internal/TERMINAL_GPU_RENDER_SRS.md` §4.2~4.3.

## 어디까지 왔나 (지난 세션, main)

| 커밋 | 내용 |
|---|---|
| `2f9d9a5b` | Run 카드: 멤버 수는 `활성/전체`(헤드리스도 활성만 셈), 경과는 마지막 활동 시각. `ORCHESTRATION_V2_SRS` FR-RVZ-3 개정 |
| `56435a84` | 터미널 흰 칸: WebGL 컨텍스트를 잃으면 3초 기다리지 않고 곧바로 DOM 렌더러로 돌린다. 뗄 때(숨김·끔·손실·칸 파괴) 컨텍스트를 `WEBGL_lose_context` 로 반납한다. `TERMINAL_GPU_RENDER_SRS` FR-TGR-10 개정·10a, TC-TGR-16·17·17b, e2e V-TGR-4 |
| `ef9001db` | 전량 재생 본문이 대체 화면 안에서 시작하면 하드 클리어 뒤에 `?1049h` 를 넣는다. `TERMINAL_RESUME_SRS` FR-TRS-10a·V-TRS-7a·7b, `TERMINAL_MODE_RESTORE_SRS` §1.4·§5 개정 |

두 커밋 모두 사용자의 서버에는 아직 반영되지 않았다(재빌드·재시작은 사용자가 한다).

## 지난 세션이 값을 치르고 배운 것

- **흰 터미널의 원인은 연결이 아니라 그리기였다.** 사용자 콘솔에 `CONTEXT_LOST_WEBGL` → `webglcontextlost` → `webglcontextrestored` → `INVALID_OPERATION: delete: object does not belong to this context` ×24 가 남았다. 같은 시각 서버의 WS 연결 수(`server.log` 의 `diag ... ws=`)는 변하지 않았다. 흰 화면 신고가 오면 먼저 `diag ws=` 와 `ws connected` 줄로 연결이 끊겼는지부터 가린다
- 브라우저가 **왜** 컨텍스트를 회수했는지는 확정하지 못했다(컨텍스트 상한 또는 macOS GPU 리셋). 앱·addon 은 `loseContext` 를 부르지 않는다
- **addon-webgl 은 캔버스를 둘 만든다** — 링크 표시용 2D 캔버스(`xterm-link-layer`)와 WebGL 캔버스. "새로 생긴 첫 캔버스" 를 고르면 틀린다. 흉내 단위 시험은 이것을 못 잡았고 실제 Chromium e2e 가 잡았다. DOM 가정은 e2e 로 확인한다
- **13:22:59 에 이 PC 브라우저의 WS 6개·SSE 2개가 한꺼번에 끊긴 원인은 미확정이다.** 사용자는 새로고침하지 않았다. 13:22:02 에 `com.chrome.devtools.json`·`.js.map` 요청이 있어 개발자 도구가 열려 있었다. 다시 생기면 그때 한 동작을 묻는다. 브라우저 쪽 기록은 서버로 오지 않는다(`ErrorLog` 는 메모리에만 있고, 콘솔에서 `ErrorLog.items()` 로 본다)
- 오전(2026-11-12)에 고친 "숨은 탭 전량 재생 반복"(`56dfac29`)은 08:43 기동 뒤 다시 나오지 않았다
- 단위 시험 하네스(`web/js/test/harness.mjs`)는 vm 컨텍스트라 `assert.deepEqual` 이 원형 차이로 실패할 수 있다. JSON 문자열로 비교한다
- RED 를 확인할 때 `git stash` 를 쓰면 시험 파일도 함께 되돌아간다. 구현 파일만 `git show HEAD:<경로> > <경로>` 로 되돌려 확인한다

## 변하지 않는 규약

- 사용자 CLAUDE.md: 심볼 탐색은 LSP → Serena → grep. 중·대 규모는 스펙(IEEE 29148) → 시험 → 구현
- 커밋은 사용자 확인 뒤, AI 서명 없음, push·병합 금지, 사용자 dongminal(데몬 포함) 재시작 금지
- 동작을 바꾸면 SRS 에 이전 동작·새 동작·이유를 적는다
- 게이트: i18n 키는 ko·en 이 같아야 하고 쓰지 않는 키가 없어야 한다. SRS 상태 값은 게이트의 허용 목록만 쓴다

## 다른 브랜치의 남은 일 (이번 세션의 일이 아님)

- `feat/telegram-bridge` 는 `ca9cdff2` 까지 커밋됐다. ⑥ 실측(TC-TGB-31·90)은 사용자의 재빌드·재시작을 기다린다. 절차는 그 브랜치의 `docs/internal/TELEGRAM_BRIDGE_HANDOFF.md` ⑥ 절에 있다. 사용자가 "다시 띄웠다" 고 하면 그 문서를 따른다
- 테스트 봇 DM 의 옛 실측 토픽(253·260·263)은 권한 확인에서 삭제가 거절돼 남아 있다. 사용자가 직접 지우기로 했다

## 사용자에게 보고할 것

1. 스크롤바 문제의 원인과 수정, 검증 결과(재현 전·후 수치)
2. 사용자 서버에 반영하려면 재빌드·재시작이 필요하다는 것(지난 세션의 `2f9d9a5b`·`56435a84` 포함)
3. 문서와 구현이 어긋난 곳이 있었으면 그 목록

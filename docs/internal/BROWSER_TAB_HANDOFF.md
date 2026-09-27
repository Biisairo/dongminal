# 인수인계 — 브라우저 탭 뒷정리 (남은 결함·흔들리는 시험)

> 근거 SRS: `BROWSER_TAB_SRS.md`(승인·구현완료) · `REQUEST_GATE_ORIGIN_PORT_SRS.md`(승인·구현완료).
> 브랜치 `main`. 직전 커밋은 엔벨로프에 있다.

## 착수 블록 — 이번 세션의 지시 전부

1. 아래 §2 의 다섯을 **순서대로 전부** 끝낸다. 결정이 필요하면 SRS·조사 문서의 결정에서 답을 찾고,
   없으면 **더 단순한 쪽**을 골라 해당 SRS 변경 기록에 "구현 중 결정" 으로 적는다. 사용자에게 되묻지
   않는다 — 단, **되돌리기 어렵거나 밖으로 나가는 일**(원격 브랜치 삭제, 남의 PR 닫기 등)은 먼저 묻는다.
2. 항목마다 원인 확인 → Spec(필요하면) → Test(RED) → Code(GREEN). 원인을 모르고 재시도·시간만 늘리는
   "고침" 은 하지 않는다 — 원인이 시험의 시간 가정이면 그 사실을 근거와 함께 적고 시험을 고친다.
3. 항목(또는 묶음)마다 **자기 파일만 경로로 골라** 커밋하고 `git push origin main` 으로 CI(verify·e2e)를
   돌린다. 사용자가 main push 로 CI 를 돌리라고 했다(2026-09-27). CI 가 초록이 될 때까지 고친다.
4. 끝나면 최종 보고(항목별 결과·근거·남은 위험·커밋 목록)를 화면에 남기고
   `dmctl notify "브라우저 탭 뒷정리 완료"` 를 부른다.

## 0. 한 줄 상태

브라우저 탭 0~4단계와 SRS 전수 대조의 빈 곳까지 끝났다. **`77df484b` 에서 CI 가 전부 초록**
(verify Ubuntu·Windows, e2e 16 샤드), 로컬 e2e 1935건 통과. 남은 것은 이 SRS 밖에서 찾은 결함 하나,
문서 한 줄, 가끔 흔들리는 시험 셋이다.

## 1. 어디까지 왔나

| 커밋 | 내용 |
|---|---|
| `9ffc0423` | 0단계 — 요청 게이트가 Origin 의 포트까지 대조 (FR-ROP) |
| `9c5b2a00` | 1~3단계 — 브라우저 탭·`dmctl browser`·CDP 프록시·충실도 |
| `ddea8eb9` | 4단계 소리(WebRTC) + SRS 대조 보완 |
| `cf5bcd3e` | 대기 중인 파일 선택·대화상자 재전송, 에이전트 `open_url` 제거(비목표 11), `<select>` 는 base-select 확정 |
| `6ea8eb7c` · `a14fdcda` · `77df484b` | CI 가 드러낸 Windows·Linux 결함과 회귀 수정 |

`BROWSER_TAB_SRS.md` §7 변경 기록의 결정 ①~55 가 모든 판단의 근거다.

## 2. 남은 일과 순서

| # | 할 일 | 끝나는 조건 |
|---|---|---|
| 1 | **`internal/daemon/ipc/paned.go:166`** `go pc.enqueue(pc.terminate(req), false)` — `go` 문의 인자는 부르는 고루틴에서 먼저 계산되므로 `terminate` 가 **IPC 읽기 루프에서** 돈다. 종료가 오래 걸리면 그동안 데몬 IPC 전체가 멎는다. `paned_browser.go:61~67` 이 같은 결함을 고친 선례다(`go func(){ pc.enqueue(run(), false) }()` + 회귀 시험 `paned_browser_test.go`) | 읽기 루프가 막히지 않음을 재는 회귀 시험이 수정 전 RED · 수정 후 GREEN |
| 2 | **`BROWSER_TAB_SRS.md`** 변경 기록의 "검증 한계 — TC-BRT-6 의 Windows 판정·Linux CI 의 Chrome 샌드박스는 CI 가 판정한다"(결정 ⑬·㉙) 를 해소로 적는다: `77df484b` 의 verify(windows-latest·ubuntu-latest) 초록이 근거 | `check-srs-status`·`check-srs-progress`·`check-decisions`·`gen-decisions -check` |
| 3 | **`TestDaemonConcurrentPushAndRequest`** — 부하 중 가끔 실패(브라우저 작업 전 HEAD 에서도 실패했다). 결함인지 시험의 시간 가정인지 가린다 | 원인이 적히고, `-count=20 -race` 가 로컬에서 초록, CI 초록 |
| 4 | **TC-BRT-81**(e2e `browser-tab.spec.ts` "탭의 소리가 뷰어에 도착한다") — Ubuntu 에서 재시도에 통과(flaky). 후보: 톤 시작과 offer 의 순서, ICE(호스트 후보) 수집, `Audio.play()` 의 자동 재생 거절. CI 산출물 trace 로 본다 | 원인 확인·수정, CI 두 회차 연속 flaky 0 |
| 5 | **TC-GLR-1**(e2e `git-observe-revive.spec.ts:231` "폴링이 멎어 있으면 그리기 한 번에 되살아난다") — Windows 에서 재시도에 통과. 브라우저 탭과 무관 | 원인 확인·수정, CI 초록 |

## 3. 먼저 읽을 것

1. `BROWSER_TAB_SRS.md` §7 변경 기록의 마지막 여덟 행(추적 감사 보완 이후) — 무엇을 왜 바꿨는지
2. `internal/daemon/ipc/paned_browser.go` 의 `browserCall` 과 그 시험 — 항목 1 의 선례
3. `.github/workflows/e2e.yml`·`verify.yml` — 샤드 분할은 `scripts/e2e-shard.mjs` 한 자리, 워커 2
4. `e2e/parity-reporter.ts` — flaky 는 실패로 올리지 않지만 기록된다(CI_GATES_SRS §3)

## 4. 이 세션이 값을 치르고 배운 것

- **CI 조회**: `gh` 계정(`dongyo12`)은 이 저장소의 collaborator 가 아니다 — `gh workflow run`(403)·`gh pr create` 가
  거절된다. **push 는 SSH(`bii:Biisairo/dongminal.git`)로 된다.** CI 는 main push 로 돈다.
  run 목록·로그·산출물은 읽힌다: `gh run list --branch main`, `gh run view <id> --log-failed`,
  `gh run download <id> -R Biisairo/dongminal -n playwright-report-<os>-<샤드>` (trace.zip 을 풀면
  `*.trace` 는 JSON 줄 — `type=="before"` 의 `title`·`startTime` 으로 시험 걸음을, `*.network` 로 요청을 본다).
  실행 중인 run 의 로그는 끝나야 받을 수 있다.
- **`sleep` 이 막힌다** — 기다릴 때는 `until …; do sleep N; done` 을 `run_in_background` 로 돌린다.
- **zsh 는 `$specs` 를 낱말로 쪼개지 않는다** — 샤드 재현은 `bash -c 'specs=$(node scripts/e2e-shard.mjs --list 6/8); npx playwright test $specs'`.
- **게이트는 시험 파일에도 적용된다**: `runtime.GOOS`·`os.FindProcess` 는 platform 밖 금지 — 권한 비트는
  `testpath.PermChecked()`, 프로세스 죽이기는 `platform.Current().Process.Kill(pid)`.
- **Linux headless Chrome**: `Page.crash`·`chrome://crash` 는 렌더러를 죽이지 않는다 — 크래시 시험은
  `SystemInfo.getProcessInfo` 의 renderer pid 를 죽인다. 크래시는 `Target.targetCrashed` 로도 받는다.
- **Windows 러너**: Chrome 첫 기동이 5초를 넘는다(getVersion 상한 15초). 프로필 폴더는 주 프로세스가 끝난 뒤에도
  Job 의 자식이 핸들을 늦게 놓는다(지우기 재시도). resize 이벤트 보고를 믿지 말고 `innerWidth` 를 직접 읽는다.
- **느린 러너가 드러낸 제품 결함 유형** — 다음에도 먼저 의심할 것: ① 연결이 열리기 전 보낸 메시지를 버림
  ② 다음 프레임에 주는 기본값이 그 사이의 사용자 조작을 덮음 ③ 등록(공개) 뒤 잠금 없이 필드를 읽음.
- **다른 세션의 리팩터(OPTIMIZE_REFACTOR)가 e2e 가정을 깼던 두 사례**: 같은 본문이면 `save()` 가 PUT 을 보내지
  않는다(FR-OPT-5-1) · 탐색기 폴링이 `_edGitPoll`(visiblePoll) 로 옮겼다(FR-OPT-4-2). 시험 계약
  (`app-testing.js`) 에 죽은 이름이 남아 있을 수 있다 — `app.testing.<이름>` 이 undefined 면 의심한다.
- 레이아웃 기준선(`e2e/baseline/ui-layout.<os>.json`)은 판마다 하나다. 새 DOM 요소가 늘면 "지금에만" 키가
  세 판 모두에서 뜬다 — 새 키만 더하고 흔들리는 기존 키는 건드리지 않는다.
- **이 작업 트리에서 다른 세션이 동시에 `main` 에 커밋할 수 있다.** 커밋할 때 자기 파일만 경로로
  `git add` 한다(`git add -A` 금지). push 전에 `git fetch` 로 앞선 커밋이 없는지 본다.

## 5. 변하지 않는 규약

- `~/.claude/CLAUDE.md` — SDD(IEEE 29148) · TDD(구현 전에 RED) · 최소 구현 · 국소 변경 · 동작 변경은
  이전/새/이유 기록.
- **커밋 메시지에 AI 서명(`Co-Authored-By` 등)을 넣지 않는다** (사내 규정). 형식 `fix(scope): 한국어 요약 (FR-…)`.
- 새 런타임 의존 금지. `platform` 밖 OS 분기 금지(시험 포함).
- 검사: `make all` · `npm run e2e` · `scripts/check-{srs-status,srs-progress,decisions,settings-docs,shortcuts-docs,env-docs,commands-docs,api-docs}.sh` ·
  `go run ./scripts/gen-decisions -check`.

## 6. 아직 유효한 사용자 결정

- 에이전트 `open_url` 은 걷었다(비목표 11) · `<select>` 는 base-select 로 확정 (2026-09-27).
- CI 는 **main 에 push** 해서 돌린다 (2026-09-27).
- 원격의 `dependabot/*` 브랜치 넷은 Dependabot 의 것이다 — 지우지 않는다(지우면 PR 이 닫힌다).
- 그 밖: `BROWSER_TAB_INVESTIGATION.md` §7 D1~D17, `BROWSER_TAB_SRS.md` §6 D-BRT-1~19.

# M9 P2 — 착수 프롬프트 (크기 통보 · 재연결 재수신 · B2 추적)

P1 은 끝났다(커밋 해시는 §4 표 — `M9_PROGRESS.md`). **P2 는 착수 전**이다. 아래 블록이 착수 세션의 지시 전부다.

---

```
프로젝트: /Users/dykim/personal/dongminal

M9 P2 를 한다 — 스펙 `docs/internal/M9_SRS.md` §4 의 P2: FR-M9-3(`OpSize` 크기 통보) ·
FR-M9-10(재연결 워크스페이스 재수신) · M9-B2(복귀 시 아래로 스크롤 안 됨)의 남은 조건 추적.
작업 트리는 깨끗하다 — `git status` 로 확인하라.

## 먼저 읽을 것 (순서대로)

1. `docs/internal/M9_SRS.md` — §2.3 재감사(실측 · P1 이 잰 것) · §3.1 의 FR-M9-3·10 · §5 의
   D-M9-3·8 · §7 비목표
2. `docs/internal/production/M9_PROGRESS.md` — §1 단계표·판정표 · **§2 배운 것**(특히 §2-2:
   재현 환경은 사용자 환경과 같은 수의 참여자를 가져야 한다) · **§3 실측 방법**(격리 인스턴스 ·
   두 클라이언트 · 잠든 기기 · Monaco 의 사실) — §3 은 그대로 다시 쓴다
3. `docs/internal/production/M8_NEXT_SESSION.md` — M8 종료 기록. 규약과 단계 종료 절차의 원본
4. `docs/internal/TERMINAL_RESUME_SRS.md`(FR-TRS-6~21 · `OpSeq` 의 규약이 `OpSize` 의 본이다) ·
   `docs/internal/VIEW_SCROLL_RESTORE_SRS.md`(B2 와 같은 증상을 두 번 고친 자리)

## 남은 일 (순서)

1. **FR-M9-3 — `OpSize`**. 와이어에 서버→클라이언트 op 하나를 더한다(cols 2 + rows 2, 빅엔디언).
   ① 접속 직후 재생·`OpSeq` **앞**에 한 번 ② PTY 크기가 바뀔 때마다 그 도구의 모든 클라이언트에게.
   브라우저는 `resizeCheck` 가 거짓인 패널에서 받은 크기로 `term.resize()` 하고 자기 `fit()` 을
   PTY 에 보내지 않는다. 옛 클라이언트는 조용히 버린다(FR-TRS-9 와 같은 규약).
   **direct 모드와 daemon 모드 둘 다** 나가야 한다 — 한쪽만 고치는 자리다(D-A-16 의 교훈).
2. **FR-M9-10 — 재연결 재수신**. 명령 SSE 가 끊겼다 다시 붙으면 그 자리에서 워크스페이스를
   다시 받아 적용한다. 주기 폴링을 더하지 마라 — 메울 구간이 있는 순간은 재연결 하나다.
3. **M9-B2 추적**. P1 은 셸 도구에서 재현하지 못했다(§2.3). 남은 조건 셋을 하나씩 지워라:
   ① TUI(claude code) ② 전량 재생 ③ `renderer.js` `_restoreScrollOf` 가 `vis` 아닌 순간에 도는
   경로. 끝내 재현되지 않으면 "재현 실패 — 조건" 으로 스펙에 남기고 P2 를 닫는다.
4. **V 전량** (단계 끝): `go test -race -shuffle=on -count=1 ./...` · `make gates` · `make unit` ·
   `make e2e` → `unexpected 0` → `make e2e-rebalance`
5. **문서** — `M9_PROGRESS.md`(§1 단계표·판정표·전량 · §2 배운 것) · `M9_SRS` §10 ·
   `PRODUCTION_ROADMAP.md` 의 M9 절 단계표 · 이 파일을 P3 착수 프롬프트로
6. **커밋** — 단계 종료 커밋 하나 (`feat(m9): P2 — …`)
7. **인수인계** — 아래 절차. M9 가 끝나면 사용자에게 종료를 보고하고 다음 지시를 기다린다

## 사용자 결정·지시 (유효)

- 자격증명이 없으면 무모델까지만 실측 — 사용자에게 자격증명을 묻지 않는다
- 출력에 이모티콘을 쓰지 않는다
- (D-M9-3) 크기는 **언제나 소유자를 따른다** — 비소유자가 PTY 를 흔들지 않는다
- (D-M9-8) 재연결은 상태를 통째로 다시 받는다. 사건 재생을 넣지 않는다
- (D-M9-1) 노출 게이트는 없다. **인증은 M9 의 비목표다** — 그 자리에 세우지 마라
- (M9-B6, P3) `team` 스킬은 오케스트레이션 전용으로 못박는다 — 인수인계는 새 `migration` 스킬의 것

## 변하지 않는 규약

- **로컬 전량은 `make e2e`** (8샤드 병렬, ~7분). 판정 `unexpected 0`. 겹쳐 돌리지 마라
  (`pgrep -fl e2e-shard-run` 0 확인 뒤 `run_in_background` 하나)
- **전량이 도는 동안 제품 소스를 건드리지 마라 — Go 도 포함이다.** 목록(`web/js`·CSS·`scripts/`·
  `e2e/`)은 예시였다. 샤드마다 시작할 때 `go build` 를 하므로 그 순간 빌드가 깨져 있으면 그 샤드가
  통째로 죽는다. P1 이 그렇게 한 회차를 잃었다 (`M9_PROGRESS` §2-9). 문서는 된다
- **`make e2e-rebalance` 는 전량 직후다.** 표적 실행이 `test-results/` 의 샤드별 `report.json` 을
  덮으므로, 표적을 먼저 돌리면 리밸런스가 리포트를 찾지 못한다 (§2-10)
- **출력을 자르지 마라.** `LC_ALL=C grep -a` 로 읽어라
- 동작을 바꾸면 근거 문서를 같은 변경에서 고친다 (이전/새/이유)
- **RED 를 실제로 보아라** — `git stash push <바꾼 파일>` → 실행 → `stash pop`. P1 의 검사 하나가
  결함 위에서 초록이었고 그것을 잡은 것이 이 절차다 (`M9_PROGRESS.md` §2-4)
- **계약을 바꾸면 그 값을 `grep` 해라** — 파일이 아니라 **값**이다. P1 이 `GIT_DIFF_OPTIONS.minimap`
  을 바꾸고 그것을 못박던 기존 검사 하나를 놓쳤고, 전량이 그것을 잡았다 (§2-8). 그리고 고칠 것은
  검사만이 아니다 — 그 검사가 딛는 **다른 SRS 의 조항**도 함께 개정한다
- 새 문구는 `t('ns.key')` — ko·en 둘 다 (`check-i18n.mjs`)
- 설정 키는 `SETTINGS_SCHEMA`·`SETTINGS_ACCESS` + `helpers.js` + `index.html` + ko·en
- 오류 코드는 `apierr/codes_core.go`·`codes_doc.go` → `go run ./scripts/gen-errors` · 프론트 문장은 `err.<code>`
- 스펙에 D-… 를 더하면 `go run ./scripts/gen-decisions` · dmctl 명령을 바꾸면 `commands.md`(check-commands-docs)
- SRS 머리의 문서 상태는 **enum 안**이어야 한다 (`초안`·`승인대기`·`승인·구현중`·`승인·구현완료`·`폐기`·`대체`)
- z-index 는 층 토큰에서 온다 — 숫자 리터럴 금지 (`check-z-index.mjs`)
- 하네스를 복사하지 마라 · 에이전트 이름을 등록부 밖에 적지 마라(`check-agent-names`)
- 커밋 메시지에 AI 서명 금지
- dmctl 주의: `new-tab`/`close-tab` 은 `--help` 를 받지 않는다
- **격리 인스턴스를 멈출 때 `--port` 와 `--home` 을 함께 줘라.** 한쪽만 주면 나머지는 환경변수가
  채우고 이 워크스페이스의 환경은 언제나 **운영**을 가리킨다 — P1 이 그렇게 운영 서버를 내렸다
  (`M9_PROGRESS` §2-11). 기동 출력이 찍어 주는 `정지: …` 줄을 그대로 쓰는 것이 가장 안전하다

## 단계 종료 절차 (사용자 지시 2026-09-13 — 모든 단계에 같다)

단계의 DoD 가 서고 전량 e2e 가 `unexpected 0` 이면, 같은 세션 안에서 순서대로:

  1. 문서 갱신 — `M9_PROGRESS.md` · 스펙 §10 · 로드맵 M9 절 · **이 파일을 다음 단계의 착수
     프롬프트로 다시 쓴다** (이 절을 그대로 옮긴다)
  2. `make gates` 초록 확인 뒤 **커밋** (단계 종료 커밋 하나 — 이 지시가 그 확인이다)
  3. 인수인계 — dongminal 접합면으로 **현재 위치에 새 탭**을 열고 claude 를 띄운다:
       `dmctl new-tab -n` (`--at` 없이) → `newTabs[0]` 의 uuid·toolId
       `dmctl rename-tab --at <탭> "M9-P<n+1>"`
       `dmctl send-input --at <탭> --execute "cd '$PWD' && claude"` → `dmctl wait --at <탭> --for ready --timeout-ms 180000`
       (rc=5 면 `dmctl read-screen --at <탭>` 으로 무엇을 묻는지 보고 처리)
       `dmctl msg --to <toolId> -` 로 `[HANDOFF M9 P<n> → P<n+1>]` 엔벨로프 — 이 파일을 읽고
       진행하라는 한 문단 + 커밋 해시
       `dmctl status --at <탭>` 로 `working` 확인 (idle 이면 `send-input --execute ""`)
  4. **자기 탭을 닫는다** — `dmctl close-tab --at <자기 탭 uuid>` (`dmctl who-am-i` 의 `uuid=`).
     세션의 마지막 명령이다. P1 이 더한 `--force` 를 쓰면 확인창 없이 닫힌다
```

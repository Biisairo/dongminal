# server-driven actions — 착수 문서 (2026-11-05)

앞 세션(`리팩토링-2차`)에서 넘어온 일이다. 이 문서의 「착수 블록」 이 이번 세션의 지시 전부다.

## 착수 블록

1. `git status` 가 깨끗한지, 브랜치가 `main` 인지 본다. 직전 커밋은 이 문서를 담은 커밋이다.
2. `docs/internal/SERVER_DRIVEN_ACTIONS_SRS.md`(**승인·구현중**)를 전부 읽는다. 이것이 단일 진실 공급원이다. 결정 D-SDA-1~7 은 사용자가 정했거나 승인했다 — **다시 묻지 않는다.**
3. 항목 ID(G-·F-·K-)의 근거(file:line)는 `docs/internal/refactor/SERVER_DRIVEN_INVENTORY.md` 에 있다. ✔ 가 없는 줄은 조사 결과 그대로이므로 **쓰기 전에 코드로 다시 확인한다.** 조사가 틀린 적이 있다(§0 의 정정).
4. **묶음 M(공통 장치)부터** 시작한다. 그다음 GR → GT → GV → F → R → X → K → N. 묶음마다:
   - SRS 의 해당 FR 을 코드에 대 보고, 설계 세부(동작 ID 목록, 사유 코드, 종단 경로)를 SRS 에 먼저 적는다
   - 시험을 먼저 쓰고 **실패(RED)를 확인**한다
   - 구현(GREEN) → 커밋 전 검증 → 사용자 확인 뒤 커밋
5. SRS 와 코드가 충돌하거나 SRS 가 답하지 않는 기능 결정이 나오면 멈추고 사용자에게 **하나씩**, 권장 답과 함께 묻는다.

## 변하지 않는 규약

- **사용자의 dongminal 을 재시작하지 않는다.** 설치 트리(`$DONGMINAL_HOME/bin`)도 다시 설치하지 않는다. e2e 는 자기 격리 서버를 띄우므로 돌려도 된다.
- 커밋은 사용자 확인 뒤에만. AI 서명(`Co-Authored-By` 등) 금지. push 하지 않는다.
- 커밋 전에 `make gates` · `make lint` · `go test ./...` · `npm run -s unit` · `npm run -s typecheck` 를 통과시킨다. 바꾼 화면을 지나는 e2e 를 돌린다.
- 새 Go 패키지를 만들면 `docs/internal/architecture.md` 패키지 표에 더한다(게이트가 잡는다). SRS 의 결정을 바꾸면 `go run ./scripts/gen-decisions` 로 `decisions.md` 를 다시 만든다.
- 동작이 바뀌면 SRS 변경 기록에 **이전 동작 / 새 동작 / 이유** 를 적는다. 새 거절은 CHANGELOG 에도 적는다(R-3).
- 사용자에게는 한국어로, 쉬운 말로 설명한다. 사용자는 "왜 그렇게 하는가" 와 "다른 도구는 어떻게 하는가" 를 자주 묻는다 — 그 근거를 갖고 말한다.
- `dmctl` 레이아웃 명령에 `--help` 를 붙여 도움말을 보지 않는다. `dmctl --help` 를 쓴다.

## 앞 세션에서 끝난 것 (이번 일과 같은 갈래)

`docs/internal/refactor/PROD2.md` 가 기록이다. 커밋 `129e2a6e`~`7c252679`:
버튼 게이트 예외 표지화 · 죽은 도구 사용량 수거 · 트리 뷰 `run_changed` 좁힘(FR-ITD-7) · statusLine 허용 목록 한 벌(`internal/shared/statusline`) · window 순서 골든 · argparse 골든 잡음 · `app-cmd.js` 분할(`app-ws-sync.js`).

## 묶음 M 을 시작할 때 알아 둘 것

- 선례가 이미 있다: `/api/git/policy`(서버가 목록을 내려 줌), `/api/git/branch/validate`·`tag/validate`(입력 검증 종단), `ui-kit.js` 메뉴의 `disabled: string`(사유 문자열을 그리는 장치), `remote.js` 의 `holds()`(서버 `job.slots` 를 그림).
- 사유 코드의 ko·en 문구 게이트(FR-SDA-8)는 기존 i18n 게이트(`check-i18n`)와 오류 카탈로그 생성(`error-docs`)의 방식을 먼저 본다.
- 묶음 M 은 공통 장치만이다 — 동작 하나(예: `git.stash.create`, #10)를 끝까지 꿰어 장치를 검증하는 것이 좋다.

## 이 문서가 하지 않는 것

- 묶음의 세부 설계를 대신 정하지 않는다. 각 묶음에서 SRS 에 먼저 적는다.

# M9 — M8 이 남긴 것 + 추가 이슈

> **문서 상태**: 초안

- 문서 상태: **초안** (2026-09-14) — §2 확정(M8 유산 7 + 사용자 이슈 9). §3~§5 는 착수 세션이 재감사 뒤 채운다
- 선행: M8 완료 (`fc6db80`)
- 형식: IEEE 29148 (요구 → 결정 → 검증). 규약은 `M8_UNIFIED_SRS` 와 같다 — Spec → Test → Code,
  단계마다 전량 e2e `unexpected 0`, 동작 변경은 이전/새/이유

## 1. 목적

M8 P7 이 **사유와 함께 남긴 것**(M8_UNIFIED_SRS D-A-22·26)을 거두고, 사용자가 더한 이슈를 같은 일정에
싣는다. 착수 첫 일은 **재감사** — 아래 수치·위치는 2026-09-14 기준이며 실측으로 정정한다.

## 2. 현재 상태

### 2.1 M8 이 남긴 것

| ID | 내용 | 근거 | 규모 |
|---|---|---|---|
| M9-A1 | **GO-44 `Git *store.Store` 좁히기** — gitapi 가 `Service()`(구체 `*core.Service`)를 72곳에서 쓴다. 인터페이스로 좁혀도 git 없이 돌지 못한다. 선행은 GO-39(git 실행기 통합) — worktree·submodule·checkIgnore·jobs 가 core 의 실행 층을 어떻게 공유하는지부터 | D-A-26 ① · `01-go-arch.md` P2 "인터페이스 설계" · M8_PROGRESS §1-1 GO-44 | M |
| M9-A2 | **§5-5 flaky 군집** — `git-*` 의 관측 주기 대기(`git-observe-revive`·`git-worktrees`·`git-history`·`git-live-triggers`·`git-sidebar`)와 `slot-*` 의 그리기 대기(`slot-view-state`). 전량마다 1~8건, 단독은 초록. 두 헬퍼가 "요청이 왔는가" 를 기다리는지 "화면이 반영했는가" 를 기다리는지 판정. 판정 기준: 전량 3회 연속 flaky 0 | D-A-26 ③ · M7_PROGRESS §5-5 · M8_PROGRESS §1-14 · §2-39(반복 재현이 먼저) | M |
| M9-A3 | **`bg-kill` TC-BGK-12** — P6·P7 전량 두 번 flaky(모바일 폭 히트 영역). 군집 밖. TC-AGT-4 처럼 `--repeat-each` 로 재현부터 | M8_PROGRESS §1-12·§1-14 | S |
| M9-A4 | **GO-42 전역 테스트 훅 5 + `clientWithin`** — `t.Parallel()` 도입 패키지가 생기면 필드 주입으로. M9 에서 병렬 도입 여부를 결정(Go 테스트 직렬 시간이 근거) | D-A-22 · `05-test.md` §3.5 | S~M |
| M9-A5 | **`sandboxplace/e2e_test.go` 700~900ms 고정 대기 넷** — 컨테이너 런타임이 있는 호스트에서 `waitShellReady` 류로 | D-A-26 ⑥ | S |
| M9-A6 | **Go 테스트 `time.Sleep` 98곳** — ① 조건 대기 ② 폴링 간격 ③ 부정 단정의 관측 창으로 분류하고 ①만 옮긴다 | M8_PROGRESS §2-37 | S |
| M9-A7 | **500줄 초과 Go 파일 20** — `toolclient/client.go` 893 · `dmctl_run.go` 794 · `workspace/manager.go` 742 · `toolhub/manager.go` 711 · `run/store.go` 705 … 이동만(D-A-10 규약) | P7 재측정 | M |

M8 에서 **결정으로 닫혀** M9 범위가 아닌 것(다시 열려면 사용자 결정): 서버 오류 본문의 한국어 9곳
동결(D-ERR-2) · 레코드 없는 옛 에이전트 도구 이행 경로 · `migrate` 의 `agents.json`.

### 2.2 추가 이슈 (사용자, 2026-09-14 — 원문 그대로 요지)

| ID | 내용 (사용자 원문 요지) | 착수 시 볼 자리 (추정 — 재감사로 확정) | 규모 |
|---|---|---|---|
| M9-B1 | **최초 expose 경고** — 최초 `expose` 실행 시 IP 필터가 꺼져 있는데도 "IP 등록이 되어 있지 않아 사용할 수 없다" 는 경고가 뜬다. 경고 제거 | 접속 허용 목록(`ACCESS_ALLOWLIST_SRS`) · `httpapi/access.go` · 노출 판정(`dmenv.ExposureLabel`) · start/expose 안내 문구 | S |
| M9-B2 | **복귀 시 아래로 스크롤 안 됨** — 터미널을 나갔다 들어오면 claude code 아래에 내용이 있는데 아래로 스크롤되지 않는다. 새로고침·입력·살짝 올렸다 내리면 내려간다 | `term-pane.js` 의 재부착·재생(`TERMINAL_RESUME_SRS`) · xterm fit/scrollToBottom · 슬롯 전환 | S~M |
| M9-B3 | **렌더 깨짐** — 터미널을 오가거나 다른 기기에서 쓰고 돌아오면 위쪽 글의 렌더가 이상하다. 특히 모바일로 봤다가 컴퓨터로 돌아올 때 심하다. **여러 방향에서** 확인 | 크기 소유(리사이즈 경합 — 기기마다 cols/rows 가 다르다) · 재생 스냅샷과 리플로우 · `resizeCheck`(세션 소유) · xterm 버퍼 | M~L |
| M9-B4 | **dmctl close-tab/close-window 무대화 옵션** — 프로세스가 있으면 팝업으로 묻는다. dmctl 로 닫을 때 답(그냥 닫기 / 백그라운드로 보내기)을 미리 주고 팝업 없이 닫는 옵션 | `runtimebin/dmctl*.go` close-tab·close-window · 브라우저 `closeTab` 확인 다이얼로그(bg-kill) · `commands.md` | S |
| M9-B5 | **diff 미니맵 영역 텍스트 침범** — 스크롤 미니맵 영역에 텍스트가 겹치는데 미니맵은 보이지 않는다. 미니맵을 끄거나, 보이고 침범하지 않게 | `web/js/git/diff-view.js`(Monaco `minimap` 옵션) · 레이아웃 폭 계산 | S |
| M9-B6 | **dongminal `migration` 스킬 추가** — 현재 pane 에 새 탭을 열고 그 탭에 에이전트를 켠 뒤, 이번 세션의 작업을 이어가도록 인수인계. 이전 문서를 써도 되고 줄글로 넘겨도 된다 — 각 작업에서 하던 방식이나 더 합리적인 방식. **현재 `team` 스킬은 오케스트레이션 전용으로 못박는다** | `internal/shared/runtime/agentplugin/skills/`(team·workflow) · M8 단계 종료 절차 3·4(인수인계 dmctl 순서가 본) · `check-agent-names` | M |
| M9-B7 | **모바일 레이아웃** — 버튼이 전부 보이지 않거나, 탭 삭제/제거 버튼 위치가 이상하다 | 모바일 폭 CSS · 탭 바 · `ui-layout-defaults` 기준선 · FUI-27 | M |
| M9-B8 | **파일 검색 결과를 미니맵·스크롤바에 표시** — 파일에서 글자 검색 시 결과 위치가 미니맵과 스크롤에 보이면 좋겠다 | 편집기 찾기 패널(`EDITOR_FIND_PANEL_SRS`) · Monaco `findMatchHighlight` overview ruler/minimap 장식 | S~M |
| M9-B9 | **고아 탭·빈 창** — 도구만 지워지고 탭이 남거나, 탭이 다 지워지고 창만 남는 문제 | 탭/도구 수명(FR-EM-14 · workspace `clean()`) · 탭 닫기 경로 · 마지막 탭 닫힘의 창 제거 · 409 재채택(FR-RUN-6d 사례) | M |

## 3. 요구사항

(§2 확정 후 작성. 항목마다 FR-M9-n · DoD · 검증)

## 4. 일정 (단계)

(§2.2 확정 후 작성. 재감사 → 단계별 Spec→Test→Code → 전량 e2e)

## 5. 설계 결정

(D-M9-n)

## 6. 검증

- `go test -race -shuffle=on -count=1 ./...` · `make gates` · `make unit` · `make e2e` → `unexpected 0` → `make e2e-rebalance`
- M9-A2 는 전량 3회 연속 flaky 0

## 7. 비목표

- M8 에서 결정으로 닫힌 셋(§2.1 끝)

## 10. 변경 기록

| 날짜 | 내용 |
|---|---|
| 2026-09-14 | 초안 — M8 P7 이 남긴 것(M9-A1~A7) + 사용자 이슈 9건(M9-B1~B9) |

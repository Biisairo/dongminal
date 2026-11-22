# 프로덕션 리팩토링 2차 — 착수 문서 (2026-11-05)

앞 세션(`issue-agent-skill`)에서 넘어온 일이다. 이 문서의 「착수 블록」 이 이번 세션의 지시 전부다.

## 착수 블록

1. `git status` 가 깨끗한지, 브랜치가 `main` 인지 본다. 직전 커밋은 이 문서를 담은 커밋이다.
2. 아래 「사용자의 요청」 을 전부 읽는다.
3. **같은 요청으로 한 전수 감사가 이미 있다.** `docs/internal/refactor/README.md` 와 그 표의 문서들(2026-09-20, 기준 커밋 `ba13ec92`, 214건)을 먼저 읽는다. 그 감사가 정한 것과 이후 SRS 들이 이미 처리한 것은 다시 하지 않는다. 이번 세션은 **그 뒤의 변화분**을 본다.
4. 사용자는 "조금만" 진행하자고 했다. 분석·수정을 시작하기 전에 **범위를 사용자에게 하나만 묻는다**(쉬운 말 설명 → 선택지 표 → 권장 → AskUserQuestion). 권장안: 「이번 달 추가된 코드(아래 후보 목록의 자리)부터 분석하고, 결과를 보고 다음을 정한다」.
5. 분석 결과는 저장소 안 문서 하나로 남긴다. 성능 개선 후보와 「문서에는 있으나 미구현·미흡·잘못」 은 **따로 모은 절**로 둔다(요청의 마지막 두 항목).
6. 수정은 사내 규정대로 한다: 중·대 규모는 SRS(IEEE 29148) → 시험(RED) → 구현. 소규모는 작업 이해 · 가정 · 검증 계획을 말한 뒤 바로.

## 사용자의 요청 (원문)

> 리팩토링을 및 잔여 작업 분석을 시작할거야. 아래 로직을 따라서 진행해줘.
> 하드코딩 제거
> 중복로직 제거
> 상수 분리
> 쓸데없는 복잡한 로직 단순화
> 너무 큰 함수, 클래스 분할
> 충분한 추상화
> 비슷한 로직 모아서 하나의 클래스로 전환
> 사람의 가독성을 고려한 코드로 수정
> 성능상 개선이 가능한 부분은 모아놨다가 한번에 처리할 수 있게 분석하면서 정리해줘.
> 문서, 기록에는 있으나 구현이 되지않았거나 구현이 미흡하거나, 구현이 잘못된 경우도 정리해줘.
> 모든 과정은 제품을 프로덕선 레벨로 올리기 위함이야.

## 변하지 않는 규약

- **사용자의 dongminal 을 재시작하지 않는다.** 지금 떠 있는 서버는 옛 바이너리이고, 사용자는 지금 재시작할 수 없다. 설치 트리(`$DONGMINAL_HOME/bin`)도 다시 설치하지 않는다. e2e 는 자기 격리 서버(`e2e/global-setup.ts`)를 띄우므로 돌려도 된다.
- 커밋은 사용자 확인 뒤에만. 커밋 메시지에 AI 서명(`Co-Authored-By` 등)을 넣지 않는다. push 하지 않는다.
- 사용자에게는 한국어로만, 한 번에 하나씩 묻는다.
- 커밋 전에 `make gates` · `make lint` · `go test ./...` · `npm run -s unit` 을 통과시킨다.
- dmctl 레이아웃 명령에 `--help` 를 붙여 도움말을 보지 않는다(이전 판에서 실제로 실행됐다 — 이번 작업으로 고쳤지만 설치된 옛 바이너리는 그대로다). `dmctl --help` 를 쓴다.

## 이번 달에 들어온 것 (변화분의 중심)

`docs/internal/ISSUE_AGENT_TREE_SRS.md`(승인·구현중) 와 그 커밋들: `9ebf3910` · `dd19ee1c` · `d818eaf8` · `eade7d9b` · `a3f45d86`.

| 묶음 | 자리 |
|---|---|
| G window 그룹 · O 순서 명령 | `web/js/core/window-order.js` · `web/js/core/app-groups.js` · `web/js/ui/sidebar-tabs.js` · `internal/helper/runtimebin/dmctl_order.go` · `dmctl_listworkspace.go` · `internal/webserver/hub/commands.go`(`awaits`) |
| S statusLine 프록시 | `internal/helper/runtimebin/dmctl_statusline.go` · `internal/webserver/httpapi/handlers_usage.go` · `domain/run/store_context.go`(`WindowOfficial`) |
| T 명령 | `internal/shared/runtime/agentplugin/commands/issue-tree.md` |
| X · D · U | team·workflow 삭제 · `handlers_runs_tree.go` · `web/js/ui/run-tree.js` · `domain/run/store_write.go`(트리 중복 방지) |

SRS 의 「남은 것」: TC-SLP-6(Windows 셸 실측) · FR-WGR-25 키보드 조작 e2e · TC-IAT-3 시범.

## 앞 세션이 작업하며 본 후보 (검증 전 — 그대로 받지 말고 확인한다)

| 분류 | 후보 | 근거 |
|---|---|---|
| 중복 로직 | 그룹 순서 규칙이 두 벌이다: JS `winOrderItems`(`window-order.js`) 와 Go `windowPositions`(`dmctl_listworkspace.go`). 언어가 달라 공유할 수 없으면 같은 표본으로 두 쪽을 시험하는 골든을 둘 만하다 | 앞 세션 구현 |
| 중복 로직 | statusLine 허용 목록이 두 벌이다: `slFields`(`dmctl_statusline.go`) 와 `toolUsage` 구조체(`handlers_usage.go`) | 앞 세션 구현 |
| 하드코딩 · 취약 | `scripts/check-button-kit.mjs` 의 예외표가 **줄 번호**(`web/index.html:354`)로 등록돼 있다. `index.html` 에 위쪽 줄을 하나 더하면 게이트가 깨진다(앞 세션에서 실제로 깨졌다) | 앞 세션 실측 |
| 시험 잡음 | `testdata/argparse.golden` 이 플래그 구조체의 덤프라, 플래그 하나를 더할 때마다 수십 줄이 바뀐다(`-update-arg-golden`) | 앞 세션 실측 |
| 큰 파일 | `web/js/core/app-cmd.js` 805줄. 500줄 초과 파일 기준선 18(FR-STR-40) | `make gates` |
| 성능 | 도구별 사용량 저장(`usageStore`)은 도구가 죽어도 지우지 않는다 | 앞 세션 구현 |
| 성능 | 트리 대시보드는 `run_changed` 가 오면 트리 뷰를 모두 다시 받는다(그 Run 이 같은 트리인지 보지 않는다) | `runs-panel.js` `_onRunChanged` |
| 미흡 | Windows 에서 statusLine 하위 명령 실행(`platform.Current().Shell.RunCommand`)을 실측하지 않았다 | SRS TC-SLP-6 |

## 이 문서가 하지 않는 것

- 범위를 대신 정하지 않는다. 착수 블록 4에서 사용자에게 묻는다.
- 위 후보를 확정하지 않는다. 분석의 출발점일 뿐이다.

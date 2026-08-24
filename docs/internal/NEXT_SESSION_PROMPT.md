# 다음 세션 프롬프트

진행 중인 트랙이 **둘**이다. 하려는 쪽의 블록을 새 세션 첫 메시지로 그대로 붙여넣는다.

| 트랙 | 남은 작업 | 인계 문서 |
|---|---|---|
| ~~1. 사용자 확인 피드백~~ | **완료** — 8개 항목 전부. iOS 실기기 수동 확인만 남음 | [USER_CHECKLIST_FIXES_HANDOFF.md](./USER_CHECKLIST_FIXES_HANDOFF.md) |
| **2. AI 오케스트레이션** | 요구 3 — `RUN_ORCHESTRATION_SRS` 작성 + 구현 | [ENTITY_MODEL_HANDOFF.md](./ENTITY_MODEL_HANDOFF.md) |

**트랙 1 은 완료됐다.** 남은 것은 트랙 2 하나이며, 규모가 크고 착수 전 결정
(worktree 격리 정책)이 남아 있다.

**트랙 1 에서 유일하게 남은 것은 사용자의 iOS 실기기 확인이다** (묶음 F,
`test-checklist.md` C11.8~C11.10). 자동 검증으로 대체할 수 없다 — Playwright 의
`webkit` 프로젝트조차 가상 키보드를 띄우지 않는다. 코드 작업은 없다.

---

## 트랙 1 — 사용자 확인 피드백: **완료**

붙여넣을 프롬프트는 없다. `user_checklist.md` 8개 항목이 전부 닫혔다.

| 묶음 | 커밋 |
|---|---|
| A 백그라운드 UI 일관화 | `eec0ddd` |
| B 마이그레이션 진입점 | `e6463e1` |
| C 모바일 키바 터치 | `18c7f14` |
| D 복귀 대상 Pane 지정 | `a906418` |
| E 크로스 기기 창 포커스 | `854ada6` |
| F 모바일 키보드 뷰포트 | `cb4cc8c` |

남은 것은 **사용자의 iOS 실기기 수동 확인** 하나다 (`test-checklist.md`
C11.8~C11.10). 특히 묶음 F 의 보정이 Safari 와 진동하지 않는지 — 진동이 관측되면
폴백은 `scroll` 리스너에서의 보정 감쇠이고, 그 판단 근거는
`USER_CHECKLIST_FIXES_HANDOFF.md` §2 묶음 F 절에 있다.

이 트랙에서 나온 **함정 15개**는 `USER_CHECKLIST_FIXES_HANDOFF.md` §4 에 있다.
트랙 2 착수 전에 읽어라 — 특히 13(브라우저 기본값은 바뀐다)·14(레이아웃 가설은
측정으로 확인)·12(Serena 가 `web/js/` 를 편집할 수 없다)는 묶음에 무관하게 유효하다.

---

## 트랙 2 — AI 오케스트레이션: 요구 3

```
dongminal 의 요구 3(AI 오케스트레이션)을 진행한다. 요구 1(구조·네이밍)과
요구 2(백그라운드)는 완료됐다.

**먼저 이 두 문서를 읽어라. 순서대로.** (개발자 문서 전체 색인은
`docs/internal/README.md`, 완료된 과거 SRS·RFC 는 `docs/internal/archive/` 에
있고 갱신하지 않는다.)

1. `docs/internal/ENTITY_MODEL_HANDOFF.md` — 인계 문서. 확정된 모델, P1~P8 완료
   내역, 반복하면 안 되는 함정 7개, 검증 방법
2. `docs/internal/ENTITY_MODEL_RESTRUCTURE_SRS.md` — 요구 1·2 의 단일 진실
   공급원 (IEEE 29148). §7 에 요구 3 의 조사 결론과 Orca 대비표가 있다

**현재 상태**

- P1~P8 완료. `go build`·`go test`·`go vet` 전부 깨끗, `gofmt -l` 0건
- Playwright **161 통과** (프로젝트 2개: `chromium` 151 + `mobile-touch` 10)
- 확정 모델: 공간 축 `Client ▶ Window ─ Pane ─ Tab ─ Tool`,
  실행 축 `Run ─ Member ──1:1──▶ Tool` (직교, 접합 필드만 구현됨)
- 도구 타입은 `terminal` 과 `editor` 두 가지다. code-server 통합과 markdown
  뷰어는 `8dc0a3f` 에서 제거됐다
- **별 트랙 user_checklist 는 A~F 전부 완료됐다.** 상태바·백그라운드 모달·
  모바일 키바 터치·`detach --restore --at`·크로스 기기 포커스·모바일 키보드
  뷰포트가 그 결과다. `docs/internal/USER_CHECKLIST_FIXES_HANDOFF.md` 에 함정
  15개와 함께 정리되어 있다
- **묶음 E 가 `internal/server` 와 포커스 소유권을 바꿨다 (`854ada6`).** 창 포커스
  소유권이 `BroadcastChannel` → 서버 권위(`internal/server/focus.go`)로 옮겨졌고,
  `/api/focus`·`/api/focus/claim`·SSE `window_focus`·`/api/commands/sse?clientId=`
  가 신설됐다. 요구 3 의 `Client ▶ Window` 축을 만질 때 이 상태를 모르고 시작하지
  마라 — `ENTITY_MODEL_RESTRUCTURE_SRS` 의 비목표 "다중 창 포커스 소유권 부채
  정리" 는 이제 **부분 해소** 로 갱신되어 있다

**이번 세션의 작업**

`RUN_ORCHESTRATION_SRS` 를 IEEE 29148 로 새로 작성하고 구현한다.

**착수 전에 반드시 해소할 결정** (인계 문서 §4.3):

worktree 격리는 팀원 간 파일 공유를 차단한다. 격리 여부를 **Run 단위로 선택**하게
할지(공유 협업과 격리 fan-out 이 모두 가능, 두 실행 모드를 유지해야 함) 아니면
**항상 격리하고 통신 채널만으로 협업**하게 할지(기존 `dongminal-team` 의 일부
토폴로지가 성립하지 않게 됨). 이 결정 전에 구현하지 마라.

**사용자 결정 (기존)**: "Orca 의 장점을 최대한 모방. 동작뿐 아니라 **실제 구현(MIT
공개 소스)도 참고**." 도입 대상 — worktree 격리, fan-out→비교→병합, diff 인라인
주석 리뷰, 태스크 연동, Run 의 실행 실체. dongminal 의 `send_agent_message` 신뢰
채널 기반 협업 토폴로지는 Orca 에 없는 축이므로 제거하지 않고 병존시킨다.

접합면은 이미 있다 — `Tool.runId` / `Window.ownerRunId` / `run.Projection`
(`internal/run/run.go`, FR-EM-17/18). 이 필드들은 없거나 비어 있어도 정상 동작한다.

**스킬 재작성도 이 SRS 범위다.** `skills/dongminal-team` 은 현재 팀을 별도 공간에
만들지 않고 팀장의 Pane 을 쪼개므로 사용자 작업 공간을 침범하고, 그 방어 규칙이
스킬 문서의 절반을 차지한다. 어휘·계약은 P8 에서 이미 맞춰 실행 가능한 상태이니
(`e2e/skill-contract.spec.ts` 가 검증) 토폴로지만 재설계하면 된다.

**작업 규약**

- 중·대 규모는 스펙 → 테스트 → 코드 순서를 지킨다. 신규 동작은 RED 를 먼저 확인한다
- 일괄 정규식 치환 전에 인계 문서 §6 의 함정 1~4 를 다시 읽어라. 스키마 값·와이어
  키·마이그레이션 코드·TS 타입 주석이 매번 침범당했다
- 심볼 작업은 LSP → Serena → CLI 순. `gopls` 가 PATH 에 없으면
  `ln -sf ~/go/bin/gopls ~/.local/bin/gopls`
- 커밋은 사용자 확인 후에만. 커밋 메시지에 AI 서명 금지
- e2e 결과가 이상하면 코드를 의심하기 전에 PTY 를 확인하라:
  `ps -eo tty | awk '$1 ~ /^ttys/' | sort -u | wc -l` (상한 511)

**아직 남은 별건**

사용자 인스턴스(`~/.dongminal`)는 여전히 v1 이고 구 바이너리가 돌고 있다.
업그레이드 순서는 인계 문서 §4.2 에 있다 (`./scripts/migrate.sh` 가 진입점이다).
**직접 마이그레이션하거나 재기동하지 마라.**
```

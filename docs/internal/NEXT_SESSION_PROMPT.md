# 다음 세션 프롬프트

진행 중인 트랙이 **둘**이다. 하려는 쪽의 블록을 새 세션 첫 메시지로 그대로 붙여넣는다.

| 트랙 | 남은 작업 | 인계 문서 |
|---|---|---|
| **1. 사용자 확인 피드백** | 묶음 E(크로스 기기 포커스) · F(모바일 키보드 뷰포트) | [USER_CHECKLIST_FIXES_HANDOFF.md](./USER_CHECKLIST_FIXES_HANDOFF.md) |
| **2. AI 오케스트레이션** | 요구 3 — `RUN_ORCHESTRATION_SRS` 작성 + 구현 | [ENTITY_MODEL_HANDOFF.md](./ENTITY_MODEL_HANDOFF.md) |

트랙 1 이 사용자 실사용에서 나온 항목이라 우선순위가 높다. 트랙 2 는 규모가 크고
착수 전 결정(worktree 격리 정책)이 남아 있다.

---

## 트랙 1 — 사용자 확인 피드백: 묶음 E·F

```
dongminal 의 user_checklist 대응에서 묶음 E(크로스 기기 창 포커스)와
F(모바일 키보드 뷰포트)를 진행한다. 묶음 A~D 는 완료됐다.

**먼저 이 세 문서를 읽어라. 순서대로.** (개발자 문서 전체 색인은
`docs/internal/README.md`, 완료된 과거 SRS·RFC 는 `docs/internal/archive/` 에
있고 갱신하지 않는다.)

1. `docs/internal/USER_CHECKLIST_FIXES_HANDOFF.md` — 인계 문서.
   A~D 완료 내역, **반복하면 안 되는 함정 9개**(전부 이번 작업에서 실제로 밟은
   것이다), 검증 방법, 미해결 항목
2. `docs/internal/USER_CHECKLIST_FIXES_SRS.md` — 단일 진실 공급원 (IEEE 29148).
   §2.7 이 E 의 근본 원인, §2.8 이 F 의 근본 원인. §3.5/§3.6 은 **골격만** 이다
3. `docs/internal/USER_CHECKLIST_FIXES_PLAN.md` — §6 에 착수 전 해소할 결정
   10건(E 5건 + F 5건)과 각각의 권장안

**현재 상태**

- 묶음 A~D 완료. 커밋 `9c3b87c`(스펙) `eec0ddd`(A) `e6463e1`(B) `18c7f14`(C) `a906418`(D)
- `go build`·`go vet`·`go test` 전부 깨끗, `gofmt -l` 0건
- Playwright **142 통과** — 프로젝트가 둘이다: `chromium`(Desktop Chrome,
  `-touch.spec.ts` 제외) 132 + `mobile-touch`(Pixel 7, `hasTouch:true`,
  `-touch.spec.ts` 전용) 10
- `bash scripts/test_migrate.sh` 28 통과

**이번 세션의 작업**

묶음 E 와 F 는 **둘 다 리스크 HIGH 이고 스펙이 골격만 있다.** 구현 전에 결정을
해소하고 FR-XDF-* / FR-MKV-* 를 확정하라. 하나씩 진행한다 — E 와 F 를 동시에
건드리지 마라.

**E 착수 전 반드시 해소할 결정** (PLAN §6.1):

`BroadcastChannel` 을 서버 경유로 옮기는 것은 방향이 정해져 있다. 남은 것은
소유권 상태의 권위 위치, 해제 트리거, 기존 채널 병행 여부, `_resizeCheck` 동반
이전 범위, README TODO("focused browser 자동 동기화") 포함 여부다. 각각 권장안이
PLAN 에 있으니 사용자와 확인하고 확정하라.

E 가 위험한 이유: 같은 상태를 `_resizeCheck`(`app.js:1699`)가 **PTY 리사이즈 권한**
판정에 쓴다. 소유권 오판은 표시 문제가 아니라 터미널 크기 깨짐이다.

**F 착수 전 반드시 해소할 결정** (PLAN §6.2):

높이 권위를 visual viewport 로 옮기는 방식, iOS 강제 스크롤 상쇄 방법,
`interactive-widget=resizes-content` 추가 여부, 줄일 대상 범위, 검증 수단.

F 가 위험한 이유: 레이아웃 높이의 단일 진실 공급원(`html,body{height:100%}`,
`style.css:14`)을 교체하므로 데스크톱 경로까지 영향한다. **iOS 실기기 수동 확인이
필수다** — Chromium 에뮬레이션으로 iOS 의 layout viewport 고정 거동을 재현할 수
없다. 기존 `e2e/mobile-keybar.spec.ts` 의 `TC-A1`~`TC-A4` 는 수치만 검증하므로
높이 체계를 바꾸면 동반 개정 대상이다.

**작업 규약**

- 중·대 규모는 스펙 → 테스트 → 코드 순서를 지킨다. 신규 동작은 **RED 를 먼저
  확인한다.** 구현을 먼저 했다면 `git stash push <file>` 로 되돌려 실패를 확인하라
  — 이 방법으로 묶음 D 의 첫 테스트가 결함을 못 잡는다는 것을 발견했다
- 인계 문서 §4 의 함정 9개를 착수 전에 읽어라. 특히 6(순서 의존 선택자),
  7(`hasTouch:false` 에서 `touchstart` 미발동)은 E·F 에서도 그대로 유효하다
- 터치·모바일 동작은 `mobile-touch` 프로젝트에서 검증한다. 새 터치 스펙은
  파일명을 `*-touch.spec.ts` 로 해야 그 프로젝트가 집어간다
- 심볼 작업은 LSP → Serena → CLI 순. `gopls` 가 PATH 에 없으면
  `ln -sf ~/go/bin/gopls ~/.local/bin/gopls`
- 커밋은 사용자 확인 후에만. 커밋 메시지에 AI 서명 금지
- e2e 결과가 이상하면 코드를 의심하기 전에 PTY 를 확인하라:
  `ps -eo tty | awk '$1 ~ /^ttys/' | sort -u | wc -l` (상한 511)

**건드리면 안 되는 것**

- 리포 루트의 `./dongminal` — 실행 중인 서버(17일째)의 실행 파일이다. 테스트가
  삭제·재빌드하면 운영 인스턴스를 바꾼다. 격리 산출물을 써라
- `~/.dongminal` — 여전히 v1 스키마다. **직접 마이그레이션하거나 재기동하지 마라.**
  절차는 인계 문서 §6 에 있고 사용자 판단이다
```

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
- Playwright **142 통과** (프로젝트 2개: `chromium` 132 + `mobile-touch` 10)
- 확정 모델: 공간 축 `Client ▶ Window ─ Pane ─ Tab ─ Tool`,
  실행 축 `Run ─ Member ──1:1──▶ Tool` (직교, 접합 필드만 구현됨)
- 도구 타입은 `terminal` 과 `editor` 두 가지다. code-server 통합과 markdown
  뷰어는 `8dc0a3f` 에서 제거됐다
- **별 트랙으로 user_checklist 묶음 A~D 가 완료됐다.** 상태바·백그라운드 모달·
  모바일 키바 터치·`detach --restore --at` 이 그 결과다. 묶음 E·F 는 미착수이며
  `docs/internal/USER_CHECKLIST_FIXES_HANDOFF.md` 에 인계되어 있다

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

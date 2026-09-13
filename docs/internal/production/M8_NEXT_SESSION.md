# M8 통합 — 다음 세션 착수 프롬프트 (P1 Go 부채 ①~④ + `TEST-8`)

아래 블록을 새 세션에 그대로 붙여넣으면 된다.

**P0 스파이크는 끝났다** (2026-09-13, `M8_PROGRESS.md` §1). 스펙 §9.1 이 실측으로
채워졌고 §9.3 에 산출물 ①~⑤·충돌 플래그 ⑥ 이 있다. **사용자 판단 대기 셋**(FR-APS-10
정정 · D-U-4 정정 · FR-AGT-11·12 확인)은 P1 을 막지 않는다 — P1 은 축 A 다. 다만 P1 ④의
`GO-46`(`ToolHub` 인터페이스)은 §9.3 ④·⑤ 를 전제로 설계한다.

---

```
프로젝트: /Users/dykim/personal/dongminal

M8 통합의 P0 스파이크가 끝났고 이 세션은 **P1 = 축 A ①~④ + `TEST-8`** 이다
(`docs/internal/M8_UNIFIED_SRS.md` §3.2·§4). 스펙 → 테스트(RED) → 구현(GREEN).
전량 e2e 는 단계 끝에 1회. 이 단계가 minor 릴리스 하나다 (로드맵 §6-2).

## 먼저 읽을 것 (순서대로)

1. `docs/internal/M8_UNIFIED_SRS.md` — §2.1(축 A 표) · §3.2(①~④·⑦ 과 DoD 원문) ·
   §9.3 ④(데몬 파이프 중계 — `GO-46` 이 딛는다) · §9.3 ⑤(D-U-4 판정)
2. `docs/internal/production/M8_PROGRESS.md` — P0 가 배운 것 §2
3. `docs/internal/architecture.md` §"프로세스 역할 넷" · §"패키지 레이아웃"(`:49-116`,
   `GO-48` 의 대상) · §"동시성" · §"종료 경로"
4. `docs/internal/production/07-production-gap.md` 와 `01-go-arch.md` 의 `GO-4~13`·
   `GO-29~35·37·42`·`GO-44~47` 원문 — **감사 항목을 결함이라 단정하지 마라**
   (M2 의 교훈: 다섯 중 넷이 이미 닫혀 있었다). 그 자리의 SRS 를 먼저 열어라
5. `internal/webserver/toolclient/client.go` (`GO-5` 의 `OnOutput/OnExit`) ·
   `internal/shared/toolhub/tool.go` (`GO-7` `readPTY`) · `internal/daemon/ipc/paned.go`

## 사용자 결정 (바꾸지 않는다)

  D-U-2·D-U-3·FR-U-4  P0 인계서 그대로
  FR-U-7  ①~④ 가 축 C 의 선행이다 — 축 C 가 이 자리를 다시 고치지 않는다
  P0 판정 ④  데몬 중계는 바이트 길 하나 — `ToolHub` 인터페이스에 종류별 메서드를
          두지 않는다 (사용자 확인 대기이나, 반대 결정이 나도 인터페이스가
          바이트 지향인 것은 같다)

## P1 — 할 일 (순서 고정, 스펙 §3.2)

  ① 경계·문서   GO-4 (`go list -deps` 경계 테스트, 위반 4곳 해소 또는 예외 등록부,
                 `architecture.md:113` 정정) · GO-48 (패키지 표 = `go list ./...`, CI 0 불일치)
  ② 레이스·리소스  GO-5 (`SetOnOutput/SetOnExit`, 필드 비공개, 배선 레이스 테스트) ·
                 GO-7 (`readPTY` recover 뒤 `kill`+`onExit`, 패닉 주입 테스트) ·
                 GO-29~35·37·42 (동시성 9건 — DoD 문장 하나씩)
  ③ 컨텍스트·전역상태  GO-9 (`httpapi` 전역 → `Server` 필드, 두 서버 동시 기동 테스트) ·
                 GO-12 (요청 경로 `time.Sleep` 0 — 6곳 → `select{<-ctx.Done()}`) ·
                 FBE-01 서버측 · GO-40·41
  ④ 타입·인터페이스  GO-13 (`ToolHub.List() []ToolInfo`, 형 단언 0) · GO-6 (데몬 `has`
                 RPC 또는 TTL 캐시) · GO-44~47 (좁은 인터페이스 `RunStore`·`WorktreeManager`·
                 `GitQuery`, `SettingsStore`, **`GO-46` `ToolHub` 인터페이스 — §9.3 ④⑤ 전제**) ·
                 FBE-05/12 (데몬 모드 kill 유예 3초)
  ⑦-일부 TEST-8  고정 `time.Sleep` 94회/25파일 → 틱 주입·`waitFor`. ④ 와 함께 —
                 축 C 의 V-1 이 그 위에 선다
  DoD 는 스펙 §3.2 의 불릿 그대로. `go test -race -shuffle=on -count=1 ./...` 통과가
  ② 의 판정이다.

## 착수 규약

- 항목마다 **먼저 실측**: 감사가 적은 줄 번호는 낡았다(2026-09-09). 그 자리를 열어
  아직 그런지 본다. 이미 닫힌 것은 "확인" 으로 적고 지나간다
- 스펙 §3.2 의 DoD 문장이 곧 테스트다 — RED 를 먼저 본다
- `architecture.md` 를 고치면 같은 커밋에서 (동작을 바꾸면 그 근거 문서를)
- `GO-46` 설계는 §9.3 ④(non-droppable `output`, stderr 스트림, `create{kind,argv}`,
  `resize`·`paste` 무동작)를 **받아들일 수 있는 모양**이어야 한다 — 지금 구현하지는
  않는다 (축 C 의 몫)
- 진행 기록은 `M8_PROGRESS.md` §2 에 이어 쓴다 (M7 형식: "무엇이 바뀌었나" 절 하나에
  배운 것 하나)

## 변하지 않는 규약

- **로컬 전량은 `make e2e`** (8샤드 병렬, ~4.5분). 판정은 `unexpected 0`. 전량은
  **단계마다 1회** — 항목마다 돌리지 않는다
- **출력을 자르지 마라.** `LC_ALL=C grep -a` 로 읽어라. 합성 명령의 종료코드는
  로그 파일의 `종료코드` 줄을 읽어라
- **전량이 도는 동안 `web/js`·CSS·`scripts/`·`e2e/` 를 고치지 마라**
- **전량을 겹쳐 돌리지 마라** · **재시동은 하지 않는다** · `--isolated`
- `make e2e-rebalance` 는 전량 직후·표적 전에
- 중·대 규모는 **스펙 → 테스트(RED) → 구현(GREEN)**
- **동작을 바꾸면 그 근거 문서를 같은 변경에서 고쳐라** (이전/새/이유)
- 게이트를 세우면 **탐침으로 검출을 확인하고 지운다** · Makefile 과 `verify.yml` 둘 다
- **하네스를 복사하지 마라** — 새 단정은 그 설정이 이미 있는 자리에
- **기준선 JSON(`e2e/baseline/ui-layout.json`)은 클래스 목록을 키로 쓴다**
- `decisions.md` 는 생성물이다. `D-*` 를 더하면 `go run ./scripts/gen-decisions`
- 설정 키를 더하면 `SETTINGS_SCHEMA`·`SETTINGS_ACCESS` 둘 다, TC-CFG-4 의 개수
- 에이전트 이름을 등록부 밖에 적지 마라 (`check-agent-names`)
- 커밋 메시지에 AI 서명 금지. 커밋은 사용자 확인 후에만
```

---

## 지금 저장소의 상태 (2026-09-13, P0 종료)

| 항목 | 값 |
|---|---|
| 마일스톤 | M0~M3·M5·M6·M7 완료 · M4 미수행(결정 9) · **M8 P0 완료 · P1 착수 전** |
| SRS | `M8_UNIFIED_SRS` 승인·구현중 — §9.1 실측 완료 · §9.3 신설 · FR-AGT-11·12 추가 · **FR-APS-10·D-U-4 정정 대기** |
| 실측 바이너리 | claude 2.1.270 · codex 0.154.0 · omp 17.4.0 (프레임 원본 `/tmp/m8-spike/`, 저장소 밖) |
| 제품 코드 | **변경 0** (P0 규약) |
| 게이트 · e2e | P0 가 건드리지 않았다 — M7 종료 시점 그대로 (게이트 33 초록 · e2e 1,642 항목 unexpected 0) |

## 사용자 판단 대기 (P1 착수를 막지 않는다)

| # | 무엇 | 어디 |
|---|---|---|
| 1 | FR-APS-10 정정 — MCP 서버 대신 `--permission-prompt-tool stdio` | 스펙 §9.3 ⑥ F-1 |
| 2 | D-U-4 정정 — "새 종류" → "변형 + `Kind`" | 스펙 §9.3 ⑤ |
| 3 | FR-AGT-11·12 확인 — 로그인·모델 전환을 UI 로 · 동시 접근은 창 포커스 소유 | 스펙 §3.4.2 |

## 이 인계를 만든 세션의 커밋 (P0)

```
75e1d83  docs(m8): P0 스파이크를 닫는다 — §9.1 실측·§9.3 산출물·FR-AGT-11/12·P1 인계
```

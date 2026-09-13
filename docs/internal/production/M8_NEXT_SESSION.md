# M8 통합 — 다음 세션 착수 프롬프트 (P0 스파이크)

아래 블록을 새 세션에 그대로 붙여넣으면 된다.

**M8 통합은 착수 전이다** (2026-09-13). 스펙 `docs/internal/M8_UNIFIED_SRS.md` 가
`승인·구현중` 이고, 첫 단계는 **P0 스파이크** — 코드를 만들지 않고 실측으로
스펙의 빈칸(§9.1 U-1~U-10)을 메우는 한 세션이다.

---

```
프로젝트: /Users/dykim/personal/dongminal

M7 이 끝났고(M7_PROGRESS §6) M8·M9·M10 이 **M8 통합** 하나가 됐다. 스펙은
`docs/internal/M8_UNIFIED_SRS.md` (승인·구현중). 이 세션은 **P0 스파이크**다 —
실측만 하고 제품 코드는 고치지 않는다. 산출물은 스펙 §9.1 의 빈칸을 채운 표와
P1 이 딛을 설계 시안이다.

## 먼저 읽을 것 (순서대로)

1. `docs/internal/M8_UNIFIED_SRS.md` — 전부. 특히 §1.1(왜 하나의 일정인가) ·
   §3.1(FR-U-1~7, 통합 원칙) · §4(단계) · §5(D-U-1~10) · §9.1(U-1~U-10)
2. `docs/internal/AGENT_PROTOCOL_SURFACE_SRS.md` — 대체됐지만 §2.4 의 claude
   stream-json **실측 프레임 표**가 여기 있다 (2.1.269 기준)
3. `internal/shared/agentadapter/adapter.go` — `Adapter` 구조체(143행~)와
   `Report`·`Signals`·`Readiness`. 프로토콜 필드는 **이 구조체에 함께** 든다 (FR-U-2)
4. `docs/internal/production/PRODUCTION_ROADMAP.md` §M8 · §1.5 지도
5. `docs/internal/production/M7_NEXT_SESSION.md` 의 "변하지 않는 규약" 과
   `M2_NEXT_SESSION.md` 의 "비싸게 배운 것"

## 사용자 결정 (바꾸지 않는다)

  D-U-2  어댑터가 인터페이스다 — 같은 `Adapter` 우선, 불가하면 GUI 용 어댑터를
         같은 등록부에. 소비자는 어떤 에이전트든 같다
  D-U-3  병행 — 터미널 도구의 훅·idle·전사본 추정은 한 줄도 바뀌지 않는다
  FR-U-4 에이전트 도구는 TUI 의 어떤 기능도 막지 않는다 — 프로토콜에 없는 것은
         TUI 출구(같은 세션을 터미널 탭으로)
  D-U-4  에이전트 도구는 새 도구 종류다 — 단 P0 가 "전송만 다른 변형" 이 `ToolHub`
         인터페이스(GO-46)에 더 싼지 판정하면 정정될 수 있다

## P0 스파이크 — 할 일

**실측 U-1~U-10** (스펙 §9.1). 추측해 채우지 않는다 — 확인 못 한 칸은 "미확인" 으로
남기고 무엇을 해 봤는지 적는다.

  U-1  omp `--mode rpc-ui` 의 실제 프레임 형식 · `extension_ui_request` payload
  U-2  codex app-server 한 프로세스가 여러 thread 를 드는가
  U-3  claude `--permission-prompt-tool` 의 호출 규약 — MCP 도구 서버가 필요한가,
       스키마는 무엇인가 (FR-APS-10 의 범위를 정한다)
  U-4  세 프로토콜의 세션 재개 절차와 재개 시 이벤트가 어디부터 오는가
  U-5  omp 의 사용량·컨텍스트 창이 프레임에 실리는가
  U-6  claude `--bg`/`claude attach` 가 휴면에 쓸 수 있는가
  U-7  세 프로토콜의 종료 절차 (ExitCommand 를 대신할 것)
  U-8  데몬 모드에서 파이프 셋을 IPC 로 중계하는 비용 — PTY 바이트 중계와
       **같은 길**로 갈 수 있는가 (§9.2 R-g)
  U-9  **기능 대조표** — 에이전트 셋 × TUI 기능(로그인 · 설정 · 모델 선택[기동/
       세션 중] · 권한/plan 모드 전환 · 슬래시 명령 · 스킬/플러그인 · /compact ·
       /clear · MCP 서버) × (프로토콜 / 파일 / TUI 출구). **이 표가 FR-U-4 의 근거**
  U-10 세 TUI 의 자체 알림 시퀀스 (claude preferredNotifChannel=terminal_bell ·
       codex tui.notifications · omp) — 훅을 못 까는 환경의 보조 채널 후보

**산출물** (스펙 §4 P0 행):
  ① 기능 대조표 (U-9)
  ② 가짜 에이전트 픽스처 판정 — 세 프로토콜을 말하는 작은 Go 프로그램이 CI·e2e
     의 V-1~V-3·V-5·V-6 을 감당할 수 있는가 (V-12). 실제 바이너리 검증은 로컬·
     야간 잡
  ③ `Adapter` 프로토콜 필드 시안 — `LaunchProto`·`Decode`·`Approve`·`Resume`·
     `Exit` 의 서명. 셋이 한 구조체에 드는지, 갈라야 할 에이전트가 있는지 (FR-U-2)
  ④ 데몬 파이프 중계의 설계 선택 (U-8) — P1 ④의 `GO-46` 설계에 들어간다
  ⑤ D-U-4 판정 — 새 종류 vs 전송만 다른 변형

**기록 자리**: `docs/internal/M8_UNIFIED_SRS.md` §9.1 의 표를 채우고(미확인은
그대로 "미확인"), 산출물 ①~⑤ 는 §9.3(신설)에 적는다. 스펙과 실측이 충돌하면
**멈추고 플래그** — M7 이 SRS 를 세 번 정정했다. 진행 기록은 `M8_PROGRESS.md`
(M7_PROGRESS 형식으로 신설).

## 실측 방법 — 주의

- 실제 바이너리로 돈다: `claude` 2.1.x · `codex` · `omp`. 버전을 표에 적어라 —
  세 표면 다 계약이 불안정하다 (R-1·R-2·R-5)
- 프레임은 파일로 남겨라 (`/tmp/m8-spike/<agent>-<case>.jsonl`). 가짜 에이전트
  픽스처의 원본이 된다. **내용은 저장소에 넣지 않는다** — 대화 내용이 실린다
  (NFR-C-1). 형태(스키마)만 스펙에 적는다
- 이 저장소의 바이너리로 `start`/`stop` 을 부르지 마라 (규약). 에이전트 실행은
  dongminal 밖에서 직접 `--print`/`app-server`/`--mode rpc-ui` 로
- 에이전트 이름을 등록부 밖에 적지 마라 (`check-agent-names`) — 스파이크 문서는
  `docs/` 라 게이트 밖이지만 코드 시안(③)은 그 규약을 진다

## 그다음 (P1 — 이 세션이 아니다)

P0 가 끝나면 P1 = Go 부채 ①~④ + `TEST-8` (스펙 §3.2). 그 단계는 스펙 → 테스트
(RED) → 구현이며, 전량 e2e 는 단계 끝에 1회. `M8_NEXT_SESSION.md` 를 P1 용으로
다시 쓴다.

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
- **기준선 JSON(`e2e/baseline/ui-layout.json`)은 클래스 목록을 키로 쓴다** — 바뀌면
  행이 조용히 빠지고 겹치면 첫 것이 이긴다. 키를 손으로 옮긴다
- `decisions.md` 는 생성물이다. `D-*` 를 더하면 `go run ./scripts/gen-decisions`
- 설정 키를 더하면 `SETTINGS_SCHEMA`·`SETTINGS_ACCESS` 둘 다, TC-CFG-4 의 개수
- 커밋 메시지에 AI 서명 금지. 커밋은 사용자 확인 후에만
```

---

## 지금 저장소의 상태 (2026-09-13)

| 항목 | 값 |
|---|---|
| 마일스톤 | M0~M3·M5·M6·M7 완료 · M4 미수행(결정 9) · **M8 통합 착수 전** |
| SRS | 150 · 상태 enum 6종 · `M8_UNIFIED_SRS` 승인·구현중 · `AGENT_PROTOCOL_SURFACE_SRS` 대체 |
| 결정 색인 | 461건 (D-U-1~10 포함) |
| 게이트 | `make gates` 33개 (check-* 30 + gofmt·vet·build) — 전부 초록 |
| e2e | 1,642 항목 · 155 스펙 · 8샤드 ~4.5분 · 마지막 전량 unexpected 0 |
| 기준선 | `e2e/baseline/ui-layout.json` — M7 이 키 마흔 옮김 (§9 기록) |

## 이 인계를 만든 세션의 커밋 (M7 종료 → M8 통합)

```
bb53fc2  docs(m7): M7 을 닫는다 — 종료 판정·SRS 구현완료·로드맵·인계
0a96261  docs(roadmap): AGENT_PROTOCOL_SURFACE_SRS 를 M10 으로 편입하고 병행(훅 유지)으로 D-1 을 뒤집는다
c3e19e1  docs(roadmap): M8·M9·M10 을 하나의 일정 하나의 스펙으로 — M8_UNIFIED_SRS
(이 커밋)  docs(m8): 스펙을 승인·구현중으로 올리고 P0 스파이크 인계를 세운다
```

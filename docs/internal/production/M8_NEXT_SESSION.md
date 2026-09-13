# M8 통합 — 다음 세션 착수 프롬프트 (P3 축 C-a 프로토콜 표면, claude 한정)

아래 블록을 새 세션에 그대로 붙여넣으면 된다.

**P2 는 끝났다** (2026-09-13, `M8_PROGRESS.md` §1-3 항목별 판정 · §1-4 전량 e2e). `make gates`
초록(게이트 35) · 단위 146 · `go test -race -shuffle=on` 통과. 사용자 결정 FR-B-1(안 A)은
스펙 §3.3 과 두 README 에 기록됐다. **첫 일**: `make e2e-rebalance` 는 P2 가 돌렸다 — 이 세션은
전량 뒤에 다시 돌리면 된다.

---

```
프로젝트: /Users/dykim/personal/dongminal

M8 통합의 P2(축 B 국제화)가 끝났고 이 세션은 **P3 = 축 C-a, 묶음 P + T, claude 한정** 이다
(`docs/internal/M8_UNIFIED_SRS.md` §2.3·§3.4·§4·§6.3·§8·§9.3). 스펙 → 테스트(RED) → 구현(GREEN).
전량 e2e 는 단계 끝에 1회. 이 단계가 minor 릴리스 하나다 (로드맵 §6-2).

## 먼저 읽을 것 (순서대로)

1. `docs/internal/M8_UNIFIED_SRS.md` — §2.3(축 C 의 사실, 2.3.1~2.3.7) · §3.4(묶음 P·T·A·B, NFR) ·
   §5(D-U-2·3·4·5·7·8) · §6.3(V-1~V-13) · §8(리스크·가정) · **§9.3 P0 산출물 ①~⑦** (어댑터 필드
   시안 ③ · 데몬 중계 선택 ④ · D-U-4 판정 ⑤ · 충돌 플래그 ⑥)
2. `docs/internal/production/M8_PROGRESS.md` — §1-1(P1 이 축 C 에 넘긴 것: `ToolHub` 의 모양) ·
   §1-3(P2 판정표) · §2-1~2-9(P0 가 배운 것) · §2-14~2-18(P2 가 배운 것) · §3(실측 방법)
3. `docs/internal/architecture.md` — 패키지 레이아웃·프로세스 축(`check-pkg-axis.sh` 가 지킨다) ·
   `ToolHub`/`DaemonHub` 인터페이스 절
4. `internal/shared/agentadapter/` (등록부 — `check-agent-names` 가 이름을 여기 묶는다) ·
   `internal/toolhub/hub.go`(`ToolHub`·`DaemonHub`) · `internal/webserver/httpapi/wait.go`(`pollUntil`)
5. **축 B 가 축 C 에 주는 규약**: `web/js/core/i18n.js` · `web/js/i18n/ko.js`·`en.js` · 스펙 §3.3
   "키 규약" — 새 UI 의 문구는 **처음부터 `t('ns.key')`** 다 (FR-B-10). `scripts/check-i18n.mjs` 가
   한글 리터럴을 잡지만 **영어 리터럴은 잡지 못한다** (D-B-2, §2-18) — 리뷰에서 본다. 새
   네임스페이스(`agent`·`approval`…)는 ko·en 둘 다에 같은 키로 넣는다

## 사용자 결정 (바꾸지 않는다)

  D-U-2·D-U-3·FR-U-4·FR-U-5  P0/P1 인계서 그대로 (어댑터가 인터페이스 · 병행·훅 유지 · TUI 상시)
  D-U-4 (정정, 승인)  에이전트 도구는 `Tool.Kind = agent` 변형 — `Placement`·`ToolInfo` 에 `Kind`
  FR-APS-10 (정정)  승인은 stdio 제어 프레임, MCP 서버 없음
  FR-AGT-11·12  확정 (스펙 §3.4.2)
  D-U-7  승인 타임아웃은 다루지 않는다
  FR-B-1 (P2)  ko·en · 기본 ko · 감지 없음 · 서버 본문 동결 — 축 C 의 서버 오류도 코드로, 문장은 `err.<code>`

## P3 — 할 일 (스펙 §4 P3 행)

  묶음 P  어댑터 프로토콜 필드(§9.3 ③ 시안 → FR-APS-9) · 공통 이벤트(FR-APS-1~8) · 승인 요청-응답
          (stdio 제어 프레임, FR-APS-10) · claude stream-json 해석층(§2.3.4 실측이 정본)
  묶음 T  에이전트 도구 종류(`Kind`, D-U-4) · GUI(대화·도구 호출·승인·사용량 뷰) · TUI 출구(FR-U-4)
  묶음 A  L1 알람(FR-AAL-1~4 — 병행에서 남는 것만)
  터미널 표면은 손대지 않는다. codex·omp 는 P4 다 (FR-U-2 의 첫 판정은 P4 에서).
  검증은 §6.3 V-1~V-13 — V-12 의 가짜 에이전트 픽스처(§9.3 ②)가 e2e 의 발판이다.

## 착수 규약

- 항목마다 **먼저 실측**: §2.3 의 바이너리 판(claude 2.1.270)은 2026-09-13 것이다. 다시 확인하고
  §2.3.4 가 어긋나면 스펙을 정정하고 시작한다 (FR-U-6)
- `ToolHub` 에 종류별 메서드를 두지 않는다 — `Placement{kind,argv}`·`ToolInfo.Kind` (§9.3 ④⑤, P1 §1-1 GO-46)
- 요청 경로의 새 대기(승인 대기)는 `pollUntil(ctx, …)` 위에 (P1 §2-13)
- 스위퍼·틱은 주입받는다 (`StartSweeper(stop, tick)`) — V-1 의 결정성
- 설정 키를 더하면 `SETTINGS_SCHEMA`·`SETTINGS_ACCESS` 둘 다, TC-CFG-4 의 개수(지금 24)
- **P1·P2 가 남긴 것을 이 세션이 줍지 않는다** — GO-44 의 `Git *store.Store`·GO-47(단, `Kind` 를
  더할 때 `Get(id)` 의 `term==nil` 계약은 함께 좁힌다 — 이것은 P3 의 몫)·GO-42·나머지 `time.Sleep`
  은 P7. `fail()` 의 한국어 본문(`httpErr` 동결 목록 밖)도 축 B 의 잔여로 두되 새로 더하지 않는다
- 진행 기록은 `M8_PROGRESS.md` §2 에 이어 쓴다 (M7 형식: "무엇이 바뀌었나" 절 하나에 배운 것 하나)

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
- **새 문구는 `t('ns.key')` 다** — ko·en 둘 다에 넣는다. `check-i18n.mjs` 가 한글 리터럴·키 집합·
  `t` 가려짐을 잡는다
- **하네스를 복사하지 마라** — 새 단정은 그 설정이 이미 있는 자리에
- **기준선 JSON(`e2e/baseline/ui-layout.json`)은 클래스 목록을 키로 쓴다**
- `decisions.md` 는 생성물이다. `D-*` 를 더하면 `go run ./scripts/gen-decisions`
- 에이전트 이름을 등록부 밖에 적지 마라 (`check-agent-names`)
- 커밋 메시지에 AI 서명 금지. 커밋은 사용자 확인 후에만

## 단계 종료 절차 (사용자 지시 2026-09-13 — **모든 단계에 같다**)

단계의 DoD 가 서고 전량 e2e 가 `unexpected 0` 이면, 같은 세션 안에서 순서대로:

  1. 문서 갱신 — `M8_PROGRESS.md`(§1 상태·§1-n 판정표·§2 배운 것) · 스펙 §10 변경 기록 ·
     **이 파일을 다음 단계의 착수 프롬프트로 다시 쓴다** (이 절을 그대로 옮긴다)
  2. `make gates` 초록 확인 뒤 **커밋** (단계 종료 커밋 하나 — 이 지시가 그 확인이다)
  3. 인수인계 — dongminal 접합면으로 **현재 위치에 새 탭**을 열고 claude 를 띄운다:
       `dmctl new-tab -n` (`--at` 없이, 포커스 위치. `new-tab`/`close-tab` 은 `--help` 를
       받지 않고 그대로 실행되니 `--help` 를 치지 마라) → `newTabs[0]` 의 uuid·toolId
       `dmctl rename-tab --at <탭> "M8-P<n+1>"`
       `dmctl send-input --at <탭> --execute "cd '$PWD' && claude"` → `dmctl wait --at <탭> --for ready --timeout-ms 180000`
       (rc=5 면 `dmctl read-screen --at <탭>` 으로 무엇을 묻는지 보고 처리)
       `dmctl msg --to <toolId> -` 로 `[HANDOFF M8 P<n> → P<n+1>]` 엔벨로프 — 이 파일을
       읽고 "먼저 읽을 것" 순서대로 진행하라는 한 문단 + 커밋 해시
       `dmctl status --at <탭>` 로 `working` 확인 (idle 이면 `send-input --execute ""`)
  4. **자기 탭을 닫는다** — `dmctl close-tab --at <자기 탭 uuid>` (`dmctl who-am-i` 의 `uuid=`).
     이것이 세션의 마지막 명령이다
```

---

## 지금 저장소의 상태 (2026-09-13, P2 종료)

| 항목 | 값 |
|---|---|
| 마일스톤 | M0~M3·M5·M6·M7 완료 · M4 미수행(결정 9) · **M8 P0·P1·P2 완료 · P3 착수 전** |
| SRS | `M8_UNIFIED_SRS` 승인·구현중 — §2.2 실측 정정 · §3.3 FR-B-1 결정·키 규약·게이트 규칙 · D-B-1~4·3a · §10 에 P2 기록 |
| 게이트 | 35 초록 (`check-i18n.mjs` 신설 · `check-http-error.sh` 가 한국어 본문 동결을 함께 잡는다 · CI `gates` 잡에 `npm ci` 추가) |
| 카탈로그 | `web/js/i18n/ko.js`·`en.js` 915키 (+en 복수형 `.one` 13) · JS 한글 리터럴 0 · `index.html` 한글 0 · CSS `content` 문구 0 |
| 단위 | node:test 146 통과 (`i18n.test.mjs` 13 추가) |
| e2e | `e2e/i18n.spec.ts` 6건 (TC-B-2~5) · 전량은 `M8_PROGRESS.md` §1-4 |

## P2 가 축 C 에 넘기는 것 (FR-B-10)

- 문구는 **키**다. `constants*.js` 에 `const X=t('ns.key')` 로 선언하거나 자리에서 `t()`/`tn()` 을
  부른다. 정적 마크업은 `data-i18n`·`data-i18n-title`·`data-i18n-html`. 네임스페이스는 화면 단위
  (`agent`·`approval` 처럼 새로 연다) — ko·en 둘 다
- 서버 오류는 `apierr` 코드 + `err.<code>` 카탈로그 문장 (D-B-3·3a). 구체 코드면 카탈로그가,
  상태 파생 코드면 본문이 사유다 — `apiErrText(r, what)` 한 자리를 쓴다
- 로케일은 로드 시점에 한 번 정해진다 (D-B-1). 살아 있는 재렌더를 전제로 설계하지 않는다
- 단축키를 품는 툴팁은 `data-i18n-shortcut="<action>"` + `{key}` (FR-B-7)

## 이 인계를 만든 세션의 커밋 (P2)

```
(커밋 해시는 종료 커밋 뒤에 적는다)
```

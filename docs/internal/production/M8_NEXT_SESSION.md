# M8 통합 — 다음 세션 착수 프롬프트 (P2 축 B 국제화)

아래 블록을 새 세션에 그대로 붙여넣으면 된다.

**P1 은 끝났다** (2026-09-13, `M8_PROGRESS.md` §1-1 항목별 판정 · §1-2 전량 e2e
unexpected 0 · flaky 8 은 M7 §5-5 군집이고 단독 통과). `go test -race -shuffle=on
-count=1 ./...` 통과 · `make gates` 초록. 사용자 판단 셋(FR-APS-10 · D-U-4 ·
FR-AGT-11·12)은 P1 착수 시 해소됐다. **첫 일**: `make e2e-rebalance` 는 P1 이 못
했다 — 이 세션의 첫 전량 뒤에 먼저 돌려라.

---

```
프로젝트: /Users/dykim/personal/dongminal

M8 통합의 P1(축 A ①~④ + TEST-8)이 끝났고 이 세션은 **P2 = 축 B 국제화** 다
(`docs/internal/M8_UNIFIED_SRS.md` §2.2·§3.3·§4·§6.2). 스펙 → 테스트(RED) → 구현(GREEN).
전량 e2e 는 단계 끝에 1회. 이 단계가 minor 릴리스 하나다 (로드맵 §6-2).

## 먼저 읽을 것 (순서대로)

1. `docs/internal/M8_UNIFIED_SRS.md` — §2.2(축 B 의 현재) · §3.3(FR-B-1~10 과 DoD 원문) ·
   §6.2(TC-B-1~3) · §7 비목표 · §8 리스크
2. `docs/internal/production/M8_PROGRESS.md` — §1-1(P1 판정표) · §2-10~2-13(P1 이 배운 것)
3. `docs/internal/ERROR_CONTRACT_SRS.md` — FR-B-8 이 딛는 규약(서버 오류는 코드, 문장은 프론트)
4. `docs/internal/ACCESSIBILITY_BASELINE_SRS.md` FR-A11Y-21 — FR-B-6 의 판정 방법
5. `web/js/core/constants*.js`(5파일) · `web/index.html` 정적 문구 · `web/js/core/settings-schema.js`
   (설정 키 `locale` 이 들어갈 자리) · `scripts/check-*.sh` 중 하나(게이트의 형태)

## 사용자 결정 (바꾸지 않는다)

  D-U-2·D-U-3·FR-U-4·FR-U-5  P0/P1 인계서 그대로
  결정 2 (2026-09-12)  UX-11 의 판정은 WCAG 2.1 AA — 접근성 트리의 이름/텍스트 노드
  FR-B-10  축 C 의 새 UI 는 처음부터 키다 — 게이트가 잡는다 (P3 의 전제)

## P2 — 할 일 (순서 고정, 스펙 §4 P2 행)

  ① 언어 정책 결정 (FR-B-1)  지원 로케일·기본·감지 규칙·폴백·**범위 경계**(CLI 는 밖인가)
     → 사용자에게 **한 번** 묻고 `README.md`·`docs/internal/README.md` 에 결정으로 적는다
  ② 카탈로그 모듈 (FR-B-2)  `t(key, params)` 하나 · 키 규약을 스펙 §3.3 에 적는다
  ③ 게이트 (FR-B-3)  한글 리터럴 검출 + 예외 등록부 · **탐침으로 검출 확인** · Makefile·verify.yml 둘 다
  ④ 외부화  `constants*.js` → `index.html` 정적 문구 → 혼용(FR-B-9 는 데이터 교정만)
  ⑤ `<html lang>`(FR-B-5) · CSS `content` 3곳(FR-B-6) · 툴팁 보간(FR-B-7)
  ⑥ 서버 6곳 코드화 (FR-B-8) · 설정 키 `locale`(FR-B-4 — SETTINGS_SCHEMA·SETTINGS_ACCESS 둘 다, TC-CFG-4 개수)
  DoD 는 스펙 §3.3 의 불릿 그대로. TC-B-1 탐침과 e2e 1스펙(TC-B-2·3)이 판정이다.

## 착수 규약

- 항목마다 **먼저 실측**: 스펙 §2.2 의 수(241줄/77파일·178줄·6곳)는 2026-09-09 감사다.
  다시 세어 스펙 §2.2 를 정정하고 시작한다
- 게이트(③)를 외부화(④)보다 **먼저** 세운다 — 없으면 외부화가 즉시 역행한다 (FR-B-3)
- 설정 키를 더하면 `SETTINGS_SCHEMA`·`SETTINGS_ACCESS` 둘 다, TC-CFG-4 의 개수
- **P1 이 남긴 것을 이 세션이 줍지 않는다** — GO-44 의 `Git *store.Store`·GO-47·GO-42·
  나머지 `time.Sleep` 은 P7 ⑥⑦ 의 몫이다 (`M8_PROGRESS.md` §1-1)
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
- 에이전트 이름을 등록부 밖에 적지 마라 (`check-agent-names`)
- 커밋 메시지에 AI 서명 금지. 커밋은 사용자 확인 후에만

## 단계 종료 절차 (사용자 지시 2026-09-13 — **모든 단계에 같다**)

단계의 DoD 가 서고 전량 e2e 가 `unexpected 0` 이면, 같은 세션 안에서 순서대로:

  1. 문서 갱신 — `M8_PROGRESS.md`(§1 상태·§1-1 판정표·§2 배운 것) · 스펙 §10 변경 기록 ·
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

## 지금 저장소의 상태 (2026-09-13, P1 종료)

| 항목 | 값 |
|---|---|
| 마일스톤 | M0~M3·M5·M6·M7 완료 · M4 미수행(결정 9) · **M8 P0·P1 완료 · P2 착수 전** |
| SRS | `M8_UNIFIED_SRS` 승인·구현중 — FR-APS-10·D-U-4 정정 반영 · FR-AGT-11·12 확정 · §10 에 P1 기록 |
| 게이트 | 34 초록 (`check-pkg-axis.sh` 신설 — 프로세스 축 경계 + 패키지 표) |
| Go 테스트 | `-race -shuffle=on` 전량 통과 (P1 중 FR-GIT-107 의 순서 결함을 잡아 고쳤다) |
| e2e | 전량 2회 — ① unexpected 1(캐시 결함, 고침) ② **unexpected 0** · flaky 8(§5-5 군집, 단독 통과). `M8_PROGRESS.md` §1-2 |

## P1 이 축 C 에 넘기는 것 (FR-U-7)

- `ToolHub` 는 `List() []ToolInfo`·`ListOK`·`Connected`·`Daemon() DaemonHub`·`Terminate` 를 갖고
  **종류별 메서드가 없다** — 축 C 는 `Placement`(`create{kind,argv}`)와 `ToolInfo` 에 `Kind` 를
  더하고, 전송 호출의 무동작은 구현 안에서 끝낸다 (§9.3 ④⑤, D-U-4)
- `DaemonHub.Subscribe` 는 `toolhub.OutChunk` 를 나른다 — 에이전트 도구의 non-droppable
  `output` 과 `stream:"stderr"` 는 그 채널의 확장이다 (§9.3 ④)
- `pollUntil(ctx, …)`(httpapi)이 요청 경로 대기의 한 자리다 — 승인 대기 등 새 대기는 그 위에
- 스위퍼는 틱을 주입받는다 (`StartSweeper(stop, tick)`) — V-1 의 결정성이 그 위에 선다

## 이 인계를 만든 세션의 커밋 (P1)

```
d05eee9  feat(m8): P1 — Go 부채 ①~④ + TEST-8 (프로세스 축 게이트·레이스·컨텍스트·ToolHub 인터페이스)
```

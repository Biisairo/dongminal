# 인계: e2e 기존 실패 정리 · V-LAY-1 linux·win32 기준선 · 직접 모드 제거 · 문서 정합

> 작성 2026-11-18. 앞 세션(EDGE-MESH 탭)이 맥락 52% 에서 넘긴다.
> 직전 커밋 `9d41e897` (main, **푸시하지 않음**). 작업 트리는 깨끗하다.

## 착수 블록 — 이번 세션의 지시 전부

사용자 지시(2026-11-18): *"e2e 실패 처리하고 나머지 기준선, 정리후보 정리해서 완벽하게 만든 후 커밋으로 마무리"*

순서대로 한다.

1. **e2e 기존 실패 21건을 고친다** (아래 「e2e 실패 목록」). 각 건마다 먼저 원인이 코드인지 시험인지 가른다.
   동작이 바뀌면 이전/새/이유를 관련 SRS 와 CHANGELOG 미출시 절에 적는다.
2. **V-LAY-1 의 linux·win32 기준선**을 채운다. 이 맥은 darwin 만 뜬다(`e2e/baseline/ui-layout.darwin.json`).
   CI(`.github/workflows/verify.yml` 등)가 산출물을 내는지 조사하고, 낼 수 있으면 그것으로 채운다. 채울 수 없으면
   그 사실과 방법을 사용자에게 보고한다(푸시·CI 실행은 바깥으로 나가는 일이라 **사용자 확인 뒤**에만).
   기록 규약: `UI_LAYOUT_DEFAULTS_SRS.md` 끝의 기록 절(2026-11-18 항목이 마지막).
3. **정리 후보 둘**:
   - **직접 모드 제거.** 사용자: *"직접 모드는 없는거야. 애초에 처음에 있던거 옮기면서 남아있는거잖아."*
     대상: `cmd/dongminal/app.go` 의 `dialOrStartDaemon` 실패 시 `buildDeps`(Direct mode) 갈래,
     `internal/webserver/httpapi/edge_node.go`(`initEdge`·서버 직접 노드 포트), `Deps.EdgeDaemon == nil` 분기들
     (`edge_api.go`·`profile_api.go`·`server.go:307` 등), `ToolManager` 직접 경로, 직접 모드 전제의 시험.
     **중·대 규모다** — 사용자 CLAUDE.md 절차(스펙 → 테스트 → 구현)를 따른다. 범위가 불명확하면(예: 데몬을 못 띄울 때
     서버가 어떻게 끝나야 하나 — 오류로 종료? 안내?) `AskUserQuestion` 으로 권장안과 함께 하나씩 묻는다.
   - **PEER_NETWORK_SRS FR-PNW-50~ 명령 표 정합.** 표는 `node.info`·`agents.list`·`message.send` 등 옛 프로토콜이고,
     지금 노드 포트 경로는 `/edge/v1/pair`·`unpair`·`link` 셋뿐이다(`edgenode/node.go`). 코드가 진실이다 — 문서를
     지금 동작에 맞추거나 "이후 바뀜" 표시를 단다. 고치기 전에 사용자에게 어느 쪽인지 묻는다(사용자 CLAUDE.md §8).
4. **마무리**: `make test`·`make gates`·`make lint`·`make unit`·`npm run -s typecheck`·e2e 전량이 통과하면
   **커밋한다** — 사용자가 이번 일의 커밋을 지시했다. 커밋 메시지에 AI 서명(`Co-Authored-By` 등) 금지. **푸시는 하지 않는다**
   (지시 없음).

## e2e 실패 목록 (커밋 9d41e897 직전 작업 트리 기준, 2026-11-18 전량)

전량 로그: `/tmp/dm-e2e-full.log` (없어졌으면 다시 돈다). 모두 **간선 망 작업 이전부터** 있던 실패다(EDGE_MESH_HANDOFF
「남은 정리」 와 같다). V-LAY-1 은 그 뒤 darwin 재생성으로 통과한다.

| 스펙 | 시험 | 단서 |
|---|---|---|
| `tooltips.spec.ts` | C1~C5, C7~C15 (14건) | `title 이 한국어인 버튼` — Activity 탭의 `title` 이 `에이전트`·`백그라운드 도구`·`채팅`. 툴팁은 영어여야 한다(FR-TIP-1·2). 탭 정의(`app-activity.js` 쪽 `ag-tabs`)의 title 을 찾는다 |
| `kit-components.spec.ts:315` | TC-CMP-20 한 자리 수 배지는 정원이다 | 배지 폭 7.5 vs 8 (FR-CMP-81) |
| `editor-git-ux.spec.ts:510` | TC-ITE-1 VS Code 편집 키 | 아직 원인 미조사 |
| `runs.spec.ts:537·562` | V-FUI-4d·4e 멤버 카드 분리 | 아직 원인 미조사 |
| `mobile-keybar.spec.ts:487·499` | 모바일 Activity 드로어 진입점 | 아직 원인 미조사 — 채팅 탭(ag-tabs) 추가 뒤 생겼을 가능성 |

툴팁 실패에 Edges 의 새 버튼(`eg-notify`·`eg-mesh-*`·`eg-invite-*`·`chat-edge-invite`)은 걸리지 않았다(영어 title 확인).

## 먼저 읽을 것

1. 이 문서
2. `docs/internal/EDGE_MESH_HANDOFF.md` 의 「값을 치르고 배운 것」·「변하지 않는 규약」
3. `docs/internal/UI_LAYOUT_DEFAULTS_SRS.md` §5.1·§9 와 끝의 기록 절
4. `docs/internal/PEER_DAEMON_SRS.md` — 직접 모드 정의(D-PDM-11, FR-PDM-52)
5. `docs/internal/PEER_NETWORK_SRS.md` §3 FR-PNW-50~

## 값을 치르고 배운 것

- **e2e 를 도는 중에 다른 e2e 를 띄우지 않는다.** `global-setup` 이 바이너리를 다시 빌드해 도는 전량을 깬다.
- **e2e 가 도는 중에 `git stash` 하지 않는다.** 그 틈에 뜬 서버가 옛 소스를 읽을 수 있다(앞 세션이 한 번 했다).
- 전량 e2e: `make e2e > /tmp/dm-e2e-full.log 2>&1` 를 백그라운드로. 결과는
  `LC_ALL=C sed 's/\x1b\[[0-9;]*[A-Za-z]//g' /tmp/dm-e2e-full.log | LC_ALL=C grep -a -E "^\[샤드 [0-9]/8\]\s+[0-9]+\) \[chromium\]"`
  로 실패 목록을 뽑는다. 샤드 8개, 약 10분.
- 한 스펙: `npx playwright test <이름>`. 기준선: `LAYOUT_BASELINE=write npx playwright test ui-layout-defaults`.
- `ps aux | grep playwright` 의 `playwright-mcp` 는 MCP 서버다 — e2e 실행이 아니다.
- `make test` 전량 중 `cmd/dongminal` `TestSessionKeep_RealReload` 가 부하 속에서 한 번 실패한 적이 있다. 따로 돌리면 통과.
  `chat` 의 `TestPinAfterRelayedState` 도 무거운 병렬 부하에서 3초 시한을 넘긴 적이 있다.
- JS 단위 시험의 vm 객체는 `deepStrictEqual` 이 실패한다 — `JSON.stringify` 로 비교한다(기존 관례).
- 게이트가 잡는 것: API 문서(`docs/external/api.md` ↔ 라우트), 오류 문서(`go run ./scripts/gen-errors`), 결정 색인
  (`go run ./scripts/gen-decisions`), 패키지 표(`architecture.md`), CSS 글자 크기 토큰(`--fs-*`), outline 을 지우면
  `:focus-visible` 되살리기, i18n ko·en 키 동치와 미사용 키.
- 시험 노드(`chat` 의 `testNode`)는 자기 `mu` 를 가져 `Service.mu` 를 가린다 — 서비스 잠금은 `x.Service.mu` 로 잡는다.

## 변하지 않는 규약

- 커밋 전: `make gates` · `make lint` · `make unit` · `npm run -s typecheck` · 관련 `go test`. 전량은 `make test`(3~4분).
- 커밋 메시지에 AI 서명 금지. 이번 일의 커밋은 사용자가 지시했다. 푸시는 지시 없음.
- 스펙 상태 줄은 enum 이고 구현중이면 `> **남은 것**:` 줄이 필요하다.
- 동작이 바뀌면 이전/새/이유를 스펙과 CHANGELOG 미출시 절에 적는다.
- 문서와 코드가 어긋나면 코드가 진실이다. 문서를 고치기 전에 사용자에게 묻는다(사용자 CLAUDE.md §8).

## 유효한 사용자 결정

- 직접 모드는 지원 대상이 아니다(EDGE_MESH_HANDOFF D-8) — 이번에 지운다.
- V-LAY-1 은 darwin 을 이 맥에서 뜨고 linux·win32 는 CI 산출물로 채운다(D-11).
- 간선 망(EDGE_MESH_SRS)은 구현 완료·커밋됨. 남긴 위험: 시빌 노드로 아는 노드 표 채우기(SRS §5a, MEDIUM) — 이번 범위 아님.

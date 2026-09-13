# M8 진행 — 통합 일정: Go 부채 · 국제화 · 에이전트 프로토콜 표면

> 로드맵 §M8. 스펙은 [`M8_UNIFIED_SRS`](../M8_UNIFIED_SRS.md) (승인·구현중). 단계는 스펙
> §4 — P0 스파이크 → P1 Go 부채 ①~④ → P2 국제화 → P3 프로토콜(claude) → P4·P5·P6 → P7.

---

## 1. 어디까지 왔나 (2026-09-13, 다섯 번째 세션 — **P3 완료**)

| 단계 | 상태 |
|---|---|
| **P0** 스파이크 (U-1~U-10 · 산출물 ①~⑤) | **완료** (첫 세션) — 스펙 §9.1 표가 채워졌고 §9.3 이 섰다. 제품 코드 0줄 |
| **P1** A ①~④ + `TEST-8` | **완료** — 아래 §1-1 표. `go test -race -shuffle=on -count=1 ./...` 통과 · `make gates` 초록 · 전량 e2e unexpected 0 (§1-2) |
| **P2** B 국제화 | **완료** — 아래 §1-3 표. 사용자 결정 FR-B-1(안 A) · 카탈로그 915키(ko·en 전수) · 게이트 `check-i18n.mjs`(35번째) · 전량 e2e §1-4 |
| **P3** C-a 묶음 P+T (claude) | **완료** — 아래 §1-5 표. Go `-race -shuffle` 초록 · `make gates` 초록 · `agent-tool.spec.ts` 7/7(3회 반복 21/21) · 전량 e2e §1-6. 두 세션(첫 세션이 Go·뷰, 둘째 세션이 e2e 4건의 원인 둘 = §2-25·§2-26) |
| P4~P7 | 착수 전 — P4 착수 프롬프트는 `M8_NEXT_SESSION.md` |

**사용자 판단 셋은 착수 시 해소됐다** (2026-09-13): FR-APS-10 정정(stdio 제어 프레임,
MCP 서버 없음) · D-U-4 정정(변형 + `Kind`) · FR-AGT-11·12 확정. 스펙 본문과 §9.3 ⑤⑥,
R-2 에 반영했고 `decisions.md` 를 다시 만들었다.

### 1-1. P1 항목별 판정

| 단계 | 항목 | 판정 | 어디에 |
|---|---|---|---|
| ① | GO-4 | **해소** — 위반 4곳 중 a·b 해소, c·d 예외 등록. `scripts/check-pkg-axis.sh` 가 축 규칙(축 패키지→자기 축+shared, shared→shared)을 `go list -deps` 로 지킨다. Makefile·verify.yml 배선, 탐침 3종 확인 | `check-pkg-axis.sh` · `shared/dmenv/helpers.go` · `shared/runfile/` · `architecture.md` §패키지 레이아웃 |
| ① | GO-48 | **해소** — 표에 빠진 20개(+`clientpid` 는 실재하지 않아 삭제)를 더했고 같은 게이트가 `go list ./...` 과 양방향 대조. 동시성 절에 `toolclient`·`AttnTracker`·`Jobs` | `architecture.md` |
| ② | GO-5 | **해소** — `SetOnOutput/SetOnExit/SetOnForeground`, 필드 비공개, `FlushEarlyPushes` 는 `SetOnExit` 안으로. 레이스 테스트 2건(잠금을 빼면 `DATA RACE` 로 잡힘을 탐침) | `toolclient/client.go` · `client_test.go` |
| ② | GO-7 | **해소** — `exitAfterRead()` 를 EOF·패닉이 함께 지난다. 릴레이 콜백에 패닉을 주입해 kill·onExit·OpExit·프로세스 소멸을 확인 | `toolhub/tool.go` · `tool_readpty_panic_test.go` |
| ② | GO-29 | **해소** — `Create` 가 잠금 밖에서 띄운다. 상한은 `pending` 예약으로. `startTool` 필드 주입(가짜 기동으로 잠금 규약을 판정) | `toolhub/manager.go` · `manager_create_lock_test.go` |
| ② | GO-30 | **해소** — `toolExited` 가 `invalidator` 를 락으로 읽는다 | 같은 자리 |
| ② | GO-31 | **확인 → 삭제** — 읽는 쪽은 TERMINAL_RESUME(FR-TRS-12)이 이미 지웠고 `Restored` 는 **쓰기 전용**이었다. 레이스는 없었고, 필드를 지웠다 | `toolhub/tool.go`·`manager.go` |
| ② | GO-32 | **해소** — `ClearAllAttention` 이 락을 놓고 방송. 방송 안에서 되묻는 대역으로 데드락을 RED 로 잡았다 | `hub/attn_tracker.go` · `attn_firing_test.go` |
| ② | GO-33 | **확인** — `StartGitWatch` 는 이미 ctx 를 쓴다 (GP-8, M6) |  |
| ② | GO-34 | **해소** — `OnIndexUpdate` 를 `mu` 밖에서, `hookMu` 로 rev 순서 보장. 훅이 막힌 동안 다른 Save 의 rev 가 진행함을 테스트 | `workspace/manager.go` · `manager_tabids_test.go` |
| ② | GO-35 | **해소** — `call` 이 `NewTimer`+`Stop` | `toolclient/client.go` |
| ② | GO-37 | **해소** — `Stream.Feed` 는 인자를 보관하지 않는다(계약 테스트) → `feedAndClients` 의 사본 제거. 청크당 명시적 복사는 릴레이 하나 | `outbuf/stream.go` · `toolhub/tool.go` |
| ② | GO-42 | **확인 — 조건 미충족** — DoD 는 "`t.Parallel()` 도입 패키지에서" 인데 도입 패키지가 0 이다. 전역 훅 5개(`toolBusyProbe`·`attnBusyProbe`·`fgProbe`·`attnNow`·`procCtl`) 잔존. `ToolManager.startTool` 필드 주입이 교체의 본이다 |  |
| ② | (발견) FR-GIT-107 | **해소** — 전량 `-race -shuffle` 에서 `TestGitRemote_InvalidatesStatusCacheOnDone` 이 한 번 떨어졌다. 원인은 제품 코드: `Jobs.finish` 가 `Done` 을 공개한 **뒤** 완료 훅(캐시 무효화)을 불렀다. 훅 → 공개 → 기록 순으로 고쳤다 | `git/jobs/job.go` · `job_test.go` · `GIT_SRS` FR-GIT-107 정정 |
| ③ | GO-9 | **해소** — `limits`·`fsOps`·`contextNotices` 가 `Server` 필드. 두 서버 동시 기동 테스트 2건(상한·통지 기억 독립). `fsOps` 는 Mkdir/OpenFile/count+RemoveAll/count+copy 구간만 | `httpapi/server.go` · `server_coexist_test.go` |
| ③ | GO-12 · FBE-01(서버) | **해소** — `pollUntil(ctx, max, every, cond)` 하나로 4곳(`waitHandoff`·`requestHandoff`·`waitToolsIdle`·`awaitTab`). 끊긴 `succeed` 는 잇지 않고 헤드리스 도구를 거둔다. `SendPaste` 의 틈은 도구 죽음으로 끊기고, `kill()` 유예는 `Wait` 채널로, worktree 되풀이는 ctx + 예산(3초) — `repoLock` 18분 경로 소멸. 요청 경로 `time.Sleep` 0 | `httpapi/wait.go` · `handlers_runs*.go` · `toolhub/bracketpaste.go`·`tool.go` · `worktree/worktree.go` |
| ③ | GO-40 | **해소** — `daemonBusyWait`·`daemonReadyTries`·`daemonReadyPoll`·`terminateGrace`·`removeRetry*`. `termReset` 은 이미 이름이 있었고 `/tmp` 기본값은 의도된 것 | `cmd/dongminal/main.go` 등 |
| ③ | GO-41 | **해소** — 튜닝 env 셋(`ATTENTION_IDLE_MS`·`ATTENTION_BELL`·`CMD_RESULT_TIMEOUT_MS`)의 이름과 읽는 규칙(`MillisEnv`·`FlagEnv`)이 `dmenv` 한 곳 | `shared/dmenv/tuning.go` |
| ④ | GO-13 | **해소** — `ToolHub.List() []ToolInfo`, 와이어(데몬 `list`)와 소비자가 같은 타입. `m["id"].(string)` 형 단언 0, `map[string]interface{}` 80→71, 필드명 변경이 컴파일 오류 1회 확인 | `toolhub/hub.go` · 소비처 6곳 |
| ④ | GO-6 | **해소** — `ToolClient` 에 200ms TTL 목록 캐시 + `exit`·`fg` push 와 변경 호출(create·kill·terminate·restore·setbackground) 무효화(**보내기 전·돌아온 뒤 두 번**, 세대 가드). Get/IsLive 30회에 list RPC 1회 계측. 전량 e2e 가 잡은 결함은 §1-2 ① | `toolclient/client.go` · `client_test.go` |
| ④ | GO-44 | **부분 해소** — `RunStore`(httpapi)·`worktree.Service` 인터페이스, `Runs`·`Worktrees`·`UserWorktrees` 가 그것을 든다. 가짜로 git 없이 도는 핸들러 테스트 1건. **`Git *store.Store` 는 남긴다** — gitapi 가 `Service()`(구체)를 83곳에서 쓰므로 인터페이스로 좁혀도 git 없이 돌지 못한다; ⑥(GO-39 git 실행기 통합) 뒤의 일 | `httpapi/deps.go` · `worktree/worktree.go` · `deps_seam_test.go` |
| ④ | GO-45 | **해소** — `SettingsStore` 의 `Get/Set/Save` 공개 | `httpapi/deps.go` |
| ④ | GO-46 | **해소** — `ToolHub` 에 `ListOK`·`Connected`·`Daemon() DaemonHub`(+`Terminate`), `IsDaemon` 삭제. `DaemonHub` 는 `Subscribe`·`SnapshotToolSince`·`DaemonInfo`·`Reconnects`. 타입 단언 6곳(ws 2·api 1·main 2·health/diag 2) 소멸, **httpapi 가 `toolclient` 를 import 하지 않는다**. 종류별 메서드 없음 — §9.3 ④⑤ 를 받아들일 모양 | `toolhub/hub.go` · `handlers_ws.go` · `architecture.md` |
| ④ | GO-47 | **미착수 — DoD 없음** — `Get(id) *Tool` 의 `term==nil` 계약은 D-U-4(변형 + `Kind`)가 그대로 딛는다. 좁히는 것은 축 C 가 `Kind` 를 더할 때 함께 |  |
| ④ | FBE-05/12 | **해소** — `ToolHub.Terminate(id, grace)`; 데몬은 `terminate {id, graceMs}` 를 **자기 고루틴에서** 처리해 연결의 다른 RPC 를 막지 않는다. 데몬 모드 통합 테스트(가짜 셸이 TERM 에 이력 표식을 남기고 유예 뒤 강제 종료) | `daemon/ipc/paned.go` · `handlers_tools_kill*.go` · `CONVENIENCE_SRS` FR-BGK-7 정정 |
| ⑦ | TEST-8 | **DoD 분 해소** — 1초 이상 `time.Sleep` 0 (`daemon_integration_test` 4곳 → 틱 주입 + `waitUntil`), `StartSweeper(stop, tick)`·`StartAttentionSweeper(stop, tick)`, `history_shell_test`·`toolhome_test` 의 500ms → `waitShellReady`/`waitOutput`. 총 `time.Sleep` 은 94→96 (새 테스트의 밀리초 폴링) — 나머지 정리는 ⑦ P7 | `hub/attn_tracker.go` · `toolhub/manager.go` · `toolhub/waitpoll_test.go` |

### 1-2. 전량 e2e (P1 판정)

| 회차 | 결과 | 비고 |
|---|---|---|
| ① 코드 완료 직후 | unexpected 1 · flaky 3 | `skill-contract` "전용 창 Run 이 사용자 공간을 건드리지 않고 …" — **목록 캐시(GO-6)의 결함**. 재시도 2회 모두 실패, HEAD 에서는 통과, TTL 0 이면 통과. 원인: 데몬은 한 연결의 RPC 를 직렬로 처리하므로 종전(캐시 없음)에는 `kill` 이 도는 동안의 `list` 가 그 뒤에 답을 받았는데, 캐시는 `kill` **전에** 받은 목록을 그 동안 그대로 냈다. 수정: 변경 RPC(create·kill·terminate·restore·setbackground)는 **보내기 전과 돌아온 뒤 두 번** 무효화하고, 무효화가 세대를 올려 진행 중이던 list 응답은 저장하지 않는다. 표적 3회 통과 |
| ② 수정 뒤 | **unexpected 0** · flaky 8 | flaky 는 전부 M7 §5-5 군집 또는 그 이웃(`slot-view-state` TC-SVS-2·21 · `git-observe-revive` TC-GLR-4 · `git-worktrees` V169 · `repo-tab` V-DSP-1 · `repo-diff-edit` E1 · `git-history` H6·H16 · `git-improve` V138 · `settings-reset-revert` TC-RST-2). 여덟 스펙 전부 **단독 실행(retry 0)에서 통과**. M7 의 "3회 연속 flaky 0" 미충족은 그대로다 (사용자 지시로 세기 중단) |

`make e2e-rebalance` 는 못 했다 — 표적 실행이 `test-results/` 를 비워 샤드 리포트가 사라졌다 (규약대로 **전량 직후·표적 전에** 돌려야 한다; 다음 세션이 전량 뒤에 먼저 돌린다). 시간표는 M7 것 그대로이고 가장 느린 샤드가 4.9분이다.

**바이너리**: claude 2.1.270 · codex 0.154.0(bunx 캐시) · omp 17.4.0. 라이브 모델 턴은 claude 만
— codex 는 토큰 만료(사용자: *"지금 사용 안 하고 있다"*), omp 는 등록 키 둘 다 401.
그 둘의 턴 의존 칸은 "미확인 — 자격증명 없음" 으로 남겼다.

---

### 1-3. P2 항목별 판정

**사용자 결정 (2026-09-13, 착수 시 한 번)**: FR-B-1 = **안 A** — 지원 `ko`·`en` · 기본 `ko` ·
`navigator.language` 감지 없음(설정 `locale` 만) · 폴백 `ko`+콘솔 경고 · `en` 전수 번역 · 전환은
페이지 재로드 · CLI·서버 로그·`SETTINGS_SCHEMA.where` 범위 밖 · 서버 오류 본문은 동결(D-ERR-2)하고
`X-Error-Code` 로 프론트가 문장을 고른다 · 툴팁 영어 규약(FR-TIP-2)은 ko 카탈로그 데이터로 유지.
스펙 §3.3 "FR-B-1 의 결정" 표와 `README.md` §언어 · `docs/internal/README.md` §언어 정책에 같은 내용.

| 순서 | 항목 | 판정 | 어디에 |
|---|---|---|---|
| ① | FR-B-1 언어 정책 | **해소** — 위 결정. 두 README 에 기록 | `README.md` · `docs/internal/README.md` · 스펙 §3.3 |
| ② | FR-B-2 카탈로그 | **해소** — `t(key,params)`·`tn(key,n,params)`·`I18N.register/apply/applyShortcuts`. 카탈로그 `web/js/i18n/ko.js`(915키)·`en.js`(915+복수형 `.one` 13). 키 규약·네임스페이스는 스펙 §3.3 | `web/js/core/i18n.js` · `web/js/i18n/` · 단위 13건 `i18n.test.mjs`(TC-B-8) |
| ③ | FR-B-3 게이트 | **해소** — `scripts/check-i18n.mjs`(espree AST: JS 리터럴 한글 · HTML 텍스트/속성 · CSS `content` 문구 · ko·en 키 집합 · `t()` 키 존재 · **`t`/`tn` 가려짐**). Makefile·verify.yml 둘 다. **탐침 5종** 확인 뒤 지움: JS 리터럴(잡음) · HTML 텍스트(잡음) · CSS `content`(잡음) · `console.warn` 한글(지나감 — 예외 등록부) · Go `httpErr` 한국어 추가(`check-http-error.sh` 가 잡음) | `scripts/check-i18n.mjs` · `scripts/check-http-error.sh` · `Makefile` · `verify.yml` |
| ④ | 외부화 | **해소** — `constants*.js` 12파일 630줄 → `t()` (키는 상수 이름에서 기계적 파생, 객체·배열 값은 `.prop`) · 그 밖 31파일 254줄 → `t()`/`tn()` (`apiErrText` 로 모인 오류 문구 포함) · `index.html` 72줄 → `data-i18n`/`-html`/`-title`/`-placeholder`. 한글 리터럴 **0** (게이트) | 43 JS 파일 · `web/index.html` |
| ⑤ | FR-B-5 `<html lang>` | **해소** — head 인라인 스크립트(`dm.locale` 거울)가 첫 페인트 전에, `i18n.js` 가 로드 시 다시 세운다. 영어가 섞인 요소 셋(`.boot-name`·`.modal-title`·`.modal-tabs`)과 언어 선택지 `<option>` 에 `lang` | `web/index.html` · `i18n.js` · TC-B-3 |
| ⑤ | FR-B-6 CSS `content` | **해소** — 3곳 전부 DOM 텍스트(`.slot-empty-hint`·`.tp-drop-hint`·`.pn-dim-hint`). CSS 는 보일 때만 `display` 를 연다. 접근성 트리의 텍스트로 잡힘을 e2e 셋이 `ariaSnapshot()` 으로 단정 (TC-B-4) | `renderer.js` · `term-pane.js` · `style.css` |
| ⑤ | FR-B-7 툴팁 보간 | **해소** — 정적 단축키 툴팁 4곳(`split-h`·`split-v`·`slot-add`·`slot-remove`)이 `data-i18n-shortcut` 으로 `{key}`=`displayKey(shortcuts[action])`. 설정 적용·녹화·되돌리기 세 자리에서 `I18N.applyShortcuts`. e2e 가 재바인딩 뒤 갱신을 단정 (TC-B-5). **동작 변경**: 종전 `(Ctrl+Shift+H)` → `(⌃+⇧+H)`(displayKey 표기) | `index.html` · `app-settings.js` · `input-binding.js` · `app-settings-keys.js` |
| ⑥ | FR-B-8 서버 오류 | **정정 후 해소** — `http.Error` 한국어는 M5 가 이미 0 으로. `httpErr` 한국어 본문 9곳은 D-ERR-2 로 **동결**(게이트가 상한 9 를 지킨다). 문장의 소유는 프론트: `apiErrText(r, what)` 이 `X-Error-Code` → `err.<code>`(25 코드) → 본문 → `{what} ({status})` 순. **동작 변경**: 코드가 카탈로그에 있으면 서버 본문 대신 카탈로그 문장 (이전: 본문 그대로 / 이유: FR-B-8) | `api.js` · `check-http-error.sh` · `i18n/*.js` `err.*` |
| ⑥ | FR-B-4 설정 키 | **해소** — `locale` 을 `SETTINGS_SCHEMA`·`SETTINGS_ACCESS` 둘 다, TC-CFG-4 23→24. Display ▸ 언어 `<select id="ds-locale">`. 저장 성공 뒤 거울 쓰기 → `location.reload()` (D-B-1). 미번역 키 폴백·콘솔 경고 1회는 단위+e2e 가 단정 (TC-B-2) | `settings-schema.js` · `app-settings.js` · `app-settings-init.js` · `schema_test.go` |
| ⑥ | FR-B-9 혼용 | **해소(별도 커밋)** — `Display Mode`·`Mobile Breakpoint (px)` 라벨을 키로 올린 뒤(코드) ko 값만 한국어로 고친 커밋 하나 (데이터). TC-B-7 의 "카탈로그 diff 만" 이 그 커밋이다 | `web/js/i18n/ko.js` |
| — | FR-B-10 | **전제 성립** — 축 C 의 새 UI 는 한글 리터럴을 적는 순간 게이트가 빨개진다 |  |
| — | (발견) CI `gates` 잡 | **해소** — `npm ci` 가 없어 node 게이트(`check-load-order` 등)가 CI 에서 `espree` 를 찾지 못하는 상태였다. `setup-node`+`npm ci` 를 잡 머리에 더했다 | `verify.yml` |

### 1-4. 전량 e2e (P2 판정)

| 회차 | 결과 | 비고 |
|---|---|---|
| ① 코드 완료 직후 | unexpected 8 · flaky 1 | 셋 다 이 변경의 것 — (a) `reconnect-storm` 5건: 격리 하네스가 전역을 손으로 세우는데 `term-pane.js` 가 새로 읽는 `DROP_FILES_HINT`·`t()` 가 없었다 → 하네스에 둘을 더했다("같은 변경에서 여기 한 줄이 늘어야 한다" 의 그 자리) (b) `access-allowlist` 2건: `apiErrText` 가 코드의 카탈로그 문장으로 **사유가 든 본문**을 덮었다 → D-B-3a(구체 코드면 카탈로그, 파생 코드면 본문) (c) `ui-layout-defaults` V-LAY-1: `<html lang="ko">` 가 글리프 메트릭을 바꿔 `#add-sandbox-window` 의 `left` 가 76.03→77.42px — `lang="en"` 으로 되돌리면 통과함을 실측해 원인을 확정하고 기준선의 그 값 하나만 고쳤다(전체 재생성은 1,739줄이 늘어 기준선의 뜻이 바뀐다). flaky 는 `slot-view-state` TC-SVS-21(M7 §5-5 군집), 단독 통과 |
| ② 수정 뒤 | **unexpected 0** · flaky 1 | flaky 는 `git-history` H17(M7 §5-5 군집의 이웃 — P1 ② 에도 H6·H16 이 있었다), 단독 실행(retry 0) 통과. `make e2e-rebalance` 를 전량 직후에 돌려 시간표를 갱신했다(8샤드 385~387s, 불균형 1.00배) |

**바이너리**: P1 과 같다 (claude 2.1.270).

### 1-5. P3 항목별 판정

**사용자 결정·지시 (2026-09-13)**: FR-AGT-4 에 **질문 답변**(`AskUserQuestion`) · FR-AGT-4a(Esc 인터럽트·
↑↓ 히스토리·`/` 자동완성·Shift+Tab 권한 순환 — *"최대한 tui agent 의 모든 공통 기능을 이용하게"*) ·
`-p --input-format stream-json` 은 1회성이 아니다(§2-19) · 출력에 이모티콘을 쓰지 않는다.

| 묶음 | 항목 | 판정 | 어디에 |
|---|---|---|---|
| P | FR-APS-1·9 `Adapter.Proto` | **해소** — 터미널 표면 옆에 선택 필드 하나. `claude.go` 는 `Proto: &claudeProto` 세 줄뿐(V-11) | `proto.go` · `claude.go` · `claude_proto.go` · `proto_test.go`(R-8 표) |
| P | FR-APS-2·3 공통 이벤트·활동 어휘 | **해소** — `Event.Activity()`: session→idle · turn_start/approval_closed→working · approval_open→waiting · turn_end→done · exit→ended | `proto.go` |
| P | FR-APS-4·D-U-6 부재 | **해소** — 없는 것은 nil/omitempty. `Proto` nil 이면 생성이 `agent_no_proto` 로 거절된다 — 셸로 조용히 내려가지 않는다 | `handlers_agent.go` |
| P | FR-APS-5·6 승인 요청-응답 | **해소** — `ProtoState.Open` · `Approve` 한 프레임(allow·deny·제안 n·질문 답) · 서버는 대신 답하지 않는다 | `claude_proto.go` · `agentsess` |
| P | FR-APS-8 모르는 프레임 | **해소** — `raw` 이벤트로 원문 보존 | `agentsess.decodeLine` |
| P | FR-APS-10 stdio 승인 | **해소** — `--permission-prompt-tool stdio` · `updatedPermissions` 로 제안 적용(실측 §2-20) | `claude_proto.go` |
| T | FR-AGT-1·2·3·7·8 `Kind=agent` 변형 | **해소** — 파이프 전송(`platform.StartPipe`), Resize/SendPaste 무동작, 같은 Create 종단(`?kind=agent`), 데몬 모드 동일(`TestAgentAPI_DaemonMode`) | toolhub · platform · httpapi |
| T | FR-AGT-4·4a·5·9·11·12 GUI | **해소** — `AgentPane`(대화·상태·사용량·다이얼로그·Esc·히스토리·자동완성·Shift+Tab·메뉴). e2e TC-AGT-1~5·7 | `agent-pane.js` · `app-agent-tool.js` · `agent-tool.spec.ts` |
| T | FR-AGT-10 TUI 출구 | **해소** — `GET /api/agent/tui-line` → 터미널 탭에 `--resume <sid>` 한 줄. e2e TC-AGT-6 | `handlers_agent.go` · `app-agent-tool.js` |
| A | FR-AAL-1~6 | **해소** — waiting/done 알람이 활동 보고에서(`reportActivity` 한 자리), 에이전트 도구는 L2 idle 제외. 종류는 청크에 실려 온다(D-C-10, §2-25) | `agentkind_test.go` · `agent_api_test.go` |
| — | GO-47 `ToolHub.Get` | **좁힘** — 계약 문서화 · 합성 Tool 이 Kind·Agent 를 든다 | `hub.go` · `toolclient.Get` |
| — | (발견) 데몬 readLoop 자기 RPC | **해소** — §2-25. `TestAgentAPI_DaemonTermChunkNoStall` | `handlers_agent.go` · `paned.go` · `client.go` |
| — | (발견) 뷰의 재생 경합 · 열린 요청 수 이중 계수 | **해소** — §2-26. `_pending` 버퍼 · `_openIds` 집합 | `agent-pane.js` |
| V | V-1·2·5·6·8·9·12·13 | Go 테스트 · V-3·V-10 e2e · V-11 `git diff` 로 확인(훅 표면 diff 0, `claude.go` 3줄) | |

### 1-6. 전량 e2e (P3 판정)

| 회차 | 결과 | 비고 |
|---|---|---|
| ① 코드 완료 직후 | unexpected 1 · flaky 4 | **진짜 회귀** — `tab-width` TC-CMU-3: P3 첫 세션이 에이전트 탭 만들기를 `+` 우클릭과 **탭 메뉴 둘 다**에 넣어 FR-CMU-8 의 셋이 넷이 됐다. 표적 검사(`agent-tool.spec`)는 `+` 메뉴만 쓰므로 전량만 잡았다. 탭 메뉴에서 뺐다(만들기는 FR-CMU-8a `+` 메뉴만, 에이전트 탭의 `터미널로 열기` 는 남는다 — `CONTEXT_MENU_UNIFY_SRS` §8). flaky 넷은 전부 §5-5 군집(`git-live-triggers` TC-GLW-6 · `git-worktrees` V169 · `editor-save` TC-ESV-1·2 · `slot-view-state` TC-SVS-22) |
| ② 수정 뒤 | **unexpected 0** · flaky 2 | 둘 다 `git-observe-revive`(TC-GOR-1 · TC-GLR-3) — §5-5 군집. 1,653 통과 · 8샤드. `make e2e-rebalance` 로 시간표 갱신(8샤드 393~394s, 불균형 1.00배) |

## 2. 무엇이 바뀌었나

### 2-19. (P3) `-p` 는 1회성이 아니다 — stdin 이 열려 있는 동안 세션이 산다

사용자 질문(*"-p 옵션은 1회성 응답 옵션 아니야?"*)에 실측으로 답했다: `-p --input-format stream-json`
한 프로세스에 프롬프트 9개를 차례로 넣어 `result` 9개를 받았고 `session_id` 는 `/clear` 때만 바뀌었다
(`/tmp/m8-spike/claude-ctl.jsonl`). 프롬프트를 인자로 주는 `-p "…"` 만 1회성이다. 같은 바이너리·같은
`~/.claude` 이므로 "있는 에이전트" 그대로다 — 바뀌는 것은 표면(TUI 대신 프레임) 하나.

### 2-20. (P3) 질문 답변은 승인과 같은 통로다

사용자 지시(FR-AGT-4 "질문 답변")로 `AskUserQuestion` 을 실측했다: `can_use_tool` +
`requires_user_interaction:true`, `input.questions[]`, 답은 `allow` + `updatedInput.answers{질문:라벨}` 한
프레임. 그래서 `ApprovalRequest.Kind` 가 `permission`·`question` 둘이고 다이얼로그 하나가 둘을 그린다.
`updatedPermissions:[제안 항목 그대로]` 도 실측으로 확인해(`setMode` → `system:status{permissionMode}`)
승인 선택지를 allow·deny·제안 n 개로 프로토콜 그대로 낼 수 있었다 (FR-AGT-5).

### 2-21. (P3) 해석층은 서버에 하나, 두 모드가 같은 바이트를 절대 오프셋 위에서 받는다

직접 모드는 `ToolHooks.OnOutput`(기동 전 배선), 데몬 모드는 `SetOnOutput` 사슬 — 둘 다 `(id, data, end)` 다.
세션은 `seen` 오프셋을 들고 겹침은 버리고 틈은 `SnapshotTool` 로 되메운다; 열 때도 스냅샷을 먼저 읽는다
(세션이 붙기 전에 나온 `system:init` 을 놓치지 않기 위해 — 테스트 `TestSession_OpenResyncsFromSnapshot`).
활동 보고는 `activity/set` 핸들러의 본문을 `reportActivity` 로 뽑아 **같은 함수**를 지난다 — 그래서
알람·활동 패널·`dmctl wait --for ready` 가 에이전트 도구에서도 터미널과 같은 길로 섰다 (FR-AGT-8).

### 2-22. (P3) 종류를 묻는 자리는 정말 셋으로 끝났다

D-U-4 의 판정대로 `Tool.Kind` 를 묻는 곳은 (a) 해석층 입구(`AgentOutput`) (b) 뷰(`_mountTabBody` 의
agent 갈래·`AgentPane`) (c) 전송 — `SendPaste` 무동작·데몬 push 의 non-droppable·`maybeIdle` 제외(FR-AAL-5)
— 그리고 영속 제외(D-C-5)다. `Resize`·`Size`·`ForegroundPGID` 는 `platform.StartPipe` 의 `Terminal` 구현
안에서 무동작으로 끝나 toolhub 가 종류를 묻지 않았다. 브라우저에서 `type==='terminal'` 을 묻던 자리는
셋이었고, 뜻이 "도구가 있는 탭" 이던 `allPids` 하나만 `toolId` 유무로 고쳤다.

### 2-23. (P3) 가짜 에이전트는 테스트 바이너리 자신이다

`agent_api_test.go` 는 `DM_FAKEAGENT=1` 로 자기를 다시 실행하면 `fakeagent.Main` 을 돈다 — `go build`
없이 서버 핸들러를 실제 프로세스·파이프로 잰다. 파일 이름은 어댑터의 `DetectCmd` 에서 온다(리터럴이
아니다). e2e 는 `global-setup` 이 바이너리를 하나 만들어 `E2E_AGENT_BIN_DIR` 에 놓고 서버가
`DONGMINAL_AGENT_BIN_DIR` 로 받는다 (D-C-7).

### 2-24. (P3) 게이트가 잡은 셋 · 실측이 잡은 하나

`check-i18n` 이 renderer 탭 메뉴의 `t('agent.open_terminal')` 을 잡았다 — 그 자리는 지역 `t` 가 전역을
가린다(§2-16 의 그 규칙). 상수 `AGENT_OPEN_TERMINAL` 로 우회. `check-pkg-axis` 가 새 패키지 셋을 표에
없다고 잡았다(GO-48) — 표에 더했다. 뷰의 클래스 접두 `ag-` 가 활동 패널의 `.ag-head`·`.ag-state` 와
충돌했다 — `agp-` 로 바꿨다. 그리고 `Event.Message` 는 와이어에서 JSON 배열 **그대로** 온다
(`json.RawMessage` 인라인) — 뷰가 문자열로 여겨 `JSON.parse` 하다 빈 본문을 그렸다; 배열이면 그대로 쓴다.

### 2-25. (P3) 해석층 입구가 종류를 되물었고, 그 물음이 readLoop 을 5초 세웠다

e2e TC-AGT-6 의 `── exited ──` 는 셸이 죽은 것이 아니었다. 데몬 모드에서 `Server.AgentOutput` 은
세션이 없는 도구의 종류를 `Tools.Get` 으로 물었고, 그것은 `ToolClient.List` — **자기가 지금 돌고
있는 readLoop 이 응답을 읽어야 끝나는 RPC** 다. 5초 시한까지 막혔다가 `dropIfCurrent` 가 연결을
떨어뜨렸고, 그 사이의 `IsLive`(→ `/api/tools/input` 404 "id 해석 실패")·`Cwd`(→ `source:"server"`)·
WS attach(→ `OP.EXIT`)가 전부 실패했다. 새 도구의 첫 청크마다, 그리고 목록 캐시가 식을 때마다 — HEAD
바이너리와 나란히 띄워 `create → cwd` 로 잰 것이 0.02s 대 5.00s 였다. 답은 D-C-10: 청크의 출처
(readPTY·데몬의 relay)는 `Tool.Kind` 를 이미 알므로 **종류를 청크에 싣는다** — `ToolHooks.OnOutput`·
`ToolClient.SetOnOutput` 이 `kind` 를 받고, 데몬의 `output` push 에 `kind` 필드(터미널은 생략)가
간다. 입구의 `agentKinds` 기억과 되묻기는 없어졌다. 회귀 시험 `TestAgentAPI_DaemonTermChunkNoStall`
(첫 청크 뒤의 `IsLive` 가 2초 안에 답한다). 유닉스 소켓 경로 길이 때문에 테스트 이름이 짧다.

### 2-26. (P3) 재생이 비행 중일 때 온 SSE 는 상태를 잃었다

TC-AGT-4 의 `/co` 자동완성이 간헐로 비었다 — `initialize` 의 commands 가 뷰에 없었다. 열 때
`GET /api/agent/events` 가 비행 중인 사이에 `status` 가 SSE 로 왔고, `this.state` 가 아직 null 이라
commands 병합이 떨어졌다. 뒤이어 앉은 서버 상태는 그 status **앞**의 것이었고, 재생이 0건이라 seq
틈도 없어 다시 묻지 않았다 (trace: events 응답 `commands=None nev=0` 하나뿐). `AgentPane` 은 이제
비행 중의 SSE 를 `_pending` 에 잡아 두었다가 재생 뒤에 `onEvent` 로 이어 붙인다 — 틈이면 그 자리에서
다시 재생한다.

### 2-14. (P2) 감사는 주석을 셌고, "6곳" 은 이미 0 이었다

§2.2 의 수는 전부 다시 세야 했다 — `constants*.js` 5파일은 M6 이 12파일로 갈랐고, "JS 241줄/
77파일" 은 주석까지 센 것이어서 문자열 리터럴만 세면 **43파일 884줄**(constants 630 + 나머지
254)이고, `index.html` 178줄은 주석 밖 **72줄**이다. `http.Error` 한국어 6곳은 M5 의 `G6-1` 이
`httpErr` 로 옮기며 **0** 이 됐고, 남은 것은 `httpErr` 의 한국어 본문 9곳 — 그것은 D-ERR-2 가
"한 바이트도 바꾸지 않는다" 고 못박은 공개 계약이다. 그래서 FR-B-8 은 "본문을 고친다" 에서
"프론트가 본문을 읽지 않게 한다" 로 정정됐다 (D-B-3). P1 의 교훈(§2-10)과 같다: **판정은
게이트가 하고 감사는 지도다.** 그리고 분모가 바뀌면 스펙을 먼저 고치고 시작한다 (FR-U-6).

### 2-15. (P2) 상수가 로드 시점에 읽으므로 전환은 재로드다

`const X=t('…')` 가 1,100여 개고 77파일이 그 이름을 읽는다. "로케일을 바꾸면 UI 전부가
바뀐다"(FR-B-4)를 살아 있는 재렌더로 하려면 모든 소비처가 구독자가 되어야 하고, 그 값은 이
제품에 없다 — 단일 사용자이고 전환은 드물다. 그래서 D-B-1: 저장 → `localStorage` 거울 →
`location.reload()`. 첫 페인트 전의 `<html lang>` 은 테마 캐시(`dm.themeVars`)와 같은 모양으로
head 인라인 스크립트가 같은 키를 읽는다. 설정이 서버에서 오는데 카탈로그는 설정보다 먼저
필요하다는 시차를 거울 하나가 잇는다 — 새 브라우저의 첫 방문은 ko 로 뜨고 설정을 받은 뒤 한 번
다시 연다.

### 2-16. (P2) 게이트가 외부화보다 먼저여야 했던 이유가 하나 더 나왔다

외부화 중에 `const t = runSvg('title'); t.textContent = … ? t('runs.coordinator') : …` 를 만들었다 —
지역 `t` 가 전역 `t()` 를 가려 **런타임에만** 죽는 코드다. eslint `no-undef` 는 잡지 못한다(이름은
있다). 게이트에 규칙을 하나 더했다: `eslint-scope` 로 `t`/`tn` 호출이 전역 아닌 바인딩에
덮이는지를 본다. 스펙이 적은 게이트 규칙 넷에 다섯째가 실측에서 더해졌다 — 게이트는 외부화를
**지키는** 것만이 아니라 외부화를 **하는 동안** 실수를 잡는 도구였다.

### 2-17. (P2) CI 의 node 게이트는 돌 수 없는 상태였다

`verify.yml` 의 `gates` 잡에 `npm ci` 가 없었다. `check-load-order.mjs`(M6)부터 node 로 쓴 게이트는
`espree` 를 import 하므로 러너에서는 첫 줄에서 죽는다 — 로컬 `make gates` 는 `node_modules` 가
있어 초록이었다. "게이트는 두 자리에 들어가야 끝난다" 의 네 번째 사례이고, 이번에는 두 자리에
**들어가 있었는데 한 자리가 돌 수 없었다.** `setup-node`+`npm ci` 를 잡 머리에 더했다.

### 2-18. (P2) 한글 게이트로 영어 혼용을 잡을 수는 없다

게이트는 한글만 본다(D-B-2) — 영어 리터럴은 식별자·클래스·프로토콜 문자열과 기계적으로 가를 수
없다. 그래서 UX-20 의 혼용 자리(`Display Mode`·`Mobile Breakpoint (px)`)는 게이트가 지나갔고,
FR-B-9 를 위해 **손으로** 키로 올려야 했다. en 쪽의 보장은 "ko 와 키 집합이 같다" 하나다. 축 C 가
새 UI 를 영어 리터럴로 적으면 게이트는 침묵한다 — 리뷰의 몫으로 남는다 (FR-B-10 의 한계).

### 2-10. (P1) 감사의 줄 번호는 낡았고, 다섯 중 둘은 이미 닫혀 있었다

GO-31(`Restored` 레이스)은 읽는 쪽이 TERMINAL_RESUME 에서 이미 사라져 **쓰기 전용
필드**였고, GO-33(gitwatch ctx)은 M6 이 닫았다. GO-42 는 DoD 의 조건("`t.Parallel()`
도입 패키지")이 성립하지 않았다. 반대로 감사가 적지 않은 것이 전량 `-race -shuffle`
에서 잡혔다 — `Jobs.finish` 가 `Done` 을 공개한 뒤 캐시를 지워 FR-GIT-107 이 그 창에서
거짓이었다. **판정은 게이트가 하고 감사는 지도일 뿐이다** (M2 의 교훈 그대로).

### 2-11. (P1) 유예는 도구가 있는 프로세스에서 기다린다

FBE-05/12 의 실체는 "서버가 pid 를 보고 기다린다" 는 설계 자체였다 — 데몬 모드의
`Get` 은 pid 없는 합성 Tool 을 주므로 유예가 통째로 건너뛰어졌다. 고친 모양은
`ToolHub.Terminate(id, grace)` 하나: 직접 모드는 그 자리에서, 데몬 모드는 RPC 로
데몬이 기다린다. 데몬의 디스패치가 직렬이라 `terminate` 만 고루틴으로 뗐다 — 응답이
id 로 짝지어지므로 순서가 바뀌어도 된다. **데몬 연결 하나가 직렬**이라는 사실은
`SendPaste` 의 120ms 틈에서도 같은 값을 물었다.

### 2-12. (P1) `Daemon()` 하나가 타입 단언 여섯을 대신했고, httpapi 가 toolclient 를 잊었다

GO-46 의 답은 "인터페이스에 메서드를 올리거나 하위 인터페이스" 였다 — 둘 다 했다.
두 모드가 같이 답할 수 있는 것(`ListOK`·`Connected`·`Terminate`)은 `ToolHub` 로, 프로세스
경계를 건널 때만 있는 것(`Subscribe`·`SnapshotToolSince`·진단 둘)은 `DaemonHub` 로 갈랐고
`Daemon()` 이 그 경계다. 결과로 `httpapi` 의 비검사 코드가 `toolclient` 를 import 하지
않는다 — 구체 타입은 composition root 만 안다. §9.3 ④⑤ 가 요구한 "종류별 메서드 없음"
은 지켰다: 인터페이스에 `Kind` 가 없고, 축 C 는 `Placement` 와 `ToolInfo` 에 그것을 더한다.

### 2-13. (P1) 끊긴 요청의 대기는 그 요청의 것이다

`pollUntil(ctx, …)` 하나로 네 대기를 모으자 FBE-01 의 서버 절반이 함께 닫혔다 — 그런데
"끊기면 무엇을 하지 않는가" 는 자리마다 달랐다. `succeed` 는 잇지 않고 헤드리스 도구를
거둔다(재시도가 처음부터), `preamble` 은 표식을 남긴다(다음 조회가 이어 기다린다),
`close` 는 그대로 닫는다(정리는 조건이 아니다). 헬퍼가 같아도 부작용의 판단은 호출자의
것이다.

### 2-1. claude 의 승인은 MCP 가 아니었다 — 스펙의 "범위 항목" 이 사라진다

스펙 FR-APS-10 과 R-c 는 `--permission-prompt-tool` 이 **MCP 도구 서버**를 요구한다고
적었고, 그래서 dongminal 이 MCP 서버를 하나 들어야 한다는 범위 항목이 됐다. 실측:
`--permission-prompts host` 만 주면 요청 없이 **자동 거부**(`system:permission_denied`,
`result.permission_denials[]`)이고, `--permission-prompt-tool stdio`(헬프에 없는 값)를
주면 `control_request{subtype:"can_use_tool",…,permission_suggestions[]}` 가 stdout 으로
오고 `control_response{behavior:"allow"}` 한 프레임에 도구가 돈다(파일 생성 확인).
`ExitPlanMode`·`AskUserQuestion` 도 같은 통로다.

MCP 서버 하나가 통째로 빠진다. 대가는 **숨은 플래그에 기대는 것** — R-2(비공개
계약)에 얹힌다.

### 2-2. 세 재개는 전부 "이력을 주지 않는다" — 재생 원천은 우리 로그뿐

claude `--resume`·codex `thread/resume`·omp `--resume` 셋 다 같은 세션 신원으로
**새 이벤트만** 낸다. 이력은 각자의 파일/페이지 API(`thread/turns/list`, `get_messages_page`)
에 있고 FR-AGT-6 은 그것을 읽지 않는다. 그러므로 FR-ABG-4 의 재생은 **우리 이벤트
로그**로만 성립하며, 요약 스냅샷(FR-ABG-21)의 근거가 더 분명해졌다.

### 2-3. `--bg` 는 휴면의 반대였다

`claude --bg` 는 `claude daemon run` + `bg-pty-host`(200×50 PTY) 로 **TUI 를 숨은 PTY 에
살려 두는** 기계다 — dongminal 의 백그라운드 터미널 도구와 같은 자리이지 프로세스가
사라지는 휴면이 아니다. 휴면(FR-ABG-10)의 실체는 `--resume` 하나.

### 2-4. omp 는 기본이 yolo 다 — 인자 없이 띄우면 승인 요청이 한 번도 안 온다

`tools.approvalMode` 기본값이 `yolo`. 그리고 `--mode rpc`(hasUI=false)에서는 승인이
**오류**로 실패한다(`wrapper.ts:307`). 어댑터의 프로토콜 기동은 `--mode rpc-ui
--approval-mode <정책>` 을 반드시 싣는다. 승인 프레임은 `select(["Approve","Deny"])` —
소스로 확인했고 라이브 왕복은 자격증명이 없어 못 봤다.

또 하나: 로그인 `input` 대기 중에 stdin 을 닫자 omp 가 `input` 재요청을 **1,162회**
쏟았다. 호스트는 열린 요청에 `{cancelled:true}` 로 답한 뒤 닫아야 한다 — 시안 ③의
`Cancel` 이 그 자리다.

### 2-5. codex 는 한 프로세스가 여러 thread 를 든다 — 그리고 훅이 생겼다

AS-1(한 프로세스 = 한 세션)은 codex 에서 거짓이다. 두 `thread/start` 가 한 stdio 에서
병렬로 돌고 알림마다 `threadId` 가 실린다. 설계는 안 바뀐다(한 프로세스를 한 도구로).

범위 밖 발견: codex 0.154.0 의 `hooks` 기능이 **stable** 이고 claude 와 같은 훅 이벤트를
`~/.codex/hooks.json` 으로 받는다. §2.3.2 의 "codex 는 사실상 침묵한다" 는 터미널
표면의 사실이라 이 스펙이 손대지 않지만(FR-U-3), `codexAdapter` 의 훅 표면은 후속
문서감이다.

### 2-6. 세 판정 — 사용자 확인 대기

| | 판정 | 근거 |
|---|---|---|
| ③ 어댑터 필드 | **셋이 한 구조체에 든다** (`Adapter.Proto *Proto`) | 차이는 핸드셰이크·요청 id 자리·codex threadId 뿐 — 전부 함수와 `ProtoState` 안 |
| ④ 데몬 중계 | **같은 길** (`output` 푸시 + `write` RPC), 단 에이전트 도구는 **non-droppable** + stderr 스트림 | 프레임 한 개 유실 = 승인 요청 유실. `exit` 이벤트와 같은 등급 |
| ⑤ D-U-4 | **변형 + `Kind`** | 종류가 갈리는 자리는 해석층·뷰·전송 호출 셋뿐. 새 종류로 두면 `ToolHub` 인터페이스에 종류별 메서드가 생겨 FR-AGT-8 을 어긴다 |

### 2-7. 사용자 요구 하나가 P0 중에 들어왔다

*"omp 는 여러 방식으로 로그인이 가능한데 이걸 다 사용할 수 있어야 해 — 모델 변경이라거나."*
→ FR-AGT-11: 프로토콜이 주는 로그인 공급자·로그인 흐름(`open_url`·`input`)·모델 목록·
전환을 UI 로 낸다. 실측으로 omp `get_login_providers`(63 공급자)·`login` → `open_url`·
`notify`·`input` 흐름, `set_model`·`cycle_model` → `model_changed` 를 봤다. claude 는
`initialize.models` + `set_model`, 로그인은 TUI 출구.

### 2-8. 동시 접근은 창 포커스 소유가 이미 답이다

*"에이전트 화면 동시 접근에 대해서는 터미널과 같은 동작으로 한쪽만 컨트롤하도록
블로킹하기."* 터미널의 그 동작은 `app-focus.js` 의 창 포커스 소유(FR-XDF — 창마다
소유자 하나, last-focus-wins, 서버가 맵을 쥐고 SSE `window_focus` 로 뿌림)와
`.pn-dimmed` 오버레이("클릭하여 포커스")다. 에이전트 도구도 창 안의 pane 이므로 같은
코드가 그대로 닿는다 — FR-AGT-12. 서버가 비소유자의 승인 응답까지 거절할지는 P3 의
결정으로 남겼다(터미널은 클라이언트만 막는다).

### 2-9. 셋 다 TUI 와 같은 자격증명을 쓴다

사용자 질문 *"tui 가 되면 gui 도 되는 건가 별개 로그인인가"* — 별개가 아니다. claude
`~/.claude`+키체인, codex `~/.codex/auth.json`, omp `~/.omp/agent/agent.db` 를 프로토콜
모드도 그대로 읽는다(라이브: claude `/cost` 가 구독 로그인을 보고, omp
`get_login_providers` 의 `authenticated`, codex `account/read`). 이번 401 은 저장된
자격증명이 죽은 것이라 TUI 로도 같다.

---

## 3. 실측 방법 — 다음 세션이 그대로 쓸 것

- `/tmp/m8-spike/drive.py <out.jsonl> <idle-sec> -- <cmd…>` + `DRIVER=<시나리오.py>` —
  stdio JSONL 드라이버. 시나리오는 `on_start(send)`·`on_frame(frame, send)→bool`·
  `on_end(send, proc)`. 출력 파일에 보낸 것은 `>>> ` 접두어로 함께 남는다.
- `/tmp/m8-spike/ptycap.py <out.bin> <sec> <cols> <rows> "<sec>:<keys>"… -- <cmd…>` —
  PTY 캡처(알림 시퀀스). claude 는 새 cwd 에서 신뢰 프롬프트가 먼저 뜬다(↓·Enter).
- codex 는 `bunx --bun @openai/codex` 로 캐시에만 받았다 —
  `~/.bun/install/cache/@openai/codex@0.154.0-*/vendor/aarch64-apple-darwin/bin/codex`.
  `app-server generate-json-schema --out <dir>` 이 프로토콜 전체(99 요청·10 서버 요청·
  90여 알림)의 스키마를 낸다 — 라이브보다 이것이 정본이다.
- omp 의 문서는 `dist/docs-index.generated.txt`(둘째 줄 base64+gzip JSON 배열, 첫 줄이
  이름 목록)에 들어 있다. `rpc.md`·`approval-mode.md`·`session.md` 를 풀어 읽었다.
- `/tmp` 는 저장소 밖이다. 픽스처(②)를 만들 때 **형태만** 옮긴다.

---

## 4. 커밋

```
75e1d83  docs(m8): P0 스파이크를 닫는다 — §9.1 실측·§9.3 산출물·FR-AGT-11/12·P1 인계
31b0d28  docs(m8): 인계서에 커밋 해시를 적는다
d05eee9  feat(m8): P1 — Go 부채 ①~④ + TEST-8
5504fa2  feat(m8): P2 — 축 B 국제화 (카탈로그·게이트·외부화·locale 설정·서버 오류 문장)
7b7b322  fix(i18n): UX-20 혼용 해소 — 데이터 교정 (TC-B-7)
```

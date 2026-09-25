# 최적화·리팩토링 감사 발견 등록부

> 생성물. `OPTIMIZE_REFACTOR_SRS.md` §3 의 FR 이 이 등록부의 ID 를 가리킨다.
> 감사: 2026-09-25, 영역 6(IPC·HTTP·DOM·SHR·FEC·FEU) × (감사 1 + 적대 검증 1). 기준 커밋 `67261463`.

채택 210건 · 제외 4건 (§제외). 판정: 확인 = 검증자가 코드로 재확인 · 개연 = 확정 못함(구현 전 재확인 필요) · 검증자 추가 = 검증 단계에서 추가된 누락 항목(검증자 본인 확인만 거침).

열: 심각도 · 분류 · 규모(S/M/L) · 위험 · 동작변경(B) · 판정

## O1 — 정확성 결함 우선 수정 (23건)

### DOM-5 — BranchDelete 가 중간 실패에서 거짓 hint 를 남기고 브랜치마다 rev-parse 를 따로 띄운다

`P1` · 결함 · S · LOW · B · 확인 · 묶음키 `branch-delete-hints`

- **위치**: `internal/webserver/domain/git/write/branch.go:415`, `internal/webserver/domain/git/write/branch.go:428`
- **근거**: 루프에서 BranchOid 가 성공할 때마다 s.AddHint 를 부른다. 두 번째 이름에서 실패하면 첫 번째 hint 는 이미 기록됐는데 ExecWrite 는 돌지 않는다. 주석 '없는 브랜치의 복구 안내는 거짓이므로 실행도 hint 도 하지 않는다'와 어긋난다. 또 N개 삭제에 rev-parse 프로세스가 N개다.
- **개선안**: 두 패스(oid 를 모두 모은 뒤 hint 기록)는 그대로 한다. 한 번에 조회하려면 for-each-ref 에 이름마다 패턴 인자를 주면 된다. 다만 for-each-ref 패턴은 접두 일치이므로 refname 이 'refs/heads/'+n 과 정확히 같은 것만 채택해야 한다. 없는 이름이 있으면 그 이름으로 오류를 낸다. 가드가 for-each-ref 인자를 허용하는지 확인해야 한다.
- **이전 감사**: AUDIT-go-domain MED BranchDelete

### IPC-4 — 출력 청크가 드롭되거나 데몬 재연결로 구멍이 나도 감지하지 않아서 브라우저 좌표(seq)가 어긋나고 재개가 깨진다

`P1` · 결함 · S · LOW · B · 확인 · 묶음키 `ws-gap-resync`

- **위치**: `internal/webserver/toolclient/client_push.go:111-123`, `internal/daemon/ipc/paned.go:99-108`, `internal/webserver/httpapi/handlers_ws.go:319-352`, `web/js/ui/term-pane.js:1016-1019`, `internal/webserver/toolclient/client.go:220-263`
- **근거**: 드롭은 두 곳에서 일어난다: 데몬 enqueue(큐 1024 초과)와 toolclient pushOutput(구독 채널 256 초과, `default:` 로 버리고 256건마다 로그만 남김). 데몬 재접속 구간의 출력도 subbers 에 그대로 남은 WS 구독에는 오지 않는다. relayOutput 은 trimOverlap 으로 겹침만 자르고, chunk.End-len(Data) > sent 인 구멍은 보지 않는다. 브라우저는 받은 바이트 길이만 _seq 에 더한다(term-pane.js:1019). 그래서 구멍이 나면 화면에서 그 바이트가 영구히 빠지고, 다음 재연결의 since 가 실제보다 작아져 서버가 이미 받은 구간을 다시 보낸다(중복).
- **개선안**: relayOutput 에서 `chunk.End>0 && chunk.End-int64(len(chunk.Data)) > sent` 이면 conn.Close() 로 끊는다. 그러면 클라이언트가 자기 since 로 재접속하고, 서버가 링버퍼에서 그 뒤를 정확히 재생한다. 끊기 전에 로그를 남기고 sent 를 갱신한다. 기존 End 기반 좌표계만으로 드롭·재연결 구멍 둘 다 자가 치유된다.

### IPC-M1 — 데몬 재연결 때 toolclient 가 subbers 를 정리하지 않아 공백 중 끝난 도구의 exit·onExit 가 영구히 유실된다

`P1` · 결함 · M · MEDIUM · B · 검증자 추가 · 묶음키 `ws-gap-resync`

- **위치**: `internal/webserver/toolclient/client.go:156-209`, `internal/webserver/toolclient/client.go:215-263`, `internal/webserver/toolclient/client_push.go:145-175`, `internal/daemon/ipc/paned_server.go:187-205`, `internal/daemon/ipc/paned.go:109-112`
- **근거**: connect()/supervise() 는 재접속 후 subbers 를 손대지 않는다. Reconnects() 는 진단(handlers_diag.go:78)에서만 읽힌다. 공백 동안 데몬의 exit 클로저는 멈춘 currConn 에 enqueue 하고 이 값은 <-pc.done 으로 버려진다. 그래서 그 사이 종료된 도구의 WS 구독은 exitCh 가 닫히지 않은 채 남는다. 브라우저 터미널은 죽은 도구에 붙어 있고, 입력은 Write 오류가 삼켜져 무반응이다. onExit(주의·활동 정리)도 돌지 않는다. 데몬이 재기동(respawn)되면 새 End 좌표가 옛 snapshot End(sent)보다 작아서 trimOverlap 이 라이브 출력을 모두 잘라낼 가능성도 있다(도구 id 재사용 여부에 따라 달라짐).
- **개선안**: connect() 가 재접속에 성공하면 list RPC 로 살아 있는 id 집합을 받는다. 거기 없는 subbers 는 pushExit 과 같은 경로로 닫고 onExit 를 합성해 부르며, 살아 있는 구독은 전부 닫아 브라우저가 since 로 재접속하게 한다(IPC-4 의 재동기 규약과 같음). invalidateList 도 함께 부른다.

### SHR-1 — LaunchLine 이 --model 값을 셸 인용하지 않는다 — zsh 에서 'opus[1m]' 류 모델명이 glob 으로 깨진다

`P1` · 결함 · S · LOW · B · 확인 · 묶음키 `adapter-launchline-quote`

- **위치**: `internal/shared/agentadapter/adapter.go:324`, `internal/shared/agentadapter/adapter.go:304`, `internal/helper/runtimebin/dmctl_run_subs.go:199`
- **근거**: launchLine 은 MemberArgs 와 prompt 는 sh.Quote 로 감싸지만 모델은 `parts = append(parts, a.ModelFlag, model)` 로 원문 그대로 붙인다. 함수 주석(304행)은 '프롬프트와 인자 값은 통째로 인용한다'고 적고 있다. 이 줄은 도구 셸에 그대로 타이핑된다(dmctl run launch). claude 모델명에는 `claude-opus-5[1m]` 같은 대괄호가 실제로 쓰인다(claude_proto.go 의 model 필드 주석). zsh 는 기본 NOMATCH 라서 `no matches found` 로 기동이 실패하고, 공백이나 ';' 가 들어간 값은 셸 명령 주입이 된다.
- **개선안**: `parts = append(parts, a.ModelFlag, sh.Quote(model))` 로 바꾸고, adapter_test 에 `[1m]`·공백·홑따옴표가 든 모델 값에 대한 posix/pwsh 기동줄 테스트를 더한다.

### DOM-6 — 원격 브랜치·태그 삭제 spec 이 잡 등록 전에 hint 를 기록한다

`P2` · 결함 · S · LOW · B · 확인 · 묶음키 `branch-delete-hints`

- **위치**: `internal/webserver/domain/git/write/branch.go:523`, `internal/webserver/domain/git/write/branch.go:531`, `internal/webserver/domain/git/write/tag.go:221`, `internal/webserver/domain/git/write/tag.go:230`, `internal/webserver/gitapi/gitjob.go:32`
- **근거**: RemoteBranchDeleteSpec·TagDeleteRemoteSpec 은 spec 을 만들면서 곧바로 s.AddHint 를 부른다. 핸들러는 그 뒤 startJob 을 부르고, 잡은 job_busy 등으로 실패할 수 있다. RebaseSpec·DropSpec 은 hint 를 돌려주고, startWriteJob 은 등록이 성공한 뒤에만 AddHint 한다(REPO_FIX 01 §5.1 '사전 단계는 부작용이 없다').
- **개선안**: 두 Spec 을 RebaseSpec 과 같은 모양 (WriteSpec, Hint, error) 로 바꾸고, 핸들러의 startJob 경로가 등록에 성공한 뒤 hint 를 기록하게 한다.
- **결정 충돌**: REPO_FIX 01 REQUIREMENTS §5.1 을 구현하는 변경이다.

### FEC-8 — 기본 프리셋 버튼의 표시 여부가 설정 적용 경로를 따라가지 않는다

`P2` · 결함 · S · LOW · B · 확인 · 묶음키 `settings-apply-hooks`

- **위치**: `web/js/core/main.js:34`, `web/js/core/app-presets.js:127`, `web/js/core/app-settings.js:43`, `web/js/ui/input-binding.js:237`
- **근거**: main.js:34 는 설정 GET 이 끝나기 전(themeReady 는 비동기)에 defaultPreset 을 읽어 #add-preset 을 숨긴다. 이 시점의 값은 늘 -1 이다. 다시 보이게 하는 자리는 _renderPresets(app-presets.js:127-128) 하나이고, initPresets 에서(= _bind, /api/state 응답 뒤) 또는 설정창 프리셋 탭을 열 때만 돈다. SETTINGS_ACCESS 의 layoutPresets·defaultPreset setter 는 값만 바꾸고 버튼을 칠하지 않는다(app-settings.js:43-44). 그래서 /api/state 가 /api/settings 보다 먼저 오면 기본 프리셋이 있어도 버튼이 숨고, 다른 브라우저가 기본 프리셋을 바꿔 settings_changed 가 와도 반영되지 않는다.
- **개선안**: _presetButtonPaint() 를 따로 빼서 defaultPreset·layoutPresets setter 가 부르게 한다. main.js:34 는 지운다(_settingsApply 가 부팅 경로이기도 하다).

### FEU-1 — GitRemoteList._load 가 stale 응답에서 _loading=true 를 영구히 쥔다

`P2` · 결함 · S · LOW · B · 확인 · 묶음키 `git-list-load-unify`

- **위치**: `web/js/git/remote.js:892`, `web/js/git/remote.js:899`, `web/js/git/remote.js:812`, `web/js/git/view-util.js:56`
- **근거**: remote.js:896 `this._loading=true;` → :899 `if(res.stale) return;` → :900 `this._loading=false;` 순서. _paintRows(:812)는 `(this._loading&&this._repo)?GIT_HIST_LOADING:GIT_RM_EMPTY` 로 판정한다. 공용 gitLoadList(view-util.js:56-66)는 FR-GRF-24 에 따라 `_loading=false` 를 stale 판정 앞에 둔다. branches/stash/worktrees/submodules 는 고쳤고 remote 만 옛 순서다. panel-poll.js:201 reloadRemotesIfOpen 이 관측 회차마다 이 경로를 돈다.
- **개선안**: gitLoadTicket/gitLoadTaken 을 도입하고 `if(gitLoadTaken(this,t)) return; this._loading=false; if(res.stale) return;` 로 순서를 바꾼다. FEU-2 와 묶어 gitLoadList 호출 하나로 바꾸는 편이 낫다.
- **이전 감사**: AUDIT-fe-ui H-1

### FEU-2 — GitRemoteList 가 gitLoadList/GitListTab 규약을 복제하고 AbortController 도 없다

`P2` · 중복 · M · LOW · B · 확인 · 묶음키 `git-list-load-unify`

- **위치**: `web/js/git/remote.js:746`, `web/js/git/remote.js:892`, `web/js/git/view-util.js:43`, `web/js/git/view-util.js:53`, `web/js/git/list-tab.js:1`
- **근거**: GitRemoteList 는 _repo/_items/_err/_loading/_el/panel 을 손으로 들고 _load 를 따로 구현한다(remote.js:892-910). 공용 gitLoadList 는 같은 필드(_list 이름만 다름)에 ticket·signal·echo·FR-GRF-24 순서를 이미 가진다. remote 만 gitFetch 호출에 signal 을 넘기지 않아 저장소를 빠르게 바꾸면 앞선 조회가 서버에서 끝까지 돈다(FR-GRF-31 이 없앤 문제).
- **개선안**: _items 를 _list 로 바꾸고 _load 를 `gitLoadList(this,{url:'/api/git/remotes',key:'remotes',failMsg:GIT_RM_LOAD_FAIL})` 한 줄로 바꾼다. 가능하면 GitListTab 을 상속해 mount/paint 골격도 합친다.
- **이전 감사**: AUDIT-fe-ui M-1

### FEU-3 — 테스트 정규식의 \b 때문에 ui-notice 가 버튼·span 에 잘못 붙어 버튼 치수가 덮인다

`P2` · 결함 · S · LOW · B · 확인 · 묶음키 `ui-notice-misapply`

- **위치**: `web/js/ui/file-editor.js:881`, `web/js/ui/file-editor.js:884`, `web/js/ui/file-editor.js:886`, `web/js/ui/file-editor.js:887`, `web/js/git/diff-view.js:480`, `web/js/test/kit-key.test.mjs:138`, `web/js/test/kit-key.test.mjs:185`, `web/style-kit.css:99`, `web/style-kit.css:271`
- **근거**: kit-key.test.mjs:185 `\\b${n}\\b` 는 하이픈을 단어 경계로 본다. 그래서 NOTICE 의 'fe-offer'·'git-diff-note' 가 'fe-offer-go'·'fe-offer-x'·'git-diff-note-act' 에도 맞고, 이 이름을 가진 버튼들이 전부 `ui-notice` 를 받았다(file-editor.js:881-887 `class="ui-notice ui-btn ui-btn-sm ..."`, diff-view.js:480). .ui-notice(style-kit.css:271, padding:6px 10px·font-size:var(--ui-font)·color:--text-muted)가 .ui-btn-sm(:99, padding:0 7px·font-size:--fs-sm)보다 뒤에 있고 명시도가 같아서 이긴다. 결과로 LSP 제안 띠의 버튼과 닫기 아이콘(fe-offer-x), diff 안내 동작 버튼의 패딩·글자 크기·색이 킷 값에서 벗어난다.
- **개선안**: 테스트 정규식을 `(?<![\\w-])${n}(?![\\w-])` 로 고치고, 버튼 5곳과 fe-offer-msg span 에서 ui-notice 를 뗀다. 컨테이너(.fe-offer·.git-diff-note)에만 남긴다.

### HTTP-11 — 에이전트 엔벨로프 포맷이 세 벌이고, 승계 요청만 to= 에 멤버 id 를 싣는다

`P2` · 중복 · S · MEDIUM · B · 확인 · 묶음키 `agent-envelope`

- **위치**: `internal/webserver/httpapi/handlers_toolio.go:155-158`, `internal/webserver/httpapi/handlers_runs_context.go:230-232`, `internal/webserver/httpapi/handlers_runs_context.go:400-403`
- **근거**: 같은 "[DONGMINAL-AGENT-MSG from=%s to=%s ts=%s]..." 포맷이 세 곳에 있다. :401 은 to=prev.ID(멤버 id)인데 배달은 deliverToTool(prev.ToolID). docs/external/api.md·agent-orchestration.md 는 to=<수신 도구 uuid> 로 정했다. 서버발 두 곳은 본문 quoteEnvelope 도 적용하지 않는다.
- **개선안**: handlers_toolio.go 에 agentEnvelope(from, toToolID, body string) 한 자리를 둔다. 발신자 상수 envelopeServerSender 와 ts 형식도 여기로 모은다. 세 호출처를 바꾸고, 승계 요청은 prev.ToolID 를 넘긴다(멤버 id 는 본문의 [HANDOFF-REQUEST member=] 에 이미 있다).
- **이전 감사**: AUDIT-go-http M-2 · D-4

### SHR-11 — 빈 dataDir 이 '.' 으로 풀려 테스트가 소스 트리에 tools.json·.bak.1~3 을 쓰고, 그 파일들이 git 에 커밋돼 있다

`P2` · 결함 · S · LOW · B · 확인 · 묶음키 `toolhub-datadir-empty`

- **위치**: `internal/shared/toolhub/manager.go:154`, `internal/shared/toolhub/tools.json`, `internal/shared/toolhub/notfound_test.go:15`, `internal/shared/toolhub/activity_tool_test.go:73`, `internal/webserver/httpapi/activity_alarm_test.go:32`
- **근거**: dataPath 는 dataDir 가 비면 "." 을 쓴다. NewToolManager("", nil) 로 만든 테스트가 Delete→saveAsync→SaveAll 을 지나면 패키지 디렉터리에 tools.json 이 생기고, 세대 회전으로 .bak.1~3 까지 생긴다. `git ls-files` 에 internal/shared/toolhub/tools.json, .bak.1, .bak.2, .bak.3 이 들어 있다(내용 `[]`). 프로덕션 호출자가 dataDir 를 비우면 서버의 cwd 에 상태 파일을 쓴다. toolBinDir 이 '상대경로를 만들지 않는다'로 고친 것과 같은 종류의 문제다.
- **개선안**: dataPath 가 dataDir=="" 이면 빈 값을 돌려주고 SaveAll/LoadAll 이 조용히 건너뛰게 한다(영속 없음). 테스트는 t.TempDir() 를 넘긴다. 커밋된 4개 파일은 지우고 .gitignore 에 `tools.json*` 패턴을 더한다.

### DOM-34 — 플러그인 아카이브 다운로드에 크기 상한이 없다

`P3` · 결함 · S · LOW · B · 확인 · 묶음키 `ext-fetch-limit`

- **위치**: `internal/webserver/domain/ext/fetch.go:38`, `internal/webserver/domain/ext/fetch.go:46`, `internal/webserver/domain/ext/fetch.go:71`
- **근거**: HTTPFetch 는 http.DefaultClient 로 받은 본문을 io.Copy 로 임시 파일에 무제한 쓴다. 해시 대조는 다 받은 뒤에 한다. 상한은 FetchTimeout(10분)뿐이다.
- **개선안**: Target 에 선택 필드 size(또는 전역 MaxArchiveBytes)를 두고 io.LimitReader 로 초과를 오류로 끊는다. 초과하면 해시 대조 전에 실패하고 임시 파일을 지운다.

### DOM-7 — indexOfMember 가 닫힌 Run 의 멤버도 집는다 — HandoffWaiting·GiveUpHandoff 가 닫힌 Run 을 저장한다

`P3` · 결함 · S · LOW · B · 확인 · 묶음키 `run-member-lookup`

- **위치**: `internal/webserver/domain/run/store_context.go:452`, `internal/webserver/domain/run/store_context.go:469`, `internal/webserver/domain/run/store_context.go:491`
- **근거**: 주석은 '열린 Run 에서'라고 하지만 State 를 거르지 않는다. GiveUpHandoff 는 닫힌 Run 에서도 HandoffPending 을 고치고 s.save() 한다.
- **개선안**: indexOfMember 는 그대로 두고 주석을 '모든 Run'으로 고친다. HandoffWaiting·GiveUpHandoff 에서만 s.runs[ri].State != Open 이면 돌아가게 한다.
- **이전 감사**: AUDIT-go-domain MED indexOfMember

### DOM-8 — 'SucceededFrom 전임자 찾기'가 세 벌이다

`P3` · 중복 · S · LOW · - · 확인 · 묶음키 `run-member-lookup`

- **위치**: `internal/webserver/domain/run/store_context.go:476`, `internal/webserver/domain/run/store_context.go:498`, `internal/webserver/domain/run/store_context.go:522`
- **근거**: HandoffWaiting·GiveUpHandoff·HandoffClause 가 각자 Members 를 선형 탐색해 ID==SucceededFrom 인 멤버를 찾는다.
- **개선안**: Record.predecessorIndex(m Member) (int, bool) 를 하나 두고 세 함수가 이것을 쓴다.
- **이전 감사**: AUDIT-go-domain MED SucceededFrom

### DOM-M1 — oid 길이를 40(SHA-1)으로 박아 SHA-256 저장소에서 서브모듈·blame 결과가 조용히 비어 나온다

`P3` · 하드코딩 · S · LOW · B · 검증자 추가 · 묶음키 `git-oid-format`

- **위치**: `internal/webserver/domain/submodule/submodule.go:58`, `internal/webserver/domain/submodule/submodule.go:122`, `internal/webserver/domain/git/query/blame.go:160`
- **근거**: const oidLen = 40 이고, parseStatus 는 line[1:1+oidLen] 가 hex 가 아니거나 뒤가 공백이 아니면 continue 한다. blameHeader 는 len(f[0]) != 40 이면 거부한다. object-format=sha256 저장소(64자)에서는 모든 줄이 버려져 오류 없이 빈 결과가 된다.
- **개선안**: oid 를 고정 길이가 아니라 '40 또는 64 자리 hex 토큰'으로 판정하는 공용 core.IsOid(s) 를 두고, 두 파서가 이것을 쓴다. 지원 범위를 SHA-1 로 한정할 것이라면 그 사실을 SRS 에 명시하고, 판정 실패를 빈 결과가 아니라 오류로 올린다.

### FEC-26 — 설정 컨트롤 DOM 동기화가 세 자리에 흩어져 있다(setter · 설정창 열기 · _init*)

`P3` · 중복 · M · LOW · - · 확인 · 묶음키 `settings-apply-hooks`

- **위치**: `web/js/core/app-settings.js:47`, `web/js/core/app-settings.js:356`, `web/js/core/app-settings.js:374`, `web/js/core/app-settings-init.js:23`
- **근거**: ds-fgnames·ds-claudefs·ds-confirmleave·ds-wordwrap·ds-minimap·ds-diffminimap·ds-tabfix·ds-tabw·ds-title 의 'getElementById→checked/value=전역' 이 세 곳에 있다. SETTINGS_ACCESS 의 set(v) 마다 한 번(app-settings.js:47-120), settings-btn 클릭 핸들러에서 한 번 더(:374-404), 각 _init* 에서 또 한 번(app-settings-init.js)이다. 새 설정을 더하면 세 곳을 모두 고쳐야 한다.
- **개선안**: SETTINGS_ACCESS 항목에 ctl:{id:'ds-wordwrap',kind:'check'|'value'} 를 선언하고 _paintSettingControls() 한 함수가 setter 뒤와 모달 열 때 칠한다. 이벤트 바인딩도 kind 로 생성한다(_initNumSetting 의 일반화).

### FEU-20 — GIT_TREE_PAD0=6 과 --git-tree-pad0:9px 가 다른데 주석은 같은 값이라고 한다

`P3` · 결함 · S · LOW · B · 확인 · 묶음키 `tree-indent-token`

- **위치**: `web/js/core/constants-git-changes.js:120`, `web/style-git-views.css:663`, `web/style-git-views.css:664`, `web/style-git.css:452`, `web/js/ui/file-tree-paint.js:804`, `web/js/git/panel-changes.js:586`
- **근거**: JS 행 패딩은 `GIT_TREE_PAD0(6)+depth*12` 이다(file-tree-paint.js:804, panel-changes.js:586). CSS 는 `/* GIT_TREE_INDENT · GIT_TREE_PAD0 (constants.js) 과 같은 값 */ --git-tree-pad0:9px` 이고 들여쓰기 가이드 배경 위치(style-git.css:452)가 이 값을 쓴다. 가이드 선과 행 들여쓰기가 3px 어긋난다.
- **개선안**: 한쪽을 정본으로 정한다. 권장은 JS 가 `getComputedStyle` 대신 CSS 변수로 패딩을 세우는 것이다(`el.style.setProperty('--depth',d)` + CSS `padding-left:calc(var(--git-tree-pad0) + var(--depth)*var(--git-indent))`). 그러면 값이 CSS 하나로 모이고 행마다 인라인 px 계산도 사라진다.
- **이전 감사**: AUDIT-fe-ui L-5

### FEU-M2 — TC-CMP-10b 가 \b 오탐을 게이트로 굳혀 FEU-3 수정을 막는다

`P3` · 결함 · S · LOW · - · 검증자 추가 · 묶음키 `ui-notice-misapply`

- **위치**: `web/js/test/kit-key.test.mjs:185`, `web/js/test/kit-key.test.mjs:138`
- **근거**: TC-CMP-10b 정규식 `\b${n}\b` 는 'fe-offer-x' 에서도 'fe-offer' 를 찾는다. 그래서 버튼에서 ui-notice 를 떼면 테스트가 실패한다. 즉 결함 있는 마크업을 테스트가 강제하고 있어서, 마크업만 고치는 수정은 CI 에서 막힌다.
- **개선안**: FEU-3 과 같은 배치에서 테스트 정규식을 `(?<![\w-])${n}(?![\w-])` 로 먼저 고친다(RED: 하이픈 확장 이름에 ui-notice 가 있으면 실패하는 역검사 추가). 그 다음 마크업을 고친다.

### HTTP-16 — os 오류 전문(절대경로 포함)이 여전히 응답 본문으로 나간다 (SEC-17 판정과 반대)

`P3` · 결함 · M · MEDIUM · B · 확인 · 묶음키 `err-leak-sec17`

- **위치**: `internal/webserver/httpapi/handlers_files.go:455`, `internal/webserver/httpapi/handlers_files.go:558`, `internal/webserver/httpapi/handlers_files.go:578`, `internal/webserver/httpapi/handlers_fs.go:91`, `internal/webserver/httpapi/handlers_fs.go:97-101`, `internal/webserver/httpapi/handlers_fs.go:136`, `internal/webserver/httpapi/handlers_fs.go:186-190`, `internal/webserver/httpapi/handlers_lsp.go:227`
- **근거**: "stat failed: "+err.Error(), "write failed: "+err.Error(), fsError{code, err.Error()}(fsFromOS·fsResolveErr), fsFailErr 폴백 fsFail(w, fsErrIO, err.Error()), lspFail(500, err.Error()) 가 *PathError 전문을 싣는다. fail.go:11-25 는 이것을 정찰 정보로 규정했다.
- **개선안**: fsError 에 cause error 필드를 두고 msg 는 우리가 쓴 문구로 채운다. fsFailErr 가 cause 를 dmlog 로 보낸다. handlers_files 세 곳과 lsp 저장 실패는 fail(w, status, 문구, err) 로 바꾼다. gitapi 의 gitTail 은 공개 계약(codes_doc)이라 제외한다.
- **이전 감사**: AUDIT-go-http M-6

### HTTP-17 — attention 계열 종단이 JSON 해석 실패와 필수 인자 누락을 한 코드로 뭉갠다

`P3` · 결함 · S · LOW · B · 확인 · 묶음키 `attention-bad-request-codes`

- **위치**: `internal/webserver/httpapi/handlers_attention.go:47`, `internal/webserver/httpapi/handlers_attention.go:86`, `internal/webserver/httpapi/handlers_attention.go:183`, `internal/webserver/httpapi/handlers_attention.go:293-296`, `internal/webserver/httpapi/httperr.go:56-63`
- **근거**: readBodyHTTP 가 돌려준 ok=false(해석 실패)와 ToolID==""·잘못된 state 가 모두 `httpErr(w, "bad request", 400, CodeBadRequest)` 로 나간다. background/set 은 깨진 JSON 도 CodeMissingArg 로 답한다. apierr 에는 CodeInvalidJSON·CodeMissingArg·CodeBadRequest 가 따로 있고 복구 안내도 각각 다르다.
- **개선안**: readBodyHTTP 의 계약(디코드 실패는 호출자 몫)은 유지한다. 호출자에서 `!ok` 는 CodeInvalidJSON, 필드 누락은 CodeMissingArg+항목명, 잘못된 state 는 CodeBadRequest+허용값으로 갈라 답한다. 필요하면 httperr.go 에 invalidJSON(w) 헬퍼를 둔다.
- **이전 감사**: AUDIT-go-http M-7

### HTTP-18 — fs 검색 잔여: clipLine UTF-8 절단, LookPath 매 요청, 테스트 전용 itoaGrep

`P3` · 결함 · S · LOW · - · 확인 · 묶음키 `fs-search-cleanup`

- **위치**: `internal/webserver/httpapi/handlers_fs_search.go:437-442`, `internal/webserver/httpapi/handlers_fs_search.go:219-225`, `internal/webserver/httpapi/handlers_fs_search.go:444-445`
- **근거**: clipLine 은 s[:fsGrepMaxLine] 로 룬 중간을 자른다. lookRipgrep 은 /api/fs/grep 요청마다 exec.LookPath("rg") 로 PATH 전체를 stat 한다. itoaGrep 은 strconv.Itoa 별칭인데 테스트만 쓴다.
- **개선안**: clipLine 은 utf8.RuneStart 로 절단점을 뒤로 물린다. itoaGrep 은 지우고 테스트가 strconv.Itoa 를 쓴다. lookRipgrep 캐시는 rg 사후 설치를 반영하지 못하므로 선택 사항으로 둔다(굳이 하려면 짧은 TTL 을 쓴다).
- **이전 감사**: AUDIT-go-http M-8 · P-5 · L-1

### HTTP-29 — FR-SAF-23 본문 상한 게이트가 없고, LSP 종단은 LimitReader 절단 탓에 413 대신 400 을 낸다

`P3` · 문서괴리 · S · LOW · B · 확인 · 묶음키 `body-limit-gate`

- **위치**: `docs/internal/SAFETY_CORRECTNESS_SRS.md:272-274`, `internal/webserver/httpapi/handlers_lsp.go:72`, `internal/webserver/httpapi/handlers_lsp.go:111`, `internal/webserver/httpapi/handlers_lsp.go:211`, `internal/webserver/httpapi/handlers_lsp.go:246`, `internal/webserver/httpreq/body.go:24-27`
- **근거**: SRS 는 `scripts/check-body-limit.sh`(r.Body 를 지나는 모든 호출이 httpreq 를 경유하는지, 예외는 사유와 함께 등록)를 요구한다. scripts/ 에 그 파일이 없다(FR-SAF-22 는 check-http-error.sh:84 로 구현됨). LSP 네 곳은 io.ReadAll(io.LimitReader(...)) 로 조용히 자르므로, 상한을 넘은 본문은 잘린 JSON 이 되어 400 'bad request'/'id required' 로 나간다.
- **개선안**: check-body-limit.sh 를 만들어 r.Body 참조를 httpreq/body.go 와 예외 등록부(handlers_files.go 업로드, handlers_lsp.go 4곳, WS)에 사유와 함께 대조하고, 탐침으로 검출을 확인한다(FR-SAF-25). LSP 는 httpreq 로 옮기지 않는다. 대신 LimitReader(r.Body, max+1) 로 읽어 len>max 이면 413 으로 답해 초과를 정확히 보고한다. SRS 의 FR-SAF-22 스크립트 이름을 실제 check-http-error.sh 로 고친다.
- **결정 충돌**: body.go 머리말은 '업로드·LSP·WS 는 실제 사고에서 배운 방어라 이 패키지가 우회하지 않는다' 고 적었다. 상한값은 유지하고 읽기 수단만 바꾸는 것이라 그 결정과 충돌하는지 확인이 필요하다. 충돌하면 게이트 예외 등록만 한다.

### HTTP-M3 — SAFETY_CORRECTNESS_SRS FR-SAF-22 가 없는 스크립트 이름(check-error-header.sh)을 가리킨다

`P3` · 문서괴리 · S · LOW · - · 검증자 추가 · 묶음키 `body-limit-gate`

- **위치**: `docs/internal/SAFETY_CORRECTNESS_SRS.md:270-271`, `scripts/check-http-error.sh`
- **근거**: SRS 는 `scripts/check-error-header.sh` 를 정했지만 scripts/ 에는 check-http-error.sh 와 check-error-docs.sh 만 있다. 감사 HTTP-29 는 FR-SAF-22 가 check-http-error.sh 로 구현됐다고 봤는데, 문서의 이름은 틀린 채 남아 있다.
- **개선안**: SRS 의 FR-SAF-22 항목을 실제 파일명 check-http-error.sh 로 고친다. FR-SAF-23 의 check-body-limit.sh 를 만들 때 같은 명명 규칙을 따른다.

## O2 — 데몬↔서버 IPC 왕복 축소 (18건)

### IPC-1 — 전경 이름 폴링이 2초마다 전체 list RPC 를 부르고, 데몬 dispatch 안에서 ps 탐침을 동기 실행한다

`P1` · 통신 · M · MEDIUM · - · 확인 · 묶음키 `daemon-fg-local-ticker`

- **위치**: `internal/webserver/hub/foreground.go:55-70`, `internal/shared/toolhub/manager.go:173-193`, `internal/shared/toolhub/foreground.go:117-172`, `internal/daemon/ipc/paned.go:153-154`, `internal/daemon/ipc/paned_server.go:80-87`, `internal/daemon/ipc/paned_handlers.go:296-304`
- **근거**: StartForegroundPoll 이 2초마다 tools.List() 를 부르고 데몬 모드에서는 이게 list RPC 다(ToolInfo 전체를 JSON 으로 싣고 client 가 marshal→unmarshal 로 다시 해석함). 데몬 쪽 pm.List() 는 ForegroundNames()→refreshForeground()→fgProbe(macOS ps 폴백, 주석 기준 수십 ms)를 dispatch 고루틴에서 동기로 돌린다. 그동안 같은 연결의 write(키 입력)·resize 가 전부 줄을 서서 기다린다. 전경 이름이 바뀌면 데몬은 이미 SetForegroundNotifier→pushForeground 로 밀어 주므로, 이 폴의 실제 목적은 데몬이 자기 캐시를 갱신하게 만드는 것뿐이다.
- **개선안**: 데몬 모드에서는 dongminald(boot.Run)가 fgRefreshInterval 티커를 직접 돌려 refreshForeground 를 비동기로 부르게 한다. list 핸들러는 캐시만 읽는다. 서버는 Tools.Daemon()!=nil 이면 StartForegroundPoll 을 걸지 않는다. pushForeground 는 지금 '다음 list 폴이 메운다'는 근거로 droppable 이므로 non-droppable 로 바꾸거나 저빈도(예: 30s) 안전망 list 를 남긴다. 기대 효과: list RPC 0.5/s 제거, dispatch 경로에서 ps 제거.
- **결정 충돌**: foreground.go:50-54 주석(FR-TAN-8 '편승할 폴링이 없어 티커를 둔다')은 브라우저 요청을 늘리지 않으려는 근거이고, 데몬 안으로 옮겨도 그 제약(C-3)은 지켜진다.

### IPC-3 — 데몬이 요청을 직렬로 처리해서 샌드박스 create(docker Ensure) 하나가 모든 도구의 입력을 막고 5초 시한으로 연결까지 끊는다

`P1` · 결함 · M · MEDIUM · B · 확인 · 묶음키 `daemon-dispatch-async`

- **위치**: `internal/daemon/ipc/paned.go:116-169`, `internal/daemon/ipc/paned_handlers.go:64-91`, `internal/shared/sandboxplace/place.go:107-175`, `internal/webserver/toolclient/client.go:21-24`, `internal/webserver/toolclient/client.go:403-408`, `internal/webserver/toolclient/client_toolhub.go:164-178`
- **근거**: handle() 는 Decode→dispatch 를 한 고루틴에서 차례로 돌리고, 비동기인 것은 terminate 하나뿐이다(paned.go:142-146). create 는 pm.Create→placer.Place 를 거치는데, 여기서 VerifyCopySource(트리 순회), EnsureHelper, p.mgr.Ensure(컨테이너 생성)가 모두 동기로 돈다. 클라이언트 create 는 기본 call(5초)을 쓰므로 시한이 지나면 dropIfCurrent 로 연결을 끊는다. 그러면 모든 WS 구독이 재접속하고, 도구는 데몬 쪽에서 계속 만들어져 고아가 된다. 그동안 다른 도구의 write/list 도 멈춘다.
- **개선안**: create·restore 를 terminate 처럼 `go pc.enqueue(pc.create(req), false)` 로 읽기 루프 밖에서 돌린다(연결당 세마포어로 동시 수 제한). 클라이언트 Create 는 callWithin(toolCreateTimeout, 예: 60s)을 쓴다. 같은 도구의 write 순서는 영향을 받지 않는다. 생성 전이라 아직 id 가 없기 때문이다.
- **결정 충돌**: client_toolhub.go:79-86 의 ListOK 캐시 주석은 '데몬은 한 연결의 요청을 직렬로 처리하므로 변경 중의 조회는 RPC 로 간다'는 순서를 전제로 하고, e2e skill-contract 가 그 순서를 단정한다. 비동기로 바꾸면 invalidateList 세대 검사로 여전히 안전한지 먼저 검증해야 한다.

### HTTP-M1 — 창 닫기 확인이 도구마다 /api/tools/{id}/busy HTTP 요청을 날리고, 각각이 데몬 busy RPC 가 된다 (브라우저→서버→데몬 N+1)

`P2` · 통신 · S · LOW · - · 검증자 추가 · 묶음키 `busy-probe-batch`

- **위치**: `web/js/core/app-layout.js:214`, `web/js/core/app-tool.js:8-11`, `internal/webserver/httpapi/handlers_api.go:323-331`, `internal/webserver/toolclient/client_toolhub.go:276-283`
- **근거**: app-layout.js:214 는 `Promise.all(pids.map(pid=>this._isToolBusy(pid)))` 로 창·칸 안의 도구마다 GET /api/tools/{id}/busy 를 보낸다. apiToolBusy 는 s.Tools.Busy(id) 를 부르고, 데몬 모드에서는 이것이 캐시 없는 call("busy") 다. 탭 N개인 창 하나를 닫으면 HTTP N회와 데몬 RPC N회가 오간다.
- **개선안**: GET /api/tools/busy?ids=a,b,c 일괄 종단을 추가해 {busy:{id:bool}} 로 답하고, 서버는 HTTP-2 의 데몬 일괄 busy RPC 한 번으로 채운다. 프론트는 창·칸 닫기에서 한 번만 부른다. 기존 단건 종단은 하위 호환을 위해 유지한다.

### IPC-10 — 활동 안전망 폴(5초·상시)이 부를 때마다 서버가 working 도구당 busy RPC 를 하나씩 데몬에 보낸다(N+1)

`P2` · 통신 · M · MEDIUM · - · 확인 · 묶음키 `activity-server-prune`

- **위치**: `web/js/core/state-registry.js:46-56`, `internal/webserver/hub/attn_tracker.go:384-411`, `internal/webserver/httpapi/handlers_attention.go:123-134`, `cmd/dongminal/main.go:277`, `internal/webserver/toolclient/client_toolhub.go:276-283`
- **근거**: tool.activity 는 every:agentsPollMs(5s) 로 패널 열림과 상관없이 돈다. AttnTracker.ActivitySnapshot 은 State=='working' 인 항목마다 busyProbe(=ToolClient.Busy→busy RPC)를 직렬로 부른다. 브라우저 B개·working 에이전트 A개면 5초마다 B×A RPC 가 나간다. 오래된 working 을 걷어내는 판정도 이 조회 안에만 있어서 서버가 그 사실을 밀지 못하고, 그래서 브라우저 폴이 필요하다(주석 '서버가 활동 변화를 전부 밀지는 않기 때문').
- **개선안**: 이미 1초마다 도는 AttnTracker 스위퍼(SweepIdleAt)에서 working 항목의 busy 를 저빈도(예: 5s)로 확인하고, 죽은 것은 activity 를 지우며 tool_activity{state:'ended'} 를 방송한다. ActivitySnapshot 은 캐시만 읽는다. busy 는 데몬에 `busymany`(ids[]) 일괄 RPC 를 두거나 list ToolInfo 에 Busy 를 싣는다. 브라우저 폴은 안전망(30s)으로 내린다.

### IPC-13 — IPC 출력 push 가 청크마다 JSON 을 3번 해석하고 base64·map 할당을 치른다

`P2` · 성능 · M · LOW · - · 확인 · 묶음키 `ipc-typed-wire`

- **위치**: `internal/webserver/toolclient/client.go:267-294`, `internal/webserver/toolclient/client_push.go:75-90`, `internal/daemon/ipc/paned_handlers.go:319-325`, `internal/shared/toolhub/tool.go:378-381`
- **근거**: readLoop 는 Decode(&RawMessage) 뒤 peek 구조체로 Unmarshal 하고, pushOutput 이 같은 raw 를 다시 Unmarshal 한 다음 base64.DecodeString 을 한다. 데몬은 청크(최대 8KB)마다 map[string]interface{} 를 만들고 base64 로 인코딩한다(+33%). 이 비용이 PTY 읽기 청크 수에 비례해서 가장 뜨거운 경로다.
- **개선안**: (S) 와이어는 그대로 두고 한 번만 해석한다: `type wireMsg struct{ID *int64; Event, Tool string; Data []byte; End int64; Code int; Cols, Rows uint16; Name string; Result json.RawMessage; Error *PanedErrObj}` 로 Decode 한 번에 끝낸다([]byte 필드는 표준 base64 를 자동 처리). 데몬도 map 대신 typed struct 를 enqueue 한다. (L) hello 기능 플래그로 협상하는 바이너리 output 프레임(길이 접두)을 추가한다.
- **결정 충돌**: FR-VHL-3 은 프로토콜 판이 다르면 연결을 거부하고, 데몬은 서버 업그레이드를 넘어 오래 산다. 바이너리 프레임은 ProtocolVersion 을 올리지 말고 hello 의 추가 필드(features)로 협상해야 PTY 를 잃지 않는다.

### IPC-14 — IPC 계약이 타입 없이 양쪽 문자열 리터럴·익명 구조체·map[string]any·float64 단언으로 흩어져 있다

`P2` · 추상화 · L · MEDIUM · - · 확인 · 묶음키 `ipc-typed-wire`

- **위치**: `internal/daemon/ipc/paned.go:133-167`, `internal/daemon/ipc/paned_handlers.go:64-285`, `internal/webserver/toolclient/client_toolhub.go:99-121`, `internal/webserver/toolclient/client_toolhub.go:166-297`, `internal/webserver/toolclient/client_toolhub.go:325-380`, `internal/webserver/toolclient/client_push.go:17-28`, `internal/shared/toolipc/wire.go:19-38`
- **근거**: 메서드 이름("create","kill","snapshot",…)과 이벤트 이름("output","fg","exit","size")이 데몬과 클라이언트에 각각 리터럴로 적혀 있다. 파라미터 키("graceMs","extraEnv","since")도 데몬 쪽 익명 struct 태그와 클라이언트 쪽 map 키 두 벌이다. 결과는 map[string]interface{} 로 받아서 SnapshotToolSince 가 float64 단언 9개, decodeModes 가 손 변환을 하고, ListOK·BackgroundList 는 json.Marshal(raw)→Unmarshal 로 왕복한다(list 는 2초마다 불림). toolipc 패키지는 바로 이 공유를 위해 있는데 요청·응답 봉투만 담고 있다.
- **개선안**: toolipc 에 `const MethodCreate = "create" …`, `EventOutput …` 과 typed 구조체(CreateParams/CreateResult, SnapshotParams/SnapshotResult{Data []byte; Modes toolhub.TermModes…}, ListResult{Tools []toolhub.ToolInfo} 등)를 둔다. callWithin 은 json.RawMessage 를 돌려주고, 제네릭 `callT[R any](method, params) (R, error)` 로 한 번에 해석한다. 와이어 JSON 은 바이트 단위로 같게 유지한다(옛 데몬 호환).

### IPC-18 — exit push 의 stderr 사유가 양쪽 모두에서 사라졌는데, 주석은 여전히 있다고 말한다

`P2` · 문서괴리 · S · LOW · - · 확인 · 묶음키 `exit-reason`

- **위치**: `internal/daemon/ipc/paned_handlers.go:289-294`, `internal/webserver/toolclient/client_push.go:145-175`, `internal/webserver/toolclient/client.go:106-111`, `internal/shared/toolhub/manager_notify.go:43-45`, `internal/shared/toolhub/tool_exitinfo.go:8-10`
- **근거**: 데몬 pushExit 는 {event,tool,code} 만 보낸다. 클라이언트는 Stderr []string 을 파싱해 놓고 ExitInfo{Code} 로 버린다. ExitInfo 에는 Code 필드뿐이다. SetOnExit·SetExitObserver 주석은 'info 는 종료 코드와 stderr 꼬리다(D-C-15)'라고 단언한다. M8_PROGRESS 는 D-C-15 를 '해소'로 기록했다.
- **개선안**: 결정한다: ① 되살린다면 ExitInfo.Reason 을 추가하고 데몬 pushExit·직접 모드 tool.go 가 stderrTail 을 채우며 클라이언트가 옮긴다. ② 폐기한다면 Stderr 필드와 주석 두 곳을 지우고 M8_PROGRESS 에 폐기 기록을 남긴다.
- **이전 감사**: AUDIT-go-http.md M-1, D-3

### IPC-2 — 키 입력·리사이즈가 WS 프레임마다 동기 RPC 왕복을 하는데 응답은 버려진다

`P2` · 통신 · M · MEDIUM · - · 확인 · 묶음키 `ipc-oneway-input`

- **위치**: `internal/webserver/httpapi/handlers_ws.go:244-246`, `internal/webserver/toolclient/client_toolhub.go:241-265`, `internal/webserver/toolclient/client.go:346-412`, `internal/daemon/ipc/paned_handlers.go:148-166`
- **근거**: handleWSDaemon 의 wsReadLoop 는 입력마다 `_ = s.Tools.Write(toolID, b); return nil` 으로 오류를 버리고 resize 도 `_ =` 로 버린다. 그래도 Write 는 call()→id 등록→Encode→응답 대기(5초 시한)를 거친다. 결과적으로 키 하나마다 요청·응답 두 프레임이 오가고 base64 인코딩이 붙으며, 다음 WS 프레임은 응답이 올 때까지 읽히지 않는다. 데몬 dispatch 가 막히면(IPC-1·IPC-3) 타이핑이 그대로 멈춘다.
- **개선안**: toolipc 에 응답 없는 알림 형식(id 생략 또는 `input`/`resizeNotify` 메서드)을 추가한다. 데몬은 알림에 응답을 enqueue 하지 않는다. WS 경로는 이 알림을 쓰고, HTTP send-input 경로(GO-8 로 오류를 돌려줘야 하는 곳)는 지금 RPC 를 유지한다. 데몬 dispatch 가 직렬이므로 순서는 그대로 보장된다. 옛 데몬이 이 메서드를 모르면 hello 에서 기능 플래그를 보고 강등한다.
- **결정 충돌**: GO-8(paned_handlers.go:160-163) 은 '없는 도구에 쓴 것도 성공으로 답하지 않는다'이다. WS 경로는 이미 그 오류를 버리고 있어 충돌하지 않지만, HTTP 경로에서는 RPC 를 유지해야 한다.

### SHR-5 — 데몬 모드에서 웹서버가 2초마다 list RPC 전체를 불러 데몬 안의 전경 조회를 일으킨다 — 답은 버린다

`P2` · 통신 · M · LOW · - · 확인 · 묶음키 `fg-poll-daemon-owned`

- **위치**: `internal/webserver/hub/foreground.go:52`, `internal/shared/toolhub/foreground.go:117`, `internal/shared/toolhub/manager.go:174`, `cmd/dongminal/app.go:180`
- **근거**: StartForegroundPoll 은 2초 티커로 `tools.List()` 를 부르고 결과를 버린다. 데몬 모드에서 이것은 IPC list RPC 이고, 데몬은 모든 도구의 Size ioctl·정렬·직렬화까지 해서 목록 전체를 돌려준다. 정작 필요한 것은 데몬 안의 refreshForeground 부작용(변화 시 fgNotify → IPC push)뿐이다. 브라우저가 한 명도 없어도 이 티커는 돈다.
- **개선안**: 데몬(ToolManager 소유자)이 자기 fgRefreshInterval 티커로 refreshForeground 를 직접 돌리고 변화만 push 하게 한다. 웹서버의 StartForegroundPoll 은 직접 모드에서만 돌린다. 가능하면 SSE 구독자가 있을 때만 돌린다. 그러면 정상 상태에서 2초마다 오가던 RPC 가 0이 된다.
- **결정 충돌**: CONVENIENCE_SRS FR-TAN-8 는 기존 폴링에 편승하라고 한다. hub/foreground.go 주석은 편승할 폴링이 없어 티커를 뒀다고 적는다. 데몬이 주체가 되는 쪽은 C-3(브라우저 요청 불증가)를 깨지 않는다.

### HTTP-1 — 데몬 모드 ForegroundPoll 이 부수효과만을 위해 2초마다 list RPC 전량을 왕복한다

`P3` · 통신 · M · MEDIUM · - · 확인 · 묶음키 `daemon-fg-self-tick`

- **위치**: `internal/webserver/hub/foreground.go:55-70`, `cmd/dongminal/app.go:188-192`, `internal/webserver/toolclient/client_toolhub.go:126`
- **근거**: StartForegroundPoll 은 2초마다 tools.List() 를 부르고 결과를 버린다. 주석대로 데몬 모드에서는 이것이 list RPC 가 되어 dongminald 안에서 ForegroundNames 를 돌리게 하는 것이 목적이다. 실제 변화는 이미 IPC push(SetOnForeground → BroadcastForeground)로 온다. listCacheTTL 이 200ms 라서 2초 틱은 거의 매번 실제 RPC 가 되고, 도구 목록 전체를 직렬화·역직렬화한다.
- **개선안**: PTY 를 가진 데몬이 자기 ticker(fgRefreshInterval 2s)로 ForegroundNames 를 돌리고 변화 시 fg push 만 보내게 한다. 웹서버 StartForegroundPoll 은 direct 모드에서만 띄운다(app.run 에서 bd.pm != nil 일 때만). 데몬 쪽 ticker 추가는 IPC 영역과 함께 처리한다.
- **결정 충돌**: CONVENIENCE_SRS FR-TAN-8(2초 주기, 브라우저 새 요청 0)과 충돌하지 않는다. 주기를 도는 주체만 데몬으로 옮긴다.

### HTTP-2 — Busy 프로브가 도구마다 데몬 RPC 를 날린다 (N+1, 캐시 없음)

`P3` · 통신 · M · LOW · - · 확인 · 묶음키 `busy-probe-batch`

- **위치**: `internal/webserver/hub/attn_tracker.go:404-408`, `internal/webserver/hub/attn_tracker.go:445`, `internal/webserver/httpapi/handlers_runs_cleanup.go:118-122`, `internal/webserver/toolclient/client_toolhub.go:276-283`, `cmd/dongminal/main.go:278`
- **근거**: ActivitySnapshot 은 state==working 인 항목마다 probe(toolID) 를 부른다. 데몬 모드의 probe 는 toolHub.Busy 이고, 이것은 캐시 없이 매번 call("busy") 한다. 그래서 GET /api/tools/activity 한 번이 working 도구 수만큼 RPC 를 직렬로 왕복한다. waitToolsIdle 은 250ms 마다 ids 전체에 Busy RPC 를 반복한다. SweepIdleAt 은 RPC probe 를 부른 뒤에야 로컬 판정(turn.InProgress, ActivityStillWorking)을 한다.
- **개선안**: ① 데몬에 ids 배열을 받는 busy 일괄 RPC 를 추가하고 ActivitySnapshot·waitToolsIdle 이 그것을 1회 호출한다. 캐시된 FgName 으로 busy 를 파생하지 않는다(실시간 IsBusy 와 뜻이 다르다). ② SweepIdleAt 에서 agentSeen → turn.InProgress → ActivityStillWorking 순으로 로컬 판정을 먼저 하고 probe 는 마지막에 부른다. AND 조건이므로 결과는 같다.

### HTTP-6 — 데몬 모드 WS 중계가 OutChunk 하나마다 WS 프레임 하나를 보낸다 (합치기 없음)

`P3` · 통신 · S · LOW · - · 확인 · 묶음키 `ws-relay-coalesce`

- **위치**: `internal/webserver/httpapi/handlers_ws.go:319-350`, `internal/webserver/httpapi/handlers_ws.go:207-209`
- **근거**: relayOutput 은 outputCh(버퍼 256)에서 청크를 하나씩 꺼내 conn.Send(OpOutput, data) 를 청크마다 호출한다. `cat` 같은 대량 출력에서는 데몬 push 단위가 곧 브라우저 프레임 수가 되어 프레임 헤더·SafeConn 락·syscall·xterm write 호출이 청크 수만큼 생긴다.
- **개선안**: 청크를 받으면 채널에 이미 쌓인 연속 출력 청크를 non-blocking 으로 더 꺼내 상한(예: 64KiB) 안에서 이어 붙인 뒤 한 프레임으로 보낸다. Size 청크나 exit 를 만나면 먼저 flush 해 순서를 지킨다. trimOverlap 의 sent 오프셋 계산은 합친 끝 기준으로 유지한다.

### IPC-22 — callWithin 이 소켓 쓰기 동안 넓은 pc.mu 를 쥐고, 파라미터 Marshal 오류를 버린다

`P3` · 성능 · S · LOW · - · 확인 · 묶음키 `ipc-typed-wire`

- **위치**: `internal/webserver/toolclient/client.go:346-372`
- **근거**: `pc.mu.Lock(); err := enc.Encode(req); pc.mu.Unlock()` 에서 pc.mu 는 pending·콜백·daemonInfo·conn 을 모두 지키는 잠금이다. 쓰기가 막히면 readLoop 의 handleResponse·pushOutput(콜백 읽기)도 멈춘다. `paramBytes, _ := json.Marshal(params)` 는 오류를 삼킨다.
- **개선안**: 쓰기 전용 writeMu 를 분리한다. Marshal 오류는 pending 을 지우고 반환한다. IPC-14 의 typed params 로 가면 Marshal 실패 경로 자체가 사실상 사라진다.
- **이전 감사**: AUDIT-go-http.md P-7

### IPC-23 — WS 연결마다 존재 확인용 list RPC(Get)를 한 뒤 snapshot RPC 를 또 부른다

`P3` · 통신 · S · LOW · - · 확인 · 묶음키 `ws-connect-rpc`

- **위치**: `internal/webserver/httpapi/handlers_ws.go:50-76`, `internal/webserver/toolclient/client_toolhub.go:195-203`, `internal/daemon/ipc/paned_handlers.go:213-225`
- **근거**: handleWS 가 s.Tools.Get(toolID)(=list 전체, 캐시 200ms)로 존재를 확인하고, handleWSDaemon 이 SnapshotToolSince 를 한 번 더 부른다. 데몬 snapshot 은 없는 도구에 CodeInternal 을 돌려줘서 '없음'과 '내부 오류'가 구분되지 않는다.
- **개선안**: toolipc 에 CodeNotFound 를 추가하고 snapshot·write·kill 의 ErrToolNotFound 를 그 코드로 옮긴다. 데몬 모드 WS 는 Get 을 건너뛰고 snapshot 에서 NotFound 면 OpExit/holdMiss 갈래로, 연결 끊김이면 재시도 갈래로 보낸다. 연결당 RPC 가 2→1 이 된다.

### IPC-24 — 데몬 Accept 의 '이전 연결 닫기' 갈래는 직렬 accept 루프에서 도달할 수 없고, hello 는 쓰이지 않는 값을 주고받는다

`P3` · 복잡도 · S · LOW · - · 확인 · 묶음키 `daemon-accept-cleanup`

- **위치**: `internal/daemon/ipc/paned_server.go:160-214`, `internal/daemon/boot/boot.go:123-141`, `internal/daemon/ipc/paned_handlers.go:43-62`, `internal/webserver/toolclient/client.go:174`, `internal/webserver/toolclient/client.go:196-209`
- **근거**: boot.Run 은 ps.Accept() 를 부르고, Accept 는 pc.handle() 이 끝날 때까지 돌아오지 않는다. 그래서 다음 Accept 시점에 currConn 은 이미 stop 된 상태이고 `if ps.currConn != nil { stop() }` 은 무의미하다. 옛 서버가 살아서 연결을 쥐고 있으면 새 서버의 dial 은 backlog 에 걸린 채 hello 5초 시한으로 실패한다. hello 는 `tool_ids` 를 싣지만(여기서 pm.List()→ps 탐침까지 돈다) 클라이언트 parseHello 는 읽지 않는다. 클라이언트는 `server_pid:0` 상수를 보낸다.
- **개선안**: 의도를 정한다. 인계(새 연결이 옛 연결을 대체)가 목적이면 Accept 를 루프 고루틴에서 받고 handle 을 go 로 돌린다. 직렬이 목적이면 죽은 갈래와 주석을 지운다. hello 의 tool_ids·server_pid 를 없앤다(옛 데몬·서버는 모르는 키를 무시하므로 호환된다).

### IPC-25 — WS 송신이 프레임마다 op 바이트를 붙이려고 payload 전체를 새로 할당·복사한다

`P3` · 성능 · S · LOW · - · 확인 · 묶음키 `ws-send-zero-copy`

- **위치**: `internal/shared/toolhub/conn.go:109-118`, `internal/shared/toolhub/tool.go:378-390`, `internal/webserver/httpapi/handlers_ws.go:339`
- **근거**: SafeConn.Send 가 `m := make([]byte, 1+len(payload)); copy` 를 매번 한다. 직접 모드 readPTY 는 relay 용 append 복사와 msg 할당·복사를 청크마다 따로 한다. 재생 payload(최대 1MB)도 같은 경로로 한 번 더 복사된다.
- **개선안**: Send 를 `w, _ := conn.NextWriter(BinaryMessage); w.Write([]byte{op}); w.Write(payload); w.Close()` 로 바꿔 복사를 없앤다(뮤텍스 구간은 그대로). readPTY 는 msg 버퍼 하나로 relay·deliver 를 함께 쓰도록 정리한다.

### IPC-M2 — Busy RPC 오류를 '바쁘지 않음'으로 읽어서 데몬 재연결 창에서 working 카드가 스냅샷에서 사라진다

`P3` · 결함 · S · LOW · B · 검증자 추가 · 묶음키 `activity-server-prune`

- **위치**: `internal/webserver/toolclient/client_toolhub.go:276-283`, `internal/webserver/hub/attn_tracker.go:405-410`
- **근거**: Busy() 는 call 오류(연결 끊김·시한)에 false 를 돌려주고, ActivitySnapshot 은 probe 가 false 인 working 항목을 뺀다. 재연결 중에 5초 폴이 돌면 살아 있는 에이전트 카드가 빠진 스냅샷이 나가고, 다음 폴까지 패널에서 사라진다. 'false' 와 '모름' 이 구분되지 않는다(TOOL_LIST_UNKNOWN_SRS 의 known 규약과 같은 부류).
- **개선안**: Busy 를 (bool, ok bool) 로 바꾸고, ok=false 면 항목을 유지한다. 또는 IPC-10 처럼 서버 스위퍼로 판정을 옮기고 오류 시 판정을 보류한다.

### IPC-M3 — hello 핸들러와 list 가 매 연결·매 폴마다 pm.List() 전체(전경 탐침 포함)를 계산한다

`P3` · 통신 · S · LOW · - · 검증자 추가 · 묶음키 `daemon-accept-cleanup`

- **위치**: `internal/daemon/ipc/paned_handlers.go:43-62`, `internal/shared/toolhub/manager.go:173-193`
- **근거**: hello 는 쓰이지 않는 tool_ids 를 만들려고 pm.List() 를 부른다. 그러면 ForegroundNames→refreshForeground→fgProbe 가 돌고, 이 탐침이 hello 5초 시한 안의 핸드셰이크 경로에 들어간다. IPC-24 가 필드 제거를 제안했지만 탐침 비용이 핸드셰이크 지연에 끼는 점은 짚지 않았다.
- **개선안**: hello 에서 pm.List() 호출을 없앤다(IPC-24 와 한 묶음). 꼭 id 가 필요하면 pm.Snapshot() 의 id 만 쓴다.

## O3 — PTY 출력 핫패스 (8건)

### SHR-2 — 직접 모드: WS 전송이 readPTY 고루틴 안에서 동기로 일어나 느린 클라이언트 하나가 PTY 읽기를 최대 10초 막는다

`P1` · 성능 · M · MEDIUM · B · 확인 · 묶음키 `pty-hotpath`

- **위치**: `internal/shared/toolhub/tool_clients.go:62`, `internal/shared/toolhub/tool.go:390`, `internal/shared/toolhub/conn.go:60`, `internal/shared/toolhub/tool_control.go:68`
- **근거**: deliver 주석은 '쓰기는 락 밖이다 — 느린 소켓 하나가 PTY 읽기 루프를 멈추게 하면 안 된다'고 적는다. 하지만 deliver 는 readPTY 가 직접 부르고, 클라이언트마다 c.WriteMsg 를 차례로 부르며, 각 쓰기에는 writeWait=10s 데드라인이 걸린다. 락은 피했지만 루프는 멈춘다. 그동안 PTY 버퍼가 차면 셸도 멈추고, 같은 도구의 다른 클라이언트도 출력을 받지 못한다. kill() 의 OpExit 방송도 같은 모양이다.
- **개선안**: SafeConn 마다 제한된 송신 큐(채널)와 writer 고루틴을 둔다. 큐가 넘치면 그 연결을 닫는다(이미 웹서버 hub 가 쓰는 '넘친 구독은 닫는다' 규약과 같다). 최소안은 deliver 의 쓰기 데드라인을 짧은 전용 상수로 분리하는 것이다. 주석을 실제 동작에 맞게 고친다.
- **결정 충돌**: 직접 모드는 데몬이 없을 때의 폴백 경로다(architecture.md:27). 데몬 모드 WS 는 웹서버 쪽 구독 채널 경로라 이 문제가 없다.

### SHR-3 — readPTY 가 청크마다 할당을 두 번 한다 — 구독자가 0명이어도 OpOutput 프레임을 만든다

`P2` · 성능 · S · LOW · - · 확인 · 묶음키 `pty-hotpath`

- **위치**: `internal/shared/toolhub/tool.go:378`, `internal/shared/toolhub/tool.go:380`, `internal/shared/toolhub/tool.go:387`, `internal/shared/toolhub/tool.go:418`
- **근거**: 청크마다 ① 릴레이용 `append([]byte(nil), raw[:n]...)` ② `msg := make([]byte, 1+n)` + copy 가 일어난다. feedAndClients 는 exited 가 아니면 cls 가 비어 있어도 live=true 를 준다. 데몬 프로세스에서는 브라우저 소켓이 cls 에 붙지 않으므로(notifySize 주석: '데몬 모드에서는 cls 가 비어 있다') ② 는 모든 청크에서 버려진다. 데몬 릴레이의 pushOutputData 는 data 를 동기로 base64 인코딩하므로 ① 의 사본을 보관하지도 않는다.
- **개선안**: feedAndClients 가 `live = len(conns) > 0` 을 돌려주게 하고, 둘 다 필요할 때는 msg 를 한 번만 만든 뒤 릴레이에 `msg[1:]` 를 넘긴다(둘 다 읽기 전용이다). 그러면 데몬 모드는 청크당 할당 1회, 직접 모드도 1회가 된다. outbuf 의 `TestFeedDoesNotRetainInput` 처럼 '릴레이가 받은 슬라이스를 이후 청크가 덮지 않는다'를 테스트로 고정한다.

### HTTP-5 — AttnTracker.FeedOutput 핫패스가 출력 청크마다 뮤텍스를 두 번 잡는다

`P3` · 성능 · S · LOW · - · 확인 · 묶음키 `attn-hotpath-locks`

- **위치**: `internal/webserver/hub/attn_tracker.go:163-166`, `internal/webserver/hub/attn_tracker.go:246-266`, `cmd/dongminal/app.go:126-128`
- **근거**: 데몬 모드에서는 모든 도구의 모든 출력 push 가 FeedOutput 을 지난다. 여기서 t.state() 가 t.mu 를 잡고(맵 조회), 곧이어 t.now() 가 테스트 시계 주입을 위해 t.mu 를 한 번 더 잡는다. 같은 락을 스위퍼·ActivitySnapshot·Attention 조회도 쓴다.
- **개선안**: nowFn 은 생성 시 고정하고 테스트는 생성자 옵션이나 atomic.Pointer 로 주입한다. 그러면 now() 에서 락이 빠진다. 도구 상태 맵은 sync.Map 이나 RWMutex 읽기 경로로 바꿔 청크당 배타 락을 없앤다.

### IPC-15 — 직접 모드는 PTY 읽기 루프에서 WS 쓰기를 동기로 해서, 느린 브라우저 하나가 그 도구의 출력 전체를 최대 10초씩 세운다

`P3` · 결함 · M · MEDIUM · B · 확인 · 묶음키 `direct-mode-sender`

- **위치**: `internal/shared/toolhub/tool.go:374-390`, `internal/shared/toolhub/tool_clients.go:62-72`, `internal/shared/toolhub/conn.go:59-64`, `cmd/dongminal/main.go:103`, `cmd/dongminal/main.go:121`
- **근거**: readPTY 가 청크마다 p.deliver(msg, conns) 를 직접 부르고, deliver 는 클라이언트마다 WriteMsg(writeWait=10s)를 차례로 한다. 주석은 '쓰기는 락 밖이다 — 느린 소켓 하나가 PTY 읽기 루프를 멈추게 하면 안 된다'고 하지만 락 밖일 뿐 같은 고루틴이라 루프가 멈춘다. 그동안 PTY 버퍼가 차면 셸이 블록되고, 같은 도구의 다른 클라이언트도 기다린다. 데몬 모드는 채널+드롭으로 분리돼 있어서 두 모드의 동작이 다르다. 직접 모드는 데몬 기동 실패 시의 폴백이다.
- **개선안**: 클라이언트마다 버퍼 채널(예: 256)과 송신 고루틴을 두고(데몬 모드 relayOutput 과 같은 모양), 넘치면 그 연결을 닫는다(IPC-4 와 같은 재동기 규약). deliver 는 non-blocking 으로 enqueue 만 한다. 오해를 부르는 주석도 고친다.

### SHR-25 — outbuf.Stream 이 쓰지 않는 context 를 받아 들고 다닌다

`P3` · 복잡도 · S · LOW · - · 확인 · 묶음키 `outbuf-simplify`

- **위치**: `internal/shared/outbuf/stream.go:20`, `internal/shared/outbuf/stream.go:37`, `internal/shared/outbuf/stream.go:122`, `internal/shared/toolhub/tool.go:307`
- **근거**: Stream 은 ctx·cancel 을 필드로 들지만 ctx 를 읽는 곳이 없다. cancel 은 Close 에서 불리기만 한다. 주석 'parent가 Done되면 내부 리소스를 정리한다'와 달리 parent 가 끝나도 아무 일도 일어나지 않는다. 호출자는 늘 context.Background() 를 넘긴다.
- **개선안**: ctx·cancel 필드와 NewStream 의 parent 인자를 없앤다(NewStream(max)). 주석도 실제 동작에 맞춘다.

### SHR-4 — 청크 하나를 ESC 기준으로 세 번 훑고, carry 연결을 두 벌로 따로 할당한다

`P3` · 성능 · M · MEDIUM · - · 확인 · 묶음키 `pty-hotpath`

- **위치**: `internal/shared/toolhub/tool_attention.go:24`, `internal/shared/toolhub/tool_attention.go:35`, `internal/shared/toolhub/tool_attention.go:39`, `internal/shared/toolhub/termmodes.go:134`, `internal/shared/toolhub/attention.go:149`
- **근거**: observeOutputAt 는 attnCarry+chunk 를 새로 할당해 이어 붙이고 IndexByte 두 번, DetectCwdReport(전체 스캔), DetectAttentionSignal(전체 스캔)을 돈다. 곧이어 observeModes 가 modeCarryBuf+chunk 를 다시 할당하고 IndexByte, scanModes 를 돈다. TUI 에이전트(Claude Code) 출력은 거의 모든 청크에 ESC 가 있어서 'ESC 없으면 빠져나간다'는 빠른 경로가 거의 타지 않는다. parsePrivateMode 도 시퀀스마다 params 슬라이스를 할당한다.
- **개선안**: ESC/BEL 위치를 한 번 훑어 OSC(주의·cwd)와 CSI ?h/l(모드)를 한 패스에서 분기하는 `escScanner` 로 합치고, carry 는 하나(최대 max(AttnMaxCarry, modeMaxCarry))로 줄인다. 재사용 스크래치 버퍼로 carry 연결 할당도 없앤다. params 는 고정 크기 배열([8]int)로 받는다. 기존 attention_*·termmodes 테스트가 회귀 검출기가 된다.

### SHR-M1 — readPTY 읽기 버퍼가 8KB 라 대량 출력 때 청크 수만큼 IPC push 프레임(base64 JSON map)과 WS 프레임이 생긴다

`P3` · 통신 · S · LOW · - · 검증자 추가 · 묶음키 `pty-hotpath`

- **위치**: `internal/shared/toolhub/tool.go:354`, `internal/daemon/ipc/paned_handlers.go:319`
- **근거**: raw := make([]byte, 8192) 로 고정돼 있다. 청크마다 relay.onOutput → pushOutputData 가 map[string]interface{} + base64 로 프레임 하나를 만들고, 그 채널은 droppable 이다(paned.go:99). `cat` 같은 버스트에서는 8KB 마다 JSON 프레임 하나와 인코딩 비용이 들고, 큐가 차면 청크를 버린다.
- **개선안**: 읽기 버퍼를 32KB~64KB 로 키워 프레임 수를 줄인다(추가 지연 없음). 필요하면 relay 쪽에 짧은 창(예: 2~4ms, 상한 64KB)의 합치기를 둔다. 효과는 프레임 수·push 드롭 카운터로 측정한다.

### SHR-M2 — outbuf.Stream 이 도구마다 1MB 를 미리 할당하고, 1MB 를 넘는 순간 2MB 급으로 재할당·복사한다

`P3` · 성능 · S · LOW · - · 검증자 추가 · 묶음키 `outbuf-simplify`

- **위치**: `internal/shared/outbuf/stream.go:39`, `internal/shared/outbuf/stream.go:55`
- **근거**: NewStream 은 buf: make([]byte, 0, max) 로 1MB 를 잡는다. Feed 는 len>2*max 가 될 때까지 append 로 늘리므로 cap 이 1MB→(Go 성장)→2MB 이상으로 재할당되고 기존 1MB 를 복사한다. 거의 출력하지 않는 도구도 1MB 를 차지하고, ToolCap=256 이면 최소 256MB 다.
- **개선안**: 초기 cap 을 작게(예: 64KB) 두거나 2*max 고정 크기 링버퍼로 바꿔 재할당과 compaction 복사를 없앤다. Since/Snapshot 의 계약(FR-TRS-1/2)은 기존 테스트로 고정한다.

## O4 — 서버↔브라우저 폴링→푸시·요청 합치기 (28건)

### IPC-5 — 부팅 시 모든 도구(다른 창·숨은 탭 포함)의 WS 를 한꺼번에 열어 도구 수만큼 스냅샷(각 최대 1MB)을 받는다

`P1` · 통신 · M · MEDIUM · B · 확인 · 묶음키 `term-lazy-connect`

- **위치**: `web/js/core/app.js:146-152`, `web/js/core/app.js:298-308`, `web/js/ui/renderer-pane.js:84-87`, `internal/webserver/httpapi/handlers_ws.go:184-227`, `internal/shared/toolhub/conn.go:63`
- **근거**: init() 가 /api/state 의 tools 전부에 대해 mkTool()→p.connect() 를 부른다(app.js:152). 도구마다 WS 핸들러가 list RPC(Get)와 snapshot RPC 를 한 번씩 부르고, 데몬은 링버퍼 tail(bufMax 1MB)을 base64 로 JSON 에 싣는다. 탭 20개면 부팅 한 번에 WS 20개, RPC 40건, JSON 최대 약 27MB 를 해석하고 xterm 20개에 재생한다. renderer-pane.js:86 이 이미 탭을 그릴 때 mkTool 을 부르므로 지연 생성할 자리는 있다.
- **개선안**: init 에서는 도구 id 집합만 기록하고(clean() 용) TerminalTool 생성·connect 는 처음 그려질 때(renderer-pane) 한다. 보이지 않는 도구는 붙이지 않는다. 처음 보일 때 since 없이 붙으므로 전량 재생 경로(FR-TRS-3)가 그대로 동작한다. 주의·활동 탐지는 서버 쪽에서 이루어지므로 영향이 없다.
- **결정 충돌**: 숨은 터미널 출력을 브라우저가 파싱해 얻던 부수효과(OSC 777 Cwd 로 상태바 갱신, TermClipboard.arrive 등)가 보이기 전까지 멎는다. 그 소비자를 먼저 조사해야 한다. handlers_ws.go:179-183 의 주석은 '새 창이 모든 도구의 WS 를 연다'를 현 동작으로 기술하고 있다.

### DOM-27 — Console 폴링이 매번 기록 최대 500건 전체를 받는다 — 커서가 없다

`P2` · 통신 · M · LOW · B · 확인 · 묶음키 `git-records-cursor`

- **위치**: `internal/webserver/domain/git/core/record.go:100`, `internal/webserver/gitapi/handlers_git_records.go:44`, `web/js/git/console.js:97`
- **근거**: Recorder 에는 Recent(n) 만 있다. /api/git/records 는 Records(0) 전체를 걸러 stderr 까지 담아 보낸다. console.js 는 탭이 보이는 동안 GIT_CON_LIMIT=500 으로 주기 폴링한다. Seq 는 이미 단조 증가한다.
- **개선안**: Recorder.Since(seq) 를 추가하고 API 에 after=<seq> 를 받는다. 응답에 lastSeq 를 실어 증분만 보낸다. 링이 넘쳐 잃은 구간이 있으면 gap:true 로 알린다.

### FEC-10 — 부팅 때 /api/settings·/api/state 를 두 번씩 받는다 — 전경 이름만 필요한 복원이 워크스페이스 전체를 받는다

`P2` · 통신 · M · MEDIUM · - · 개연 · 묶음키 `sse-open-snapshot`

- **위치**: `web/js/core/main.js:14`, `web/js/core/app.js:146`, `web/js/core/state-registry.js:91`, `web/js/core/event-bus.js:179`, `web/js/core/app-cmd.js:240`, `web/js/core/app-cmd.js:118`
- **근거**: 부팅 요청은 셋이다. main.js themeReady 가 GET /api/settings(main.js:14-20), App.init 이 GET /api/state(app.js:146), SSE 첫 open(gen=1) 이 sse:open 을 발행한다(event-bus.js:179). 등록부의 settings·tool.foreground 는 gen 을 보지 않고 revalidateOn:['sse:open'] 으로 다시 복원한다. 그래서 /api/settings 한 번이 더 나가고, _fgRestore 는 전경 이름 때문에 /api/state(워크스페이스+도구 전체)를 한 번 더 받는다(app-cmd.js:240-249). 워크스페이스 재조회만 gen>1 조건이 있다(app-cmd.js:118).
- **개선안**: SSE 를 부팅 GET 보다 먼저 열거나(connect 를 init 앞으로 옮기고 첫 open 을 기다린 뒤 조회), 부팅 GET 을 보낸 시각 이후에 첫 open 이 왔으면 그 open 의 settings·fg 재검증만 건너뛴다. _fgRestore 는 init 이 이미 받은 tools 로 _fgApply 하는 것으로 첫 회를 대신한다. 가벼운 도구 목록 종단은 FEC-11 스냅샷 설계에 합친다.
- **검증 메모**: 중복 조회는 사실이다. main.js:14 가 GET /api/settings, init 이 GET /api/state 를 보내고, 첫 sse:open 에서 settings·fg 가 gen 을 보지 않고 다시 복원한다(state-registry.js:173-175). _fgRestore 는 /api/state 전체를 받는다(app-cmd.js:242). 그러나 SSE 는 init 의 상태 조회 뒤에 connect 된다(app-cmd.js 의 bus.connect). 그 사이에 생긴 설정·전경 변경은 gen=1 재검증만이 메운다. 제안 ① 처럼 gen=1 재검증을 건너뛰면 그 틈의 변경이 조용히 빠진다. 워크스페이스가 gen>1 을 택한 이유는 로컬 편집을 덮는 문제였고, 여기에는 그대로 옮겨지지 않는다.

### FEC-11 — SSE (재)연결마다 복원 GET 7개가 따로 나간다 — 스냅샷 한 번으로 묶을 수 있다

`P2` · 통신 · L · MEDIUM · - · 확인 · 묶음키 `sse-open-snapshot`

- **위치**: `web/js/core/state-registry.js:36`, `web/js/core/app-attn.js:98`, `web/js/core/app-agents.js:28`, `web/js/core/app-cmd.js:242`, `web/js/core/app-tool.js:483`, `web/js/core/app-update.js:22`, `web/js/core/app-focus-owner.js:132`
- **근거**: STATE_REGISTRY 의 revalidateOn:['sse:open','softreload'] 항목마다 restore 가 자기 GET 을 보낸다. /api/tools/attention, /api/tools/activity, /api/state(fg), /api/tools/background, /api/settings, /api/update, /api/focus 에 git.observe 의 collect 까지 더해진다. 모바일·원격(RTT 80ms 이상)에서 재연결할 때마다 7왕복 이상이 한꺼번에 나간다.
- **개선안**: 서버에 GET /api/snapshot?parts=attention,activity,tools,background,settings,update,focus(또는 SSE hello 이벤트에 스냅샷을 싣기)를 두고, 등록부가 한 번 받아 각 restore 에 조각을 나눠 준다. flight/merge 규약(beginSnapshot)은 그대로 둔다. IPC 영역과 같이 설계한다.

### FEC-3 — render() 할 때마다 GET /api/cwd — OSC 로 이미 받은 cwd 를 매번 서버에 다시 묻는다

`P2` · 통신 · S · LOW · - · 확인 · 묶음키 `cwd-cache`

- **위치**: `web/js/ui/renderer.js:123`, `web/js/core/app-statusbar.js:453`, `web/js/core/app-focus.js:168`, `web/js/ui/term-pane.js:1075`
- **근거**: Renderer.render() 가 끝날 때마다 this.app.updateCwd() 를 부르고(renderer.js:123), updateCwd 는 포커스 터미널에 대해 apiGet('/api/cwd',{tool}) 를 무조건 보낸다(app-statusbar.js:453-459). render() 를 부르는 자리는 57곳이며(refactor README §4.1-3), workspace_changed·탭 전환·포커스마다 돈다. setFocus 도 updateCwd 를 따로 부른다(app-focus.js:168). 반면 셸 OSC 777;Cwd 는 이미 TerminalTool._onCwd 로 this._cwd 와 app.cwd 를 갱신한다(term-pane.js:1075-1078).
- **개선안**: ① statusBar.cwd 가 꺼져 있으면 updateCwd 는 아무 요청도 보내지 않는다. ② 포커스 도구 id 가 직전과 같고 p._cwd(OSC 777 로 받은 값)가 있으면 서버에 묻지 않는다. ③ renderer.js 의 무조건 호출은 포커스 도구가 바뀐 경우로 좁힌다. OSC 훅이 없는 셸(ssh 안 등)은 _cwd 가 비므로 서버 조회로 떨어진다. 이 폴백은 유지한다.

### FEC-9 — activity 스냅샷을 패널이 닫혀 있어도 5초마다 폴링한다 — FR-AAP-19 는 '패널 열림 동안', 폴링 시작·정지 함수는 빈 껍데기

`P2` · 문서괴리 · S · LOW · B · 확인 · 묶음키 `poll-gating`

- **위치**: `web/js/core/state-registry.js:47`, `web/js/core/state-registry.js:176`, `web/js/core/app-agents.js:62`, `web/js/core/app-agents.js:68`, `docs/internal/GIT_REVIEW4_SRS.md:140`
- **근거**: STATE_REGISTRY 의 tool.activity 는 every:(app)=>app.agentsPollMs 이고 when 이 없어서 항상 돈다. 숨은 탭에서만 멈춘다(state-registry.js:47-54, 176-181). 문서 쪽은 FR-AAP-19 주석(app-agents.js:61)과 GIT_REVIEW4_SRS 표(:140)가 '패널 열림 동안' 이라고 적는다. agentsStartPoll()·_agentsStopPoll() 은 this._agentsTimer=null 만 하는 사실상 빈 함수인데 토글과 input-binding 이 계속 부른다(app-agents.js:58-70, input-binding.js:23). 증분은 이미 SSE tool_activity 로 오고, 재연결 때는 sse:open 재검증이 스냅샷을 준다.
- **개선안**: 등록부 선언에 when:(app)=>app._agentsPanelOpen()||app._attn.size>0 을 준다. 주의 센터 detail 이 activity 를 읽으므로(app-attn.js:380) 알림이 있을 때는 계속 돈다. 빈 껍데기 둘은 지우고 호출처를 정리한다(e2e 계약인 app-testing.js:98 목록도 함께 고친다).
- **결정 충돌**: FR-HUB-3 이 주기를 등록부로 옮겼을 때 '패널 열림' 조건을 옮겨 오지 않았다. 의도된 제거라는 기록은 찾지 못했다.

### FEU-4 — EdDirtyDiff.stage 가 gitSignal 뒤에 refresh 를 또 불러 같은 요청쌍이 두 번 나간다

`P2` · 통신 · S · LOW · - · 확인 · 묶음키 `editor-dd-refresh`

- **위치**: `web/js/ui/file-editor-diff.js:385`, `web/js/ui/file-editor-diff.js:386`, `web/js/core/app-editor-pane.js:309`
- **근거**: stage() 성공 시 :385 `this.app.gitSignal('patch')` 를 부른다. app-editor-pane.js:301-310 의 gitSignal 래퍼가 열린 문서의 `d.dd.refresh()` 를 전부 부르는데, 여기에 이 문서의 dd 도 들어 있다. 이어 :386 `this.refresh()` 가 다시 돈다. refresh→_load 는 매번 GET /api/git/status + GET /api/git/diff-content 를 보낸다. 앞 호출은 _seq 비교로 결과만 버려지고 요청 4건은 모두 나간다.
- **개선안**: :386 의 `this.refresh()` 를 지운다(gitSignal 이 이미 부른다). FEU-5 의 공유 캐시를 도입하면 자연히 1회로 줄어든다.

### FEU-5 — 같은 저장소의 /api/git/status 를 세 소비자가 따로 받는다(편집기는 문서마다)

`P2` · 통신 · L · MEDIUM · - · 확인 · 묶음키 `git-status-shared-fetch`

- **위치**: `web/js/ui/file-editor-diff.js:196`, `web/js/ui/file-editor-diff.js:201`, `web/js/ui/file-tree-paint.js:459`, `web/js/ui/file-tree-paint.js:466`, `web/js/ui/file-tree-paint.js:505`, `web/js/git/panel-poll.js:484`, `web/js/core/app-editor-pane.js:309`
- **근거**: gitSignal 한 번에 (1) Git 패널 collect 가 panel-poll.js:484 에서 status 를 받고, (2) 탐색기 pollGit 이 file-tree-paint.js:466 에서 같은 status 를 받아 전체 본문을 파싱한 뒤 :505 에서야 mark 로 같은 관측인지 판정하며, (3) 열린 문서 N개가 각자 EdDirtyDiff._load 에서 file-editor-diff.js:201 status 를 받는다. (3)은 status 를 repo/rootMatch/requestedResolved 에서 접두를 뽑는 데만 쓰고, 이어서 diff-content 를 한 번 더 부른다. 같은 저장소 문서 10개면 gitSignal 한 번에 status 12건 + diff-content 10건이 나간다.
- **개선안**: 요청 root 별 single-flight + 짧은 TTL 캐시(GitStatusHub)를 둔다. Git 패널 collect 는 clientId 임대 의미 때문에 그대로 두고 결과만 hub 에 공급한다. 탐색기와 dirty-diff 는 hub 를 거치고, prefix 는 각자 repo/requestedResolved 로 계산한다. 서버 조건부 응답(?since=mark)은 별도 SRS 로 다룬다.

### FEU-6 — 관측 한 회차에 History 와 Branches 가 /api/git/refs 를 각각 부른다

`P2` · 통신 · M · LOW · - · 확인 · 묶음키 `git-view-reload-plan`

- **위치**: `web/js/git/history-load.js:161`, `web/js/git/history-load.js:164`, `web/js/git/history-load.js:220`, `web/js/git/branches.js:204`, `web/js/git/panel-poll.js:167`, `web/js/git/panel-poll.js:168`, `web/js/git/panel.js:80`
- **근거**: _reloadViews(panel-poll.js:165-201)는 History.reload(→ history-load.js:222 `Promise.all([this._loadRefs(),...])` → :164 GET /api/git/refs)와 Branches.reload(→ branches.js:204 GET /api/git/refs)를 같은 회차에 부른다. panel.js:80 주석이 '/api/git/refs 를 부르는 자리가 둘' 이라고 적었고, panel-views.js:223 adoptRefs 는 결과를 덮어쓰기만 한다.
- **개선안**: GitPanel 에 refs 를 한 번만 받는 single-flight 메서드(`loadRefs()`: 세대/토큰별 promise 공유)를 두고 두 뷰가 그것을 기다리게 한다. _knownRefs 가 이미 단일 저장소이므로 받는 자리만 하나로 합치면 된다.

### FEU-7 — _reloadViews 가 떼어진(비활성 탭) 뷰까지 매 변화마다 다시 받는다

`P2` · 통신 · M · MEDIUM · B · 확인 · 묶음키 `git-view-reload-plan`

- **위치**: `web/js/git/panel-poll.js:165`, `web/js/git/panel-poll.js:201`, `web/js/git/panel-life.js:82`, `web/js/git/panel-life.js:89`, `web/js/git/panel-life.js:107`
- **근거**: _reloadViews 는 만들어진 뷰 필드(_historyView·_branchesView·_stashView·_worktreesView·_submodulesView·원격)를 확인만 하고, 각 뷰는 `_el`·`_repo` 로만 조기 반환한다. 뷰의 _el 은 탭이 닫힐 때(dropView)만 풀린다. panel-life.js:89 주석처럼 탭 전환 때마다 루트가 DOM 에서 떼였다 붙고, elFor(:82-110)는 활성화될 때 _render 로 다시 받는다. 그래서 열어 두고 보지 않는 탭이 커밋·fetch 때마다 log(최대 2000)·refs·stash·worktree·submodule 요청을 낸다.
- **개선안**: _reloadViews 에서 `this._els.get(key)?.isConnected` 가 거짓인 뷰는 요청 대신 `_staleSince=sig` 표식만 남기고, elFor 에서 표식이 있으면 reload 한다(History 의 staleFor 와 같은 모양). FR-GVR-4('열린 적 없는 뷰에는 요청 없음')를 '보이지 않는 뷰는 활성화 시 받는다' 로 넓히는 SRS 개정이 필요하다.
- **결정 충돌**: GIT_VIEW_REFRESH_SRS FR-GVR-4/12 는 '열지 않은 뷰' 만 규정한다. 비활성 탭 지연은 새 결정이라 SRS 개정이 먼저다.

### FEU-M1 — 탐색기 주기 폴링과 Git 패널 주기 폴링이 같은 저장소의 /api/git/status 를 서로 다른 타이머로 부른다

`P2` · 통신 · M · MEDIUM · - · 검증자 추가 · 묶음키 `git-status-shared-fetch`

- **위치**: `web/js/core/app-editor-pane.js:23`, `web/js/core/app-editor-pane.js:24`, `web/js/git/panel-poll.js:351`, `web/js/core/app-git.js:507`
- **근거**: _edStartGitPoll 이 visiblePoll(gitReposInterval) 틱마다 보이는 트리 전부에 pollGit()(→ GET /api/git/status)을 부른다. Git 패널은 TIMERS.every('git.status:'+root) 로 따로 status 를 받는다. gitSignal 경로(FEU-5)와 별개로, 가만히 있어도 두 주기가 같은 root 를 이중 조회한다. 같은 간격 키로 gitReposRefresh 도 따로 돈다.
- **개선안**: FEU-5 의 GitStatusHub 에 주기 소비자도 붙인다. 같은 root 에 대해 한 주기에 한 번만 요청하고, 그 결과를 트리 pollGit 과 패널 collect 가 공유한다. 패널의 clientId 임대 요청이 흐르는 동안에는 트리 폴링을 hub 캐시로 대체한다.

### IPC-11 — 슬롯 소유권용 SSE(칸당 1개, 최대 3개)가 전체 방송을 받고 HTTP/1.1 연결 슬롯을 차지한다

`P2` · 통신 · M · MEDIUM · - · 확인 · 묶음키 `sse-presence-only`

- **위치**: `web/js/core/app-slots.js:239-258`, `web/js/core/event-bus.js:269-277`, `internal/webserver/httpapi/commands.go:54-175`, `internal/webserver/hub/commands.go:244-296`
- **근거**: _slotSyncSubs 가 칸 1..3 마다 `/api/commands/sse?clientId=…` 를 연다. 메시지는 처리하지 않고 '여는 것 자체가 목적'이다. 그래도 서버는 이 구독을 CmdSub 로 등록하고 모든 Broadcast 를 넣으며(큐 16 초과 시 폐기→재연결), 연결마다 Updates.Trigger() 와 gitWatch.Attach 를 돈다. 4칸이면 방송 트래픽이 4배다. 평문 HTTP/1.1(기본 localhost)에서는 오리진당 연결 6개 중 SSE 4개(+git job SSE)가 상시 점유해서 fetch 들이 남은 1~2개 연결로 줄을 선다.
- **개선안**: `?presence=1` 쿼리를 받으면 서버가 Focus.AttachFrom·gitWatch.Attach 만 하고 Commands.Add 는 하지 않는다(방송 없음, hello keepalive 만). Updates.Trigger 도 건너뛴다. 더 나아가 한 SSE 가 `clientId=a&extra=b,c` 로 여러 신원을 임대하게 해서 칸 SSE 자체를 없앤다.
- **결정 충돌**: WINDOW_SLOTS_SRS D-3 은 '슬롯을 서버에게 별개 클라이언트로 보이게 하여 서버 무변경'을 택했다. presence 옵션은 서버를 바꾸지만, 소유권 의미(구독이 살아 있는 동안만 소유)는 그대로 지킨다.

### IPC-6 — 부팅과 SSE 재연결 때마다 /api/state 를 두 번 받고, 상태 복원 요청 7~8건이 동시에 나간다

`P2` · 통신 · M · MEDIUM · - · 확인 · 묶음키 `reconnect-snapshot-aggregate`

- **위치**: `web/js/core/state-registry.js:34-151`, `web/js/core/app-cmd.js:120`, `web/js/core/app-cmd.js:240-252`, `web/js/core/app-cmd.js:316-332`, `web/js/core/app.js:123-134`
- **근거**: sse:open 한 번에 _attnRestore(/api/tools/attention), _activityRestore(/api/tools/activity), _fgRestore(/api/state 전체), _bgRefresh(/api/tools/background), _settingsRestore, _updateRestore, _gitObserveRestore(관측기마다 git status), _focusRestore(/api/focus)가 발화한다. 재연결(gen>1)이면 _onWorkspaceChanged 가 /api/state 를 한 번 더 받는다. _fgRestore 는 fgName 하나를 얻으려고 워크스페이스 전체와 tools 목록을 받는데, _applyRemoteWorkspace 가 이미 같은 목록으로 _fgApply 를 부른다(app-cmd.js:332). 첫 로드에서도 init 의 /api/state 뒤에 gen=1 sse:open 이 _fgRestore 로 /api/state 를 또 받는다. 서버 재시작 때는 브라우저 수 × 이 묶음이 동시에 몰린다.
- **개선안**: (1) init 에서 /api/state 의 tools 로 _fgApply(sp) 를 직접 부르도록 추가한 뒤 tool.foreground 의 sse:open 재검증을 gen>1 경로(_onWorkspaceChanged)로 흡수한다. 단 _onWorkspaceChanged 는 _saveInflight/_wsApplyInflight 에서 유예되고 !sv.windows 면 적용을 건너뛰므로, 그 갈래에서도 fg 가 적용되도록 _fgApply 를 windows 검사 앞으로 옮긴다. RESTORE_FLIGHT_SRS 의 touched 보호(FR-RSF-3)가 동기 경로에서 빠지는 점을 명시한다. (2) 집계 종단은 원안 유지.

### IPC-7 — /api/git/repos 를 3초마다 무조건 폴링하고, Repo 탭이 보이면 핀 전부에 rev-parse+git status 를 돌린다

`P2` · 통신 · M · MEDIUM · B · 확인 · 묶음키 `git-pins-push`

- **위치**: `web/js/core/app-git.js:505-508`, `web/js/core/app-git.js:655-681`, `internal/webserver/gitapi/handlers_git.go:113-163`, `internal/webserver/domain/git/store/store.go:20-21`
- **근거**: _startGitReposPoll 은 visiblePoll(gitReposInterval=3000) 로 탭 종류와 상관없이 돈다. 서버 gitPinnedEntries 는 핀마다 RepoRoot 를 부르는데 TTL 이 2s 라 3초 주기에서는 매번 git rev-parse 가 뜬다. observe=1(Repo 탭)이면 gitObservePins 가 핀마다 RepoRoot+Status 를 돌린다(status TTL 200ms 라 매번 실행). 핀 10개면 3초마다 git 프로세스 약 20개다. 핀 목록은 사용자 조작으로만 바뀌고(workspace_changed 로 전파됨), 배지 변화는 GitWatcher 가 signature 게이트로 싸게 잡을 수 있는 종류다.
- **개선안**: Repo 탭이 보이는 동안 핀 전부를 GitWatcher 에 clientId 임대로 등록하고(NoteFor), 배지 갱신은 git_changed 방송을 계기로 한다. gitReposRefresh 는 workspace_changed·git_changed(핀 저장소)·가시성 복귀에서만 부르고, 주기는 안전망(예: 30s)으로 내린다. Repo 탭이 아닐 때는 주기 폴을 멈춘다(배지는 탭 복귀 시 1회 수집).
- **결정 충돌**: FR-GOB-5/D-1(관측은 Git 탭을 보는 동안) 과는 양립한다. POLL_INTERVAL_SETTINGS_SRS 가 gitReposInterval 을 사용자 조절값으로 노출하므로 그 의미('안전망 주기')를 문서에서 바꿔야 한다.

### IPC-8 — Editor 트리의 git 색·스탬프가 git_changed 를 듣지 않고 트리마다 3초에 요청 3종을 폴링한다

`P2` · 통신 · M · MEDIUM · B · 확인 · 묶음키 `git-pins-push`

- **위치**: `web/js/core/app-editor-pane.js:20-31`, `web/js/ui/file-tree-paint.js:459-466`, `web/js/ui/file-tree-store.js:102-107`, `web/js/core/app-editor-open.js:236-244`, `web/js/core/app-git.js:591-631`
- **근거**: _edStartGitPoll 이 gitReposInterval 마다 보이는 트리마다 pollGit(/api/git/status 전량)·pollStamp(POST /api/fs/stamp)를 부르고, edPollDocStamps(POST /api/file/stamps)도 부른다. git_changed 를 소비하는 곳은 app-git.js 의 _onGitChanged(Git 관측기) 하나뿐이라, 서버가 변화를 알려도 Editor 는 다음 3초 틱까지 모른다. 변화가 없어도 git status 전체 목록을 계속 받는다. pollGit 의 status 요청에는 clientId 가 없어서 임대도 걸리지 않는다.
- **개선안**: FileTreeStore 가 git_changed 를 구독하게 한다(_onGitChanged 와 같은 repo/root 일치 판정·mark 중복 거르기). status 요청에 clientId 를 실어 GitWatcher 임대를 건다. 주기 pollGit 은 안전망(gitStatusInterval, 기본 30s)으로 내린다. fs/stamp·file/stamps 는 작업 트리 변화이므로 3초를 유지하되 요청 하나로 합친다(POST /api/fs/stamps 에 dirs+paths).
- **결정 충돌**: FR-EDT-77·FR-FSL-7·FR-ELR-10 은 '세 관측을 같은 틱에' 를 요구한다(중간 상태 방지). git 색만 push 로 옮기면 틱이 갈라지므로, 스탬프 틱에서 git 색도 캐시로 다시 칠하는 방식으로 조율해야 한다.

### IPC-9 — 상태바 틱이 3초마다 요청 3개(ping·stats·git/jobs)를 낸다 — 초당 1건인 최대 상시 트래픽

`P2` · 통신 · S · LOW · - · 확인 · 묶음키 `statusbar-tick-merge`

- **위치**: `web/js/core/app-statusbar.js:43-73`, `web/js/core/app-git.js:864-873`, `internal/webserver/httpapi/handlers_api.go:37-61`, `internal/webserver/httpapi/handlers_api.go:427-430`
- **근거**: _pollStats 는 /api/ping → Promise.all(/api/stats, /api/git/jobs) 순으로 부른다. 기본 statsInterval 3000 에서 1.0 req/s 이고 하한(1s)이면 3 req/s 다. /api/stats 는 서버가 백그라운드로 샘플링한 Stats.Snapshot() 을 읽을 뿐이고, git jobs 의 시작·종료는 서버가 안다(잡 스트림이 따로 있음).
- **개선안**: (1) git jobs 목록을 /api/stats 응답에 합친다(`jobs` 필드). 틱당 3r→2r 이 된다. (2) 더 나아가 잡 시작·종료 때 `git_jobs_changed` SSE 를 밀고 _pollGitJobs 를 sse:open·이벤트 기반으로 옮긴다. ping 분리는 FR-PRF-36~38 근거(지연 측정 순수성)대로 유지한다.
- **결정 충돌**: FR-PRF-36~38 은 ping 만 분리하라고 한다. stats+jobs 합치기와는 충돌하지 않는다.

### FEC-12 — 탐색기 git 색이 push(git_changed)를 쓰지 않고 3초마다 칸별로 status 를 폴링한다 — 같은 루트가 두 칸이면 요청도 두 번

`P3` · 통신 · M · MEDIUM · B · 개연 · 묶음키 `explorer-git-poll`

- **위치**: `web/js/core/app-editor-pane.js:23`, `web/js/core/app-editor-open.js:372`, `web/js/ui/file-tree-paint.js:466`, `web/js/core/app-git.js:591`
- **근거**: _edStartGitPoll 은 gitReposInterval(기본 3초)마다 _edVisibleTrees() 의 트리마다 pollGit()·pollStamp() 를 부른다(app-editor-pane.js:23-24). _edTrees 는 슬롯 키(id@slot) 단위라서, 같은 창을 두 칸에 띄우면 같은 루트로 GET /api/git/status 가 두 번 나간다(file-tree-paint.js:466, _gitBusy 는 트리마다 따로다). 같은 저장소의 GitObserver 는 git_changed 방송으로 collect 하는데(app-git.js:591-640), 탐색기 색은 그 결과도 방송도 쓰지 않는다.
- **개선안**: ① 코어 루프에서 루트 기준으로 중복을 걸러 한 번만 부르고 결과를 같은 루트의 트리 전부에 나눠 칠한다. ② _onGitChanged 가 해당 루트의 탐색기에도 신호를 주게 하고, 탐색기 status 주기는 안전망 수준(gitStatusInterval)으로 늘린다. 같은 저장소의 GitObserver 가 살아 있으면 그 _status 를 공유한다.
- **결정 충돌**: EDITOR FR-EDT-77 이 'GIT_REPOS_POLL_MS 와 같은 주기 + 서버 캐시 200ms' 로 정했다. 이 결정은 GIT_PUSH_OBSERVE_SRS(서버 push) 이전의 것이라 재결정이 필요하다.
- **검증 메모**: 트리마다 pollGit 이 따로 GIT_STATUS_API 를 부르고 _gitBusy 도 트리마다다(file-tree-paint.js:466-472). 같은 루트가 두 번 조회될 수 있다는 것은 맞다. 다만 FR-EDT-77 주석대로 서버에 캐시 TTL 200ms 와 single-flight 가 있어 git 실행은 겹치지 않는다. 늘어나는 것은 HTTP 왕복뿐이다. push 로 전환하는 것은 FR-EDT-77 재결정이 필요하다. P2 는 과하다.

### FEC-13 — gitReposRefresh 가 3초마다 응답이 바뀌지 않아도 사이드바 목록·상단·탭 배지를 다시 칠하고 모든 패널에 핀 통지를 보낸다

`P3` · 성능 · S · LOW · - · 확인 · 묶음키 `explorer-git-poll`

- **위치**: `web/js/core/app-git.js:507`, `web/js/core/app-git.js:676`, `web/js/core/app-git.js:695`, `web/js/core/app-editor-pane.js:23`
- **근거**: 응답이 ok 이면 무조건 this.gitRepos=res.data; renderer._rGitSection(); renderer._rSbTabs(); this._gitNotifyPinsAll() 를 한다(app-git.js:676-695). _rGitSection 은 _rLists()+_rTopbar() 다. 같은 주기의 탐색기 폴링(app-editor-pane.js:23)과 타이머가 따로라서 한 틱으로 합쳐지지도 않는다.
- **개선안**: 응답 서명(JSON 문자열 또는 서버 mark)이 직전과 같으면 칠하기·통지를 건너뛴다. _gitReposPoll 과 _edGitPoll 을 한 job(id:'repos.tick')으로 합쳐 같은 틱에 돈다.

### FEC-15 — /api/git/jobs 를 statsInterval(1~3초)마다 폴링한다 — 작업 시작·끝은 서버가 알고 있다

`P3` · 통신 · M · LOW · - · 확인 · 묶음키 `sse-open-snapshot`

- **위치**: `web/js/core/app-statusbar.js:70`, `web/js/core/app-git.js:864`, `web/js/core/app-statusbar.js:13`
- **근거**: _pollStats 가 회차마다 ping 에 이어 Promise.all([/api/stats, _pollGitJobs()]) 를 부른다(app-statusbar.js:63-72). 작업 목록은 표시용이 아니고 다른 브라우저 작업을 adoptJobs 로 넘기려는 것이다(app-statusbar.js:11-14). 작업이 없을 때도 회차당 3요청이 나간다.
- **개선안**: 1단계(서버 변경 없음): Git 패널(gitPanelAt 으로 만들어진 패널)이 하나도 없으면 _pollGitJobs 를 건너뛴다. 결과를 쓸 곳이 없기 때문이다. 2단계: FR-GIT-101a 를 개정해 git_jobs_changed push 와 등록부의 git.jobs(merge:'latest', revalidateOn sse:open)로 바꾼다.
- **결정 충돌**: FR-GIT-101a 는 폴링이 목록을 나른다고 적었다. 대안을 쓰려면 push 전환 결정이 필요하다. FR-PRF-36~38 이 ping 을 따로 두기로 한 결정은 유지한다.

### FEC-16 — 칸(slot)마다 전체 SSE 스트림을 따로 열고 받은 메시지를 버린다 — 브라우저 탭 하나에 최대 4개

`P3` · 통신 · L · MEDIUM · - · 확인 · 묶음키 `slot-sse-identity`

- **위치**: `web/js/core/app-slots.js:243`, `web/js/core/app-slots.js:251`, `docs/internal/WINDOW_SLOTS_SRS.md:233`
- **근거**: _slotSyncSubs 가 i=1..SLOT_MAX-1 마다 bus.openChannel('/api/commands/sse?clientId=…') 를 연다. 주석에 따르면 이 구독들은 메시지를 처리하지 않고 여는 것 자체가 목적이다(app-slots.js:238-257). 모든 방송(workspace_changed·attention·activity 등)이 칸 수만큼 중복 전송되고, HTTP/1.1 의 origin 당 연결 상한(보통 6)을 SSE 4개가 차지한다.
- **개선안**: FR-WSL-11 을 유지하는 최소안: 칸 구독 URL 에 passive=1 을 붙인다. 서버는 그 구독을 소유권 수명(FR-XDF-9)에만 쓰고 방송을 싣지 않는다(keep-alive 만). 연결 수를 줄이는 다중 신원 SSE 는 FR-WSL-11 개정 뒤의 L 규모 과제로 분리한다.
- **결정 충돌**: WINDOW_SLOTS_SRS FR-WSL-11 이 '자체 SSE 구독' 을 요구한다(해제 계기가 구독 드롭, FR-XDF-9). 바꾸려면 이 결정의 개정이 필요하다.

### FEC-M1 — 포커스 아닌 터미널의 OSC cwd 가 상태바 cwd 를 덮는다

`P3` · 결함 · S · LOW · B · 검증자 추가 · 묶음키 `cwd-cache`

- **위치**: `web/js/ui/term-pane.js:1075`, `web/js/core/app-statusbar.js:136`
- **근거**: TerminalTool._onCwd 는 자기가 포커스인지 보지 않고 app.cwd=cwd; app.updateStatusBar() 를 한다(term-pane.js:1075-1078). 상태바는 this.cwd 를 포커스 터미널의 위치로 표시한다(app-statusbar.js:136). 백그라운드 칸의 셸이 cd 하거나 precmd 를 내면 상태바가 그 칸의 경로를 보인다. 다음 render/updateCwd 가 돌 때까지 그대로다.
- **개선안**: _onCwd 는 this._cwd 만 갱신하고, app.focusedTerminal()===this 일 때만 app.cwd 를 바꾼다. FEC-3 의 캐시(p._cwd)와 같은 원천을 쓴다.

### FEU-10 — History 의 자리 유지 재적재가 매번 skip=0 에서 이미 받은 개수(최대 2000)만큼 다시 받는다

`P3` · 통신 · M · MEDIUM · - · 확인 · 묶음키 `history-incremental`

- **위치**: `web/js/git/history-load.js:76`, `web/js/git/history-load.js:83`, `web/js/git/history-load.js:86`, `web/js/core/constants-git-history.js:23`, `web/js/core/constants-git-history.js:26`
- **근거**: _doLoad(more=false,keep=true)의 limit 이 `Math.min(GIT_LOG_MAX,Math.max(GIT_LOG_INITIAL,this._commits.length))` 이고 skip 은 0 이다. 사용자가 1500개까지 스크롤했으면 관측 변화(커밋 하나) 때마다 1500개를 다시 받는다.
- **개선안**: 새 HEAD 부터 기존 첫 oid 를 만날 때까지만 받는 증분 조회(서버에 `until=<oid>` 또는 `since`)를 두고 앞쪽에 붙인다. 머리가 이어지지 않으면(리베이스·리셋) 전량으로 돌아간다. 서버 API 추가가 필요하다.

### FEU-8 — run_changed SSE 마다 /api/runs 전량을 합치기 없이 다시 받는다

`P3` · 통신 · S · LOW · - · 확인 · 묶음키 `runs-refresh-coalesce`

- **위치**: `web/js/ui/runs-panel.js:92`, `web/js/ui/runs-panel.js:100`, `web/js/ui/runs-panel.js:384`, `web/js/ui/runs-panel.js:391`
- **근거**: _onRunChanged(:384)가 이벤트마다 무조건 `this._runsRefresh()` 를 부른다. _runsRefresh(:92-100)에는 진행 중 가드가 없다. 반면 같은 파일의 _runFetch(:368-381)는 busy/pending 으로 합친다. 멤버 메시지가 몰리면 run_changed 수만큼 목록 요청이 겹쳐 나가고 도착 순서도 보장되지 않는다.
- **개선안**: _runFetch 와 같은 busy/pending 합치기를 _runsRefresh 에 넣는다. 더 나아가면 SSE run_changed 에 요약(state·members 수·contextLevel)을 실어 목록 재조회를 생략하거나, TIMERS 디바운스(예: RUN_LIST_COALESCE_MS)를 둔다.

### FEU-9 — 탭이 보일 때마다 판 확인용으로 index.html 전체를 no-store 로 받는다

`P3` · 통신 · S · LOW · - · 확인 · 묶음키 `version-check-light`

- **위치**: `web/js/ui/version-watch.js:141`, `web/js/ui/version-watch.js:143`, `web/js/ui/version-watch.js:149`
- **근거**: visibilitychange 가 올 때마다 check() 가 `apiGet('/',{query:{_v:Date.now()},cache:'no-store',parse:false})` 로 문서 전체를 받아 정규식으로 main.js?v= 를 찾는다. 머리 주석(:17-18)은 '인사가 닿지 못한 경우의 길' 이라고 적었지만, 코드는 SSE 가 살아 있는지 보지 않고 매번 보낸다. /api/health 응답에는 자산 판이 없다(handlers_health.go:18-42).
- **개선안**: (1) SSE 가 연결돼 있고 인사(__dmAssetVersion)를 받았으면 건너뛴다. (2) 가벼운 판 확인 경로(/api/ping 이나 health 에 assetVersion 필드, 또는 HEAD+ETag)로 바꾼다.

### FEU-M3 — version-watch 머리 주석은 '인사가 닿지 못했을 때만' index.html 을 받는다고 하나 구현은 조건이 없다

`P3` · 문서괴리 · S · LOW · B · 검증자 추가 · 묶음키 `version-check-light`

- **위치**: `web/js/ui/version-watch.js:17`, `web/js/ui/version-watch.js:140`, `web/js/ui/version-watch.js:149`
- **근거**: 주석(:17-18)은 '그때만 index.html 을 받아 견준다' 이다. 그런데 check() 는 done 만 보고, 판이 같으면 done 이 세워지지 않으므로 탭이 보일 때마다 요청한다. FR-RLC-2b 의 문언과 구현이 어긋나 있다.
- **개선안**: SSE 구독 생존 및 인사 수신 여부를 app-cmd.js 가 노출하는 이름(window.__dmAssetVersion 계열) 하나로 받아 check 앞에서 판정한다. 아니면 문서를 현재 동작에 맞춰 정정한다.

### HTTP-7 — /api/git/status 가 mark 가 같아도 파일 목록 전체를 다시 보낸다 (조건부 응답 없음)

`P3` · 통신 · M · MEDIUM · B · 확인 · 묶음키 `conditional-get-mark-rev`

- **위치**: `internal/webserver/gitapi/handlers_git.go:496-538`, `internal/webserver/httpapi/handlers_api.go:240-265`, `internal/webserver/httpapi/handlers_api.go:349-360`
- **근거**: 응답에는 관측 식별자 mark(store.Mark)가 있다. git_changed 방송과 브라우저 중복 거르기도 이 값을 쓴다. 하지만 서버는 요청자가 이미 가진 mark 를 받지 않으므로, 30초 안전망 폴링과 재연결 재조회가 변화가 없어도 status 전체를 매번 직렬화해 보낸다. /api/state·/api/workspace 도 ETag(rev)를 내면서 If-None-Match 를 보지 않는다.
- **개선안**: GET /api/git/status 에만 선택 인자 ifMark 를 둔다(헤더 If-None-Match 는 쓰지 않는다. 브라우저 자동 재검증이 끼어들지 않게 한다). mark 가 같으면 {repo, requested, isRepo, mark, unchanged:true} 로 답한다. /api/workspace·/api/state 의 rev 는 재기동 때 0 으로 돌아가므로 조건부 GET 키로 쓰지 않는다. 그 부분은 제외한다.
- **결정 충돌**: handlers_files.go:477 은 편집기 파일 읽기에서 304 를 의도적으로 피한다. 이 제안은 git status·workspace 에만 적용하고, 파일 읽기는 건드리지 않는다.

### IPC-29 — agentsStartPoll/_agentsStopPoll/_agentsTimer 는 언제나 null 인 죽은 배선이다

`P3` · 가독성 · S · LOW · - · 확인 · 묶음키 `fe-dead-poll-cleanup`

- **위치**: `web/js/core/app-agents.js:57-70`, `web/js/core/app-agents.js:47-56`
- **근거**: agentsStartPoll 은 _agentsStopPoll 을 부른 뒤 `this._agentsTimer=null` 만 한다. 주기는 state-registry 의 tool.activity 가 가진다. agentsToggle 이 두 함수를 계속 불러서, 패널을 닫으면 폴링이 멈출 것처럼 읽힌다(실제로는 멈추지 않는다).
- **개선안**: 두 함수와 필드를 지우고 agentsToggle 에서 호출을 뺀다. app-testing.js 의 표면 목록에서도 정리한다.

### IPC-30 — git status 안전망·push 후속 요청이 변화가 없어도 매번 전체 목록을 받는다

`P3` · 통신 · S · LOW · - · 확인 · 묶음키 `git-status-conditional`

- **위치**: `web/js/git/panel-poll.js:462-497`, `internal/webserver/hub/gitwatch.go:103`, `internal/webserver/hub/gitwatch.go:118-124`
- **근거**: collect() 는 `/api/git/status?repo=…&clientId=…` 로 파일 목록 전체를 받는다. 서버는 관측 식별자 mark(store.Mark)를 이미 가지고 있고 git_changed 에도 싣지만, 요청에 '내가 가진 mark' 를 실어 생략받는 길은 없다. 안전망 30s·가시성 복귀·워치독 회차가 모두 전량을 받는다.
- **개선안**: status 요청에 `mark=<마지막 mark>` 를 싣고, 서버는 현재 관측의 mark 가 같으면 `{requested, mark, unchanged:true}` 만 답한다. 브라우저는 unchanged 면 _lastObsAt 만 갱신하고 칠하지 않는다. 옛 서버는 파라미터를 무시하므로 호환된다.

## O5 — 쓰기 경로 합치기·원자성 (12건)

### DOM-3 — run.Store 가 컨텍스트 훅마다 runs.json 전체를 쓴다 — 잠금 안에서 세대 회전과 fsync 2회

`P1` · 성능 · M · MEDIUM · B · 확인 · 묶음키 `run-store-save-coalesce`

- **위치**: `internal/webserver/domain/run/store_context.go:157`, `internal/webserver/domain/run/store_context.go:180`, `internal/webserver/domain/run/store_context.go:291`, `internal/webserver/domain/run/store.go:278`, `internal/webserver/domain/run/store_messages.go:69`, `internal/shared/platform/statefile.go:52`
- **근거**: dmctl 은 activity 훅마다 /api/runs/context 를 보낸다(dmctl_activity.go:88). ObserveContext 는 ContextAt 만 바뀌어도 s.save() 를 부른다. save 는 s.mu 를 쥔 채 WriteStateFile 을 부르고, 이 함수는 stat·remove·rename 2회, ReadFile 뒤 .bak.1 원자 쓰기(fsync), 본 파일 원자 쓰기(fsync)를 한다. 그동안 List·MemberByTool 등 모든 조회가 막힌다. AppendMessage 도 메시지 한 건마다 같은 경로를 탄다.
- **개선안**: ① 은 좋다. 다만 ContextAt 만 바뀐 관측은 메모리에만 반영하고 저장을 건너뛴다(ContextAt 은 재기동 뒤 다시 채워진다). ②의 지연 쓰기는 FBE-17(쓰기 실패 시 메모리 되돌림)과 FR-SFD-1 을 개정해야 하므로 별도 SRS 개정 항목으로 나눈다. 우선 ① 과 '잠금 안 Marshal, 잠금 밖 쓰기(쓰기는 전용 mutex 로 직렬화)'만 한다.
- **이전 감사**: AUDIT-go-domain P3
- **결정 충돌**: STATE_FILE_DURABILITY_SRS FR-SFD-1(덮어쓰기 전 매번 세대를 남긴다)과 FBE-17(쓰기 실패 시 메모리 되돌림)을 지연 쓰기에 맞게 개정해야 한다.

### FEC-1 — 변경 없는 워크스페이스 PUT — 포커스·창 전환마다 rev 증가·디스크 쓰기·전 브라우저 재조회가 연쇄된다

`P1` · 통신 · S · MEDIUM · - · 확인 · 묶음키 `ws-save-dedupe`

- **위치**: `web/js/core/app.js:463`, `web/js/core/app.js:479`, `web/js/core/app-focus.js:173`, `web/js/core/app-layout.js:390`, `internal/shared/workspace/manager.go:267`, `internal/webserver/httpapi/handlers_api.go:364`, `web/js/core/app-cmd.js:186`
- **근거**: save() 는 replacer 로 activeWindow·focusedPane·dirty 를 뺀 뒤 전체 ws 를 PUT 한다(app.js:479-487). 그런데 setFocus() 는 pane 포커스만 바꾸고 무조건 this.save() 를 부르고(app-focus.js:173), switchWindow() 도 activeWindow 만 바꾼 뒤 this.save() 를 부른다(app-layout.js:390). 결과적으로 직전과 같은 본문이 나간다. 서버 Manager.Save 는 본문을 비교하지 않고 rev+1·enqueueWrite 를 하며(manager.go:267-290), apiWorkspacePut 은 매번 workspace_changed 를 방송한다(handlers_api.go:411-418). 방송을 받은 다른 브라우저는 모두 GET /api/state 뒤 _applyRemoteWorkspace+render() 를 돈다(app-cmd.js:186-206). 클릭 한 번이 PUT 1회, 디스크 쓰기 1회, 다른 브라우저 N개의 전체 재조회·재렌더로 번지고, rev 가 올라가 다른 화면의 대기 저장이 409 를 맞을 확률도 커진다.
- **개선안**: save() 에서 본문을 한 번만 문자열화하고(아래 FEC-2) 마지막으로 성공한 본문 문자열(_wsLastSentBody)과 같으면 PUT 을 건너뛰고 _savePending 만 내린다. 409·재채택 뒤에는 기억을 비운다. 서버 쪽(go-domain 영역)에서도 Manager.Save 가 현재 raw 와 바이트가 같으면 rev 를 올리지 않고 방송도 하지 않게 하는 이중 방어를 권한다.
- **결정 충돌**: WORKSPACE_SAVE_CONFLICT_SRS 에 동일 본문 저장을 요구하는 조항이 없다. FR-WSC-16 의 유예 rev 판정은 ETag 가 바뀌지 않으면 그대로 성립한다.

### FEC-4 — 설정 에코가 사용자 정의 테마 편집기의 객체 참조를 끊는다 — 첫 에코 이후 색 편집이 적용·저장되지 않는다

`P1` · 결함 · M · MEDIUM · B · 확인 · 묶음키 `settings-save-pipeline`

- **위치**: `web/js/core/app-settings-theme.js:232`, `web/js/core/app-settings-theme.js:247`, `web/js/core/app-settings.js:238`, `web/js/core/state-registry.js:94`, `internal/webserver/httpapi/handlers_settings.go:121`
- **근거**: 편집기는 customTheme=JSON.parse(...) 로 사본을 만들고, 색 입력마다 obj=customTheme.ui 또는 customTheme.terminal 참조를 묶는다(app-settings-theme.js:232-256). 'input' 이벤트마다 saveSettings() 로 PUT 하고, 서버는 보낸 쪽을 포함한 전원에 settings_changed 를 방송한다(handlers_settings.go:121). 보낸 쪽도 _settingsRestore → _settingsApply 를 돌고, 그 안의 if(saved.customTheme){customTheme=saved.customTheme}(app-settings.js:238) 가 전역을 새 객체로 바꾼다. 그 뒤의 입력은 옛 obj 를 고치지만 applyThemeObj(customTheme) 와 saveSettings 는 새 객체를 쓴다. 그래서 두 번째 편집부터는 화면에도 저장에도 반영되지 않는다. 같은 에코는 포커스·알림 가장자리 슬라이더에도 온다. 500ms 디바운스 저장의 에코가 드래그 도중 set() 으로 슬라이더 값을 되돌릴 수 있다(app-settings-init.js:192-205, PLAUSIBLE).
- **개선안**: ① saveSettings 가 보낸 본문 문자열을 기억하고, _settingsRestore 가 받은 blob 이 그것과 같거나 로컬 저장이 대기 중이면 적용하지 않는다(자기 에코 무시). ② _settingsApply 가 customTheme 을 갈아끼웠고 편집기가 열려 있으면 편집기를 새 객체로 다시 묶는다. ③ 색 입력 저장은 디바운스한다(FEC-5). 재현 테스트: 색 입력 2회 사이에 settings_changed 를 흉내 내고 두 번째 값이 저장 본문에 실리는지 본다.
- **결정 충돌**: state-registry 의 settings 는 merge:'latest'(방송은 다시 받으라는 신호)다. 보낸 쪽 에코를 거르는 규약은 SETTINGS_LIVE 에 없으므로 추가 결정이 필요하다.

### DOM-4 — NFR-SFD-1 은 '회전은 rename 셋'이라지만 구현은 복사 + fsync 이고, 자주 쓰는 파일에서는 세대가 의미를 잃는다

`P2` · 문서괴리 · S · LOW · B · 확인 · 묶음키 `run-store-save-coalesce`

- **위치**: `internal/shared/platform/statefile.go:64`, `internal/shared/platform/statefile.go:78`, `docs/internal/STATE_FILE_DURABILITY_SRS.md:191`, `internal/webserver/domain/run/store.go:287`
- **근거**: rotateGenerations 는 os.ReadFile(path) 뒤 WriteFileAtomic(genPath(1)) 로 복사한다(:78~86). SRS NFR-SFD-1 의 비용 근거('rename 셋')와 다르다. 또 runs.json 은 훅마다 저장되므로 .bak.1~3 이 몇 초 간격인 거의 같은 판이 되어, 손상 복구(FR-SFD-12)에 쓸 과거 판이 사실상 없다.
- **개선안**: NFR-SFD-1 을 실제 비용(read 1회 + 원자 쓰기 1회 + rename 2회)으로 고친다. 고빈도 저장소(runs.json)는 최소 회전 간격(예: 60초)을 두는 옵션을 WriteStateFile 에 더한다. DOM-3 과 함께 처리한다.

### FEC-5 — 색 입력은 디바운스 없이 input 이벤트마다 설정 blob 전체를 PUT 한다(방송·재조회 포함)

`P2` · 통신 · S · LOW · - · 확인 · 묶음키 `settings-save-pipeline`

- **위치**: `web/js/core/app-settings-theme.js:251`, `web/js/core/app-settings.js:156`
- **근거**: _colorInput 의 'input' 리스너가 obj[key]=v → applyThemeObj → _renderPreview → this.saveSettings() 를 매 이벤트 부른다(app-settings-theme.js:251-256). 색상 피커를 드래그하면 초당 수십 번의 PUT(shortcuts·layoutPresets·customTheme 를 포함한 전체 blob)이 나가고, 한 번마다 settings_changed 방송과 전 브라우저의 GET /api/settings 가 따른다. 같은 파일의 다른 입력(제목·탭 폭·가장자리)은 500ms 디바운스를 쓰는데 여기만 빠졌다.
- **개선안**: 다른 입력과 같은 디바운스 헬퍼(FEC-6)를 쓰고 'change' 에서 곧바로 확정 저장한다. 미리보기(_renderPreview)는 rAF 한 번으로 합친다.

### FEC-7 — saveSettings 에 비행 합치기가 없다 — 전체 blob PUT 두 개가 순서가 바뀌어 도착하면 옛 값이 남는다

`P2` · 결함 · S · LOW · - · 개연 · 묶음키 `settings-save-pipeline`

- **위치**: `web/js/core/app-settings.js:156`, `web/js/core/app-settings.js:170`
- **근거**: saveSettings 는 부를 때마다 즉시 apiPut('/api/settings',body) 를 보낸다(app-settings.js:170). 비행 중 가드나 체인이 없다. 본문이 전체 blob 이고 서버는 마지막 도착을 저장하므로, 병렬 연결에서 먼저 보낸 요청이 늦게 닿으면 새 값을 옛 값이 덮는다. 워크스페이스 save() 는 _saveChain·_savePending 으로 이를 막는다(app.js:463-468). PLAUSIBLE — 순서 역전 재현은 하지 않았다.
- **개선안**: save() 와 같은 모양의 single-flight + pending 합치기를 saveSettings 에 둔다(비행 중 호출은 pending 으로 표시만 하고, 비행이 끝나면 최신 본문으로 한 번 더). FEC-4 의 '마지막 보낸 본문' 기억도 여기서 세운다.
- **검증 메모**: saveSettings(app-settings.js:156-173)에 비행 가드가 없고 본문이 전체 blob 이라는 것은 맞다. 다만 순서 역전은 같은 origin 의 HTTP/1.1 병렬 연결에서만 생긴다. 재현하지 않았다.

### SHR-6 — tools.json 저장에 합치기가 없다 — 변경마다 고루틴 하나, 저장마다 lsof·파일 읽기·fsync 2회·rename 여럿

`P2` · 성능 · M · MEDIUM · - · 확인 · 묶음키 `state-save-coalesce`

- **위치**: `internal/shared/toolhub/manager.go:249`, `internal/shared/toolhub/persist.go:29`, `internal/shared/toolhub/manager_create.go:138`, `internal/shared/platform/statefile.go:52`, `internal/shared/workspace/manager.go:192`
- **근거**: Create/Delete 가 saveAsync 로 호출마다 고루틴을 하나씩 띄운다. 이것들은 saveFile 락에서 줄을 서고, 저장마다 스냅샷 → ownedTools(runs.json 읽기) → CWDs(darwin lsof fork) → Marshal → WriteStateFile 을 모두 다시 한다. WriteStateFile 은 rotateGenerations 에서 Stat+Remove+Rename×2+ReadFile+WriteFileAtomic(fsync) 를 하고 본 파일에 한 번 더 fsync 한다. 같은 저장소의 workspace.Manager 는 이미 size-1 채널로 latest-wins 합치기를 한다. 도구 N개를 연달아 열면 저장이 N번 모두 일어난다.
- **개선안**: workspace.writer 의 latest-wins 패턴을 `platform`(또는 shared/statefile)의 작은 `CoalescingSaver`(dirty 플래그 + 대기 중 요청 하나)로 뽑아 ToolManager 와 workspace 가 함께 쓴다. saves WaitGroup·noSave·saveFile 세 장치가 이것 하나로 줄어든다. StopSaving 의 의미('더 시작하지 않고 진행 중인 것을 기다린다')는 그대로 둔다.

### SHR-7 — 내용이 같은 상태 파일도 매번 세대를 회전시킨다 — 세대가 같은 사본으로 밀려나고 NFR-SFD-1 의 비용 서술과 다르다

`P2` · 성능 · S · LOW · B · 확인 · 묶음키 `state-save-coalesce`

- **위치**: `internal/shared/platform/statefile.go:64`, `internal/shared/platform/statefile.go:81`, `docs/internal/STATE_FILE_DURABILITY_SRS.md:191`, `internal/shared/toolhub/persist.go:101`
- **근거**: rotateGenerations 는 현재 파일을 읽어 .bak.1 에 WriteFileAtomic(fsync) 으로 복사한다. 새 data 가 현재 내용과 같은지는 보지 않는다. tools.json 은 cwd 가 그대로면 바이트가 같은데도 저장할 때마다 3세대가 같은 사본으로 덮여, 정작 '몇 번 저장된 뒤에 알아챈 손상'을 되돌릴 여유가 사라진다. NFR-SFD-1 은 '회전은 rename 셋'이라 적지만 실제로는 ReadFile + fsync 쓰기가 한 번 더 있다.
- **개선안**: WriteStateFile 이 먼저 현재 파일을 읽어(회전 때도 어차피 읽는다) bytes.Equal 이면 회전과 쓰기를 모두 건너뛴다. 읽은 blob 을 회전에 재사용해 ReadFile 을 한 번으로 줄인다. NFR-SFD-1 의 비용 서술은 실제에 맞게 고친다.

### FEC-2 — save() 가 워크스페이스 전체를 두 번 직렬화한다

`P3` · 성능 · S · LOW · - · 확인 · 묶음키 `ws-save-dedupe`

- **위치**: `web/js/core/app.js:479`, `web/js/core/app.js:487`, `web/js/core/api.js:79`
- **근거**: wsBody=JSON.parse(JSON.stringify(this.ws,replacer)) 로 깊은 복사를 만든 뒤 apiPut 이 apiInit 에서 JSON.stringify(body) 를 한 번 더 한다(api.js:79). 저장 한 번에 stringify 2회와 parse 1회가 돈다. 헤더 Content-Type 도 apiInit 기본값과 겹쳐서 손으로 넣는다(app.js:476).
- **개선안**: const body=JSON.stringify(this.ws,replacer) 한 번으로 끝낸다. schemaVersion 은 replacer 에서 덮는다. apiPut 에는 문자열을 그대로 넘긴다(apiInit 이 문자열은 그대로 보낸다). _wsMarkSaved 에 줄 창 id 는 직렬화 시점의 this.ws.windows 에서 모은다. 이 문자열이 FEC-1 의 비교 키가 된다.

### FEC-6 — 설정 저장 디바운스 관용구 5벌 + 매직 넘버 500

`P3` · 중복 · S · LOW · - · 확인 · 묶음키 `settings-save-pipeline`

- **위치**: `web/js/core/app-settings-init.js:34`, `web/js/core/app-settings-init.js:65`, `web/js/core/app-settings-init.js:199`, `web/js/core/app-settings-init.js:231`, `web/js/core/app-settings-init.js:398`
- **근거**: TIMERS.cancel(this._xxxSaveTimer); this._xxxSaveTimer=this.timers.after(500,()=>this.saveSettings(),{owner:'app',label:'save-…'}) 가 _initPageTitle·_initTabWidth·_initFocusEdge·_initAttnEdge·_initNumSetting 에 따로 있고 필드 이름만 다르다. 확정 경로(blur·change 에서 cancel 뒤 즉시 저장)도 각각 따로 적었다. 일반화된 _initNumSetting 이 이미 있지만 나머지는 옮기지 않았다.
- **개선안**: SETTINGS_SAVE_DEBOUNCE_MS 상수와 _saveSettingsSoon(key)·_saveSettingsNow(key) 한 쌍을 만든다(키별 타이머를 Map 으로). 다섯 자리와 색 입력(FEC-5)이 그것을 쓴다.

### FEC-M3 — 설정 저장마다 보낸 쪽도 자기 방송을 받아 GET /api/settings 를 다시 한다

`P3` · 통신 · S · LOW · - · 검증자 추가 · 묶음키 `settings-save-pipeline`

- **위치**: `internal/webserver/httpapi/handlers_settings.go:121`, `web/js/core/state-registry.js:94`, `web/js/core/app-settings.js:170`
- **근거**: apiSettingsPut 은 보낸 쪽을 가리지 않고 settings_changed 를 방송한다. 보낸 브라우저도 _settingsRestore 로 GET /api/settings 뒤 _settingsApply 전체를 다시 돈다(테마 재적용, I18N.applyShortcuts, 감지 계층 재평가). 설정 변경 한 번에 PUT 1회와 자기 GET 1회, 전체 재적용 1회가 따른다. FEC-4 의 원인과 같은 경로의 통신 비용이다.
- **개선안**: PUT 에 clientId 를 싣고 방송 payload 에 origin 을 넣는다. 수신 측은 origin 이 자기이고 비행 중 저장이 없으면 재조회를 건너뛴다. FEC-4 ①(자기 에코 무시)을 서버 표식으로 결정적으로 만드는 방식이다.
- **결정 충돌**: SETTINGS_LIVE 의 '방송은 다시 받으라는 신호' 규약에 origin 필드를 더하는 결정이 필요하다.

### SHR-12 — 헬퍼·훅·셸 스크립트 설치물이 os.WriteFile(비원자, 무조건 덮어쓰기)로 쓰인다 — 살아 있는 셸이나 에이전트가 잘린 파일을 읽을 수 있다

`P3` · 결함 · S · LOW · - · 확인 · 묶음키 `install-atomic-write`

- **위치**: `internal/shared/runtime/install.go:463`, `internal/shared/runtime/install.go:211`, `internal/shared/agentadapter/claude_install.go:63`, `internal/shared/agentadapter/claude_install.go:99`, `internal/shared/agentadapter/omp_install.go:32`, `internal/shared/agentadapter/omp_install.go:35`
- **근거**: unpackEmbedded 는 부팅마다 모든 셸 훅 파일을 O_TRUNC 로 덮어쓴다. 에이전트 훅 claude.json, 플러그인 hooks.json, omp shim·멤버 설정도 같은 방식이다. 다른 도구의 셸이 source 하거나 claude 가 --settings 로 읽는 순간과 겹치면 빈 파일이나 잘린 파일을 읽는다. 같은 저장소에 platform.WriteFileAtomic 이 있다. 내용이 같아도 매번 쓰므로 부팅 IO 도 낭비된다.
- **개선안**: 설치 경로 전부에 쓰는 `writeIfChanged(path, data, mode)` 하나를 둔다. 기존 내용과 같으면 건너뛰고, 다르면 WriteFileAtomic 으로 쓴 뒤 mode 를 맞춘다. installAgentAssets 의 InstallSpec 에 이 쓰기 함수를 주입해 어댑터 설치물도 같은 자리를 지나게 한다.
- **이전 감사**: AUDIT-go-infra #7

## O6 — LSP 동기화·세션 (8건)

### DOM-1 — LSP sync 가 내용이 같아도 매 요청 전체 텍스트 didChange 를 보낸다

`P1` · 성능 · S · LOW · - · 확인 · 묶음키 `lsp-sync-dedupe`

- **위치**: `internal/webserver/domain/lsp/session.go:358`, `internal/webserver/domain/lsp/session.go:370`, `internal/webserver/domain/lsp/session.go:447`
- **근거**: sync 는 매번 판 번호를 올리고 sent[uri] 에 sha256 을 적는다(:370). 그런데 그 해시를 이전 값과 비교하지 않고 didChange 로 전체 텍스트를 보낸다. 같은 파일의 resync 는 hash==prev.hash 이면 보내지 않는다(:447~). 호버는 커서를 움직일 때마다 오므로, 편집이 없어도 최대 8MiB 텍스트를 보내고 언어 서버가 다시 파싱한다.
- **개선안**: sync 에서 seen && sent[uri].hash==새 해시이면 판 번호를 올리지 않고 Notify 를 생략한다. 해시 계산은 이미 하고 있으므로 비용이 늘지 않는다.
- **결정 충돌**: EDITOR_LSP_SRS D-3(요청이 현재 텍스트를 싣는다)과 충돌하지 않는다. 서버에서 언어 서버로 가는 구간의 중복만 없앤다.

### DOM-2 — 브라우저 -> 서버 LSP 요청이 호버마다 파일 전체 텍스트를 싣는다

`P2` · 통신 · M · MEDIUM · B · 확인 · 묶음키 `lsp-sync-dedupe`

- **위치**: `internal/webserver/domain/lsp/manager.go:24`, `internal/webserver/domain/lsp/manager.go:77`, `internal/webserver/domain/lsp/session.go:370`
- **근거**: Definition·References·Hover 가 모두 text 를 받는다(MaxTextBytes 8MiB). 세션은 이미 마지막 전송 해시(sent[uri].hash)를 기억한다.
- **개선안**: 요청에 textHash 를 선택 필드로 받는다. 세션이 기억한 해시와 같으면 text 를 비워도 되게 하고, 모르면 409 need_text 로 답해 클라이언트가 텍스트를 실어 다시 보내게 한다. 도메인은 Session.KnownHash(path) 만 내면 된다. 프론트엔드·핸들러 변경이 함께 필요하다.
- **결정 충돌**: D-3 은 현재 텍스트를 서버가 알아야 한다는 요구다. 해시가 같을 때 생략하는 것은 그 요구를 지키지만, 'text 를 싣는다'는 문장은 개정해야 한다.

### DOM-9 — lsp.Service.session 이 같은 키에 언어 서버를 두 번 띄울 수 있다

`P2` · 성능 · M · LOW · - · 확인 · 묶음키 `lsp-session-lifecycle`

- **위치**: `internal/webserver/domain/lsp/manager.go:226`, `internal/webserver/domain/lsp/manager.go:238`
- **근거**: 캐시 미스 뒤 s.mu 를 놓고 newSession 으로 프로세스를 띄운다. 동시에 들어온 요청도 미스를 보고 또 띄우며, 나중에 온 쪽이 자기 것을 Close 한다(:238). gopls 기동은 수백 MB 를 쓴다.
- **개선안**: Service 에 starting map[key]chan struct{} 를 둔다. 미스가 났을 때 기동 중인 키면 기다린 뒤 다시 조회한다(또는 singleflight 를 쓴다).
- **이전 감사**: AUDIT-go-domain MED lsp.Service.session

### FEC-14 — LSP 호버·정의·참조 요청마다 파일 전문을 싣고, 서버는 내용이 같아도 매번 didChange 전문을 보낸다

`P2` · 통신 · M · MEDIUM · - · 확인 · 묶음키 `lsp-text-sync`

- **위치**: `web/js/core/app-lsp.js:441`, `web/js/core/app-lsp.js:206`, `web/js/core/app-lsp.js:323`, `web/js/core/app-lsp.js:417`, `web/js/core/app-lsp.js:173`, `internal/webserver/domain/lsp/session.go:358`
- **근거**: _lspHoverWhere 가 {text:model.getValue()} 를 돌려주고(app-lsp.js:441), 호버·Ctrl+호버 정의 제공자·F12·참조가 모두 그것을 본문에 싣는다(:206, :323, :417). Monaco 는 마우스가 멈출 때마다 호버를 부르므로 큰 파일은 호버 한 번에 수백 KB 가 오간다. 서버 Session.sync 는 해시를 s.sent 에 적어 두기만 하고 비교하지 않은 채 판을 올려 didChange 전문을 보낸다(session.go:358-390). 언어 서버는 요청마다 전체 재파싱을 한다.
- **개선안**: 클라이언트는 경로별로 마지막으로 보낸 model.getAlternativeVersionId() 를 기억하고, 바뀌었을 때만 text 를 싣는다(아니면 text 를 빼고 version 만). 서버는 text 가 없거나 해시가 s.sent 와 같으면 didChange 를 건너뛴다. 서버가 문서를 잊었으면(didClose 뒤) 409 류로 알려 다시 보내게 한다.

### DOM-10 — LSP 요청 앞단이 세 벌이고, 텍스트 상한 검사가 세션 기동 뒤에 온다

`P3` · 중복 · S · LOW · - · 확인 · 묶음키 `lsp-session-lifecycle`

- **위치**: `internal/webserver/domain/lsp/manager.go:77`, `internal/webserver/domain/lsp/manager.go:82`, `internal/webserver/domain/lsp/manager.go:97`, `internal/webserver/domain/lsp/manager.go:112`, `internal/webserver/domain/lsp/session.go:499`, `internal/webserver/domain/lsp/session.go:551`
- **근거**: Definition·References·Hover 가 모두 session -> checkText -> ready 를 반복한다. 8MiB 를 넘는 텍스트도 session() 이 언어 서버를 먼저 띄운 뒤에 거절된다. Session.Hover 는 locate 의 waitReady·sync·position 조립을 복제하고, ready 뒤에 waitReady 를 한 번 더 부른다.
- **개선안**: manager 에 withSession(ctx, root, path, text, fn) 하나를 두고 checkText 를 맨 앞으로 옮긴다. Session 에는 request(ctx, method, path, text, line, col, extra, out) 하나를 두어 locate 와 Hover 가 함께 쓴다.

### DOM-11 — ext.Locate 가 실행 파일을 찾은 뒤에도 readiness(LookPath 등)를 계산하고 버린다

`P3` · 성능 · S · LOW · - · 확인 · 묶음키 `ext-locate-cost`

- **위치**: `internal/webserver/domain/ext/locate.go:263`, `internal/webserver/domain/ext/locate.go:275`
- **근거**: st.CanInstall, st.Missing = l.readiness(m) 뒤 st.Found 이면 Missing=nil 로 버린다. readiness 는 런타임마다 LookPath 와 toolchain LookPath 를 돌린다. 캐시 미스 경로와 Status() 에 실린다.
- **개선안**: readiness 를 blockers(m) 한 번으로 나눈다. Found 이면 CanInstall 만 계산하고 MissingNotFetched 는 할당하지 않는다.
- **이전 감사**: AUDIT-go-domain MED ext.Locate

### DOM-12 — SetPaths 가 아는 id 를 얻으려고 Status(전체 Locate)를 돌린다

`P3` · 성능 · S · LOW · - · 확인 · 묶음키 `ext-locate-cost`

- **위치**: `internal/webserver/domain/lsp/service.go:165`, `internal/webserver/domain/lsp/service.go:168`
- **근거**: known 표를 만들려고 s.Ext.Status(nil) 을 부른다. 서버마다 LookPath·Stat·readiness 가 돈다. 필요한 것은 선언의 pack/server id 뿐이다.
- **개선안**: Ext.Manifests() 와 Packs 로 id 만 모은다(ext.Service.ServerIDs()).

### DOM-13 — 서버 경로 표가 pack/server 로 키잉되지만 Locator 에는 server id 로만 넘어간다

`P3` · 결함 · S · LOW · B · 확인 · 묶음키 `ext-locate-cost`

- **위치**: `internal/webserver/domain/lsp/service.go:231`, `internal/webserver/domain/ext/locate.go:242`
- **근거**: locatorOverrides 가 desc 의 마지막 '/' 뒤만 키로 쓰고, Locate 는 l.Overrides[s.ID] 를 본다. 서로 다른 팩이 같은 server id 를 쓰면 한쪽 경로가 다른 쪽에도 적용된다. 반면 세션 키(exeKeyLocked)는 descID 를 쓴다.
- **개선안**: Locator.Overrides 를 descID(pack/server) 키로 바꾸고, Locate 에서 m.ID+"/"+s.ID 로 조회한다.

## O7 — git 실행 수·실행 경로 단일화 (15건)

### DOM-14 — Exec·ExecWrite·ExecUnguarded 의 오류 분류·거부·마감 처리가 세 벌이다

`P2` · 중복 · S · LOW · - · 확인 · 묶음키 `git-core-exec-unify`

- **위치**: `internal/webserver/domain/git/core/exec.go:114`, `internal/webserver/domain/git/core/write.go:141`, `internal/webserver/domain/git/core/unguarded.go:84`, `internal/webserver/domain/git/core/exec.go:123`, `internal/webserver/domain/git/core/write.go:243`, `internal/webserver/domain/git/core/unguarded.go:128`, `internal/webserver/domain/git/core/exec.go:129`, `internal/webserver/domain/git/core/unguarded.go:113`
- **근거**: 같은 switch(err==nil && ExitCode!=0 -> ExecError{kind: classify}, 분류되지 않은 err 감싸기)가 세 곳에 글자 그대로 있다. deny·denyWrite·denyUnguarded 도 같은 몸통이다. withTimeout 과 unguardedDeadline 은 d 기본값만 다르다.
- **개선안**: finishExec(ctx, argv, dir, out, err) error, denyWith(err, rec func(Output)), deadline(ctx, d) 를 하나씩 둔다. 세 진입점은 각각 한 줄로 부른다.
- **이전 감사**: AUDIT-go-domain MED Exec 오류 분류 세 벌

### DOM-16 — worktree.runGit 과 submodule.runGit 이 쌍둥이다(차이는 trim 방식 하나)

`P2` · 중복 · S · LOW · - · 확인 · 묶음키 `unguarded-runner`

- **위치**: `internal/webserver/domain/worktree/worktree.go:231`, `internal/webserver/domain/submodule/submodule.go:340`
- **근거**: 둘 다 ExecUnguarded(Timeout: ManagerWriteTimeout, Reason), ErrGitMissing 매핑, Stdout+Stderr 결합, %w 감싸기를 한다. worktree 는 TrimSpace, submodule 은 TrimRight(\r\n)이다. 앞 공백을 지우면 파싱이 깨진다는 결함이 이미 주석으로 남아 있다(submodule.go:312).
- **개선안**: core 에 RunUnguardedText(ctx, svc, dir, argv, timeout, reason, trim TrimMode) 를 두고, 두 패키지는 sentinel 매핑만 남긴다. DOM-17 을 풀려면 stdout 을 따로 돌려주는 형태가 좋다.
- **이전 감사**: AUDIT-go-domain MED runGit 쌍둥이

### DOM-17 — worktree isDirty 가 stderr 까지 읽어 경고 한 줄만으로 깨끗한 트리를 dirty 로 판정한다

`P2` · 결함 · S · LOW · B · 확인 · 묶음키 `unguarded-runner`

- **위치**: `internal/webserver/domain/worktree/remove.go:152`, `internal/webserver/domain/worktree/worktree.go:244`
- **근거**: runGit 은 strings.TrimSpace(out.Stdout+out.Stderr) 를 돌려준다. isDirty 는 그 결과가 비어 있지 않으면 dirty 로 본다. git status 가 stderr 로 경고(예: 디렉터리 열기 실패, 설정 경고)를 내면 변경이 없어도 ResidueDirty 가 되어 Run 정리가 트리를 남긴다.
- **개선안**: Runner 가 stdout 과 stderr 를 따로 돌려주게 하거나(DOM-16 의 공통 함수), isDirty 는 stdout 만 본다. `status --porcelain -z` 로 판정한다.

### DOM-19 — PreflightOf 가 git 프로세스를 5개 띄우고 signature 전체를 계산한다

`P2` · 성능 · S · LOW · - · 확인 · 묶음키 `git-query-exec-count`

- **위치**: `internal/webserver/domain/git/query/preflight.go:135`, `internal/webserver/domain/git/query/preflight.go:138`, `internal/webserver/domain/git/query/preflight.go:150`, `internal/webserver/domain/git/query/preflight.go:163`, `internal/webserver/domain/git/query/preflight.go:174`, `internal/webserver/domain/git/query/preflight.go:180`
- **근거**: configGet 을 4회(user.name, user.email, commit.gpgsign, commit.template) 부르고, 캐시되지 않은 s.GitDirs(rev-parse)를 부른다. RefName 하나를 얻으려고 ReadSignature(refsTree 워크, extras 포함)를 돈다. 커밋 화면을 열 때와 커밋 사전 단계(handlers_git_write.go:208)에서 부른다.
- **개선안**: `config -z --get-regexp '^(user\.name|user\.email|commit\.gpgsign|commit\.template)$'` 한 번으로 읽는다. 여러 값이면 마지막 값을 쓰고, gpgsign 은 gitBool 로 해석한다. 이 인자가 guard 를 지나는지 먼저 확인한다(--list 는 허용돼 있음). gitDir 은 Store.gitDirs 캐시를 쓰고 HEAD 는 파일만 읽는다.

### DOM-20 — PushSpec·StashPush 가 값 몇 개를 얻으려고 --untracked-files=all 전체 status 를 돈다

`P2` · 성능 · S · LOW · - · 확인 · 묶음키 `git-query-exec-count`

- **위치**: `internal/webserver/domain/git/write/remote.go:206`, `internal/webserver/domain/git/write/stash.go:145`
- **근거**: PushSpec 은 HasUpstream·Detached·Branch 만 쓴다. StashPush 는 '0개인가'만 본다. 둘 다 StatusOf(`--untracked-files=all`)를 부르는데, 이것은 node_modules 가 무시되지 않은 저장소에서 가장 비싼 조회다.
- **개선안**: 제안은 유효하다. 다만 StashEmptyReason(st, ...) 가 status 의 untracked 정보를 사유 문장에 쓰는지 확인해야 한다. PushSpec 은 status 대신 `rev-parse --abbrev-ref --symbolic-full-name @{u}` 와 HEAD 파일 읽기로도 충분하다.

### DOM-15 — '분류되지 않은 ExecError' 관용구가 7곳으로 늘었고, rev-parse --verify 조회도 4벌이다

`P3` · 추상화 · S · LOW · - · 확인 · 묶음키 `git-core-exec-unify`

- **위치**: `internal/webserver/domain/git/query/head.go:18`, `internal/webserver/domain/git/query/branch.go:66`, `internal/webserver/domain/git/query/branch.go:239`, `internal/webserver/domain/git/query/tag.go:59`, `internal/webserver/domain/git/query/preflight.go:236`, `internal/webserver/domain/git/write/tag.go:290`, `internal/webserver/domain/git/query/diff.go:386`, `internal/webserver/domain/git/query/branch.go:115`
- **근거**: `errors.As(err,&xe) && xe.Unwrap()==nil` 이 7곳에 있다(이전 감사 시점에는 5곳). HasHead·LocalBranchExists·refOid·TagOid 가 모두 rev-parse --verify <prefix+name> 을 각자 부른다.
- **개선안**: core.PlainExit(err) (*ExecError, bool) 를 추가한다. query 에는 refOid 와 refExists(=PlainExit 이면 false) 하나를 두고 HasHead·LocalBranchExists·TagOid 를 그 위에 세운다.
- **이전 감사**: AUDIT-go-domain MED 관용구 다섯 벌

### DOM-18 — git 프로세스 기동이 두 벌이다 — 잡 경로에는 launchArgs 가 없고, 두 경로 모두 실행마다 LookPath 를 한다

`P3` · 중복 · S · LOW · B · 확인 · 묶음키 `git-core-exec-unify`

- **위치**: `internal/webserver/domain/git/core/exec.go:147`, `internal/webserver/domain/git/core/exec.go:198`, `internal/webserver/domain/git/jobs/exec.go:24`, `internal/webserver/domain/git/jobs/exec.go:38`
- **근거**: execGit 은 LookPath + CommandContext(bin, launchArgs(args)) + Env + Spawn 이다. execStreamGit/execStream 은 LookPath + CommandContext(bin, args) 로, `-c log.showSignature=false` 가 빠져 있다(REPO_FIX 01 P-4 는 '기동 헬퍼'에 붙인다고 정했다). exec.LookPath("git") 는 status 폴링을 포함해 모든 git 실행마다 PATH 를 훑는다.
- **개선안**: core.GitCmd(ctx, dir, args, stdin) *exec.Cmd 로 모은다. bin 은 캐시하고(ErrNotFound 이면 다시 조회), launchArgs 와 Env 를 한 자리에서 붙인다. jobs 는 이것을 쓴다.
- **결정 충돌**: REPO_FIX 01 P-4 조사표가 잡 경로를 대상에서 뺐는지 확인해야 한다. 잡 출력은 파싱하지 않으므로 차이는 기록·표시뿐이다.

### DOM-21 — StashPopChecked 가 stash list 를 한 번 더 부른다

`P3` · 성능 · S · LOW · - · 확인 · 묶음키 `git-query-exec-count`

- **위치**: `internal/webserver/domain/git/write/stash.go:262`, `internal/webserver/domain/git/write/stash.go:247`
- **근거**: StashPopChecked 가 StashLocate 를 부르고 결과를 버린다. 이어서 StashPop 이 같은 oid 로 StashLocate 를 다시 부른다. 사후 확인까지 stash list 가 3회 돈다.
- **개선안**: stashPopAt(target Stash) 내부 함수를 두고, Checked 는 한 번 찾은 target 을 넘긴다(2회로 줄어든다).

### DOM-22 — 충돌 Resolve 가 경로마다 git 을 2개씩 순차로 띄운다

`P3` · 성능 · M · MEDIUM · B · 확인 · 묶음키 `git-query-exec-count`

- **위치**: `internal/webserver/domain/git/write/resolve.go:70`, `internal/webserver/domain/git/write/resolve.go:97`
- **근거**: 경로마다 checkout --ours|--theirs 와 add 를 따로 ExecWrite 한다. N개 경로면 2N개 프로세스다. 같은 패키지에 경로 묶음 실행기 execPaths(stage.go:143)가 이미 있다.
- **개선안**: 경로를 checkout 대상과 rm 대상으로 나눠 execPaths 로 묶어 실행한다. 묶음이 실패하면 그 묶음만 경로별로 다시 실행해 ResolveResult 의 경로별 결과를 유지한다.

### DOM-23 — diff 한쪽마다 cat-file -s 와 show 를 둘 다 부른다(요청당 최대 4개)

`P3` · 성능 · S · MEDIUM · - · 확인 · 묶음키 `git-query-exec-count`

- **위치**: `internal/webserver/domain/git/query/diff.go:192`, `internal/webserver/domain/git/query/diff.go:213`, `internal/webserver/domain/git/query/diff.go:44`
- **근거**: diffBlobSide 는 크기를 먼저 물은 뒤 show 한다. 그런데 DiffMaxBytes(1MiB)가 출력 상한 core.DefaultMaxOutput(1MiB)과 같아서, 상한은 show 의 잘림 여부로 이미 드러난다(:218 도 잘림을 TooLarge 로 다룬다).
- **개선안**: cat-file -s 선검사는 유지한다. 줄이려면 상한 초과 시 프로세스를 끊는 모드(cappedBuffer 가 넘치면 cancel)를 core 에 먼저 둔다. 그 뒤에만 show 우선을 검토한다. 그 전에는 변경하지 않는다.

### DOM-24 — worktree.Resolve 가 rev-parse 를 2~3회 순차로 부른다

`P3` · 성능 · S · LOW · - · 확인 · 묶음키 `git-query-exec-count`

- **위치**: `internal/webserver/domain/worktree/worktree.go:290`, `internal/webserver/domain/worktree/worktree.go:306`, `internal/webserver/domain/worktree/worktree.go:313`
- **근거**: --show-toplevel 을 부르고, 이어서 --abbrev-ref HEAD, detached 이면 rev-parse HEAD 를 부른다. 격리 Run 을 시작할 때마다 돈다.
- **개선안**: `rev-parse --show-toplevel HEAD --abbrev-ref HEAD` 순서로 부르면 toplevel·sha·이름 세 줄이 나온다(실측). 커밋 없는 저장소에서는 실패하므로, 그때만 --show-toplevel 을 다시 불러 '저장소 아님'과 'HEAD 없음'을 가른다.

### DOM-26 — git Store 캐시 — pruneCache 가 통째로 비우고, RepoRoot 에 single-flight 가 없고, CommonDirKey 에 캐시되지 않은 길이 하나 더 있다

`P3` · 성능 · S · LOW · - · 확인 · 묶음키 `git-store-cache`

- **위치**: `internal/webserver/domain/git/store/store.go:378`, `internal/webserver/domain/git/store/store.go:262`, `internal/webserver/domain/git/core/exclusion.go:57`, `internal/webserver/gitapi/handlers_git_remote.go:228`, `internal/webserver/httpapi/handlers_runs_worktree.go:55`, `internal/webserver/gitapi/gitlock.go:151`
- **근거**: 항목이 64개에 닿으면 clear(m) 로 전부 버린다. 핀이 64개를 넘으면 gitDirs 30초 TTL 이 무의미해진다. RepoRoot 는 미스가 동시에 나면 호출자마다 rev-parse 를 돌린다. gitlock.go 는 캐시된 Store.CommonDir 를 쓰지만 handlers_git_remote 와 runs_worktree 는 svc.CommonDirKey 로 매번 rev-parse 한다.
- **개선안**: pruneCache 는 만료 항목부터 거두고, RepoRoot 에 키별 inflight 를 둔다. gitapi 폴백 경로는 대상에서 뺀다. runs_worktree 의 commonKey 는 s.Git 이 있으면 Store 캐시를 쓰게 하는 정도로 둔다(우선순위 낮음).
- **이전 감사**: AUDIT-go-domain P5

### DOM-31 — 경로·ref 인자 가드가 패키지마다 따로 있고 강도가 다르다

`P3` · 중복 · S · LOW · B · 확인 · 묶음키 `arg-guard-unify`

- **위치**: `internal/webserver/domain/submodule/submodule.go:279`, `internal/webserver/domain/git/core/guard.go:205`, `internal/webserver/domain/worktree/naming.go:86`, `internal/webserver/domain/git/core/guard.go:250`
- **근거**: submodule.checkPath 는 core.RelPath 와 같은 목적인데 NUL 검사가 없고, 볼륨 없는 루트 상대(`\foo`, Windows)를 막지 못한다. worktree.validRef 와 core.CheckRefArg 도 같은 규칙(- 시작, .., 제어 문자)을 각자 갖는다.
- **개선안**: submodule 은 core.RelPath(p, ErrUnsafePath) 를 쓰고 '-' 시작 금지만 덧붙인다. worktree.validRef 는 core.CheckRefArg 위에 .lock·// 같은 추가 규칙만 얹는다.

### HTTP-12 — branch/tag validate 핸들러가 32줄 거의 그대로 두 벌이다

`P3` · 중복 · S · LOW · - · 확인 · 묶음키 `git-name-validate`

- **위치**: `internal/webserver/gitapi/handlers_git_branch.go:109-140`, `internal/webserver/gitapi/handlers_git_tag.go:148-180`
- **근거**: 본문 조립, ErrRefName 분기, 존재 확인 순서가 같다. 다른 것은 kinds 키와 검증·존재 함수 둘뿐이다.
- **개선안**: gitNameValidateRoute(w, r, extra map[string]any, valid, exists func(...)) 로 한 번만 적고, 두 핸들러는 각각 한 줄로 만든다. 응답 바이트는 그대로 둔다.
- **이전 감사**: AUDIT-go-http M-3

### HTTP-27 — 세마포어 fan-out 이 세 벌이고, observe=1 은 핀마다 RepoRoot 를 두 번 fan-out 한다

`P3` · 중복 · S · LOW · - · 확인 · 묶음키 `git-pins-fanout`

- **위치**: `internal/webserver/gitapi/handlers_git.go:136-161`, `internal/webserver/gitapi/handlers_git.go:238-265`, `internal/webserver/hub/gitwatch.go:456-476`
- **근거**: gitObservePins·gitPinnedEntries·GitWatcher.Tick 이 같은 `sem := make(chan struct{}, N); wg; go func` 패턴을 각자 적는다. GET /api/git/repos?observe=1 은 gitObservePins(RepoRoot+Status)가 끝난 뒤 gitPinnedEntries 가 다시 핀 전체 RepoRoot fan-out 을 돈다(TTL 캐시로 git 은 안 돌지만 고루틴·락 왕복이 두 번이다).
- **개선안**: boundedEach 헬퍼만 도입해 세 곳의 세마포어/WaitGroup 보일러플레이트를 줄인다. 관측 단계와 응답 조립 단계의 분리(handlers_git.go:129-133)는 유지한다. 중복을 줄이려면 gitPinsRead 결과를 두 단계에 인자로 넘기는 데까지만 한다.

## O8 — 서버 내부 성능·SSE (27건)

### DOM-25 — wsentry.Roots 가 파일 API 요청마다 MkdirAll 2회, EvalSymlinks 3회, workspace.json 전체 파싱을 한다

`P2` · 성능 · M · LOW · - · 확인 · 묶음키 `wsentry-roots-cache`

- **위치**: `internal/webserver/domain/wsentry/wsentry.go:93`, `internal/webserver/domain/wsentry/wsentry.go:107`, `internal/webserver/domain/wsentry/wsentry.go:118`, `internal/webserver/domain/wsentry/wsentry.go:146`, `internal/webserver/httpapi/handlers_fs.go:134`
- **근거**: Roots 는 List(Home 의 EvalSymlinks + Read 의 json.Unmarshal 로 창 트리까지 map[string]any 로 풂), Notes·Plugins(각각 MkdirAll + NormalizePath)를 거친다. fsRoot 는 그 결과마다 NormalizePath 를 또 부른다. fsRoot 는 파일 API 13곳에서 쓰인다.
- **개선안**: Notes·Plugins 는 '보장됨' 표식을 캐시하고, Stat 이 실패할 때만 MkdirAll 한다(FR-NOT-1·2 의 '없으면 만든다'를 유지). workspace.json 파싱은 Snapshot rev 로 메모이즈하고 정규화된 list 도 함께 캐시한다. 그러면 fsRoot 의 루프 안 NormalizePath 를 없앨 수 있다.
- **이전 감사**: AUDIT-go-domain LOW wsentry.Roots MkdirAll

### HTTP-3 — /api/runs/context 훅이 비멤버에게도 매번 lsof/ps fork 체인과 settings 재파싱을 돈다

`P2` · 성능 · S · LOW · - · 확인 · 묶음키 `run-caller-resolve-fastpath`

- **위치**: `internal/webserver/httpapi/handlers_runs_context.go:166-167`, `internal/webserver/httpapi/handlers_runs.go:85-91`, `internal/webserver/seam/adapters/client.go:20-46`, `internal/shared/platform/procinfo.go:171-184`
- **근거**: apiRunContext 는 Run 과 무관한 모든 claude 세션의 훅이 부른다(주석: 비멤버는 조용히 200). 그런데 매 호출이 callerToolID → ResolveClientPane 을 지난다. darwin 에서는 lsof 1~2회에 부모 체인마다 `ps -o ppid=` 를 최대 32회 fork 하고, 그다음 contextPolicy() 가 settings blob 전체를 json.Unmarshal 한다. 결과는 대부분 observed:false 다. callerToolID 는 report·handoff·peers·run start 에서도 같은 비용을 낸다.
- **개선안**: ObserveContext 전에 싼 판정을 둔다. 열린 Run 이 하나도 없으면(Runs 가 메모리에서 답함) PID 해석 없이 observed:false 로 답한다. PID 해석 우선 정책(스푸핑 방지)은 멤버가 있을 수 있을 때만 적용한다. contextPolicy 는 HTTP-27 의 캐시된 settings 뷰를 쓴다.

### IPC-12 — SSE 핸들러가 메시지마다 문자열 연결·쓰기·Flush 를 따로 하고, 작은 큐(16)가 버스트에서 구독을 닫아 재연결 폭주를 부른다

`P2` · 성능 · S · LOW · - · 확인 · 묶음키 `sse-write-batching`

- **위치**: `internal/webserver/httpapi/commands.go:124-173`, `internal/webserver/hub/commands.go:224-233`, `internal/webserver/hub/commands.go:281-296`, `internal/webserver/hub/attn_tracker.go:311-331`
- **근거**: send() 는 frame 하나마다 SetWriteDeadline→WriteString→Flush 를 부르고, 호출부는 `"data: " + string(msg) + "\n\n"` 로 구독자마다 복사본을 만든다. 채널에 쌓인 메시지를 모아 한 번에 flush 하지 않는다. cmdSubQueue=16 이고 넘치면 구독을 닫는다(→브라우저 재연결→IPC-6 의 복원 묶음). ClearAllAttention 은 지운 도구마다 onClear→Broadcast 를 따로 불러서, 도구 20개를 한 번에 지우면 20건이 연달아 나간다. 쓰기 쪽이 flush 마다 syscall 을 치르는 동안 16칸을 넘길 수 있다.
- **개선안**: (1) 메시지 하나를 받으면 `for len(ch)>0` 로 대기 중인 것(상한 예: 64)을 비블로킹으로 더 꺼내 bytes.Buffer 에 모아 한 번 쓰고 한 번 flush 한다. (2) 대량 이벤트는 묶음 payload 로 보낸다: `tool_attention_clear{ids:[…]}`(브라우저 핸들러도 배열을 받게). (3) 큐를 64 로 늘리는 것도 검토한다(메모리는 구독당 포인터 64개).

### SHR-8 — BackgroundList 는 도구마다 cwd 를 따로 물어 darwin 에서 lsof 를 N번 fork 한다 — FR-PRF-76 의 일괄 조회가 여기에는 적용되지 않았다

`P2` · 성능 · S · LOW · - · 확인 · 묶음키 `cwd-batch`

- **위치**: `internal/shared/toolhub/manager_hub.go:233`, `internal/shared/toolhub/tool_cwd.go:41`, `internal/shared/toolhub/tool_cwd.go:58`, `internal/shared/platform/procinfo.go:121`
- **근거**: SaveAll 은 FR-PRF-76 으로 CWDs 를 한 번 부르게 바뀌었다. 그런데 BackgroundList 는 루프 안에서 cwdOrServer(p.t) → p.Cwd() → Info.CWD(pid)(darwin lsof 1회)를 도구마다 부른다. 순서 규칙(직접 조회 → 셸 보고 → 서버 cwd)도 cwdOrServer 와 cwdOrServerFrom 두 벌로 적혀 있다.
- **개선안**: BackgroundList 도 pid 를 모아 CWDs 를 한 번 부르고 cwdOrServerFrom 을 쓴다. cwdOrServer 는 `cwdOrServerFrom(p, Info.CWDs([]int{pid}))` 로 줄이거나 없애서 순서 규칙을 한 벌로 만든다.

### SHR-9 — 에이전트 훅 한 번마다 dmctl 이 HTTP 를 2번 부르고, 전사본 꼬리 256KB 를 읽어 string 복사 후 Split 한다

`P2` · 통신 · M · MEDIUM · B · 확인 · 묶음키 `hook-report-path`

- **위치**: `internal/helper/runtimebin/dmctl_activity.go:86`, `internal/helper/runtimebin/dmctl_activity.go:111`, `internal/helper/runtimebin/dmctl_activity.go:147`, `internal/helper/runtimebin/dmctl_activity.go:175`, `internal/helper/runtimebin/dmctl_activity.go:196`
- **근거**: claude 훅은 모든 이벤트(PreToolUse/PostToolUse 포함)에 transcript_path 와 session_id 를 싣는다. 그래서 reportContext 의 조기 반환이 거의 타지 않고, 도구 호출 하나당 /api/tools/activity/set 과 /api/runs/context 두 요청이 나간다. transcriptUsage 는 매번 최대 256KB 를 읽고 `strings.Split(string(buf), "\n")` 으로 사본과 슬라이스를 만든 뒤 뒤에서부터 훑는다. 도구 호출이 잦은 턴에서 훅 프로세스마다 이 비용이 다시 든다.
- **개선안**: ① 전사본 꼬리는 bytes.LastIndexByte 로 뒤에서부터 줄 단위로 훑고, 마지막 usage 줄을 찾으면 곧바로 멈춘다(사본과 Split 제거). ② 컨텍스트 관측은 PostToolUse/Stop/PreCompact/SessionStart/UserPromptSubmit 처럼 값이 바뀌는 이벤트로 한정하거나, 한 요청에 선택 필드로 실어 보낸다. ②는 결정 확인이 필요하다.
- **결정 충돌**: dmctl_activity.go:98-101 과 NFR-CBG-2 는 관측 층을 별도 종단으로 둔 이유를 실패 격리로 적는다. 합치려면 그 결정을 다시 확인해야 하므로 ①만 결정 충돌 없이 할 수 있다.

### DOM-33 — sysstat 이 바뀌지 않는 부팅 시각을 2초마다 읽고, linux 는 /proc/stat 을 틱마다 두 번 읽는다

`P3` · 성능 · S · LOW · - · 확인 · 묶음키 `sysstat-sample`

- **위치**: `internal/webserver/domain/sysstat/sampler.go:90`, `internal/webserver/domain/sysstat/reader_linux.go:22`, `internal/webserver/domain/sysstat/reader_linux.go:38`
- **근거**: sample() 은 매 주기 BootTime() 을 부른다. linux 에서는 CPUTicks 와 BootTime 이 각자 os.ReadFile("/proc/stat") 을 한다.
- **개선안**: BootValid 가 된 뒤에는 BootTime 을 다시 읽지 않는다. linux reader 는 한 틱에 읽은 blob 을 두 파서가 함께 쓴다.

### HTTP-10 — SSE 스트림 구현이 두 벌이고, job events 쪽에는 쓰기 시한과 쓰기 오류 판정이 없다

`P3` · 중복 · M · LOW · - · 확인 · 묶음키 `sse-writer`

- **위치**: `internal/webserver/httpapi/commands.go:54-175`, `internal/webserver/gitapi/handlers_git_remote.go:286-357`
- **근거**: apiGitJobEvents 주석은 '구현 규약은 /api/commands/sse 를 따른다' 라고 적었다. 그런데 commands SSE 에 있는 http.ResponseController.SetWriteDeadline(sseWriteTimeout)과 Write/Flush 오류 시 종료가 없다. fmt.Fprint·Fprintf 의 오류를 버리고 줄마다 flusher.Flush() 한다. 헤더 세 줄, keep-alive ticker, `data: ...\n\n` 조립도 두 파일에 따로 있다. 멎은 클라이언트 하나가 job 구독 고루틴을 붙든다.
- **개선안**: 작은 패키지(internal/webserver/sse)에 Stream{rc, deadline} 과 Open(w)(헤더·연결 코멘트), Event(name, payload) bool, Data(bytes) bool, Comment() bool 을 둔다. 두 핸들러가 이것을 쓰게 하고, 채널에 쌓인 이벤트를 한 번에 써서 flush 1회로 묶는 drain 도 함께 둔다.

### HTTP-15 — SSE payload 조립이 핸들러·조립 루트에 인라인으로 흩어져 있다 (workspace_changed 두 벌)

`P3` · 중복 · S · LOW · - · 확인 · 묶음키 `sse-payloads`

- **위치**: `internal/webserver/httpapi/handlers_api.go:414-420`, `internal/webserver/httpapi/handlers_runs_marks.go:87-92`, `cmd/dongminal/main.go:383-391`, `internal/webserver/httpapi/handlers_settings.go:91-97`, `internal/webserver/httpapi/access.go:617-624`
- **근거**: hub 패키지는 toolAttentionPayload·gitChangedPayload·BackgroundChangedPayload 처럼 action 마다 생성 함수를 둔다. 반면 workspace_changed 는 map 리터럴로 두 곳에 복제돼 있고, lsp_diagnostics 는 main.go 에서, settings_changed·access_changed 는 httpapi 에서 따로 만든다.
- **개선안**: hub 에 WorkspaceChangedPayload(rev)·LSPDiagnosticsPayload(d)·SettingsChangedPayload()·AccessChangedPayload() 를 두고, wsentry/mutate.go 의 broadcastAct 까지 포함한 세 곳의 workspace_changed 를 모두 그것으로 바꾼다.

### HTTP-25 — 라우팅이 선형 스캔이고, /api/git/* 는 httpapi 표 약 100개를 먼저 훑은 뒤에야 닿는다

`P3` · 성능 · S · LOW · - · 확인 · 묶음키 `route-index`

- **위치**: `internal/webserver/httproute/httproute.go:36-48`, `internal/webserver/httpapi/handlers_api.go:233-238`, `internal/webserver/gitapi/routes.go:118-130`
- **근거**: Dispatch 는 표를 앞에서부터 돌며 Method 비교와 클로저 Match 를 호출한다. handleAPI 는 apiRoutes 전체가 실패한 뒤에 s.git.Handle 로 넘긴다. 알려진 경로에 다른 메서드로 오면 405 가 아니라 404 가 나간다.
- **개선안**: handleAPI 에서 strings.HasPrefix(p, "/api/git/") 이면 곧바로 s.git.Handle 로 보낸다(표 한 벌 소유 FR-DRC-10 유지). httproute 에 map 색인을 추가하는 것은 측정된 병목이 없으므로 하지 않는다.
- **결정 충돌**: DRIFT_RECLAIM_SRS FR-DRC-10(표 한 벌 소유)은 유지한다. 색인은 httproute 내부 최적화다. 404→405 전환은 behaviorChange 라 이번 묶음에서 제외한다.

### HTTP-26 — settings blob 을 호출마다 각자 map/구조체로 재파싱한다

`P3` · 성능 · S · LOW · - · 확인 · 묶음키 `settings-view-cache`

- **위치**: `internal/webserver/httpapi/handlers_api.go:305`, `internal/webserver/httpapi/agent_render_env.go:45-60`, `internal/webserver/httpapi/handlers_runs_context.go:95-116`, `internal/webserver/httpapi/handlers_settings.go:36-40`
- **근거**: 도구 생성마다 agentRenderEnv 가 settings 전체를 map[string]any 로 Unmarshal 한다. 컨텍스트 훅마다 contextPolicy 가 같은 blob 을 다시 Unmarshal 한다. settingsStore 는 바이트만 들고 있다.
- **개선안**: settingsStore.Set 시점에 서버가 읽는 키들의 typed view(renderEnv, contextPolicy)를 한 번 파싱해 캐시하고, Get 계열 접근자를 둔다. blob 자체는 여전히 해석하지 않고 그대로 저장·응답한다.

### HTTP-28 — POST /api/commands 가 비생성 명령마다 payload 전문을 Info 로 남긴다

`P3` · 성능 · S · LOW · - · 확인 · 묶음키 `cmd-log-payload`

- **위치**: `internal/webserver/httpapi/commands.go:275`, `internal/webserver/httpapi/commands.go:268-273`
- **근거**: `dmlog.Infof(nil, "[cmd] action=%s%s delivered=%d payload=%s", ...)` 가 openUrl 의 URL(쿼리 토큰 포함 가능)과 renameTab 등 인자 전문을 매번 기록한다. 로그 상한(RECONNECT_STORM FR-LOG-1)이 있는 제품이고, 생성 명령 쪽 로그에는 payload 가 없다.
- **개선안**: Info 에는 action·location·delivered·len(payload) 만 남기고, 전문은 Debug 로 내린다. openUrl 은 호스트만 남긴다.

### HTTP-31 — 서버 내부 대기가 폴링 루프다 (activity wait 100ms, handoff 250ms, attach 50ms, 종료 대기 250ms)

`P3` · 성능 · M · MEDIUM · - · 확인 · 묶음키 `wait-event-driven`

- **위치**: `internal/webserver/httpapi/handlers_status.go:37-42`, `internal/webserver/httpapi/handlers_status.go:254-277`, `internal/webserver/httpapi/handlers_runs.go:391-403`, `internal/webserver/httpapi/handlers_runs_headless.go:41-42`, `internal/webserver/httpapi/handlers_runs_headless.go:256-263`, `internal/webserver/httpapi/handlers_runs_cleanup.go:114-122`
- **근거**: apiToolStatusWait 는 대기 하나당(최대 32개·30분) 100ms 틱으로 toolStatusOf 를 재평가하고, 1초마다 liveness RPC 를 한다. waitHandoff 는 HandoffWaiting 을 250ms, awaitTab 은 workspace 색인을 50ms, waitToolsIdle 은 Busy RPC 를 250ms 간격으로 폴링한다. 상태를 바꾸는 쪽(AttnTracker.SetActivity, RunStore.Handoff, workspace Save, OnExit push)은 모두 서버 안에 있다.
- **개선안**: 이벤트 구동 전환 대신 HTTP-2 의 busy 일괄 RPC 로 waitToolsIdle 을 바꾼다. activity wait 의 liveness 는 OnExit push 로 받은 종료 집합을 먼저 확인한 뒤 RPC 한다. handoff·awaitTab 의 메모리 폴링은 그대로 둔다.

### HTTP-4 — accessGate 가 요청마다 전역 뮤텍스를 잡고 허용 항목 전부를 다시 파싱한다

`P3` · 성능 · M · LOW · - · 확인 · 묶음키 `access-matcher-snapshot`

- **위치**: `internal/webserver/httpapi/access.go:408-450`, `internal/webserver/httpapi/access.go:366-380`, `internal/webserver/httpapi/reqgate.go:87-127`
- **근거**: allowed() 는 모든 HTTP 요청(정적 자산·WS 포함)에서 s.mu 를 잡는다. 그리고 cfg.Entries 마다 netip.ParseAddr → ParsePrefix 를 다시 수행한다. self 루프는 isSelf 와 allowed 에 두 벌 있다. requestGate 의 hostAllow.ok 는 isSelf 와 hasHostAlias 로 같은 락을 두 번 더 잡는다. 콜드 로드에 Monaco 청크 수십 개가 오면 요청 수 × 항목 수만큼 파싱하고 락을 경합한다.
- **개선안**: setConfig/refresh 시점에 불변 matcher 스냅샷(self set, 미리 파싱한 addrs/prefixes, resolved, 소문자 hostAliases, enabled)을 atomic.Pointer 에 넣는다. allowed·isSelf·hasHostAlias 는 스냅샷만 읽는다. isSelf 와 allowed 의 판정 분리(access.go:362-366 주석)는 유지하고, self 집합 조회만 공용 헬퍼로 둔다.

### HTTP-8 — /api/state 가 workspace blob 을 interface{} 로 왕복 해석하고 오류를 버린다

`P3` · 성능 · S · LOW · - · 확인 · 묶음키 `state-raw-workspace`

- **위치**: `internal/webserver/httpapi/handlers_api.go:250-253`
- **근거**: json.Unmarshal(rawWS, &ws) 는 반환값을 받지 않는다. 그다음 map 트리를 다시 Encode 한다. workspace.json 이 깨져 있으면 조용히 "workspace": null 이 나간다. apiWorkspaceGet(:349-360)은 같은 바이트를 그대로 쓴다.
- **개선안**: 응답 구조체에 Workspace json.RawMessage 를 둔다. 빈 값이면 "null" 을 넣는다. 해석이 사라지고 오류 삼킴도 함께 없어진다.
- **이전 감사**: AUDIT-go-http M-9 · P-6

### HTTP-9 — waitInFlight·waitMaxConcurrent 가 여전히 패키지 전역이다

`P3` · 결함 · S · LOW · - · 확인 · 묶음키 `server-limits-wait`

- **위치**: `internal/webserver/httpapi/handlers_status.go:49-52`, `internal/webserver/httpapi/handlers_status.go:218-224`, `internal/webserver/httpapi/server.go:150-169`
- **근거**: var waitMaxConcurrent int64 = 32 / waitInFlight atomic.Int64 가 전역이다. serverLimits 는 GO-9 로 서버 필드가 됐지만 이 계수기는 옮기지 않았다. 그래서 한 프로세스의 두 Server 가 32 슬롯을 나눠 쓰고, 이를 낮추는 테스트는 병렬 실행 시 다른 테스트에 번진다.
- **개선안**: serverLimits 에 waitMaxConcurrent(기본 32)를 두고 Server 에 waitInFlight atomic.Int64 필드를 둔다. 테스트는 srv.limits.waitMaxConcurrent 로 낮춘다.
- **이전 감사**: AUDIT-go-http H-6

### HTTP-M2 — commands SSE 가 메시지·진단마다 write+flush 를 따로 한다 (쌓인 이벤트를 합쳐 쓰지 않음)

`P3` · 성능 · S · LOW · - · 검증자 추가 · 묶음키 `sse-writer`

- **위치**: `internal/webserver/httpapi/commands.go:125-133`, `internal/webserver/httpapi/commands.go:155-167`
- **근거**: send() 는 프레임마다 SetWriteDeadline, WriteString, Flush 를 한다. DiagnosticsReady 갈래는 TakeDiagnostics() 로 받은 N건을 루프에서 하나씩 send 해 flush 가 N번 일어난다. Messages() 에 여러 건이 쌓여 있어도 select 한 번에 하나씩 flush 한다.
- **개선안**: TakeDiagnostics 결과는 프레임을 하나의 버퍼에 이어 붙여 send 1회로 보낸다. Messages 갈래도 채널에 쌓인 것을 non-blocking 으로 상한(예: 64KiB)까지 모아 한 번에 쓴다. HTTP-10 의 공용 sse 패키지에 drain 으로 넣는다.

### IPC-20 — SSE payload 빌더 7곳이 같은 json.Marshal(map{action,args}) 을 반복하고, 주의·활동 방송 배선도 두 벌이다

`P3` · 중복 · S · LOW · - · 확인 · 묶음키 `sse-event-helper`

- **위치**: `internal/webserver/hub/activity.go:44-58`, `internal/webserver/hub/attention.go:8-31`, `internal/webserver/hub/foreground.go:19-32`, `internal/webserver/hub/background.go:23-33`, `internal/webserver/hub/update.go:13-16`, `internal/webserver/hub/gitwatch.go:118-124`, `internal/webserver/httpapi/focus.go:13-25`, `internal/webserver/hub/attn_tracker.go:72-90`
- **근거**: payload 함수마다 `b, _ := json.Marshal(map[string]any{"action":…, "args":…})` 로 오류를 버리는 같은 형태다. 직접 모드 WireAttention/WireActivity 와 데몬 모드 NewAttnTracker 안의 onAttention/onAttentionClear/onActivity 가 같은 Broadcast(payload) 를 따로 조립한다.
- **개선안**: hub 에 `type Event struct{Action string `json:"action"`; Args any `json:"args,omitempty"`}` 와 `func EventPayload(action string, args any) []byte`(오류는 로그) 하나를 둔다. action 이름은 상수(ActToolActivity 등)로 하고, 브라우저 state-registry 의 이벤트 이름과 대조하는 계약 검사를 붙인다. 두 모드의 배선은 `attnBroadcasts(hub)` 한 함수에서 파생한다.

### IPC-21 — /api/state 가 워크스페이스 blob 을 interface{} 로 해석했다 다시 인코딩하고, 오류는 버리며, 붙여 둔 ETag 는 조건부 요청에 쓰이지 않는다

`P3` · 성능 · S · LOW · - · 확인 · 묶음키 `api-state-raw`

- **위치**: `internal/webserver/httpapi/handlers_api.go:240-266`
- **근거**: json.Unmarshal(rawWS, &ws) 의 반환을 버리고 map 트리를 만든 뒤 Encode 한다. 이 종단은 부팅·재연결·모든 workspace_changed·_fgRestore 에서 불린다(IPC-6). ETag 를 붙이지만 If-None-Match 를 보지 않는다.
- **개선안**: 응답 구조체를 `struct{Tools []ToolInfo; ToolsKnown bool; Workspace json.RawMessage}` 로 두고(빈 값이면 `null`), 해석과 재직렬화를 없앤다. 필요하면 If-None-Match==rev 일 때 워크스페이스를 생략하는 옵션을 검토한다(tools 는 매번 필요).
- **이전 감사**: AUDIT-go-http.md P-6, M-9 (PERFORMANCE_HARDENING_SRS 비목표 3 으로 이월)

### IPC-27 — SanitizeActivityField 가 바이트 길이로 잘라서 UTF-8 글자를 중간에서 끊는다

`P3` · 결함 · S · LOW · B · 확인 · 묶음키 `hub-minor-fixes`

- **위치**: `internal/webserver/hub/activity.go:28-39`
- **근거**: `if len(s) > max { s = s[:max] }` 이다. 한글 detail(3바이트/글자)이 512 경계에 걸리면 깨진 바이트가 남고, json.Marshal 이 U+FFFD 로 바꿔 카드에 □ 가 보인다.
- **개선안**: max 이하의 마지막 rune 경계까지 되돌려 자른다(utf8.RuneStart 로 뒤에서 탐색). 테스트로 멀티바이트 경계를 고정한다.
- **이전 감사**: AUDIT-go-http.md M-8(같은 부류, clipLine)

### IPC-31 — TimerHub 가 _arm 마다 전체 스캔하는 _reschedule 을 불러서 tick 한 번이 O(n²) 이 된다

`P3` · 성능 · S · LOW · - · 확인 · 묶음키 `timerhub-resched`

- **위치**: `web/js/core/timer-hub.js:84-90`, `web/js/core/timer-hub.js:312-321`, `web/js/core/timer-hub.js:342-359`
- **근거**: _tick 은 마감 지난 job 마다 _fire→_arm→_reschedule(모든 _jobs+_ones 스캔)을 부르고, finally 에서 한 번 더 부른다. _ones 에는 after 가 아닌 defer·frame·sleep 기록도 함께 있어서 매 스캔에 섞인다(터미널 출력 flush 마다 defer 가 1건씩 들어간다).
- **개선안**: _tick 동안에는 _reschedule 을 미루는 플래그(_inTick)를 두고 끝에서 한 번만 계산한다. after 를 별도 Map(_afters)으로 두어 스캔 대상을 줄인다. 관측 가능한 동작은 같다.

### IPC-32 — hub/SSE 쪽 잔손질: BroadcastAndAwait 의 time.After 누수, 명령마다 payload 전문 Info 로그

`P3` · 하드코딩 · S · LOW · - · 확인 · 묶음키 `hub-minor-fixes`

- **위치**: `internal/webserver/hub/commands.go:187-193`, `internal/webserver/httpapi/commands.go:270-276`
- **근거**: BroadcastAndAwait 가 `case <-time.After(timeout)` 를 써서, 응답이 먼저 와도 타이머가 시한(기본 3s)까지 남는다. 같은 저장소가 GO-35 에서 client.go 의 같은 패턴을 NewTimer+Stop 으로 고친 기록이 있다. 비생성 명령은 payload 전문을 Info 로 남겨서, 원격 명령 인자(URL 등)가 로그에 전량 실린다.
- **개선안**: time.NewTimer+defer Stop 으로 바꾼다. payload 로그는 Debug 로 내리거나 action·location·delivered 만 남긴다.

### SHR-10 — dmctl 공용 HTTP 클라이언트가 10초를 잡아, 서버가 없을 때 fire-and-forget 훅이 에이전트 턴마다 최대 10초를 멈춘다

`P3` · 성능 · S · LOW · B · 확인 · 묶음키 `hook-report-path`

- **위치**: `internal/helper/runtimebin/http.go:45`, `internal/helper/runtimebin/dmctl_activity.go:86`, `internal/helper/runtimebin/dmctl_activity.go:147`, `internal/helper/runtimebin/dmctl_agentcontext.go:97`, `internal/helper/runtimebin/dmctl_notify.go:41`
- **근거**: 훅 계열 호출은 httpPostJSON(예산 0 → 공용 10초 클라이언트)을 쓰고 응답을 버린다. clientWithin 이 이미 있는데도 훅용 예산이 정해져 있지 않다.
- **개선안**: hookBudget 상수(예: 2s)를 두고 훅 계열 호출이 httpPostJSONWithin 을 쓰게 한다. 근거는 '서버가 없을 때'가 아니라 '서버가 받아 놓고 멈췄을 때(데드락·GC 정지·과부하)'다.
- **이전 감사**: AUDIT-go-infra P4

### SHR-27 — Restore 는 레지스트리 쓰기 락을 쥔 채 셸과 PTY 를 띄우고, 부팅 복원은 도구 수만큼 직렬로 돈다

`P3` · 성능 · M · MEDIUM · - · 확인 · 묶음키 `toolhub-restore-unlock`

- **위치**: `internal/shared/toolhub/manager_create.go:221`, `internal/shared/toolhub/persist.go:132`
- **근거**: Create 는 'fork/exec + PTY open 은 잠금 밖의 일이다'라며 pending 예약으로 락 밖에서 띄우는데, Restore 는 `m.mu.Lock(); defer Unlock()` 안에서 startTool 을 부른다. LoadAllWith 는 참조된 도구를 하나씩 차례로 Restore 한다. 그동안 Get/List/IsLive 가 모두 기다리고, 부팅 시간은 도구 수 × 셸 기동 시간이 된다. Restore 는 ToolCap 도 세지 않는다.
- **개선안**: Restore 도 Create 처럼 pending 예약 → 락 밖 기동 → 등록 순서를 따르게 한다(이미 끝난 프로세스 재처리 포함). LoadAllWith 는 제한된 병렬(예: 4)로 복원한다.

### SHR-28 — ActivitySnapshot 은 working 도구마다 busy 검사를 따로 해 darwin 에서 pgrep 을 N번 fork 한다

`P3` · 성능 · S · LOW · - · 확인 · 묶음키 `cwd-batch`

- **위치**: `internal/shared/toolhub/manager_notify.go:104`, `internal/shared/platform/procinfo.go:100`
- **근거**: ActivitySnapshot 은 working 상태 항목마다 attnBusyProbe → IsBusy → HasChildren(darwin `pgrep -P pid`)을 부른다. CWDs·Names 는 같은 이유로 이미 일괄 조회가 된다(NFR-XP-4, FR-PRF-76). 이 경로에만 일괄이 없다.
- **개선안**: ProcInfo 에 `ChildrenOf(pids []int) map[int]bool`(darwin: `ps -A -o ppid=` 한 번, linux: /proc 한 번 훑기)을 더하고 ActivitySnapshot 이 그것을 한 번 부른다.

### SHR-29 — claude stream_event 는 토큰 델타마다 JSON 을 두 번 푼다

`P3` · 성능 · S · LOW · - · 확인 · 묶음키 `agentadapter-decode-perf`

- **위치**: `internal/shared/agentadapter/claude_decode.go:19`, `internal/shared/agentadapter/claude_decode.go:174`, `internal/shared/agentadapter/claude_proto.go:264`
- **근거**: claudeDecode 는 한 줄을 26개 필드의 합집합 claudeFrame 으로 풀고(Event 는 RawMessage 로 보존), claudeDecodeStream 이 fr.Event 를 중첩 포인터 구조체로 다시 푼다. `--include-partial-messages` 라서 content_block_delta 가 토큰마다 오므로 가장 잦은 프레임에서 이중 파싱과 할당이 일어난다.
- **개선안**: 먼저 벤치마크로 비용을 잰다. 제안된 '얇은 헤더 → event' 방식도 두 번 스캔하므로 이득은 claudeFrame 의 나머지 필드 디코딩 생략뿐이다. 이득이 측정되지 않으면 하지 않는다.

### SHR-31 — dmctl list-workspace 가 bool 설정 하나 때문에 /api/settings 전체를 한 번 더 부른다

`P3` · 통신 · S · LOW · - · 확인 · 묶음키 `dmctl-listworkspace-one-trip`

- **위치**: `internal/helper/runtimebin/dmctl_listworkspace.go:59`, `internal/helper/runtimebin/dmctl_listworkspace.go:290`, `internal/helper/runtimebin/dmctl_listworkspace.go:281`, `internal/shared/toolhub/manager.go:149`
- **근거**: fetchListWorkspaceRows 가 /api/state 를 받은 뒤, 자동 이름 탭이 있으면 fgTabNamesEnabled 가 /api/settings 전체를 받아 fgTabNames 하나만 읽는다. 명령 한 번에 왕복이 2번이다. defaultTabName="Shell" 은 toolhub.defaultToolName 과 같은 값을 따로 선언한 것이다.
- **개선안**: /api/state 응답에 표시용 이름을 서버에서 계산해 싣거나(fgTabNames 적용 결과), 적어도 fgTabNames 를 state 에 함께 싣는다. 탭 기본 이름은 toolhub 상수를 공개해 함께 쓴다.

### SHR-32 — 기동 실패 안내용 tail() 이 로그 전체(최대 64MB)를 읽어 20줄을 뽑는다

`P3` · 성능 · S · LOW · - · 확인 · 묶음키 `tail-read-helper`

- **위치**: `internal/ctl/cli/proc.go:212`, `internal/ctl/cli/start.go:221`, `internal/ctl/cli/verify_run.go:129`, `internal/ctl/cli/logcap.go:18`
- **근거**: tail 은 os.ReadFile 로 파일 전체를 읽고 Split 한다. 로그 상한은 LogMaxBytes=64MB 다. transcriptUsage 에는 이미 꼬리만 ReadAt 하는 패턴이 있다.
- **개선안**: 끝에서 최대 64KB 만 ReadAt 해 n 줄을 자르는 tailFile 로 바꾼다. 같은 헬퍼를 dmctl 의 전사본 꼬리 읽기(SHR-9)와 함께 쓸 수 있다.

## O9 — Go 구조 리팩토링 (중복·추상화·분할) (12건)

### HTTP-13 — attention/activity 종단마다 direct/daemon 이중 분기와 인터페이스 단언이 반복된다

`P2` · 추상화 · M · MEDIUM · - · 확인 · 묶음키 `attention-service`

- **위치**: `internal/webserver/httpapi/handlers_attention.go:21-27`, `internal/webserver/httpapi/handlers_attention.go:55-62`, `internal/webserver/httpapi/handlers_attention.go:90-101`, `internal/webserver/httpapi/handlers_attention.go:111-115`, `internal/webserver/httpapi/handlers_attention.go:125-131`, `internal/webserver/httpapi/handlers_attention.go:209-228`, `internal/webserver/httpapi/deps.go:118`
- **근거**: 여덟 종단이 모두 `if s.AttnTracker != nil {...} else if tool := s.Tools.Get(id); tool != nil {...}` 또는 `s.Tools.(interface{ AttentionIDs() []string })` 단언으로 모드를 가른다. Deps.AttnTracker 는 구체 *hub.AttnTracker 이고, nil 이면 direct 모드라는 암묵 규약이다. 새 신호를 하나 더하면 두 갈래를 모두 고쳐야 한다.
- **개선안**: Deps 에 AttentionService 인터페이스(AttentionIDs, Signal, Attend(typed), ClearAll, ActivitySnapshot, SetActivity, NoteUserPrompt, SignalAgentEvent, Forget)를 둔다. 구현은 hub.AttnTracker 와 seam/adapters 의 ToolManager 어댑터 둘이다. 합성 루트(buildDeps/buildDepsWithHub)가 하나를 고르고, 핸들러는 분기 없이 한 줄씩 부른다.

### SHR-13 — 세 프로토콜 어댑터의 요청 id 발급·대기표·턴 경계 로직이 복제돼 있다

`P2` · 중복 · S · LOW · - · 확인 · 묶음키 `agentadapter-proto-common`

- **위치**: `internal/shared/agentadapter/claude_proto.go:78`, `internal/shared/agentadapter/claude_proto.go:87`, `internal/shared/agentadapter/codex_proto.go:61`, `internal/shared/agentadapter/codex_proto.go:71`, `internal/shared/agentadapter/omp_proto.go:50`, `internal/shared/agentadapter/omp_proto.go:59`, `internal/shared/agentadapter/claude_decode.go:131`, `internal/shared/agentadapter/claude_decode.go:180`, `internal/shared/agentadapter/codex_decode.go:168`
- **근거**: claudeExt·codexExt·ompExt 가 모두 `seq int` 와 똑같은 `nextID(){ x.seq++; return "dm-"+strconv.Itoa(x.seq) }` 를 가진다. xxxExtOf 의 'st.Ext 타입 단언 → 없으면 map 초기화 후 저장' 도 세 벌이다. '턴 시작 edge'(`if !x.inTurn { x.inTurn=true; emit EvTurnStart }`)는 claude 에 두 곳, codex 에 한 곳, omp(inAgent)에 한 곳 있다.
- **개선안**: `reqSeq`(seq+nextID), 제네릭 `extOf[T any](st *ProtoState, mk func() *T) *T`, `turnEdge`(`start() (Event, bool)`, `end()`)를 proto.go 에 두고 세 Ext 에 내장한다. 디코더 스키마는 그대로 두고 상태 관리만 모은다. 공통 접두 "dm-" 도 상수로 뺀다.

### SHR-15 — dmctl 인자 파서가 네 벌로 손으로 짜여 있고, 세 번째 bool 반환값의 뜻이 파서마다 반대다

`P2` · 중복 · M · MEDIUM · B · 확인 · 묶음키 `dmctl-cli-common`

- **위치**: `internal/helper/runtimebin/dmctl_listworkspace.go:25`, `internal/helper/runtimebin/dmctl_status.go:81`, `internal/helper/runtimebin/dmctl_run.go:187`, `internal/helper/runtimebin/dmctl.go:363`
- **근거**: parseRunFlags 는 표 기반(`map[string]*string`)으로 `--k v` 와 `--k=v` 를 모두 받는다. parseStatusFlags 는 take 클로저와 HasPrefix 분기를 손으로 짰다. parseListWorkspaceFlags 는 `--window=` 형태를 받지 않는다. 반환 규약도 갈린다: listworkspace 는 (f, code, true) 가 '여기서 끝내라'이고, status·run 은 (f, code, true) 가 '계속하라'다.
- **개선안**: runtimebin 에 작은 `argSpec{strs map[string]*string; bools map[string]*bool; help string}` 파서 하나를 두고 네 명령이 함께 쓴다. `--k v`·`--k=v`·-h 처리와 오류 문구를 통일하고, 반환은 `(code int, proceed bool)` 로 이름 붙인 한 규약으로 맞춘다.

### DOM-32 — jobs.finish(102줄)가 결말 분류·기록·훅·공개를 한 몸에 들고 있다

`P3` · 크기 · S · LOW · - · 확인 · 묶음키 `jobs-finish-split`

- **위치**: `internal/webserver/domain/git/jobs/job_run.go:75`
- **근거**: shutdown·canceled·timeout·exit 분류와 원격 auth·rejected 판정, RecordWrite/RecordUnguarded, index.lock 판정, onDone·finish 훅, 공개·구독 종료가 한 함수에 있다.
- **개선안**: classifyOutcome(final Job, canceled, shutdown, runErr, exit, tail) Job 을 순수 함수로 떼어 테이블 테스트한다. 기록은 recordFinal 로 뗀다.

### HTTP-14 — 성공 JSON 응답 작성기가 세 벌(writeJSON·fsJSON·gitJSON)이고 인라인이 40곳 넘는다

`P3` · 중복 · M · LOW · - · 확인 · 묶음키 `json-writer`

- **위치**: `internal/webserver/httpapi/handlers_toolio.go:258-261`, `internal/webserver/httpapi/handlers_fs.go:64-68`, `internal/webserver/gitapi/handlers_git.go:45-49`, `internal/webserver/httpapi/handlers_api.go:254-262`, `internal/webserver/httpapi/handlers_attention.go:28`, `internal/webserver/httpapi/handlers_lsp.go:233-238`
- **근거**: `w.Header().Set("Content-Type","application/json"); json.NewEncoder(w).Encode(x)` 가 httpapi·gitapi 19개 파일에 43회 인라인으로 있다(handlers_api.go 9, handlers_attention.go 8, handlers_files.go 5). 상태 코드를 받는 것(fsJSON·gitJSON)과 받지 않는 것(writeJSON)이 섞여 있다. lspFail 은 writeToolIOError 를 거의 그대로 복제했다.
- **개선안**: httpreq 옆에 httpresp.JSON(w, status, v) 하나를 두고, fsJSON·gitJSON·writeJSON 을 그것의 얇은 별칭으로 만든다. 인라인 43곳을 치환한다. 오류 방언 렌더러는 그대로 둔다. lspFail 은 writeToolIOError 에 code 인자를 받는 갈래(writeToolIOErrorCode)로 흡수한다.
- **결정 충돌**: architecture.md '오류 응답 — 방언 넷, 통일하지 않는다' 는 오류 본문에 대한 결정이다. 이 제안은 성공 응답 작성과 헤더 조립만 모으고 오류 본문 모양은 바꾸지 않는다.

### HTTP-23 — buildCommonDeps(123줄)와 buildDeps/buildDepsWithHub 의 중복 조립

`P3` · 크기 · M · LOW · - · 확인 · 묶음키 `composition-root-split`

- **위치**: `cmd/dongminal/main.go:298-420`, `cmd/dongminal/main.go:217-293`, `cmd/dongminal/main.go:305-312`
- **근거**: buildCommonDeps 한 함수가 workspace·run·git·worktree 둘·sysstat·ext·LSP·진단 방송 payload 까지 조립한다. toolHub.(*toolhub.ToolManager) 단언을 같은 분기에서 두 번 한다. 샌드박스 고아 회수(`Reap(liveWindowUUIDs(bd.wsMgr.Windows()))`)는 두 모드 함수에 따로 있다.
- **개선안**: newGitDeps(cfg, gitRoot)·newLSPDeps(cfg, cmdHub)·newRunDeps(cfg, toolHub) 로 가르고, 단언은 한 번 받아 쓴다. 회수는 공통 후처리 함수 하나로 모으고, lsp_diagnostics payload 는 hub 로 옮긴다(HTTP-15).

### HTTP-24 — Run 오케스트레이션 표면(10파일·2,485줄)이 httpapi.Server 에 섞여 있다

`P3` · 추상화 · L · MEDIUM · - · 확인 · 묶음키 `httpapi-subsurface-split`

- **위치**: `internal/webserver/httpapi/handlers_runs.go:1`, `internal/webserver/httpapi/handlers_runs_context.go:1`, `internal/webserver/httpapi/handlers_runs_headless.go:1`, `internal/webserver/httpapi/handlers_runs_worktree.go:1`, `internal/webserver/httpapi/handlers_api.go:96-116`
- **근거**: handlers_runs*.go 10개 비테스트 파일, 합계 2,485줄이 *Server 메서드로 붙어 있다. gitapi 는 같은 이유(표면이 크고 자기 라우트 표를 소유)로 GitServer 가 됐지만, runs 는 apiRoutes 에 섞여 있다. 그 결과 httpapi 는 fs·files·tools·runs·sandbox·access·lsp 를 한 패키지에서 다루게 됐다.
- **개선안**: gitapi 와 같은 모양으로 runapi.RunServer{Runs, Tools, Work, Commands, Worktrees, WhoAmI, Settings} 를 만들고, 라우트 표를 스스로 소유하게 한 뒤 handleAPI 에서 git 처럼 위임한다. 1단계는 파일 이동과 수신자 교체만 하고, 행위는 바꾸지 않는다(커버리지 기반 검증).

### IPC-19 — 커맨드 action 표 셋(허용·생성·단일실행자)을 손으로 맞춰야 하고, 허용 표는 export 된 가변 맵이다

`P3` · 추상화 · S · LOW · - · 확인 · 묶음키 `cmd-action-table`

- **위치**: `internal/webserver/hub/commands.go:95-156`, `internal/webserver/hub/commands.go:315-340`, `internal/webserver/httpapi/commands.go:200`
- **근거**: creatingActions ⊂ singleExecutorActions ⊂ AllowedCmdActions 관계가 코드로 강제되지 않는다. 새 action 을 허용 표에만 넣으면 게이팅 없이 모든 브라우저에서 실행된다(FR-SXE 결함 부류). AllowedCmdActions 는 export 된 var 라 어디서든 바꿀 수 있고, httpapi 는 메서드(AllowedAction)가 아니라 맵에 직접 접근한다.
- **개선안**: `var cmdActions = map[string]cmdSpec{"newWindow":{creating:true, single:true}, "renameTab":{}, …}` 하나로 합치고, IsAllowed/IsCreating/IsSingleExecutor 를 여기서 파생한다. 맵은 unexport 한다. 단위 검사로 creating⇒single 불변식을 고정한다.

### SHR-16 — dmctl 의 HTTP 결과→종료 코드 변환이 여러 벌이고 dmctlSend 는 dmctlPost 의 복사본이다

`P3` · 중복 · S · LOW · B · 확인 · 묶음키 `dmctl-cli-common`

- **위치**: `internal/helper/runtimebin/dmctl.go:465`, `internal/helper/runtimebin/dmctl.go:484`, `internal/helper/runtimebin/dmctl.go:525`, `internal/helper/runtimebin/dmctl_run_http.go:57`, `internal/helper/runtimebin/dmctl_status.go:305`, `internal/helper/runtimebin/dmctl_listworkspace.go:59`, `internal/helper/runtimebin/detach.go:210`
- **근거**: dmctlHTTPResult(FR-DRC-11 로 세 벌을 하나로 합친 결과), runResult, statusGet 이 같은 일(err→1, 비2xx→stderr 출력 후 1)을 서로 다른 문구로 한다. fetchListWorkspaceRows·detachList·whoami·toolio 는 이 셋을 쓰지 않고 인라인으로 다시 짰다. dmctlSend 의 몸통(url·body·httpPostJSON·HTTPResult·Delivery)은 dmctlPost 와 한 줄도 다르지 않다.
- **개선안**: dmctlPost 의 args 타입을 any 로 넓히거나 내부 dmctlPostRaw(action string, args any, …) 를 둔다. dmctlSend 는 JSON 을 파싱한 뒤 그것을 부른다. 공통 dmctlCall 통합은 그다음에 한다.

### SHR-18 — '셸이 프롬프트를 그리고 조용해질 때까지 기다린다'가 세 벌이고, doctor 도구 검사만 고정 3초 sleep 을 쓴다

`P3` · 중복 · S · LOW · B · 확인 · 묶음키 `ctl-shell-ready-wait`

- **위치**: `internal/ctl/cli/doctor.go:413`, `internal/ctl/cli/doctor.go:40`, `internal/ctl/cli/doctor_probe.go:147`, `internal/ctl/cli/verify.go:42`, `internal/ctl/cli/verify.go:382`
- **근거**: verify 는 waitToolQuiet(verifyShellWait, verifyShellQuiet=700ms)를 쓰고, doctor_probe 는 자기 루프(doctorReadyWait, doctorQuietFor=700ms)를 쓴다. 두 상수는 값과 주석이 같다. doctor 의 도구 왕복 검사(doctor.go:413)는 이것들을 쓰지 않고 `time.Sleep(3 * time.Second)` 로 무조건 기다려서, 셸이 0.3초에 떠도 매번 3초가 든다.
- **개선안**: `waitQuiet(snapshot func() (n int, lastChange time.Time), limit, quiet time.Duration) error` 하나를 ctl/cli 에 두고 세 자리가 함께 쓴다. 상수는 `shellReadyWait`·`shellQuietFor` 한 쌍으로 합친다. doctor.go:413 의 고정 sleep 은 이것으로 바꾼다.

### SHR-24 — 빈 몸체 훅 두 개 — AgentTurn.NoteAttendTyped 와 workspace.InvalidateTool 이 아무 일도 하지 않는데 배선돼 있다

`P3` · 복잡도 · S · LOW · - · 확인 · 묶음키 `toolhub-dead-hooks`

- **위치**: `internal/shared/toolhub/agentturn.go:88`, `internal/shared/toolhub/tool_attention.go:133`, `internal/shared/workspace/manager.go:315`, `cmd/dongminal/main.go:238`, `internal/shared/toolhub/manager_create.go:175`
- **근거**: NoteAttendTyped 는 `{}` 이고 19줄 주석이 왜 비었는지 설명한다(FR-ATN-16a). AttendTyped 는 여전히 이것을 부른다. workspace.InvalidateTool 은 `_ = toolID` 뿐인데, main.go 가 SetInvalidator 로 걸고 toolExited 가 매번 부른다.
- **개선안**: 결정 근거(FR-ATN-16a)는 AttendTyped 의 주석으로 옮기고 NoteAttendTyped 는 지운다. InvalidateTool 도 지우고 SetInvalidator 배선을 없애거나, 실제로 쓰일 곳(workspace 가 dangling 을 알아야 할 때)이 생길 때 다시 단다.

### SHR-26 — StartTool(92줄)이 환경 조립·시작 디렉터리 판정·PTY 기동·훅 배선을 한 함수에서 한다

`P3` · 크기 · S · LOW · - · 확인 · 묶음키 `toolhub-starttool-split`

- **위치**: `internal/shared/toolhub/tool.go:243`
- **근거**: StartTool 은 셸 선택, env 여섯 갈래(TERM/PATH/HOME/도구 id/브라우저/USER/셸 env/히스토리/extraEnv/os.Environ) 조립, cwd 검사, ProcSpec 구성, PTY 시작, Tool 구성, relay·hooks 복사(NewDetachedTool 과 같은 코드), cwd 기록, 고루틴 기동을 차례로 한다. hooks 복사 블록(316-322)은 NewDetachedTool(187-192)과 거의 같다.
- **개선안**: `toolEnv(id, shell, binDir, extra) []string`, `startDir(cwd) string`, `(p *Tool) applyHooks(h *ToolHooks)` 로 나눈다. applyHooks 는 NewDetachedTool 과 함께 쓴다. 동작은 바꾸지 않고 옮기기만 한다.

## O10 — Go 상수 분리·하드코딩 제거 (7건)

### SHR-14 — 활동 상태 어휘(working/waiting/done/idle/ended)가 20곳 넘게 문자열 리터럴로 흩어져 있다

`P2` · 상수 · M · LOW · - · 확인 · 묶음키 `activity-vocab-const`

- **위치**: `internal/shared/agentadapter/proto.go:455`, `internal/shared/agentadapter/claude.go:94`, `internal/shared/agentadapter/omp.go:99`, `internal/shared/toolhub/agentturn.go:47`, `internal/shared/toolhub/agentturn.go:122`, `internal/shared/toolhub/tool_attention.go:202`, `internal/shared/toolhub/tool_attention.go:231`, `internal/shared/toolhub/manager_notify.go:106`, `internal/webserver/domain/run/vocabulary.go:49`
- **근거**: Report.State 주석은 값이 '서버의 활동 상태 어휘를 그대로 쓴다'고 하고, Event.Activity 주석은 '어휘는 훅 표면의 것과 한 글자도 다르지 않다'고 한다. 그런데 그 어휘를 담은 상수가 없다. shared 영역에만 "working" 리터럴이 14곳이고, webserver 에도 hub/attn_tracker 3곳, run/vocabulary 1곳이 따로 있다. 오타가 나도 컴파일러가 잡지 못한다.
- **개선안**: shared 에 `activity` 패키지(또는 agentadapter 안의 타입 `ActivityState string` + 상수 5개)를 두고, 어댑터 파서·AgentTurn·Tool·ActivitySnapshot·웹서버 AttnTracker 가 모두 그것을 쓴다. run.MemberState 는 이 상수에서 파생한다.

### DOM-30 — 같은 대상의 상한·기본값이 따로 정의돼 어긋난다

`P3` · 상수 · S · LOW · B · 확인 · 묶음키 `domain-constants`

- **위치**: `internal/webserver/domain/lsp/manager.go:24`, `internal/webserver/domain/lsp/session.go:176`, `internal/webserver/domain/run/context_window.go:27`, `internal/webserver/domain/run/store_context.go:45`, `internal/webserver/domain/lsp/service.go:248`
- **근거**: LSP 요청 텍스트 상한은 MaxTextBytes=8MiB 인데 resync 상한은 ResyncMaxBytes=10MiB 다. 8~10MiB 파일은 디스크 판이 resync 로 전송되지만 요청은 거절된다. 200000 이 contextWindows 와 DefaultContextPolicy.LimitTokens 에 두 번 적혀 있다. exeKey 의 "default" 는 이름 없는 리터럴이다.
- **개선안**: LSP 문서 상한을 상수 하나(MaxDocBytes)로 두고 두 곳이 참조한다. DefaultWindowTokens = contextWindows[0] 으로 파생한다. defaultExeKey 상수를 둔다.

### HTTP-21 — 상태 코드 숫자 리터럴과 반복 Query() 파싱 (핸들러 가독성)

`P3` · 하드코딩 · S · LOW · - · 확인 · 묶음키 `handler-readability`

- **위치**: `internal/webserver/httpapi/handlers_api.go:237`, `internal/webserver/httpapi/handlers_api.go:242`, `internal/webserver/httpapi/handlers_api.go:269`, `internal/webserver/httpapi/handlers_api.go:346`, `internal/webserver/httpapi/handlers_api.go:366`, `internal/webserver/httpapi/handlers_api.go:413`, `internal/webserver/httpapi/handlers_api.go:500`, `internal/webserver/httpapi/handlers_api.go:518`, `internal/webserver/httpapi/handlers_api.go:536`, `internal/webserver/httpapi/access.go:614`, `internal/webserver/httpapi/handlers_settings.go:125`, `internal/webserver/httpapi/handlers_api.go:273-303`
- **근거**: 404·500·503·200·204 숫자가 http.Status* 와 섞여 쓰인다. apiToolsCreate 는 r.URL.Query() 를 6번 다시 파싱하고, cwd(cwdTool 폴백)와 explicit cwd 를 두 번 읽어 구분한다. server.go:344-345 의 ReadHeaderTimeout 10s·IdleTimeout 120s 는 이름 없는 인라인 값이다.
- **개선안**: http.Status* 로 기계적으로 치환한다. apiToolsCreate 머리에서 q := r.URL.Query() 를 한 번 잡고 cwd / explicitCwd 로 이름을 가른다. 서버 타임아웃 두 값은 ShutdownGrace 옆 명명 상수로 올린다.
- **이전 감사**: AUDIT-go-http L-7 · L-8

### HTTP-22 — 홈 파일·디렉터리 이름과 환경변수·서브커맨드가 조립 코드에 문자열로 흩어져 있다

`P3` · 상수 · M · LOW · - · 확인 · 묶음키 `home-layout-consts`

- **위치**: `internal/webserver/httpapi/server.go:176-200`, `internal/webserver/httpapi/server.go:231-234`, `cmd/dongminal/main.go:131-136`, `cmd/dongminal/main.go:300`, `cmd/dongminal/main.go:342`, `cmd/dongminal/main.go:348`, `cmd/dongminal/main.go:365`, `cmd/dongminal/main.go:371`, `cmd/dongminal/main.go:437`, `internal/webserver/httpapi/handlers_workspace_revert.go:29`
- **근거**: "settings.json"·"access.json"·"workspace.json"·"lsp-paths.json"·"daemon.log"·"worktrees"·"git-worktrees"·"notes"·"ext" 가 리터럴이다. 같은 이름이 ctl/cli/homelayout.go(:59-78) 등록부, rollback.go, migrate/apply.go, daemon/boot 에 또 있다. startDaemon 은 dmenv.EnvHome 대신 "DONGMINAL_HOME=" 을 직접 쓴다. 데몬 서브커맨드 "d" 는 startDaemon 과 main 에 따로 적혀 있다. server.New 는 `if cfg.DataDir != "" { filepath.Join(...) }` 패턴을 네 번 반복한다.
- **개선안**: shared 에 homefiles(또는 dmenv 확장) 상수 한 벌(SettingsFile, AccessFile, WorkspaceFile, LSPPathsFile, DaemonLog, WorktreesDir, …)을 두고, homelayout 등록부도 그것을 참조하게 한다. server.New 에는 dataPath(cfg, name) 헬퍼를 둔다. 데몬 서브커맨드는 상수 하나로, 환경은 dmenv.EnvHome+"=" 으로 조립한다.

### SHR-17 — ping·조회 시한과 폴링 간격이 ctl/cli 곳곳에 리터럴과 중복 상수로 흩어져 있다

`P3` · 하드코딩 · S · LOW · B · 확인 · 묶음키 `ctl-timeouts-const`

- **위치**: `internal/ctl/cli/start.go:369`, `internal/ctl/cli/migrate.go:47`, `internal/ctl/cli/doctor.go:332`, `internal/ctl/cli/doctor.go:343`, `internal/ctl/cli/doctor.go:431`, `internal/ctl/cli/doctor_probe.go:154`, `internal/ctl/cli/doctor_probe.go:234`, `internal/ctl/cli/health.go:15`, `internal/ctl/cli/health_wait.go:26`, `internal/ctl/cli/window.go:16`, `internal/helper/runtimebin/dmctl_run_http.go:18`, `internal/helper/runtimebin/dmctl_status.go:293`, `internal/shared/sandbox/helper_real.go:36`
- **근거**: 로컬 /api/ping 시한이 1s(start.go:369 리터럴)·2s(migrate.go:47 리터럴, windowPingTimeout, healthTimeout, daemonProbeTimeout)·3s(healthPingTimeout, doctor.go:332·343 리터럴)로 갈린다. doctor 의 폴링 간격 100ms/200ms 도 리터럴이다. runtimebin 에는 같은 뜻의 `runClientSlack=10s` 와 `waitClientSlack=10s` 가 따로 있다. sandbox 헬퍼 다운로드 클라이언트도 `5*time.Minute` 리터럴이다.
- **개선안**: ctl/cli 에 `localPingTimeout`·`localProbePoll` 두 상수를 두고 모든 로컬 ping 이 그것을 쓴다. runtimebin 은 `clientSlack` 하나로 합친다. sandbox 다운로드 시한은 이름 있는 상수로 뺀다.

### SHR-19 — 홈 하위 상태 파일 이름이 여러 패키지에 리터럴·중복 상수로 남아 있다

`P3` · 하드코딩 · S · LOW · - · 확인 · 묶음키 `home-filenames-const`

- **위치**: `internal/shared/toolhub/persist.go:101`, `internal/shared/toolhub/persist.go:119`, `internal/ctl/cli/proc.go:20`, `internal/ctl/migrate/apply.go:20`, `internal/ctl/cli/rollback.go:42`, `internal/ctl/cli/homelayout.go:59`
- **근거**: "tools.json" 은 persist.go 에 두 번 리터럴로 있고, migrate/apply.go 의 toolsFile 상수와 homelayout 리터럴까지 합쳐 네 벌이다. "workspace.json" 은 migrate(workspaceFile)·httpapi(workspaceFile)·rollback·homelayout·main.go·boot.go 에 있다. "paned.pid" 는 cli/proc.go·migrate/apply.go·daemon/boot.go 에 있다. rollbackTargets 는 homeLayout 의 상태 파일을 손으로 다시 적은 목록이다.
- **개선안**: dmenv(또는 platform)에 `FileTools`·`FileWorkspace`·`FilePanedPID` 같은 이름 상수를 두고 모든 호출부가 그것을 쓴다. rollbackTargets 는 homeLayout 에서 `InBackup && !IsDir && 세대가 있는 상태 파일`로 파생한다.
- **이전 감사**: AUDIT-go-infra #6

### SHR-30 — envOr 가 두 패키지에 두 벌 있고, cli 의 PORT·DONGMINAL_LOG·Actions 가 단일 출처를 두고 따로 선언돼 있다

`P3` · 중복 · S · LOW · - · 확인 · 묶음키 `env-const-single-source`

- **위치**: `internal/helper/runtimebin/http.go:14`, `internal/shared/sandboxplace/wire.go:46`, `internal/ctl/cli/options.go:28`, `internal/ctl/cli/options.go:31`, `internal/ctl/cli/options.go:74`, `internal/ctl/cli/service.go:161`
- **근거**: envOr 몸체가 runtimebin 과 sandboxplace 에 똑같이 있다. options.go 는 EnvPort="PORT", EnvLog="DONGMINAL_LOG" 을 리터럴로 선언하고 service.go:161 은 "PORT" 를 다시 박는다. `var Actions` 는 테스트에서만 읽히고, 액션 목록의 출처는 actionsOf() 다.
- **개선안**: dmenv 에 `Or(key, fallback)` 와 EnvLog·EnvLegacyPort 상수를 두고 두 패키지가 쓴다. service.go 는 상수를 쓴다. Actions 는 actionsOf() 에서 파생하거나 지우고, 테스트는 actionsOf 를 돈다.
- **이전 감사**: AUDIT-go-infra #9, #10, #14

## O11 — FE core 리팩토링 (20건)

### FEC-17 — 받은 워크스페이스 정규화 파이프라인이 init 과 _applyRemoteWorkspace 에 두 벌 있고, 활성 창 폴백 식은 세 벌이다

`P2` · 중복 · M · MEDIUM · - · 확인 · 묶음키 `ws-normalize`

- **위치**: `web/js/core/app.js:175`, `web/js/core/app.js:208`, `web/js/core/app-cmd.js:355`, `web/js/core/app-cmd.js:385`, `web/js/core/app-cmd.js:418`, `web/js/core/app-cmd.js:436`
- **근거**: 두 경로가 같은 순서의 단계를 반복한다. clean+normalizeLayout 루프 → windows.filter(layout||isEditorWin) → _migrateGitWindow → _migrateEditorTabs 뒤 재필터 → 활성 창 폴백 → displayMode·mobileBreakpoint·sidebarWidth 삭제 → _edMigrateSideWidth. 위치는 init 쪽 app.js:175-209, 원격 채택 쪽 app-cmd.js:355-376·436-443 이다. 활성 창 폴백 식 (windows.find(s=>!isEditorWin(s))||windows[0])?.id||null 은 app.js:209, app-cmd.js:386, app-cmd.js:419 에 똑같이 있다.
- **개선안**: _normalizeIncomingWorkspace(sv,{live}) → {changed} 하나로 모으고 두 경로가 부르게 한다. 폴백은 _fallbackActiveWindow(windows) 로 뺀다. 한쪽에만 있는 단계(init 의 schema 마이그레이션 표시 등)는 옵션으로 둔다.

### FEC-18 — '활성 창 전환' 이 여전히 여러 자리에 흩어져 각자 다른 부분집합을 한다

`P2` · 추상화 · M · MEDIUM · B · 확인 · 묶음키 `active-window-unify`

- **위치**: `web/js/core/app-layout.js:349`, `web/js/core/app-layout.js:494`, `web/js/core/app-layout.js:575`, `web/js/core/app-cmd.js:750`, `web/js/core/app-docrender.js:167`, `web/js/core/app-attn.js:226`, `web/js/core/app-slots.js:504`
- **근거**: this.ws.activeWindow=… 와 try{sessionStorage.setItem('activeWindow',…)}catch{} 쌍이 16자리에 있다(grep 16건). 자리마다 cur.focusedPane 저장, _rememberReturn, ACTIVE_EDITOR_ROOT_KEY 갱신, _slotOnSwitch, _focusWindow, _gitRescheduleAll 중 서로 다른 부분집합을 한다. 예: addTab 의 run·editor 기존 탭 이동(app-layout.js:494-503, 575-586)은 ACTIVE_EDITOR_ROOT_KEY 와 _gitRescheduleAll 을 하지 않는다. switchWindow(app-layout.js:349-391)는 둘 다 한다.
- **개선안**: _activateWindow(id,{rememberFocus,claim,rescheduleGit}) 한 함수를 세워 16자리를 옮긴다. sessionStorage 쓰기와 에디터 루트 기억은 그 안에서만 한다. switchWindow 는 그 위에 드로어 닫기·모바일 인덱스만 얹는다.
- **이전 감사**: AUDIT-fe-core H4, M8

### FEC-19 — 기기·탭 저장소 접근이 리터럴 키와 빈 catch 로 흩어져 있다 — 빈 catch{} 75개의 대부분이 이것이다

`P2` · 추상화 · M · LOW · - · 확인 · 묶음키 `storage-keys`

- **위치**: `web/js/core/app-layout.js:163`, `web/js/core/app-focus.js:152`, `web/js/core/app.js:253`, `web/js/core/app.js:348`, `web/js/core/app-agents.js:56`, `web/js/core/app-slots.js:280`, `web/js/core/helpers.js:660`
- **근거**: core 의 localStorage·sessionStorage 호출 키 가운데 'activeWindow'(16), 'focusedPanes', 'agentsGroupFold', 'mobileBreakpoint', 'displayMode', 'attnSound', 'attnDesktop', 'dm.sbx.recent', 'agentsPanelOpen', 'lspServerPaths' 등은 리터럴이다. 같은 파일 안에서도 SLOT_KEY·THEME_VARS_KEY 같은 상수와 섞여 있다. core 의 빈 catch{} 는 75개이고 대부분 try{storage…}catch{} 다(app-layout.js 12, app-slots.js 11, app.js 9 …). 실패가 ErrorLog 에도 남지 않는다.
- **개선안**: constants.js 에 STORE_KEYS 표(키·영역 local|session·기본값)를 두고, DeviceStore.get/set/remove·TabStore.* 래퍼가 예외를 한 자리에서 삼키면서 ErrorLog.push('storage',…) 로 남긴다. JSON 값용 getJSON/setJSON 도 둔다. 호출부의 try/catch 를 걷어낸다.
- **이전 감사**: AUDIT-fe-core M5, M7

### FEC-21 — 레이아웃 트리 순회 3벌 + '탭 찾기' 7벌

`P2` · 중복 · M · LOW · - · 확인 · 묶음키 `layout-tree-helpers`

- **위치**: `web/js/core/helpers.js:816`, `web/js/core/app.js:94`, `web/js/core/app.js:290`, `web/js/core/app-layout.js:396`, `web/js/core/app-layout.js:427`, `web/js/core/app-layout.js:436`, `web/js/core/app-docrender.js:180`, `web/js/ui/runs-panel.js:283`, `web/js/core/app-cmd.js:722`, `web/js/core/app-cmd.js:736`
- **근거**: pane 목록을 만드는 함수가 셋이다. panesOf(helpers.js:816), App.flattenPanes(app.js:94), App._collectPanes(app.js:290)이고 호출처는 각각 7·23·8곳이다. 탭 탐색은 _findPreviewTab·findGitViewTab·_findRenderTab 이 flattenPanes 위에서 조건만 바꿔 쓰고, _findEditorTab(app-layout.js:436)·RunsPanel._findRunTab(runs-panel.js:283)은 같은 재귀 walk 를 손으로 다시 적었다. _findTabById(app-cmd.js:722)는 _collectPanes 를 쓴다. _focusLocation(app-cmd.js:736)은 _resolveLocation(:705)과 같은 정규식·인덱스 해석을 다시 한다.
- **개선안**: helpers 에 panesOf 하나만 남기고(flattenPanes·_collectPanes 는 위임 뒤 제거), findTabWhere(windows,pred)→{win,pane,tab} 를 세워 7개를 조건 한 줄로 바꾼다. _focusLocation 은 _resolveLocation 결과를 받아 _activateWindow(FEC-18)로 옮긴다.

### FEC-22 — addTab 160줄 · save 187줄 · init 154줄 · closeTab 149줄 — 분할 경계가 명확하다

`P2` · 크기 · M · MEDIUM · - · 확인 · 묶음키 `app-large-methods`

- **위치**: `web/js/core/app-layout.js:462`, `web/js/core/app-layout.js:623`, `web/js/core/app.js:463`, `web/js/core/app.js:136`
- **근거**: addTab 은 타입 네 가지(run·git·editor·terminal)를 if 블록으로 이어 쓴다. run 과 editor 의 '기존 탭으로 옮기기' 블록은 거의 같다(app-layout.js:494-503, 575-586). save() 는 409·428 처리(원격 git·editors·windows 채택)만 해도 약 100줄을 안쪽에 품는다(app.js:491-591). init 은 워크스페이스 정규화(FEC-17)·세션 복원·바인딩을 한 함수에서 한다.
- **개선안**: addTab 은 TAB_OPENERS={run,git,editor,terminal} 표로 나누고 공통 전처리(창 해석·창 타입 불변식)만 남긴다. save 는 _saveAdoptRemote(gr)·_saveFlushDeferred() 로 나눈다. init 은 _initAdoptWorkspace(st)·_initRestoreSession() 으로 나눈다.
- **이전 감사**: AUDIT-fe-core M3, M8

### FEC-23 — _execRemote 190줄 if(action===…) 사슬 — EventBus 가 이미 버린 형태

`P2` · 복잡도 · M · MEDIUM · - · 확인 · 묶음키 `app-large-methods`

- **위치**: `web/js/core/app-cmd.js:473`, `web/js/core/app-cmd.js:139`
- **근거**: _execRemote 는 focus·openUrl·openEditorTab·renameTab/renameWindow·newWindow·newTab·splitH/V·detachTab·restoreTool·closeWindow·closeTab 등을 순서대로 if 로 판정한다(app-cmd.js:473-662). 버스의 폴백으로 연결돼 있다(:139). EventBus 는 action→구독자 표로 바뀌었다(FR-BUS-4).
- **개선안**: REMOTE_ACTIONS={focus:(a)=>…, newTab:…} 표와 _execRemote(action,args){const h=REMOTE_ACTIONS[action]; …} 로 바꾸고, 큰 분기(newTab·split·closeWindow)는 각자 메서드로 뺀다. echo(_echoResult) 규약은 핸들러 반환값으로 통일한다.
- **이전 감사**: AUDIT-fe-core M2

### FEC-25 — 설정 기본값·범위가 SETTINGS_SCHEMA 와 상수 사이에 두 벌이고, 검증기가 네 개다

`P2` · 상수 · M · LOW · - · 확인 · 묶음키 `settings-schema-source`

- **위치**: `web/js/core/settings-schema.js:31`, `web/js/core/settings-schema.js:70`, `web/js/core/settings-schema.js:102`, `web/js/core/app-polling.js:30`, `web/js/core/app-polling.js:96`, `web/js/core/constants.js:128`, `web/js/core/constants.js:533`, `web/js/core/helpers.js:513`, `web/js/core/helpers.js:645`, `web/js/core/constants-git.js:100`, `web/js/core/constants-git-detect.js:25`
- **근거**: 스키마(단일 원천, FR-CFG-1)가 agentsPollInterval 5000·statsInterval 3000·gitStatusInterval 30000·gitReposInterval 3000·tabWidthPx 160/40/480·focusEdgeLevel·attnEdgeLevel 5/0/10 을 갖는다. 같은 값이 AGENTS_POLL_DEFAULT(constants.js:128), STATS_INTERVAL_DEFAULT(helpers.js:513), GIT_REPOS_POLL_MS(constants-git.js:100), GIT_STATUS_POLL_MS(constants-git-detect.js:25), TAB_WIDTH_DEFAULT/MIN/MAX(constants.js:533-535), UFE_LEVEL_*·ATTN_EDGE_LEVEL_*(constants.js:78-79, 109-110)에 다시 있다. 두 벌이 같은지 보는 게이트·테스트가 없다(grep 결과 0). 검증기도 settingValue·clampSetting(settings-schema.js)·pollValue(app-polling.js:96, POLL_SETTINGS.opts 에서 범위 파생)·clampTabWidth(helpers.js:645) 넷이다.
- **개선안**: 상수를 const AGENTS_POLL_DEFAULT=SETTINGS_BY_KEY.agentsPollInterval.def 처럼 스키마에서 파생한다(settings-schema.js 를 constants 앞으로 로드). clampTabWidth·pollValue 는 settingValue·clampSetting 위로 합친다. POLL_SETTINGS.opts 의 최소·최대가 스키마 min·max 와 같은지 단위 테스트를 둔다.

### FEC-27 — 손으로 짠 confirm-overlay 모달 골격 5벌 — UIKit.modal(FR-UIK-25)이 이미 같은 일을 한다

`P2` · 추상화 · M · MEDIUM · - · 확인 · 묶음키 `modal-unify`

- **위치**: `web/js/core/app-tool.js:23`, `web/js/core/app-tool.js:90`, `web/js/core/app-tool.js:234`, `web/js/core/app-tool.js:409`, `web/js/core/app-editor-file.js:158`, `web/js/ui/ui-kit.js:361`
- **근거**: 다섯 자리가 각자 같은 순서를 반복한다. overlay/box 생성, returnTo 포착, document keydown(Escape, 일부는 Enter) 등록과 해제, 바깥 클릭 닫기, UIKit.dialogOpen 호출과 해제, 한 번만 닫기 가드(done)다. UIKit.modal 은 닫는 길 셋을 onClose 하나로 모으고 목적 버튼 포커스·roving 을 갖추고 있다(ui-kit.js:361-455). 대신 머리(title)가 고정 구조라 confirm-msg 형태와 차이가 있다.
- **개선안**: UIKit.confirm({msg, actions:[{label,kind,value}], escValue, enterValue})→Promise<value> 를 UIKit.modal 위에 세우고 다섯 자리를 옮긴다. 머리 없는 변형은 modal({title:''}) 에 head 생략 옵션을 준다. CSS 클래스(.confirm-overlay)는 cls 로 유지해 e2e 선택자를 지킨다.
- **결정 충돌**: KIT_APPLICATION_SRS FR-KIT-24 는 골격마다 dialogOpen 을 부르는 방식으로 끝냈다. UIKit.modal 로 옮기는 것은 금지된 것이 아니라 다음 단계다.

### IPC-17 — _execRemote 가 약 190줄짜리 if-체인으로 남아 있다

`P2` · 크기 · M · MEDIUM · - · 확인 · 묶음키 `remote-action-table`

- **위치**: `web/js/core/app-cmd.js:473-662`
- **근거**: SSE 방송 중 구독자가 없는 action 이 모두 _fallback→_execRemote 로 온다. EventBus._onMessage 는 라우팅 테이블로 바뀌었지만(FR-BUS-4) 그 아래는 옛 형태 그대로여서, return 을 빠뜨리면 공통 경로로 떨어진다(FR-RUN-6b 사고 기록이 있음).
- **개선안**: REMOTE_ACTIONS 서술자 표({action, needsExec, run(args)})로 바꾸고, hub/commands.go 의 서버 쪽 action 표(IPC-19)와 이름 목록을 맞추는 계약 검사를 둔다.
- **이전 감사**: AUDIT-fe-core.md M2

### FEC-20 — index.html 선주입 스크립트의 키·범위가 상수와 손으로 동기화되고, 이를 지키는 게이트가 없다

`P3` · 하드코딩 · S · LOW · - · 확인 · 묶음키 `storage-keys`

- **위치**: `web/index.html:38`, `web/index.html:49`, `web/index.html:53`, `web/js/core/constants.js:257`
- **근거**: 첫 페인트 스크립트에 'sidebarWidth'·100·400·'sidebarCollapsed'(:38), 'dm.themeVars'·'dm.themeFollow'·'.dark'·'.light'(:49), 'dm.locale'·'en'/'ko'(:53)가 박혀 있다. 주석은 'constants.js 의 SIDEBAR_W_MIN_PX 등을 함께 고친다' 로 사람에게 맡긴다. scripts/ 에 이 대응을 검사하는 게이트가 없다(check-load-order·check-i18n-html 만 index.html 을 본다).
- **개선안**: 서버가 이미 __ASSETV__ 를 치환하므로 같은 방식으로 __SB_W_MIN__ 등을 constants 원천에서 주입한다. 또는 check-preinject 게이트를 세워 index.html 리터럴과 constants 값을 대조한다(규약 '두 곳이 같은가' 와 같은 꼴).
- **이전 감사**: AUDIT-fe-core M9
- **결정 충돌**: M6 FE-18 은 '100·400 은 여기서만 숫자로 남는다' 를 받아들였지만, 동기화를 지키는 장치는 정하지 않았다.

### FEC-24 — helpers.js 1,162줄·주제 11개, core 의 500줄 초과 파일 11개

`P3` · 크기 · L · MEDIUM · - · 확인 · 묶음키 `helpers-split`

- **위치**: `web/js/core/helpers.js:5`, `web/js/core/helpers.js:176`, `web/js/core/helpers.js:488`, `web/js/core/helpers.js:663`, `web/js/core/helpers.js:950`, `web/js/core/helpers.js:1053`, `docs/internal/FE_MODULE_BOUNDARY_SRS.md:356`
- **근거**: helpers.js 한 파일에 단축키 파싱, 경로, HTML 이스케이프, 테마 변수 계산(themeVarsOf 82줄), 단축키 기본표, 설정 전역 var 약 25개, 레이아웃 트리·병합(mergeUnseenLayout), 탭 이름, git 배지, visiblePoll, git status 헬퍼가 있다. 이전 감사 때 1,136 이던 것이 1,162 로 늘었다. check-file-size --list 기준 core 의 500줄 초과 파일은 helpers 1162, app-layout 998, app-git 895, app-slots 788, app-cmd 784, constants 743, app 685, constants-editor 677, app-lsp 666, app-tool 660, app-mobile 504 다.
- **개선안**: helpers.js 를 path.js · theme-vars.js · shortcuts.js · layout-tree.js(트리 순회·병합, FEC-21 과 함께) · settings-state.js(전역 var, FEC-25 와 함께) · git-status-helpers.js 로 나눈다. check-load-order 순서표를 갱신하고 check-file-size 기준선을 내린다.
- **이전 감사**: AUDIT-fe-core D3, D2
- **결정 충돌**: FE_MODULE_BOUNDARY_SRS §5 N4 가 'helpers.js 분할은 비목표(주제 하나)' 로 정했다. 현재 주제가 11개라 그 전제가 깨졌으므로 N4 개정 결정이 필요하다.

### FEC-28 — 상태줄 '저장 중/저장됨/오류' 관용구 4벌 + 오류 메시지 이어 붙이기 관용구 9벌

`P3` · 중복 · S · LOW · - · 확인 · 묶음키 `status-line-helper`

- **위치**: `web/js/core/app-settings-access.js:158`, `web/js/core/app-settings-access.js:164`, `web/js/core/app-settings-sandbox.js:73`, `web/js/core/app-settings-sandbox.js:89`, `web/js/core/app-cmd.js:535`, `web/js/core/app-cmd.js:556`, `web/js/core/app-layout.js:929`, `web/js/core/app.js:389`, `web/js/core/main.js:93`
- **근거**: ACL·샌드박스 패널이 같은 흐름을 네 번 쓴다. status.classList.remove('err'); textContent=t('core.saving') → r.ok 가 아니면 apiErrText → catch 에서 t(…)+' — '+((e&&e.message)||e) → classList.add('err') 다. t('…')+' — '+((err&&err.message)||err) 꼴은 core 에 9곳 있다. apiSend 는 망 실패도 status 0 으로 돌려주므로(예외를 던지지 않는다) 이 catch 들은 대부분 닿지 않는 경로다.
- **개선안**: errText(prefix,err) 헬퍼 하나와 StatusLine(el).run(fn,{pending,ok,fail}) 을 세운다. 닿지 않는 try/catch 는 지운다(흐름 제어용 try/catch 금지 규약).
- **이전 감사**: AUDIT-fe-core L2

### FEC-31 — 탭 타입·기본 이름·스키마 판·도구 크기 등 남은 하드코딩

`P3` · 하드코딩 · M · LOW · - · 확인 · 묶음키 `hardcode-sweep`

- **위치**: `web/js/core/constants.js:479`, `web/js/core/app-layout.js:475`, `web/js/core/app-layout.js:816`, `web/js/core/app-presets.js:57`, `web/js/core/app-tool.js:551`, `web/js/core/helpers.js:789`, `web/js/core/helpers.js:952`, `web/js/core/app.js:23`, `web/js/core/app.js:487`, `web/js/core/app-tool.js:573`, `web/js/core/app-layout.js:507`, `web/js/core/app-statusbar.js:357`, `web/js/core/app.js:424`
- **근거**: git 탭은 TAB_TYPE_GIT(constants.js:479, 23곳)을 쓰지만 'editor'(22), 'terminal'(10), 'run'(7)은 리터럴이다. 'Shell' 은 DEFAULT_TOOL_NAME·TAB_NAME_DEFAULT 두 상수(helpers.js:789, 952)에 더해 리터럴 3곳에 있다(app-layout.js:816, app-presets.js:57, app-tool.js:551). schemaVersion 2 가 두 곳(app.js:23, 487)에 있다. apiPost('/api/tools?cols=120&rows=40'+q) 는 크기가 고정이고 쿼리를 손으로 조립한다(app-tool.js:573). Run 짧은 id 가 slice(0,8) 두 곳(app-layout.js:507, app-statusbar.js:357)이고, executeAction 의 i<9(app.js:424)가 있다. /api/* 경로 리터럴은 약 60건인데 *_API 상수는 약 30건이라 섞여 있다.
- **개선안**: TAB_TYPE_{TERMINAL,EDITOR,RUN} 상수를 더하고 리터럴을 옮긴다. 'Shell' 은 하나로 합친다(tabNameSource 판정이 딛는 값). WS_SCHEMA_VERSION, RUN_SHORT_ID_LEN, SB_JUMP_MAX 를 둔다. _newTool 은 apiPost(TOOLS_API,null,{query:{cols,rows,cwd,…}}) 로 바꾸고, 가능하면 대상 pane 크기를 실어 생성 직후 리사이즈(SIGWINCH 재그리기)를 없앤다. /api 경로는 도메인별 *_API 표로 모은다.
- **이전 감사**: AUDIT-fe-core M1, L1

### FEC-32 — 주의 센터는 알림이 바뀔 때마다 통째로 다시 만들고, 해제 한 번에 두 번 그린다

`P3` · 성능 · S · LOW · - · 확인 · 묶음키 `attn-render`

- **위치**: `web/js/core/app-attn-center.js:44`, `web/js/core/app-attn-center.js:80`, `web/js/core/app-attn.js:139`, `web/js/core/app-attn.js:280`, `web/js/core/app-attn.js:308`
- **근거**: _attnCenterRender 는 center.innerHTML='' 뒤 전 항목을 새로 만든다(app-attn-center.js:47-84). 항목의 x 클릭은 _attnClear 를 부르고(→ _attnRefresh → 센터가 열려 있으면 _attnCenterRender, app-attn.js:139, 308) 곧바로 _attnCenterRender 를 한 번 더 부른다(app-attn-center.js:80). _attnRefresh 는 알림 변화마다 document 전체에 querySelectorAll('#windows .si')·('#area .pn-tab[data-toolid]')·('#area .pn[data-paneid]') 를 돈다(app-attn.js:281-296).
- **개선안**: 센터 렌더를 reconcileList(키=toolId)로 바꾸고(agentsRender 와 같은 규약) x 클릭의 중복 호출을 지운다. _attnRefresh 는 바뀐 toolId 만 받아 해당 요소만 토글하는 증분 경로를 둔다.
- **이전 감사**: refactor README §7.3 (_attnCenterRender 폴링 등록)

### FEC-33 — doSearch 가 키 입력마다 getComputedStyle 을 세 번 부른다

`P3` · 성능 · S · LOW · - · 확인 · 묶음키 `minor-perf`

- **위치**: `web/js/core/app-search.js:99`
- **근거**: doSearch 는 입력마다 getComputedStyle(document.documentElement) 를 3회 불러 --accent·--accent-border·--danger 를 읽고 hexToRgba 로 장식을 만든다(app-search.js:99-104). 이 값은 테마가 바뀔 때만 달라진다.
- **개선안**: applyThemeObj 가 끝날 때 검색 장식 객체를 한 번 계산해 캐시하고(또는 theme vars 맵에서 직접 읽고), doSearch 는 캐시를 쓴다.
- **이전 감사**: AUDIT-fe-core P2

### FEC-34 — initMobileKeybar 211줄 — 키 표·이름 표·툴팁·버튼 배선·뷰포트가 한 함수에, 제어 문자가 눈에 보이지 않게 박혀 있다

`P3` · 크기 · M · LOW · - · 확인 · 묶음키 `mobile-keybar`

- **위치**: `web/js/core/app-mobile.js:163`, `web/js/core/app-mobile.js:167`, `web/js/core/app-mobile.js:199`
- **근거**: keys 배열(:167-196)의 send 값은 ESC(0x1b)·ETX(0x03) 날문자를 소스에 그대로 담고 있어 편집기에서 '' 로 보인다(Esc·^C·방향키·Home/End/PgUp/PgDn). FULL_NAMES 표(:199-209)·showTip/hideTip·버튼 19개 × 리스너가 함수 안에서 만들어진다.
- **개선안**: MKB_KEYS·MKB_FULL_NAMES 를 constants 로 옮기고 '\x1b[A' 처럼 이스케이프로 적는다. 툴팁은 작은 헬퍼로, 버튼 배선은 bar 에 이벤트 위임 하나로 바꾼다.
- **이전 감사**: AUDIT-fe-core M4, P3

### FEC-35 — App 인스턴스 필드가 다시 불었다 — 접두 가족별로 소유 클래스로 뺄 수 있다

`P3` · 추상화 · L · MEDIUM · - · 확인 · 묶음키 `app-state-extract-2`

- **위치**: `web/js/core/app-slots.js:223`, `web/js/core/app-attn.js:132`, `web/js/core/app.js:463`, `web/js/core/app-runs.js:13`, `docs/internal/APP_STATE_EXTRACT_SRS.md:10`
- **근거**: app*.js 에서 서로 다른 this.X= 대입 대상이 약 124개다(grep -oh 'this\.[_a-zA-Z]+\s*=' | sort -u). APP_STATE_EXTRACT_SRS 착수 때는 107개였다. _slot*(_slotIds·_slotSse·_slotRenderArmed…), _attn*(_attn·_attnTyped·_attnNotifs…), _ws*/_save*(_wsETag·_saveChain·_savePending·_saveHoldUntil·_saveConflicts·_wsDeferRev…) 가 각각 한 파일 안에서만 쓰이는 가족이다. RunsPanel(app-runs.js)이 같은 추출을 이미 해 보였다.
- **개선안**: WorkspaceSync(save·충돌·유예 rev·_applyRemoteWorkspace, FEC-1·17 과 함께), SlotManager, AttentionCenter 를 RunsPanel 과 같은 '위임 껍데기 + 지연 생성' 규약으로 뺀다. e2e 가 만지는 필드는 APP_STATE_EXTRACT §2.3 처럼 접근자로 남긴다.

### FEC-36 — 잔손질 묶음 — 전역 t() 가림, 호출마다 새로 만드는 액션 맵, index.html 인라인 display:none

`P3` · 가독성 · S · LOW · - · 확인 · 묶음키 `minor-readability`

- **위치**: `web/js/core/app-agents.js:27`, `web/js/core/app-cmd.js:241`, `web/js/core/app-settings.js:180`, `web/js/core/app.js:380`, `web/index.html:303`
- **근거**: const t=/let t= 가 core 에 34곳 있어 전역 i18n t() 를 가린다. 예: const t=this._restoreBegin(...) (app-agents.js:27, app-cmd.js:241), _openSettings 의 const t=querySelector (app-settings.js:180). executeAction 은 키 입력마다 클로저 30여 개짜리 map 을 새로 만든다(app.js:380-425). index.html 의 설정 패널 12개와 #custom-editor 가 style="display:none" 인라인이고, 탭 전환은 p.style.display 를 직접 바꾼다(app-settings.js:419 부근).
- **개선안**: 가림 변수 이름을 flight·tabEl 등으로 바꾸고 eslint no-shadow(전역 t 대상)를 켠다. 액션 맵은 생성자에서 한 번 만든다. 패널 표시는 hidden 속성이나 .is-hidden 클래스로 통일한다.
- **이전 감사**: AUDIT-fe-core M6

### FEC-M2 — settings-schema.js 주석이 없는 게이트(TC-CFG-2)를 근거로 든다

`P3` · 문서괴리 · S · LOW · - · 검증자 추가 · 묶음키 `settings-schema-source`

- **위치**: `web/js/core/settings-schema.js:15`, `docs/internal/CONFIG_MANAGEMENT_SRS.md:273`, `internal/shared/settingsschema/derive_test.go:20`
- **근거**: 주석은 '상수를 참조하고 싶어도 값을 적어라 — 그 상수와 어긋나면 TC-CFG-2 가 잡는다' 고 적는다. 그러나 TC-CFG-2 는 '범위 밖 값이 기본값으로 떨어진다' 는 시험이다. settingsschema 의 Go 테스트(derive_test·schema_test)도 스키마 키와 SETTINGS_ACCESS 키 집합만 대조한다. AGENTS_POLL_DEFAULT·TAB_WIDTH_* 같은 상수와 스키마 def/min/max 를 비교하는 검사는 없다.
- **개선안**: FEC-25 와 함께 처리한다. 상수를 스키마에서 파생하거나, 상수↔스키마 대조 테스트(TC-CFG-2x)를 실제로 세운 뒤 주석을 그 id 로 고친다.

### FEU-18 — localStorage 선호값 get/set+try/catch 패턴이 곳곳에 복제돼 있다

`P3` · 추상화 · S · LOW · - · 개연 · 묶음키 `pref-store`

- **위치**: `web/js/git/panel-poll.js:21`, `web/js/git/panel-poll.js:29`, `web/js/git/panel-poll.js:38`, `web/js/git/panel-poll.js:45`, `web/js/git/panel-poll.js:54`, `web/js/git/panel-poll.js:62`, `web/js/git/commit.js:1`, `web/js/git/branches-tree.js:1`, `web/js/ui/sidebar-tabs.js:1`
- **근거**: panel-poll.js 에 _sideBySidePref/_ignoreWsPref/_foldPref 와 짝 setter 셋이 `let v=null; try{v=localStorage.getItem(K)}catch{}; this._x=v==='1'` / `try{localStorage.setItem(K,x?'1':'0')}catch{}` 를 세 번 반복한다. ui/git 전반에 같은 try{localStorage…}catch 가 19곳 있고(input-binding 3, panel-changes 2, sidebar-tabs 2, commit 2, branches-tree 2 등), core 에 공용 헬퍼가 없다.
- **개선안**: core 에 `prefStore={bool(key,def),setBool(key,v),json(key,def),setJson(key,v)}` 를 두고 예외 흡수를 한 곳으로 모은다. panel-poll 의 셋은 `_pref(field,key,def)`/`_setPref(field,key,v,apply)` 로 합친다.
- **검증 메모**: panel-poll.js 의 pref get/set try/catch 반복은 감사 서술과 같은 모양이다. 19곳 전수는 확인하지 않았다. core 에 공용 스토어가 이미 있는지(sidebarWidthStore 계열)도 먼저 보고, 있으면 그쪽으로 수렴해야 한다.

## O12 — FE ui/git 리팩토링 (16건)

### FEU-12 — GitDialog 와 GitConfirm 이 모달 골격·실행·오류·닫기 로직을 두 벌 갖는다

`P2` · 중복 · M · MEDIUM · - · 확인 · 묶음키 `git-modal-base`

- **위치**: `web/js/git/dialog.js:147`, `web/js/git/dialog.js:167`, `web/js/git/dialog.js:330`, `web/js/git/dialog.js:371`, `web/js/git/dialog.js:386`, `web/js/git/dialog.js:402`, `web/js/git/confirm.js:172`, `web/js/git/confirm.js:189`, `web/js/git/confirm.js:317`, `web/js/git/confirm.js:346`, `web/js/git/confirm.js:362`, `web/js/git/confirm.js:376`
- **근거**: 두 클래스가 같은 것을 각자 구현한다. _show(returnTo 잡기→_build→_cur 등록→_paint→_focus→UIKit.dialogOpen), _build 의 innerHTML(changed 배너·err reason/tail/copy·actions progress/cancel/go), _paint 의 err·progress·cancel/go 라벨 세우기, _run/_advance(busy→run→try/catch→ok 면 닫기, 아니면 err={reason,tail}), _close(keydown 해제·releaseDlg·ov.remove·_cur 해제·resolve), _front, _copy(ClipboardWriter). 다른 것은 CSS 접두어(gc- vs git-dialog-)와 본문(대상 목록 vs 필드)뿐이다.
- **개선안**: GitModalBase 를 추출한다. 생명주기(show/close/front/_cur), 실행 상태기계(busy/err/run), 오류 블록 칠하기, actions 행 칠하기를 가지고 `_bodyHTML()`·`_paintBody()`·`_focusDefault()` 훅을 둔다. 클래스 접두어는 ns 로 넘긴다. try/catch 흐름 제어는 run 계약(항상 {ok} 반환)으로 없앤다.

### FEU-14 — TerminalTool.connect() 와 _reconnect() 가 WebSocket 배선을 두 벌 갖고 백오프 수치가 박혀 있다

`P2` · 중복 · M · MEDIUM · - · 확인 · 묶음키 `term-ws-wire`

- **위치**: `web/js/ui/term-pane.js:720`, `web/js/ui/term-pane.js:731`, `web/js/ui/term-pane.js:737`, `web/js/ui/term-pane.js:937`, `web/js/ui/term-pane.js:942`, `web/js/ui/term-pane.js:944`, `web/js/ui/term-pane.js:955`, `web/js/ui/term-pane.js:960`, `web/js/ui/term-pane.js:771`, `web/js/ui/term-pane.js:789`
- **근거**: onopen/onmessage/onclose/onerror 가 :720-747 과 :946-971 에 두 번 있다. 두 벌 사이에 차이도 있다. connect 쪽 onclose 는 `this.ws!==ws` 가드가 없어서 reconnectNow(:769-773)·_scheduleReconnect(:789)가 콜백을 먼저 null 로 끊어야 한다. `TIMERS.after(300,()=>{_hideOverlay;opacity='1';_reconnecting=false;scrollToBottom})` 도 문자 그대로 두 번(:731, :955) 있다. 백오프 200/500/1000/10000/×2.5/×1.2 가 리터럴이다(:942-944). 소켓 콜백 해제 코드도 :771 과 :789 두 곳에 있다.
- **개선안**: `_wireSocket(ws,{adoptOnOpen})` 하나로 모으고 stale 가드(`if(this.ws&&this.ws!==ws) return`)를 공통으로 둔다. `_detachSocket(s)` 로 해제를 하나로 합친다. `_onWsReady()` 로 300ms 오버레이 해제를 모은다. TERM_RETRY_FIRST_MS·TERM_RETRY_FAST_MAX_MS·TERM_RETRY_MAX_MS·TERM_OVERLAY_HIDE_MS 상수를 constants 로 옮긴다.
- **이전 감사**: AUDIT-fe-ui M-3, L-2

### FEU-22 — panel-diff.js 1056줄 — hunk 툴바와 blame 이 응집된 하위 컴포넌트로 분리 가능

`P2` · 크기 · M · LOW · - · 개연 · 묶음키 `split-panel-diff`

- **위치**: `web/js/git/panel-diff.js:242`, `web/js/git/panel-diff.js:370`, `web/js/git/panel-diff.js:391`, `web/js/git/panel-diff.js:483`, `web/js/git/panel-diff.js:770`
- **근거**: GitPanel.prototype 에 blame(_blameTarget~openBlame, :242-376)과 부분 스테이징 hunk 툴바(_paintHunks~_afterHunk, :391-768, _hunkBar* 12개)가 Diff 탭 탐색·dirty 처리와 한 파일에 섞여 있다. hunk 툴바는 _hunkKey/_hunks/_hunkErr* 등 자체 상태를 갖고 dispose 수명도 따로 관리한다(_hunkBarDispose).
- **개선안**: FE_MODULE_BOUNDARY 증강 규약대로 `git/panel-blame.js`(블레임)와 `git/hunk-bar.js`(class GitHunkBar{constructor(panel)}: 상태·Monaco 배선·좌표·동작)로 뗀다. 패널에는 `this._hunkBar` 위임만 남긴다. 구간 이동이 대부분이다.
- **검증 메모**: panel-diff.js 1056줄은 확인했다. 블레임·hunk 툴바 구간 경계는 직접 대조하지 않았다.

### IPC-16 — TermPane 의 connect()/_reconnect() WS 배선이 두 벌이고, 재접속 백오프는 하드코딩에 지터가 없다

`P2` · 중복 · M · LOW · - · 확인 · 묶음키 `term-socket-extract`

- **위치**: `web/js/ui/term-pane.js:720-758`, `web/js/ui/term-pane.js:937-973`, `web/js/ui/term-pane.js:19`
- **근거**: onopen/onmessage/onclose/onerror 네 핸들러가 두 함수에 거의 같은 모양으로 있고, `TIMERS.after(300,()=>{this._hideOverlay();…})` 가 글자 그대로 두 번 나온다. 백오프 200→×2.5(≤1000)→×1.2(≤10000) 는 리터럴이고, _sendQueueMax=64 도 리터럴이다. 지터가 없어서 서버 재시작 뒤 모든 탭의 WS 가 0ms·200ms·500ms… 에 한꺼번에 재접속하고, 그때마다 list+snapshot RPC 가 몰린다. 파일은 1174줄이고 전송·재접속·크기 소유·IME 가 한 클래스에 섞여 있다.
- **개선안**: TermSocket 클래스(연결·재접속·송신 큐·백오프·건강 판정)를 따로 뽑고, TermPane 은 op 수신만 처리한다. 백오프 상수(TERM_WS_RETRY_FIRST_MS·_MAX_MS·_FACTOR, TERM_OVERLAY_HIDE_MS, TERM_SEND_QUEUE_MAX)는 constants.js 로 옮기고, 지연에 ±20% 지터를 넣는다.
- **이전 감사**: AUDIT-fe-ui.md M-3, L-2

### FEU-11 — DocRender 가 보이지 않는 렌더 탭도 편집마다 markdown+DOMPurify 로 다시 그린다

`P3` · 성능 · S · LOW · - · 확인 · 묶음키 `hidden-view-defer`

- **위치**: `web/js/ui/doc-render.js:302`, `web/js/ui/doc-render.js:306`, `web/js/ui/doc-render.js:310`, `web/js/ui/doc-render.js:395`
- **근거**: _bindModel 이 onDidChangeContent 를 구독하고(:306), _schedule 은 가시성과 상관없이 DOC_RENDER_DEBOUNCE_MS 뒤 _paint 를 건다. _paint 는 전체 render→sanitize→innerHTML 을 한다(:367-395). 가시성은 스크롤 자리를 읽을 때(:393)만 본다.
- **개선안**: _schedule 에서 `!this.el.isConnected||!classList.contains('vis')` 면 _dirty=true 만 세우고, 탭이 보이는 경로(_applyWant·restore)에서 dirty 면 _paint 한다.

### FEU-13 — panel-views.js 의 _renderX 여섯이 거의 같은 블록이다

`P3` · 중복 · S · LOW · - · 개연 · 묶음키 `git-view-descriptor`

- **위치**: `web/js/git/panel-views.js:57`, `web/js/git/panel-views.js:82`, `web/js/git/panel-views.js:101`, `web/js/git/panel-views.js:120`, `web/js/git/panel-views.js:139`, `web/js/git/panel-views.js:158`
- **근거**: _renderHistory/_renderBranches/_renderConsole/_renderWorktrees/_renderSubmodules/_renderStash 가 `if(!this.repo){el.dataset.built='';el.innerHTML='';view.unmount();빈 안내 div…;return} if(el.dataset.built!=='1'){mount;built='1'} paint()` 를 반복한다. 게으른 getter(_history()…) 여섯도 같은 모양이다. 다른 것은 뷰 클래스와 History 의 _paintHeadIn 한 줄뿐이다.
- **개선안**: GIT_VIEWS 서술자(이미 GIT_VIEW_FIELD_BY_KEY 가 있다)에 cls 와 afterPaint 를 더하고 `_viewOf(key)` + `_renderView(key,el)` 하나로 바꾼다. 빈 저장소 안내는 `gitEmptyRow` 류 헬퍼 하나로 만든다.
- **이전 감사**: AUDIT-fe-ui M-2
- **검증 메모**: _renderX 반복 구조는 감사 서술과 맞는다. 여섯 블록을 줄 단위로 대조하지는 않아서 History 외에 다른 특례가 있는지는 확정하지 못했다.

### FEU-15 — 터미널 키 매핑 바이트열과 송신 큐 상한이 리터럴이다

`P3` · 하드코딩 · S · LOW · - · 확인 · 묶음키 `term-constants`

- **위치**: `web/js/ui/term-pane.js:19`, `web/js/ui/term-pane.js:147`, `web/js/ui/term-pane.js:189`, `web/js/ui/term-pane.js:190`, `web/js/ui/term-pane.js:194`, `web/js/ui/term-pane.js:195`
- **근거**: Shift+Enter `[OP.INPUT,0x1b,0x0d]`(:147), Cmd+←/→ `0x01`/`0x05`(:189-190), Alt+←/→ `0x1b,0x62`/`0x1b,0x66`(:194-195)이 핸들러 안에 박혀 있고 키마다 Uint8Array 를 새로 만든다. `_sendQueueMax=64`(:19)도 인스턴스 필드 리터럴이다.
- **개선안**: TERM_KEY_SEQ={shiftEnter:[0x1b,0x0d],lineStart:[0x01],lineEnd:[0x05],wordBack:[0x1b,0x62],wordFwd:[0x1b,0x66]} 표와 TERM_SEND_QUEUE_MAX 상수를 constants 로 옮긴다. 조합표 `{meta:{ArrowLeft:'lineStart',…},alt:{…}}` 로 if 사슬을 조회로 바꾼다.

### FEU-16 — 버튼 38곳이 UIKit.button 없이 손으로 조립되고, 아이콘 전용 버튼 일부에 type·aria-label 이 없다

`P3` · 중복 · L · MEDIUM · B · 확인 · 묶음키 `kit-button-migrate`

- **위치**: `web/js/git/panel-changes.js:252`, `web/js/git/panel-changes.js:558`, `web/js/git/panel-changes.js:629`, `web/js/ui/renderer-chrome.js:277`, `web/js/ui/renderer-chrome.js:241`, `web/js/ui/renderer-pane.js:373`, `web/js/git/submodules.js:92`, `web/js/git/worktrees.js:91`, `web/js/ui/runs-panel.js:176`, `web/js/git/diff-view.js:225`, `web/js/ui/ui-kit.js:70`
- **근거**: ui/git 에서 `createElement('button')` 이 40곳(킷 자신 2 제외 38), UIKit.button 호출은 전체 13곳이다. check-button-kit 게이트가 킷 클래스는 강제하지만 조립은 여전히 손으로 한다. 계약 차이가 실제로 있다. panel-changes.js:252(git-group-bulk)·:558(폴더 동작)·renderer-chrome.js:277(새로고침)은 아이콘만 있는데 aria-label 이 없고(title 만 있음) type='button' 도 없다. 반면 renderer-chrome.js:323 은 aria-label 을 직접 넣는다. UIKit.button(ui-kit.js:70-96)은 type·aria-label·이름 없는 버튼 금지를 항상 보장한다.
- **개선안**: 이미 'ui-btn …' 문자열을 쓰는 자리는 `UIKit.button({icon,label,title,kind,size,cls,dataset,onClick})` 로 기계적으로 바꾼다. innerHTML 골격 안의 버튼은 `UIKit.buttonHTML(spec)`(UI_KIT_SRS 개정 필요)로 바꾼다. 게이트에 'createElement("button") 은 ui-kit.js 밖에서 금지(예외 등록부)' 를 더한다.
- **이전 감사**: AUDIT-fe-ui H-3 (킷 클래스 부분은 해결, 조립·계약 부분은 잔존)
- **결정 충돌**: D-KIT-8(B2-K 키보드 도달)은 tabindex/roving 범위이고 이 항목은 버튼 팩토리 이주라 겹치지 않는다.

### FEU-17 — Agents 패널 폭은 160/480 리터럴과 원시 localStorage 키를 쓰고, 사이드바만 상수·스토어를 쓴다

`P3` · 하드코딩 · S · LOW · - · 확인 · 묶음키 `panel-width-store`

- **위치**: `web/js/ui/input-binding.js:23`, `web/js/ui/input-binding.js:36`, `web/js/ui/input-binding.js:48`, `web/js/ui/input-binding.js:51`, `web/js/ui/input-binding.js:98`, `web/js/ui/input-binding.js:120`, `web/js/ui/input-binding.js:9`
- **근거**: agents 드래그(:36)와 복원(:51)이 `w>=160&&w<=480` 을 두 번 적고, 키 'agentsWidth'·'agentsPanelOpen' 을 localStorage 에 바로 쓴다(:23,:48,:51). 같은 함수의 사이드바(:98-120)는 SIDEBAR_W_MIN_PX/SIDEBAR_W_MAX_PX 와 sidebarWidthStore 를 쓴다. bind() 는 236줄 한 함수다.
- **개선안**: AGENTS_W_MIN_PX/AGENTS_W_MAX_PX·AGENTS_WIDTH_KEY·AGENTS_OPEN_KEY 상수와 agentsWidthStore 를 만들고, 두 핸들을 `_bindWidthHandle(handle,{el,cssVar,min,max,store,sidesOrder})` 하나로 합친다. bind() 는 드래그/단축키/DnD/녹화 배선으로 나눈다.
- **이전 감사**: AUDIT-fe-ui L-1

### FEU-19 — UIKit.menu·HUD 의 화면 가장자리 여백이 매직 넘버다

`P3` · 하드코딩 · S · LOW · - · 확인 · 묶음키 `ui-kit-constants`

- **위치**: `web/js/ui/ui-kit.js:511`, `web/js/ui/ui-kit.js:512`, `web/js/ui/ui-kit.js:513`, `web/js/ui/ui-kit.js:514`, `web/js/ui/ui-kit.js:696`, `web/js/ui/ui-kit.js:697`
- **근거**: menu 가 `innerWidth-4`·`Math.max(4,…)` 을 네 번 쓰고, _hud 가 `Math.max(x,48)`·`innerWidth-48`·`Math.max(y,28)`·`innerHeight-28` 을 쓴다.
- **개선안**: UIK_MENU_EDGE_PX=4, UIK_HUD_EDGE_X_PX=48, UIK_HUD_EDGE_Y_PX=28 을 ui-kit 머리에 상수로 두고 `clampToViewport(x,y,w,h,edge)` 헬퍼로 두 자리를 합친다.
- **이전 감사**: AUDIT-fe-ui L-4

### FEU-21 — 서명·키 구분자가 '\u0001' 과 '\u0000' 두 벌로 흩어져 있다

`P3` · 상수 · S · LOW · - · 확인 · 묶음키 `sig-sep`

- **위치**: `web/js/git/remote.js:829`, `web/js/git/stash.js:211`, `web/js/git/panel-diff.js:263`, `web/js/git/panel-diff.js:313`, `web/js/git/panel-views.js:187`, `web/js/git/branches-tree.js:132`, `web/js/ui/file-tree-paint.js:505`, `web/js/ui/file-tree-paint.js:690`
- **근거**: reconcileList sig 와 캐시 키가 `.join('\u0001')`(remote.js:829, file-tree-paint.js:690)과 `.join('\u0000')`(stash.js:211, panel-diff.js:263/313/403/854, branches-tree.js:132, commit.js:107 등 14곳)로 섞여 있다. 문자열 결합으로 직접 붙이는 곳도 있다(panel-diff.js:468, file-tree-paint.js:505).
- **개선안**: repaint.js 에 `RPT_SEP` 과 `rptKey(...parts)` 를 두고 전부 그것을 쓴다. 동작은 바뀌지 않는다(구분자는 비교에만 쓰인다).
- **이전 감사**: AUDIT-fe-ui L-3

### FEU-23 — runs-panel.js 911줄 — 목록·대시보드(그래프·카드·타임라인)가 한 객체이고 배치 수치가 리터럴이다

`P3` · 크기 · M · LOW · - · 개연 · 묶음키 `split-runs-panel`

- **위치**: `web/js/ui/runs-panel.js:68`, `web/js/ui/runs-panel.js:104`, `web/js/ui/runs-panel.js:421`, `web/js/ui/runs-panel.js:482`, `web/js/ui/runs-panel.js:483`, `web/js/ui/runs-panel.js:488`
- **근거**: RunsPanel.prototype 하나에 Run 목록 행·삭제/종료 확인(:104-230)과 대시보드 렌더(_runPaint 이하 그래프·마커·카드·타임라인)가 모두 있다. _runLayout 의 `n*(RUN_NODE_W+30)+60`·`RUN_ROW_Y+RUN_NODE_H+76`·`+16` 은 이웃 치수와 달리 이름 없는 상수다.
- **개선안**: `ui/runs-list.js`(목록·확인)와 `ui/run-dashboard.js`(그래프·카드·타임라인)로 나눈다. RUN_NODE_GAP_X=30·RUN_GRAPH_PAD_X=60·RUN_GRAPH_PAD_BOTTOM=76·RUN_GRAPH_PAD_COORD=16 을 상수로 둔다.
- **검증 메모**: runs-panel.js 911줄은 확인했다. _runLayout 리터럴은 직접 대조하지 않았다.

### FEU-25 — term-pane.js 1174줄 — 111줄 생성자·118줄 open() 과 한 줄에 메서드 둘이 들어간 451자 줄

`P3` · 크기 · M · LOW · - · 확인 · 묶음키 `split-term-pane`

- **위치**: `web/js/ui/term-pane.js:6`, `web/js/ui/term-pane.js:117`, `web/js/ui/term-pane.js:142`, `web/js/ui/term-pane.js:936`
- **근거**: 생성자(:6-116)는 상태 초기화·DnD·컨텍스트 메뉴·폴더 드롭을, open()(:117-234)은 xterm 애드온·CSI 핸들러·키 매핑·IME·모바일 입력 배선을 한 번에 한다. :142(225자)는 open 과 CSI 등록 세 개를 한 줄에, :936(451자)은 _onEraseDisplay 와 _onAltMode 두 메서드를 한 줄에 둔다. 애드온 로드는 빈 catch 가 달린 try 네 번이다(:131-138).
- **개선안**: _wireDnd()·_wireContextMenu()·_loadAddons()·_wireKeys()·_wireIme(ta) 로 나누고, :142·:936 을 풀어 쓴다. IME·터치 입력은 term-input 믹스인 파일로 뗀다(파일 경계 규약과 같다).

### FEU-26 — renderer-pane.js 691줄(README 부채 585줄에서 증가) — _makePane 186줄에 DnD 배선 셋이 들어 있다

`P3` · 크기 · M · LOW · - · 개연 · 묶음키 `split-renderer-pane`

- **위치**: `web/js/ui/renderer-pane.js:432`, `web/js/ui/renderer-pane.js:252`, `web/js/ui/renderer-pane.js:531`, `web/js/ui/renderer-pane.js:560`, `web/js/ui/renderer-pane.js:563`
- **근거**: _makePane(:432-617)이 탭줄 DOM·roving·가로 스크롤 overflow 표시·탭줄 drop·본문 dragover/drop·mousedown 포커스를 한 함수에서 한다. 본문 dragover 마다 `tabs.querySelectorAll('.pn-tab').forEach(remove drag-left/right)` 를 부른다(:563). _makeTab 도 105줄이다. refactor/README §7.3 이 585줄을 남은 부채로 적었는데 지금은 691줄이다.
- **개선안**: _wireTabScroll(scroll)·_wireTabsDrop(tabs,node)·_wireBodyDrop(body,node)·_wirePaneFocus(el) 로 나누고, dragover 에서는 직전에 표시한 탭만 해제한다(el._dragMarked 기억). 탭 DnD 는 app-dnd.js 와 맞춰 한 모듈로 모으는 것을 검토한다.
- **이전 감사**: refactor/README.md §7.3 renderer-pane.js 585줄
- **검증 메모**: renderer-pane.js 691줄은 확인했다. _makePane 의 186줄 여부와 dragover querySelectorAll 은 직접 확인하지 않았다.

### FEU-27 — FileEditor._createEditor 159줄 — 같은 요소에 keydown 리스너 셋(capture 둘·bubble 하나)

`P3` · 복잡도 · S · LOW · - · 개연 · 묶음키 `file-editor-wiring`

- **위치**: `web/js/ui/file-editor.js:384`, `web/js/ui/file-editor.js:490`, `web/js/ui/file-editor.js:506`, `web/js/ui/file-editor.js:513`
- **근거**: this.el 에 capture keydown 두 개(검색·뷰 키 :490, dirty-diff Esc :506)와 bubble keydown(stopPropagation :513)이 따로 붙는다. 같은 함수가 Monaco 생성·LSP·DocRender·dirty 추적·포커스 배선까지 한다.
- **개선안**: capture 핸들러 둘을 `_onKeyCapture(e)` 하나로 합치고(Esc→dd 판정 뒤 search→view 키), _createEditor 를 _mountMonaco/_wireModelEvents/_wireKeys/_wireFocus/_notifyIntegrations 로 나눈다.
- **검증 메모**: 확인하지 않았다. 캡처 리스너 두 개를 합치면 Esc 우선순위가 바뀔 수 있으므로 등록 순서를 보존해야 한다.

### FEU-32 — API 경로 리터럴 68종이 흩어져 있고 git GET 을 부르는 방식이 세 가지다

`P3` · 하드코딩 · M · LOW · - · 확인 · 묶음키 `git-get-helper`

- **위치**: `web/js/git/panel-poll.js:484`, `web/js/git/panel-diff.js:276`, `web/js/git/panel-diff.js:279`, `web/js/git/history-load.js:31`, `web/js/git/console.js:99`, `web/js/git/diff-view.js:353`, `web/js/ui/file-tree-paint.js:466`, `web/js/core/constants-git-actions.js:495`
- **근거**: ui/git 안에 '/api/…' 리터럴이 68종·87회다. 반면 *_API 상수는 core 전체에 26개뿐이고, GIT_STATUS_API 가 있는데도 panel-poll.js:484 는 '/api/git/status?repo='+encodeURIComponent(repo) 를 손으로 조립한다. 호출 방식도 셋이다. ① apiGet+수동 쿼리 문자열(panel-poll·panel-diff:276-279·console:99·diff-view:353) ② apiGet(path,{query})(file-tree-paint:466) ③ gitFetch(echo/stale 검증 포함, 18곳). history-load._get(:13-37)은 자체 echo 검증을 또 구현한다.
- **개선안**: GIT_API={status,refs,log,blame,hunks,…} 경로 표를 core 에 두고, 조회는 gitFetch(path,params,{timeout,stale,echo,signal}) 하나로 모은다. timeout 기본값을 gitFetch 가 갖게 하고 history-load._get 은 gitFetch 위임으로 줄인다.

## O13 — CSS·디자인 토큰 (3건)

### FEU-24 — style-git-views.css 에 Runs·사이드바 탭·bg-kill CSS(약 230줄)가 섞여 있다

`P3` · 추상화 · S · LOW · - · 확인 · 묶음키 `css-file-cohesion`

- **위치**: `web/style-git-views.css:831`, `web/style-git-views.css:843`, `web/style-git-views.css:996`, `web/style-git-views.css:1061`
- **근거**: '/* --- track: runs */'(:831, .runs-*/.run-* 규칙 89개), '/* --- track: sidebar-tabs */'(:996), '/* --- track: bg-kill */'(:1061)가 git 뷰 파일 뒤에 붙어 있다. git 과 무관한 선택자라 파일 이름으로 찾을 수 없다.
- **개선안**: style-runs.css·style-sidebar.css 로 옮기고(내용 불변, index.html 링크 추가, 로드 순서는 지금과 같게) check-css-* 게이트 목록에 넣는다.

### FEU-28 — CSS transition 시간이 토큰 없이 9종 리터럴이다(.1s·.12s·.15s·.18s·.2s·.22s·.3s 등)

`P3` · 하드코딩 · S · LOW · B · 확인 · 묶음키 `motion-tokens`

- **위치**: `web/style.css:634`, `web/style.css:1432`, `web/style.css:1489`, `web/style-kit.css:81`, `web/style-git.css:1`, `web/style-editor.css:1`
- **근거**: `transition:` 선언 약 30개가 .1s/.12s/.15s/.18s/.2s/.22s/.3s 를 제각각 쓴다(.15s 17회, .1s 8회, .12s 4회 등). DESIGN_TOKENS_SRS 에는 motion/duration 토큰이 없고, prefers-reduced-motion 블록(style.css:1773)은 !important 로 전역 덮어쓰기만 한다.
- **개선안**: --dur-fast(.1s)·--dur-base(.15s)·--dur-slow(.2s) 세 토큰을 :root 에 두고 치환한다. check-css-vars 류 게이트에 transition 리터럴 금지를 더한다. 값 통합으로 미세한 체감 변화가 있으므로 DESIGN_TOKENS_SRS 개정이 먼저다.

### FEU-29 — git 뷰 안내 띠·툴바·리사이즈 핸들 CSS 가 뷰마다 복제돼 있다(빈 규칙 둘 포함)

`P3` · 중복 · M · MEDIUM · - · 확인 · 묶음키 `css-kit-notice-bar`

- **위치**: `web/style-git-views.css:150`, `web/style-git-views.css:458`, `web/style-git-views.css:529`, `web/style-git-views.css:573`, `web/style-git-views.css:618`, `web/style-git-views.css:1`, `web/style-git-views.css:270`, `web/style-git-views.css:380`, `web/style.css:224`, `web/style.css:227`, `web/style.css:501`, `web/style-editor.css:43`, `web/style.css:1025`, `web/style.css:1210`
- **근거**: .git-hist-note/.git-br-note/.git-stash-note 가 display:none;flex;gap:8px;padding:3~4px 10px;font-size:--fs-sm;color:--attn-text;background:--attn-subtle + .vis{display:flex} + -msg{flex:1 1 auto} 를 바이트까지 거의 같게 반복하고, wt/sub-note 도 변형이다. 이 모양은 킷 .ui-notice.ui-notice-attn 과 같다. .git-diff-bar/.git-con-bar/.git-br-bar 본문이 같다. 리사이즈 핸들 히트영역 ::before(left/right:-6px) 5벌(#sb-handle·#agents-handle·.ed-ex-handle·.slot-handle·.sh)이 있다. 빈 규칙 .sc-list{}(style.css:1025)·.sb-settings{}(:1210)이 남아 있다.
- **개선안**: notice 계열을 .ui-notice.ui-notice-attn + [hidden] 로 옮기고 뷰별 규칙을 지운다. 툴바는 .git-bar 공용 클래스, 핸들은 킷 .ui-resize-handle(::before 히트영역 포함)로 모은다. 빈 규칙 둘을 지운다.
- **이전 감사**: refactor/README.md §7.3 (.sc-list{} · .sb-settings{})

## O14 — 문서·주석 동기화, 죽은 코드 (13건)

### HTTP-19 — 문서 주석이 다른 심볼에 붙어 있거나 파일 끝에 매달려 있다 (H-5 잔존 + 신규)

`P2` · 가독성 · S · LOW · - · 확인 · 묶음키 `comment-realign`

- **위치**: `internal/webserver/httpapi/handlers_fs_search.go:106-121`, `internal/webserver/httpapi/handlers_ws.go:105-121`, `internal/webserver/httpapi/handlers_fs.go:180-193`, `internal/webserver/httpapi/handlers_fs.go:318-327`, `internal/webserver/httpapi/access.go:359-366`, `internal/webserver/httpapi/handlers_toolio.go:185-204`, `internal/webserver/httpapi/handlers_runs.go:125-141`, `internal/webserver/gitapi/handlers_git_history.go:199-205`, `internal/webserver/httpapi/server_middleware.go:150-157`, `cmd/dongminal/main.go:40-58`, `cmd/dongminal/app.go:252-266`, `internal/webserver/httpapi/handlers_api.go:216-229`
- **근거**: findFiles 설명이 fsWalkFiles 위에, handleWSDirect 설명이 sendModeRestore 위에, fsUnderRoot 설명이 fsResolveErr 위에, POST /api/fs/create 설명이 fsRootTarget 위에 있다. allowed 설명은 isSelf 에, resolveSender 설명은 decodeJSONBody 에, apiRunsGet 설명은 runMember 에, gitCountParam 설명은 gitBoolParam 에 붙었다. assetVersion 블록은 server_middleware.go 끝에 매달려 있다. main.go 의 dialOrStartDaemon godoc(구식 'lines 50-53' 참조 포함)은 const 블록 위에 붙었다. shutdownSteps 주석은 0~6 단계를 적었지만 실제 표는 8칸('판 확인' 누락)이다. apiRoutes 끝에는 gitapi 로 옮겨 간 라우트 설명 주석 14줄이 대상 없이 남았다.
- **개선안**: 감사 제안에 handlers_git_tag.go:144 의 'gitBranchNameTaken' 주석(apiGitTagValidate 위) 정정을 더한다. 게이트 스크립트는 오탐이 많을 수 있으니(주석이 다른 식별자를 먼저 언급하는 정상 사례) 경고 전용으로 시작한다.
- **이전 감사**: AUDIT-go-http H-5

### SHR-20 — backup·uninstall 도움말이 homeLayout 을 손으로 베꼈고 이미 낡았다 — lsp-paths.json·git-worktrees·panes.json 이 빠져 있다

`P2` · 문서괴리 · S · LOW · B · 확인 · 묶음키 `help-derive-homelayout`

- **위치**: `internal/ctl/cli/help.go:168`, `internal/ctl/cli/help.go:170`, `internal/ctl/cli/help.go:199`, `internal/ctl/cli/homelayout.go:62`, `internal/ctl/cli/homelayout.go:104`
- **근거**: usageBackup 의 '담는 것'은 workspace·settings·access·runs·tools·server·sandbox·notes 여덟 개뿐이다. homeLayout 에는 InBackup:true 인 lsp-paths.json, git-worktrees, panes.json 이 더 있다. '담지 않는 것'과 uninstall 의 '지우는 것' 목록(로그·소켓·pid·bin/·tool-history/)도 ext·worktrees·cache·doctor* 등 Ephemeral 항목과 맞지 않는다. 이전 감사가 예측한 드리프트가 실제로 일어났다.
- **개선안**: usageBackup·usageUninstall 이 backupNames()와 새 ephemeralNames()를 strings.Join 해서 본문을 만들게 한다. check-home-layout.sh 대조에 도움말도 넣는다.
- **이전 감사**: AUDIT-go-infra #17

### DOM-29 — 비용·전제를 말하는 주석이 낡았다

`P3` · 가독성 · S · LOW · - · 확인 · 묶음키 `stale-comments`

- **위치**: `internal/webserver/domain/git/query/signature.go:14`, `internal/webserver/domain/git/query/signature.go:78`, `internal/webserver/domain/git/store/store.go:327`, `internal/webserver/domain/run/store_context.go:34`, `internal/webserver/domain/git/core/unguarded.go:133`
- **근거**: ReadSignature 를 'read 1회 + stat 2회', '0.02ms'로 적었지만 실제로는 refsTree ReadDir 워크와 extras 를 포함한다. store.observe 도 'signature 는 stat 2회'라고 적었다. ContextPolicy.LimitTokens 주석 '멤버 레코드에 모델이 없으므로 늘 기본값'은 WindowForModel(FR-CTX-5) 도입 뒤 틀렸다. unguarded.go 의 recordUnguarded 와 RecordUnguarded 는 두 doc 주석이 한데 붙어 있다.
- **개선안**: 실제 비용(read 1 + stat 5~8 + refs ReadDir)과 현재 전제로 고친다. signature_perf_test 결과를 주석과 GIT_PUSH_OBSERVE 근거에 적는다. 붙은 주석을 두 함수 위로 나눈다.
- **이전 감사**: AUDIT-go-domain LOW ReadSignature · D5

### FEC-29 — FR-TIP-4('title 문자열은 상수 표에 산다') 위반 — 인라인 영문 툴팁 12자리

`P3` · 문서괴리 · S · LOW · - · 확인 · 묶음키 `tip-constants`

- **위치**: `web/js/core/app-backup.js:243`, `web/js/core/app-attn-center.js:51`, `web/js/core/app-attn-center.js:79`, `web/js/core/app-presets.js:147`, `web/js/core/app-presets.js:152`, `web/js/core/app-presets.js:160`, `web/js/core/app-presets.js:167`, `web/js/core/app-settings-access.js:43`, `web/js/core/app-settings-sandbox.js:28`, `web/js/core/app-settings-theme.js:67`, `web/js/core/app-settings-theme.js:157`, `web/js/core/app-mobile.js:124`
- **근거**: UX_BATCH5_SRS FR-TIP-4(:348)는 툴팁 문자열이 상수 표에 살아야 한다고 정한다. 그런데 'Revert the window layout to this generation', 'Clear every attention alert', 'Dismiss this alert', 'Make this the default preset', 'Load this preset', 'Delete this preset'(2회), 'Keep this preset', 'Remove this entry', 'Remove this mount', aria-label 'Theme'·'Theme preview: …', 'Close the sidebar', 'Show everything that is running'(app-mobile.js:134) 가 요소를 만드는 자리에 바로 적혀 있다. 영어라는 점 자체는 FR-TIP-2 의 결정이라 결함이 아니다.
- **개선안**: 문자열을 constants.js 의 TIP_* 표로 옮기고, 같은 문구 중복('Delete this preset' 2회)을 합친다. 정적 검사 게이트는 추가하지 않는다(UX_BATCH5_SRS:600 의 결정).
- **이전 감사**: AUDIT-fe-core H2(인라인 5곳 부분)
- **결정 충돌**: FR-TIP-2 로 영어 툴팁은 의도된 것이므로 언어는 바꾸지 않는다.

### FEC-30 — architecture.md 의 core 구조 서술이 낡았다

`P3` · 문서괴리 · S · LOW · - · 확인 · 묶음키 `docs-sync`

- **위치**: `docs/internal/architecture.md:126`, `docs/internal/architecture.md:127`, `docs/internal/architecture.md:353`, `web/js/core/helpers.js:674`
- **근거**: 문서에는 'App 클래스 (app.js + 주제별 app-*.js 17)'(:126), 'constants{,-git,-editor}.js'(:127), '도구 타입은 terminal 과 editor 두 가지'(:353)라고 적혀 있다. 실제로는 app-*.js 가 41개, constants*.js 가 12개(-git-actions/-changes/-commit/-detect/-diff/-history/-refs/-remote, -docrender)다. TOOL_CAPABILITIES 에는 git 도 있고(helpers.js:674-678), 탭 타입은 run 까지 넷이다.
- **개선안**: 세 줄을 실제에 맞게 고친다. 파일 수는 손으로 세지 말고 파생 명령을 함께 적는다(refactor README §7.1 의 규약).

### FEU-31 — 쓰이지 않는 i18n 키(core.collapse·core.expand)를 게이트가 못 잡는다

`P3` · 문서괴리 · S · LOW · - · 확인 · 묶음키 `i18n-unused-gate`

- **위치**: `web/js/i18n/ko.js:112`, `web/js/i18n/ko.js:120`, `web/js/i18n/en.js:1`, `scripts/check-i18n.mjs:1`
- **근거**: ko 1111키를 전수 대조했더니 소스·HTML·e2e·단위 테스트 어디에도 문자열 'core.collapse'·'core.expand' 가 없다(err.* 27키는 api.js:157 의 'err.'+code 동적 참조라 제외). check-i18n.mjs 는 한글 리터럴과 ko/en 키 집합 일치만 본다('i18n ok — 한글 리터럴 0 · 카탈로그 1111 키 · 호출 1037'). 미사용 키는 재지 않는다.
- **개선안**: 두 키를 ko/en 에서 지운다. check-i18n 에 '정적 참조가 없고 동적 접두 등록부(err.·…)에도 없는 키' 를 경고하는 패스를 더한다.

### HTTP-20 — 죽은 코드·무의미 별칭·도달 불가 분기 일괄

`P3` · 가독성 · S · LOW · - · 확인 · 묶음키 `dead-code-sweep`

- **위치**: `internal/webserver/httpapi/server_middleware.go:59-61`, `internal/webserver/httpapi/handlers_ws.go:309`, `internal/webserver/httpapi/file_boundary.go:36-46`, `internal/webserver/httpapi/file_boundary.go:59-81`, `internal/webserver/seam/adapters/command.go:1-40`, `internal/webserver/seam/toolaccess/deps.go:65-88`, `internal/webserver/seam/adapters/tool.go:21-33`, `internal/webserver/seam/adapters/client.go:29`
- **근거**: loggingMiddleware 는 테스트(server_helpers_test.go:66)만 쓴다. readWSDirect 는 readWS 의 한 줄 별칭이다. fileAllow(p, _ bool) 는 불값을 무시하고 fileDenial.log 는 채우는 곳이 없다(파일 주석이 스스로 밝힘). adapters.Command 와 toolaccess.CommandBroadcaster·CmdResult·TabRef 는 비테스트 참조가 0이다. listPanes 의 Hub 분기는 List() 가 먼저 반환하므로 닿지 않는다. adapters.Client 는 Tool(r) 구조체 변환으로 메서드를 빌리는데, 그 의존이 어디에도 드러나지 않는다.
- **개선안**: loggingMiddleware·readWSDirect·adapters.Command·toolaccess 미사용 타입을 지운다. 테스트는 loggingMiddlewareFor(nil, …) 를 쓴다. fileAllow·fileGuard 에서 forWrite·log 를 없앤다. listPanes 를 PM.Snapshot() 만 남긴 pmSnapshot 으로 줄이고, Client 에 tools() Tool 헬퍼를 둔다.
- **이전 감사**: AUDIT-go-http L-1 · L-2 · L-3 · L-4 · L-5

### HTTP-30 — architecture.md 의 HTTP 계층 서술이 현재 코드와 어긋난다

`P3` · 문서괴리 · S · LOW · - · 확인 · 묶음키 `arch-doc-sync`

- **위치**: `docs/internal/architecture.md:63`, `docs/internal/architecture.md:159-162`, `internal/webserver/gitapi/routes.go:15-116`, `internal/webserver/httpapi/handlers_api.go:240-537`
- **근거**: architecture.md:63 은 '/api/git/* 핸들러 74개' 라고 적었지만, routes.go 에는 라우트 77개가 등록돼 있다. :161 의 'handlers_api.go 에는 라우트 테이블과 디스패처가 남는다' 와 달리, 그 파일에는 apiStateGet·apiToolsCreate·apiToolBusy/Delete·workspace GET/PUT·sandbox 5종·stats 핸들러와 reapSandboxes 가 있다.
- **개선안**: 수를 코드에서 세어 갱신하거나 '수를 적지 않는다' 로 바꾼다. handlers_api.go 서술을 실제 구성과 맞추거나, 도구·workspace·sandbox 핸들러를 handlers_tools.go·handlers_workspace.go·handlers_sandbox.go 로 옮겨 문서 서술을 참으로 만든다(권장: 후자, 파일 이동만).

### IPC-28 — toolclient 의 엉뚱한 자리에 붙은·끊긴 문서 주석과 paned/Pane/Tool 이 섞인 이름

`P3` · 가독성 · S · LOW · - · 확인 · 묶음키 `toolclient-doc-naming`

- **위치**: `internal/webserver/toolclient/client.go:336-339`, `internal/webserver/toolclient/client.go:428-434`, `internal/webserver/toolclient/client_push.go:178-179`, `internal/webserver/toolclient/client.go:21-34`, `internal/webserver/toolclient/client.go:141`
- **근거**: handlePush 설명이 call() 위에 있고, call 설명의 앞 절반은 client_push.go 끝에 매달려 있다. client.go 끝에는 Subscribe/OutChunk 설명 조각이 대상 없이 남아 있다. 상수는 panedCallTimeout 등, 생성자는 DialPaneClientWithReconnect, 오류 문구는 'paned connection lost' 로, 타입 이름 ToolClient 와 어휘가 갈린다.
- **개선안**: 주석을 원래 심볼 위로 옮기고 끊긴 문장을 합친다. 내부 이름은 tool* 로 바꾼다(와이어 타입 toolipc.Paned* 는 호환 표면이라 유지). 함수 선언 직전 주석의 첫 식별자를 검사하는 게이트를 둔다.
- **이전 감사**: AUDIT-go-http.md H-5, L-6

### SHR-21 — DONGMINAL_SHELL 은 Windows 에서만 먹히는데 문서는 모든 플랫폼에서 되는 것처럼 적는다

`P3` · 문서괴리 · S · LOW · B · 확인 · 묶음키 `shell-env-parity`

- **위치**: `internal/shared/platform/shell.go:271`, `internal/shared/platform/shell.go:174`, `docs/external/getting-started.md:326`
- **근거**: windowsShell.pick 만 DONGMINAL_SHELL 을 읽는다. posixShell.pick 은 $SHELL → 폴백 순으로만 고른다. getting-started.md 는 '도구 셸로 띄울 프로그램을 강제합니다'라고 플랫폼 제한 없이 적는다. 변수 이름도 dmenv 상수가 아닌 리터럴이다.
- **개선안**: 결정이 필요하다. ① posix 에도 같은 우선순위(DONGMINAL_SHELL → SHELL → 폴백)를 적용하거나, ② 문서에 'Windows 전용'을 명시한다. 어느 쪽이든 이름은 dmenv.EnvShell 상수로 옮긴다.
- **이전 감사**: AUDIT-go-infra #13, D4

### SHR-22 — persist.go 머리말과 architecture.md 가 SaveAll 동작·동시성 구조를 틀리게 적는다

`P3` · 문서괴리 · S · LOW · - · 확인 · 묶음키 `doc-drift-toolhub`

- **위치**: `internal/shared/toolhub/persist.go:14`, `docs/internal/architecture.md:1113`, `docs/internal/architecture.md:1114`, `docs/internal/architecture.md:1134`
- **근거**: persist.go:14 와 architecture.md:1134 는 '탭이 참조하는 도구만 기록된다'고 적는다. 실제 SaveAll 은 백그라운드(비소유)와 샌드박스만 빼고 모두 기록하며, 참조 필터는 LoadAll(FR-EM-14)에서 걸린다. architecture.md:1113 은 background 를 `map[string]BackgroundEntry` 라 적지만 실제는 `map[string]int64`(전환 시각)다. 1114행의 workspace.Manager 는 `atomic.Pointer[[]byte]+atomic.Uint64` 라 적지만 실제는 `atomic.Pointer[snap]`(raw 와 rev 를 한 쌍으로)다.
- **개선안**: 세 서술을 코드에 맞게 고친다. 기록은 '백그라운드·샌드박스 제외 전부, 참조 필터는 적재 시', background 는 map[id]since, workspace 는 (raw,rev) 쌍 포인터로 적는다.

### SHR-23 — 고아·어긋난 doc 주석과 죽은 오류 값 — 없는 필드와 없는 기능을 설명한다

`P3` · 가독성 · S · LOW · - · 확인 · 묶음키 `toolhub-comment-hygiene`

- **위치**: `internal/shared/toolhub/manager.go:128`, `internal/shared/toolhub/manager.go:162`, `internal/shared/toolhub/manager_create.go:59`, `internal/shared/toolhub/manager_create.go:75`, `internal/shared/toolhub/manager_create.go:112`, `internal/shared/platform/paths.go:280`, `internal/shared/toolhub/tool_control.go:15`
- **근거**: BackgroundEntry 안에 없는 `Kind` 필드의 주석(128-129)과 타입 없는 Placement 주석(162-166)이 남아 있다. 'Create spawns a new tool.' 이 ToolCap 의 doc 에 붙어 있다(59). ErrToolExists 주석은 존재하지 않는 `Placement.ReuseID` 를 가리키고, 이 값을 내는 검사(112)는 방금 만든 uuid 를 조회하므로 도달할 수 없다. paths.go:280-286 의 tempSibling 설명이 WriteFileAtomic 의 godoc 앞에 붙어 있다. tool_control.go:15-17 의 kill 설명이 terminateWait 의 doc 에 섞여 있다.
- **개선안**: 주석을 실제 선언 옆으로 옮기거나 지운다. ErrToolExists 와 그 검사는 지운다. go vet 과 godoc 출력으로 확인한다.
- **이전 감사**: AUDIT-go-infra #16

### SHR-34 — 도구 스트림 상한 bufMax 가 'Tool 을 모른다'는 conn.go 에 있고, 배경 프롬프트 표식이 두 목록에 중복돼 있다

`P3` · 가독성 · S · LOW · - · 확인 · 묶음키 `toolhub-comment-hygiene`

- **위치**: `internal/shared/toolhub/conn.go:63`, `internal/shared/toolhub/conn.go:14`, `internal/shared/agentadapter/claude.go:126`, `internal/shared/agentadapter/claude_decode.go:226`
- **근거**: conn.go 머리말은 '이 파일의 것들은 Tool 을 모른다'고 하는데, Tool 의 outbuf 크기인 bufMax(1MB)가 WS 타임아웃 상수 옆에 있다. claude 의 backgroundPromptMarks 와 claudeHarnessPrefixes 가 "<\task-notification>" 을 각자 들고 있어, 표식이 바뀌면 두 곳을 함께 고쳐야 한다.
- **개선안**: bufMax 는 tool.go(또는 outbuf 기본값)로 옮긴다. 두 표식 목록은 공통 상수(claudeTaskNotificationMark)를 함께 쓰도록 한다.

## 제외

| ID | 판정 | 제목 | 사유 |
|---|---|---|---|
| SHR-33 | INTENDED_DESIGN | 도구 히스토리 파일을 거두는 작업이 SRS 에 '별도 작업'으로만 남고 구현되지 않았다 — tool-history/ 가 계속 쌓인다 | docs/internal/TOOL_HISTORY_ISOLATION_SRS.md §6 비목표가 '회수·만료'를 명시적으로 제외한다('즉각적인 문제가 아니다… 필요해지면 별도 작업'). 미구현 결함이 아니라 의도된 범위 제외다. 하려면 SRS 개정이 먼저다. |
| FEU-30 | INTENDED_DESIGN | FR-GLY-4 문자 아이콘 교체 미완·V-4 문자 인벤토리 스크립트 부재 | UI_KIT_SRS.md:245 개정문 '글리프는 남는다 (사용자 결정)' 이 ★·▸·▾ 를 명시적으로 유지한다. ⚠ 는 §2.6 교체 표에 없다. 실제로 남은 위반은 file-tree-paint.js:851 `x.textContent='✕'` 하나뿐이다(§2.6 대상이고 유지 목록에 없다). V-4 의 문자 인벤토리 검사가 e2e·scripts 어디에도 없는 것은 사실이다. |
| IPC-26 | REFUTED | 브라우저 침묵 판정 45s 가 서버 hello 주기 15s 의 3배라는 사실이 언어를 넘어 암묵적으로 묶여 있다 | s.helloEvery 는 unexport 필드이고 비테스트 코드에서 설정하는 곳이 없다(server.go:127-129, commands.go:321 만 존재). 즉 운영 주기는 sseHelloEvery 상수 15s 로 고정이다. 45s 가 그 3배라는 관계는 constants.js:199-201 주석에 명시돼 있다. 한쪽만 바꿀 수 있다는 위험은 이론적인 수준이다. |
| DOM-28 | REFUTED | 잡 구독 채널 버퍼가 보존 상한(2000줄)과 같다 | Line 은 {Seq uint64, Stream string, Text string} 으로 약 40B 다. 채널 버퍼 2000칸은 약 80KB 이고, Text 문자열 바이트는 st.lines 와 공유되며 복사되지 않는다. 구독자당 수 MB 라는 근거는 과장이다. 게다가 Subscribe 는 재생을 채널에 select-default 로 넣으므로, 버퍼를 줄이면 재연결 재생분이 조용히 버려지는 퇴행이 생긴다. |

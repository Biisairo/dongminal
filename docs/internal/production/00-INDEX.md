# 00 — 감사 리포트 통합 인덱스

기계적 병합 문서. 새로운 분석·판단을 추가하지 않고 01~06 리포트의 발견을 재구성만 했다.
원본: `01-go-arch.md`(GO/01-Go) · `02-fe-arch.md`(FE/02-FE) · `03-uiux.md`(UX/03-UX) ·
`04-secops.md`(SEC/04-Sec) · `05-test.md`(TEST/05-Test) · `06-docs-hygiene.md`(DOC/06-Docs)

ID 규칙: `축약어-번호`. 원본에 명시된 순번이 아니라 이 문서에서 부여한 식별자다(원본은 항목 제목으로만 구분).
정렬: 심각도 내림차순(P0→P1→P2→P3), 동일 심각도 내 규모 오름차순(S→S/M→M→M/L→L, 원문에 규모 표기가 없는 항목은 "미표기"/"정보성"으로 표시하고 해당 tier 맨 뒤에 둠).

총 발견 수: **173건** (P0 8 · P1 41 · P2 122 · P3 2)

---

## 1. 통합 발견 목록

### P0 (8건)

| ID | 심각도 | 제목 | 주요 근거 위치 | 담당 축 | 규모 |
|---|---|---|---|---|---|
| FE-2 | P0 | 부팅 실패 시 워크스페이스를 빈 판으로 덮어씀 (데이터 손실) | `web/js/core/app.js:210-213`; 서버 `internal/shared/workspace/manager.go:212` | 02-FE | S |
| TEST-1 | P0 | `/api/file/write` 단위 테스트 0 · 경로 경계 검사 없음 | `internal/webserver/httpapi/handlers_files.go:362-388` | 05-Test | S |
| GO-1 | P0 | 브라우저 교차출처(CSWSH/CSRF)로 임의 명령 실행 — Origin·Content-Type·인증 검사 전무 | `internal/shared/toolhub/conn.go:37`; `handlers_runs_headless.go:45-97`; `handlers_files.go:362-390` | 01-Go | S/M |
| FE-1 | P0 | 터미널 출력 → 상태바 innerHTML로 스크립트 주입(XSS) | `web/js/core/app-statusbar.js:75-79,119-122`; `web/js/ui/term-pane.js:665-686` | 02-FE | S/M |
| SEC-1 | P0 | WebSocket Origin 미검증 → 임의 웹페이지가 터미널에 입력을 씀(CSWSH→RCE) | `internal/shared/toolhub/conn.go:34-37`; `handlers_ws.go:32,45,81-92,243-247` | 04-Sec | S/M |
| SEC-2 | P0 | 상태변경 HTTP API 전체가 CSRF 무방비 | `internal/webserver/httpapi/server.go:196-216`; `handlers_files.go:362-387`; `handlers_runs_headless.go:47-70` | 04-Sec | M |
| TEST-2 | P0 | 데몬 재기동 복원 경로(세션 생존)가 어느 층에서도 검증 안 됨 | `internal/daemon/boot/boot.go:29-51`; `toolhub/persist.go:94`; `manager.go:436` | 05-Test | M |
| TEST-3 | P0 | `stop`·포트킬 경로 테스트 0 — 운영 인스턴스 오살 재발방지 장치 없음 | `internal/ctl/cli/stop.go:9`; `proc.go:42,48,56` | 05-Test | M |

### P1 (41건)

| ID | 심각도 | 제목 | 주요 근거 위치 | 담당 축 | 규모 |
|---|---|---|---|---|---|
| GO-2 | P1 | `http.Server` 타임아웃 부재 + 비정상 종료(Close) | `internal/webserver/httpapi/server.go:220,238-241` | 01-Go | S |
| GO-3 | P1 | 요청 본문 크기 상한 부재 | `handlers_api.go:326`; `handlers_settings.go:91` 등 10곳 | 01-Go | S |
| GO-5 | P1 | `ToolClient.OnOutput/OnExit` 데이터 레이스(문서화된 채 방치) | `toolclient/client.go:89-91,279-280,341-347` | 01-Go | S |
| GO-7 | P1 | `readPTY` 패닉 시 도구가 반죽음 상태로 남음 | `shared/toolhub/tool.go:342-347` | 01-Go | S |
| GO-8 | P1 | IPC 경계에서 실패를 성공으로 응답 | `daemon/ipc/paned.go:258,294`; `manager_hub.go:21` | 01-Go | S |
| GO-10 | P1 | 영속 실패가 사용자에게 성공으로 보임 | `main.go:593`; `workspace/manager.go:139-148`; `access.go:135-137` | 01-Go | S |
| GO-11 | P1 | 문자열매칭 기반 에러분류 · 내부 오류문구 노출 | `toolhub/tool.go:352`; `handlers_api.go:276,436` | 01-Go | S |
| FE-7 | P1 | 조용히 삼켜지는 실패 — 설정저장·부팅설정·초기화 | `app-settings.js:15`; `main.js:14-21`; `app.js:210-213` | 02-FE | S |
| UX-1 | P1 | 확인창 두 벌의 Enter 규약이 정반대 — 실행 중 프로세스 오살 | `app-tool.js:366-392`; 대조 `git/confirm.js:203-210` | 03-UX | S |
| UX-5 | P1 | 정의되지 않은 토큰 `--bg-alt`를 4곳이 참조 | `style.css:137,531`; `style-git.css:557` | 03-UX | S |
| UX-7 | P1 | 모바일 터치 타겟이 44px 하한에 미달하는 자리 다수 | `style.css:1139,1134,1108,1041` | 03-UX | S |
| SEC-4 | P1 | `http.Server`에 타임아웃이 하나도 없음 | `internal/webserver/httpapi/server.go:220` | 04-Sec | S |
| SEC-5 | P1 | 요청 본문 크기 상한이 대부분의 종단에 없음(10곳) | `handlers_fs.go:93`; `handlers_files.go:363` 등 | 04-Sec | S |
| SEC-6 | P1 | 프로세스·구독 생성에 상한이 없음 | `toolhub/manager.go:357-397`; `hub/commands.go:177-183` | 04-Sec | S |
| SEC-8 | P1 | 로컬 권한경계 — 데몬 소켓·홈·로그가 다른 사용자에게 열림 | `platform/ipc.go:49-51`; `daemon/ipc/paned.go:437-446` | 04-Sec | S |
| SEC-9 | P1 | Host 헤더 미검증 — DNS rebinding으로 Origin 방어 우회 가능 | (요청 헤더 검사 전무, `ACCESS_ALLOWLIST_SRS.md §5-3`) | 04-Sec | S |
| TEST-4 | P1 | CI 단위테스트가 `./web/...`를 건너뜀 | `.github/workflows/verify.yml:53`; `release.yml:51` | 05-Test | S |
| DOC-5 | P1 | LICENSE 파일과 README 라이선스 절이 모두 없음 | README.md 전문 검색 0건; LICENSE 파일 부재 | 06-Docs | S |
| SEC-3 | P1 | `--expose`/`DONGMINAL_HOST`는 무인증·평문·ACL 기본꺼짐으로 PTY를 LAN에 염 | `ctl/cli/start.go:36-42`; `access.go:80-104` | 04-Sec | S/M |
| GO-4 | P1 | 프로세스 축 의존 규칙 위반 — 문서와 실제 import 그래프 불일치 | `shared/runtime→helper/runtimebin`; `daemon/boot→webserver/domain/run` | 01-Go | M |
| GO-6 | P1 | 데몬모드 `Get/IsLive/Has`가 매번 전체 `list` RPC — O(N) 왕복 | `toolclient/client.go:549-559,572-574` | 01-Go | M |
| GO-9 | P1 | 패키지 전역 가변상태 + 전역뮤텍스가 네트워크 I/O를 감쌈 | `handlers_fs.go:391`; `handlers_runs_context.go:80` | 01-Go | M |
| GO-12 | P1 | 요청 고루틴 안의 `time.Sleep` 폴링 — 컨텍스트 취소 미전파 | `handlers_runs.go:364-379`; `handlers_runs_headless.go:232-244` | 01-Go | M |
| GO-13 | P1 | 핵심 인터페이스 `ToolHub.List()`가 `[]map[string]interface{}` | `shared/toolhub/hub.go:6` | 01-Go | M |
| FE-5 | P1 | 린트·타입 안전망 전무(35k LOC) | 루트에 eslint/tsconfig 없음; `verify.yml` | 02-FE | M |
| FE-6 | P1 | Monaco를 런타임에 외부 CDN에서 받음(오프라인 불가) | `web/js/ui/file-editor.js:5,64-81` | 02-FE | M |
| FE-8 | P1 | fetch 관용구 중복 — `gitFetch`가 있는데 core는 손으로 23벌 | core/ui `await fetch(` 51곳 | 02-FE | M |
| UX-2 | P1 | 창 `×`는 확인 없이 세션을 kill하고 되돌릴 길이 없음 | `app-layout.js:167-215`; `sidebar-list.js:130-139` | 03-UX | M |
| UX-3 | P1 | 설정 모달에 다이얼로그 시맨틱·포커스 관리가 없음 | `index.html:212-235`; `app-settings.js:445-484` | 03-UX | M |
| UX-6 | P1 | 보조 텍스트 색 대비가 WCAG 기준에 크게 미달 | `style.css:12-14,942`; `style-kit.css:167` | 03-UX | M |
| UX-8 | P1 | 사용자 피드백이 스크린리더에 전달 안 됨 — 라이브 리전 0개 | `aria-live` 검색 0건; `toast.js` | 03-UX | M |
| SEC-7 | P1 | `/api/file/{read,write,raw,probe}`·upload·download가 파일시스템 전체를 염 | `handlers_files.go:325-355,362-387` | 04-Sec | M |
| TEST-5 | P1 | flaky가 회차마다 자리를 바꿈 — 계통결함을 `retries:1`이 초록으로 만듦 | `playwright.config.ts:52-70` | 05-Test | M |
| TEST-6 | P1 | e2e가 프론트 내부(private) 상태에 결합 — 리팩터 비용이 테스트로 전가 | `app._xxx` 533회/81파일 | 05-Test | M |
| TEST-7 | P1 | 스펙이 기능이 아니라 납품 묶음 단위로 갈라짐 | `ux-batch6/8/9.spec.ts`; `git-ui-revision.spec.ts`(1,246줄) | 05-Test | M |
| TEST-8 | P1 | Go 프로세스·PTY 테스트가 고정 `time.Sleep` 위에 있음 | `time.Sleep` 94회/25파일 | 05-Test | M |
| DOC-2 | P1 | `commands.md`가 `dmctl` 서브커맨드 절반 가까이 미문서화 | `internal/helper/runtimebin/dmctl.go:36-57` | 06-Docs | M |
| FE-3 | P1 | 전역 스크립트 93개 · 암묵적 로드순서 · ~1,600개 전역 바인딩 | `index.html:470-594` | 02-FE | M(검사기)/L(모듈전환) |
| FE-4 | P1 | 계층 역전 — ui/·git/이 App의 `_private`를 직접 파고듦 | `ui/renderer.js`(54개 `_xxx` 참조) | 02-FE | L |
| UX-4 | P1 | 목록·탭·카드가 전부 `div` — Tab 순회·스크린리더 불가 | `sidebar-list.js:97`; `renderer.js:894` | 03-UX | L |
| DOC-4 | P1 | `api.md`가 실제 HTTP 표면 절반 이상을 누락(Git API 60+, Run API 13) | `gitapi/routes.go:16-88`; `handlers_api.go:91-178` | 06-Docs | L |

### P2 (122건)

> 항목이 많아 규모(S→S/M→M→L→기타) 순으로 묶었다. 각 소그룹 내부는 축(01→06) 순.

**S (80건)**

| ID | 제목 | 주요 근거 위치 | 축 |
|---|---|---|---|
| GO-14 | `handlers_fs.go` 775줄 — fs조작과 `/api/editors/*` 혼재 | `httpapi/handlers_fs.go:1-663,665-775` | 01-Go |
| GO-15 | `tool.go` 774줄 — PTY 수명과 주의상태기 혼재 | `shared/toolhub/tool.go:245-376,398-603` | 01-Go |
| GO-18 | `worktree.go` 701줄 — git실행·정리규칙·파서 혼재 | `domain/worktree/worktree.go`; `:600` | 01-Go |
| GO-19 | runtimebin/ctl 거대함수 3건 | `dmctl_run.go:521`; `dmctl_listworkspace.go:16`; `migrate/identity.go:44` | 01-Go |
| GO-20 | `ctl/cli/doctor.go` 685줄 — 진단항목 11개 순차함수 | `ctl/cli/doctor.go` | 01-Go |
| GO-21 | `toolclient/client.go` `handlePush` 86줄 switch | `toolclient/client.go:263-349` | 01-Go |
| GO-22 | `paned.go` 핸들러 12개가 디코드+에러코드 중복 | `daemon/ipc/paned.go:184-364` | 01-Go |
| GO-23 | JSON 응답조립·에러렌더러 5종 중복 | (`Content-Type` 설정 36곳; `writeToolIOError` 등) | 01-Go |
| GO-24 | `dataPath` 중복 구현 | `main.go:41-47`; `toolhub/manager.go:312-318` | 01-Go |
| GO-25 | `HeadlessToolIDs`가 부팅 중 두 번 읽힘 | `main.go:226,236`; `boot.go:71,73` | 01-Go |
| GO-26 | 스냅샷 전송 프레이밍 중복 | `handlers_ws.go:113-123,174-186` | 01-Go |
| GO-27 | 준비대기 폴링루프 중복(`pollUntil` 부재) | `main.go:108-115`; `start.go:236-244`; `proc.go:56-71` | 01-Go |
| GO-28 | 기본 터미널 크기 `120×40` 리터럴 3곳 | `manager_hub.go:96`; `persist.go:115` | 01-Go |
| GO-29 | `Create`가 쓰기락을 쥔 채 `StartTool`(fork/exec) 수행 | `toolhub/manager.go:377-384` | 01-Go |
| GO-30 | onExit 클로저가 `invalidator`를 락 없이 읽음 | `manager.go:379-383,439-443` | 01-Go |
| GO-31 | `tool.Restored` 일반 bool을 동시 WS 두 개가 읽고 씀 | `handlers_ws.go:125-126` | 01-Go |
| GO-32 | `ClearAllAttention`이 락 쥔 채 `Broadcast` 호출(규약 불일치) | `hub/attn_tracker.go:294-306` | 01-Go |
| GO-33 | `gitwatch.go`의 `context.Background()` — 종료 시 취소 불가 | `hub/gitwatch.go:291` | 01-Go |
| GO-34 | `OnIndexUpdate`를 `m.mu` 안에서 호출 — 재진입 데드락 위험 | `shared/workspace/manager.go:227-232` | 01-Go |
| GO-35 | 호출마다 `time.After` 타이머 생성(미회수) | `toolclient/client.go:416` | 01-Go |
| GO-36 | pidfile `os.WriteFile` 반환값 폐기 | `daemon/ipc/paned.go:446` | 01-Go |
| GO-37 | PTY 청크마다 두 번 복사 | `toolhub/tool.go:365,367` | 01-Go |
| GO-38 | `apiFileRead`가 `io.Copy` 반환 무시·크기 상한 없음 | `handlers_files.go:325-355` | 01-Go |
| GO-40 | 매직 리터럴 상수화 안 됨(3s, 20/100ms, 50ms 등) | `main.go:90,108-109`; `tool.go:746` | 01-Go |
| GO-41 | 환경변수 기반 런타임설정이 여러 곳에 분산 | `hub/commands.go:96-103`; `toolhub/attention.go` | 01-Go |
| GO-45 | `deps.go`의 `SettingsStore`가 비공개 메서드만 가짐 — 주입표면 무의미 | `httpapi/deps.go:63-67` | 01-Go |
| GO-48 | `architecture.md` 패키지 표에 11개 패키지 누락 | `docs/internal/architecture.md:49-116` | 01-Go |
| FE-9 | `constants-git.js` 1282줄 — 문구·CSS맵·상수 혼재 | `core/constants-git.js` | 02-FE |
| FE-12 | `app-settings.js` 1000줄 — 무관한 패널 4개 혼재 | `core/app-settings.js` | 02-FE |
| FE-14 | `ui/renderer.js`의 `render()`가 54개 호출지점에서 합쳐지지 않음 | `ui/renderer.js:134-160` | 02-FE |
| FE-15 | `_confirmClose`가 이스케이프 없이 innerHTML(잠재 XSS) | `core/app-tool.js:369-378` | 02-FE |
| FE-16 | `escHtml` 사용이 불균일 — `git/`에는 0건 | `core/app-lsp.js` 등 vs `git/*` | 02-FE |
| FE-17 | `_aclYou`(서버 신뢰값)를 innerHTML에 연결 | `core/app-settings.js:981` | 02-FE |
| FE-24 | 이벤트버스 토픽 문자열 하드코딩 | `app-cmd.js:64-78`; `state-registry.js:43-126` | 02-FE |
| FE-25 | `visiblePoll`과 `TIMERS.every` 표면이 중복 | `helpers.js:752` | 02-FE |
| FE-29 | e2e만이 유일한 검증 — 순수 모듈 단위테스트 0 | `hunk-coords.js`, `lanes.js` 등 | 02-FE |
| UX-9 | `<html lang="en">`인데 UI 대부분 한국어 | `index.html:2` | 03-UX |
| UX-10 | 검색 입력에 라벨 없음 | `index.html:192` | 03-UX |
| UX-11 | 시각전용정보 — CSS `content` 문구·색만으로 전달되는 상태 | `style.css:376,772,818` | 03-UX |
| UX-12 | `prefers-reduced-motion`이 일부 애니메이션만 덮음 | `style.css:578-579,737-738,1057` | 03-UX |
| UX-13 | 포커스 표시가 키트 밖 컨트롤에는 없음 | (`outline:none` 17곳 vs `:focus-visible` 9곳) | 03-UX |
| UX-14 | 위험색·상태색이 Tokyo Night 값으로 하드코딩(테마 무시) | `style-kit.css:84-85,149`; `style.css:85,845` | 03-UX |
| UX-15 | 라이트 테마에서 사라지는 구분선 | `style.css:728,853,929` | 03-UX |
| UX-21 | 툴팁의 단축키 표기가 정적 — 재바인딩하면 거짓이 됨 | `index.html:166-167,179,181` | 03-UX |
| UX-22 | 단축키 발견 가능성 낮음 — 진입점이 설정 하나뿐 | `index.html:220` | 03-UX |
| UX-23 | 드래그 가능 요소에 사전 어포던스가 없음 | (`cursor:grab` 검색 0) | 03-UX |
| UX-24 | 탭 줄 오버플로가 보이지 않음 | `style.css:410-415` | 03-UX |
| SEC-10 | `DONGMINAL_HOST`로 조용한 노출(환경변수만으로 0.0.0.0) | `ctl/cli/start.go:37-39` | 04-Sec |
| SEC-11 | ACL fail-open — `access.json` 깨지면 꺼진 채로 기동 | `access.go:88-99` | 04-Sec |
| SEC-12 | 정적 UI에 보안 헤더 없음(CSP·X-Frame-Options) | `static.go:51-68` | 04-Sec |
| SEC-14 | submodule/worktree `execGit`이 화이트리스트 초크포인트를 안 지남 | `server.go:392-402`; `submodule.go:268-283`; `worktree.go:160-175` | 04-Sec |
| SEC-15 | git `repo` 파라미터가 임의 절대경로를 허용 | `gitapi/handlers_git_write.go:354-384` | 04-Sec |
| SEC-16 | 플러그인 매니페스트가 사용자 편집 가능·실행경로 불명확 | `ext/install.go:72-80`; `ext/manifest.go:211-215` | 04-Sec |
| SEC-17 | 오류 문자열을 그대로 응답 본문에 실음 | `handlers_api.go:276`; `handlers_files.go:346,385` | 04-Sec |
| SEC-18 | 로그에 명령 전문이 남음(토큰 노출 가능) | `handlers_runs_headless.go`; `commands.go:183,199` | 04-Sec |
| SEC-19 | `apiFileRead` 파일 크기 무제한 | `handlers_files.go:353-354` | 04-Sec |
| SEC-20 | zip 다운로드 동시 요청 상한 없음 | `handlers_fs_zip.go:33,104` | 04-Sec |
| SEC-21 | `settings.json` 본문 미검증(JSON 아니어도 저장) | `handlers_settings.go:90-95` | 04-Sec |
| SEC-25 | `daemon.log` 크기 상한 미적용(추정, §6 미확인과 중복) | `main.go:131-137,553` | 04-Sec |
| SEC-26 | 헬스·메트릭 종단 부족 | `handlers_api.go:354`; `health.go:19-49` | 04-Sec |
| SEC-27 | 설정파일 스키마·버전 없음(상위판 다운그레이드 미감지) | `access.go:41-45`; `workspace/manager.go:541` | 04-Sec |
| SEC-28 | 취약점 스캐너 없음(govulncheck 등) | `.github/`, `scripts/` 부재 | 04-Sec |
| SEC-29 | GitHub Actions를 태그로 참조(SHA 미고정) | `release.yml:42-43,88,130` | 04-Sec |
| SEC-30 | 재현 가능 빌드 미설정(`-trimpath` 없음) | `scripts/build.sh:88-89` | 04-Sec |
| SEC-32 | `web/vendor` 제3자 JS 버전 추적 없음 | `web/vendor/` | 04-Sec |
| TEST-9 | 린터 없음(golangci-lint/staticcheck) | `verify.yml:46` | 05-Test |
| TEST-10 | gofmt 게이트 없음(현재 1건 위반) | `domain/lsp/session.go` | 05-Test |
| TEST-11 | e2e TypeScript 타입검사·린트 없음(`: any` 595회) | `e2e/*.ts` | 05-Test |
| TEST-12 | 커버리지 측정·문턱 없음 | (워크플로우 전체) | 05-Test |
| TEST-13 | darwin 단위테스트는 릴리스 때만 | `release.yml:31` | 05-Test |
| TEST-14 | `-shuffle` 없음(`t.Parallel()` 0건) | (314 테스트파일) | 05-Test |
| TEST-15 | `e2e.yml` 주석이 실제 설정과 어긋남 | `e2e.yml:37,57`; `playwright.config.ts:41-46` | 05-Test |
| TEST-19 | `git-repo-missing.spec.ts`가 e2e 전체 시간의 1/3을 먹음 | `git-repo-missing.spec.ts`(합 249s) | 05-Test |
| TEST-21 | git 픽스처가 호스트 gitconfig를 그대로 봄 | `git_fixture.sh:47-52` | 05-Test |
| TEST-23 | 저장소 픽스처 7벌 중복 | `handlers_fs_ignored_test.go:50` 등 | 05-Test |
| TEST-24 | git 쓰기도메인 0% 함수(`Merge`/`Replay` 등) | `git/write/branch.go:444`; `replay.go:27` | 05-Test |
| TEST-25 | 호스트 셸 의존(toolhub 테스트) | `platform/shell.go:142-145` | 05-Test |
| TEST-26 | 전역 훅 교체(`attnNow` 등, 병렬화 시 취약) | `attention_*_test.go` | 05-Test |
| TEST-29 | e2e CI 매트릭스 샤드 수 재검토 필요 | `e2e.yml:66-77` | 05-Test |
| DOC-3 | `shortcuts.md`에 `sidebarToggle`·`edSave` 누락 | `web/js/core/helpers.js:262,281` | 06-Docs |

**S/M 계열 (3건)**

| ID | 제목 | 주요 근거 위치 | 축 | 규모 |
|---|---|---|---|---|
| TEST-17 | 헬퍼 중복(`enter`×15, `goto`×11 등) | e2e 스펙 지역 함수 | 05-Test | S–M |
| TEST-27 | 프론트엔드 단위테스트 부재(순수모듈 6종) | `hunk-coords.js`; `timer-hub.js`; `lanes.js` | 05-Test | S(하네스)+M(모듈) |
| DOC-7 | 린터 설정(golangci-lint/eslint/prettier)·`.editorconfig` 부재 | (설정파일 부재 전반) | 06-Docs | S(.editorconfig)/M(린터전체) |

**M (25건)**

| ID | 제목 | 주요 근거 위치 | 축 |
|---|---|---|---|
| GO-16 | `main.go` `serve` 158줄 + `buildDeps` 3벌 — 조립/기동/종료 미분리 | `cmd/dongminal/main.go:209-396,442-600` | 01-Go |
| GO-17 | `handlers_runs.go` 710줄 — workspace 조작 책임 혼재 | `httpapi/handlers_runs.go:223,428,560-710` | 01-Go |
| GO-39 | git 실행기 4벌 — `core.Env()` 미공유(자격증명 프롬프트 매달림 위험) | `worktree.execGit:159-174`; `submodule.go:275`; `job.go:515` | 01-Go |
| GO-42 | 패키지 변수 테스트훅이 전역(`t.Parallel` 방해) | `toolhub/tool.go:128`; `foreground.go:42` | 01-Go |
| GO-43 | 로깅 `log.Printf` 146곳 비구조화(slog 없음) | (전역) | 01-Go |
| GO-44 | `httpapi/deps.go`가 구체 포인터 주입 — 테스트가능성 저하 | `httpapi/deps.go:79,90,94,99,108` | 01-Go |
| GO-46 | 데몬모드 판별이 타입단언으로 새어나감 | `handlers_ws.go:60,158`; `handlers_api.go:247` | 01-Go |
| GO-47 | `ToolHub.Get(id) *Tool` 구체타입 반환(데몬모드 합성 Tool) | `hub.go:11-19` | 01-Go |
| FE-10 | `git/history.js` 1274줄 — 4책임 혼재 | `git/history.js` | 02-FE |
| FE-11 | `core/app-editor.js` 1155줄 — 67메서드가 `App.prototype`에 | `core/app-editor.js` | 02-FE |
| FE-13 | `git/branches.js` 990줄 — 클래스 4개 + 400줄 메서드 | `git/branches.js:18,395-799,800,900,941` | 02-FE |
| FE-23 | 설정이 전역 `var` 26개에 분산·서술자표 부재 | `helpers.js`; `constants.js`; `app-settings.js:321-436` | 02-FE |
| UX-17 | 버튼 외형 선언이 키트 밖에 6벌 이상 | `style.css:338-342,1038-1045` 등 | 03-UX |
| UX-18 | 글자 크기 12종이 토큰 없이 산재 | (font-size 분포 실측) | 03-UX |
| UX-19 | 시스템 다크/라이트 추종 없음 | (`prefers-color-scheme` 검색 0) | 03-UX |
| UX-20 | 한국어·영어 혼용이 규칙 없이 섞임 | `index.html:166-184,268,274,286,294` | 03-UX |
| UX-25 | 파일 삭제가 영구 — 되돌릴 길이 없음 | `file-tree-edit.js:193-211` | 03-UX |
| UX-26 | 컨텍스트 메뉴 두 벌의 동작이 다름 | `ui-kit.js:199-255`; `git/menu.js:340-415` | 03-UX |
| SEC-23 | 웹서버 프로세스 자체를 감독하는 것이 없음 | `start.go:105-145` | 04-Sec |
| SEC-24 | 로그가 stdlib `log` 비구조화·단일레벨 | `main.go:403` | 04-Sec |
| SEC-31 | 체크섬 미서명(cosign/GPG/provenance 없음) | `release.yml:149` | 04-Sec |
| TEST-16 | 하드코딩 대기 224회/40파일(≈197s) | `waitForTimeout` 전수 | 05-Test |
| TEST-20 | 파일 내 순서 의존이 병렬화를 막음 | `playwright.config.ts:83-93` | 05-Test |
| DOC-1 | SRS 113개 중 106개(94%)에 구현상태 판별 필드 없음 | `docs/internal/*_SRS.md` | 06-Docs |
| DOC-6 | git 히스토리에 옛 9MB 바이너리 반복커밋(팩 79.67MiB 팽창) | `remote-terminal`(29커밋); `bin/dongminal`(2커밋) | 06-Docs |

**L (2건)**

| ID | 제목 | 주요 근거 위치 | 축 |
|---|---|---|---|
| UX-16 | 모달/오버레이 골격 7벌 · z-index 스택 비체계(28종) | `style.css:590`; `style-kit.css:114` 등 | 03-UX |
| TEST-18 | 셀렉터 전략 — `data-testid` 0, CSS 클래스 2,266 | (셀렉터 실측) | 05-Test |

**기타(원문 규모 미표기 / 정보성, 12건)**

| ID | 제목 | 주요 근거 위치 | 축 | 비고 |
|---|---|---|---|---|
| FE-18 | 사이드바 폭 100/400 리터럴 3곳 | `index.html:27`; `app.js:171`; `app-cmd.js:370` | 02-FE | 미표기 |
| FE-19 | 저장소 키 리터럴(`'sidebarWidth'` 등) 산재 | `index.html:27`; `input-binding.js:110` | 02-FE | 미표기 |
| FE-20 | `getElementById` 182회 전부 리터럴 | (전역) | 02-FE | 미표기 |
| FE-21 | cwd 홈경로 축약이 macOS 전용 정규식 | `app-statusbar.js:72` | 02-FE | 미표기 |
| FE-22 | `_fmtBytes` 두 벌 + `ETag` 헤더 이중조회 | `file-editor.js:294`; `app-statusbar.js:316` | 02-FE | 미표기 |
| FE-26 | 폴링 최소간격 1초·상태바 3초마다 2요청 | `app-polling.js:30-70`; `app-statusbar.js:33-44` | 02-FE | 미표기 |
| FE-27 | `render()` 디바운스 없음(A-6 거대모듈 항목 참조) | `git/panel-poll.js:225` | 02-FE | 미표기 |
| FE-28 | xterm scrollback 50000 × 슬롯 인스턴스, 메모리 상한 없음 | `constants.js:246` | 02-FE | 미표기 |
| SEC-13 | 헤드리스 `command`가 설계상 셸 문자열 | `toolhub/manager.go:416-419` | 04-Sec | SEC-2(P0-2)에 포함, 별도조치 불요 |
| SEC-22 | `apiUpload`의 `dir` 상대경로 기본 "."(서버 cwd) | `handlers_files.go:177-188` | 04-Sec | 미표기, 기능성 성격 |
| TEST-22 | 표 기반 테스트 비율 낮음(`[]struct{` 24/314) | (Go 테스트 전반) | 05-Test | 정보성 |
| TEST-28 | Go 테스트 직렬 214s(패키지간 병렬로 체감 ~60s) | (`go test` 실측) | 05-Test | 정보성 |

### P3 (2건)

| ID | 제목 | 주요 근거 위치 | 축 | 규모 |
|---|---|---|---|---|
| DOC-8 | 이슈/PR 템플릿 부재 | `.github/`에 `workflows/`만 존재 | 06-Docs | S |
| DOC-9 | `v1` 태그가 SemVer 미준수·CHANGELOG 미대응(실무영향 낮음) | git tags; `CHANGELOG.md` | 06-Docs | S |

---

## 2. 중복·교차 확인 섹션

팀장이 제시한 6쌍 + 리포트를 다시 읽으며 찾은 4쌍, 총 10쌍.

| 쌍 | 항목 | 같은 코드 지점/근본원인 | 판정 |
|---|---|---|---|
| (a) | GO-1 ↔ SEC-1 | `internal/shared/toolhub/conn.go:37` `CheckOrigin` 항상 true | **한 수정으로 함께 해소** — `CheckOrigin` 복원 하나가 양쪽 기술 |
| (b) | GO-2 ↔ SEC-4 | `httpapi/server.go:220` `http.Server` 타임아웃 부재 | **한 수정으로 함께 해소** — 동일 3줄 설정 |
| (c) | GO-3 ↔ SEC-5 | 요청 본문 크기 상한 부재(10곳 grep 동일) | **한 수정으로 함께 해소** — 공통 `readJSON(limit)` 헬퍼 하나 |
| (d) | FE-15 ↔ UX-1 | `app-tool.js:369-378`(`_confirmClose`) — 이스케이프(FE) vs Enter 규약(UX), 이유는 다름 | **한 수정으로 함께 해소 가능** — `_confirmClose`를 `GitConfirm`/`UIKit.modal` 규약으로 재작성하면 두 결함(innerHTML 미이스케이프 + 위험버튼 기본포커스) 모두 사라짐 |
| (e) | GO-1 · SEC-2 · SEC-7 · TEST-1 | `/api/file/write`(`handlers_files.go:362-390`) — CSRF 노출(GO/SEC)과 테스트0·경계없음(TEST) | **부분적으로 별개 수정 필요** — CSRF 게이트(SEC-2, GO-1의 일부)는 상태변경 API 공통 미들웨어로 함께 닫히지만, 루트 경계 검사·회귀테스트(TEST-1)는 이 엔드포인트 전용 추가 작업이 별도로 필요 |
| (f) | FE-5 ↔ TEST-9/TEST-11 | CI 게이트 부재 — FE-5는 "Playwright가 CI에 없다"를 언급, TEST-9(Go 린터 없음)·TEST-11(e2e TS 타입검사·린트 없음)이 동일 공백을 구체화 | **부분적으로 별개 수정 필요** — TEST-9(Go)는 별도 스텝, TEST-11(TS)은 FE-5와 동일 인프라(정적분석) 구축으로 함께 해소 |
| (g) | GO-39 ↔ SEC-14 | `worktree.execGit`(`worktree.go:159-175`)·`submodule.go:268-283` — git 실행기가 화이트리스트 초크포인트(`core.Env()`)를 안 지남 | **한 수정으로 함께 해소** — `core.Env()` 공유 또는 `ExecRaw` 개방 하나로 두 리포트가 요구하는 조치가 동일 |
| (h) | GO-11 ↔ SEC-17 | `handlers_api.go:276,436` `http.Error(w, err.Error(), 500)` | **한 수정으로 함께 해소** — 동일 코드지점, 코드화된 메시지로 교체 |
| (i) | FE-1 ↔ SEC-12 | CSP 부재 — FE-1의 2차 방어 제안("index.html에 CSP를 Go쪽과 협의")과 SEC-12("정적 UI에 보안헤더 없음") | **한 수정으로 함께 해소** — CSP 헤더 도입 하나가 두 리포트의 요구를 동시에 충족 (단, FE-1의 1차 방어인 싱크 이스케이프는 별개 수정 필요) |
| (j) | FE-5 ↔ TEST-27 | 프론트 정적분석·단위테스트 인프라 부재 — FE-5(전반적 린트/타입 안전망), TEST-27(순수모듈 6종 구체 목록: `hunk-coords.js`·`timer-hub.js`·`lanes.js` 등) | **한 묶음으로 함께 진행 권장** — 별개 코드지점이지만 같은 인프라 투자(node:test 하네스 + jsconfig/eslint)로 동시 해소 |

---

## 3. 단일 수정으로 다수 해소되는 묶음

| 묶음 | 포함 ID | 조치 | 합산 규모 |
|---|---|---|---|
| **B1. Origin/CSRF/Host 통합 게이트** | GO-1, SEC-1, SEC-2, SEC-9 | `Handler()` 체인에 Origin/Host/Sec-Fetch-Site/Content-Type 검사 미들웨어 1개 + `CheckOrigin` 복원 (04 리포트가 스스로 "P0-1+P0-2+P1-7을 한 게이트로" 제안) | M |
| **B2. `/api/file/write` 루트가드 + 회귀테스트** | TEST-1, SEC-7(부분) | 워크스페이스/에디터 루트 대조 추가 + RED→GREEN 테스트 5종 | S+S |
| **B3. `http.Server` 타임아웃 설정** | GO-2, SEC-4 | `ReadHeaderTimeout`·`IdleTimeout` 3줄 | S |
| **B4. 공통 JSON 디코더 도입** | GO-3, SEC-5 | `http.MaxBytesReader` 포함한 `readJSON(limit)` 헬퍼 하나로 통합(B1의 미들웨어와 같은 자리에 둘 수 있음) | S |
| **B5. git 실행기 `core.Env()` 통합** | GO-39, SEC-14 | worktree/submodule 실행기가 화이트리스트·자격증명 매달림 방지 환경을 공유하도록 재사용 | S/M |
| **B6. 에러 응답 코드화** | GO-11, SEC-17 | `http.Error(w, err.Error(), 500)` 패턴을 고정 문구+로그로 교체 | S |
| **B7. CSP 헤더 도입** | SEC-12, FE-1(2차 방어분) | `index.html`·정적 응답에 `Content-Security-Policy`·`X-Frame-Options` 부여 | S |
| **B8. `_confirmClose` 재작성** | FE-15, UX-1 | `UIKit.modal`/`GitConfirm` 규약으로 통일(초기포커스 취소, Enter≠실행, textContent) | S |
| **B9. 프론트 정적분석·단위테스트 인프라** | FE-5, TEST-11, TEST-27 | `jsconfig.json`+`@ts-check`, eslint 최소규칙, `node:test` 하네스로 `hunk-coords.js`·`timer-hub.js`·`lanes.js` 검사 | M |

---

## 4. 축별 통계

| 축 | P0 | P1 | P2 | P3 | 합계 |
|---|---|---|---|---|---|
| 01-Go (GO) | 1 | 12 | 35 | 0 | 48 |
| 02-FE (FE) | 2 | 6 | 21 | 0 | 29 |
| 03-UX (UX) | 0 | 8 | 18 | 0 | 26 |
| 04-Sec (SEC) | 2 | 7 | 23 | 0 | 32 |
| 05-Test (TEST) | 3 | 5 | 21 | 0 | 29 |
| 06-Docs (DOC) | 0 | 3 | 4 | 2 | 9 |
| **합계** | **8** | **41** | **122** | **2** | **173** |

(SEC 축 P2는 원본 요약표가 "22"로 적었으나, 개별 항목을 모두 세면 23건이다 — 원본 bullet 수 그대로 옮긴 결과이며 임의 조정 아님.)

---

## 5. 양호 판정 목록 (작업 범위에서 제외할 근거)

- **git 실행 초크포인트**(`domain/git/core`) 정적검사·화이트리스트·자격증명 마스킹 — 01 서두 강점, 04 §5 재확인 (`core/exec.go:200-224`, `GIT_TERMINAL_PROMPT=0` 등)
- **`go vet ./...` / `go build ./...` clean**, `go test -race`(toolclient·toolhub·hub·workspace) 전부 pass — 01 부록
- **외부 명령 실행 안전성** — 셸 경유는 저장소 전체에서 헤드리스 명령 1곳뿐, 나머지 `exec.Command*` 17곳은 인자배열 전달(01 "외부 명령 실행" 확인완료 항목)
- **git 자격증명 취급 양호** — `GIT_TERMINAL_PROMPT=0`, `GIT_ASKPASS=`, URL userinfo 마스킹, 추적된 시크릿 없음(04 §4.3)
- **기본값은 안전** — 바인드 127.0.0.1, ACL 꺼짐(노출 시에만 위험), 포트범위 검증, `--isolated` 구조적 보호(04 §4.6)
- **미들웨어 체인이 한 자리, ACL이 RemoteAddr만 신뢰·프록시헤더 무시, `/api/fs/*` 심볼릭링크 실제로 품, 업로드 MaxBytesReader, 패닉그물 SSE/WS 구분, 재연결폭주·미스홀드 상한** — 04 §5 전체
- **릴리스 산출물이 3 OS 게이트를 지남, `verify`가 격리 인스턴스만 겨눔** — 04 §5
- **이벤트 리스너 누수 없음** — `addEventListener` 375 vs `removeEventListener` 19이지만 검사 결과 앱수명/`{once:true}`/짝맞음 확인, 요소수준은 DOM과 GC — 02 "F. 이벤트 리스너" 확인결과 양호
- **폴링 구조(TimerHub) 양호** — 숨김 시 정지·복귀 시 1회 보상, 항목단위 reconcile로 리페인트 억제 — 02 "E. 성능·폴링" 1번
- **파괴적 git 동작 확인창 설계 — 모범사례** — 정책서버 소유, 취소기본, Enter≠실행, 영향목록+복구힌트+stderr 복사, `UIKit.button`이 이름없는 아이콘버튼 생성을 막음, 아이콘 스프라이트 `currentColor`로 44개 테마 자동대응, 부팅화면 FOUC 제거, 닫기 전 dirty·busy 이중가드, 모바일 소프트키보드 보정 — 03 §4 "잘 되어 있는 것" 7건
- **성능 체감 — P1/P2 발견 없음**(History 윈도잉, Diff Monaco, Console 500줄 제한, 탐색기 폴더단위 로드) — 03 §3.7 결론
- **Go 커버리지 다수 패키지 고득점**(`toolline`·`outbuf`·`apierr`·`web` 100%, `workspace` 89.9%, `git/write` 89.7% 등) — 05 §0.1
- **e2e 결과 unexpected 0**(expected 1,418 / flaky 4 / skipped 3, 135스펙·1,425테스트) — 05 §0.2
- **git 파괴적 쓰기 테스트 양호**(`TestBranchDelete_DestructiveInRecord` 등, `check-gitwrite.sh` 게이트) — 05 §5, 단 `Merge`·`Replay` 0%는 별도 결함(TEST-24)
- **fixtures 층(`fixtures.ts`, `osenv.ts`, `git_fixture.sh`) 응집도 양호** — 05 "P1 스펙이 납품묶음 단위" 판단부
- **리포지토리 워킹트리 위생 양호** — `dongminal`·`dist/`·`playwright-report/`·`test-results/`·`.playwright-mcp/`는 git 미추적, `.gitignore`가 전부 커버 — 04 §0, 06 §4에서 재확인(단 git *히스토리*의 별도 경로 문제는 §6 참조)
- **CHANGELOG 규약 준수** — Keep a Changelog + SemVer 선언대로, 13개 버전 헤더 전부 날짜까지 태그와 정확히 일치 — 06 §7
- **`shortcuts.md`·`commands.md`·`api.md` 문서화된 내용은 전부 코드에 실재**(역방향 불일치 0건) — 06 §2-1,2-2,2-3, 문제는 반대방향(코드에는 있으나 문서에 없는 누락, DOC-2·DOC-4)
- **go.mod 의존성 매우 가벼움**(직접 2 + 간접 1), **archive 이동 관행 일관** — 06 §6, §1

---

## 6. 상충·미확정 항목

### 6.1 git 히스토리 대용량 blob — 04 vs 06 (재검증 진행/완료)

- **04(secops)**: `dongminal`(루트)·`dist/`·`playwright-report/`·`test-results/`·`.playwright-mcp/` 5개 경로는 git에 미추적이며 **과거 커밋 이력도 없다**고 명시(§0: `git log --all --diff-filter=A -- dongminal dist` 결과 비어있음).
- **06(docs-hygiene)**: 처음에는 이를 "요청에서 가정한 문제는 재현되지 않음"으로 정정했으나, 이후 team-lead 요청으로 04와의 정합성을 재검증하여 **"충돌 아님 — 서로 다른 경로"**로 자체 결론지었다: 04가 확인한 5개 경로는 06도 이력 0건으로 재확인했고, 06이 실제로 지적하는 것은 그와 **다른 두 경로** `remote-terminal`(27개 blob, 최대 9.1MB, 29커밋)과 `bin/dongminal`(1개 blob, 9.09MB, 2커밋)이다(DOC-6).
- **본 인덱스의 판정**: 06 리포트 스스로는 "충돌 아님"이라 결론 내렸지만, 팀장 지시에 따라 **두 리포트가 같은 주제(git 데이터 크기)에 대해 서로 다른 경로·수치를 보고했다는 사실 자체는 여기 미확정/교차검증 필요 항목으로 남긴다.** 특히 (1) 04는 "과거 커밋 이력 없음"을 5개 경로에 한정해 말했을 뿐 저장소 전체 히스토리를 훑지 않았고, (2) 06의 `remote-terminal`·`bin/dongminal` 발견이 04의 감사범위(§1 의도된 보안모델·코드 read) 밖이었다는 점에서, **04 리포트를 "git 히스토리에 대용량 파일 없음"으로 일반화해 인용하면 안 된다.**

### 6.2 04(secops) §6 미확인 8건 (그대로 이관)

1. `submodule.Manager`가 `ExecGit`에 넘기는 인자 조립 전체 — 사용자 입력(경로·URL·브랜치)이 `-` 접두/옵션으로 해석될 여지가 있는지 (`domain/submodule/submodule.go` 앞부분 미열람)
2. `ext.Installer`가 실행하는 `name/args`가 매니페스트(사용자 편집 가능 파일)에서 오는지, 아니면 동봉 선언(`builtin.go:35`)에서만 오는지
3. `daemon.log`에 크기 상한이 적용되는지 — `WatchLogSize` 호출부(`main.go:553`)가 넘기는 경로가 서버 로그 하나로 보이나 `logcap.go` 나머지를 다 읽지 않음
4. `dongminald` ↔ 서버의 버전 불일치 감지(hello 교환에 판이 실리는지) — `toolclient/client.go`·`daemon/ipc/paned.go`의 handshake 미열람
5. `web/vendor` 라이브러리들의 정확한 버전과 알려진 취약점 여부
6. `workspace.SchemaVersion > 2` 파일을 만났을 때의 동작(`manager.go:541`은 `<`만 봄 — 상위판 처리 분기가 다른 곳에 있을 수 있음)
7. 샌드박스 `mounts` 정의(`sandbox/config.go`)가 `/`·`~/.ssh` 같은 민감 호스트 경로 마운트를 거부하는지
8. Windows의 AF_UNIX 소켓 ACL — POSIX만 확인함

### 6.3 그 외 각 리포트 자체가 표기한 미확인 항목

- **03(uiux)**: 설정모달 `Escape` 리스너가 전역(`document`)이라 `GitDialog`/`UIKit.modal`과 중첩 시 닫힘 순서가 각자의 `capture:true`에 의존적 — 미확인 (`index.html:212-235` 관련)
- **06(docs-hygiene)**: `.github/workflows/verify.yml`이 린트/포맷을 실제로 강제하는지는 06의 범위 밖이라 미확인(단 05가 TEST-9·TEST-10으로 이 공백을 실측 확인함 — 06의 "미확인"과 05의 "확인된 부재"가 사실상 같은 결론으로 수렴)
- **06(docs-hygiene)**: archive 이동 판단 기준(리뷰 프로세스 존재 여부)은 git log/PR 이력을 보지 않아 미확인
- **06(docs-hygiene)**: `web/vendor` vendoring 방식과 `package.json`에 빌드 도구가 없는 이유는 02(fe-arch) 소관으로 보고 깊이 파지 않음 — 02는 이를 실제로 다뤘음(FE-6 Monaco CDN, 정적자산은 `go:embed`+vendor로 확인) 다만 vendor 파일의 정확한 버전 표기 부재는 SEC-32로 남아 있어 완전히 해소되지는 않음

# 부팅 코드 범위 재설계 (이슈 3.4.12)

- 상태: **사용자 승인 2026-11-25, 구현 끝 2026-11-25(3.4.12.11)**. 이 문서가 3.4.12.1~3.4.12.11 의 설계 원본이다. §1~§6 은 승인 당시 원문이고, 구현이 설계와 다르게 된 곳과 결과는 §7 이다. 근거 요구사항은 `PERF_OPTIMIZATION_SRS.md` FR-SPA-1·2, NFR-PRF-12.
- 기준: perf-m1 `e11fa14a`, 부팅 JS 1,543,764 B(3.4.10 측정). 바이트는 묶음 규칙(`js_strip.rs`·`bundles.rs::concat`)대로 주석을 걷은 추정이다. 추정 boot 합 845,934 B 와 실측 845,965 B 의 차이는 31 B 다.

## 1. 원칙 (사용자 결정 원문: "필요한거 전부. 최초 부팅 시 당장 필요한것만 가져가고 레이지로딩")

- **첫 화면** = 복원된 창·탭·사이드바·상태 바가 그려지고, 보이는 터미널에 입력할 수 있는 상태(데스크톱 기본 프로필).
- 첫 화면에 쓰이지 않는 코드는 처음 쓸 때 싣는다.
- 측정 창(이동 ~ `#boot` 사라짐 + 2초) 밖으로 미뤄 지표만 맞추는 방식은 쓰지 않는다.
- 그 사용자에게 당장 필요한 것은 부팅 때 싣는다. 예: 기본이 아닌 테마 사용자 → `themes`, 모바일 → `mobile`, 편집기 탭을 복원한 사용자 → `cm`·`mdlib`.

## 2. 부팅에 남기는 것

- vendor xterm·addon-fit·unicode11·web-links, `b/pre.js`, head 3개(server-move·storage-rename·panel-layout).
- addon-webgl: 데스크톱은 첫 페인트 직후 idle 프레임에서 평상시 렌더러로 쓰이므로 남긴다(D-40 유지). 터치 기기(`_tsTouch`, `_gpuWant` 거짓)는 싣지 않는다.
- `b/boot.js` 의 골격: 상수·스키마, 기반(api·channel·timer-hub·event-bus·state-registry…), UI 골격, 터미널, 렌더러, App 과 생성자가 만드는 컨트롤러, 편집기 컨트롤러(렌더마다 동기 호출이 많다), 기본 두 테마(Tokyo Night·GitHub Light)와 테마 변수, 언어 카탈로그의 부팅분과 동적 키.

## 3. 처음 쓸 때 싣는 묶음

로더는 `Screens.register(name, {needs:[…]})` 를 지원한다. `load` 는 needs 를 먼저 순서대로 싣고, needs 가 실패하면 본 묶음을 싣지 않으며, 실패를 기억하지 않는다. 라이브러리 묶음은 `tab` 없이 등록한다.

| 묶음 | 내용 | 싣는 진입점 | needs | 예상 감소(B) |
|---|---|---|---|---|
| `mdlib` | vendor markdown-it·purify | 터미널 `bareLinkProvider.provideLinks` 첫 호출(기다린 뒤 판정), `loadCodeMirror()`(CM import 와 나란히), `docrender` needs | – | 144,274 |
| `diag` | diag.js | head 인라인이 `?diag=1` 일 때만 `b/diag.js` 를 쓴다 | – | 13,829 |
| `search` | vendor addon-search, tool-search 본문(`focusedTerminal` 은 부팅에 남김) | 찾기 줄 열기. 실린 뒤 모든 터미널에 붙이고, 새 터미널은 실렸으면 바로 붙인다 | – | 16,267 |
| `remote` | tool-cmd·open-url(작은 도우미는 부팅에 남김) | `wsSync._execRemote` 첫 명령. 받은 명령은 순서대로 줄을 세운다 | – | 약 10,600 |
| `themes` | 기본 두 테마를 뺀 THEMES 항목 | `_settingsApply` 에서 부팅 표에 없는 이름일 때, 설정 ▸ 테마, 시스템 테마 추종 전환 | – | 약 36,500 |
| `cm` | CM 공용 층(cm-find·cm-scrollbar·cm-sticky·cm-marks·cm-setup·cm-lsp·cm-link·file-editor-find·file-editor-diff·hunk-coords·git-path), lsp-client·lsp-paths | `loadCodeMirror()` 가 CM vendor 와 나란히 싣는다. CM 뷰의 동기 계약(FR-ELS-12 클릭 안의 `window.open`, hover 정화)은 그대로 | mdlib | 91,628 |
| `editor`·`git` (기존) | 그대로 | 그대로 | cm | – |
| `docrender` (기존) | 그대로 | 그대로 | mdlib | – |
| `mobile` | mobile-controller·mobile-sheets·mobile-nav·keybar·drawer-sheet | 부팅 쪽 껍데기가 `isMobile` 이면 부팅 때, 아니면 resize 로 모바일이 될 때 싣고 본체로 바꾼다. 그 전엔 데스크톱 답 | – | 약 23,000 |
| `i18n.<묶음>.<언어>` | 지연 묶음 전용 키 조각(ko·en) | `Screens.load(묶음)` 이 묶음 JS 앞에 붙인다(순서 보장) | – | 46,359 이상 |
| `uiact` | layout-dnd·layout-tab-reopen·attn-center·repo-preview·path-suggest·drop-entries·term-transfer | 각 처리기 첫 호출. 동기여야 하는 곳(dragover 의 `getDragZone` 등)은 설계 단계에서 따로 정한다 | – | 약 20,867 |
| `chat` (기존 확장) | chat-window·chat-human·edges-mesh | `ChatController.views`. `settings` 는 `needs:['chat']`(edges-mesh-view 가 `meshDirectPeer` 를 씀) | – | 12,060 |

대화상자·메뉴 키트(dialog-stack·dialog·kit-modal·menu·size-hud·size-drag, 15,294 B)는 동기 API 호출처가 많아 부팅에 남긴다(설계 권장, 사용자에게 보고함).

## 4. 예상 결과

| 단계 | 누적 jsBytes(추정) |
|---|---|
| 지금 | 1,543,764 |
| .2 mdlib | 1,399,490 |
| .3~.6 | 약 1,322,300 |
| .7 cm | 약 1,230,700 |
| .8 mobile | 약 1,207,700 |
| .9 언어 조각 | 약 1,161,300 |
| .10 uiact·chat | 약 1,128,400 |

부팅 요청은 45 → 42(vendor 3개 빠짐).

## 5. 사용자 결정 (2026-11-25)

- 범위: 3.4.12.1~3.4.12.11 전부.
- 목표(NFR-PRF-12): 마지막 단계의 실측값을 기준으로 낮춘다(3.4.12.11 에서 값 확정).
- 체감 변화 수용: ① 맨 도메인 밑줄이 첫 hover 때 한 번 늦음 ② 기본이 아닌 테마는 부팅 때 테마 묶음을 하나 더 받음 ③ 창을 줄여 모바일로 바뀔 때 잠깐 지연 ④ 터치 기기는 WebGL 을 싣지 않음.
- 병합: 단계별. 독립 단계는 병렬로 맡긴다.
- 뒤집는 결정: 3.4.8(markdown-it·DOMPurify 부팅 잔류), 3.4.7(CM 공용 층 부팅 잔류), D-34·M8 FR-B-2(언어 카탈로그), D-41 일부(`meshDirectPeer`), D-42(목표 1.55 MB). 새 결정은 SRS D-43~D-48.

## 6. 단계와 RED 시험

| 단계 | 내용 | RED 시험 | 위험 | deps |
|---|---|---|---|---|
| 3.4.12.1 | `needs` 로더, lazy-boundary 에 vendor UMD 전역표(`markdownit`·`DOMPurify`·`SearchAddon`) | 단위 needs 순서·실패 시 미부착. 게이트: 전역표를 넣으면 지금 코드가 RED | LOW | – |
| 3.4.12.2 | mdlib | 단위 bare-link(markdownit 없을 때 load 뒤 cb). e2e: 부팅 요청 0·hover 뒤 밑줄·요청 1번 / 편집기 첫 열기 Ctrl+클릭 URL / 복원 렌더 탭 | LOW–MED | .1 |
| 3.4.12.3 | diag | e2e: 파라미터 없으면 `b/diag.js` 0, `?diag=1` 이면 오버레이 | LOW | .1 |
| 3.4.12.4 | search | e2e: 부팅 search 요청 0, Ctrl+F 결과, 새 터미널에서도 찾기 | LOW–MED | .1 |
| 3.4.12.5 | remote | e2e: 부팅 요청 0, otterctl 명령 둘을 잇달아 → 순서대로 실행 | MED | .1 |
| 3.4.12.6 | themes | 단위: 부팅 표에 없는 이름이면 load 뒤 적용. e2e: 기본 테마 요청 0, 다른 테마 저장 후 새로고침 색, 시스템 추종 | MED | .1 |
| 3.4.12.7 | cm + lsp | e2e: 부팅 `b/cm.js` 0, Diff 먼저 → 편집기 열 때 cm 요청 1번, LSP hover·정의 이동. 단위: cm 없을 때 `EdDirtyDiff` 가드 | MED–HIGH | .2 |
| 3.4.12.8 | mobile | e2e: 데스크톱 요청 0, 폭 줄이면 모바일 UI, 모바일 뷰포트 부팅 시 키바·서랍 | MED–HIGH | .1 |
| 3.4.12.9 | 언어 조각 | 게이트: 조각 키는 그 묶음 파일에서만, ko/en 같음. e2e: git·설정 첫 열기에 `ns.key` 노출 0(ko·en) | MED–HIGH | .2~.8 |
| 3.4.12.10 | uiact·chat 부품, 터치 기기 WebGL 생략 | e2e: 끌어 놓기·탭 다시 열기·주의 센터 동작, 터치 에뮬레이션 addon-webgl 요청 0 | MED | .1 |
| 3.4.12.11 | 문서 정합·재측정·NFR-PRF-12 확정·회귀 상한 | scenario `jsBytes` ≤ 상한, 데스크톱 기본 부팅 지연 묶음 요청 0 | LOW | .2~.10 |

공통: 단계마다 이전/새/이유를 진행 기록과 커밋에 적는다. `harness.mjs` 는 그대로(D-33). 각 e2e 는 `page.route` 로 묶음을 붙잡아 기다림·자리표시를 확인한다. app-testing 이 노출하는 `lspClient()`·`dnd.*`·`cmd._execRemote` 는 e2e 가 먼저 `Screens.load` 를 부른다.

## 7. 구현 결과·정합 (PERF 3.4.12.11, 2026-11-25)

### 7.1 합친 재측정

perf-m1 `b64402c8`(3.4.12.1~3.4.12.10 병합 뒤) 릴리스 빌드 `otterminal-pf3.4.12.11`. `scenario.mjs --only boot` 를 매번 새 격리 인스턴스(포트 61701~61703, 새 홈)로 3번 쟀다. 기계 부하는 load average 약 48 이었다.

| 지표 | 기준선(3.4.1) | 3.4.11 | 3.4.12 1 · 2 · 3 |
|---|---|---|---|
| 부팅 요청 (NFR-PRF-11, 80 이하) | 332 | 45 | **42** · 42 · 42 |
| └ Script · Stylesheet · Fetch | 296 · 21 · 12 | 14 · 16 · 12 | 11 · 16 · 12 (세 번 같음) |
| └ Document · Image · Other | 1 · 1 · 1 | 1 · 1 · 1 | 1 · 1 · 1 |
| 부팅 JS 풀린 크기 (NFR-PRF-12) | 3,891,882 B | 1,543,787 B | **1,142,951 B** (세 번 같음) |
| 부팅 JS 전송 크기 | 4,123,482 B | 935,880 B | 677,753 B (세 번 같음) |
| 16 ms 초과 작업 | 2 (최대 23.6 ms) | 0~2 (최대 20.3 ms) | 2 (17.3) · 2 (50.3) · 2 (27.4) |
| bootMs | 397~701 | 319~333 | 331 · 401 · 359 |

- 3.4.11 대비 −400,836 B(−26.0%), 기준선 대비 −70.6%. 부팅 Script 셋(vendor markdown-it·purify·addon-search)이 빠져 요청이 45 → 42 다(§4 의 예상과 같다).
- 부팅 Script 11개: head 셋(server-move·storage-rename·panel-layout), vendor 넷(xterm·fit·web-links·unicode11), addon-webgl(데스크톱), `b/pre.js`, `js/i18n/ko.js`(부팅분), `b/boot.js`.
- 16 ms 초과 작업의 50.3 ms 한 건은 같은 조건의 다른 두 회에 없고 기계 부하가 높을 때라 부하 영향으로 본다(추정).
- **NFR-PRF-12 확정(D-48)**: 1,142,951 B 를 다음 10,000 B 로 올려 **1,150,000 B** 다(여유 7,049 B). SRS NFR-PRF-12·D-42·D-48 을 고쳤다.
- `scenario.mjs` 는 boot 값을 찍은 뒤 창·탭 만들기에서 `otterctl new-tab -n --at <새 창 탭 uuid>` 가 "location 은 list-workspace 의 uuid 만 허용" 으로 실패해 세 번 모두 exit 1 로 끝났다. boot 값은 실패 전에 찍힌다. 도구는 고치지 않았다(§7.5).

### 7.2 단계별 실제 감소량

단계마다 그 단계의 브랜치를 단독으로 잰 값이다(진행 기록). 기준 커밋이 단계마다 달라 전 값이 다르다.

| 단계 | 예상(§3·§4) | 실측 전 → 후 | 감소 | 예상과 다른 이유 |
|---|---|---|---|---|
| 3.4.12.1 needs 로더 | 0 | (.3·.6 의 전 값 1,544,326 = 기준 + 539) | +539 | 로더 코드(`_load`·`needs`) 몫 |
| 3.4.12.2 mdlib | 144,274 | 1,543,787 → 1,400,268 | −143,519 | |
| 3.4.12.3 diag | 13,829 | 1,544,326 → 1,530,493 | −13,833 | |
| 3.4.12.4 search | 16,267 | 1,543,787 → 1,528,703 | −15,084 | 껍데기(`focusedTerminal`·`toggleSearch`·`attachIfReady` 등)가 부팅에 남음 |
| 3.4.12.5 remote | 약 10,600 | 1,530,493 → 1,520,658 | −9,835 | 껍데기(`_execRemote`·`_echoResult`·`_findTabById`)가 부팅에 남음 |
| 3.4.12.6 themes | 약 36,500 | 1,544,326 → 1,508,007 | −36,319 | |
| 3.4.12.7 cm | 91,628 | 1,350,116 → 1,258,539 | −91,577 | |
| 3.4.12.8 mobile | 약 23,000 | 1,530,493 → 1,507,992 | −22,501 | 부팅 껍데기 `mobile-shell.js` |
| 3.4.12.9 언어 조각 | 46,359 이상 | 1,190,252 → 1,142,951 | −47,301 | |
| 3.4.12.10 uiact·chat | 32,927 | 1,530,493 → 1,510,185 | −20,308 | 동기 반환값을 쓰는 세 파일과 껍데기·`chat-window` 일부가 부팅에 남음(§7.3) |
| 합 | 약 415,400 | 1,543,787 → **1,142,951** | 단독 합 −400,277 · 실제 −400,836 | 단독 합과의 차이 559 B 는 병합 순서·단계 사이 커밋 몫 |

설계 추정 최종값 1,128,400 B 보다 14,551 B 크다. 거의 전부 uiact·chat(−12.6 KB)·search·remote 의 부팅 잔류 몫이다.

### 7.3 설계와 다르게 된 점

| 설계(§3·§6) | 실제 | 이유 | 단계 |
|---|---|---|---|
| `mobile` 묶음에 keybar 포함 | `[keybar]` 라이브러리 묶음을 따로 두고 `mobile`·`settings` 가 needs 로 싣는다 | 설정 ▸ Terminal 도 keybar.js 를 쓴다. 설정을 열 때 모바일 본체를 받지 않게 | .8 |
| `mobile` 은 껍데기가 본체에 위임 | 부팅 껍데기 `MobileShell` 이 `app.mobile` 이고, 본체를 실으면 `app.mobile` 을 본체로 바꾼다. `app.isMobile` 은 본체가 선 뒤에만 참(옛 판정은 `wantsMobile`) | 본체 없이 모바일 판정이 참이면 반쯤 모바일인 화면을 그린다 | .8 |
| `uiact` = 일곱 파일 | `layout-tab-reopen`·`repo-preview`·`drop-entries` 세 파일은 부팅 잔류. `layout-dnd`·`attn-center`·`term-transfer` 는 껍데기가 남고 본체만 옮겼다(`Screens.call`). 탭 dragstart 에서 미리 싣는다 | 반환값을 그 자리에서 쓰는 동기 호출(탭 닫기 기록·뒤로/앞으로 판정·미리보기 탭 찾기, dragover/drop 안의 판정) | .10 |
| `chat` 에 chat-window 통째 | 열기 몫(`chat-window-open.js`)만 옮겼다. `_chatNormalize`·`_chatRepaint`·`chatPanelRender` 는 부팅 | 부팅의 `_chatRestore` 가 부른다 | .10 |
| 터치 기기 WebGL 생략(방식 미정) | index.html 인라인이 `(pointer: coarse)` 가 아닐 때만 `document.write` 로 싣는다. 묶음이 아니다 | 데스크톱은 종전과 같은 URL·자리·동기 실행이어야 첫 페인트 직후 붙이기(D-40)가 그대로다 | .10 |
| `diag`: head 인라인 | 본문 끝, `b/boot.js` 바로 뒤의 인라인이 `?diag=1` 일 때만 `document.write`. `Screens.register` 하지 않는다 | 종전 순서(부팅 묶음의 끝)를 지킨다 | .3 |
| 언어 조각 `i18n.<묶음>.<언어>` (묶음) | 정적 파일 `js/i18n/<묶음>.<언어>.js`. 서버 묶음이 아니고 Rust 는 바꾸지 않았다. 조각은 9묶음(git·settings·editor·run·chat·docrender·uiact·remote·cm). diag 키 9개는 부팅에 남김(`check-i18n` 의 `UNFRAGMENTED`) | `[diag]` 는 `Screens.load` 를 지나지 않는다. 조각을 실을 길을 따로 두면 두 벌이 된다(D-11) | .9 |
| `cm` 진입점: `loadCodeMirror()`·needs | 더해 설정 ▸ Code 첫 열기(`settings-code.js` 가 `Screens.load('cm')` 뒤 `_lspRefresh`)와 `app.lspClient()`(cm 전에는 `null`) | `settings` 묶음이 LSP 상태를 읽는다. `lspClient` 본체가 cm 묶음에 있다 | .7 |
| `cm` 이동 뒤 탐색기만 열면 editor 묶음만 | 탐색기 사이드도 needs 로 mdlib·cm 을 먼저 받는다 | editor·git 묶음이 로드 시점에 cm 전역을 읽는다 | .7 |
| `search` 진입점 "찾기 줄 열기" | `ToolSearch.toggleSearch`(Ctrl+F·터미널 메뉴·모바일 찾기 단추가 모두 부른다). `tool-search.js` 는 껍데기, 본체는 새 `tool-search-bar.js` | — | .4 |
| `remote` 진입점 `wsSync._execRemote` | `ToolCmd._execRemote`(버스 fallback·`app.testing` 이 부른다). `tool-cmd.js` 는 껍데기로 부팅에 남고 본체는 새 `tool-cmd-remote.js` | `ToolController` 가 부팅 때 `new ToolCmd` 한다 | .5 |
| `themes` 진입점 "시스템 테마 추종 전환" | 따로 두지 않았다. `_settingsApply` 가 슬롯 이름까지 보고 부팅 적용 때 싣는다. `settings` 는 needs 로 `themes` 를 싣는다 | 추종 전환 때는 두 슬롯이 늘 표에 있다 | .6 |
| `settings` needs: chat | `needs:['themes','keybar','chat']` | .6·.8·.10 을 합쳤다 | .6·.8·.10 |
| §6 .1 "게이트: 전역표를 넣으면 지금 코드가 RED" | 지금 vendor 셋이 부팅 소속이라 게이트는 통과했고, RED 는 단위 시험의 고정 자료로 확인했다 | — | .1 |
| §6 .11 회귀 상한 "scenario jsBytes ≤ 상한" | 게이트 `scripts/check-boot-bytes.mjs` 가 바이너리 없이 묶음 규칙대로 계산한다(실측과 같은 1,142,951 B). e2e `perf-boot-lazy.spec.ts` TC-BTL-1 이 데스크톱 기본 부팅의 지연 묶음·조각 요청 0 을 잰다 | 시나리오는 사람이 돌리고 부하에 흔들린다. 바이트는 결정적으로 셀 수 있다 | .11 |

### 7.4 정합 목록과 처리 결과

원칙: 코드가 기준이다. 당시 기록은 원문을 두고 "(정정 2026-11-25, PERF 3.4.12.11: 지금은 …)" 을 더했다. 결정 표는 개정 줄(이전/새/이유)을 더했다. 동작 코드는 바꾸지 않았다.

| 자리 | 어긋남 | 처리 |
|---|---|---|
| SRS 머리 "남은 것" | M3 3.4.11·3.4.12 를 남은 일로 적음 | 고침 |
| SRS D-34 | 언어 파일 하나가 카탈로그 전부 | 개정 줄(D-46) |
| SRS D-41 | `meshDirectPeer` 부팅 잔류 | 개정 줄(D-47) |
| SRS D-42 | 목표 1.55 MB | 개정 줄(D-48, 1,150,000 B) |
| SRS D-48 | 값 미정 | 확정 줄 |
| SRS FR-SPA-1·2·6 상태 | 3.4 시점(FR-SPA-2 부분 충족, 1,543,764 B) | 고침(FR-SPA-2 충족) |
| SRS NFR-PRF-12 | 1.55 MB | 1.15 MB(1,150,000 B)(D-48) |
| SRS NFR-PRF-11 | — | 그대로(목표 80, 실측 42 는 §7.3) |
| SRS §2.4 비목표 "성능 회귀를 CI 게이트로 강제하기" | 새 게이트와 겉보기 충돌 | 정정 한 줄: 결정적 값(부팅 JS 바이트)만 예외, CI 워크플로에는 넣지 않음 |
| SRS §7 | 3.4.12 결과 없음 | 「7.3 3.4.12」 표 |
| `decisions.md` | — | 다시 만듦 |
| M3_DESIGN §3.4 | index.html vendor 8개, `register` 꼴, 언어 한 벌, `boot`·`docrender` 행, 3.4.12 결과·회귀 게이트 없음 | 정정 줄·결과 줄·하위 이슈 행·재는 법 줄 |
| M8_UNIFIED_SRS FR-B-2 | 로케일별 파일 하나 | 정정 줄 |
| 이슈 3.4.5 목표 | 활성 언어 파일 하나 | 정정 줄 |
| 이슈 3.4.7 결정 A | CM 공용 층 부팅 잔류 | 정정 줄 |
| 이슈 3.4.8 목표 | markdown-it·DOMPurify 부팅 잔류 | 정정 줄 |
| 이슈 3.4.9.2 조사 | `meshDirectPeer` 부팅 잔류 | 정정 줄 |
| `web/js/i18n/ko.js` 머리말 | "문구 교정은 이 파일의 diff 하나다" | 고침(조각 포함). 부팅 JS +12 B |
| `web/js/i18n/en.js` 머리말 | — | 이미 맞음 |
| `web/bundles.txt` 머리 주석 | 싣는 차례에 diag·조각·needs 없음 | 고침 |
| `web/bundles.txt` `[docrender]`·`[editor]` 주석 | (3.4.12.10 보고) | 이미 맞음(3.4.12.2·.7 이 고침) |
| `web/bundles.txt` boot 의 "keybar.js 가 MKB_KEYS 를 딛는다" | (3.4.12.8 보고) 말투만 옛것 | 그대로(사실은 맞음) |
| `web/index.html` 186·240행 주석 | `#drawer-close`·`mTopPaint` 가 늘 있는 것처럼 | 고침(모바일 본체가 선 뒤에만) |
| `web/index.html` 언어 인라인 주석 | 활성 로케일 파일 하나 | 고침(부팅분 + 조각) |
| CHANGELOG [Unreleased] | 3.4.12 체감 변화 없음 | 항목 하나 더함 |
| 이 문서 §1~§6 | §7.3 의 차이 | 원문 유지, 머리 상태 줄과 §7 |
| `web/js/core/tool-cmd.js` 머리말 "main.js 이전" | (3.4.12.5 보고) "없는 파일" | 어긋나지 않음 — `js/core/main.js` 는 `[boot]` 에 있다 |
| `docs/internal/ASSET_VERSION_SINGLE_SOURCE_SRS.md:52` | 묶음 이전의 `js/ui/diag.js?v=` 예시 | 남김(범위 밖, 3.4.12 전부터) |
| `web/js/core/settings-theme.js` 머리말 "44개 테마" | 실제 54종 | 남김(범위 밖, 3.4.12 전부터) |
| `settings-schema.js` `themeName` def `"dark"` | 테마 이름이 아님 | 남김(동작 코드) |
| `web/js/core/edges-controller.js` 머리말 | 망 그림 함수가 `chat` 묶음이라는 말 없음 | 남김(범위 밖) |
| `web/js/core/i18n.js` `lookup` 주석 "기본 로케일 폴백" | ko 카탈로그가 실렸을 때만 맞음(3.4.5 보고) | 남김(범위 밖) |
| `e2e/event-timer-hub-contract.spec.ts` `CONST_GIT_JS` | index.html 의 개별 태그 전제(T-5·6·7·7b 기존 실패) | 남김(마일스톤 전체 시험 몫) |
| `e2e/baseline/ui-layout.*.json` | 데스크톱 `drawer-close`·`mkb-btn` 키, `search-bar` position | 남김(기준선 갱신은 사용자 결정) |

### 7.5 남은 위험

- 게이트의 바이트 계산은 서버 `js_strip.rs`·`bundles.rs::concat` 을 옮긴 `scripts/js-strip.mjs` 다. 서버 규칙을 바꾸면 이 파일도 같이 바꿔야 한다. 어긋나면 계산 값이 실측과 달라진다 — 재측정 때 둘을 견준다.
- 게이트는 데스크톱 기본 프로필만 잰다. 인라인 로더(`webglSrc`·`i18nSrc`·`diagSrc`)를 기본 부팅이 싣는지는 게이트의 표가 정하고, 모르는 로더가 생기면 실패한다. 기본이 아닌 테마·모바일·복원된 편집기 탭의 부팅은 재지 않는다(설계상 그 사용자에게 필요한 묶음을 싣는다).
- 상한까지 여유는 7,049 B 다. 부팅 코드를 조금만 더해도 게이트가 실패한다. 그때는 부팅 범위를 다시 보거나(이 문서 §1) 사용자 결정으로 상한을 고친다.
- `scenario.mjs` 의 창·탭 만들기가 `otterctl new-tab --at` 에서 실패한다. `--only boot` 값에는 영향이 없지만 전체 시나리오(idle·load …)는 지금 끝까지 돌지 않을 수 있다(확인하지 않았다).

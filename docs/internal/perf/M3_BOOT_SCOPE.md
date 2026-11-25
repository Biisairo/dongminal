# 부팅 코드 범위 재설계 (이슈 3.4.12)

- 상태: **사용자 승인 2026-11-25**. 이 문서가 3.4.12.1~3.4.12.11 의 설계 원본이다. 근거 요구사항은 `PERF_OPTIMIZATION_SRS.md` FR-SPA-1·2, NFR-PRF-12.
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

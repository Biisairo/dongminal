# 12 — UI 기능 흐름 완성도 감사

대상: `web/js/**`, `web/index.html` (35,716 LOC). read-only. 모든 발견은 실제로 읽은 줄을 근거로 한다.
범위 밖: git 폴링·갱신 흐름(`audit-git-poll` 담당). 기존 173건(`00-INDEX.md`)과 겹치는 것은 ID 참조만 한다.
축 접두: **FUI**.

## 0. 요약

| 등급 | 건수 |
|---|---|
| P1 | 4 |
| P2 | 22 |
| 의도적 설계(비결함, 문서 근거) | 9 |
| 미확인 | 6 |

미완성 신호(TODO·FIXME·HACK·XXX·추후·임시·미구현·not implemented) grep 실측: **2건**, 둘 다 산문 주석 속 일반어(`app-git.js:388` "그 임시", `panel-poll.js:78` "임시 textarea") → **기능 결손 0건**. `disabled` 사용 62곳은 전부 조건부(한계·진행 중·대상 없음)이며 항상-비활성 버튼 없음. 핸들러가 비어 있는 요소 없음. 조건부로 절대 표시되지 않는 UI 없음(`add-preset`·`attn-badge`·`m-add-tab` 숨김은 전부 상태 기반).

---

## 1. P1

### [P1] FUI-01 이미 열린 파일을 다시 열면 미저장 편집이 디스크 내용으로 조용히 덮인다
- 위치: `web/js/core/app-layout.js:469-480` (`addTab` editor 분기 `existing` → `editor.refresh()`), `web/js/ui/file-editor.js:585-611` (`refresh()` — `getValue()!==content` 면 `setValue(content)`, `_dirty=false`)
- 현재 동작: `refresh()` 는 `_loading` 만 검사한다. dirty 버퍼가 디스크와 다르면 무조건 `setValue` 로 교체하고 dirty 를 내린다.
- 기대 동작: dirty 문서는 다시 읽지 않거나(VS Code 규약) 묻는다. 근거: `EDITOR_TAB_SRS.md:735` FR-EDT-101 "그 탭으로 이동하고 새로 읽는다" 에 dirty 예외가 없다 — **스펙 결함을 겸한다.** 같은 파일의 `save()` 는 "문서 하나에 한 번" 을 지키느라 FR-SVS-50~55 까지 세웠는데, 재열기는 그 문서를 통째로 버린다.
- 재현: Editor 창에서 `a.txt` 열기 → 몇 글자 입력(탭에 `●`) → 탐색기에서 `a.txt` 행을 **다시 클릭**(또는 `Cmd+P` 로 선택, 터미널에서 `edit a.txt`, grep 결과 클릭) → 입력한 글자가 사라지고 `●` 가 꺼진다.
- 영향: 사용자의 가장 흔한 손짓(목록에서 파일을 다시 누르기)이 데이터 손실이다. e2e R7(`editor-ops.spec.ts:544`)은 중복 탭만 검사하고 dirty 를 만들지 않아 잡지 못한다.
- 조치: `refresh()` 첫 줄에 `if(this._dirty) return;`(또는 `note()` 로 "디스크와 다름 — 저장하지 않은 편집을 유지합니다" 알림). FR-EDT-101 을 "dirty 가 아닐 때만 새로 읽는다" 로 개정. e2e: dirty 뒤 재열기 → 내용 보존.
- 규모: S

### [P1] FUI-02 저장이 외부 변경을 대조하지 않는다 — 마지막 쓰기가 이긴다
- 위치: `web/js/ui/file-editor.js:561-565` (`POST /api/file/write` 본문 `{path,content}` 만), `internal/webserver/httpapi/handlers_files.go:362-390` (`apiFileWrite` — mtime·ETag·If-Match 검사 없음, `WriteFileAtomic` 즉시)
- 현재 동작: 열린 파일이 바깥(터미널 `git checkout`, 다른 브라우저, 에이전트)에서 바뀌어도 편집기는 모르고(파일 **내용**의 mtime 은 관측하지 않는다 — `NOTES_LIVE_EXPLORER_SRS.md:298-299` 가 그 사실을 적어 두었다), `Cmd+S` 가 그것을 덮어쓴다. 문제 유형이 `TEST-1`·`SEC-7` 과 같은 종단이지만 결함은 다르다 — 저쪽은 경계, 이쪽은 **동시성**.
- 기대 동작: 열 때 받은 mtime/해시를 저장 시 함께 보내고 서버가 다르면 409 → 편집기가 "디스크가 바뀌었습니다: 덮어쓰기 / 다시 읽기 / 비교" 를 묻는다. 워크스페이스 저장은 이미 같은 규약(ETag/If-Match, `app.js:388`)을 갖고 있다.
- 재현: 브라우저 A·B 에서 같은 파일 열기 → A 에서 1행 고쳐 저장 → B 에서 5행 고쳐 저장 → A 의 변경이 사라진다. 또는 편집 중 터미널에서 `git checkout other-branch` → 저장 → 체크아웃된 내용이 편집 전 버퍼로 덮인다.
- 영향: README 가 명시한 사용 시나리오("노트북에서도 아이패드에서도 같은 터미널", 에이전트 다중 실행)에서 정확히 발생한다. 서버 `WriteFileAtomic` 이 "원자적" 이라 부분 손상은 없지만 **어느 쪽이 이겼는지 아무도 모른다.**
- 조치: `/api/file/read` 응답에 `X-File-Mtime`(또는 ETag)을 싣고 `_fetchFile` 이 문서에 보관 → `save()` 가 `ifMtime` 을 보냄 → 서버 409 → 편집기 `_confirmClose` 골격으로 3지선다. `EdDirtyDiff` 의 `_gitSignal` 훅(`app-editor.js:1153`)이 이미 "저장소가 바뀌었다" 를 받으므로 그 자리에서 mtime 재조회를 걸면 감지도 싸다.
- 규모: M (서버 S + 클라이언트 S/M)

### [P1] FUI-03 새 판 자동 새로고침이 미저장 편집을 묻지 않고 버린다
- 위치: `web/js/ui/version-watch.js:59-72` (`reload()` — `__dmReloading=true` 뒤 `location.reload()`), `web/js/core/main.js:151-155` (`beforeunload` 가드는 `__dmReloading` 이면 물러난다), `web/js/core/app-backup.js:187-193` (같은 경로)
- 현재 동작: 서버가 새 자산 판으로 재기동되면(`server_hello`) 열린 편집기의 dirty 여부와 무관하게 즉시 새로고침한다. `_edAnyDirty()`(`app-editor.js:302`)는 이 경로에서 읽히지 않는다.
- 기대 동작과 근거: `RELOAD_CONTINUITY_SRS` FR-RLC-5a 와 `features.md:245` 가 "자동 새로고침은 묻지 않는다" 를 **세션 연결**에 대해 근거 짓는다("연결만 잃는다. 세션은 서버에 남는다"). 미저장 편집은 그 근거의 범위 밖이다 — 서버에 남지 않는다. 문서화된 결정이지만 그 결정이 다루지 않은 손실이므로 결함으로 분류한다.
- 재현: 파일 편집(저장 안 함) → 서버를 새 빌드로 `dongminal start`(자산 판 변경) → 화면이 스스로 다시 열리고 편집이 사라진다. 개발 중인 사용자에게 흔한 순서다.
- 영향: 데이터 손실. `softReload` 는 "가진 것을 버리지 않는다" 를 원칙으로 세웠는데(`app-reload.js:6-9`) 그 옆의 하드 리로드는 예외 없이 버린다.
- 조치: `reload()` 앞에 `app._edAnyDirty()` 검사 → dirty 면 하단 배너("새 판이 있습니다 — 저장하지 않은 편집 N개. 저장 후 다시 열기 / 지금 다시 열기")로 물러난다. 사용자가 보고 있지 않으면 자동 갱신이 멎는다는 우려는 dirty 가 없을 때만 자동으로 두면 해소된다.
- 규모: S

### [P1] FUI-04 Run 을 UI 에서 중단·정리할 길이 없다 — 유일한 출구가 기록까지 지우는 "삭제"
- 위치: `web/js/ui/runs-panel.js:128-232` (행에 `삭제` 만), `:723-734` (`_runJumpToMember` — attach 만); 서버는 `/api/runs/close`(`handlers_api.go:95`)·`/api/runs/detach`(`:104`)·`/api/runs/succeed`·`/handoff` 를 갖는다
- 현재 동작: Runs 모달·대시보드에 시작·중단(close)·분리(detach)·재시도 어느 것도 없다. `open` 상태의 Run 을 멈추려면 `삭제`를 눌러야 하고 확인 문구가 그것을 인정한다("진행 중인 Run 이며 기록도 함께 사라진다", `:196-198`). 시작은 `RUN_EMPTY_HINT='/dongminal:team 으로 팀을 연다'` — CLI 전용.
- 기대 동작: 서버가 이미 노출한 `close` 를 행·대시보드에 두어 "멈추되 기록은 남긴다" 가 가능해야 한다. `closeTab` 주석(`app-layout.js:562-565`)이 `dmctl run close` 흐름을 안다 — 같은 일을 화면에서 못 한다.
- 재현: `/dongminal:team` 으로 Run 시작 → 에이전트가 잘못 돌기 시작 → Runs 모달 → 멈출 버튼 없음 → 백그라운드 도구 모달에서 멤버를 하나씩 `종료`(3초 SIGTERM 유예)하거나 `삭제`로 타임라인까지 잃는다.
- 영향: 오케스트레이션 UI 가 **관측 전용**이다. 문제 상황(폭주·컨텍스트 고갈 경고 `⚠ critical` 배지가 뜬 순간)에 화면에서 할 수 있는 안전한 조치가 없다. `ORCHESTRATION_V2_SRS §6` 비목표 7개에 "UI 조작 없음" 은 없다.
- 조치: 행에 `종료`(`POST /api/runs/close`, GitConfirm 규약) 추가, 대시보드 멤버 카드에 `분리`(detach). 재시도는 서버 비목표(§6-1 "자동 교체 않음")와 충돌하지 않는 범위에서 "새 Run 으로 같은 objective" 정도만.
- 규모: M

---

## 2. P2 (카테고리별, 22건)

### A. 편집기 (4)

**FUI-05 저장 실패 피드백이 500ms 붉은 테두리뿐** — `file-editor.js:575-579`. 읽기 전용 파일·권한 없음·디스크 오류·서버 재시작 중 전부 같은 깜빡임이고 사유는 `console.error` 에만 남는다. 서버는 `write failed: <err>` 를 본문에 싣는데(`handlers_files.go:387`) 읽지 않는다. 재현: `chmod 444 a.txt` → 편집 → `Cmd+S` → 붉은 테두리 0.5초 → dirty 그대로. 조치: `note(text)`(이미 있는 편집기 우상단 알림 줄)에 사유 표기. S

**FUI-06 큰 텍스트 파일에 클라이언트 게이트가 없다** — `file-editor.js:222-230`. `_probeFile` 이 `size` 를 받지만 텍스트면 크기와 무관하게 `/api/file/read` 전체를 Monaco 에 올린다(`SEC-19` 서버 무제한과 짝). 재현: 수백 MB 로그를 탐색기에서 클릭 → 탭이 멎는다. 조치: `probe.size > EDITOR_TEXT_MAX` 면 `_showUnsupported` 계열로 "너무 큽니다 — 터미널에서 여세요" + 다운로드. S

**FUI-07 "모두 저장" 이 없다** — `_edWinSaveDirty`(`app-editor.js:317-329`)는 창 닫기 확인창에서만 불린다. 여러 파일을 고치면 탭마다 `Cmd+S`. 단축키 표(`helpers.js:237-282`)에도 없다. 조치: `edSaveAll` 액션 + 창 단축키. S

**FUI-08 탭 컨텍스트 메뉴가 없다** — `renderer.js:892-974` 탭 요소에 `contextmenu` 리스너 없음. 모두 닫기·다른 탭 닫기·오른쪽 닫기·경로 복사·탐색기에서 보기가 없다. 탐색기 행(`file-tree-xfer.js:170-212`)과 git 뷰들은 `GitMenu` 를 갖는다 — 같은 앱 안의 비대칭. S/M

### B. 탐색기 (5)

**FUI-09 다중 선택이 없다** — `file-tree.js:41` `_sel=''`(단일 문자열). 삭제·복사·이동·다운로드가 전부 단건이다. 열 개를 지우려면 확인창 열 번. 조치: `Shift/Cmd+클릭` → `_sel` 을 Set 으로, `doDelete`·`doPasteInto` 가 배열을 받게. M

**FUI-10 잘린 폴더(10,000 초과)의 나머지에 닿는 길이 없다** — `file-tree-paint.js:531-534`("잘림. N개 표시") + `handlers_fs.go:44` `fsListMax=10000`. FR-EDT-65 가 잘림 **표기**는 정했지만 "더 보기"·필터·정렬 전환은 없어 10,001번째 이후 파일은 UI 로 열 수 없다(터미널 `edit` 로만). 의도적 표기이나 완결 경로 없음. 조치: `?offset=`/`?after=` 페이징 또는 행 안 필터 입력. M

**FUI-11 다른 루트로의 이동이 없다(복사는 있다)** — DnD 는 `this.el` 안에서만 성립(`file-tree-xfer.js:212-262`), 붙여넣기는 `srcRoot≠dstRoot` 를 허용(`file-tree-edit.js:209-226`, FR-WBR-61). 즉 `~/proj` 트리의 파일을 메모장 트리로 **복사**는 되지만 **옮기기**는 안 되고 "잘라내기" 메뉴도 없다. 조치: `잘라내기` 항목(클립보드에 `move:true`) → `doPasteInto` 가 `FS_RENAME_API` 분기. S

**FUI-12 빈 여백·빈 폴더에서 우클릭이 아무 일도 하지 않는다** — `_onCtx`(`file-tree-xfer.js:170-173`)는 `.ed-row` 가 아니면 `return`. 루트가 비었거나 마지막 행 아래를 우클릭하면 메뉴가 없어 "새 파일·업로드·붙여넣기" 는 헤더 버튼(새 파일·새 폴더·새로고침 셋)으로만 — 헤더에는 업로드·붙여넣기가 없다. 조치: `.ed-tree` 자체 우클릭 → 루트 대상 메뉴. S

**FUI-13 키보드 조작 없음(부분)** — 인라인 입력에만 keydown(`file-tree-paint.js:638-642`). 행 선택 상태에서 `F2`·`Delete`·`Enter`·`←→` 접기가 없다. 접근성 측면은 `UX-4` 가 다루고, 여기서는 **기능 비대칭**(같은 조작이 마우스로만)만 기록. 겹침: UX-4. (규모는 UX-4 에 귀속)

### C. 터미널·탭·창·슬롯 (6)

**FUI-14 종료된 도구의 탭이 죽은 채 남는다** — `term-pane.js:475-482` `_markExited` 는 오버레이("도구 종료됨 / 이 탭을 닫아 주세요") 만 띄운다. 자동 닫기·"새 셸로 다시 열기" 버튼·닫기 버튼이 없다. 워크스페이스에는 없는 toolId 를 가리키는 탭이 남아 새로고침 뒤에도 같은 오버레이가 선다. 재현: 터미널에서 `exit` → 탭이 회색 오버레이로 남음 → 사용자가 `×`. 조치: 오버레이에 `[닫기] [같은 자리에 새 셸]` 두 버튼. S/M

**FUI-15 터미널 검색이 일치 수·위치를 보이지 않고 정규식·단어 단위가 없다** — `app-search.js:40-53` `regex:false,wholeWord:false` 고정, `#search-count` 는 `''`/`'없음'` 둘뿐. 벤더 `addon-search.js` 는 `onDidChangeResults({resultIndex,resultCount})` 를 이미 낸다(미사용). 편집기 찾기 줄은 셋 다 있고 `현재/전체` 를 보인다(`file-editor-find.js:69-71,201`) — 같은 앱의 두 검색이 비대칭. `features.md` 터미널 표는 "대소문자 구분 토글" 만 적으므로 문서와는 일치하되 기능 격차. 조치: `search.onDidChangeResults` 구독 → `n/N`, `.*`·`ab` 토글 추가. S

**FUI-16 터미널에 폴더를 드롭하면 구조가 올라가지 않는다** — `term-pane.js:25,701-730` 은 `dataTransfer.files` 만 순차 업로드(entry 재귀 없음). 탐색기는 `_dropEntries/_walkEntry` 로 폴더를 편다(`file-tree-xfer.js:403-433`). README "파일 주고받기" 절은 "터미널이나 탐색기에 … 폴더를 놓으면 하위 구조까지" 라고 두 대상을 함께 말한다 — 터미널 쪽은 사실이 아니다. 조치: `_dropUpload` 로직을 공용 함수로 뽑아 터미널이 `relPath` 를 함께 보내게. S (런타임에서 폴더 File 이 어떻게 오는지는 미확인 — §7)

**FUI-17 터미널 본문 컨텍스트 메뉴가 없다** — `term-pane.js` 에 `contextmenu` 리스너 0건. 복사·붙여넣기(원격 http 에서 `navigator.clipboard` 부재 시 유일한 마우스 경로)·선택 검색·탭 이름 바꾸기·화면 지우기가 마우스로 닿지 않는다. 탐색기·git·(FUI-08 이후) 탭과의 비대칭. S/M

**FUI-18 탭·창 이름 변경에 길이 상한이 없다** — 생성 시에는 `.slice(0,64)`(`app-layout.js:132,403,455,503`) 인데 `_renameTab`(`:76-77`)·`_rename`(`app.js:568-575`)은 자르지 않는다. 수천 자를 넣으면 워크스페이스 JSON 과 사이드바 폭이 그대로 받는다. 조치: 두 곳에 같은 상한. S

**FUI-19 슬롯 간 탭 드래그가 표식은 뜨고 드롭은 조용히 무시된다** — `renderer.js:1030-1053` `dragover` 가 드롭 표식을 그리지만 `drop` → `_moveTabToPane`(`app-dnd.js:15-33`)이 `this._aw()`(포커스 슬롯의 창)에서만 pane 을 찾아 다른 슬롯의 창이면 `return`. `_splitPaneWithTab` 도 같다. 재현: 슬롯 2개에 서로 다른 창 → 왼쪽 탭을 오른쪽 pane 본문으로 끌기 → 표식 표시 → 놓으면 아무 일도 없음. 조치: pane 요소의 `_ctx.slot` 로 대상 창을 구해 `_moveTabToWindow` 규약으로 넘기거나, 다른 슬롯이면 `dropEffect='none'` 으로 표식을 끈다. S/M

### D. Runs · 에이전트 · 백그라운드 · 알림 (4)

**FUI-20 Run 멤버 attach 실패가 무피드백** — `runs-panel.js:732-733` `console.warn` 만. 카드 툴팁이 "클릭하면 … 부착한다" 고 약속하는데 실패하면 화면이 조용하다. 조치: 카드 안 인라인 오류(`runs-err-inline` 이 이미 있다). S

**FUI-21 백그라운드 도구 복귀 실패가 무피드백** — `app-tool.js:461-475` `_restoreTool`: pane 없음 → `console.warn`, `_setToolBackground(false)` 실패 → `return`. 모달은 이미 닫혔다(`app-statusbar.js` 행 클릭 → `_bgModalToggle(false)` 뒤 `_restoreTool`). 사용자는 "눌렀는데 아무것도 안 됨". 조치: 실패 시 `Toast.show`(err) — `Toast` 는 현재 앱 전체에서 1곳만 쓴다(`UX-8` 참조). S

**FUI-22 알림 센터에 개별 해제가 없다** — `app-attn.js:334-355` 항목 클릭=이동(=해제), 헤더 `모두 제거`. "이건 무시하고 나머지는 두기" 를 하려면 그 도구로 가야 한다. 조치: 항목 우측 `×`. S

**FUI-23 Run 시작이 UI 에 없다(CLI 전용)** — `RUN_EMPTY_TEXT/HINT`(`runs-panel.js:25-26`). `POST /api/runs` 는 있다. 팀 구성은 스킬(`/dongminal:team`)이 하는 것이 설계이므로 결함이라기보다 **비대칭 기록**. 조치 제안 없음(스펙 결정 사항). S(기록만)

### E. 설정 · 프리셋 · 메뉴 (3)

**FUI-24 설정 전체를 기본값으로 되돌리는 길이 없다** — 단축키만 항목별 ↶(`app-settings.js:696-697`). 테마·상태바·폴링·표시·알림에는 없고 Backup 가져오기는 "파일이 있어야" 한다. 조치: Backup 탭에 `기본값으로 되돌리기`(서버 PUT `{}` + BACKUP_KEYS 제거 + reload). S

**FUI-25 프리셋 삭제에 확인·되돌리기가 없고, 로드 실패가 무피드백** — `app-presets.js:78-84` `_deletePreset` 즉시 splice·저장. `_loadPreset`(`:44-77`)은 `_newTool` 의 throw(샌드박스 런타임 없음 등, `app-tool.js:493-498`)를 잡지 않아 클릭 핸들러에서 unhandled rejection — 창은 생기고 레이아웃은 반쯤. 조치: 삭제 인라인 확인(bg-kill 규약), 로드에 try → `_notify`. S

**FUI-26 `UIKit.menu` 는 비활성 항목의 사유를 보이지 않는다** — `ui-kit.js:441-448` `disabled` 면 클래스만; `GitMenu` 는 `disabled(target)` 가 돌려준 사유를 `title` 로 보인다(`git/menu.js:547-555`). 키보드 이동 부재는 `UX-26`. 겹침: UX-26(부분). S

### F. 모바일 (1)

**FUI-27 모바일에서 Runs·Agents 에 닿는 길이 없다** — 두 버튼이 `desktop-only`(`index.html:170,184`)이고 대체 진입점은 단축키뿐(`runsToggle`·`agentsToggle`) — 모바일에는 물리 키가 없다. `Background` 만 모바일에도 남겼다(`index.html:171-174` 주석 "모바일에서 백그라운드 도구에 닿는 유일한 통로"). `ORCHESTRATION_V2_SRS.md:742` 가 desktop-only 를 적어 두었으므로 **결정은 문서화**돼 있으나, 슬롯(FR-WSL-62 "칸은 좁은 화면에 뜻이 없다")과 달리 Runs 목록·Agents 카드는 모바일에서 뜻이 있다. 조치: 드로어(사이드바) 하단에 두 진입점, 또는 `m-drawer` 메뉴 항목. S

---

## 3. 기능 대조표

O 지원 · △ 부분 · X 미지원 · (의) 문서 근거 있는 의도적 결정

### 3.1 탐색기 — 조작 × 대상

| 조작 | 파일 | 폴더 | 심볼릭 링크 | 루트 | 다중 선택 | 비고 |
|---|---|---|---|---|---|---|
| 열기 | O(클릭=미리보기, 더블클릭=고정) | O(펼침) | X(의) FR-EDT-60 | — | X | |
| 새 파일·폴더 | O(형제) | O(안) | O(형제) | O(헤더 버튼) | — | 빈 여백 우클릭 X (FUI-12) |
| 이름 변경 | O | O | O | X(의) | X | 길이 상한 없음 (FUI-18 와 같은 부류) |
| 삭제 | O(확인+개수+dirty 표기) | O | O | X(의) | X (FUI-09) | Undo X → UX-25 |
| 이동(DnD) | O 같은 루트 | O | O(링크 자신) | 헤더=루트 드롭 O | X | 다른 루트 X (FUI-11), 자기 하위 X(의) FR-EDT-85 |
| 복사·붙여넣기 | O | O | O | O | X | 다른 루트 O(FR-WBR-61), OS 클립보드 X(의) FR-WBR-72 |
| 복제 | O | O | O | — | X | |
| 잘라내기 | X | X | X | — | X | FUI-11 |
| 업로드 | O(파일 여럿) | O(폴더 통째) | — | O | — | 실패 4지선다 O |
| 다운로드 | O | O(zip) | X(의) FR-ETR-16 | O(zip) | X | |
| 숨김 파일 토글 | X(의) 항상 표시 | | | | | features.md:63 |
| 큰 디렉터리 | 10,000 잘림 표기 O · 더 보기 X (FUI-10) | | | | | |
| 키보드(F2·Delete·화살표) | X | X | X | | | UX-4 |
| 바깥 변경 추적 | O(mtime 스탬프, 목록만) | | | | | 파일 **내용** 변경은 관측 X → FUI-02 |

### 3.2 터미널 · 탭 · 창 · 슬롯

| 기능 | 창 | 탭 | 슬롯 | 리포 행 | 비고 |
|---|---|---|---|---|---|
| 이름 변경 | O(더블클릭) | O(더블클릭, 빈값=자동복귀) | X(파생) | X(의) 경로 파생 | git 뷰 탭 X(의) FR-RTU-33 |
| 닫기 | O(dirty·busy 만 확인 → UX-2) | O | O(포커스 칸만, 의) | O(핀 해제) | 고정 행(~·메모장) X(의) |
| 재배치 DnD | O(사이드바) | O 같은 pane · O 다른 pane · O 다른 창(사이드바, 일반 창만·마지막 탭 X 의) | **X 다른 슬롯(조용히 무시, FUI-19)** | O(서버 확정) | 에이전트 카드: 같은 창 그룹 안만 O(의) FR-AGG-7 |
| 분할 | 터미널 창 O(버튼·키) · Editor 창 DnD 만(의) FR-EDT-50 · Git 창 X(의) | | 넷까지 O | | 모바일 X(의) |
| 컨텍스트 메뉴 | X | X (FUI-08) | X | X | 터미널 본문 X (FUI-17); 탐색기 행·git 뷰 O |
| 검색 | 터미널: case O · regex X · word X · n/N X (FUI-15) | 편집기 찾기: 셋 다 O · n/N O · 바꾸기 X(의) D-6 | | | 전체 grep: 옵션 X, 엔진 표기 O |
| 복사 | OSC52 3단 O · 선택 복사 브라우저 기본 | | | | 붙여넣기 브라우저 기본(브래킷 규약은 API 경로만, SRS 명시) |
| 도구 종료 뒤 | 오버레이만 · 재시작/자동 닫기 X (FUI-14) | | | | |
| 백그라운드 | 터미널 O(detach·확인창) · 편집기·run·git 탭 X(의) | | | | 복귀 실패 무피드백 (FUI-21) |
| 스크롤백 | 50,000 고정, 설정 X | | | | FE-28(메모리) 참조 |
| 프리셋 | 저장 O · 이름변경 O · 기본 지정 O · 삭제(확인 X) · 로드=새 창만(의) features.md | | | | FUI-25 |

### 3.3 컨텍스트 메뉴 두 벌

| 항목 | `GitMenu.openList` (탐색기·git) | `UIKit.menu` (ACL 확인 등) |
|---|---|---|
| Esc·바깥 클릭 닫힘 | O | O |
| 스크롤·리사이즈 닫힘 | O | 스크롤 O |
| ↑↓ Enter 이동 | O | X → UX-26 |
| disabled 사유 툴팁 | O(`title=why`) | X (FUI-26) |
| 아이콘 | X | O |
| 위험 항목 색 | (`destructive` → 확인창) | `danger` 클래스 |
| 실행 전 확인 게이트 | O(`_pick` 단일) | X(호출자 몫) |

### 3.4 데스크톱 vs 모바일

| 기능 | 데스크톱 | 모바일 | 근거 |
|---|---|---|---|
| Split H/V | O | X | `_splitInner` `isMobile` 조기 반환 — 문서 근거 미확인(§7) |
| 슬롯 | O | X | (의) FR-WSL-62 |
| Runs · Agents | O(버튼·키) | X (FUI-27) | (의) ORCHESTRATION_V2_SRS:742, 다만 대체 진입점 없음 |
| Background | O | O | index.html:171-174 |
| 터미널 검색 | Ctrl+F | 버튼 O | |
| 사이드바 | 패널·레일 | 드로어 O | |
| Editor 사이드/본문 | 나란히 | 순회 자리 O | FR-RTU-80 |
| 소프트 키보드 제어·키바 | — | O | |
| 탭·창·행 재배치(HTML5 DnD) | O | 미확인(§7) — 터치 DnD 이벤트는 표준상 발화하지 않음 | |
| 설정 모달 | O | O | |

### 3.5 키보드 vs 마우스 vs 터치 (진입점이 하나뿐인 기능)

| 기능 | 키 | 마우스 | 터치 |
|---|---|---|---|
| 사이드바 접기 | O(`sidebarToggle`) | O(손잡이) | 드로어 |
| Runs · Agents 열기 | O | O(desktop-only) | X |
| 탭 이름 변경 | X | 더블클릭 | 미확인 |
| 탐색기 파일 조작 | X(인라인 입력만) | 우클릭 | 미확인(길게 누르기 없음) |
| 슬롯 이동 | O(slotPrev/Next) | 클릭 | — |
| 편집기 저장 | O(`edSave`) | X(버튼 없음) | X |
| 터미널 검색 이전/다음 | Enter/Shift+Enter | 버튼 O | 버튼 O |

---

## 4. 의도적 설계 (결함 아님, 문서 근거)

| # | 항목 | 근거 |
|---|---|---|
| I-1 | 편집기 찾기에 바꾸기 없음 | `EDITOR_FIND_PANEL_SRS.md:334-336` §6-1, D-6 |
| I-2 | 편집기 탭은 백그라운드 불가 | `features.md:76,146` |
| I-3 | Editor 창 분할은 DnD 로만 | `features.md:70`, FR-EDT-50·51 |
| I-4 | 심볼릭 링크는 열지도 펼치지도 내려받지도 않음 | FR-EDT-60, FR-ETR-16 |
| I-5 | 사라진 Run 의 탭은 자동으로 닫지 않음 | FR-RVZ-9 (`runs-panel.js:376-377`) |
| I-6 | 슬롯은 모바일에 없음, 마지막 슬롯 넘김은 감기지 않음 | FR-WSL-62, `app-slots.js:518-533` |
| I-7 | 탐색기 dot 파일 항상 표시 | `features.md:63` |
| I-8 | 이름 충돌 시 덮어쓰기·자동 개명 없음(복사만 개명) | FR-EDT-86, D-WBR-15 |
| I-9 | 새 창은 cwd 를 승계하지 않음(홈) | FR-WBR-20 |

---

## 5. 양호 판정 (범위에서 제외할 근거)

- 탐색기 조작 넷(생성·이름변경·삭제·이동)의 낙관적 반영과 실패 되돌리기(`_snap/_restore/_rekey`) — 실패 사유가 그 자리에 붙고 다음 조작 시작·선택 변경에서 지워진다(FR-WBR-1~4).
- 업로드 실패 4지선다(재시도·건너뛰기·이후 모두 건너뛰기·중단), 상한 10,000 항목, `readEntries` 반복 읽기.
- 편집기 문서 공유 모델(FR-SVS-50~55) — 같은 파일을 두 칸에 열어도 dirty·저장이 한 번. 파괴된 뷰의 `saving` 플래그 누수까지 닫혀 있다(FR-WBR-90~92).
- 이진·이미지 파일은 열기 전 probe 로 갈라 저장 경로 자체가 생기지 않는다(FR-EVW-3·7).
- 창 삭제·탭 닫기의 dirty → busy 이중 가드와 "실행 중인 것만 백그라운드로".
- Run 삭제·백그라운드 종료의 인라인 확인·진행·오류가 데이터로 살아 다시 그려도 남는다.
- git 조작 표면(`GIT_MENUS`): cherry-pick·revert·reset·drop·rebase·merge·upstream·tag push/delete·stash apply/pop/drop·worktree·submodule 이 메뉴에 있고 파괴적 항목은 `_pick` 단일 게이트를 지난다 — "동작 자체가 없음" 류 발견 없음.
- 설정 값 검증: 폴링 주기(`pollValue` 범위·0 허용 표), 가장자리 세기(정수·범위), 탭 너비 clamp, breakpoint 320~2000 폴백.
- Backup 가져오기: kind/version 검사, 더 새로운 판 거부, 서버 실패 시 브라우저 저장소 불변.

---

## 6. 기존 발견과의 겹침 (재보고하지 않음)

| 본 리포트 | 기존 ID | 관계 |
|---|---|---|
| FUI-02 | TEST-1, SEC-7, GO-1 | 같은 종단 다른 결함(동시성 vs 경계) — 서버 수정 시 함께 |
| FUI-05·20·21 | FE-7, UX-8 | "조용히 삼켜지는 실패"·Toast 미사용의 구체 사례 3건 |
| FUI-06 | SEC-19, GO-38 | 서버 무제한의 클라이언트 짝 |
| FUI-13 | UX-4 | 접근성 축이 본체 |
| FUI-26 | UX-26 | 키 이동은 UX-26, 사유 표기는 신규 |
| 파일 삭제 Undo | UX-25 | 재보고 안 함 |
| 창 × 확인 | UX-2 | 재보고 안 함 |
| `_confirmClose` Enter | UX-1, FE-15 | 재보고 안 함 |

---

## 7. 미확인

1. **FUI-16 런타임**: Chrome/Safari 가 터미널 `drop` 의 `dataTransfer.files` 에 폴더를 어떤 `File` 로 싣는지(크기 0·읽기 실패)는 실행하지 않았다. 코드 경로상 재귀가 없다는 사실만 확인.
2. **모바일 재배치**: HTML5 DnD 가 터치에서 발화하지 않는다는 것은 표준 동작이지만 이 앱에서 실기기 검증은 하지 않았다(§3.4).
3. **모바일 Split 금지의 문서 근거**: `_splitInner` `isMobile` 반환의 SRS 출처를 찾지 못했다(WINDOW_SLOTS 는 슬롯만 다룬다).
4. `panel-changes.js:816-817` 원격 버튼 초기 `disabled` 가 뒤에 풀리는지 — git 폴링 영역이라 파지 않았다.
5. `main.js:35` `add-window` 클릭 핸들러의 `_newTool` throw 처리(샌드박스 실패 `_notify` 도달 여부) — 읽지 않았다. 프리셋 로드 경로(FUI-25)는 확인함.
6. `refresh()`(FUI-01)의 e2e 부재는 `editor-ops.spec.ts:544` R7 과 `editor-tab.spec.ts:586` 두 곳만 grep 으로 확인했다 — 다른 스펙 파일에 dirty+재열기 검증이 있을 가능성은 배제하지 않았다.

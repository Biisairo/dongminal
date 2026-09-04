# 개발자 문서

Dongminal 컨트리뷰터·유지보수자 대상 문서.

디렉터리 규칙은 하나다 — **이 폴더는 지금 읽어야 하는 문서, `archive/` 는 완료된
작업의 기록**이다. 보관 문서는 당시 어휘와 당시 코드 위치를 그대로 담고 있으므로
**갱신하지 않는다.** 지금의 사실은 `architecture.md` 와 코드가 답한다.

## 현행

| 문서 | 내용 |
|------|------|
| [NOTES_LIVE_EXPLORER_SRS.md](./NOTES_LIVE_EXPLORER_SRS.md) | **메모장 · 탐색기의 살아있는 반영 · 캐럿** (IEEE 29148). 묶음 **N**(FR-NOT) · **L**(FR-FSL) · **K**(FR-CUR). §2.1 이 인터뷰를 뒤집은 근거 — 저장 위치를 전수 조사하니 **브라우저 저장소 어디에도 "내용" 이 사는 자리가 없어**, "브라우저 세션에 저장" 요구가 서버 저장으로 확정됐다(D-1). D-2 가 이 작업의 전부다: 메모를 **파일**로 두면 메모 루트를 `Roots()` 에 한 줄 더하는 것으로 창·탐색기·편집기·조작이 전부 선다. §2.3 은 탐색기가 **바깥의 변경을 아예 반영하지 않던** 사실(폴링이 바꾸는 것은 색뿐이다)이고 D-5 가 세 후보를 견준 표, D-6 이 fsnotify 를 기각한 근거. **D-9 는 구현 중 걸린 결함의 기록** — 부분 갱신 리터럴이 셋으로 흩어져 한 자리를 빠뜨리자 메모장 창이 동기화 한 번에 사라졌다. **구현 완료** |
| [CODE_AUDIT_FIXES_SRS.md](./CODE_AUDIT_FIXES_SRS.md) | **전수검사가 찾아낸 결함의 수정** (IEEE 29148). `go vet`·`staticcheck`·`deadcode`·`go test -race`·핵심 경로 정독이 찾은 것 **전부**를 담고 고칠 순서를 근거와 함께 정한다. 핵심은 원자적 쓰기 — `domain/run/store.go` 가 "부분 쓰기가 살아 있는 파일이 되면 안 된다" 를 지키는 동안 `workspace.json`·`tools.json`·`settings.json` 과 편집기의 저장은 `os.WriteFile` 로 가고 있었다. 저장 순서 역전, HTTP 핸들러의 패닉 복구 누락도 함께. **구현 완료** |
| [WINDOW_SLOTS_SRS.md](./WINDOW_SLOTS_SRS.md) | **창 슬롯 — 두 창을 한 화면에** (IEEE 29148, `FR-WSL-*`). 접수한 요구는 "window·git·editor 를 동시에 보려고 크롬 창을 두 개 켜고 있다" 였다. 콘텐츠 영역이 `activeWindow` **하나만** 그리던 것을 칸 넷까지로 늘린다. 칸 **사이의 이동에 키를 만들지 않은 것**(D-5)이 결정의 요체 — 분할 칸 이동이 창의 끝에서 넘어간다. **구현 완료** |
| [SLOT_VIEW_STATE_SRS.md](./SLOT_VIEW_STATE_SRS.md) | **칸별 시선 — 슬롯이 창을 각자의 눈으로 본다** (IEEE 29148, `FR-SVS-*`). 같은 창을 두 칸에 놓지 못하던 것을 푼다. **관측과 시선을 가른다**(D-4·D-5) — 디렉터리 목록·git 색은 루트마다 하나(`FileTreeStore`), 펼침·선택·스크롤은 칸마다 하나(`FileTree`). 규약의 원본은 터미널이다: PTY 는 서버에 하나, xterm 은 칸마다 하나. FR-SVS-50 이 편집 문서를 **파일 경로 단위**로 못박은 근거(탭 단위면 한쪽 저장이 다른 쪽을 덮는다). **구현 완료** |
| [SLOT_RUN_VIEW_SRS.md](./SLOT_RUN_VIEW_SRS.md) | **Run 뷰의 슬롯 다중화** (IEEE 29148). 같은 창을 두 칸에 놓고 Run 탭을 활성으로 두면 **한 칸이 빈다** — 싱글턴 패널이 요소 하나를 두 자리에 붙이려 하기 때문이다. `SLOT_VIEW_STATE_SRS` 가 탐색기에 대해 세운 규약을 Run 뷰에 적용한다. **구현 완료** |
| [SLOT_TITLE_BOUNDARY_SRS.md](./SLOT_TITLE_BOUNDARY_SRS.md) | **슬롯 제목과 경계** (IEEE 29148, `FR-STB-*`). 어느 칸이 무엇을 보고 있는지(windows·git·editor)와 창 이름을 합쳐 보이고, 한 칸이 어디까지인지를 경계로 말한다. FR-STB-3 이 **창 타입의 보이는 이름을 사이드바 탭 서술자 하나에서** 가져오는 근거 — 제목이 부르는 이름과 탭이 부르는 이름이 갈리면 둘을 잇는 일이 사용자 몫이 된다. **구현 완료** |
| [TOOL_LIST_UNKNOWN_SRS.md](./TOOL_LIST_UNKNOWN_SRS.md) | **도구 목록을 모르는 순간과 재연결 폭주** (IEEE 29148, `FR-TLU-*`). `RECONNECT_STORM_SRS` 가 닫은 것은 **없는 도구**를 향한 재접속이었고, 남은 것은 그 반대다 — 살아 있는 도구를 클라이언트가 죽은 것으로 읽는 창. 요체는 **빈 목록을 사실로 받지 않는 것**(FR-TLU-5·6): 서버가 "모른다" 고 말할 수 있게 하고, 모르는 스냅숏으로는 도구도 pane 도 창도 지우지 않는다. **구현 완료** |
| [RELOAD_CONTINUITY_SRS.md](./RELOAD_CONTINUITY_SRS.md) | **새로고침의 연속성 — 자동 갱신과 잃지 않을 기억** (IEEE 29148). 새 판이 뜨면 배너를 띄우고 사용자를 기다리던 것을 **즉시 새로고침**으로 바꾸고, 그때 "이 페이지를 나가시겠습니까?" 를 묻지 않는다 — 물으면 자동이 아니게 된다. 함께 새로고침이 사이드바 선택 같은 화면 상태를 잃던 것을 고친다. **구현 완료** |
| [RESTORE_FLIGHT_SRS.md](./RESTORE_FLIGHT_SRS.md) | **복원 중에 도착한 갱신은 스냅숏보다 새롭다** (IEEE 29148, `FR-RSF-*`). `FG_RESTORE_RACE_SRS` §8 이 조사로 확정한 결함을 없앤다. 세 함수(`_attnRestore`·`_fgRestore`·`_activityRestore`)가 같은 창을 갖고 있었고, **규약을 주석으로 선언하고 손으로 옮겨 적으니 한 방향을 놓쳤다** — 그래서 규약을 함수로 옮긴다. **구현 완료** |
| [SETTINGS_PORTABILITY_SRS.md](./SETTINGS_PORTABILITY_SRS.md) | **설정 내보내기·가져오기** (IEEE 29148). 값이 세 저장소(서버 블롭·localStorage·sessionStorage)에 흩어져 새 기계에서 손으로 다시 짜야 했다. 이 창에서 설정할 수 있는 값 **전부**가 JSON 하나로 나가고 돌아온다. 가져오기를 **전체 교체**로 둔 근거와, 화면 치수·리포별 보기 취향을 담지 않은 근거가 결정에 있다. **구현 완료** |
| [ASSET_VERSION_SINGLE_SOURCE_SRS.md](./ASSET_VERSION_SINGLE_SOURCE_SRS.md) | **자산 판의 단일 출처 — `?v=` 를 손으로 적지 않는다** (IEEE 29148). `index.html` 이 캐시 무효화 번호를 **70 곳**에 적고 있었고, 자산을 고치며 올리지 않으면 브라우저가 캐시의 옛 JS 를 계속 돌린다 — 실제로 그렇게 지나간 커밋이 있다. 서버가 **자산의 내용에서 계산해** 넣는다. **구현 완료** |
| [CONFIRM_ONE_STAGE_SRS.md](./CONFIRM_ONE_STAGE_SRS.md) | **파괴적 동작의 확인을 한 걸음으로** (IEEE 29148). 확인을 두 번 누르게 하던 것을 한 번으로 줄인다. 고칠 자리가 많지 않은 이유는 **Git 의 파괴적 동작이 전부 한 자리를 지나기 때문**이다. 실수를 막는 것은 걸음 수가 아니라 기본 선택이 `취소` 이고 `Enter` 가 실행이 아닌 것이며, 그 둘은 그대로 둔다. **구현 완료** |
| [BRANCH_MENU_UNIFY_SRS.md](./BRANCH_MENU_UNIFY_SRS.md) | **브랜치 메뉴 — merge 통합과 삭제 통합** (IEEE 29148). pull/merge 가 remote 에만 되던 것, 브랜치 삭제가 local·remote 로 갈려 있던 것을 합친다 — VS Code 처럼 한 번에 둘을 지우는 선택을 준다. **구현 완료** |
| [HISTORY_BRANCH_BUTTON_SRS.md](./HISTORY_BRANCH_BUTTON_SRS.md) | **History 의 브랜치 생성 버튼** (IEEE 29148). 브랜치 생성 **기능**은 이미 있었고 닿는 길이 **우클릭뿐**이었다 — 보이는 진입점을 준다. **구현 완료** |
| [ATTENTION_FIRING_SRS.md](./ATTENTION_FIRING_SRS.md) | **알람의 발화 조건과 포커스와의 공존** (IEEE 29148). 알림 깜빡임이 포커스 링에 가려 보이지 않던 것과, 알람이 울 자리가 아닌 곳에서 울던 것. 맥박이 생기면서(`ATTENTION_PULSE_SRS`) 겹침 순서의 전제가 바뀐 것이 계기다. **구현 완료** |
| [ATTN_UTIL_RELOCATE_SRS.md](./ATTN_UTIL_RELOCATE_SRS.md) | **`app-attn.js` 의 공용 유틸을 제자리로** (IEEE 29148). `APP_STATE_EXTRACT_SRS` §7.4 가 남긴 관측의 해소 — 알림과 무관한 공용 유틸이 알림 파일에 살고 있었다. **객체 추출이 아니므로** 위임 껍데기가 없고 호출부가 한 줄도 바뀌지 않는다. **구현 완료** |
| [README_REWRITE_SRS.md](./README_REWRITE_SRS.md) | **README 재작성** (IEEE 29148). 최상위 README 가 사용자 문서가 된다 — 346줄 중 절반 이상이 빌드·패키지 트리·로드맵이었고 **그림이 하나도 없었다**(화면을 쓰는 도구인데). §2.1 이 절마다 사용자 것인지 개발자 것인지 가르고, §2.2 가 옮길 곳을 확인한다(프로세스 다이어그램만 갈 곳이 없어 `architecture.md` 로 옮겼다). §2.3 이 촬영의 제약 — 운영 화면에는 홈 경로·호스트명·실제 저장소 이름이 보이고 README 는 공개되므로 **격리 인스턴스에서만 찍는다**(D-1). D-3 은 개발자 내용을 지우지 않고 옮긴 이유, D-4 는 촬영을 스크립트로 남긴 이유. **구현 완료** |
| [LEFTOVERS_SRS.md](./LEFTOVERS_SRS.md) | **남은 둘 — 규약 위반과 헬퍼 잔재** (IEEE 29148). 묶음 **S**: `platform` 밖의 `runtime.GOOS` 셋을 걷어 `check-seams.sh` 를 되살린다 — 셋 다 "이 OS 인가" 가 아니라 **"이 능력이 있는가"** 를 묻고 있었고, 그 질문의 자리는 이미 `testpath` 에 있었다(D-1). 묶음 **R**: 설치가 **자기가 놓았던 것을 거둔다** — 폐지된 `mdview` 가 사용자 `bin/` 에 남아 있던 것이 계기다. §2.3 이 제약 — `bin/` 에는 훅·플러그인·자기 복사본이 함께 살아 **모르는 파일을 지우는 규칙은 둘 수 없다**. 그래서 기록(`.helpers`)으로 우리가 놓은 것만 거두고(D-2), 기록 이전의 이름만 폐지 목록이 맡는다(D-3). **구현 완료** |
| [PANEL_SHORTCUTS_SRS.md](./PANEL_SHORTCUTS_SRS.md) | **BG·Runs 진입점의 단축키** (IEEE 29148). 상단 툴바 다섯 중 `Agents` 만 키가 있었다. §2.1 이 착수 전 사실 — 여는 함수는 이미 있고 **버튼만이 그것을 부르는 유일한 자리**였으며, 설정 목록은 자동이 아니라 `_renderShortcutList` 의 하드코딩된 무리 배열이다(그 사실을 구현 중 e2e 가 잡아 스펙을 고쳤다). §2.2 가 쓸 수 있는 키를 고정한다 — `R` 은 `SOFT_RELOAD_SRS` D-6 이 이미 배제했으므로 `Runs` 가 `O` 를 쓴다. **구현 완료** |
| [HELPER_INSTALL_SRS.md](./HELPER_INSTALL_SRS.md) | **헬퍼 설치의 안정성** (IEEE 29148). 사용자의 Stop 훅이 `bin/dmctl: No such file or directory` 로 죽던 사건의 스펙. §2.1 이 원인 — 설치가 `os.Executable()` 을 그대로 링크하는데 `go run` 아래에서 그것은 **끝나면 지워지는 임시 산출물**이라, 설치는 성공한 채 다섯 링크가 한꺼번에 죽는다. §2.2 가 왜 이것이 개발 기계에서만 터지는지(CI 는 홈이 매번 새것), §2.3 이 왜 늦게 발견되는지(죽는 시점이 설치 뒤)를 적는다. D-1 은 `go run` 을 막는 대신 **사라지지 않을 것을 가리키게** 한 이유(릴리스 게이트가 그 명령을 쓴다), D-2 는 판정에 두 조건을 모두 요구한 이유, D-4 는 `doctor` 가 고치지 않고 알리기만 하는 이유(§2.5 — 진단이 대상을 바꾼 것이 이 사고가 퍼진 경로다). **구현 완료** |
| [WINDOW_COMMAND_SRS.md](./WINDOW_COMMAND_SRS.md) | **`dongminal window`** (IEEE 29148). 창을 여는 일과 서버를 띄우는 일을 갈라 놓는다 — `start --open` 을 폐기하고(FR-OPN-1~3) 독립 명령으로 옮겼다. §2.1 이 이유다: 이미 돌고 있는 서버에 창만 붙일 길이 없었고, `start` 를 다시 부르면 **돌던 서버를 죽이고 새로 띄운다.** D-2(죽은 서버에는 열지 않는다)·D-3(창 열기 실패는 이 명령의 실패다 — `start` 에서 경고였던 이유는 거기서 본체가 서버였기 때문)·D-5(기다리지 않는다). **구현 완료** |
| [STATUS_BAR_REFLOW_SRS.md](./STATUS_BAR_REFLOW_SRS.md) | **상태바 줄바꿈과 백그라운드 진입점 이전** (IEEE 29148). §2.1 이 실측 — 좁아진 상태바는 지표를 **잘라내고 있었다**(560px 3개·420px 5개가 표시 없이 사라졌다). `flex-shrink` 가 없어 상자가 글자보다 좁아지고, `overflow:hidden` 이 나머지를 먹었다. 고침은 `flex-wrap` 과 `flex-shrink:0` 이고, D-5 가 줄 첫 항목의 구분선을 지우는 수단(음수 마진 + 클리핑)이다. FR-SBR-7 은 고정 높이가 풀린 대가 — 상태바가 커지면 터미널을 다시 맞춰야 하는데 `window.resize` 는 그것을 알리지 않는다. 묶음 B 는 진입점을 상단바 `Runs`·`Agents` 사이로 옮기고 **FR-BGU-5(0개면 숨김)를 폐기한다**(D-3). **구현 완료** |
| [ATTENTION_PULSE_SRS.md](./ATTENTION_PULSE_SRS.md) | **주의 표식의 맥박** (IEEE 29148). 정지해 있던 `--attn` 표식이 2초 주기로 숨쉰다(1초 사라짐·1초 나타남). §2.1 이 표식이 사는 일곱 자리를 세고, D-1 이 이 작업의 전부다 — **요소가 아니라 표식을 그리는 속성을 움직인다.** `opacity` 한 줄이면 끝나지만 그 대가로 터미널 화면과 탭·창 이름이 1초마다 사라진다(§2.2). D-2 는 글자색을 고정한 이유(읽을 수 없게 되는 것은 알림이 아니다), D-4 는 `prefers-reduced-motion`. **§2.3 은 맥박이 드러낸 원래 결함의 기록** — 분할 칸의 링이 테두리와 안쪽 그림자 **두 곳**에서 나오고 안쪽 그림자를 자식이 면마다 다르게 덮어, 실측 두께가 위 2px·왼쪽 3px·아래 4px 로 어긋나 있었다. D-5 가 링을 자식 위에 뜬 겹으로 옮겨 네 변 3.00px 을 얻는다. **구현 완료** |
| [PAGE_TITLE_SRS.md](./PAGE_TITLE_SRS.md) | **페이지 제목 설정** (IEEE 29148). 브라우저 탭 이름을 Settings ▸ Display 에서 정하고 서버 설정 blob 에 남긴다. §2.1 이 제약 — 주의 배지(FR-PAN-13b)가 제목 전체를 다시 쓰므로 **합성 자리가 하나여야 한다**(`_applyPageTitle`). D-1 은 값이 브라우저별이 아니라 서버의 것인 근거(FR-TAN-19·FR-KEY-6 의 선례), D-2 는 빈 문자열이 곧 기본 이름인 이유. **구현 완료** |
| [EDITOR_TAB_SRS.md](./EDITOR_TAB_SRS.md) | **Editor 탭 — 파일 탐색기와 편집기 창** (IEEE 29148). 편집기를 일반 창의 탭에서 걷어내고 경로마다 하나씩 서는 제3의 사이드바 탭으로 옮긴다. FR-EDT-1~120, V-EDT-1~96, 확정 결정 D-1~D-29. §2 는 착수 전 조사와 1차 검증으로 굳힌 사실이며 **§2.4(`layout` 없는 창이 지워진다)가 이번 작업 최대의 제약**이다. §3.7 은 VSCode 의 폴더 색이 우선순위가 아니라 **경로 사전순 우연**임을 소스로 확인하고 모사하지 않기로 한 근거를 담는다. **구현 완료** |
| [RECONNECT_STORM_SRS.md](./RECONNECT_STORM_SRS.md) | **재연결 폭주와 헬퍼 설치의 비원자성** (IEEE 29148). 원격 접속이 한 번씩 끊기던 원인 — 사라진 도구를 향한 지연 0 의 무한 재접속이 임시 포트를 말렸다. §2 는 전부 실측(초당 95연결·TIME_WAIT 2,881·포트 16,384)이고, §2.5 는 **배포된 클라이언트 수정이 이미 열려 있는 탭에 닿지 않는다**는 사실을 재측정으로 확인한 기록이다. §6.1 에 판단 오류 둘(비목표 #4 철회·D-5 철회)을 근거와 함께 남긴다. **구현 완료** |
| [EDITOR_GIT_UX_SRS.md](./EDITOR_GIT_UX_SRS.md) | **Changes 크기조정 · Diff 개요 눈금 · Editor 검색 · 열 수 있는 형식** (IEEE 29148). 묶음 **D**(FR-CSZ) · **O**(FR-DOR) · **F·G**(FR-EQO·FR-EGS) · **V**(FR-EVW) · **K**(FR-EKB). §1.3 의 인터뷰 결정 셋이 스펙보다 앞선다. §2.4 가 착수 전 제약 — 전역 keydown 은 Monaco 안에서 돌지 않으므로 키를 두 자리에 배선해야 한다. **구현 완료** |
| [EXPLORER_TRANSFER_IGNORE_SRS.md](./EXPLORER_TRANSFER_IGNORE_SRS.md) | **무시 표시 · 폴더 단위 전송 · 경로 자동채움 · 터미널 복사** (IEEE 29148). 묶음 **A**(무시 흐림, `check-ignore` 온디맨드) · **B**(폴더 zip 다운로드) · **C**(폴더 업로드, `relPath`) · **D**(실패했을 때의 선택) · **E**(`+ Add` 의 자동채움) · **F**(OSC 52). §2.4 와 §2.5 가 실측으로 굳힌 두 결함이 핵심이다 — 서버가 **자기 cwd 를 그럴듯하게** 답하고 있었고, xterm 은 OSC 52 를 **받는 사람이 없었다**. D-4 는 폴더를 폴더 그대로 내려받는 길(File System Access API)이 secure context 를 요구해 막힌 기록이며, D-12 가 복사에서 같은 벽을 만난다. **구현 완료** |
| [SOFT_RELOAD_SRS.md](./SOFT_RELOAD_SRS.md) | **내부 새로고침** (IEEE 29148). 페이지를 다시 열지 않고 서버의 사실만 다시 받는다. §2.1 이 요점 — **조각은 이미 다 있고 부르는 자리가 없었다**(복원 경로 다섯은 SSE `onopen` 만 쓰고 있었다). §2.2 는 왜 그것으로 부족한지를 적는다: 구독이 형식상 살아 있는데 브로드캐스트를 놓친 경우 회복의 계기가 없다. 터미널은 **전부** 다시 붙이되 pane 은 다시 만들지 않는다(D-2·D-3) — 그 구분이 페이지 새로고침과의 차이 전부다. **구현 완료** |
| [CONNECTIVITY_RESILIENCE_SRS.md](./CONNECTIVITY_RESILIENCE_SRS.md) | **재연결 폭주의 종식과 끊긴 순간의 기록** (IEEE 29148). 묶음 **A**(붙잡기) · **B**(진단 스냅샷). **원인을 고치지 않는다** — 아직 모른다(D-6). 대신 밝혀진 유일한 실제 결함을 없애고, 다음 발생 때 원인이 확정되도록 준비한다. §2.2 가 핵심이다: `onclose` 가 재연결의 유일한 계기이므로 **닫는 한 재연결은 반드시 온다** — 지연은 주기를 늘리고 거절은 오히려 줄인다. §2.5 는 구현 중 실측으로 FR-CNR-6 을 뒤집은 기록이다(hijack 뒤에는 `r.Context()` 가 절단을 알리지 않는다). **구현 완료** |
| [CONNECTIVITY_INVESTIGATION.md](./CONNECTIVITY_INVESTIGATION.md) | **간헐적 접속 불가 — 조사 노트** (SRS 가 아니다). SSH 까지 끊긴다는 새 사실 때문에 `RECONNECT_STORM_SRS` 와 같다고 단정할 수 없다. §1 은 확정한 사실(폭주는 17분의 1 로 줄었으나 **멎지 않았다** · 절전은 배제 · 데몬이 둘), §2 는 근거 없는 가설 셋, §3 은 **끊긴 그 순간에** 찍어야 할 명령과 그것을 가르는 표다. 원인이 서면 그때 SRS 를 연다 |
| [UX_REVISION_SRS.md](./UX_REVISION_SRS.md) | **Run 수명 · 사이드바 블루프린트 · 편의 개정** (IEEE 29148, `FR-BLP-*` 외). 세 묶음 아홉 줄의 요구를 받는다. 요체는 **사이드바 목록의 블루프린트화** — 창 목록과 Git 핀 목록은 같은 것인데 각자 reconcile·드래그·행 생성을 구현하고 있었고, 그래서 한쪽에만 있는 동작이 생겼다(핀 재배치가 폴링까지 옛 순서로 남던 것). 구현을 하나로 내리고 **탭은 타깃만** 준다(D-3). **구현 완료** |
| [GIT_VIEW_REFRESH_SRS.md](./GIT_VIEW_REFRESH_SRS.md) | **Git 창 — 쓰기 뒤 뷰 갱신의 누락** (IEEE 29148, `FR-GVR-*`). "push 를 했는데 history 가 바로 안 바뀐다" 의 실체는 **아예 갱신하지 않는 것**이었다. §2.1 이 갱신을 부르는 자리를 전수로 세고, 원격 경로에만 그 대응물이 없음을 보인다. **갱신을 부르는 자리만 고친다** — 폴링 주기도 파일 감시도 손대지 않는다. **구현 완료** |
| [REPO_TAB_UNIFY_SRS.md](./REPO_TAB_UNIFY_SRS.md) | **Git·Editor 통합 — 저장소 하나에 창 하나** (IEEE 29148, `FR-RTU-*`). `Git`·`Editor` 두 사이드바 탭이 `Repo` 하나가 되고, 창의 좌측은 `Explorer`↔`Changes` **탭 교체**이며 diff·history 는 본문에 **편집기 탭과 같은 자격으로** 뜬다. 옛 `WINDOW_TYPE_GIT` 창은 로드에 사라진다. §7 의 **결정 32개**가 본문보다 앞서며, 그중 D-RTU-16~32 는 **구현이 스펙을 뒤집은 것**이다 (관측기를 저장소마다 · 인라인 미리보기 폐기 · 한 번 클릭 = diff · 뷰 탭의 닫기·드래그 · 관측 게이트를 표면으로 · 모바일 영역 순회). **구현 완료** |
| [REPO_TAB_UNIFY_HANDOFF.md](./REPO_TAB_UNIFY_HANDOFF.md) | 위 마일스톤의 **인계 노트** (SRS 가 아니다). 스펙이 말하지 않는 것 — 왜 그렇게 됐는지, e2e 가 크게 바뀐 자리, e2e 정리에서 드러난 **구현 결함 열하나**, 남긴 관찰(좁은 사이드에서 바의 가운데가 버튼이 되는 문제) |
| [GIT_DIR_ENTRY_SRS.md](./GIT_DIR_ENTRY_SRS.md) | **디렉터리 상태 항목** (IEEE 29148, `FR-DIR-*`). 서브모듈·중첩 저장소는 **폴더가 상태의 단위**다 — `git status` 가 `dir/` 한 줄로 접는 것을 이름 있는 항목으로 펴고, 그 자리에 사유와 진입점을 보인다. 루트가 저장소 **안**이어도 색을 입힌다 (FR-DIR-40). **구현 완료** |
| [SANDBOX_PICK_COPY_SRS.md](./SANDBOX_PICK_COPY_SRS.md) | **샌드박스 선택창과 scratch 복사** (IEEE 29148, `FR-SPK-*`). 샌드박스 창을 열 때 작업 폴더를 고르고, 원본 대신 **복사본**을 컨테이너에 줄 수 있게 한다 — 그 사실은 창의 목록 배지로 남는다. **구현 완료** |
| [GIT_HEAD_MOBILE_SRS.md](./GIT_HEAD_MOBILE_SRS.md) | **Git 머리의 왼쪽 정렬 · History 이식 · 모바일 폭** (IEEE 29148). 상단 버튼의 정렬, Changes 의 버튼 무리를 History 에도 세우는 일, 좁은 폭에서의 배치. **구현 완료** |
| [GIT_REPO_MISSING_SRS.md](./GIT_REPO_MISSING_SRS.md) | **Git 리포 소실** (IEEE 29148). "저장소 폴더가 사라졌다" 를 서버가 **확정된 사유로 분류**하게 하고, 패널이 낡은 목록 대신 그 사실을 보이며 그 자리에서 핀을 제거할 수 있게 한다. **구현 완료** |
| [GIT_ACTIONS_SRS.md](./GIT_ACTIONS_SRS.md) | **Git 창의 동작 표면 완성** (IEEE 29148). "VSCode Git · Git Graph 의 GUI 기능을 다 갖춘다" 는 결정의 단일 진실 공급원. 범위의 출처는 `GIT_SURFACE_MAP.md` 의 126항목이다 |
| [GIT_FOLLOW_REMOVAL_SRS.md](./GIT_FOLLOW_REMOVAL_SRS.md) | **follow 제거와 리포 추가 개선** (IEEE 29148). `follow` 를 표면에서 걷어내고, 그것이 유일하게 하던 일(핀하지 않은 리포로 가는 한 번의 클릭)을 `+ Add` 가 대신하게 한다. **구현 완료** |
| [FILE_TRANSFER_SRS.md](./FILE_TRANSFER_SRS.md) | **파일 전송과 탐색기 이동** (IEEE 29148, `FR-FTR-*`). 업로드·다운로드를 바로잡고 그것을 **편집기의 파일 탐색기에서도** 쓰게 한다. 탐색기의 전송이 조회·조작과 **같은 루트 가드**를 받는 근거가 여기 있다. **구현 완료** |
| [BRACKETED_PASTE_SRS.md](./BRACKETED_PASTE_SRS.md) | **붙여넣기 모드를 물어보고 감싼다** (IEEE 29148). API·에이전트가 넣는 입력이 **조건 없이** bracketed paste 로 감싸여 나가던 것 — 받는 프로그램이 그 모드를 켜지 않았으면 제어열이 글자로 새어 들어간다. **구현 완료** |
| [BRIGHT_DARK_THEMES_SRS.md](./BRIGHT_DARK_THEMES_SRS.md) | **Bright Dark 테마 추가** (IEEE 29148). 다크이면서 배경 휘도·채도가 높아 "밝게 느껴지는" 테마군. 아카이브의 `THEMES_EXPANSION_SRS` 후속. **구현 완료** |
| [ICON_ASSETS_SRS.md](./ICON_ASSETS_SRS.md) | **아이콘·파비콘 자산** (IEEE 29148). 파비콘·터치 아이콘·PWA 아이콘의 크기·형식·생성 경로 |
| [RELEASE_SRS.md](./RELEASE_SRS.md) | **바이너리 배포 — GitHub Releases** (IEEE 29148). 쓰려면 클론해서 Go 로 빌드해야 하던 것을 릴리스 애셋으로 바꾼다. **바이너리를 저장소에 커밋하지 않는 근거가 실측으로 §2.1 에 있다**(5종 69MB · git 은 모든 판을 영구 보관 · 델타 압축이 먹지 않는다). darwin 을 macOS 러너에서 빌드해야 하는 이유(CGO 가 꺼지면 지표가 조용히 빠진다)도 여기다. **구현 완료** |
| [CROSS_PLATFORM_SRS.md](./CROSS_PLATFORM_SRS.md) | **OS 이음매의 인터페이스화 · Linux/WSL/Windows 지원** (IEEE 29148). darwin 전용이던 것은 설계가 아니라 **OS 의존 호출이 부르는 자리에 그대로 박혀 있었기 때문**이다. `syscall.Kill`·`Setsid`·`/proc`·`lsof`·`pgrep`·`/bin/bash`·unix 소켓을 `platform` 뒤로 모은다. §11 이 실기 기록이다 |
| [CROSS_PLATFORM_HANDOFF.md](./CROSS_PLATFORM_HANDOFF.md) | 위 작업의 인계 문서. 네 트랙 종료 시점의 상태와 CI 잡 넷이 초록이 된 근거. ConPTY 의 원인이 `STARTF_USESTDHANDLES` 하나였다는 결론이 §0 에 있다 |
| [WINDOWS_TEST_PARITY_SRS.md](./WINDOWS_TEST_PARITY_SRS.md) | **Windows 테스트 패리티** (IEEE 29148). `test (windows-latest)` 가 **도입 이래 한 번도 통과한 적이 없었다** — 한 번도 초록이 아니었으므로 아무도 읽지 않았고, 그 사이 실패 356줄 아래 **제품 결함 4건**이 묻혀 있었다. 초록이 아닌 검사는 없는 검사라는 사실의 기록. **구현 완료** |
| [E2E_UNIFICATION_SRS.md](./E2E_UNIFICATION_SRS.md) | **종단간 검증의 통일 — 세 OS 가 같은 목록을 돈다** (IEEE 29148, `FR-E2I-*`). macOS 는 셸 스크립트 21항목, Linux·Windows 는 CI 인라인으로 5단계를 돌았고 **세 벌이 서로의 목록을 몰랐다.** Go 한 벌(`dongminal verify`)로 모은다 — 두 벌이면 한쪽만 고쳐지고, 실제로 그런 적이 있다(D-3). **구현 완료** |
| [HANDOFF_WS2.md](./HANDOFF_WS2.md) | 인계 — WS-2 헤드리스 멤버 (`ORCHESTRATION_V2_SRS` §3.2, `FR-HLM-1~12`). 브리핑을 기억으로 쓴 사고의 기록이 머리말에 있다 |
| [HANDOFF_WS4.md](./HANDOFF_WS4.md) | 인계 — WS-4 패턴 카탈로그 + P2P 봉인 해제 (`ORCHESTRATION_V2_SRS` §3.4). 묶음 P 완료·승인 시점의 상태와 남은 하나 |
| [building.md](./building.md) | **빌드·검사·배포.** 받아 쓰는 사람에게는 필요 없다 — README 가 사용자 문서가 되면서 옮겨 온 개발자 절이다 (`README_REWRITE_SRS` FR-RDM-9) |
| [architecture.md](./architecture.md) | 패키지 레이아웃, **에이전트 접합면과 Run**, **에이전트 어댑터 레지스트리**, **멤버 프리앰블**, 어댑터 패턴, 커맨드 브로드캐스트, 핫패스 성능, 종료 경로 |
| [test-checklist.md](./test-checklist.md) | 백엔드·프론트엔드 동작 체크리스트 + 테스트 커버리지 현황 |
| [ENTITY_MODEL_RESTRUCTURE_SRS.md](./ENTITY_MODEL_RESTRUCTURE_SRS.md) | 엔티티 모델(Window ─ Pane ─ Tab ─ Tool)과 백그라운드 도구의 단일 진실 공급원. 요구 1·2 완료. §7 의 Run 접합면(FR-EM-17/18)은 후속 작업의 근거다 |
| [ENTITY_MODEL_HANDOFF.md](./ENTITY_MODEL_HANDOFF.md) | 위 작업의 인계 문서 — 확정된 모델과 근거, P1~P8 완료 내역, **반복하면 안 되는 함정 7개**, 검증 방법 |
| [USER_CHECKLIST_FIXES_HANDOFF.md](./USER_CHECKLIST_FIXES_HANDOFF.md) | 트랙 1(사용자 확인 피드백)의 인계 문서. 스펙·계획은 `archive/` 로 보관됐고 이 문서만 현행이다 — §4 의 **반복하면 안 되는 함정 15개**가 계속 유효한 필독 자료이기 때문 |
| [SYSTEM_STATS_SRS.md](./SYSTEM_STATS_SRS.md) | 상태바 지표 수집 재설계 (IEEE 29148). `/api/stats` 요청당 프로세스 6개·1.5초를 커널 직접 호출로 제거 + 메모리 계산식 정정. **구현 완료** (§4.1 실측) |
| [WORKSPACE_IDENTITY_SRS.md](./WORKSPACE_IDENTITY_SRS.md) | 식별자와 단일 실행자의 단일 진실 공급원 (IEEE 29148). 묶음 I(엔터티 id → uuid)·X(생성 명령 단일 실행자)·**U(모든 발급 지점을 uuid 로 통일 + 형태 판별 제거)**. **구현 완료** |
| [SKILL_INJECTION_SRS.md](./SKILL_INJECTION_SRS.md) | MCP 폐지와 세션 스코프 스킬 주입의 단일 진실 공급원 (IEEE 29148). 에이전트 접합면 = `dmctl` (액션) + `--plugin-dir`/`--settings` 주입 스킬·훅 (정책). **구현 완료** |
| [RUN_ORCHESTRATION_SRS.md](./RUN_ORCHESTRATION_SRS.md) | AI 오케스트레이터의 단일 진실 공급원 (IEEE 29148). Run 레코드·상태/대기 계약·에이전트 어댑터 레지스트리·worktree 격리·프리앰블/보고 계약·스킬 재작성. 착수 전 결정 5건 확정. **묶음 S·R·P·A·K 구현 완료, W 남음** |
| [ORCHESTRATOR_RESEARCH_NOTES.md](./ORCHESTRATOR_RESEARCH_NOTES.md) | 위 SRS 의 입력 — orca(MIT)·paseo(AGPL) **실제 소스** 조사 노트. 파일 경로 근거 포함. §9 는 기존 문서 서술을 뒤집은 5건 |
| [WAVE1_HANDOFF.md](./WAVE1_HANDOFF.md) | **3축 병렬 웨이브 1 의 완료 기록.** 워크스트림 **8개 전부 완료** — WS-1 식별자 uuid 전용화 · WS-2 헤드리스 멤버 · WS-3 컨텍스트 예산·승계 · WS-4 패턴 카탈로그+P2P · WS-5 Run 시각화 · WS-6 사이드바 탭 · WS-7 전경 프로세스 탭 이름 · WS-8 백그라운드 즉시 종료. §2 남은 것(수동 실사 M-1~M-10 · e2e 미실행) · §3 판정 기록 · **§5 반복하면 안 되는 것** — 브리핑을 기억으로 쓴 사고 3회, 대칭적 추종으로 같은 항목이 열 번 뒤집힌 사고, 게이트 전제, 플레이크 판정, "서버 완성 ≠ 기능 완성" · §7 커밋 분할 |
| [PARALLEL_DELIVERY_PLAN.md](./PARALLEL_DELIVERY_PLAN.md) | **아래 세 SRS 를 한 번에 다루는 실행 계획.** §2 확정 결정 12건(스펙보다 앞선다) → §3 파일 단위 충돌 지도(핫스팟 6개) → §4 **Step 0 골격 선행 커밋**(동작 불변 리팩터, 게이트 3종) → §5 8 워크스트림·배타적 파일 소유권·웨이브 배치 → §7 통합 게이트와 수동 실사 10항목. §6 은 dongminal 자신의 팀 Run 으로 실행하는 구성(부트스트랩 주의 포함), §8 은 후속 독립 트랙(expose 인증·cross-platform)의 착수점. **완료 (2026-08-28 웨이브 1)** |
| [ORCHESTRATION_V2_SRS.md](./ORCHESTRATION_V2_SRS.md) | **오케스트레이션 2세대** (IEEE 29148). 묶음 **I** 식별자 uuid 전용화(FR-IDU) · **H** 헤드리스 멤버(FR-HLM) · **C** 컨텍스트 예산·승계(FR-CBG) · **P** 패턴 카탈로그(FR-PAT) · **V** Run 시각화(FR-RVZ). §2.1 은 조사로 확정한 현재 상태 — **레이아웃 경로는 이미 uuid 전용이고 IO 경로가 라벨을 받는다**는 역전이 핵심 사실이다. **완료 (2026-08-28 웨이브 1)** |
| [ATTENTION_LIFECYCLE_GIT_OBSERVE_SRS.md](./ATTENTION_LIFECYCLE_GIT_OBSERVE_SRS.md) | **도구 알람의 수명과 핀 리포 전체 관측** (IEEE 29148). 묶음 **L** 도구가 죽으면 알람도 죽는다(FR-ATL — 활동만 정리하고 주의를 남기던 네 자리) · **J** 탭 없는 도구의 알람이 착지하는 자리(FR-ATJ) · **O** Git 탭 진입 시 핀 전부 관측(FR-GOB, `?observe=1`). §2.1 의 감사 A1~A14 가 근거다 — **주의와 활동은 직교하는 두 레이어인데 정리 규약이 활동에만 있었다**는 것이 알람 결함의 뿌리다. D-2 로 `GIT_SIDEBAR_TABS_SRS` FR-SBT-12(Git 탭 헤더 배지)를 **폐기**한다 — 관측을 Git 탭 안으로 가둔 이상 그 밖의 숫자는 근거가 없다. **구현 완료** |
| [GIT_SIDEBAR_TABS_SRS.md](./GIT_SIDEBAR_TABS_SRS.md) | **사이드바 상단 탭** (IEEE 29148). Windows/Git 의 세로 공존(`max-height:40%`)을 탭 전환으로 대체. FR-SBT-1~33. §3.6~3.8 은 2026-08-28 인터뷰로 추가된 것 — **탭의 서술자 인터페이스화**(새 탭 = 서술자 1개) · **탭 선택이 콘텐츠 창까지 전환** · **탭마다 직행 키 + 순회 키 재해석**. 이로써 `GIT_REMAINING` §1.2 의 보류건 **I5·I6 이 함께 닫힌다**. §7 은 철회된 결정 2건(D-4·D-6)과 그 근거. §4.1 은 착수 첫 작업 — 기존 Git e2e 의 가시성 전제 영향 범위 확정. **완료 (2026-08-28 웨이브 1)** |
| [CONVENIENCE_SRS.md](./CONVENIENCE_SRS.md) | **편의 기능** (IEEE 29148). 묶음 **N** 전경 프로세스 자동 탭 이름(FR-TAN, 수동 이름이 영구히 이긴다) · **X** 백그라운드 도구 즉시 종료(FR-BGK, 확인 필수·전체 종료 없음). §2.1(c) 가 핵심 제약을 고정한다 — **데몬 모드는 PTMX 를 노출하지 않으므로 전경 프로세스 조회는 데몬 안에서 수행하고 IPC 로 실어 나른다.** FR-TAN-23/24 는 그 조회를 단일 함수 + build tag 로 격리해 cross-platform 후속 트랙이 갈아낄 자리를 만든다. §6 비목표에 분리한 둘(expose 인증·cross-platform). **완료 (2026-08-28 웨이브 1)** |
| [GIT_SRS.md](./GIT_SRS.md) | **Git 창의 단일 진실 공급원** (IEEE 29148). FR-GIT-1~178, 검증 V1~V69, 21단계 구현 계획. §7 은 확정 결정 O1~O14, §7.1 은 요구사항 해석 I1~I8 |
| [GIT_REMAINING.md](./GIT_REMAINING.md) | **Git 트랙에서 아직 끝나지 않은 것 전부.** §1 사용자 검토 10건 — **오류 3건은 완료**(§1.3·§1.4 에 전수 조사 결과·E4·Git Graph 재구현), **개선 7건은 미착수이며 §1.2 에 착수점과 물어야 할 결정이 있다** · §2 수동 실사 잔여 · §3 문서 흡수 · §4 P1/P2 로 미뤄둔 기능(**2026-08-27 지시로 범위 안**, §4.1 의 자격증명·한글 안내문만 예외) · §5 알려진 간헐 실패 · §6 트랙 밖 별건. **목표는 여기 남은 전부를 끝내는 것이고, 이것이 다음 세션의 출발점이다** |
| [GIT_REVIEW4_SRS.md](./GIT_REVIEW4_SRS.md) | **4차 사용자 검토의 오류 3건 명세** (IEEE 29148). `GIT_SRS`·`GIT_UI_REVISION_SRS` 를 개정한다. **FR-RPT-1~8** 은 Git 밖까지 걸리는 교차 규약이다 — 바깥 계기(폴링·SSE)의 다시 그리기가 요소 상태(hover·더블클릭·드래그·선택·툴팁)를 깨뜨리지 않게 하는 규칙이고, 공통 수단은 `web/js/ui/repaint.js` 다. **§2.3.1 은 VSCode Git Graph 의 배치 규칙 R1~R4 를 근거 코드와 함께 고정한다.** FR-GIT-227~235, V104~V131. §3.6 은 개선 7건이 착수될 때 채워진다 |
| [GIT_SURFACE_MAP.md](./GIT_SURFACE_MAP.md) | 위 SRS 의 입력 — VSCode·gitMaster·Git Graph 의 기능 126개를 6개 표면(S1~S6)에 배치하고 P0/P1/P2 로 나눈 지도. **MVP = P0 38개** |
| [GIT_INTEGRATION_ANALYSIS.md](./GIT_INTEGRATION_ANALYSIS.md) | 같은 SRS 의 설계 근거 (Informative). §3.5 확정 설계(창 싱글턴·고정 탭·Monaco DiffEditor), §4.5 변경 감지 실측(fsnotify·watcher·fsmonitor 기각 근거) |
| [design/](./design/) | **21단계 구현 계약** (`GIT_M*_STEP*_CONTRACT.md`). 각 단계 착수 시 SRS 를 다시 해석하지 않고 이 문서를 단일 진실 공급원으로 삼는다. `design/README.md` 가 색인·픽스처 규약·검증 게이트 |
| [PACKAGE_RESTRUCTURE_SRS.md](./PACKAGE_RESTRUCTURE_SRS.md) | **프로세스 축 패키지 재구성의 단일 진실 공급원** (IEEE 29148). `internal/` 을 helper·daemon·webserver·ctl + `shared/` 로 재배치하고, 대형 패키지 3개(`server` 19,653줄 · `git` 10,936줄 · `app.js` 2,999줄)를 역할별로 갈랐다. §2.1 의 프로세스×패키지 실행 행렬과 §2.3 의 Go 메서드-패키지 제약 실측이 구조를 결정한 근거다. **16단계 전량 구현 완료** (§8.10·§8.11·§8.12) — 프로세스 축 밖 패키지 0개, `handlers_api.go` 701→262줄. §8 은 스펙 이탈 D-1~D-7 과 15·16단계 기록 — 특히 D-1·D-5 는 측정 방법의 결함(경계를 넘는 비공개 멤버 접근을 놓쳤다)을, §8.12 는 §5 비목표 #4 를 철회한 근거를 담는다 |
| [DEEPENING_REFACTOR_SRS.md](./DEEPENING_REFACTOR_SRS.md) | **얕은 모듈 깊이화 리팩터의 단일 진실 공급원** (IEEE 29148). 프로세스 축 구조 **안에서** 계약이 복제된 자리 여섯을 깊이화한다 — 묶음 A `apierr`(sentinel → (status, code) 등록부, 번역기 17개 흡수 + 전수성 강제), B git 쓰기 파이프라인(`gitwrite.go`, 순서 불변식을 타입이 쥔다), C 프론트 `gitFetch`(stale·echo 가드 회수), D `constants.js` 주제별 분할, E `Deps` 임베딩, F `ctl/cli` 액션 표. **전량 구현 완료** — §7 이 측정·무동작변경 증명·의도한 행위 변경 셋을 담는다. §1.1 은 복제가 이미 드리프트한 증거(`core.ErrRefName` 이 두 코드로 갈렸다)를, §3.2.2 는 묶음 B 가 드러낸 잠재 결함(nil Git 역참조 패닉, 검사가 22곳에 복제돼 세 곳이 빠져 있었다)을 적는다 |
| [SPLIT_REFACTOR_SRS.md](./SPLIT_REFACTOR_SRS.md) | **통짜 파일 넷 분할의 단일 진실 공급원** (IEEE 29148, 요구 번호 `FR-MSP-*`). 앞선 두 리팩터가 남긴 것은 깊이의 문제가 아니라 **자리**의 문제다 — 이 저장소가 이미 확립한 분할 관행(`Object.assign` 프로토타입 증강 · 타입이 곧 파일)을 네 파일만 따르지 않았다. 묶음 A `toolhub/tool.go` 1,390→5파일, B `git/panel.js` 2,984→10파일, C `ui/file-tree.js` 1,279→5파일, D `style.css` 2,673→4파일. **전량 구현 완료** — §2.2 는 `DEEPENING_REFACTOR_SRS` 비목표 N6("크지만 얕음의 증거를 못 찾았다")을 **뒤집지 않고** 판정 기준이 다름을 밝히고, §7.2 는 무동작변경을 diff·바이트 동일·멤버 집합으로 증명하며, §7.3 은 구간 경계가 메서드의 **선행 주석**을 앞 구간에 떨구는 것을 실측으로 기록한다 |
| [E2E_HELPER_RECLAIM_SRS.md](./E2E_HELPER_RECLAIM_SRS.md) | **e2e 헬퍼 회수와 죽은 코드 정리** (IEEE 29148, `FR-EHR-*`). `fixtures.ts` 가 있는데도 87개 스펙이 같은 헬퍼를 각자 정의하던 것(`waitForInit` 63 · `copyFx` 22 · `openGit` 20)을 거뒀다 — **본문이 바이트 동일한 것만**, 변종은 그대로. §2.1 이 검증 독립성 원칙(`toHaveCount(7)` 을 `GIT_VIEWS.length` 로 바꾸지 않는 이유), §7.5 가 억제 주석으로 덮으려다 지적이 가리키던 것 자체를 없앤 기록 |
| [FG_RESTORE_RACE_SRS.md](./FG_RESTORE_RACE_SRS.md) | **전경 이름 복원이 새 이름을 지우던 경쟁** (IEEE 29148, `FR-FGR-*`). `_fgRestore` 가 "`_attnRestore` 와 같은 규약" 이라 주석에 써놓고 그 규약(지울 후보를 요청 전에 확정)을 지키지 않았다. §7.1 이 **기각된 가설 둘의 기록**이고, §7.2 가 계측으로 확정한 근거다. 재시도로 덮지 않았다 |
| [APP_STATE_EXTRACT_SRS.md](./APP_STATE_EXTRACT_SRS.md) | **App 의 상태를 소유자에게 돌려주는 리팩터** (IEEE 29148, `FR-ASE-*`). 묶음 A(`RunsPanel`)만 완료 — `app-runs.js` 730→38줄. **§7.2 가 앞선 측정의 정정**(`this.<이름>` 을 전부 필드로 세어 56%→실제 46%), **§7.3 이 추출의 세 조건**, §2.3 이 최대 함정(형제 파일은 `app.` 이 아니라 `this.` 로 만진다). 남은 후보 셋은 현재 측정으로 **전부 보류** |
| [REFACTOR_HANDOFF.md](./REFACTOR_HANDOFF.md) | **`refactor` 브랜치 인수인계.** 네 단계의 결과·반드시 지킬 절차·손대지 않기로 한 것과 사유. 다음 세션은 [REFACTOR_NEXT_SESSION.md](./REFACTOR_NEXT_SESSION.md) 를 첫 메시지로 붙여넣는다 |
| [CLI_CONSOLIDATION_SRS.md](./CLI_CONSOLIDATION_SRS.md) | 운영 스크립트 8개를 바이너리 액션 4개(`start`/`stop`/`migrate`/`health`)로 통합하고 `scripts/` 에 `build.sh` 하나만 남긴 근거 (IEEE 29148). **구현 완료** |
| [MOBILE_TUI_INPUT_SCROLL_SRS.md](./MOBILE_TUI_INPUT_SCROLL_SRS.md) | **모바일 TUI 입력·스크롤 교정의 단일 진실 공급원** (IEEE 29148). FR-MTI-1~19, TC-MTI-1~14. xterm 을 포크하지 않고 앱 계층에서 교정한다 — `beforeinput` 가로채기(중복·유실 제거), 터치 감도 배율+관성, `visualViewport` fit 병합, 키바 포커스, sticky modifier. **구현 완료** |
| [MOBILE_TUI_SCROLL_INPUT_ANALYSIS.md](./MOBILE_TUI_SCROLL_INPUT_ANALYSIS.md) | 위 SRS 의 입력 — 실측 근거 (Informative). 대상 TUI 가 켜는 터미널 모드 캡처, 터치 1:1 스크롤 수치, `CompositionHelper._handleAnyTextareaChanges` 의 중복·유실 재현. §2 는 초기 판정(`_inputEvent` 게이트)을 관측 시점 오류로 정정한 기록을 남긴다 |
| [GIT_MANUAL_CHECKLIST.md](./GIT_MANUAL_CHECKLIST.md) | Git 창 수동 검증 체크리스트 (V14·V60). 자동 테스트가 잡지 못하는 것만 — 배치·색·읽힘, 모바일 실기기, 성능·보안 기준. 픽스처(`e2e/git_fixture.sh`) 기준 |
| [NEXT_SESSION_PROMPT.md](./NEXT_SESSION_PROMPT.md) | 다음 세션 첫 메시지로 붙여넣을 프롬프트(파일 전체가 그대로 첫 메시지다). **열려 있는 것은 Git 창 하나** — 재구성 트랙은 16단계로 닫혔다. `GIT_REMAINING.md` 가 출발점이고, 착수 전에 물어야 할 것(단축키 배정 · "원래 있던 윈도우"의 정의 · 자격증명 배제 유지 여부)과 반복하면 안 되는 함정(`stop` 의 포트 기반 대상 선정, BSD `sed` 의 `\b`, 보호 테스트 약화)을 담는다 |

## 용어

좌표계는 `W{n}.P{n}.T{n}` 이고 계층은 아래와 같다. 보관 문서의 `session`·`region`·
`paneId` 는 각각 아래의 Window·Pane·Tool 을 뜻한다.

```
공간 축:  Client ▶ Window ─ Pane ─ Tab ─ Tool
실행 축:  Run ─ Member ──1:1──▶ Tool        (직교. 접합 필드만 구현됨)
```

| 용어 | 뜻 |
|------|----|
| **Client** | 브라우저 창. 휘발성 뷰포트. Window 하나에 attach |
| **Window** | Pane 들을 담는 작업공간. 서버 영속. tmux 의 session |
| **Pane** | Window 안에서 나뉜 공간. 탭 목록 보유 |
| **Tab** | 도구를 담는 공간 |
| **Tool** | 탭에 탑재되는 실체 (`terminal` \| `editor`) |
| **Run** | 오케스트레이션 실행 인스턴스 (미구현) |

`paned`·`paned.sock`·`paned.pid` 는 **데몬 프로세스의 이름**이며 개명 대상이 아니다.
`internal/ctl/migrate` 안의 `panes.json`·`region`·`paneId` 는 **구 어휘가 입력**이라
그대로 둔다.

## 보관 (`archive/`) — 완료된 작업의 기록

### 아키텍처 · 리팩터

| 문서 | 시점 |
|------|------|
| [ARCHITECTURE_DEEPENING_RFC.md](./archive/ARCHITECTURE_DEEPENING_RFC.md) — C1–C5 모듈 심화 | 2026-04 |
| [FOLLOWUP_HOTFIX_RFC.md](./archive/FOLLOWUP_HOTFIX_RFC.md) — H1–H5·F1–F4. H5 는 workspace 비동기 쓰기 | 2026-04 |
| [DESIGN_REVIEW_FOLLOWUP.md](./archive/DESIGN_REVIEW_FOLLOWUP.md) — 설계 리뷰 후속 계획 | 2026-05 |
| [APP_DECOMPOSE_SRS.md](./archive/APP_DECOMPOSE_SRS.md) — App 클래스 3분할 | 2026-05 |
| [PANE_MANAGER_DECOMPOSE_SRS.md](./archive/PANE_MANAGER_DECOMPOSE_SRS.md) — PaneManager 분해 + mutex 정리 | 2026-05 |
| [HANDLERS_API_ROUTER_SRS.md](./archive/HANDLERS_API_ROUTER_SRS.md) — handlers_api 라우터 테이블화 | 2026-05 |
| [WORKSPACE_SNAPSHOT_SRS.md](./archive/WORKSPACE_SNAPSHOT_SRS.md) — Workspace Snapshot 단일 진입점 | 2026-05 |
| [MCP_BIND_HELPER_SRS.md](./archive/MCP_BIND_HELPER_SRS.md) — MCP typed bind helper. **전체 폐지** (SKILL_INJECTION_SRS §6) | 2026-05 |
| [RUNTIME_HELPERS_GO_SRS.md](./archive/RUNTIME_HELPERS_GO_SRS.md) — 런타임 헬퍼 Go 재작성 | 2026-05 |
| [TS_MIGRATION_SRS.md](./archive/TS_MIGRATION_SRS.md) — 프론트엔드 TypeScript 마이그레이션 | 2026-05 |
| [TODO.md](./archive/TODO.md) — 2026-04~05 작업 로그 (완료 49건) | 2026-05 |
| [NEXT_SESSION_PROMPTS.md](./archive/NEXT_SESSION_PROMPTS.md) — 당시 세션 프롬프트 | 2026-05 |

### 안정성 · 동시성

| 문서 | 시점 |
|------|------|
| [SAFETY_WARMUP_SRS.md](./archive/SAFETY_WARMUP_SRS.md) — L1/L4/L8 | 2026-05 |
| [CONCURRENCY_HARDENING_SRS.md](./archive/CONCURRENCY_HARDENING_SRS.md) — L3/L5/L7 | 2026-05 |
| [OUTBUF_BACKPRESSURE_SRS.md](./archive/OUTBUF_BACKPRESSURE_SRS.md) — PTY 출력 백프레셔 | 2026-05 |
| [HOT_RELOAD_SRS.md](./archive/HOT_RELOAD_SRS.md) — 무중단 재기동 | 2026-05 |
| [MDSCROLL_LEAK_FIX_SRS.md](./archive/MDSCROLL_LEAK_FIX_SRS.md) — 스크롤 리스너 누수 | 2026-05 |

### 레이아웃 · 포커스

| 문서 | 시점 |
|------|------|
| [SPLIT_SERIALIZATION_SRS.md](./archive/SPLIT_SERIALIZATION_SRS.md) — 분할 직렬화 | 2026-05 |
| [SHORTCUT_DISPATCH_SRS.md](./archive/SHORTCUT_DISPATCH_SRS.md) — 단축키 디스패치 | 2026-05 |
| [PANE_SCROLL_PRESERVE_SRS.md](./archive/PANE_SCROLL_PRESERVE_SRS.md) — 창 전환 시 스크롤 보존 | 2026-05 |
| [SPLIT_KEEPFOCUS_FIX_SRS.md](./archive/SPLIT_KEEPFOCUS_FIX_SRS.md) — keepFocus 시맨틱 정정 | 2026-06 |
| [THEMES_EXPANSION_SRS.md](./archive/THEMES_EXPANSION_SRS.md) — 테마 라이브러리 확장 | 2026-05 |

### 편집기 · 마크다운 (현재는 내장 Monaco 편집기로 대체됨)

`8dc0a3f`("feat: editor 임베드")에서 markdown 뷰어와 code-server 통합이 제거됐다.
아래 문서들의 대상은 더 이상 존재하지 않는다.

| 문서 | 시점 |
|------|------|
| [MULTI_TAB_TYPE_SPEC.md](./archive/MULTI_TAB_TYPE_SPEC.md) — 다중 탭 타입 인프라 + Markdown 뷰어 | 2026-04 |
| [MD_FOCUS_NEW_PANE_CWD_SRS.md](./archive/MD_FOCUS_NEW_PANE_CWD_SRS.md) — 파일 탭의 cwd 상속 (`editor` 로 이관돼 살아 있다) | 2026-05 |
| [MD_SCROLL_SYNC_SRS.md](./archive/MD_SCROLL_SYNC_SRS.md) — 마크다운 스크롤 동기화 | 2026-05 |
| [MD_VIEWER_REGRESSION_FIX_SRS.md](./archive/MD_VIEWER_REGRESSION_FIX_SRS.md) — 뷰어 도입 후 회귀 (포커스 불변식은 살아 있다) | 2026-05 |
| [CODESERVER_SHUTDOWN_SRS.md](./archive/CODESERVER_SHUTDOWN_SRS.md) — code-server graceful shutdown | 2026-05 |
| [CODESERVER_STABILITY_SRS.md](./archive/CODESERVER_STABILITY_SRS.md) — code-server 안정화 | 2026-05 |

### 모바일

| 문서 | 시점 |
|------|------|
| [MOBILE_MODE_RFC.md](./archive/MOBILE_MODE_RFC.md) — 모바일 모드 전반 | 2026-05 |
| [MOBILE_KEYBAR_ALWAYS_VISIBLE_SRS.md](./archive/MOBILE_KEYBAR_ALWAYS_VISIBLE_SRS.md) | 2026-05 |
| [MOBILE_KEYBAR_LAYOUT_ROBUSTNESS_SRS.md](./archive/MOBILE_KEYBAR_LAYOUT_ROBUSTNESS_SRS.md) | 2026-05 |
| [MOBILE_KEYBAR_TOOLTIPS_SRS.md](./archive/MOBILE_KEYBAR_TOOLTIPS_SRS.md) | 2026-05 |
| [MOBILE_VERIFICATION_AUTOMATION_SRS.md](./archive/MOBILE_VERIFICATION_AUTOMATION_SRS.md) — RFC §7.2 검증 자동화 | 2026-05 |

### 사용자 확인 피드백 (트랙 1)

| 문서 | 시점 |
|------|------|
| [USER_CHECKLIST_FIXES_SRS.md](./archive/USER_CHECKLIST_FIXES_SRS.md) — 8개 항목의 명세 (묶음 A~F) | 2026-08 |
| [USER_CHECKLIST_FIXES_PLAN.md](./archive/USER_CHECKLIST_FIXES_PLAN.md) — 묶음·순서 + 착수 전 결정 10건 | 2026-08 |

인계 문서(함정 15개)는 현행으로 남아 있다 — 위 표 참조.

### 식별자 · 원격 제어 · 에이전트 접합면

| 문서 | 시점 |
|------|------|
| [UUID_IDENTITY_SRS.md](./archive/UUID_IDENTITY_SRS.md) — UUID 기반 엔티티 정체성 | 2026-05 |
| [DMCTL_UUID_FINALIZE_SRS.md](./archive/DMCTL_UUID_FINALIZE_SRS.md) — dmctl UUID 전환 마무리 (location uuid-only 정책) | 2026-05 |
| [DMCTL_WHO_AM_I_SRS.md](./archive/DMCTL_WHO_AM_I_SRS.md) — `who-am-i` 추가 + 출력 라인 통일 (`internal/helper/toolline`) | 2026-06 |
| [LIST_PANES_NAME_FILTER_SRS.md](./archive/LIST_PANES_NAME_FILTER_SRS.md) — 이름 필터 (현 `list_workspace`) | 2026-06 |
| [REMOTE_SESSION_TAB_CREATE_SRS.md](./archive/REMOTE_SESSION_TAB_CREATE_SRS.md) — `newWindow`/`newTab` 의 keepFocus·name | 2026-06 |
| [RENAME_TAB_SESSION_SRS.md](./archive/RENAME_TAB_SESSION_SRS.md) — `renameTab`/`renameWindow` | 2026-06 |
| [REMOTE_COMMAND_RESULT_SRS.md](./archive/REMOTE_COMMAND_RESULT_SRS.md) — 생성 명령의 새 uuid 반환 (long-poll correlation) | 2026-06 |
| [DONGMINAL_WORKFLOW_SKILL_SRS.md](./archive/DONGMINAL_WORKFLOW_SKILL_SRS.md) — `dongminal-workflow` 스킬. 호출명·설치 경로는 SKILL_INJECTION_SRS 가 개정 | 2026-06 |

### 알림 · 활동

| 문서 | 시점 |
|------|------|
| [PANE_ATTENTION_NOTIFY_SRS.md](./archive/PANE_ATTENTION_NOTIFY_SRS.md) — 출력 감시 기반 주의 알림 (SSE `tool_attention`) | 2026-06 |
| [AGENT_ACTIVITY_PANEL_SRS.md](./archive/AGENT_ACTIVITY_PANEL_SRS.md) — 에이전트 활동 패널 (SSE `tool_activity`) | 2026-06 |

### 데몬 분리

| 문서 | 시점 |
|------|------|
| [DAEMON_SPLIT_SRS.md](./archive/DAEMON_SPLIT_SRS.md) — `dongminald` + `dongminal` 분리 | 2026-06 |
| [DAEMON_CWDPANE_RESOLVE_SRS.md](./archive/DAEMON_CWDPANE_RESOLVE_SRS.md) — 데몬 모드 cwd 해석 | 2026-06 |
| [DAEMON_PANE_BUSY_RESOLVE_SRS.md](./archive/DAEMON_PANE_BUSY_RESOLVE_SRS.md) — 데몬 모드 busy 해석 | 2026-06 |

## 남은 작업

| 항목 | 상태 |
|------|------|
| 요구 3 — AI 오케스트레이터 (`RUN_ORCHESTRATION_SRS`) | **완료.** 묶음 **S**(상태·대기 계약)·**R**(Run 레코드)·**P**(멤버 프리앰블)·**A**(어댑터 레지스트리)·**K**(스킬 재작성)·**W**(worktree 격리) 전부. FR-STA-4 준비완료 사다리 2단계(화면 패턴)는 스펙에 남기고 구현을 보류했다. **남은 별건**: 실제 격리 팀으로 한 바퀴 — 첫 격리 Run 은 새 worktree 경로가 신뢰 목록에 없어 폴더 신뢰 모달에 걸릴 수 있다 |
| 요구 4 — Git 창 (`GIT_SRS`) | **P0 전량 구현 완료.** 그 뒤 사용자 검토 4회를 반영했다 — 1~3차는 [GIT_UI_REVISION_SRS.md](./GIT_UI_REVISION_SRS.md)(FR-GIT-179~226), 4차 오류 3건은 [GIT_REVIEW4_SRS.md](./GIT_REVIEW4_SRS.md)(FR-RPT-1~8, FR-GIT-227~235). `go test ./...` 통과, Playwright 431. **남은 것은 4차 검토의 개선 7건·수동 실사·P1/P2 기능**이며 전부 [GIT_REMAINING.md](./GIT_REMAINING.md) 에 있다 |
| ~~`TC-BGU-9b` 기존 실패~~ | **해소** (트랙 4 0-A). 제품 결함이 아니라 테스트가 서버 관측을 클라이언트 단정의 배리어로 쓴 것이었다. 별개로 `location` 미지정 복귀의 조용한 무효는 실재했고 FR-BGR-7 로 닫았다 |
| ~~프론트엔드 id 가 UUID 가 아니다~~ | **해소** — 엔터티 id 는 `crypto.randomUUID()` 로 만든다. 생성 명령의 다중 실행도 함께 닫았다 ([WORKSPACE_IDENTITY_SRS.md](./WORKSPACE_IDENTITY_SRS.md)) |
| 워크스페이스 PUT 의 last-write-wins | 미해소. 사람 둘이 각자 브라우저에서 동시에 편집하면 한쪽이 유실된다. 오케스트레이터 경로는 FR-SXE-\* 가 덮는다 (WORKSPACE_IDENTITY_SRS §2.4·§5) |
| ~~사용자 인스턴스 v1 → v2 마이그레이션~~ | **완료** (2026-08-24 12:24). `~/.dongminal` 에 `.v1.bak` 3개, `panes.json`→`tools.json` 전환 확인 |
| `~/.dongminal/runs.json` | 커밋된 코드에 소비자가 없는 산출물. 실행 중 바이너리에 문자열조차 없다 — 출처 불명의 Run 레코드 프로토타입 |
| ~~`internal/shared/uuid`(Go v7) 가 죽은 패키지~~ | **해소** — 묶음 U 가 `toolId`·`reqId` 의 단일 생성기로 삼았다 (FR-UNI-6) |
| ~~`toolId` 가 서버 카운터~~ | **해소** — uuid. 카운터가 영속되지 않아 모든 도구가 닫힌 상태로 재기동하면 `"1"` 부터 재사용됐다 (WORKSPACE_IDENTITY_SRS §2.7) |
| ~~LAN 노출 시 엔터티 생성 실패~~ | **해소** — `crypto.randomUUID` 는 보안 컨텍스트 전용이라 `--expose` 접속에서 undefined 였고 폴백이 없었다. `newUUID()` 가 `getRandomValues` 로 폴백한다 (FR-UNI-3) |
| `~/.dongminal/panels.json` | v1 시절 도구 기록. 소비자 없음. 삭제 여부 미정 |
| `CLIENT_ATTACH_SRS` — Client↔Window attach 서버 등록, visibility 파생 | 미착수 (ENTITY_MODEL SRS §7 후속) |
| 사용자 대상 기능 TODO | 저장소 루트 [README.md](../../README.md) |

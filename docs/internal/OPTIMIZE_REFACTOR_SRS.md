# SRS: 통신 최소화·성능·리팩토링 — 프로덕션 승격 2차 감사 (IEEE 29148)

> **문서 상태**: 승인·구현중
> **남은 것**: O2~O14 (O1 완료, §8)

- 접수: 2026-09-25 · 기준 커밋 `67261463` (v1.1.7)
- 요청: 데몬-서버-클라이언트 통신 요소 최소화, 그 밖의 성능 개선, 하드코딩·중복·상수·복잡도·크기·추상화·가독성
  리팩토링, 문서와 구현의 괴리 정리. 목표는 프로덕션 수준.
- 근거: `docs/internal/optimize/FINDINGS.md` — 채택 **210건**. 모든 FR 이 이 등록부의 ID 를 가리킨다.
- 선행 감사: `production/00-INDEX.md`(173건) · `refactor/AUDIT-*.md`(214건, 묶음 B1~B6). 이 감사는 두 감사의
  **잔여 항목을 다시 확인해 포함**했고, 해결된 항목은 넣지 않았다. 이전 감사 ID 는 등록부의 "이전 감사" 줄에 있다.

---

## 1. 개요

### 1.1 목적

1차 감사(B1~B6)는 안전성·정확성과 **측정 가능한 렌더 성능**을 다뤘다. 이 문서는 그 뒤에 남은 두 가지를 다룬다.

1. **통신량.** 프로세스 셋(데몬 ② · 웹서버 ③ · 브라우저)이 주고받는 요청·프레임 수가 **정상 상태에서도**
   필요 이상으로 많다. 대부분 폴링이 남아 있거나, 푸시가 있는데 쓰지 않거나, 왕복을 버리는 경우다.
2. **구조 부채.** 중복 구현, 거대 함수, 흩어진 상수, 낡은 주석이 쌓여 있다.

### 1.2 범위

| 묶음 | 이름 | 건수 | P1 | 동작 변경 | 규모 |
|---|---|---|---|---|---|
| **O1** | 정확성 결함 우선 수정 | 23 | 4 | 18 | S 위주 |
| **O2** | 데몬↔서버 IPC 왕복 축소 | 18 | 2 | 2 | M |
| **O3** | PTY 출력 핫패스 | 8 | 1 | 2 | S/M |
| **O4** | 서버↔브라우저 폴링→푸시·요청 합치기 | 28 | 1 | 10 | M/L |
| **O5** | 쓰기 경로 합치기·원자성 | 12 | 3 | 4 | S/M |
| **O6** | LSP 동기화·세션 | 8 | 1 | 2 | S/M |
| **O7** | git 실행 수·실행 경로 단일화 | 15 | 0 | 4 | S |
| **O8** | 서버 내부 성능·SSE | 27 | 0 | 3 | S |
| **O9** | Go 구조 리팩토링 | 12 | 0 | 3 | M/L |
| **O10** | Go 상수 분리·하드코딩 제거 | 7 | 0 | 2 | S |
| **O11** | FE core 리팩토링 | 20 | 0 | 1 | M/L |
| **O12** | FE ui/git 리팩토링 | 16 | 0 | 1 | M/L |
| **O13** | CSS·디자인 토큰 | 3 | 0 | 1 | S/M |
| **O14** | 문서·주석 동기화, 죽은 코드 | 13 | 0 | 2 | S |

**미포함**: §6.

### 1.3 정의

| 용어 | 정의 |
|---|---|
| **왕복(RT)** | 요청 하나와 그 응답. IPC 에서는 `call()` 한 번, HTTP 에서는 요청 하나 |
| **정상 상태 트래픽** | 사용자가 아무것도 하지 않을 때 타이머가 내는 요청. 초당 요청 수로 센다 |
| **안전망 주기** | 푸시로 전환한 뒤에도 푸시 유실에 대비해 남기는 긴 주기 폴링 (기본 30 s) |
| **기능 협상** | 데몬은 서버 업그레이드를 넘어 오래 산다. 그래서 IPC 에 새 메서드를 더할 때 `ProtocolVersion` 을 올리지 않고 `hello` 의 `features` 로 알린다. 모르는 쪽은 옛 경로로 강등한다 |
| **자기 에코** | 브라우저가 PUT 한 결과가 SSE 방송으로 자기에게 되돌아오는 것 |

### 1.4 참조

`architecture.md` · `decisions.md` · `PERFORMANCE_BUDGET.md` · `PERFORMANCE_HARDENING_SRS.md` ·
`CONVENIENCE_SRS`(FR-TAN-8) · `POLL_INTERVAL_SETTINGS_SRS` · `GIT_VIEW_REFRESH_SRS`(FR-GVR-4·12) ·
`WINDOW_SLOTS_SRS`(FR-WSL-11, D-3) · `STATE_FILE_DURABILITY_SRS`(FR-SFD-1, NFR-SFD-1) · `EDITOR_LSP_SRS`(D-3) ·
`VERSION_HEALTH_SRS`(FR-VHL-3) · `EVENT_TIMER_HUB_SRS`(FR-HUB-3) · `WORKSPACE_SAVE_CONFLICT_SRS` · `RESTORE_FLIGHT_SRS`.

---

## 2. 현재 상태 (감사로 확인한 사실)

### 2.1 통신 지도

```
브라우저 ──WS (도구당 1, 바이너리 op)──▶ 웹서버 ──Unix socket, 줄 단위 JSON-RPC 1연결──▶ 데몬
        ──SSE (커맨드 1 + 칸당 ≤3 + git job)──                  데몬: 요청을 한 고루틴에서 직렬 dispatch
        ──HTTP 폴링──                                            push: output/fg/exit/size (base64 JSON)
```

### 2.2 정상 상태 트래픽 (기본값, 터미널 창 하나가 보일 때)

| 출처 | 주기 | 요청 | 근거 |
|---|---|---|---|
| 상태바 틱 | 3 s | ping · stats · git/jobs = 3 | IPC-9, FEC-15 |
| `/api/git/repos` | 3 s | 1 | IPC-7 |
| `/api/tools/activity` | 5 s | 1 (패널이 닫혀 있어도) | FEC-9, IPC-10 |
| **브라우저→서버 합계** | | **≈ 1.5 req/s (≈ 92 req/분)** | |
| 전경 폴 (서버→데몬) | 2 s | list RPC 1. 데몬 dispatch 안에서 `ps` 탐침을 동기로 실행 | IPC-1 |
| 활동 폴 (서버→데몬) | 5 s | working 도구당 busy RPC 1 (N+1) | IPC-10 |
| 키 입력 (서버→데몬) | 입력마다 | 동기 RPC 1. 응답은 버린다 | IPC-2 |

Editor 창이 보이면 트리마다 3 s 에 요청 3종이 더해진다(IPC-8). Repo 탭이 보이면 3 s 마다 핀 전부에
rev-parse 와 status 를 실행한다(IPC-7).

### 2.3 부팅·재연결 폭주

- 부팅하면 **모든 도구**(다른 창과 숨은 탭 포함)의 WS 를 연다. 도구마다 list 와 snapshot RPC 를 한 번씩
  부르고 최대 1 MB 의 tail 을 받는다. 탭이 20개면 WS 20개, RPC 40건, JSON 최대 약 27 MB 다 (IPC-5).
- SSE 가 열릴 때마다 복원 GET 7~8건이 따로 나간다. `/api/state` 는 두 번 받는다 (IPC-6, FEC-10, FEC-11).

### 2.4 여러 영역에서 같은 결함이 보고된 곳

독립 감사자 둘 이상이 같은 결함을 보고한 곳이다. 신뢰도가 가장 높다.

| 결함 | 보고 ID |
|---|---|
| 데몬 모드 전경 폴이 부수효과만을 위해 list RPC 를 부른다 | IPC-1 · SHR-5 · HTTP-1 |
| 직접 모드 WS 쓰기가 readPTY 를 막는다 | SHR-2 · IPC-15 |
| busy 조회 N+1 | HTTP-2 · HTTP-M1 · IPC-10 |
| 같은 저장소의 git status 를 여러 소비자가 따로 받는다 | FEU-5 · FEU-M1 · IPC-8 · FEC-12 |
| SSE 재연결 복원 요청이 흩어져 있다 | IPC-6 · FEC-10 · FEC-11 |
| LSP 요청이 파일 전문을 싣고, 서버가 같은 내용도 매번 didChange 한다 | DOM-1 · DOM-2 · FEC-14 |
| TermPane WS 배선이 두 벌이다 | FEU-14 · IPC-16 |
| `_execRemote` 190줄 if 사슬 | IPC-17 · FEC-23 |
| `/api/state` 가 blob 을 interface{} 로 왕복시킨다 | HTTP-8 · IPC-21 |
| 상태 파일 저장에 합치기가 없고 NFR-SFD-1 과 다르다 | SHR-6 · SHR-7 · DOM-3 · DOM-4 |

---

## 3. 요구사항

### 3.0 전 묶음 공통

- **FR-OPT-0-1** 각 묶음은 `CONTRIBUTING.md` §3-1 을 따른다. 테스트를 먼저 쓰고 RED 를 확인한 뒤 구현한다.
- **FR-OPT-0-2** 기존 SRS 가 정한 결정을 뒤집는 FR 은 **같은 변경에서 그 SRS 를 개정한다** (§3-2). 대상은 각 FR 의 "개정" 표시다.
- **FR-OPT-0-3** 공개 계약(HTTP 오류 방언, WS op, IPC 와이어 JSON)은 **바이트 단위 호환**을 유지한다.
  확장은 선택 인자와 선택 필드로만 한다. 옛 서버·옛 데몬과 섞여 돌아도 깨지지 않아야 한다.
- **FR-OPT-0-4** 통신량 FR 은 전후 요청 수를 **센다** (셀 수 있는 수, `PERFORMANCE_HARDENING_SRS` §1.3).
  e2e 요청 타임라인 또는 Go 계수 테스트로 고정한다.
- **FR-OPT-0-5** 한 묶음이 끝나면 `make gates`·`make test`·`make unit`·관련 e2e 를 통과시킨 뒤 커밋한다.
  커밋은 사용자 확인 후에만 한다.

### 3.1 O1 — 정확성 결함 (가장 먼저)

| FR | 요구 | 등록부 |
|---|---|---|
| FR-OPT-1-1 | 에이전트 기동줄의 `--model` 값을 셸 인용한다 (posix·pwsh). | SHR-1 |
| FR-OPT-1-2 | WS 중계가 출력 좌표의 구멍(`End-len(Data) > sent`)을 감지하면 연결을 닫아 클라이언트가 `since` 로 재동기하게 한다. 데몬에 재연결하면 살아 있는 id 와 대조해 사라진 도구의 exit 를 합성하고, 나머지 구독은 닫아 재동기시킨다. | IPC-4 · IPC-M1 |
| FR-OPT-1-3 | BranchDelete 는 oid 를 모두 모은 뒤 hint 를 기록한다. 원격 브랜치·태그 삭제는 잡을 등록한 뒤 hint 를 기록한다. | DOM-5 · DOM-6 |
| FR-OPT-1-4 | 닫힌 Run 의 멤버를 조회 대상에서 뺀다. 전임자 찾기는 한 함수로 모은다. | DOM-7 · DOM-8 |
| FR-OPT-1-5 | `GitRemoteList._load` 가 stale 응답에서 `_loading` 을 푼다. 목록 적재는 `gitLoadList` 규약으로 옮긴다. | FEU-1 · FEU-2 |
| FR-OPT-1-6 | `ui-notice` 판정 정규식의 `\b` 오탐을 고친다. 그 오탐을 굳힌 TC-CMP-10b 도 함께 고친다. | FEU-3 · FEU-M2 |
| FR-OPT-1-7 | 빈 dataDir 을 거부해 테스트가 소스 트리에 쓰지 않게 한다. 커밋된 `internal/shared/toolhub/tools.json*` 을 지운다. | SHR-11 |
| FR-OPT-1-8 | 에이전트 엔벨로프 포맷을 한 함수로 모으고 `to=` 에는 uuid 만 싣는다. | HTTP-11 |
| FR-OPT-1-9 | 응답 본문에 os 오류 원문(절대경로)을 싣지 않는다 (SEC-17 판정대로). attention 계열은 해석 실패와 필수 인자 누락을 다른 코드로 구분한다. | HTTP-16 · HTTP-17 |
| FR-OPT-1-10 | 본문 상한 게이트(FR-SAF-23)를 세운다. LSP 종단은 413 을 낸다. FR-SAF-22 가 가리키는 스크립트 이름을 바로잡는다. | HTTP-29 · HTTP-M3 |
| FR-OPT-1-11 | oid 길이를 40 으로 고정하지 않는다 (SHA-256 저장소). 플러그인 아카이브 다운로드에 크기 상한을 둔다. | DOM-M1 · DOM-34 |
| FR-OPT-1-12 | 나머지 소결함: fs 검색 UTF-8 절단(HTTP-18), 트리 들여쓰기 토큰 불일치(FEU-20), 기본 프리셋 버튼의 표시 동기화(FEC-8 · FEC-26). | HTTP-18 · FEU-20 · FEC-8 · FEC-26 |

### 3.2 O2 — 데몬↔서버 IPC 왕복 축소

| FR | 요구 | 등록부 | 기대 효과 |
|---|---|---|---|
| FR-OPT-2-1 | 데몬 모드에서는 **데몬이** 전경 갱신 티커를 돌리고 변화만 push 한다. 이 push 는 드롭하지 않는다. 서버의 `StartForegroundPoll` 은 직접 모드에서만 조회를 시킨다 — 데몬 모드에서는 데몬이 `hello.features` 에 `fgtick` 을 말하지 않았을 때(옛 데몬)만 종전의 list 폴로 강등한다. list 핸들러는 캐시만 읽는다. | IPC-1 · SHR-5 · HTTP-1 · IPC-M3 | list RPC 0.5/s → 0. dispatch 경로에서 `ps` 가 빠진다 |
| FR-OPT-2-2 | IPC 에 **응답 없는 알림**(`input`, `resize`)을 추가하고 기능 협상으로 켠다. WS 경로는 알림을 쓴다. HTTP send-input 은 오류를 돌려줘야 하므로 RPC 를 유지한다. | IPC-2 | 키 입력당 프레임 2 → 1. 응답 대기가 사라진다 |
| FR-OPT-2-3 | `create`·`restore` 를 읽기 루프 밖에서 처리한다 (연결당 세마포어). 클라이언트 Create 시한은 전용 상수(60 s)로 둔다. 순서 전제(ListOK 캐시·skill-contract e2e)는 세대 검사로 안전한지 먼저 테스트로 확인한다. | IPC-3 | 샌드박스 생성이 다른 도구의 입력을 막지 않는다 |
| FR-OPT-2-4 | busy 일괄 조회: 데몬에 `busymany(ids)` RPC, 서버에 `GET /api/tools/busy?ids=` 를 둔다. 스위퍼는 로컬 판정을 먼저 하고 busy 탐침은 마지막에 부른다. RPC 오류는 판정 보류(`ok=false`)이며 "바쁘지 않음" 으로 읽지 않는다. | HTTP-2 · HTTP-M1 · IPC-10 · IPC-M2 | N 왕복 → 1 |
| FR-OPT-2-5 | WS 연결 시 존재 확인용 Get 을 없애고 snapshot 의 `CodeNotFound` 로 판정한다. 데몬이 `snapnotfound` 를 말하지 않으면(옛 데몬) Get 경로로 강등한다. | IPC-23 | 연결당 RPC 2 → 1 |
| FR-OPT-2-6 | IPC 계약을 `toolipc` 의 메서드·이벤트 상수와 typed 구조체로 옮긴다. 수신은 한 번만 Decode 한다. 쓰기 뮤텍스를 분리하고, Marshal 오류는 호출자에게 돌려준다. 와이어 JSON 바이트는 바꾸지 않는다. | IPC-13 · IPC-14 · IPC-22 | 청크당 JSON 해석 3 → 1 |
| FR-OPT-2-7 | 데몬 모드 WS 중계는 채널에 쌓인 연속 출력을 64 KiB 안에서 한 프레임으로 합친다 (size·exit 앞에서 flush). WS 송신은 `NextWriter` 로 op 바이트와 payload 를 복사 없이 쓴다. | HTTP-6 · IPC-25 | 폭주 출력 때 프레임 수가 줄어든다 |
| FR-OPT-2-8 | Accept 의 도달 불가 갈래와 hello 의 미사용 필드(`tool_ids`·`server_pid`)를 지운다. exit 의 stderr 사유는 **D-OPT-6** 에 따라 되살리거나 폐기한다. | IPC-24 · IPC-18 | |

### 3.3 O3 — PTY 출력 핫패스

- **FR-OPT-3-1** 직접 모드 WS 송신을 연결별 제한 큐와 writer 고루틴으로 옮긴다. 큐가 넘치면 그 연결을 닫는다.
  느린 브라우저 하나가 PTY 읽기를 막지 않는다. (SHR-2 · IPC-15)
- **FR-OPT-3-2** readPTY 는 구독자가 0 이면 프레임을 만들지 않는다. 청크당 할당과 ESC 스캔을 한 번으로 줄인다. 읽기 버퍼를 키울지는 벤치로 정한다. (SHR-3 · SHR-4 · SHR-M1)
- **FR-OPT-3-3** outbuf 는 쓰지 않는 context 를 받지 않는다. 1 MB 를 미리 할당하지 않고, 넘칠 때 재할당하지 않는 링 구조를 쓴다. (SHR-25 · SHR-M2)
- **FR-OPT-3-4** `AttnTracker.FeedOutput` 은 청크당 락을 한 번만 잡는다. (HTTP-5)
- 검증: `-bench -benchmem` 전후 allocs/op 를 기록한다. 계수 테스트로 고정한다.

### 3.4 O4 — 서버↔브라우저 폴링→푸시·요청 합치기

| FR | 요구 | 등록부 | 개정 대상 |
|---|---|---|---|
| FR-OPT-4-1 | **GitStatusHub**(FE): 요청 root 별 single-flight 와 짧은 TTL 을 둔다. 탐색기·dirty-diff·패널 주기 소비자가 공유한다. 탐색기는 `git_changed` 를 구독하고, 주기 폴은 안전망으로 내린다. 스탬프 틱에서는 캐시로 git 색을 다시 칠해 "같은 틱" 요구를 지킨다. | FEU-5 · FEU-M1 · IPC-8 · FEC-12 · FEU-4 | FR-EDT-77 · FR-FSL-7 · FR-ELR-10 |
| FR-OPT-4-2 | `fs/stamp` 와 `file/stamps` 를 요청 하나(`POST /api/fs/stamps`)로 합친다. | IPC-8 | |
| FR-OPT-4-3 | `/api/git/repos`: Repo 탭이 보이면 핀을 GitWatcher 에 임대하고 `git_changed` 로 갱신한다. 주기는 안전망으로 내린다. 응답 서명이 같으면 다시 칠하지 않는다. | IPC-7 · FEC-13 | POLL_INTERVAL_SETTINGS (`gitReposInterval` 의미) |
| FR-OPT-4-4 | 상태바 틱: git jobs 를 `/api/stats` 에 합치고, 잡 시작·종료는 `git_jobs_changed` 로 push 한다. Git 패널이 없으면 조회하지 않는다. ping 은 분리 유지(FR-PRF-36~38). | IPC-9 · FEC-15 | FR-GIT-101a |
| FR-OPT-4-5 | **SSE 열림 스냅샷**: `GET /api/snapshot?parts=…` 하나로 복원 7종을 받는다. 첫 open 에서는 부팅 GET 과 겹치는 재검증을 건너뛴다. `_fgRestore` 는 워크스페이스 적용 경로에 흡수한다. | IPC-6 · FEC-10 · FEC-11 | RESTORE_FLIGHT (FR-RSF-3 경로 명시) |
| FR-OPT-4-6 | activity 폴은 패널이 열려 있거나 알림이 있을 때만 돈다. 빈 껍데기 함수는 지운다. | FEC-9 · IPC-29 | (FR-AAP-19 회복) |
| FR-OPT-4-7 | **조건부 응답**: `GET /api/git/status?ifMark=` 는 mark 가 같으면 `unchanged:true` 만 답한다. 파일 읽기의 304 회피는 유지한다. | HTTP-7 · IPC-30 | |
| FR-OPT-4-8 | 증분 조회: Console 기록은 `after=<seq>` 와 `lastSeq`·`gap`, History 는 `until=<oid>` 로 머리만 받는다. 머리가 이어지지 않으면 전량으로 돌아간다. | DOM-27 · FEU-10 | |
| FR-OPT-4-9 | Git 뷰: refs 는 회차당 한 번 받아 공유한다. 보이지 않는 뷰는 표식만 남기고 활성화할 때 받는다. | FEU-6 · FEU-7 | FR-GVR-4 |
| FR-OPT-4-10 | 소통신: `/api/cwd` 는 포커스가 바뀌었을 때만, OSC 값이 없을 때만 묻는다. 포커스 아닌 터미널의 OSC 는 상태바를 덮지 않는다. run 목록 재조회는 합친다. 판 확인은 인사를 받았으면 건너뛴다. | FEC-3 · FEC-M1 · FEU-8 · FEU-9 · FEU-M3 | |
| FR-OPT-4-11 | **터미널 지연 연결**: 처음 그려질 때 WS 를 연다. 숨은 도구는 붙이지 않는다. **D-OPT-2** 로 결정한다. | IPC-5 | handlers_ws 주석 |
| FR-OPT-4-12 | **칸 SSE 경량화**: `?presence=1` 구독은 소유권 수명에만 쓰고 방송을 싣지 않는다. **D-OPT-4** 로 결정한다. | IPC-11 · FEC-16 | FR-WSL-11 · D-3 |

**목표**: 터미널 창 하나일 때 정상 상태 트래픽을 ≈ 1.5 req/s 에서 **≤ 0.5 req/s** 로 줄인다 (ping 과 stats 만 남는다).
e2e 요청 타임라인으로 잰다.

### 3.5 O5 — 쓰기 경로 합치기·원자성

- **FR-OPT-5-1** 워크스페이스: 마지막으로 성공한 본문과 같으면 PUT 하지 않는다. 직렬화는 한 번만 한다. 서버도 raw 바이트가 같으면 rev 를 올리지 않고 방송하지 않는다. (FEC-1 · FEC-2)
- **FR-OPT-5-2** 설정 저장 파이프라인을 하나로 모은다: 디바운스(상수), 비행 합치기, 자기 에코 무시. 에코가 사용자 정의 테마 편집기의 객체 참조를 끊는 결함도 고친다. **D-OPT-7**. (FEC-4 · FEC-5 · FEC-6 · FEC-7 · FEC-M3)
- **FR-OPT-5-3** tools.json 저장을 합친다 (latest-wins). 내용이 같으면 세대를 회전하지 않는다. (SHR-6 · SHR-7)
- **FR-OPT-5-4** runs.json: `ContextAt` 만 바뀐 관측은 저장하지 않는다. Marshal 은 잠금 안에서, 쓰기는 잠금 밖에서 전용 mutex 로 직렬화한다. NFR-SFD-1 의 비용 서술을 실제에 맞게 고친다. **D-OPT-5**. (DOM-3 · DOM-4)
- **FR-OPT-5-5** 헬퍼·훅·셸 스크립트 설치물은 원자적으로 쓴다 (임시 파일 + rename, 내용이 같으면 건너뜀). (SHR-12)

### 3.6 O6 — LSP

- **FR-OPT-6-1** 서버는 내용 해시가 같으면 didChange 를 보내지 않는다. (DOM-1)
- **FR-OPT-6-2** 브라우저는 문서 판(version)이 서버가 마지막으로 받은 판과 같으면 텍스트를 싣지 않는다. 서버가 판 불일치를 답하면 전문으로 다시 보낸다. EDITOR_LSP D-3 을 개정한다. (DOM-2 · FEC-14)
- **FR-OPT-6-3** 같은 키에 언어 서버를 두 번 띄우지 않는다 (single-flight). 텍스트 상한은 세션을 띄우기 전에 검사한다. 요청 앞단은 한 벌로 모은다. (DOM-9 · DOM-10)
- **FR-OPT-6-4** `ext.Locate` 는 실행 파일을 찾으면 멈춘다. 경로 표 키를 일치시킨다. (DOM-11 · DOM-12 · DOM-13)

### 3.7 O7 — git 실행

- **FR-OPT-7-1** `Exec`·`ExecWrite`·`ExecUnguarded` 의 오류 분류·거부·마감을 한 함수로 모은다. 기동도 한 벌로 모으고 `LookPath` 결과를 캐시한다. `rev-parse --verify` 조회는 한 함수로 모은다. (DOM-14 · DOM-15 · DOM-18)
- **FR-OPT-7-2** worktree 와 submodule 의 runGit 쌍둥이를 하나로 모은다. isDirty 는 stdout 만 읽는다. (DOM-16 · DOM-17)
- **FR-OPT-7-3** 호출당 git 프로세스 수를 줄인다: PreflightOf 5 → ≤2, PushSpec·StashPush 는 전체 status 대신 필요한 값만 조회, 충돌 Resolve 는 일괄 처리, diff 는 `cat-file --batch` 사용, worktree.Resolve 는 rev-parse 를 한 번에. 전후 프로세스 수를 계수 테스트로 고정한다. (DOM-19~24)
- **FR-OPT-7-4** Store: pruneCache 는 LRU 로 부분 제거한다. RepoRoot 에 single-flight 를 둔다. fan-out 세마포어는 한 벌로 모은다. (DOM-26 · HTTP-27)
- **FR-OPT-7-5** 인자 가드와 이름 validate 핸들러를 한 벌로 모은다. (DOM-31 · HTTP-12)

### 3.8 O8 — 서버 내부 성능·SSE

- **FR-OPT-8-1** SSE 작성기를 하나로 모은다: 쓰기 시한, 쌓인 이벤트를 합쳐 한 번에 Flush, payload 빌더 한 벌. 큐 상한은 버스트 실측으로 정한다. (HTTP-10 · HTTP-M2 · IPC-12 · IPC-20 · HTTP-15)
- **FR-OPT-8-2** 요청 경로 캐시: access 매처 스냅샷(설정이 바뀔 때만 다시 만든다), settings 뷰 캐시, `wsentry.Roots` 캐시(workspace rev 로 무효화), 라우팅 인덱스(접두 맵). (HTTP-4 · HTTP-26 · DOM-25 · HTTP-25)
- **FR-OPT-8-3** fork 일괄화: BackgroundList 의 cwd 와 ActivitySnapshot 의 busy 를 한 번의 lsof·pgrep 으로 조회한다. `/api/runs/context` 는 비멤버를 빠른 경로로 처리한다. (SHR-8 · SHR-28 · HTTP-3)
- **FR-OPT-8-4** 서버 내부 폴링 대기(100 ms·250 ms·50 ms)를 조건 변수 또는 채널 대기로 바꾼다. (HTTP-31)
- **FR-OPT-8-5** 훅 보고 경로: dmctl 은 훅 한 번에 HTTP 한 번만 부르고, 전사본 꼬리를 스트리밍으로 읽는다. fire-and-forget 시한은 짧게 한다. list-workspace 의 이중 호출을 없앤다. (SHR-9 · SHR-10 · SHR-31)
- **FR-OPT-8-6** 소항목: `/api/state` 가 blob 을 RawMessage 로 넘긴다(HTTP-8 · IPC-21). 명령 payload 전문은 Info 가 아니라 Debug 로 남긴다(HTTP-28 · IPC-32). TimerHub 재스케줄을 O(n) 으로 줄인다(IPC-31). sysstat 은 부팅 시각을 한 번만 읽는다(DOM-33). tail 은 로그 끝에서 읽는다(SHR-32). Restore 는 락 밖에서 PTY 를 띄운다(SHR-27). claude 델타를 한 번만 디코드한다(SHR-29). 패키지 전역 wait 를 없앤다(HTTP-9). UTF-8 경계에서 자른다(IPC-27).

### 3.9 O9 — Go 구조 리팩토링

- **FR-OPT-9-1** agentadapter 세 프로토콜의 요청 id·대기표·턴 경계를 공통 타입으로 모은다. (SHR-13)
- **FR-OPT-9-2** dmctl 인자 파서와 결과→종료 코드 변환을 한 벌로 모은다. 셸 준비 대기를 한 함수로 모은다. (SHR-15 · SHR-16 · SHR-18)
- **FR-OPT-9-3** attention/activity 종단의 direct/daemon 이중 분기를 서비스 인터페이스 하나로 모은다. (HTTP-13)
- **FR-OPT-9-4** 성공 JSON 작성기를 하나로 모은다(방언별 오류 렌더러는 유지). (HTTP-14)
- **FR-OPT-9-5** 분할: composition root(HTTP-23), Run 표면을 하위 패키지로(HTTP-24), StartTool(SHR-26), jobs.finish(DOM-32), 커맨드 action 표를 단일 선언으로(IPC-19). 빈 훅 둘을 지운다(SHR-24).

### 3.10 O10 — Go 상수

- **FR-OPT-10-1** 활동 상태 어휘를 타입 상수 하나로 둔다 (Go 와 JS 한 벌씩, 게이트로 대조). (SHR-14)
- **FR-OPT-10-2** 홈 하위 파일·디렉터리 이름, 환경변수, ctl 시한·간격, 도메인 상한의 단일 출처를 정한다. (SHR-17 · SHR-19 · SHR-30 · HTTP-22 · DOM-30)
- **FR-OPT-10-3** 핸들러의 상태 코드 숫자 리터럴을 `http.Status*` 로 바꾸고, 쿼리 파싱 헬퍼를 둔다. (HTTP-21)

### 3.11 O11 — FE core

- **FR-OPT-11-1** 워크스페이스 정규화 파이프라인을 한 벌로 모은다. 활성 창 전환을 한 메서드로 모은다. 레이아웃 트리 순회를 한 헬퍼로 모은다. (FEC-17 · FEC-18 · FEC-21)
- **FR-OPT-11-2** 거대 메서드를 분할한다: addTab·save·init·closeTab, `_execRemote` 는 action 표로, initMobileKeybar 는 키 표로. (FEC-22 · FEC-23 · IPC-17 · FEC-34)
- **FR-OPT-11-3** 저장소 접근(`localStorage`·`sessionStorage`)을 키 상수와 PrefStore 한 벌로 모은다. 빈 `catch{}` 를 없앤다. index.html 선주입 키는 게이트로 대조한다. (FEC-19 · FEC-20 · FEU-18)
- **FR-OPT-11-4** 설정 기본값·범위는 `SETTINGS_SCHEMA` 만 원천으로 하고 검증기는 하나만 둔다. (FEC-25 · FEC-M2)
- **FR-OPT-11-5** 손으로 짠 모달 5벌을 `UIKit.modal` 로 옮긴다. 상태줄 관용구를 헬퍼로 모은다. (FEC-27 · FEC-28)
- **FR-OPT-11-6** helpers.js 를 주제별로 분할한다. App 필드를 접두 가족별 소유 클래스로 뺀다. (FEC-24 · FEC-35)
- **FR-OPT-11-7** 소항목: FEC-31 · FEC-32 · FEC-33 · FEC-36.

### 3.12 O12 — FE ui/git

- **FR-OPT-12-1** TermPane 의 WS 배선을 `TermSocket` 하나로 모은다. 백오프는 상수로 두고 지터를 더한다. 키 매핑·큐 상한을 상수로 옮긴다. (FEU-14 · IPC-16 · FEU-15)
- **FR-OPT-12-2** GitDialog 와 GitConfirm 의 모달 골격을 공통 기반으로 모은다. panel-views 렌더를 서술자 표로 바꾼다. (FEU-12 · FEU-13)
- **FR-OPT-12-3** 버튼 38곳을 `UIKit.button` 으로 옮기고, 아이콘 버튼에 type·aria-label 을 단다. (FEU-16)
- **FR-OPT-12-4** 분할: panel-diff(FEU-22), runs-panel(FEU-23), term-pane(FEU-25), renderer-pane(FEU-26), FileEditor._createEditor(FEU-27).
- **FR-OPT-12-5** API 경로 리터럴을 상수 표로 모으고 git GET 호출 방식을 하나로 통일한다. (FEU-32)
- **FR-OPT-12-6** 소항목: 보이지 않는 렌더 탭은 다시 그리기를 미룬다(FEU-11). FEU-17 · FEU-19 · FEU-21.

### 3.13 O13 — CSS

- **FR-OPT-13-1** transition 시간을 모션 토큰으로 바꾼다. git 뷰의 안내 띠·툴바·리사이즈 CSS 를 kit 규칙으로 모은다. Runs·사이드바 CSS 를 제자리 파일로 옮긴다(캐스케이드 순서를 보존한다). (FEU-28 · FEU-29 · FEU-24)

### 3.14 O14 — 문서·주석·죽은 코드

- **FR-OPT-14-1** 코드와 어긋난 문서를 고친다: architecture.md 의 HTTP·core·toolhub 서술(HTTP-30 · FEC-30 · SHR-22), backup·uninstall 도움말은 homeLayout 에서 생성한다(SHR-20), `DONGMINAL_SHELL` 플랫폼 표기(SHR-21).
- **FR-OPT-14-2** 엉뚱한 자리에 붙은 주석과 낡은 주석을 바로잡는다. 죽은 코드를 지운다. (SHR-23 · SHR-34 · HTTP-19 · HTTP-20 · IPC-28 · DOM-29)
- **FR-OPT-14-3** 인라인 영문 툴팁을 상수 표로 옮긴다(FR-TIP-4). 쓰이지 않는 i18n 키를 잡는 게이트를 세우고 탐침으로 확인한다. (FEC-29 · FEU-31)

---

## 4. 결정 (2026-09-25 사용자 승인 — 권장안 일괄 확정)

권장안을 먼저 적었다. 권장안과 다르게 정하면 해당 FR 을 개정한다.

| ID | 질문 | 권장안 | 영향 FR |
|---|---|---|---|
| **D-OPT-1** | IPC 확장 방식 | `hello.features` 로 기능을 협상하고 `ProtocolVersion` 은 올리지 않는다 (데몬은 PTY 를 잃지 않고 살아남는다) | 2-2 · 2-4 · 2-5 |
| **D-OPT-2** | 숨은 터미널의 지연 연결 | 채택한다. 단 숨은 도구의 OSC 부수효과(cwd·클립보드) 소비자를 먼저 조사하고, 필요한 것은 서버 경로로 옮긴다 | 4-11 |
| **D-OPT-3** | 폴링→푸시 전환에 따른 SRS 개정 | FR-EDT-77 · FR-GIT-101a · FR-GVR-4 · `gitReposInterval` 을 "안전망 주기(기본 30 s)" 로 개정한다 | 4-1 · 4-3 · 4-4 · 4-9 |
| **D-OPT-4** | 칸 SSE | 1단계로 `presence=1`(방송 없음)만 한다. 연결 수를 줄이는 다중 신원 SSE 는 비목표 | 4-12 |
| **D-OPT-5** | 상태 파일 지연 쓰기 | 이번에는 하지 않는다. 동일 내용 건너뛰기와 락 밖 쓰기만 한다 (FBE-17 · FR-SFD-1 유지) | 5-3 · 5-4 |
| **D-OPT-6** | exit stderr 사유 | 폐기한다. 필드와 주석을 지운다 | 2-8 |
| **D-OPT-7** | 설정 자기 에코 | 보낸 본문과 같거나 로컬 저장이 대기 중이면 적용하지 않는다 | 5-2 |

---

## 5. 검증

| 종류 | 방법 |
|---|---|
| 통신량 | e2e 요청 타임라인: 30 s 동안의 요청 수를 종단별로 센다. 목표는 §3.4 이며 전후 값을 이 문서 §8 에 기록한다 |
| IPC | toolclient·ipc 계수 테스트: 동작 하나당 RPC 수. 옛 데몬·새 서버, 새 데몬·옛 서버 교차 테스트 (hello features 미지원 강등) |
| 핫패스 | `-bench -benchmem` 전후 allocs/op 기록 |
| git | 호출당 자식 프로세스 수 계수 (`gittest` 픽스처) |
| 결함 | 결함마다 재현 테스트가 수정 전 RED, 수정 후 GREEN |
| 리팩토링 | 동작 보존: 기존 단위·e2e 가 무수정으로 통과한다. 테스트를 고치면 그 이유를 커밋에 적는다 |
| 게이트 | `make gates` · `make lint` · `make typecheck` · `make unit` · `make test` |

## 6. 비목표

- 오류 본문 방언 통일 (architecture.md: 파괴적 변경).
- IPC 바이너리 출력 프레임 (IPC-13 의 L 안). typed struct 단일 Decode 로 대부분의 이득을 얻는다.
- 다중 신원 SSE (칸 SSE 연결 수 축소). FR-WSL-11 을 크게 개정해야 한다.
- 상태 파일 지연 쓰기 (D-OPT-5).
- 도구 히스토리 회수 (SHR-33, TOOL_HISTORY_ISOLATION §6 이 제외했다) · 문자 아이콘 교체 잔여 (FEU-30, UI_KIT 사용자 결정).
- 번들러·타입스크립트 도입.

## 7. 리스크

| 리스크 | 등급 | 완화 |
|---|---|---|
| IPC 변경이 살아 있는 데몬과의 호환을 깬다 | HIGH | D-OPT-1 협상. 교차 판 테스트. 실사용 인스턴스는 건드리지 않고 `--isolated` 로 확인한다 |
| create 비동기화가 ListOK 캐시의 순서 전제를 깬다 | MEDIUM | 세대 검사 테스트를 먼저 쓰고, 통과하지 못하면 FR-OPT-2-3 을 보류한다 |
| 푸시 전환 뒤 push 유실 시 화면이 낡는다 | MEDIUM | 안전망 주기와 가시성 복귀 재검증을 남긴다 |
| 지연 연결이 숨은 터미널의 부수효과를 멈춘다 | MEDIUM | D-OPT-2 의 사전 조사 |
| 대규모 FE 분할이 로드 순서 의존을 깬다 | MEDIUM | index.html 로드 순서 게이트와 e2e 전량 |
| 개연(PLAUSIBLE) 9건이 실제로는 결함이 아니다 | LOW | 착수 전에 재확인하고, 아니면 등록부에 "제외" 로 옮긴다 |

## 8. 진행 순서와 기록

권장 순서: **O1 → O2 → O3 → O5 → O4 → O6 → O7 → O8 → O10 → O9 → O14 → O11 → O12 → O13**.
결함을 먼저 고치고, 통신·성능을 그다음에 한다. 리팩토링은 그 뒤에 한다. O10(상수)은 O9 분할 전에 해야
분할 뒤 다시 손대지 않는다.

| 묶음 | 상태 | 전 | 후 | 커밋 |
|---|---|---|---|---|
| O1 | 완료 | 결함 23건 | 23건 수정, 재현 테스트 RED→GREEN · gates · go test -race 전량 · unit 372 · e2e 관련 135 통과 | (커밋 대기) |
| O2~O14 | 대기 | | | |

**O1 구현 중 결정**: HTTP-17 은 본문 문구를 바꾸지 않고 `X-Error-Code` 만 갈랐다 (ERROR_CONTRACT FR-ERR-5 · FR-OPT-0-3).
본문 문구를 바꾸려던 초안은 되돌렸다. HTTP-16(os 오류 원문 제거)은 SEC-17 판정에 따른 보안 수정이라 본문이 바뀐다.

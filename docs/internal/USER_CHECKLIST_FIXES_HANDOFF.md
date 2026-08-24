# 인계: 사용자 확인 피드백 반영 (user_checklist.md)

- **스펙**: [USER_CHECKLIST_FIXES_SRS.md](./USER_CHECKLIST_FIXES_SRS.md) — 단일 진실 공급원
- **계획**: [USER_CHECKLIST_FIXES_PLAN.md](./USER_CHECKLIST_FIXES_PLAN.md) — 묶음·순서·열린 결정
- **입력**: `user_checklist.md` (리포 루트)

## 1. 현재 상태

| 묶음 | 내용 | 상태 | 커밋 |
|---|---|---|---|
| — | 계획 + SRS | 완료 | `9c3b87c` |
| **A** | 백그라운드 UI 일관화 | **완료** | `eec0ddd` |
| **B** | 마이그레이션 진입점 | **완료** | `e6463e1` |
| **C** | 모바일 키바 터치 | **완료** | `18c7f14` |
| **D** | 복귀 대상 Pane 지정 | **완료** | `a906418` |
| **E** | 크로스 기기 창 포커스 | **완료** | `854ada6` |
| **F** | 모바일 키보드 뷰포트 | **미착수** — 스펙 골격만 | — |

검증 상태 (A~E 완료 시점 실측):

```
go build ./...        깨끗
go vet ./...          경고 0
gofmt -l internal/ cmd/   0건
go test ./...         전량 통과
npx playwright test   153 통과 (chromium 143 + mobile-touch 10)
bash scripts/test_migrate.sh   28 통과
```

묶음 E 의 신규 스펙(`e2e/focus-owner.spec.ts` 11개)은 3회 반복 실행 전부 통과했다.

**단, `npx playwright test` 전량 통과는 결정론적이지 않다** — 스위트 레벨 산발 실패가
있다. §6 을 읽어라.

## 2. 완료 내역

### 묶음 A — 백그라운드 UI (`eec0ddd`)

| 요구 | 결과 |
|---|---|
| FR-BGU-1 | 확인창 형태 규약을 `.confirm-btns button` 단일 규칙으로. 버튼별 규칙은 색만 |
| FR-BGU-2..5 | 진입점을 상태바 **우측 끝** 정적 버튼(`#sb-bg-btn`)으로. 지표는 `#sb-items` 로 분리 |
| FR-BGU-6..9 | 앵커 팝오버 → 중앙 모달(`#bg-modal`), 배경 클릭 + `Esc` |

핵심 구조 변경: 지표(`#sb-items`, 폴링마다 재생성)와 진입점(`#sb-bg-btn`, 정적)의
수명을 분리했다. 리스너는 `_initStatusBar` 에서 1회 부착한다.

`e2e/background-ui.spec.ts` 11개. `.bg-row` 에 `data-toolid` 가 있다 (D 에서 추가).

### 묶음 B — 마이그레이션 진입점 (`e6463e1`)

`scripts/migrate.sh` 가 사용자 진입점이다. `dongminal` 은 PATH 에 없다 —
`runtimebin` 이 설치하는 helper 는 `dmctl`·`edit`·`download`·`detach` 4개뿐이다.

스크립트가 지키는 세 가지(전부 구현 중 실제로 밟은 함정에서 나왔다 — SRS §2.5a):

1. **매 실행 빌드** (FR-MIG-3) — 낡은 바이너리는 `migrate` 를 모르고 웹 서버로 부팅한다
2. **`PORT` 응답 시 거부** (FR-MIG-6) — `--dry-run` 은 읽기 전용이라 허용
3. **호출자 환경변수 우선** (FR-MIG-7) — `.env` 는 기본값으로만

`scripts/test_migrate.sh` 28개. **운영 자산 불가침이 테스트의 전제다** (§4 함정 3).

### 묶음 C — 모바일 키바 터치 (`18c7f14`)

`touchstart` 의 `preventDefault()` 가 합성 마우스 이벤트를 취소해, 키 전송이 달린
`click` 이 오지 않았다 — **실기기에서 버튼이 전혀 동작하지 않았다.** 같은 호출이
스크롤도 취소해 슬라이드도 불가했다.

| 요구 | 결과 |
|---|---|
| FR-MTB-1/2 | 키 전송을 `touchend`(짧은 탭)로. `click` 은 마우스 폴백. 중복은 시간 기준으로 차단 |
| FR-MTB-3 | `touchstart`/`touchmove` 를 `passive:true` 로 되돌려 스크롤 복구 |
| FR-MTB-5 | 롱프레스 취소를 이동 거리 임계값(`MKB_TAP_SLOP_PX=10`)으로 |
| FR-MTB-7 | Playwright 프로젝트 분리 |

제스처 상수 4개는 `web/js/constants.js` 에 있다 (`MKB_*`).

**Playwright 프로젝트 2개** — 이 분리가 없으면 같은 회귀가 재발한다:

| 프로젝트 | 디바이스 | 대상 |
|---|---|---|
| `chromium` | Desktop Chrome (`hasTouch:false`) | `-touch.spec.ts` 를 **제외한** 전부 |
| `mobile-touch` | Pixel 7 (`hasTouch:true`) | `-touch.spec.ts` **만** |

### 묶음 D — 복귀 대상 지정 (`a906418`)

`detach --restore <id> --at <uuid>`. **`internal/server` 는 한 줄도 바꾸지 않았다** —
`translateLocationUUID` 가 이미 action 무관하게 `args.location` 을 변환한다.

- `detach.go` 파서를 플래그 일괄 수집으로 (—`--at` 이 `--restore` 앞에 와도 동작)
- `_restoreTool(toolId, opts={})` — 기본값으로 기존 호출부 무변경
- `location` 해석은 `newTab`·`splitH` 와 동일: 값은 탭 uuid, 복귀는 Pane 단위이므로 T 성분 무시
- FR-BGR-5: 대상 확정을 백그라운드 해제보다 **앞에** 둔다

`ENTITY_MODEL_RESTRUCTURE_SRS` 의 FR-BG-7·TC-BG-7 을 개정했다.

### 묶음 E — 크로스 기기 창 포커스 (`854ada6`)

`BroadcastChannel('dongminal-focus')` 을 **서버 권위**로 옮겼다. 채널은 동일 브라우저·
동일 origin 한정이라 다른 기기와 원리적으로 통신할 수 없었고, `--expose` 시
`localhost:PORT` 와 `<host-ip>:PORT` 는 origin 이 달라 같은 컴퓨터의 두 탭도 격리됐다.

| 요구 | 결과 |
|---|---|
| FR-XDF-1 | `FocusRegistry`(`internal/server/focus.go`) — in-memory. 영속화하지 않는다 |
| FR-XDF-2/3 | last-focus-wins 유지. 한 Client 는 한 Window |
| FR-XDF-5/6 | `POST /api/focus/claim` → SSE `window_focus`. 페이로드는 **소유권 전체 맵** |
| FR-XDF-8/9/10 | `/api/commands/sse?clientId=` 결선. 구독 해제 시 즉시 해제. epoch 로 재연결 경합 차단 |
| FR-XDF-11/12/13 | `_focusRestore` — 스냅샷 정렬 + OS 포커스 시 재획득 |

**이 작업의 실체는 동기화 결손 수정이 아니다.** 지금까지 원격 기기의
`_windowFocusOwner` 에는 자기 자신만 있어 `_resizeCheck` 가 항상 `true` 였다 —
**모든 기기가 각자 PTY 를 리사이즈하고 마지막 것이 이겼다.** 묶음 E 는 여태 발현되지
않았던 리사이즈 권한 게이팅을 **처음으로 켜는** 작업이다. 그래서 획득 정책이 곧 PTY
크기 정책이고, 사용자 확인을 받아 last-focus-wins 를 유지했다 (PLAN E-7).

전체 맵 브로드캐스트를 택한 이유: 멱등이라 자기 에코 필터(`clientId` 비교)가
불필요하고, 부분 상태·순서 의존이 생기지 않는다. 증분 이벤트 2종보다 단순하다.

**즉시 해제와 재획득은 한 쌍이다.** 서버가 구독 해제 시 즉시 해제하는데 재획득이
없으면, Client 는 자신이 아직 소유자라고 기억하므로 `_focusWindow` 의 "소유권이 실제로
바뀔 때만 전파" 조건에 걸려 **영구히 재획득하지 못한다.** 둘 중 하나만 넣으면 안 된다.

`docs/external/api.md` 에 `/api/focus`·`/api/focus/claim`·`window_focus`·`?clientId=`
를 기록했다. `ENTITY_MODEL_RESTRUCTURE_SRS` 의 비목표 "다중 창 포커스 소유권 부채
정리" 를 부분 해소로 갱신하고, `README.md` TODO 의 현행 동작 서술을 정정했다.

## 3. 남은 작업

### 묶음 F — 모바일 키보드 뷰포트

**근본 원인** (SRS §2.8): iOS Safari 는 키보드 표출 시 layout viewport 를 줄이지
않고 visual viewport 를 스크롤한다. `body.style.paddingBottom`(`app.js:1956`)으로는
상쇄할 수 없고 `overflow:hidden` 으로 막을 수도 없다. `#area` 가 실제로 줄지 않아
`doFit()`(`app.js:1962`)도 무효가 된다.

**리스크 HIGH** — 레이아웃 높이의 단일 진실 공급원(`html,body{height:100%}`,
`style.css:14`)을 교체한다. 데스크톱 경로까지 영향한다.

**검증 제약**: iOS 실기기 수동 확인이 필수다. Chromium 터치 에뮬레이션으로
iOS 의 layout viewport 고정 거동을 재현할 수 없다. `test-checklist.md` C11 에
수동 항목을 이미 넣어뒀다.

기존 `e2e/mobile-keybar.spec.ts` 의 `TC-A1`~`TC-A4` 는 `--m-kb-h` 와
`body.paddingBottom` **수치만** 검증하므로, 높이 체계를 바꾸면 동반 개정 대상이다.

**착수 전 결정 5건** — PLAN §6.2.

## 4. 반복하면 안 되는 함정

전부 이 작업들에서 **실제로 밟은** 것들이다. 1~9 는 묶음 A~D, 10~12 는 묶음 E 에서 나왔다.

### 1. `.env` 가 호출자 환경변수를 덮어쓴다

`_load_env`(`scripts/*.sh`)는 값을 무조건 `export` 한다. `.env` 에
`DONGMINAL_HOME=~/.dongminal` 이 있으므로, 격리 홈을 지정해도 운영 홈으로
대체된다. `start.sh`·`stop.sh` 는 `.env` 를 기본값으로 쓰는 것이 의도라 무해하지만,
**파괴적 동작에서는 지정한 대상이 무시되는 것 자체가 결함**이다.
새 스크립트를 만들 때는 `migrate.sh` 의 `_CALLER_*` 패턴을 따라라.

### 2. 낡은 `./dongminal` 은 인자를 무시하고 웹 서버로 부팅한다

`migrate` 서브커맨드가 없던 시절의 바이너리에 `migrate` 를 주면 서버가 뜬다.
실측 결과: 데몬 대기 100초 → direct mode 폴백 → **운영 홈의 PTY 16개 되살림** →
포트 충돌로 rc=1. `migrate.Apply` 의 데몬 검사는 이 경로에 도달조차 못 한다.
**바이너리를 재사용하지 말고 항상 빌드하라.**

### 3. 루트 `./dongminal` 은 실행 중인 서버의 실행 파일이다

`ps` 로 확인하면 `./dongminal` 이 17일째 돌고 있다. 테스트가 이걸 삭제·재빌드하면
운영 인스턴스의 바이너리를 바꾼다. **테스트는 격리 산출물을 써라** —
`BINARY=.test-dongminal/...`. `scripts/test_migrate.sh` 의 `TC-MIG-10` 이 루트
바이너리의 권한·크기·해시 무변경을 대조한다.

### 4. 캐시 버스터가 두 종류다

`web/index.html` 에 `style.css?v=N` 과 `js/*.js?v=M` 이 **따로** 있다. 묶음 A 에서
`app.js` 를 바꿨는데 js 쪽을 올리지 않았다. CSS·JS 중 하나만 고쳤다고 방심하지 마라.

### 5. 탭 1개 Pane 에서 detach 하면 Pane 이 제거된다

그러면 남은 Pane 이 자동으로 포커스를 받아, **`location` 을 무시하는 구현도 통과**
한다. 대상 지정을 검증하려면 포커스 Pane 에 탭을 2개 두어 detach 후에도 Pane 이
살아 있게 하고, 대상 Pane 은 포커스 밖에 유지하라 (`e2e/background-restore-at.spec.ts`
의 `twoPanes`).

### 6. 순서 의존 선택자는 앞선 스펙의 잔여물에 오염된다

`.bg-row` **first()** 를 클릭하던 `TC-BGU-9b` 가 전체 스위트에서 2/3 실패했다.
앞선 스펙이 남긴 백그라운드 도구가 목록에 있으면 엉뚱한 행을 누른다.
`fixtures.ts` 가 매 테스트 전 미참조 도구를 회수하지만 완전하지 않다.
**식별자로 지목하라** (`.bg-row[data-toolid="..."]`).

### 7. `hasTouch:false` 에서는 `touchstart` 리스너가 발동하지 않는다

Desktop Chrome 프로젝트에서 `.click()` 을 쓰면 터치 코드 경로를 전혀 타지 않는다.
`mobile-keybar.spec.ts` 가 이 때문에 실기기 무동작을 한 번도 보지 못했다.
**터치 동작은 `mobile-touch` 프로젝트(`-touch.spec.ts`)에서 검증하라.**

### 8. `sendToFocused` 의 Ctrl 변환 범위는 `0x40~0x7e` 다

`/`(0x2f)·`-`(0x2d)는 범위 밖이라 원문이 나가는 것이 **정상**이다. 제어문자 변환을
검증하려면 `~`(0x7e)·`|`(0x7c)를 써라.

### 9. `detach` 의 `-l` 은 `--list` 다

`dmctl` 은 `-l` 을 `--at` 의 단축으로 쓰지만(`dmctl.go:213`), `detach` 에서는
`--list` 다. 두 CLI 의 단축이 다르다는 것을 전제하라.

### 10. `_resizeCheck` 는 **toolId** 를 받는다 — pane id 를 넘기면 조용히 통과한다

`app.focused` 는 **pane id** 이고 `_resizeCheck(toolId)` 는 **tool id** 를 받는다.
pane id 를 넘기면 `_toolWindowId` 가 null 을 돌려주고 `_resizeCheck` 는
`return true // pane not in any window yet → allow` 로 빠진다. TC-XDF-10 이 이 때문에
"리사이즈가 허용됐다"고 실패했는데, 원인은 구현이 아니라 **테스트가 엉뚱한 식별자를
넘긴 것**이었다. 도구를 지목할 때는 DOM 에서 꺼내라 —
`document.querySelector('#area .pn-tab[data-toolid]').dataset.toolid`.

거짓 통과 쪽이 더 위험하다: 소유권 게이팅이 깨져도 `true` 가 나와 테스트는 초록이 된다.
**판정이 참일 때와 거짓일 때를 둘 다 단정하라** — TC-XDF-10 은 소유권을 해제한 뒤 같은
toolId 가 `true` 로 돌아오는 것까지 확인해, `false` 의 원인이 소유권임을 못박는다.

### 11. init-time claim 이 e2e 의 "늦은 참여자" 테스트를 오염시킨다

`app.js` init 의 소유권 획득은 `document.hasFocus()` 만 본다. Playwright 는 여러
컨텍스트가 동시에 포커스를 참으로 보고할 수 있어, 늦게 접속한 클라이언트가 **접속만으로
소유권을 빼앗는다.** 그러면 스냅샷 복원(FR-XDF-11)을 검증하려던 테스트가 실제로는
획득 경로를 보게 된다.

`addInitScript` 로 `document.hasFocus` 를 스텁해 비포커스 클라이언트를 만들어라
(`e2e/focus-owner.spec.ts` 의 `newClient(browser, {osFocused:false})`).

같은 이유로, 소유권 주장은 클릭 대신 `setFocus` 직접 호출로 트리거하는 것이 결정론적이다.
검증 대상은 클릭 결선이 아니라 전파이므로 **트리거만 API 로 하고 효과는 DOM
(`pn-dimmed`)으로 확인하라.**

### 12. Serena 는 이 프로젝트에서 `web/js/` 를 편집할 수 없다

활성 언어서버가 `go` 뿐이고 `web/js/app.js` 는 무시 경로다 —
`find_symbol` 이 `ValueError: Explicitly requested symbols in 'web/js/app.js' while the
path is ignored` 로 거부한다. JS 심볼 편집은 폴백(정밀 텍스트 편집)으로 가야 한다.
Go 쪽은 정상 동작한다.

## 5. 검증 방법

```bash
# Go
go build ./... && go vet ./... && gofmt -l internal/ cmd/
go test ./... -count=1

# e2e (두 프로젝트 전부)
npx playwright test
npx playwright test --project=mobile-touch      # 터치 경로만
npx playwright test --project=chromium          # 마우스 경로만

# 마이그레이션 스크립트 (운영 자산 불가침 검증 포함)
bash scripts/test_migrate.sh
```

**RED 확인법**: 구현을 먼저 했다면 해당 파일만 되돌려 실패를 확인하라.

```bash
git stash push web/js/app.js
npx playwright test --project=chromium e2e/<spec>.spec.ts   # 실패해야 한다
git stash pop
```

이 방법으로 묶음 D 의 첫 테스트가 **결함을 못 잡는다**는 것을 발견했다 (§4 함정 5).

## 6. 미해결

### `internal/server` 의 1회성 실패

전체 `go test` 1회 실행에서 `internal/server` 가 실패했으나 **3회 재실행 모두
통과**해 재현되지 않았다. 출력에 PTY 정리 로그(`[tool N] killing pid=`)만 있어
케이스를 특정하지 못했다. 원인 미확정으로 남긴다. 다시 보이면 `-run` 으로 좁혀 기록하라.

**묶음 E 에서는 재발하지 않았다.** `internal/server` 를 실제로 수정한 작업인데
(`focus.go` 신설, `handleCommandSSE` 변경) `go test ./...` 첫 실행부터 전량 통과했다.
따라서 그 1회성 실패가 `runtimebin` 변경과 무관하다는 추정은 유지되고, 여전히 미확정이다.

### e2e 스위트 레벨 산발 실패 (약 4~5회 중 1회)

전량 `npx playwright test` 가 간헐적으로 1건 실패한다. 이번 세션에 실측한 것:

| 트리 | 전체 실행 | 산발 실패 |
|---|---|---|
| 묶음 E 적용 | 8회 | 2회 (한 번은 `TC-BGU-9b`, 한 번은 미특정) |
| 묶음 E stash (깨끗) | 3회 | 1회 (미특정) |

**묶음 E 에 귀속되지 않는다.** 깨끗한 트리에서도 같은 비율로 난다. 단독 실행
(`npx playwright test --project=chromium e2e/background-ui.spec.ts`)은 변경 전후 각
5회씩, 총 13회 전부 통과했으므로 **스위트 순서·부하 의존**이다.

`--repeat-each` 로는 조사할 수 없다 — 테마 상태가 반복 간 남아 `TC-BGU-4`(진입점 색이
테마 팔레트를 따른다)가 거짓 실패하며, 그게 조사 대상을 가린다.

확인된 후보는 `TC-BGU-9b`(`e2e/background-ui.spec.ts:271`)다. 함정 6 에서 선택자를
`data-toolid` 로 고쳤는데도 남았으므로 **선택자 오염이 아닌 다른 원인**이다. 구조상
의심되는 곳: 서버의 백그라운드 목록이 비는 것과 로컬 탭이 늘어나는 것이 서로 다른
이벤트인데, 테스트는 **서버 쪽을 폴링한 뒤 로컬 상태를 읽는다**(`:295`→`:300`).
그 사이 `_onWorkspaceChanged` 가 `/api/state` 로 `this.ws` 를 갈아치우면 방금 늘어난
탭이 일시적으로 사라질 수 있다.

**다음에 보이면 이렇게 좁혀라**: 실패한 실행의 `test-results/<슬러그>/error-context.md`
를 즉시 읽어라 (다음 실행이 덮어쓴다 — 이번에 그래서 잃었다). `tabsAfter` 를 단정 대신
`expect.poll` 로 바꿔 통과하면 원인은 경합이다.

**문서의 "142 통과"·"153 통과" 는 단일 실행 실측치이고 보장이 아니다.**

### 범위 밖으로 기록만 한 것

- `restoreTool` 의 `reqId` echo 미지원 — `creatingActions`
  (`internal/server/commands.go:58`)에 없어 CLI 가 생성된 탭 uuid 를 받지 못한다.
  실제 결손이지만 요구 범위 밖이다 (SRS §5-3)
- `.confirm-ok` 의 배경이 리터럴 `rgba(247,118,142,.15)` — 기존 코드
- README TODO "focused browser 자동 동기화" — 묶음 E 와 뿌리는 같으나 별건

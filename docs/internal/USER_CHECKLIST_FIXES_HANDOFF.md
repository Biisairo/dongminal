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
| **E** | 크로스 기기 창 포커스 | **미착수** — 스펙 골격만 | — |
| **F** | 모바일 키보드 뷰포트 | **미착수** — 스펙 골격만 | — |

검증 상태 (A~D 완료 시점 실측):

```
go build ./...        깨끗
go vet ./...          경고 0
gofmt -l internal/ cmd/   0건
go test ./...         전량 통과
npx playwright test   142 통과 (chromium 132 + mobile-touch 10)
bash scripts/test_migrate.sh   28 통과 (3.7초)
```

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

## 3. 남은 작업

### 묶음 E — 크로스 기기 창 포커스

**근본 원인** (SRS §2.7): `BroadcastChannel('dongminal-focus')`(`app.js:1642`)은
동일 브라우저·동일 origin 한정이다. 다른 기기와 통신 불가이고, `--expose` 시
`localhost:PORT` 와 `<host-ip>:PORT` 는 origin 이 달라 같은 컴퓨터에서도 격리된다.

**리스크 HIGH** — 같은 상태를 `_resizeCheck`(`app.js:1699`)가 PTY 리사이즈 권한
판정에 쓴다. 소유권 오판은 터미널 크기 깨짐으로 직결된다.

착수 지점:
- 재사용할 인프라: `CommandHub.Broadcast`(`internal/server/commands.go:155`),
  `GET /api/commands/sse`, `_subscribeCommands`(`app.js:180`), `clientId`(`app.js:8`)
- 늦은 참여 복원은 `_attnRestore`·`_activityRestore` 와 같은 스냅샷 패턴
- 해제는 SSE 구독 해제 기준. `beforeunload`(`app.js:1660`)는 원격 기기 강제 종료·
  네트워크 단절에서 발화하지 않는다
- 회귀 주의: `e2e/focus.spec.ts`, `focus-invariant.spec.ts`, `regression-focus.spec.ts`

**착수 전 결정 5건** — PLAN §6.1 (각각 권장안 있음).

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

이번 세션에서 **실제로 밟은** 것들이다.

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
케이스를 특정하지 못했다. 이번 작업은 `runtimebin` 만 건드렸으므로 무관해
보이지만 원인 미확정으로 남긴다. 다시 보이면 `-run` 으로 좁혀 기록하라.

### 사용자 인스턴스가 여전히 v1 이다

`~/.dongminal/workspace.json` 은 `sessions` 키를 가진 v1 이고 `schemaVersion` 이
없다. 구 바이너리(8월 7일 빌드)가 17일째 돌고 있어 정상 동작한다. **최신 소스로
재시작하면 스키마 게이트에서 멈춘다.**

업그레이드 순서는 이제 이것이다 (`ENTITY_MODEL_HANDOFF.md` §4.2 도 갱신했다):

```bash
./scripts/stop.sh --all
./scripts/migrate.sh --dry-run
./scripts/migrate.sh
./scripts/start.sh
```

**직접 마이그레이션하거나 재기동하지 마라.** 사용자 판단이다.

### 범위 밖으로 기록만 한 것

- `restoreTool` 의 `reqId` echo 미지원 — `creatingActions`
  (`internal/server/commands.go:58`)에 없어 CLI 가 생성된 탭 uuid 를 받지 못한다.
  실제 결손이지만 요구 범위 밖이다 (SRS §5-3)
- `.confirm-ok` 의 배경이 리터럴 `rgba(247,118,142,.15)` — 기존 코드
- README TODO "focused browser 자동 동기화" — 묶음 E 와 뿌리는 같으나 별건

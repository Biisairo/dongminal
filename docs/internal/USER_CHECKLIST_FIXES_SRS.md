# SRS: 사용자 확인 피드백 반영 — 백그라운드 UI · 모바일 입력 · 마이그레이션 진입점 — IEEE 29148

## 1. 개요 (Introduction)

### 1.1 목적 (Purpose)

실사용 확인에서 관측된 8개 항목(`user_checklist.md`)의 근본 원인을 제거한다. 항목들은
표면상 무관하지만 세 축으로 수렴한다 — **나중에 덧붙인 UI 표면이 기존 UI 규약을 따르지
않은 것**(묶음 A), **브라우저 이벤트/뷰포트 규격을 실기기 기준으로 검증하지 않은 것**
(묶음 C·F), **단일 기기·단일 브라우저를 암묵 전제한 것**(묶음 B·E).

### 1.2 범위 (Scope)

**포함:**

| 묶음 | 내용 | 상태 |
|---|---|---|
| A | 확인창 버튼 스타일 통일, 백그라운드 진입점을 상태바 우측 끝 버튼으로, 목록을 중앙 모달로 | 요구사항 확정 |
| B | `scripts/migrate.sh` 신설 + 안내문·문서 정정 | 요구사항 확정 |
| C | 모바일 키바 터치 반응·수평 슬라이드 복구 + 터치 e2e 프로젝트 | 요구사항 확정 |
| D | `restoreTool` 대상 Pane 지정 (`detach --restore <toolId> --at <uuid>`) | 요구사항 확정 |
| E | 크로스 기기 창 포커스 소유권 동기화 | **골격만. §3.5 결정 후 확정** |
| F | 모바일 키보드 표출 시 레이아웃 높이 체계 | **골격만. §3.6 결정 후 확정** |

**미포함:** §5 비목표 참조.

### 1.3 정의 (Definitions)

`Client` / `Window` / `Pane` / `Tab` / `Tool` / `백그라운드 도구` 는
`ENTITY_MODEL_RESTRUCTURE_SRS.md` §1.3 의 정의를 그대로 따른다. 본 SRS 고유 용어만 정의한다.

| 용어 | 정의 |
|------|------|
| **확인창** | `_confirmClose`(`web/js/app.js:505`) 가 만드는 모달. 닫기/취소 + 상황별 추가 버튼 |
| **백그라운드 진입점** | 백그라운드 도구 목록을 여는 UI 요소. 현재는 상태바 배지 `⏻ N` |
| **layout viewport** | `window.innerHeight` 가 보고하는 뷰포트. iOS 는 키보드 표출 시 이것을 줄이지 않는다 |
| **visual viewport** | `window.visualViewport` 가 보고하는 실제 보이는 영역 |
| **호환 마우스 이벤트** | 터치 브라우저가 `touchend` 후 합성하는 `mousedown`/`mouseup`/`click` |
| **소유권** | 한 Window 를 어느 Client 가 보고 있는지. `_windowFocusOwner`(`app.js:17`) |

### 1.4 참고 (References)

- `docs/internal/USER_CHECKLIST_FIXES_PLAN.md` — 실행 순서·의존성·열린 결정
- `docs/internal/ENTITY_MODEL_RESTRUCTURE_SRS.md` — FR-BG-* (본 SRS §6 이 개정)
- `docs/internal/archive/MOBILE_KEYBAR_ALWAYS_VISIBLE_SRS.md`, `MOBILE_KEYBAR_LAYOUT_ROBUSTNESS_SRS.md`, `MOBILE_KEYBAR_TOOLTIPS_SRS.md` — 키바 선행 스펙
- `docs/internal/archive/UUID_IDENTITY_SRS.md` — `location` = 탭 uuid 규약
- `docs/internal/archive/REMOTE_COMMAND_RESULT_SRS.md` — `reqId` echo 규약
- W3C Touch Events — `touchstart` 의 `preventDefault()` 는 호환 마우스 이벤트 생성을 취소한다

### 1.5 개요 (Overview)

§2 실측된 현황, §3 요구사항(묶음별), §4 검증, §5 비목표, §6 기존 요구사항 개정, §7 변경 기록.

---

## 2. 현황 (Identified Issue)

### 2.1 확인창의 네 번째 버튼만 스타일 규약 밖에 있다

`web/style.css:621` 이 `.confirm-bg` 의 유일한 규칙이다.

```css
.confirm-btns .confirm-bg{border-color:var(--accent-border);color:var(--accent)}
```

형제 버튼 `.confirm-ok`(`style.css:431`) · `.confirm-save`(`style.css:436`) ·
`.confirm-cancel`(`style.css:441`) 은 각각 `padding` · `border-radius` · `border` ·
`background` · `font-size` · `cursor` · `font-family:inherit` 7종을 모두 선언한다.
`.confirm-bg` 는 색상 2종만 선언하므로:

1. `border` 축약 선언이 없어 `border-color` 가 적용될 대상이 없다 (초기값 `border-style:none`)
2. `padding` · `background` · `font-family` 가 브라우저 기본 네이티브 버튼 값으로 남는다

위치도 근거가 된다. `.confirm-*` 규칙군은 `style.css:418-445` 에 모여 있는데 `.confirm-bg`
만 파일 최하단 백그라운드 섹션(`style.css:607-621`)에 있다. 기능 추가 시 스타일 규약을
확인하지 않고 색상만 덧붙인 흔적이다.

발현 경로는 두 곳이다 — `_confirmClose`(`app.js:505`)의 `opts.bgBtn` 분기(`app.js:514`)를
`delWindow`(`app.js:1134`)와 `closeTab`(`app.js:1274`)이 호출한다.

### 2.2 백그라운드 진입점이 상태 지표와 구별되지 않는다

`_updateStatusBar`(`app.js:2212`)가 배지를 `items` 배열에 넣는다 (`app.js:2225`):

```js
items.push(`<span class="sb-item sb-bg" id="sb-bg" title="백그라운드 도구 ${this._bg.length}개">⏻ ${this._bg.length}</span>`);
```

세 가지가 겹친다.

1. **위치** — `connection` · `latency` 다음, 즉 지표 나열의 중간이다
2. **스타일** — 다른 지표와 동일한 `.sb-item`(`style.css:380`). 추가된 것은
   `cursor:pointer` 와 hover 색뿐(`style.css:608-609`)이라 정적 상태에서 구분 단서가 없다
3. **수명** — `bar.innerHTML=items.join('')`(`app.js:2265`)이 `statsInterval` 주기마다
   상태바를 통째로 재생성한다. 그래서 클릭 리스너를 매번 재부착해야 한다(`app.js:2266`).
   상호작용 요소가 폴링 주기에 종속된 구조다

### 2.3 백그라운드 목록이 사라질 앵커에 매여 있다

`_bgPopoverRender`(`app.js:2278`)가 `#sb-bg` 의 `getBoundingClientRect()` 로 `position:fixed`
팝오버를 배치한다. §2.2 를 해소해 진입점 구조가 바뀌면 이 위치 계산은 무효가 된다.
현재 구현에는 `Esc` 핸들러도 없다 — 문서 클릭 리스너만 있다.

### 2.4 모바일 키바가 실기기에서 반응하지 않는다

`_initMobileKeybar`(`app.js:1826`)의 터치 핸들러:

```js
b.addEventListener('touchstart',e=>{
  e.preventDefault();                                    // app.js:1907
  longPressFired=false;
  pressTimer=setTimeout(()=>{longPressFired=true;showTip(full,b)},600);
},{passive:false});
```

`touchstart` 에서 `preventDefault()` 를 호출하면 규격상 브라우저가 **호환 마우스 이벤트
합성을 취소**한다. 그런데 키 전송과 모디파이어 토글은 전부 `click` 리스너(`app.js:1920`)에
있고, `touchend`(`app.js:1916`)는 롱프레스일 때만 처리하고 짧은 탭에는 아무 동작이 없다.

→ **실기기에서 짧은 탭이 아무 효과도 내지 못한다.**

같은 `preventDefault()` 가 그 터치의 스크롤도 취소한다. `#mobile-keybar`
(`style.css:527`)에 `overflow-x:auto` 가 있어도 **버튼 위에서 시작한 스와이프로는
슬라이드가 불가**하다. 버튼이 바를 거의 덮으므로 (`padding:4px 6px`) 사실상 슬라이드 불능이다.

**왜 테스트를 통과했는가.** `playwright.config.ts` 는 `devices['Desktop Chrome']`
(`hasTouch:false`) 단일 프로젝트다. `e2e/mobile-keybar.spec.ts` 의 `TC-D1` · `TC-T4` 는
`.click()`(마우스 경로)만 쓴다. `touchstart` 리스너가 발동하지 않으므로 실기기 경로가
전혀 검증되지 않는다.

### 2.5 `dongminal migrate` 안내가 실행 불가하다

`cmd/dongminal/main.go:432-434` 가 스키마 미달 시 안내한다.

```
2) 변환 내용 확인:            dongminal migrate --dry-run
3) 변환 실행:                 dongminal migrate
```

그런데 `$DONGMINAL_HOME/bin/` 에 설치되는 것은 `internal/runtimebin/dispatch.go:19-24` 의
4개뿐이다.

```go
var commands = map[string]runFunc{
	"dmctl": runDmctl, "edit": runEdit,
	"download": runDownload, "detach": runDetach,
}
```

`runtime.Install`(`internal/runtime/install.go:32`)은 `helperNames()` 만 symlink 하므로
`dongminal` 자체는 PATH 에 오지 않는다. 루트의 `./dongminal` 은 `.gitignore:2` 로 제외된
빌드 산출물이므로 존재를 보장할 수 없다. `dmctl` 에도 `migrate` 서브커맨드는 없다.

→ **안내문을 그대로 따르면 `command not found: dongminal`.**
동일 문구가 `docs/internal/ENTITY_MODEL_HANDOFF.md:149-150` 과
`docs/internal/architecture.md:12` 에도 있다.

### 2.5a 마이그레이션 진입점의 두 함정 (묶음 B 구현 중 실측)

FR-MIG 초안대로 `scripts/migrate.sh` 를 만들어 돌렸을 때 **운영 홈을 대상으로
웹 서버가 부팅**됐다. 두 원인이 겹쳤다.

**(1) `.env` 가 호출자 환경변수를 덮어쓴다.** `.env` 에 `DONGMINAL_HOME=~/.dongminal`
이 있고, `_load_env`(`scripts/start.sh:8`)는 값을 무조건 `export` 한다. 따라서
`DONGMINAL_HOME=/tmp/... ./scripts/migrate.sh` 로 격리 홈을 지정해도 운영 홈으로
대체된다. `start.sh`/`stop.sh` 는 `.env` 를 기본값으로 쓰는 것이 의도이므로 무해하지만,
**파괴적 동작에서는 지정한 대상이 무시되는 것 자체가 결함**이다.

**(2) 낡은 바이너리 재사용이 파괴적 오작동을 한다.** 존재 여부만 확인해
(`[ ! -x "./$BINARY" ]`) 재사용하면, `migrate` 서브커맨드가 없던 시절의 바이너리가
`migrate` 를 **인자가 아닌 것으로 무시하고 웹 서버로 부팅**한다. 실측된 결과:

```
dongminald not reachable, starting...        ← 데몬 기동 시도
paneclient read: ... use of closed network connection   ← 100초간 재시도
dongminald did not become ready (falling back to direct mode)
[pane 267] restored total=1 ... panes restored count=16 ← 운영 홈의 PTY 16개 되살림
server fatal: listen tcp 127.0.0.1:58146: bind: address already in use
```

마이그레이션을 하려던 명령이 100초를 소비하고 PTY 16개를 띄운 뒤 포트 충돌로 죽었다.
`migrate.Apply` 의 데몬 검사(`ErrDaemonRunning`)는 이 경로에 도달하지 못한다 —
`migrate` 서브커맨드 자체가 디스패치되지 않았기 때문이다.

**(3) 데몬 검사만으로는 부족하다.** 운영 인스턴스가 direct mode 로 돌 수 있다
(`paned.sock` 이 낡아 데몬 연결에 실패하면 `dongminal` 은 ToolManager 를 직접 쓴다).
그때 `paned.pid` 는 죽은 pid 를 가리키므로 `daemonAlive` 가 false 를 돌려주고,
`Apply` 는 살아 있는 서버가 소유한 홈을 변환하게 된다.

### 2.6 백그라운드 복귀 대상을 지정할 수 없다

`_restoreTool`(`app.js:558`)이 대상 Pane 을 `this.focused` 로 하드코딩한다. 이는
FR-BG-7(`ENTITY_MODEL_RESTRUCTURE_SRS.md:219`) 명세대로의 동작이므로 **결함이 아니다.**

다만 `detach --restore` 를 다른 Window 의 셸에서 실행하면 기준점이 *명령을 실행한 도구의
Pane* 이 아니라 *브라우저가 현재 포커스한 Pane* 이 된다. 워크스페이스 조작 명령 중
대상 지정 수단이 없는 유일한 명령이다 — `dmctl` 계열은 `--at <uuid>`(`dmctl.go:213-223`)로
대상을 지정하고, 서버의 `translateLocationUUID`(`internal/server/commands.go:202`)는
**action 종류를 보지 않고** `args.location` 이 있으면 uuid→좌표로 변환한다.

즉 서버는 이미 준비되어 있고 클라이언트와 CLI 만 이를 쓰지 않는다.

대비: `detachTab`(`app.js:391`)은 `_findToolLocation(args.toolId)` 로 위치를 역산하므로
`toolId` 만으로 대상이 완전히 결정된다 — 대상 지정 수단이 필요 없다.

### 2.7 창 포커스 소유권이 동일 브라우저를 벗어나지 못한다

`_initFocusChannel`(`app.js:1640`) · `_focusWindow`(`app.js:1673`)가
`BroadcastChannel('dongminal-focus')`(`app.js:1642`)로 소유권을 전파한다.
`BroadcastChannel` 은 **동일 브라우저 · 동일 origin 내 컨텍스트끼리만** 통신한다.

1. 다른 기기의 브라우저와는 원리적으로 통신 불가 → `_windowFocusOwner` 미동기화 →
   `_applyFocusOverlay`(`app.js:1709`)의 dim 미적용
2. `--expose` 접속 시 `localhost:PORT` 와 `<host-ip>:PORT` 는 **origin 이 달라** 같은
   컴퓨터의 두 탭 사이에서도 채널이 격리된다

같은 상태를 `_resizeCheck`(`app.js:1699`)가 PTY 리사이즈 권한 판정에 쓴다. 즉 이 결손은
표시 문제에 그치지 않고 터미널 크기 결정에도 영향한다 — `README.md` TODO
"focused browser 자동 동기화"와 같은 뿌리다.

해제 경로도 불완전하다. `beforeunload`(`app.js:1660`)는 원격 기기의 강제 종료·네트워크
단절에서 발화하지 않으므로 소유권이 영구히 남는다.

### 2.8 모바일 키보드 표출 시 문서가 스크롤된다

`_initMobileKeybar` 의 visualViewport 블록(`app.js:1938-1962`):

```js
const kbH=Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
if(isUp){
  bar.style.bottom = kbH + 'px';                                  // app.js:1955
  document.body.style.paddingBottom = (kbH + kbH_PX()) + 'px';    // app.js:1956
}
```

`html,body{height:100%;overflow:hidden}`(`style.css:14`) + 전역
`box-sizing:border-box`(`style.css:1`) 구조에서 body 에 `padding-bottom` 을 더하면 `#app` 의
사용 가능 높이는 줄어든다. 그러나 **iOS Safari 는 키보드 표출 시 layout viewport 를 줄이지
않고 visual viewport 를 위로 스크롤**한다. 이 스크롤은 `overflow:hidden` 으로 막을 수 없다.

결과: topbar 가 화면 밖으로 밀려 사용자가 화면을 스크롤해야 한다. `#area` 가 실제로 줄지
않으므로 `doFit()`(`app.js:1962`)도 무효가 된다 — 요구 원문의 "탭이 줄어드는걸 감지하지
못하는 것 같음"이 이 현상이다.

`e2e/mobile-keybar.spec.ts` 의 `TC-A1`~`TC-A4` 는 `--m-kb-h` 와 `body.paddingBottom` **수치만**
검증하므로 이 증상을 잡지 못한다.

---

## 3. 요구사항 (Requirements)

### 3.1 묶음 A — 백그라운드 UI 일관화

**FR-BGU-1** 확인창의 모든 버튼은 동일한 형태 규약(`padding` · `border` ·
`border-radius` · `font-size` · `font-family` · `cursor`)을 공유하고, 역할 색상만
달라진다. 규약은 단일 규칙으로 표현하며 버튼별 규칙은 색상만 선언한다. 새 버튼을
추가할 때 형태 선언을 다시 쓰지 않아도 되는 구조여야 한다.

**FR-BGU-2** 백그라운드 진입점은 상태바의 **우측 끝**에 놓인다.

**FR-BGU-3** 진입점은 `.tbtn`(`style.css:90`)의 버튼 UI 를 쓴다. 색상은 테마 CSS 변수만
사용한다 — 리터럴 색상값을 새로 도입하지 않는다.

**FR-BGU-4** 진입점은 상태바 지표 재생성(`_updateStatusBar`)의 대상이 **아니다.** 정적
요소로 존재하고 개수·표시 여부만 갱신된다. 클릭 리스너는 초기화 시 1회만 부착한다.

**FR-BGU-5** 백그라운드 도구가 0개일 때 진입점은 표시되지 않는다 (FR-BG-8 유지).

**FR-BGU-6** 백그라운드 목록은 화면 중앙 모달로 표시된다. 앵커 요소의 좌표에 의존하지
않는다.

**FR-BGU-7** 모달은 오버레이 배경 클릭과 `Esc` 로 닫힌다.

**FR-BGU-8** 목록 항목 클릭 시 복귀 동작은 변경되지 않는다 (FR-BG-7 / FR-BGR-1 경로).

**FR-BGU-9** 상태바 지표 나열과 진입점 사이에 `.sb-item+.sb-item` 구분선
(`style.css:381`)이 적용되지 않는다 — 진입점은 지표가 아니다.

### 3.2 묶음 B — 마이그레이션 진입점

**FR-MIG-1** `scripts/migrate.sh` 가 v1→v2 엔티티 스키마 마이그레이션의 사용자 진입점이
된다. 인자는 `dongminal migrate` 에 그대로 위임한다 (`--dry-run` 포함).

**FR-MIG-2** 스크립트는 기존 운영 스크립트의 규약을 따른다 —
`cd "$(dirname "$0")/.."`, `.env` 안전 로드(`_load_env`), `PORT`/`DONGMINAL_HOME`/`BINARY`
환경변수 해석. `scripts/{start,stop,health}.sh` 와 동일한 형태여야 한다. `PORT` 는
FR-MIG-6 의 서버 실행 검사에 쓴다.

**FR-MIG-3** **매 실행마다 바이너리를 빌드한다.** 존재 여부로 재사용을 결정하지
않는다 — §2.5a(2) 의 파괴적 오작동은 낡은 바이너리 재사용에서 나온다. 빌드 실패 시
마이그레이션을 시도하지 않고 비영 종료한다.

**FR-MIG-4** 마이그레이션 변환 로직(`internal/migrate`)과 `dongminal migrate` 서브커맨드
(`cmd/dongminal/main.go:380`)는 **변경하지 않는다.** 진입점만 추가한다.

**FR-MIG-5** 스키마 미달 안내문(`cmd/dongminal/main.go:432-434`)과 문서
(`docs/internal/architecture.md:12`, `docs/internal/ENTITY_MODEL_HANDOFF.md:149-150`,
`README.md` 스크립트 목록)이 실행 가능한 명령을 가리킨다.

**FR-MIG-6** `PORT` 에서 dongminal 웹 서버가 응답하면 변환을 거부하고 정지 방법을
안내한다. `migrate.Apply` 의 데몬 검사만으로는 direct mode 로 도는 인스턴스를 잡지
못한다 (§2.5a(3)). `--dry-run` 은 파일을 변경하지 않으므로 이 검사의 대상이 아니다.

**FR-MIG-7** 호출자가 명시한 환경변수가 `.env` 값보다 **우선**한다. `.env` 는
기본값으로만 쓰인다 — 지정한 `DONGMINAL_HOME` 이 무시되면 의도하지 않은 홈을 변환한다
(§2.5a(1)).

### 3.3 묶음 C — 모바일 키바 터치

**FR-MTB-1** 키바 버튼의 짧은 탭은 실제 터치 디바이스에서 키를 전송한다. 모디파이어
버튼의 짧은 탭은 sticky 상태를 토글한다.

**FR-MTB-2** 키 전송·모디파이어 토글은 마우스 경로(`click`)와 터치 경로(`touchend`)
양쪽에서 동작하며, 한 제스처가 두 경로를 모두 타서 **두 번 발동해서는 안 된다.**

**FR-MTB-3** 버튼 위에서 시작한 수평 스와이프로 키바를 슬라이드할 수 있다.

**FR-MTB-4** 롱프레스(600ms) 툴팁 동작은 유지된다. 롱프레스가 발동한 제스처는 키를
전송하지 않는다 (기존 REQ-T-2/T-3).

**FR-MTB-5** 롱프레스 취소 판정은 **이동 거리 임계값**으로 한다. 임계값 미만의 미세한
떨림은 롱프레스를 취소하지 않고, 임계값 이상의 이동은 롱프레스와 키 전송 모두 취소하고
스크롤로 넘긴다.

**FR-MTB-6** 키바 조작이 xterm 의 포커스를 빼앗지 않는다 (기존 TC-D2 의 `mousedown`
포커스 가드 유지). 터치 경로에서도 동일해야 한다.

**FR-MTB-7** Playwright 에 `hasTouch:true` 프로젝트를 신설하고, 키바 터치 요구사항은 그
프로젝트에서 검증한다. 기존 마우스 경로 검증은 유지한다.

### 3.4 묶음 D — 백그라운드 복귀 대상 지정

**FR-BGR-1** `restoreTool` 은 `args.location` 을 수용한다. 지정 시 그 위치의 Pane 에
복귀하고, 미지정 시 현재 포커스된 Pane 에 복귀한다 (기존 동작 = 기본값).

**FR-BGR-2** `location` 의 해석은 기존 규약과 동일하다 — 값은 **탭 uuid** 이고
(`translateLocationUUID`, `IsKnownTabID`), 서버가 좌표로 변환하며, 클라이언트는
`_resolveLocation`(`app.js:347`)으로 `{windowId, paneId}` 를 얻는다. `restoreTool` 은
Pane 단위 동작이므로 **좌표의 T 성분은 무시**된다. 이는 `newTab` · `splitH` · `splitV` 가
이미 쓰는 해석이다.

**FR-BGR-3** `detach --restore <toolId> --at <uuid>` 로 대상을 지정한다. 플래그는
`dmctl` 규약을 따른다 — `--at <uuid>` · `-l <uuid>` · `--at=<uuid>`.

**FR-BGR-4** `--at` 없는 기존 호출 형태 `detach --restore <toolId>` 는 동작이 변하지
않는다.

**FR-BGR-5** 복귀 대상 Pane 이 존재하지 않으면 복귀하지 않고 그 사실을 알린다. 백그라운드
상태를 해제한 뒤 실패해 도구가 어디에도 매이지 않는 상태가 되어서는 안 된다.

**FR-BGR-6** 서버(`internal/server`)와 `dmctl` 은 변경하지 않는다. `restoreTool` 은 이미
action 화이트리스트에 있고 `location` 변환은 action 무관하게 동작한다.

**비목표(D)**: `restoreTool` 을 MCP `workspace_command` 에 노출하지 않는다 — `toolId`
인자가 MCP 스키마에 없어 `location` 추가만으로는 호출 가능해지지 않으며, 이는 별개 결정이다.

### 3.5 묶음 E — 크로스 기기 창 포커스 (미확정)

아래는 **골격**이다. `USER_CHECKLIST_FIXES_PLAN.md` §6.1 의 결정 E-1..E-5 를 해소한 뒤
FR-XDF-* 로 확정한다.

- **목표 동작**: 서로 다른 기기·origin 의 Client 들 사이에서도 한 Window 를 보는 Client 가
  하나로 수렴하고, 나머지 Client 에서 그 Window 가 dim 된다
- **전송 경로**: 브라우저→서버 `POST`, 서버→브라우저 SSE(`/api/commands/sse`). 기존
  `CommandHub.Broadcast`(`internal/server/commands.go:155`)와 `_subscribeCommands`
  (`app.js:180`) 재사용
- **자기 에코 필터**: `clientId`(`app.js:8`) 비교
- **늦은 참여 복원**: `_attnRestore` · `_activityRestore` 와 동일한 스냅샷 조회 패턴
- **해제**: SSE 구독 해제 시 서버가 소유권을 해제한다 (`beforeunload` 의존 제거)
- **동반 이전**: `_resizeCheck`(`app.js:1699`) — 같은 상태를 읽으므로 분리 불가

### 3.6 묶음 F — 모바일 키보드 뷰포트 (미확정)

아래는 **골격**이다. `USER_CHECKLIST_FIXES_PLAN.md` §6.2 의 결정 F-1..F-5 를 해소한 뒤
FR-MKV-* 로 확정한다.

- **목표 동작**: 키보드가 올라오면 터미널 영역만 줄어들고, 문서 전체가 스크롤되지 않는다
- **높이 권위**: layout viewport(`height:100%`) → visual viewport 기반 값으로 이전
- **iOS 상쇄**: `vv.offsetTop` 관측 기반 보정
- **viewport meta**: `interactive-widget=resizes-content` 추가 검토 (`index.html:5`)
- **검증 제약**: iOS 실기기 수동 검증 필수. 기존 `TC-A1`~`TC-A4` 는 수치 검증이므로
  높이 체계 교체 시 동반 개정 대상

---

## 4. 검증 (Verification)

### 4.1 묶음 A

| TC | FR | 절차 | 기대 |
|---|---|---|---|
| TC-BGU-1 | FR-BGU-1 | busy 도구가 있는 탭 닫기 → 확인창 | 세 버튼의 `padding`·`border-width`·`border-radius`·`font-family` 계산값이 동일 |
| TC-BGU-2 | FR-BGU-1 | `{백그라운드, 닫기, 취소}` 와 `{저장 후 닫기, 닫기, 취소}` 두 조합 각각 | 조합 안에서 역할 색상이 서로 다르다. 동시에 표출되지 않는 버튼끼리는 비교하지 않는다 |
| TC-BGU-3 | FR-BGU-2 | 백그라운드 도구 1개 생성 | 진입점의 우측 경계가 상태바 우측 내부 경계와 일치 |
| TC-BGU-4 | FR-BGU-3 | 동일 | 진입점의 계산된 색상이 테마 변수 값과 일치. 테마 변경 시 함께 변한다 |
| TC-BGU-5 | FR-BGU-4 | 진입점 노드에 마커를 심고 `_updateStatusBar` 를 직접 3회 호출 | 마커가 유지된다 (노드가 재생성되지 않음). 폴링 주기(3s) 대기보다 결정론적이다 |
| TC-BGU-6 | FR-BGU-5 | 백그라운드 도구 0개 | 진입점 비표시 |
| TC-BGU-7 | FR-BGU-6 | 진입점 클릭 | 모달이 뷰포트 중앙에 표시. 진입점 좌표와 무관 |
| TC-BGU-8 | FR-BGU-7 | 모달 표시 후 `Esc` / 배경 클릭 | 각각 닫힘 |
| TC-BGU-9 | FR-BGU-8 | 모달에서 항목 클릭 | 현재 Pane 새 탭에 복귀. 목록에서 제거 |

### 4.2 묶음 B

| TC | FR | 절차 | 기대 |
|---|---|---|---|
| TC-MIG-1 | FR-MIG-1 | v1 스키마 홈에서 `./scripts/migrate.sh --dry-run` | 변환 계획 출력. 파일 무변경 |
| TC-MIG-2 | FR-MIG-1 | 이어서 `./scripts/migrate.sh` | v2 변환 + `*.v1.bak` 백업 생성 |
| TC-MIG-3 | FR-MIG-3 | `BINARY` 자리에 `exit 42` 스텁을 두고 실행 | 스텁이 아니라 재빌드된 바이너리가 실행된다 (rc≠42, 정상 변환) |
| TC-MIG-4 | FR-MIG-3 | `go` 가 없는 PATH 로 실행 | 비영 종료. 마이그레이션 미시도 |
| TC-MIG-5 | FR-MIG-4 | `internal/migrate` 기존 유닛 테스트 | 전량 통과 (무변경 확인) |
| TC-MIG-6 | FR-MIG-5 | 안내문·문서에 나온 명령을 그대로 실행 | 전부 실행 가능 |
| TC-MIG-7 | FR-MIG-6 | `PORT` 를 점유한 상태에서 실행 | 거부 + 정지 안내. 파일 무변경 |
| TC-MIG-8 | FR-MIG-6 | 같은 상태에서 `--dry-run` | 정상 수행 (읽기 전용이므로 거부 대상 아님) |
| TC-MIG-9 | FR-MIG-7 | `.env` 와 다른 `DONGMINAL_HOME` 을 지정해 실행 | 지정한 홈이 변환된다. `.env` 의 홈은 무변경 |
| TC-MIG-10 | 안전 | 전 TC 수행 후 | 루트 `./dongminal` 이 삭제·권한 변경되지 않았다 |

### 4.3 묶음 C — `hasTouch:true` 프로젝트에서 수행

| TC | FR | 절차 | 기대 |
|---|---|---|---|
| TC-MTB-1 | FR-MTB-1 | `Esc` 버튼 짧은 탭(터치) | 포커스된 터미널에 `ESC` 전송 |
| TC-MTB-2 | FR-MTB-1 | `Ctrl` 버튼 짧은 탭(터치) | `sticky` 클래스 부여 |
| TC-MTB-3 | FR-MTB-2 | 한 번의 탭 제스처 | 키 전송 1회 (중복 없음) |
| TC-MTB-4 | FR-MTB-2 | 마우스 클릭 (기존 경로) | 키 전송 1회 |
| TC-MTB-5 | FR-MTB-3 | 버튼 위에서 시작하는 수평 스와이프 | `scrollLeft` 증가 |
| TC-MTB-6 | FR-MTB-4 | 700ms 홀드 | 툴팁 표시, 키 미전송, 모디파이어 무변화 |
| TC-MTB-7 | FR-MTB-5 | 임계값 미만 떨림 후 릴리스 | 롱프레스 유지 (또는 키 전송) — 스크롤 미발생 |
| TC-MTB-8 | FR-MTB-6 | 터치로 키 전송 후 | 터미널이 포커스를 유지 |
| TC-MTB-9 | FR-MTB-7 | 기존 마우스 경로 스위트 | 전량 통과 |

### 4.4 묶음 D

| TC | FR | 절차 | 기대 |
|---|---|---|---|
| TC-BGR-1 | FR-BGR-1 | Window2 의 탭 uuid 로 `detach --restore <id> --at <uuid>` | 그 탭이 속한 Pane 에 새 탭으로 복귀 |
| TC-BGR-2 | FR-BGR-1, FR-BGR-4 | `--at` 없이 `detach --restore <id>` | 현재 포커스 Pane 에 복귀 (기존 동작) |
| TC-BGR-3 | FR-BGR-2 | 같은 Pane 의 두 번째 탭 uuid 지정 | 동일 Pane 에 복귀 (T 성분 무시 확인) |
| TC-BGR-4 | FR-BGR-2 | 좌표(`W1.P1.T1`)·`toolId` 를 `--at` 에 지정 | 서버가 400. 복귀 미수행 |
| TC-BGR-5 | FR-BGR-3 | `--at=<uuid>` · `-l <uuid>` 형태 | 모두 동작 |
| TC-BGR-6 | FR-BGR-5 | 존재하지 않는 uuid 지정 | 복귀 미수행. 도구가 백그라운드 목록에 그대로 남는다 |
| TC-BGR-7 | FR-BGR-6 | `internal/server` 기존 테스트 | 전량 통과 (무변경 확인) |

### 4.5 회귀 검증 (전 묶음 공통)

| 대상 | 이유 |
|---|---|
| `e2e/mobile-keybar.spec.ts` TC-6 | 묶음 A 가 상태바 구조를 바꾼다 |
| `e2e/mobile-keybar.spec.ts` TC-D1/D2/T2/T3/T4 | 묶음 C 가 같은 핸들러를 재작성한다 |
| `e2e/mobile-keybar.spec.ts` TC-A1..A4 | 묶음 F 가 높이 체계를 교체한다 (F 착수 시 개정) |
| `internal/migrate` 유닛 | 묶음 B — 구 어휘가 입력이므로 일괄 치환 금지 |
| `e2e/focus.spec.ts`, `focus-invariant.spec.ts`, `regression-focus.spec.ts` | 묶음 E 가 소유권 경로를 교체한다 |
| `go test ./...` 전량 | 묶음 B·D |

---

## 5. 비목표 (Non-goals)

1. **`detachTab` 의 대상 지정** — `toolId` 로 대상이 완전히 결정된다 (§2.6)
2. **MCP `workspace_command` 에 `restoreTool` 노출** — §3.4 비목표 참조
3. **`restoreTool` 의 `reqId` echo 지원** — `creatingActions`
   (`internal/server/commands.go:58`)에 `restoreTool` 이 없어 생성된 탭 uuid 를 CLI 가 받지
   못한다. 실제 결손이지만 본 요구 범위 밖이다. **별도 항목으로 기록만 한다**
4. **README TODO "focused browser 자동 동기화"** — 묶음 E 와 뿌리는 같으나 별건
5. **모바일 Ctrl+C/D/Z 단발 버튼, 키 커스터마이즈** — `MOBILE_MODE_RFC` §8 잔여
6. **키보드 표출 시 상태바 숨김** — 요구 원문은 "터미널 창만 줄어들면 좋겠다"이다
7. **UI 에서 복귀 대상 Pane 선택** — 모달에 대상 선택기를 넣지 않는다. CLI 표면만 확장한다
8. **`.confirm-*` 외 버튼군의 스타일 통일** — `.tbtn` · `.mtbtn` · `.mkb-btn` 은 각자
   맥락이 다르다. 확인창 내부만 다룬다

---

## 6. 기존 요구사항 개정 (Amendments)

묶음 D 착수 시 `docs/internal/ENTITY_MODEL_RESTRUCTURE_SRS.md` 를 아래와 같이 개정한다.

| 대상 | 현행 | 개정 |
|---|---|---|
| FR-BG-7 (:219) | "`detach --restore <id>` 는 백그라운드 도구를 **현재 Pane** 의 새 탭으로 복귀시킨다" | "…를 **지정 Pane**(`--at <uuid>`, 미지정 시 현재 Pane)의 새 탭으로 복귀시킨다" |
| FR-BG-8 (:221) | "배지 클릭 시 목록을 표시하고, 항목 클릭 시 FR-BG-7 와 동일하게 복귀시킨다" | 진입점을 "상태바 배지" → "상태바 우측 끝 버튼", "목록 표시" → "중앙 모달"로. 항목 클릭 시 대상 미지정 복귀 (FR-BGR-1 기본값) |
| TC-BG-7 (:289) | "현재 Pane 새 탭에 부착. 스크롤백 보존. 목록에서 제거" | 대상 지정 케이스 추가 (TC-BGR-1..6 참조) |

묶음 A 는 FR-BG-8 의 UI 서술만 바꾸고 동작 계약은 바꾸지 않는다.

---

## 7. 변경 기록 (Change Log)

동작이 변경되는 항목은 구현 시 아래 표에 **이전 동작 / 새 동작 / 이유**를 기록한다.

| 묶음 | 항목 | 이전 동작 | 새 동작 | 이유 |
|---|---|---|---|---|
| A | 확인창 "백그라운드로" 버튼 | 네이티브 버튼 형태 (padding·border·font-family 미지정) | 형제 버튼과 동일한 형태, 색만 다름 | `.confirm-bg` 가 색상 2종만 선언해 `border-style:none` 이었다. 형태 규약을 `.confirm-btns button` 단일 규칙으로 옮겨 5번째 버튼에서 재발하지 않게 한다 |
| A | 백그라운드 진입점 위치 | 상태바 지표 나열 중간 (connection·latency 다음) | 상태바 우측 끝 | 지표에 묻혀 보이지 않았다 |
| A | 백그라운드 진입점 형태 | `.sb-item` (지표와 동일) | `.tbtn` 버튼 (상태바 높이에 맞춰 여백만 축소) | 상호작용 요소임이 정적 상태에서 드러나야 한다 |
| A | 백그라운드 진입점 수명 | `_updateStatusBar` 가 폴링(3s)마다 재생성, 리스너 재부착 | `index.html` 정적 요소. `_updateBgBtn` 이 표시 여부·개수만 갱신, 리스너는 `_initStatusBar` 에서 1회 | 상호작용 요소가 폴링 주기에 종속되지 않아야 한다 |
| A | 백그라운드 목록 표시 | `#sb-bg` 앵커 기준 `position:fixed` 팝오버. 문서 클릭으로만 닫힘 | 화면 중앙 모달. 배경 클릭 + `Esc` 로 닫힘 | 앵커 좌표 의존을 제거하고 확인창(`.confirm-overlay`)과 동일한 모달 규약으로 통일 |
| B | 마이그레이션 진입점 | 안내문이 `dongminal migrate` 를 지시 — PATH 에 없어 `command not found` | `./scripts/migrate.sh [--dry-run]` | `dongminal` 은 helper 로 설치되지 않는다 (dmctl/edit/download/detach 뿐) |
| B | 바이너리 처리 | (신규) | 매 실행마다 `go build` | 존재 여부로 재사용하면 `migrate` 를 모르는 낡은 바이너리가 웹 서버로 부팅해 데몬 대기 100초 + PTY 되살림 + 포트 충돌을 일으킨다 (§2.5a-2, 구현 중 실측) |
| B | 환경변수 우선순위 | (신규) | 호출자 값 > `.env` 값 | `_load_env` 가 무조건 export 하므로 지정한 `DONGMINAL_HOME` 이 `.env` 의 운영 홈으로 대체됐다 (§2.5a-1, 구현 중 실측) |
| B | 서버 실행 중 보호 | (신규) | `PORT` 응답 시 변환 거부 (`--dry-run` 은 허용) | `Apply` 의 데몬 검사는 direct mode 인스턴스를 잡지 못한다 (§2.5a-3) |
| C | | | | |
| D | | | | |

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
| A | 확인창 버튼 스타일 통일, 백그라운드 진입점을 상태바 우측 끝 버튼으로, 목록을 중앙 모달로 | **구현 완료** (`eec0ddd`) |
| B | `scripts/migrate.sh` 신설 + 안내문·문서 정정 | **구현 완료** (`e6463e1`) |
| C | 모바일 키바 터치 반응·수평 슬라이드 복구 + 터치 e2e 프로젝트 | **구현 완료** (`18c7f14`) |
| D | `restoreTool` 대상 Pane 지정 (`detach --restore <toolId> --at <uuid>`) | **구현 완료** (`a906418`) |
| E | 크로스 기기 창 포커스 소유권 동기화 | **구현 완료** (§3.5, FR-XDF-1..14) |
| F | 모바일 키보드 표출 시 visual viewport 스크롤 상쇄 | **구현 완료** (§3.6, FR-MKV-1..11) |

완료 묶음의 구현 결과와 함정은 [USER_CHECKLIST_FIXES_HANDOFF.md](./USER_CHECKLIST_FIXES_HANDOFF.md) 에 있다.

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

`_initMobileKeybar` 의 visualViewport 블록(`app.js:2016-2046`):

```js
const kbH=Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
if(isUp){
  bar.style.bottom = kbH + 'px';                                  // app.js:2034
  document.body.style.paddingBottom = (kbH + kbH_PX()) + 'px';    // app.js:2035
}
```

#### 2.8a 이 결손은 iOS 한정이 아니다 (조사 결과)

초판은 이 항목을 "iOS Safari 의 특이 거동"으로 서술했다. **더 이상 사실이 아니다.**
**Chrome 108 부터 Android Chrome 이 MobileSafari 에 맞춰 기본 거동을 바꿨다** — 가상
키보드가 뜰 때 layout viewport 를 줄이지 않고 **visual viewport 만** 줄인다
(기본값 `interactive-widget: resizes-visual`). Samsung Internet 은 Chromium 기반이므로
(현 30 = M143) 동일하다. 즉 사용자가 쓰는 세 브라우저가 모두 같은 거동이다.

갈리는 것은 **복구 수단**이다.

| 엔진 | 키보드 표출 시 layout viewport | `interactive-widget` |
|---|---|---|
| Chrome Android ≥108 | 줄지 않음 (기본 `resizes-visual`) | **지원** (108+) |
| Samsung Internet ≥20 (Chromium ≥108) | 동일 | **지원** |
| Firefox ≥132 | 동일 | **지원** |
| iOS Safari | 줄지 않음 **+ visual viewport 를 스크롤** | **미지원** |

`interactive-widget=resizes-content` 를 선언하면 Chromium·Firefox 는 layout viewport
까지 줄인다 — 그러면 `innerHeight` 가 함께 줄어 `kbH ≈ 0` 이 되고 위 JS 분기는
**스스로 비활성**이 되며 `height:100%` 사슬이 그대로 옳아진다. WebKit 은 이 키를
무시하므로 JS 경로가 유일한 수단이다.

#### 2.8b `#area` 는 실제로 줄어든다 — 초판의 서술은 틀렸다

초판은 "`#area` 가 실제로 줄지 않으므로 `doFit()` 도 무효가 된다"고 적었다.
**측정으로 반증됐다.** 전역 `box-sizing:border-box`(`style.css:1`) + `html,body{height:100%}`
(`style.css:15`) 구조에서 body 에 `padding-bottom` 을 더하면 body 의 **content box** 가
줄고, `#app{height:100%}`(`style.css:16`) 는 그 content box 를 기준으로 하므로
`#app → #content → #area` 가 전부 줄어든다.

실측 (390×780 뷰포트, 키보드 300px):

| 상태 | `#area` 높이 |
|---|---|
| 키보드 없음 | 688px |
| 키보드 표출 (`offsetTop=0`) | **388px** — 줄어든다 |

따라서 **높이 권위(`height:100%`)를 교체할 필요가 없다.** 결손은 하나뿐이다.

#### 2.8c 진짜 결손: `vv.offsetTop` 을 아무도 상쇄하지 않는다

iOS Safari 는 포커스된 요소를 드러내기 위해 visual viewport 를 **위로 스크롤**한다
(`vv.offsetTop > 0`). 이 스크롤은 `overflow:hidden` 으로 막을 수 없고, 레이아웃은
layout viewport 좌표계에 그대로 있으므로 화면 상단이 가시 영역 밖으로 밀린다.

실측 (같은 뷰포트, 키보드 300px, **`offsetTop=120`**):

```
가시 영역   = [120, 600]        (vv.offsetTop ~ vv.offsetTop+vv.height)
kbH        = 780-480-120 = 180
padBottom  = 180+38 = 218
#app       = [0, 562]          ← 상단 120px 이 가시 영역 밖
#topbar    = [0, 32]           ← 전체가 가시 영역 밖. 이것이 사용자가 본 증상이다
#area      = [32, 540]
#mobile-keybar = [562, 600]    ← 이쪽은 정확하다 (fixed, bottom:kbH)
```

`padding-top` 이 `0px` 인 것이 유일한 오차다. `padding-top = vv.offsetTop` 을 주면
body content box 가 `[120, 562]` 로 내려와 topbar 가 `[120,152]` 에 보이고, 키바는
계산이 바뀌지 않으므로 `[562,600]` 에 그대로 남아 **틈도 겹침도 없다.**

#### 2.8d 기존 테스트가 이것을 볼 수 없는 이유

`e2e/mobile-keybar.spec.ts` 의 `stubVisualViewportHeight`(`:100`)가
**`offsetTop` 을 0 으로 고정한다**(`:105`). `TC-A1`~`TC-A4` 는 스크롤된 상태를 한 번도
만들지 않으므로 이 결손을 원리적으로 관측할 수 없다 — 함정 7(`hasTouch:false` 에서
`touchstart` 미발동)과 같은 구조다. 게다가 `resizes-content` 를 선언한 뒤에는 그 시뮬
자체가 **실재하는 엔진 거동과 대응하지 않는다**(실제 Chromium 에서는 `innerHeight` 가
함께 줄어 `kbH≈0` 이 된다). 그래서 동반 개정이 아니라 **재작성** 대상이다.

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

**FR-BGR-3** `detach --restore <toolId> --at <uuid>` 로 대상을 지정한다. `--at <uuid>`
와 `--at=<uuid>` 두 형태를 지원한다. `dmctl` 의 `-l` 단축(`dmctl.go:213`)은 **제공하지
않는다** — `detach` 에서 `-l` 은 이미 `--list` 이고(`detach.go:35`), 기존 사용을 깨뜨릴
수 없다. `--at` 은 `--restore` 와 함께만 유효하며, 단독으로 오면 거부한다.

**FR-BGR-4** `--at` 없는 기존 호출 형태 `detach --restore <toolId>` 는 동작이 변하지
않는다.

**FR-BGR-5** 복귀 대상 Pane 이 존재하지 않으면 복귀하지 않고 그 사실을 알린다. 백그라운드
상태를 해제한 뒤 실패해 도구가 어디에도 매이지 않는 상태가 되어서는 안 된다.

**FR-BGR-6** 서버(`internal/server`)와 `dmctl` 은 변경하지 않는다. `restoreTool` 은 이미
action 화이트리스트에 있고 `location` 변환은 action 무관하게 동작한다.

**FR-BGR-7** (개정, 트랙 4 0-A) FR-BGR-5 의 "복귀하지 않는다"는 **명시 대상**
(`location` 지정)에만 적용한다. `location` 미지정은 "대상을 정하지 않았다"는 뜻이므로
조용한 무효가 되어서는 안 되며, 다음 순서로 폴백한다.

1. 포커스 Pane
2. 활성 창의 첫 Pane
3. 아무 창의 첫 Pane
4. 창이 하나도 없으면 — `delWindow` 가 마지막 창을 지우고 `_mkWindow` 를 `await`
   하는 동안의 과도 상태뿐이다 — `RESTORE_PANE_WAIT_MS` 간격으로
   `RESTORE_PANE_WAIT_TRIES` 회까지 기다렸다 1~3 을 재시도한다

새 Pane·창을 만들지 않는다. 폴백이 모두 실패하면 FR-BGR-5 대로 백그라운드 목록에
남긴다 — 목록에 있으면 여전히 닿을 수 있다.

**비목표(D)**: `restoreTool` 을 MCP `workspace_command` 에 노출하지 않는다 — `toolId`
인자가 MCP 스키마에 없어 `location` 추가만으로는 호출 가능해지지 않으며, 이는 별개 결정이다.

### 3.5 묶음 E — 크로스 기기 창 포커스

`USER_CHECKLIST_FIXES_PLAN.md` §6.1 의 결정 E-1..E-7 이 해소되어 확정됐다.

#### 3.5.1 소유권 정책

**FR-XDF-1** 창 포커스 소유권의 권위는 **서버의 in-memory 상태**다. `workspace.json` 에
영속화하지 않으며, 서버 재시작 시 전원 해제된다 (E-1).

**FR-XDF-2** 획득 정책은 **last-focus-wins** 다 — 마지막으로 그 Window 를 포커스한
Client 가 소유자가 된다. 기기 종류·화면 크기를 구분하지 않는다 (E-7). 이는 현행
동일 브라우저 내 동작과 동일하며, 새 정책을 도입하지 않는다.

**FR-XDF-3** 한 Client 는 동시에 최대 하나의 Window 만 소유한다. 새 Window 를 획득하면
이전 소유는 해제된다 (현행 `_focusWindow` 규약 유지).

**FR-XDF-4** 소유권 상태를 읽는 곳은 둘이다 — PTY 리사이즈 권한 판정
(`_resizeCheck`, `app.js:1717`)과 dim 표시(`_applyFocusOverlay`, `app.js:1727`). 두
경로는 **동일한 상태**를 읽고, 별도 상태를 두지 않는다 (E-4).

#### 3.5.2 전파

**FR-XDF-5** 전파는 서버 브로드캐스트로 한다. `BroadcastChannel('dongminal-focus')`
(`app.js:1642`) 경로는 **제거한다** — 두 전파 경로가 같은 상태를 쓰지 않는다 (E-3).

**FR-XDF-6** 브로드캐스트 페이로드는 **소유권 전체 맵**(`{windowId: clientId}`)을 싣는다.
획득·해제를 각각의 증분 이벤트로 보내지 않는다. 근거: 전체 맵은 멱등이므로 자기 에코
필터가 불필요하고, 부분 상태·순서 의존이 생기지 않는다. Window 수는 소수이므로 페이로드
크기는 문제가 되지 않는다.

**FR-XDF-7** 소유권 조회 표면과 획득 표면을 제공한다. 조회는 읽기 전용이고, 획득은
`clientId` 와 `windowId` 를 받는다.

#### 3.5.3 구독 결선과 해제

**FR-XDF-8** SSE 구독은 `clientId` 를 실어 서버가 **구독↔Client 를 결선**할 수 있게 한다
(E-6). 현행 `handleCommandSSE`(`internal/server/commands.go:232`)의 구독(`cmdSub`)에는
신원이 없고 `EventSource('/api/commands/sse')`(`app.js:180`)도 `clientId` 를 보내지 않으므로,
이 결선이 FR-XDF-9 의 선행 조건이다.

**FR-XDF-9** SSE 구독이 끊기면 서버는 그 Client 가 소유한 Window 를 **즉시** 해제하고
전파한다. grace period 를 두지 않는다 (E-2). `beforeunload` 의존(`app.js:1660`)은
제거한다 — 원격 기기 강제 종료·네트워크 단절에서 발화하지 않는다.

**FR-XDF-10** 같은 `clientId` 의 **더 새로운 구독이 존재하는 상태**에서 옛 구독의 종료가
감지되면 해제하지 않는다. 재연결 경합에서 최신 구독이 우선한다 — 이 보호가 없으면
새 구독의 획득이 옛 구독의 지연된 해제에 덮인다.

#### 3.5.4 재연결

**FR-XDF-11** SSE 연결 수립 시 Client 는 소유권 스냅샷을 조회해 로컬 상태를 서버 상태로
맞춘다. `_attnRestore`(`app.js:710`) · `_activityRestore`(`app.js:798`)와 동일한 패턴이다.

**FR-XDF-12** SSE 연결 수립 시 Client 가 **OS 포커스를 갖고 있으면** 활성 Window 의
소유권을 **재획득**한다. 근거: FR-XDF-9 로 서버가 해제한 뒤에도 Client 의
`_windowFocusOwner` 는 자신을 소유자로 기억하므로, 현행 `_focusWindow`
(`app.js:1697`)의 "소유권이 실제로 바뀔 때만 전파" 조건에 걸려 **영구히 재획득하지
않는다.** 즉시 해제(FR-XDF-9)를 택한 전제가 이 재획득이다.

**FR-XDF-13** OS 포커스가 없는 Client 는 재연결 시 소유권을 주장하지 않는다. 백그라운드로
내려간 기기가 소유권을 되찾아 활성 기기의 PTY 크기를 빼앗아서는 안 된다.

**FR-XDF-14** 자신이 소유자로 기록된 브로드캐스트를 수신해도 상태가 변하지 않는다 (멱등).

#### 3.5.5 비목표 (E)

1. **README TODO "focused browser 자동 동기화"(마지막 이벤트 기준)** — 뿌리는 같으나
   별건이다 (E-5, 최소 구현 원칙)
2. **명시적 소유권 인수 UI** — FR-XDF-2 가 자동 획득이므로 인수 표면이 필요 없다
3. **삭제된 Window 의 소유권 항목 청소** — 항목은 유한하고 아무것도 참조하지 않는다

### 3.6 묶음 F — 모바일 키보드 뷰포트

`USER_CHECKLIST_FIXES_PLAN.md` §6.2 의 결정 F-1..F-6 이 해소되어 확정됐다.
**F-1 은 권장안(높이 권위 전면 이전)을 채택하지 않았다** — §2.8b 의 실측이 그 전제를
반증했다. 근거는 PLAN §6.2 에 있다.

#### 3.6.1 대상 브라우저

**FR-MKV-1** 대상은 iOS Safari · Android Chrome · Samsung Internet 세 엔진이다 (F-6).
세 엔진 모두 키보드 표출 시 layout viewport 를 줄이지 않으므로(§2.8a) **동일한 결손을
공유한다.** 복구 수단만 둘로 갈린다 — Chromium 계열은 선언으로, WebKit 은 JS 로.

#### 3.6.2 Chromium·Firefox 경로 (선언)

**FR-MKV-2** viewport meta 에 `interactive-widget=resizes-content` 를 선언한다
(`index.html:5`, F-3). 그러면 Chromium ≥108 · Firefox ≥132 는 layout viewport 까지
줄이므로 `html,body{height:100%}` 사슬이 그대로 옳아진다.

**FR-MKV-3** 그 환경에서 JS 보정 경로는 **스스로 비활성**이어야 한다. `innerHeight` 가
키보드만큼 줄어 `kbH = innerHeight - vv.height - vv.offsetTop ≈ 0` 이 되고 `isUp` 이
거짓이 되므로, 별도 분기를 두지 않는다. 엔진 판별(UA 스니핑)을 하지 않는다.

#### 3.6.3 WebKit 경로 (JS 보정)

**FR-MKV-4** 키보드 표출 상태에서 body 의 `padding-top` 은 `vv.offsetTop` 이어야 한다.
이것이 §2.8c 의 유일한 결손을 메운다. 키보드 미표출 시에는 선언하지 않는다(CSS 기본값
복원).

**FR-MKV-5** `padding-bottom` 계산은 **바꾸지 않는다** — `kbH + <키바 높이>` 그대로다.
`padding-top` 을 더해도 키바의 `bottom: kbH` 계산과 어긋나지 않는다: body 는
`box-sizing:border-box` + `height:100%` 이므로 content box 는
`[offsetTop, innerHeight - kbH - 키바높이]` 가 되고, 키바(fixed)는
`[innerHeight - kbH - 키바높이, innerHeight - kbH]` 에 남아 정확히 맞물린다 (§2.8c).

**FR-MKV-6** `vv.offsetTop` 은 `resize` 뿐 아니라 `scroll` 에서도 추적한다 (현행
리스너 2종 유지). 사용자가 visual viewport 를 직접 스크롤해도 앱이 가시 영역에 고정된다.

**FR-MKV-7** `window.scrollTo` 로 스크롤을 되돌리지 않는다 (F-2). 문서가
`overflow:hidden` 이라 되돌릴 스크롤이 없고, visual viewport 의 스크롤은 그 API 의
대상이 아니다. **관측 후 보정**만 한다.

#### 3.6.4 줄어드는 대상

**FR-MKV-8** 키보드 표출 시 줄어드는 것은 **터미널 영역(`#area`)뿐**이다 (F-4).
`#topbar`(32px)·`.status-bar`(22px)·키바는 높이를 유지한다. 요구 원문("터미널 창만
줄어들면 좋겠다") 그대로이며, `#area{flex:1}`(`style.css:100`) 구조상 이미 그렇게 된다 —
새 규칙을 넣지 않는다.

**FR-MKV-9** `#area` 축소 후 활성 터미널은 `doFit()` 으로 cols/rows 를 재계산한다
(현행 `app.js:2041` 유지). 이것이 요구 원문의 "탭이 줄어드는걸 감지하지 못하는 것
같음"에 대응한다 — 감지는 이미 동작하고 있었고, 보이지 않은 원인은 §2.8c 의 스크롤이었다.

#### 3.6.5 검증

**FR-MKV-10** 자동 검증은 `vv.height` 와 **`vv.offsetTop` 을 함께** 시뮬레이션해야
한다. `offsetTop` 을 0 으로 고정하는 시뮬은 이 결손을 원리적으로 관측할 수 없다
(§2.8d). 기존 `TC-A1`~`TC-A4` 는 **재작성** 대상이다 — `resizes-content` 선언 이후
그 시뮬은 실재 엔진 거동과 대응하지 않는다.

**FR-MKV-11** iOS 실기기 수동 검증이 필수다 (F-5). Chromium 에뮬레이션으로 WebKit 의
키보드 스크롤 거동을 재현할 수 없고, Playwright 의 `webkit` 프로젝트도 가상 키보드를
띄우지 않으므로 대체가 되지 않는다. `docs/internal/test-checklist.md` 에 항목을 둔다.

#### 3.6.6 비목표 (F)

1. **키보드 표출 시 상태바·topbar 숨김** — 요구 원문은 "터미널 창만 줄어들면 좋겠다"다
   (F-4). 별건
2. **높이 권위를 `--vvh` 로 전면 이전** — §2.8b 가 전제를 반증했다. `height:100%` 는
   데스크톱과 `resizes-content` 환경에서 옳고, WebKit 결손은 `padding-top` 하나로 메워진다.
   불필요한 데스크톱 리스크를 지지 않는다
3. **UA 기반 엔진 분기** — FR-MKV-3 이 계산으로 자동 비활성되므로 필요 없다
4. **VirtualKeyboard API**(`navigator.virtualKeyboard`) — Chromium 전용이라 WebKit 결손을
   해결하지 못하고, `resizes-content` 와 역할이 겹친다

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
| TC-BGR-5 | FR-BGR-3 | `--at=<uuid>` 형태 | 동작한다 |
| TC-BGR-5b | FR-BGR-3 | `detach -l` | 기존대로 목록을 출력한다 (`--at` 의 단축이 아니다) |
| TC-BGR-5c | FR-BGR-3 | `detach --at <uuid>` (`--restore` 없이) | 거부. rc≠0 |
| TC-BGR-6 | FR-BGR-5 | 존재하지 않는 uuid 지정 | 복귀 미수행. 도구가 백그라운드 목록에 그대로 남는다 |
| TC-BGR-7 | FR-BGR-6 | `internal/server` 기존 테스트 | 전량 통과 (무변경 확인) |
| TC-BGR-6b | FR-BGR-5 | 명시 대상이 브라우저 시점에 사라진 경쟁 상황 | 복귀 미수행. 백그라운드 유지 (폴백하지 않는다) |
| TC-BGR-8 | FR-BGR-7 | `location` 미지정 + `app.focused` 가 해소되지 않음 | 활성 창의 Pane 에 복귀 |
| TC-BGR-9 | FR-BGR-7 | `location` 미지정 + `ws.windows` 가 빈 과도 상태 | 기다렸다 복귀 |

### 4.5 묶음 E — 크로스 기기 창 포커스

**크로스 기기 프록시**: Playwright `browser.newContext()` 는 `BroadcastChannel` 스코프와
`clientId`(`app.js:8`, 페이지 로드마다 `crypto.randomUUID()`)가 모두 격리되므로 다른
기기와 동등하다. `e2e/sync.spec.ts` 가 이미 쓰는 패턴이다.

**RED 전제**: TC-XDF-1 은 현행 코드에서 **실패해야 한다.** 두 컨텍스트 사이에서
`BroadcastChannel` 이 전달되지 않으므로 dim 이 적용되지 않는다 — 이것이 §2.7 의 증상이다.

| TC | FR | 절차 | 기대 |
|---|---|---|---|
| TC-XDF-1 | FR-XDF-5, FR-XDF-6 | 컨텍스트 A·B 로 접속. A 가 Window1 을 포커스 | B 에서 Window1 의 Pane 에 `pn-dimmed` 적용 |
| TC-XDF-2 | FR-XDF-2 | 이어서 B 가 같은 Window 를 포커스 | A 가 dim, B 는 밝음 (last-focus-wins) |
| TC-XDF-3 | FR-XDF-3 | A 가 Window1 소유 후 Window2 를 포커스 | Window1 소유가 해제된다 (한 Client 는 한 Window) |
| TC-XDF-4 | FR-XDF-7 | 소유 상태에서 소유권 조회 | 스냅샷이 `{Window1: A의 clientId}` 를 반영 |
| TC-XDF-5 | FR-XDF-9 | A 의 컨텍스트를 닫음 | B 의 dim 이 벗겨진다. grace 대기 없이 |
| TC-XDF-6 | FR-XDF-11 | A 소유 상태에서 컨텍스트 C 를 새로 접속 | C 가 접속 직후 dim 을 본다 (늦은 참여 복원) |
| TC-XDF-7 | FR-XDF-12 | A 에서 SSE 를 강제 종료(`_cmdES.close()`) 후 재연결 대기 | 재연결 후 소유권 스냅샷에 A 가 **다시** 소유자로 있다 |
| TC-XDF-8 | FR-XDF-13 | OS 포커스 없는 상태(`blur`)에서 SSE 재연결 | 소유권을 주장하지 않는다 |
| TC-XDF-9 | FR-XDF-5 | 브라우저에서 포커스 채널 객체 존재 확인 | `BroadcastChannel` 경로가 없다 |
| TC-XDF-10 | FR-XDF-4 | B 가 A 소유 Window 의 도구에 대해 `_resizeCheck` 호출 | `false` — dim 과 리사이즈 권한이 같은 상태를 읽는다 |
| TC-XDF-11 | FR-XDF-10 | 서버 유닛 — 같은 `clientId` 로 구독 2개를 연 뒤 **먼저 연 것**을 닫는다 | 소유권이 유지된다 (최신 구독 우선) |
| TC-XDF-12 | FR-XDF-9 | 서버 유닛 — 구독 종료 | 소유권 해제 + 전체 맵 브로드캐스트 |
| TC-XDF-13 | FR-XDF-14 | 자신이 소유자인 브로드캐스트 수신 | 상태 무변화 (멱등) |

### 4.6 묶음 F — 모바일 키보드 뷰포트

**시뮬레이션 규약**: `vv.height` 와 `vv.offsetTop` 을 **함께** 스텁한다 (FR-MKV-10).
`innerHeight` 는 건드리지 않는다 — layout viewport 가 줄지 않는 것이 WebKit 재현의
핵심이다 (TC-MKV-10 만 예외로 `innerHeight` 를 함께 줄여 Chromium 경로를 재현한다).

기준 수치는 e2e 의 `MOBILE_VIEWPORT`(**375×667**) · 키보드 300px · 스크롤 120px 이다.
그때:

```
vv.height = 367        가시 영역 = [120, 487]
kbH       = 667-367-120 = 180
padTop    = 120        padBottom = 180+38 = 218
#app      = [120, 449]  키바 = [449, 487]      → 틈도 겹침도 없다
```

(§2.8 의 실측은 390×780 프로브 기준이다. 비율은 같고 수치만 다르다.)

**RED 전제**: TC-MKV-1 은 현행 코드에서 실패해야 한다 — `padding-top` 이 `0px` 이다.

| TC | FR | 절차 | 기대 |
|---|---|---|---|
| TC-MKV-1 | FR-MKV-4 | `height-=300`, `offsetTop=120` 시뮬 | `body` 의 `padding-top` = `120px` |
| TC-MKV-2 | FR-MKV-4 | 이어서 `offsetTop=0` 으로 되돌림 | `padding-top` = `0px` |
| TC-MKV-3 | FR-MKV-4 | 키보드 해제 (`height` 복원) | `padding-top` = `0px`, `padding-bottom` = 키바 높이 |
| TC-MKV-4 | FR-MKV-5 | `offsetTop=120` 시뮬 | `padding-bottom` = `kbH + 키바높이` = `218px`. `offsetTop` 이 이 값을 바꾸지 않는다 |
| TC-MKV-5 | FR-MKV-4 | `offsetTop=120` 시뮬 | `#topbar` 가 가시 영역 안에 있다 — `top ≥ vv.offsetTop` |
| TC-MKV-6 | FR-MKV-5 | `offsetTop=120` 시뮬 | 키바 상단이 `#app` 하단과 맞물린다 (틈·겹침 0). 키바가 가시 영역 하단에 닿는다 |
| TC-MKV-7 | FR-MKV-8 | `offsetTop=120` 시뮬 | `#topbar`·`.status-bar` 높이 무변화(32/22). `#area` 만 줄어든다 |
| TC-MKV-8 | FR-MKV-6 | `resize` 없이 `scroll` 이벤트만 발화 | `padding-top` 이 새 `offsetTop` 을 따라간다 |
| TC-MKV-9 | FR-MKV-2 | viewport meta 파싱 | `interactive-widget=resizes-content` 를 포함한다. 기존 `viewport-fit=cover` 도 유지 |
| TC-MKV-10 | FR-MKV-3 | `innerHeight` 가 함께 줄어든 상태(resizes-content 환경 재현: `height-=300`, `innerHeight-=300`, `offsetTop=0`) | `keyboard-up` 이 붙지 않고 `padding-top`·`padding-bottom` 인라인 값이 없다 — JS 경로가 비활성 |
| TC-MKV-11 | FR-MKV-9 | `offsetTop=120` 시뮬 후 | 활성 터미널의 `rows` 가 축소 전보다 작다 |
| TC-MKV-12 | 회귀 | 데스크톱 모드 | `padding-top`·`padding-bottom` 인라인 값이 없다. `#app` 높이 = `innerHeight` |

**수동 검증 (iOS 실기기, FR-MKV-11)**: `docs/internal/test-checklist.md`.
자동화로 대체할 수 없는 것 — 실제 WebKit 의 스크롤 타이밍, 그리고 보정 후 Safari 가
다시 스크롤해 진동하지 않는지. 보정은 포커스된 textarea 를 가시 영역 안에 두므로
Safari 가 재스크롤할 이유가 없다는 것이 설계 근거이지만(§2.8c), **이것만은 실기기로만
확인된다.** 진동이 관측되면 `scroll` 리스너에서의 보정을 감쇠하는 것이 폴백이다.

### 4.7 회귀 검증 (전 묶음 공통)

| 대상 | 이유 |
|---|---|
| `e2e/mobile-keybar.spec.ts` TC-6 | 묶음 A 가 상태바 구조를 바꾼다 |
| `e2e/mobile-keybar.spec.ts` TC-D1/D2/T2/T3/T4 | 묶음 C 가 같은 핸들러를 재작성한다 |
| `e2e/mobile-keybar.spec.ts` TC-A1..A4 | 묶음 F 가 **재작성**한다 — `offsetTop=0` 고정 시뮬은 실재 엔진 거동과 대응하지 않는다 (§2.8d) |
| `internal/migrate` 유닛 | 묶음 B — 구 어휘가 입력이므로 일괄 치환 금지 |
| `e2e/sync.spec.ts` | 묶음 E 가 SSE 구독 URL 에 `clientId` 를 추가한다 |
| `internal/server` 유닛 (`commands_test.go`) | 묶음 E 가 `handleCommandSSE` 를 바꾼다 |
| `go test ./...` 전량 | 묶음 B·D·E |

**정정**: 본 SRS 초판은 `e2e/focus.spec.ts` · `focus-invariant.spec.ts` ·
`regression-focus.spec.ts` 를 묶음 E 의 회귀 주의 대상으로 적었다. **사실이 아니다** —
세 스펙은 `s.focusedPane` 불변식(어느 Pane 이 활성인가)만 검증하고 `_windowFocusOwner`
(어느 Client 가 그 Window 를 보는가)는 참조하지 않는다. 두 상태는 이름만 비슷하고
서로 무관하다. 따라서 **소유권 경로에는 기존 테스트가 없고**, TC-XDF-* 가 유일한
안전망이다.

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
| C | 키바 `touchstart` | `e.preventDefault()` (passive:false) | preventDefault 제거 (passive:true) | 규격상 합성 마우스 이벤트 생성을 취소한다. 키 전송이 `click` 리스너에 있었으므로 실기기에서 짧은 탭이 무반응이었고, 같은 호출이 스크롤도 취소해 슬라이드가 불가했다 |
| C | 키 전송 시점 | `click` 전용 | `touchend`(짧은 탭) + `click`(마우스 폴백) | 터치 경로에서 즉각 반응하고, 마우스 경로는 그대로 유지한다 |
| C | 중복 발동 방지 | (없음 — 이중 발동 가능) | `touchend` 후 700ms 내 `click` 무시 (`MKB_GHOST_CLICK_MS`) | 플래그 방식은 `preventDefault` 로 click 이 오지 않으면 플래그가 남아 다음 마우스 클릭을 먹는다. 시간 기준은 그 잔존이 없다 |
| C | 롱프레스 취소 판정 | `touchmove` 발생 즉시 취소 | 이동 거리 임계값 10px 초과 시 취소 (`MKB_TAP_SLOP_PX`) | 손떨림에도 롱프레스가 죽었고, 스크롤과 공존할 수 없었다 |
| C | 검증 범위 | Desktop Chrome 단일 프로젝트(`hasTouch:false`) | `mobile-touch` 프로젝트(Pixel 7, `hasTouch:true`) 신설 | 마우스 경로만으로는 이 결함을 한 번도 볼 수 없었다. 분리 없이는 재발한다 |
| D | `restoreTool` 대상 | 항상 브라우저의 현재 포커스 Pane (`this.focused` 하드코딩) | `args.location` 지정 시 그 탭이 속한 Pane, 미지정 시 기존대로 | 워크스페이스 조작 명령 중 대상 지정 수단이 없는 유일한 명령이었다. 서버(`translateLocationUUID`)는 이미 action 무관하게 변환하고 있었다 |
| D | `detach` 인자 파싱 | 첫 플래그에서 즉시 반환 | 플래그를 모두 모은 뒤 해석 | `--at` 이 `--restore` 앞에 와도 같은 결과여야 한다 |
| D | `_restoreTool` 시그니처 | `(toolId)` | `(toolId, opts={})` | 대상 Pane 주입. `opts` 기본값으로 기존 호출부(모달 항목 클릭) 무변경 |
| D | `location` 미지정 복귀 대상 (트랙 4 0-A) | 포커스 Pane 이 해소되지 않으면 조용히 무효 — `delivered=1`·`ok=true` 를 반환하고 아무 일도 하지 않았다 | 포커스 → 활성 창 첫 Pane → 아무 창 첫 Pane → (창이 비면) 대기 후 재시도 (FR-BGR-7) | `delWindow` 가 마지막 창을 지우고 `_mkWindow` 를 `await` 하는 동안 `ws.windows` 가 비어 `_aw()` 가 null 이 된다 (실측 확인). 명시 대상은 폴백하지 않는다 — 지목이 사라졌으면 실패가 옳다 |
| D | 모달 행 식별자 | (없음) | `data-toolid` | `.pn-tab[data-toolid]` 과 같은 관행. 여러 백그라운드 도구 중 특정 행을 DOM 으로 지목할 수 있다 |
| E | 소유권 전파 경로 | `BroadcastChannel('dongminal-focus')` — 동일 브라우저·동일 origin 한정 | `POST /api/focus/claim` → SSE `window_focus` | 다른 기기와 원리적으로 통신 불가였고, `--expose` 시 `localhost:PORT` 와 `<host-ip>:PORT` 는 origin 이 달라 같은 컴퓨터의 두 탭도 격리됐다 (§2.7) |
| E | 소유권 권위 | 각 브라우저의 로컬 `_windowFocusOwner` (합의 없음) | 서버 in-memory (`FocusRegistry`) | 권위가 없으면 기기마다 다른 소유자를 믿는다. 영속화하지 않는 이유는 클라이언트 소유권이 휘발성이기 때문이다 — 서버 재시작 시 전원 해제가 안전하다 |
| E | 전파 페이로드 | 증분 이벤트 2종 (`windowFocus` / `windowRelease`) | 소유권 **전체 맵** 1종 (`window_focus`) | 전체 맵은 멱등이라 자기 에코 필터(`clientId` 비교)가 불필요하고, 부분 상태·순서 의존이 생기지 않는다. Window 수는 소수다 |
| E | **PTY 리사이즈 게이팅** | 사실상 무효 — 원격 기기의 `_windowFocusOwner` 에는 자기 자신만 있어 `_resizeCheck` 가 항상 `true` 였다. **모든 기기가 각자 리사이즈하고 마지막 것이 이겼다** | 소유자 하나만 리사이즈를 보낸다 | 묶음 E 는 동기화 결손을 고치는 데 그치지 않고, 여태 발현되지 않았던 리사이즈 권한 게이팅을 **처음으로 켠다**. 이것이 리스크 HIGH 의 실체다 |
| E | 획득 정책 | last-focus-wins (동일 브라우저 내에서만 발현) | last-focus-wins (기기 간에도 발현) | 정책은 바꾸지 않았다. 사용자 판단: 같은 Window 를 보는 두 기기 중 한쪽 렌더는 필연적으로 깨지므로 마지막 접근자가 갖는 것이 맞고, 비소유 측은 dim 으로 드러난다 (PLAN E-7) |
| E | 소유권 해제 | `beforeunload` 에서 브라우저가 스스로 해제 | 서버가 SSE 구독 해제 시 즉시 해제 | `beforeunload` 는 원격 기기 강제 종료·네트워크 단절에서 발화하지 않아 소유권이 영구히 남았다. 재연결 경합은 `clientId` 별 epoch 로 막는다 — 옛 구독의 지연된 teardown 이 새 구독의 획득을 덮지 않는다 |
| E | 재연결 시 소유권 | (해당 없음 — 서버 상태가 없었다) | SSE `onopen` 에서 스냅샷 정렬 + OS 포커스 시 재획득 | 즉시 해제를 택한 전제다. 재획득이 없으면 `_focusWindow` 의 "소유권이 실제로 바뀔 때만 전파" 조건에 걸려 **영구히 재획득하지 못한다.** OS 포커스가 없는 기기는 주장하지 않는다 — 백그라운드 기기가 활성 기기의 PTY 크기를 빼앗아서는 안 된다 |
| E | `_initFocusChannel` | BroadcastChannel 생성 + OS 포커스 리스너 + `beforeunload` | `_initFocusSync` — OS 포커스 리스너만 | 채널이 없어졌으므로 이름의 "Channel" 이 사실과 어긋난다. 전파는 `_focusClaim`(송신)과 `window_focus` SSE 분기(수신)로 분리했다 |
| E | SSE 구독 URL | `/api/commands/sse` | `/api/commands/sse?clientId=<id>` | `cmdSub` 에 신원이 없어 구독 해제와 소유권 해제를 이을 수 없었다. 쿼리 파라미터는 기존 payload 규약과 `CommandBroker` 인터페이스를 건드리지 않는다. `clientId` 없는 구독도 그대로 동작한다 (소유권 결선만 없음) |
| F | viewport meta | `width=device-width, initial-scale=1.0, viewport-fit=cover` | `interactive-widget=resizes-content` 추가 | Chrome 108 이 기본값을 `resizes-visual` 로 바꿔 Android Chrome·Samsung Internet 도 layout viewport 를 줄이지 않게 됐다. 이 선언으로 Chromium·Firefox 는 layout viewport 까지 줄이므로 `height:100%` 사슬이 그대로 옳아지고, `innerHeight` 가 함께 줄어 JS 보정이 스스로 비활성된다 (UA 스니핑 불필요) |
| F | 키보드 표출 시 `body` padding | `padding-bottom` 만 (`kbH + 키바높이`) | `padding-top = vv.offsetTop` 추가. `padding-bottom` 은 무변경 | WebKit 은 포커스된 요소를 드러내려 visual viewport 를 스크롤하는데(`vv.offsetTop > 0`) 아무도 상쇄하지 않아 `#topbar` 전체가 가시 영역 밖으로 밀렸다. 실측: 가시 영역 `[120,600]` 인데 `#app` 이 `[0,562]` 였다 (§2.8c) |
| F | 높이 권위 | `html,body{height:100%}` | **무변경** | 초판 계획은 `--vvh` 전면 이전이었으나 §2.8b 의 측정이 전제를 반증했다 — `#area` 는 이미 688→388px 로 줄고 있었다. 교체는 데스크톱 경로까지 위험에 넣으면서 아무것도 더 고치지 못한다. `web/style.css` 는 한 줄도 바꾸지 않았다 |
| F | 키보드 시뮬 e2e | `TC-A1`~`TC-A4` — `vv.height` 만 스텁, `offsetTop` 은 0 고정 | `TC-MKV-1..12` — `vv.height`·`vv.offsetTop` 을 함께 스텁 | `offsetTop=0` 고정 시뮬은 이 결손을 원리적으로 관측할 수 없었다(함정 7 과 같은 구조). 게다가 `resizes-content` 선언 이후 그 시뮬은 실재하는 어떤 엔진 거동과도 대응하지 않는다 — 동반 개정이 아니라 재작성이 필요했다 (§2.8d) |

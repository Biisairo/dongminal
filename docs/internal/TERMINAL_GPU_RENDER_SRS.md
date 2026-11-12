# SRS: 터미널 GPU 렌더링 — IEEE 29148

> **문서 상태**: 승인·구현완료

## 1. 개요

### 1.1 목적

터미널은 지금 xterm.js 의 **DOM 렌더러**로 그린다. `web/vendor/` 에 WebGL·Canvas
addon 이 없기 때문이다. DOM 렌더러는 xterm 의 렌더러 중 가장 느리다. 대량 출력과
빠른 스크롤에서 프레임이 떨어진다.

이 문서는 화면에 보이는 터미널을 `@xterm/addon-webgl` 로 그리게 한다. WebGL 을 쓸
수 없거나 사용자가 끄면 DOM 렌더러로 돌아간다.

### 1.2 범위

| 포함 | 제외 (비목표) |
|---|---|
| WebGL addon vendor 추가와 판 기록 | 네이티브 선택 오버레이 (별도 SRS) |
| 보이는 칸에만 붙이고 숨으면 떼는 수명 규칙 | xterm 6 으로 올리기 |
| 컨텍스트 손실과 미지원 환경의 DOM 복귀 | Canvas addon |
| 기기별 설정 `termGpu` (기본 켬) | 글리프 아틀라스·폰트 렌더 튜닝 |
| 진단(`diag.js`)에 렌더러 표시 | 서버 측 변경 |
| e2e 기본 렌더러 고정과 WebGL 전용 e2e | |

### 1.3 정의

| 용어 | 뜻 |
|---|---|
| **DOM 렌더러** | xterm 기본 렌더러. 행마다 `.xterm-rows > div` 에 `<span>` 을 둔다 |
| **WebGL 렌더러** | `WebglAddon` 을 `loadAddon` 하면 켜진다. 글자를 `<canvas>` 에 GPU 로 그린다. addon 을 `dispose` 하면 xterm 이 DOM 렌더러로 돌아간다 |
| **보이는 칸** | `TerminalTool.el` 이 `vis` 클래스를 가진 칸 (`renderer-pane.js:99`, `renderer-layout.js:130`) |
| **컨텍스트 손실** | 브라우저가 WebGL 컨텍스트를 회수하는 것. 컨텍스트 수 한도(Chrome 약 16개)를 넘거나 GPU 가 재설정되면 일어난다. addon 은 `onContextLoss` 로 알린다 |
| **GPU 사용 불가** | 이 페이지 수명 동안 WebGL 을 다시 시도하지 않는 상태 |

### 1.4 참고

- `docs/internal/VENDOR_VERSIONS.md` — vendor 판과 해시 (`scripts/check-vendor.sh` 가 지킨다)
- `web/js/core/pref-store.js` — 기기별 저장소 `PrefStore.local`
- `web/js/ui/renderer-layout.js` `_afterLayout` — 프레임 뒤처리 지점

---

## 2. 현황

### 2.1 렌더러

- `web/vendor/xterm.js` 는 5.5 계열이다 (`VENDOR_VERSIONS.md` ①).
- `index.html` 은 `addon-fit`·`addon-web-links`·`addon-unicode11`·`addon-search` 만 싣는다.
- 그래서 모든 터미널이 DOM 렌더러다.

### 2.2 칸의 보임과 숨음

- `_rWindowInto` 계열이 붙인 칸에 `vis` 를 단다 (`renderer-pane.js:99`).
- `_gcWidgets` 가 이번 그리기에 붙지 못한 칸의 `vis` 를 뗀다 (`renderer-layout.js:130`).
- `_afterLayout` 은 다음 프레임에 모든 도구를 돌며 `vis` 인 칸을 `open()`·`doFit()` 한다
  (`renderer-layout.js:140-148`). **보임 상태를 한 번에 볼 수 있는 유일한 자리다.**

### 2.3 DOM 렌더러에 기댄 곳

| 자리 | 기대는 것 | WebGL 에서 |
|---|---|---|
| e2e 24곳 (11 파일), `fixtures.ts:750` `waitShellReady` | `.xterm-rows` 의 텍스트 | 비어 있다 → **실패한다** |
| `term-touch.js:165` `_rowHeight` | `_core._renderService.dimensions` | 렌더러와 상관없이 값이 있다 |
| `term-pane.js:156` | `.xterm-helper-textarea` | 그대로 있다 |
| 앱 CSS | `.xterm-viewport`·`.xterm-screen` | 그대로 있다. `.xterm-rows` 를 꾸미는 앱 CSS 는 없다 |

---

## 3. 결정

| ID | 결정 | 이유 |
|---|---|---|
| D-TGR-1 | **보이는 칸에만** WebGL 을 붙이고, 숨으면 뗀다 | 탭 수와 상관없이 컨텍스트 한도를 넘지 않는다. 비용은 탭 전환 첫 프레임의 붙이기 시간이다 |
| D-TGR-2 | 끄는 설정을 두고 **기본은 켬** | 일부 GPU·드라이버·원격 데스크톱에서 글자가 흐리거나 깨질 수 있다. 사용자가 직접 끌 수 있어야 한다 |
| D-TGR-3 | 설정은 **기기별**(`PrefStore.local`) | GPU 문제는 기기의 것이다. 한 기기에서 끈 값이 다른 기기로 번지면 안 된다. 서버 스키마는 바꾸지 않는다 |
| D-TGR-4 | addon 판은 `@xterm/addon-webgl` **0.18.0** | xterm 5.5 와 같은 시기의 판이다. 0.19 이후는 xterm 6 용이다 |
| D-TGR-5 | e2e 는 기본으로 GPU 를 끈다. WebGL 경로는 전용 e2e 가 본다 | 기존 e2e 24곳이 `.xterm-rows` 텍스트를 읽는다. 전부 버퍼 읽기로 바꾸는 것은 이 SRS 의 범위를 넘는다 |
| D-TGR-7 | 조합 이모지가 갈라지는 한계(§9.2)를 **받아들인다** | 사용자 확인: 쓰는 중에 알아채지 못했던 차이다. 대안(기본 끔)은 성능 이득 전부를 버린다 |
| D-TGR-8 | WebGL 의 셀 폭 차이(§9.2, Retina 에서 약 5% 촘촘)를 **보정하지 않는다** | 글꼴 크기는 같고 가로 간격만 다르다. WebGL 은 정수 기기 픽셀 격자를 쓴다(VS Code 터미널과 같다). 데스크톱은 늘 WebGL 이라 두 모양을 나란히 볼 일이 드물다. `letterSpacing` 반올림 보정은 검토 후 사용자가 기각했다 |
| D-TGR-6 | **터치 기기는 제외**한다. 판정은 `TerminalTool#_tsTouch()` 다 (모바일 레이아웃이거나 주 포인터가 coarse) | 터치 기기는 DOM 글자 위의 OS 네이티브 선택을 쓴다 (UX_BATCH11_SRS FR-TCP-7·8, `term-clip.js` `_wireNativeSelect`). WebGL 은 글자를 canvas 로 옮기므로 그 선택을 깨뜨린다. 같은 판정을 써야 두 기능의 경계가 어긋나지 않는다 |

---

## 4. 기능 요구사항

### 4.1 자산

**FR-TGR-1** `web/vendor/addon-webgl.js` 를 둔다. 원본은 `@xterm/addon-webgl@0.18.0`
패키지의 `lib/addon-webgl.js` 이며 바이트를 고치지 않는다.

**FR-TGR-2** `VENDOR_VERSIONS.md` 표에 그 파일의 라이선스(MIT)·판(0.18.0)·SHA-256 앞
16자·바이트 수를 적는다. `scripts/check-vendor.sh` 가 통과해야 한다.

**FR-TGR-3** `index.html` 은 `addon-webgl.js` 를 `xterm.js` 뒤, 앱 스크립트 앞에서 싣는다.

### 4.2 수명

**FR-TGR-4** 다음이 모두 참이면 그 칸에 WebGL addon 을 붙인다.

1. 칸이 보인다 (`vis`).
2. `term` 이 있다 (열린 칸).
3. 설정 `termGpu` 가 켜져 있다.
4. 전역 `WebglAddon` 이 있다.
5. GPU 사용 불가 상태가 아니다.
6. 터치 기기가 아니다 (D-TGR-6). 모바일 레이아웃으로 바뀌면 다음 동기화에서 뗀다.
7. 그 칸에 아직 붙어 있지 않다.

**FR-TGR-5** 칸이 보이지 않게 되면 붙은 addon 을 `dispose` 한다. 설정이 꺼질 때도
보이는 모든 칸의 addon 을 `dispose` 한다.

**FR-TGR-6** 동기화는 멱등이다. 같은 상태로 여러 번 불려도 붙이거나 떼는 일이 한 번만
일어난다.

**FR-TGR-7** 동기화 지점은 `_afterLayout` 의 프레임 콜백 한 자리다. 각 도구마다
`doFit()` **앞에서** 보임 여부를 넘겨 동기화한다. 렌더러가 바뀐 뒤 크기를 다시 재야
`cols`·`rows` 가 맞는다.

**FR-TGR-7a** `_afterLayout` 밖에서 렌더러가 바뀌는 두 경로도 바뀐 뒤 다시 잰다.

- 설정 스위치(`TermGpu.apply`): 보이는 칸마다 `syncGpu(true)` 뒤 `doFit()`.
- 컨텍스트 손실(FR-TGR-10): DOM 으로 돌린 뒤 `doFit()`.

두 렌더러의 칸 폭은 다르다 — DOM 은 소수 px(예: 8.43), WebGL 은 정수 px(예: 8)다. 다시 재지
않으면 같은 `cols` 가 칸의 일부만 덮거나 넘친다 (§7.3 실측: 170칸이 1433px ↔ 1360px).

**FR-TGR-8** 칸이 파괴되면 addon 참조를 버린다. (`term.dispose()` 가 실린 addon 을
함께 정리한다.)

### 4.3 실패

**FR-TGR-9** `new WebglAddon()` 이나 `loadAddon` 이 던지면:

- 그 칸은 DOM 렌더러로 남는다.
- 페이지 전체를 **GPU 사용 불가**로 둔다. 다른 칸도 다시 시도하지 않는다.
- `ErrorLog.push` 로 한 번 남긴다.

**FR-TGR-10** 컨텍스트를 잃으면 그 칸의 addon 을 `dispose` 하고 DOM 렌더러로
돌린다. 그 칸이 다음에 **숨었다가 다시 보이면** 다시 붙인다.

- 계기는 그 칸 캔버스의 `webglcontextlost` 이벤트다. 칸 요소에 캡처로 받아 **곧바로** 처리한다.
  addon 의 `onContextLoss` 는 복구를 3초 기다린 뒤에야 오고, 그동안 칸이 빈 채로 하얗게 남는다.
- `onContextLoss` 도 계기로 남긴다. 이미 처리한 손실은 다시 세지 않는다.
- 지금 붙은 addon 의 캔버스가 아닌 곳에서 온 이벤트는 무시한다.

> **개정 2026-11-12.** 이전 동작: `onContextLoss` 만 계기였다. 새 동작: 위와 같다. 이유: 실사용에서
> `webglcontextlost` → `webglcontextrestored` 가 반복됐고, 그 사이 최대 3초 동안 터미널이 하얗게 보였다
> (사용자 신고·콘솔 기록). 서버의 터미널 연결은 끊기지 않았다.

**FR-TGR-10a** addon 을 뗄 때(숨김·설정 끔·손실·칸 파괴) 그 캔버스의 WebGL 컨텍스트를
`WEBGL_lose_context` 로 곧바로 반납한다. 순서는 `dispose` 뒤다. addon 은 컨텍스트를 반납하지
않아 가비지 수거 전까지 남고, 탭을 바꿀 때마다 쌓이면 브라우저의 컨텍스트 상한(Chrome 약 16개)에
걸려 **보이는 칸의 컨텍스트가 회수될 수 있다** (개정 2026-11-12).

**FR-TGR-11** 페이지 수명 동안 컨텍스트 손실이 `TERM_GPU_LOSS_LIMIT`(3)회에 이르면
GPU 사용 불가로 둔다. 손실이 되풀이되는 환경에서 붙였다 떼기를 반복하지 않기 위해서다.

**FR-TGR-12** 실패는 터미널 동작을 막지 않는다. 입력·출력·검색·링크·선택은 렌더러와
상관없이 동작해야 한다.

### 4.4 설정

**FR-TGR-13** 키는 `STORE_KEYS.termGpu`(`'termGpu'`)이고 `PrefStore.local.bool(k, true)`
로 읽는다. 값이 없거나 모르는 값이면 켬이다.

**FR-TGR-14** Settings ▸ Terminal 에 스위치 `#ds-termgpu` 와 안내문을 둔다. 문구는
`html.term_gpu`·`html.term_gpu_hint` 키로 ko·en 카탈로그에 둔다.

**FR-TGR-15** 스위치를 바꾸면 **곧바로** 보이는 모든 칸에 적용한다. 새로고침을 요구하지
않는다. 끄면 GPU 사용 불가 상태는 그대로 둔다. 켜도 이미 불가가 된 페이지에서는 붙이지
않는다.

### 4.5 진단

**FR-TGR-16** `diag.js` 의 칸 정보에 `renderer=webgl|dom` 을 낸다. 페이지 정보에
`gpuUnavailable=true|false` 와 컨텍스트 손실 횟수를 낸다.

### 4.6 e2e

**FR-TGR-17** e2e fixture 는 모든 컨텍스트에서 첫 로드 전에 `termGpu` 를 `'0'` 으로 둔다
(`fixtures.ts` 의 전역 `addInitScript` 자리).

**FR-TGR-18** WebGL 전용 e2e 는 그 값을 `'1'` 로 두고 다음을 본다.

- 보이는 칸에 WebGL `<canvas>` 가 있다. (헤드리스에서 WebGL2 를 쓸 수 없으면 DOM 복귀를 본다.)
- 다른 탭으로 바꾸면 숨은 칸에서 canvas 가 사라진다.
- 설정을 끄면 보이는 칸의 canvas 가 사라지고 `.xterm-rows` 에 텍스트가 돌아온다.
- 어느 경우든 셸 입력과 출력이 왕복한다 (버퍼로 확인).

---

## 5. 비기능 요구사항

**NFR-TGR-1** 동시에 살아 있는 WebGL 컨텍스트 수는 보이는 터미널 칸 수를 넘지 않는다.

**NFR-TGR-2** 동기화는 프레임마다 도는 루프 안에 있으므로, 상태가 바뀌지 않은 칸에서는
DOM 조회·할당을 하지 않는다.

**NFR-TGR-3** 기존 단위 테스트·e2e·타입 검사·`check-vendor.sh`·`check-storage.mjs` 가
통과한다.

---

## 6. 설계

- 새 파일 `web/js/ui/term-gpu.js` 가 `TerminalTool.prototype` 에 얹는다. `term-touch.js`
  와 같은 증강 분할 방식이다. `index.html` 에서 `term-pane.js` 뒤에 싣는다.
- 페이지 상태(불가 여부·손실 횟수)는 그 파일의 `TermGpu` 객체 하나가 쥔다.
- 공개 동작은 둘이다.
  - `TerminalTool#syncGpu(visible)` — FR-TGR-4~7·10
  - `TermGpu.apply(app)` — 설정이 바뀌었을 때 보이는 칸 전부에 `syncGpu` (FR-TGR-15)
- 상수 `TERM_GPU_LOSS_LIMIT` 은 `constants.js` 에 둔다.

---

## 7. 검증

### 7.1 단위 테스트 (`web/js/test/term-gpu.test.mjs`, xterm·addon 흉내)

| ID | 상황 | 기대 |
|---|---|---|
| TC-TGR-1 | 보임 + 켬 | `loadAddon` 1회, 렌더러 webgl |
| TC-TGR-2 | 같은 상태로 3회 동기화 | `loadAddon` 1회 (멱등) |
| TC-TGR-3 | 붙은 칸이 숨음 | addon `dispose` 1회, 참조 null |
| TC-TGR-4 | 설정 끔 | 붙이지 않음. 붙어 있던 칸은 `dispose` |
| TC-TGR-5 | 전역 `WebglAddon` 없음 | 붙이지 않음, 던지지 않음 |
| TC-TGR-6 | 생성자가 던짐 | 그 칸 DOM, 페이지 불가, 다른 칸도 시도하지 않음, ErrorLog 1회 |
| TC-TGR-7 | 컨텍스트 손실 | `dispose`, 계속 보이는 동안 다시 붙이지 않음, 숨었다 보이면 다시 붙임 |
| TC-TGR-8 | 손실 3회 | 페이지 불가, 이후 붙이지 않음 |
| TC-TGR-9 | `term` 없음 | 아무 일도 없음 |
| TC-TGR-10 | 칸 파괴 | 참조 null, 이후 동기화가 던지지 않음 |
| TC-TGR-11 | `PrefStore` 값 없음 / `'0'` / 깨진 값 | 켬 / 끔 / 켬 |
| TC-TGR-12 | `_afterLayout` 순서 | 칸마다 `syncGpu` 가 `doFit` 보다 먼저 불림 |
| TC-TGR-14 | 설정 스위치로 켜고 끔 | 보이는 칸만 `doFit` 이 바뀔 때마다 1회, 숨은 칸은 0회 |
| TC-TGR-15 | 컨텍스트 손실 | `doFit` 1회 |
| TC-TGR-16 | 그 칸 캔버스의 `webglcontextlost` | 곧바로 DOM·`doFit` 1회·손실 1회. 뒤늦은 `onContextLoss` 는 다시 세지 않음. 다른 캔버스의 이벤트는 무시 (FR-TGR-10 개정) |
| TC-TGR-17 | addon 을 뗌 | `dispose` 뒤 그 캔버스 컨텍스트의 `loseContext` 1회 (FR-TGR-10a) |
| TC-TGR-17b | 칸 파괴 | 그 캔버스 컨텍스트의 `loseContext` 1회 (FR-TGR-8·10a) |
| V-TGR-4 (e2e) | 실제 브라우저에서 보이는 칸의 컨텍스트를 `loseContext` | 3초 복구 대기 없이 DOM 으로 돌아가고 입력이 왕복. addon 이 만드는 링크용 2D 캔버스가 아닌 WebGL 캔버스를 고른다 |
| TC-TGR-13 | 터치 기기 (`isMobile` 또는 `pointer: coarse`) | 붙이지 않음. 붙은 뒤 모바일로 바뀌면 뗌 |

### 7.2 e2e

- FR-TGR-18 의 네 항목 (`e2e/term-gpu.spec.ts`).
- 기존 e2e 전체가 FR-TGR-17 아래에서 통과.

### 7.3 수동 확인

- macOS Chrome·Safari 에서 `yes | head -200000`, `cat` 대용량 파일로 프레임 체감 비교.
- 한글·전각·이모지·밑줄·링크·선택·커서 모양이 DOM 렌더러와 같게 보이는지.
- 분할 4칸 + 탭 20개에서 콘솔에 컨텍스트 경고가 없는지.
- 캐럿 위치를 읽는 외부 앱(입력기 표시기 등)이 DOM 렌더러와 같게 동작하는지. 포커스 요소인 `.xterm-helper-textarea` 는 렌더러와 상관없이 DOM 에 남는다.

---

## 8. 리스크

| 리스크 | 수준 | 대응 |
|---|---|---|
| 일부 환경에서 글자 품질 저하 | MEDIUM | D-TGR-2 설정, FR-TGR-9~11 자동 복귀 |
| 탭 전환 첫 프레임 지연 | LOW | 수동 확인에서 체감되면 별도로 다룬다 |
| e2e 가 WebGL 경로를 넓게 보지 못함 | MEDIUM | FR-TGR-18 전용 e2e. 기존 e2e 를 버퍼 읽기로 옮기는 일은 후속 과제 |
| 헤드리스 CI 에 WebGL2 가 없을 수 있음 | LOW | FR-TGR-18 이 복귀 경로를 대신 본다 |
| 조합 이모지(ZWJ·국기·피부색)가 갈라져 그려짐 | LOW | §9 알려진 한계. 설정으로 끌 수 있다 |
| e2e 에서 DPR 을 에뮬레이션하면 WebGL 화면이 빈다 | LOW | §9. e2e 는 DPR 1 로 돈다 |

---

## 9. 측정과 알려진 한계 (2026-11-04)

### 9.1 성능

환경: Apple M4, Chromium headed(ANGLE Metal), DPR 1, 터미널 179×48. 세 번 잰 중앙값.
`task` 는 CDP `Performance.getMetrics` 의 `TaskDuration` 증가분(메인 스레드 총 작업 시간)이다.

| 경우 | 측정 | DOM | WebGL |
|---|---|---|---|
| CPU 1× | 5만 줄 쓰기 시간 | 363 ms | 333 ms |
| CPU 1× | 5만 줄 쓰기 중 메인 스레드 | 199 ms | 103 ms |
| CPU 1× | 스크롤 240프레임 중 메인 스레드 | 822 ms | 115 ms |
| CPU 4× | 5만 줄 쓰기 시간 | 1881 ms | 607 ms |
| CPU 4× | 스크롤 fps / p95 프레임 | 72 fps / 18.3 ms | 100 fps / 11.1 ms |
| CPU 4× | 스크롤 240프레임 중 메인 스레드 | 3330 ms | 372 ms |

- CPU 1× 에서는 두 렌더러 모두 화면 주사율(100 Hz)에 붙는다. 차이는 **메인 스레드 비용**에서 난다. 스크롤 중 레이아웃·스타일 계산이 0 이 된다.
- CPU 4×(약한 기기 흉내)에서는 DOM 이 프레임을 놓치고(72 fps), WebGL 은 주사율을 지킨다. 대량 쓰기는 약 3.1배 빠르다.

### 9.2 렌더 품질

같은 샘플을 두 렌더러로 그려 비교했다.

- **같다**: ASCII, 굵게·기울임·밑줄·취소선·반전·흐리게, 16·256·트루컬러, 한글, 전각 정렬, 박스·블록 문자, 곡선 밑줄, OSC 8 링크 밑줄, 커서.
- **다르다 (한계)**: 조합 이모지. 👍🏽 는 👍 와 피부색 칸으로, 👨‍👩‍👧 는 얼굴 셋으로, 🇰🇷 는 `KR` 로 갈라진다. WebGL 은 칸마다 글리프를 그리고, DOM 은 브라우저가 한 줄을 통째로 shaping 하기 때문이다. 단일 이모지(😀 ✅ ❌ 🚀)는 같다.
- 칸 폭: DOM 은 소수 px(8.43), WebGL 은 기기 픽셀로 내린 정수 px(8)다. 글꼴 크기·줄 높이는 같다 (D-TGR-8). 같은 칸에 들어가는 열 수가 다르다(170 ↔ 179). FR-TGR-7a 가 바뀔 때 다시 잰다.

### 9.3 측정 환경의 함정

Chromium 의 DPR **에뮬레이션**(`deviceScaleFactor: 2`)에서는 `devicePixelRatio` 가 2 인데
`ResizeObserver` 의 `device-pixel-content-box` 는 배율이 빠진 값을 낸다. addon 은 canvas 크기를 뒤의
것으로, 그리기를 앞의 것으로 정하므로 화면이 빈다. 앱 없이 vendor 파일만 올린 페이지와 공식
`@xterm/xterm@5.5.0` 에서도 같다. 실제 화면에서는 두 값이 같다. e2e 는 DPR 1 이다.

부수 확인: `web/vendor/xterm.js` 의 SHA-256 이 `@xterm/xterm@5.5.0` 의 `lib/xterm.js` 와 같다.

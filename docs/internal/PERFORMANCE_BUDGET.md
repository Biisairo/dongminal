# 성능 예산과 SLO

> **문서 상태**: 승인·구현완료

이 문서는 **무엇이 느려지면 결함인가**를 정합니다. 숫자가 없으면 "느리다" 는
의견이고, 의견은 고칠 자리를 가리키지 못합니다.

**측정 하네스는 `scripts/perf-probe.sh` 입니다.** CI 는 이것을 강제하지 않습니다 —
성능 회귀 CI 는 이 마일스톤의 범위 밖이며(로드맵 §4-3), 러너의 부하가 재는 값을
흔들어 게이트가 거짓 경보를 내기 때문입니다. **사람이 의심할 때 돌립니다.**

---

## 1. 왜 이 값들인가

기준은 하나입니다 — **사람이 "멈췄다" 고 느끼는 선.**

| 구간 | 사람이 느끼는 것 |
|---|---|
| ~100 ms | 즉각적이다 |
| ~300 ms | 빠르다 |
| ~1 s | 흐름이 끊기지 않는다 |
| 1 s 초과 | **기다린다** — 여기부터는 무언가를 보여 줘야 한다 |

터미널은 특히 앞쪽이 중요합니다. 키를 치고 글자가 나오기까지의 지연은
**모든 조작에 곱해지기** 때문입니다.

---

## 2. 예산

### 2-1. 입력 왕복 — 가장 중요한 하나

| 항목 | 예산 | 넘으면 |
|---|---|---|
| 키 입력 → 화면 반영 (로컬) | **p95 50 ms** | 터미널이 "무겁다" 고 느껴집니다 |
| 키 입력 → 화면 반영 (LAN) | **p95 100 ms** | 같음 |

이 값이 이 문서의 이유입니다. 과거에 접근 로그가 요청마다 남으면서 분할 조작 중
수백 ms 의 입력 지연이 났고(`H5`), 그래서 지금 `/api/ping`·`/api/stats`·
`/api/workspace`·`/api/tools` 가 접근 로그에서 빠집니다.

### 2-2. 서버 응답

| 종단 | 예산 (p95) | 근거 |
|---|---|---|
| `GET /api/ping` | 5 ms | 레이턴시 측정에 쓰이므로 자기 무게가 없어야 합니다 |
| `GET /api/stats` | 50 ms | 상태바가 3초마다 부릅니다 |
| `GET /api/health` · `/api/diag` | 100 ms | 사람이 부릅니다 |
| `GET /api/workspace` | 50 ms | 부팅 경로에 있습니다 |
| `PUT /api/settings` | 100 ms | 디스크 쓰기를 포함합니다 |
| `GET /api/git/status` (중간 규모 저장소) | 500 ms | `git` 프로세스를 띄웁니다 |
| `GET /api/fs/grep` | 2 s | `rg` 가 없으면 더 걸립니다 — 그 사실을 화면이 말합니다 |

### 2-3. 부팅

| 항목 | 예산 |
|---|---|
| `dongminal start` → `/api/ping` 응답 | **2 s** |
| 그 뒤 데몬 연결 | 5 s (붙지 않아도 기동은 성립합니다) |
| 브라우저 첫 화면 (부팅 화면이 걷히기까지) | **3 s** |

### 2-4. 자원

| 항목 | 예산 | 근거 |
|---|---|---|
| 유휴 시 서버 RSS | 100 MiB | 도구 없이 떠 있을 때 |
| 도구 하나당 증가분 | 5 MiB | 스크롤백 버퍼 1 MiB 를 포함합니다 |
| 유휴 시 CPU | 1% | 폴링이 도는 상태 |
| goroutine 수 (도구 10개) | 500 | 넘으면 새는 것을 의심합니다 |

`GET /api/diag` 가 `goroutines`·`allocMB` 를 냅니다 — 의심할 때 먼저 보는 자리입니다.

### 2-5. 셀 수 있는 예산 — 게이트가 읽는 자리

> **신설 2026-09-21** (묶음 B6 · `PERFORMANCE_HARDENING_SRS` FR-PRF-4).
>
> 위 §2-1~2-4 는 **벽시계와 자원**이다. 그 값들은 기계의 부하에 흔들리므로 게이트가
> 되지 못하고(§5-1), 그래서 *"사람이 의심할 때 돌린다"* 가 이 문서의 원래 규약이었다.
>
> 이 절은 다른 갈래다 — **같은 입력에 언제나 같은 답이 나오는 수**만 담는다.
> 그 수는 게이트가 될 수 있고, **아래 각 행은 자기를 지키는 검사의 이름을 적는다.**
> 수가 두 벌이 되지 않게 하려는 것이다.

#### 2-5-1. 비우고 다시 그리는 자리 (등록부)

`web/js/ui/repaint.js` 머리말이 규칙을 적는다 — *"목록을 `innerHTML=''` 로 비우고 다시
만드는 것은 **사용자가 부른 다시 그리기에서만** 옳다"*. 모양 자체는 결함이 아니고
**계기**가 결함을 만든다. 그 계기는 호출 사슬을 따라가야 알 수 있어 파싱으로 파생되지
않으므로(`STRUCTURE_CLEANUP_SRS` D-STR-6 · `PERFORMANCE_HARDENING_SRS` D-PRF-2),
게이트는 판정이 아니라 **이 목록과의 일치**만 본다.

**지키는 검사**: `scripts/check-repaint.mjs` (`make gates`).
**계기**: `사용자`(규약이 허용) · `가드`(폴링·관측이지만 근거 가드 뒤) · `폴링`(가드 없음 — **빚**).

| 파일 | 함수 | 대상 | 수 | 계기 | 근거 |
|---|---|---|---:|---|---|
| `web/js/core/app-attn.js` | `_attnCenterRender` | `center` | 1 | 폴링 | **등록부가 드러낸 자리.** 주의 상태가 바뀔 때마다(`_attnPaint`) 열려 있는 알림 센터를 통째로 다시 만든다. `refactor/README.md` §4.1 의 열다섯 밖이라 B6 이 고치지 않는다 (SRS §6-3) |
| `web/js/core/app-edsearch.js` | `_edPanel` | `p.querySelector('.ed-find-list')` | 1 | 사용자 | 찾기 패널을 세울 때 한 번 |
| `web/js/core/app-edsearch.js` | `_edPanelPaint` | `list` | 1 | 사용자 | 검색어가 비면 목록을 비운다 |
| `web/js/core/app-edsearch.js` | `_edPanelQuery` | `p.querySelector('.ed-find-list')` | 1 | 사용자 | 사용자가 친 검색어 |
| `web/js/core/app-mobile.js` | `initMobileKeybar` | `bar` | 1 | 사용자 | 키바 배선 — `InputBinding.bind()` 에서 한 번 |
| `web/js/core/app-presets.js` | `_renderPresets` | `el` | 1 | 사용자 | 프리셋 목록을 열 때 |
| `web/js/core/app-settings-access.js` | `_loadAccessPanel` | `box` | 1 | 사용자 | 설정 탭 전환 |
| `web/js/core/app-settings-access.js` | `_loadAccessPanel` | `hostBox` | 1 | 사용자 | 같은 자리 |
| `web/js/core/app-settings-keys.js` | `_renderShortcutList` | `el` | 1 | 사용자 | 설정 탭 전환 |
| `web/js/core/app-settings-sandbox.js` | `_loadSandboxPanel` | `box` | 1 | 사용자 | 설정 탭 전환 |
| `web/js/core/app-settings-theme.js` | `_renderThemePanel` | `list` | 1 | 사용자 | 설정 탭 전환 |
| `web/js/core/app-settings-theme.js` | `_showCustomEditor` | `termDiv` | 1 | 사용자 | 사용자가 연 편집기 |
| `web/js/core/app-settings-theme.js` | `_showCustomEditor` | `uiDiv` | 1 | 사용자 | 같은 자리 |
| `web/js/core/app-statusbar.js` | `_renderStatusBarSettings` | `el` | 1 | 사용자 | 설정 탭 전환 |
| `web/js/git/commit.js` | `_paintBlocks` | `box` | 1 | 가드 | `box.dataset.sig` — 막힘 코드 목록이 그대로면 그리지 않는다 |
| `web/js/git/confirm.js` | `_paint` | `ul` | 1 | 사용자 | 사용자가 연 확인창 |
| `web/js/git/console.js` | `_drawList` | `list` | 1 | 가드 | `paintIfChanged` 안이다 (FR-RPT-1) |
| `web/js/git/diff-view.js` | `clear` | `this._host` | 1 | 사용자 | 이름이 곧 계기다 — 비우라고 부른다 |
| `web/js/git/history-detail.js` | `_paintDetail` | `ps` | 1 | 가드 | 부모 줄이 `paintIfChanged` 를 지난다 (FR-PRF-10) |
| `web/js/git/history-detail.js` | `_paintDetail` | `sel` | 1 | 가드 | `sel.dataset.for` — 커밋과 부모 수가 그대로면 채우지 않는다 |
| `web/js/git/history-refs.js` | `_paintRefs` | `box` | 1 | 가드 | 뼈대는 한 번, 그룹별 행은 `reconcileList` 를 지난다 (FR-PRF-10) |
| `web/js/git/history.js` | `_paintRev` | `box` | 2 | 가드 | 하나는 리비전이 없을 때의 비우기, 하나는 `box.dataset.sig` 뒤 |
| `web/js/git/panel-changes.js` | `_paintGroup` | `rows` | 1 | 가드 | 접힌 그룹을 비운다 — 이미 비어 있으면 변이가 없다. 펼친 쪽은 `reconcileList` 다 |
| `web/js/git/panel-changes.js` | `_paintHead` | `badges` | 1 | 가드 | 배지 줄이 `paintIfChanged` 를 지난다 (FR-PRF-10) |
| `web/js/git/panel-changes.js` | `_renderChanges` | `el` | 1 | 가드 | `el.dataset.built` — 뷰를 처음 세울 때만 |
| `web/js/git/panel-changes.js` | `_renderInit` | `el` | 1 | 사용자 | 뷰 세우기 |
| `web/js/git/panel-diff.js` | `_drawBlame` | `rows` | 1 | 가드 | `box.dataset.sig` — 같은 파일을 다시 열어도 다시 그리지 않는다. 한 번의 비용은 §2-5-2 가 잡는다 |
| `web/js/git/panel-diff.js` | `_hunkBarPaint` | `el` | 1 | 가드 | `el.dataset.sig` |
| `web/js/git/panel-life.js` | `_render` | `el` | 1 | 사용자 | 뷰 전환 |
| `web/js/git/panel-life.js` | `_renderBody` | `el` | 1 | 사용자 | 뷰 전환 |
| `web/js/git/panel-life.js` | `_renderMissing` | `el` | 1 | 사용자 | 리포 소실 — 상태 전이 한 번 |
| `web/js/git/panel-views.js` | `_renderBranches` | `el` | 1 | 가드 | `el.dataset.built` |
| `web/js/git/panel-views.js` | `_renderConsole` | `el` | 1 | 가드 | `el.dataset.built` |
| `web/js/git/panel-views.js` | `_renderHistory` | `el` | 1 | 가드 | `el.dataset.built` |
| `web/js/git/panel-views.js` | `_renderStash` | `el` | 1 | 가드 | `el.dataset.built` |
| `web/js/git/panel-views.js` | `_renderSubmodules` | `el` | 1 | 가드 | `el.dataset.built` |
| `web/js/git/panel-views.js` | `_renderWorktrees` | `el` | 1 | 가드 | `el.dataset.built` |
| `web/js/git/panel-write.js` | `_paintNote` | `ul` | 1 | 사용자 | 사용자가 연 부분 스테이지 대화상자 |
| `web/js/git/remote.js` | `_paintFail` | `opts` | 1 | 가드 | `opts.dataset.opts` |
| `web/js/git/remote.js` | `_paintLog` | `log` | 1 | 가드 | `log.dataset.job` — job 이 바뀔 때만 |
| `web/js/ui/doc-render.js` | `_note` | `this._body` | 1 | 사용자 | 문서를 여는 경로의 안내 |
| `web/js/ui/doc-render.js` | `_paintTable` | `this._body` | 1 | 사용자 | 문서를 여는 경로 |
| `web/js/ui/file-editor.js` | `_createEditor` | `this.el` | 1 | 사용자 | 편집기를 세울 때 한 번 |
| `web/js/ui/runs-panel.js` | `_runPaintSummary` | `el` | 1 | 가드 | `paintIfChanged` 안이다 |
| `web/js/ui/sidebar-list.js` | `_paintInto` | `el` | 2 | 가드 | 빈 상태의 비우기 둘. 목록은 `reconcileList` 를 지난다 |
| `web/js/ui/ui-kit.js` | `_hud` | `b` | 1 | 사용자 | 분할 드래그 중의 크기 HUD — 사용자의 손이 계기다 |

#### 2-5-2. 그 밖의 셀 수 있는 예산

| 항목 | 예산 | 지키는 검사 |
|---|---|---|
| 값이 바뀌지 않은 관측 회차의 목록 DOM 변이 | **0** | `e2e/perf-repaint.spec.ts` P1 |
| 값이 **바뀐** 회차에 살아남는 행 | **바뀌지 않은 행 전부** | `e2e/perf-repaint.spec.ts` P2~P5 |
| 한 동작이 내는 `render()` 진입 | **1** (유휴 5초는 **0**) | `e2e/perf-render.spec.ts` R1·R2 |
| blame 이 한 번에 그리는 행 | **`GIT_BLAME_MAX_ROWS`(2,000) 이하** — 행마다 6노드다 | `e2e/git-diff.spec.ts` BL3 |
| 만든 관측자를 잡지 않는 자리 | **0** (착수 시 9자리 중 1) | `scripts/check-observer.mjs` |
| 레이아웃을 애니메이션하는 `@keyframes` | **0** (착수 시 13개 중 1) | `scripts/check-css-animation.mjs` |
| 상태바 한 회차의 **직렬** 왕복 | **2** (`ping` → `stats` ∥ `git/jobs`) | `e2e/perf-statusbar.spec.ts` S1 |
| 같은 `.gz` 자산 N회 요청의 파일 읽기 | **1** | `TestStatic_PrecompressedReadsFileOnce` |
| 없는 경로 1,000회 뒤 `etags` 항목 | **0** | `TestStatic_ETagDoesNotCacheMisses` |
| 핀 목록의 `RepoRoot` 동시 진행 | **2 이상 · `gitObserveMax`(4) 이하** | `TestGitPinnedEntries_RunsInParallel` |
| grep 폴백의 파일당 상주 메모리 | **O(줄 길이)** (전에는 O(파일 크기)) | `TestGrepWithGo_LineSplittingUnchanged` · `BenchmarkGrepWithGo` |
| 살아 있는 LSP 세션을 쓰는 요청의 `LookPath` | **0** (전에는 요청당 2) | `TestManager_LiveSessionSkipsResolve` |
| `runs.json` 저장 1회의 깊은 복사 | **0** (되돌림은 쓴 바이트에서 푼다) | `TestSave_RollbackWorksFromBlob` · `BenchmarkAppendMessage` |
| 부팅 1회의 `runtime.Install` 진입 | **1** (서버만. 데몬은 점검) | `TestEnsureInstalled_SkipsWhenHelpersAreHealthy` |

> 둘째 줄이 없으면 첫째 줄은 *"아무것도 안 그린다"* 로도 통과한다. 조용히 낡은
> 화면은 느린 화면보다 나쁘다 (`PERFORMANCE_HARDENING_SRS` §7).

---

## 3. SLO — 무엇을 약속하는가

단일 사용자 도구라 가용성 SLO 를 %로 적는 것은 뜻이 없습니다. 대신 **회복**을 적습니다.

| 항목 | 약속 |
|---|---|
| 데몬이 죽으면 | 웹서버가 재연결을 시도합니다. 그동안 화면은 "연결 끊김" 을 보입니다 |
| 웹서버가 죽으면 | **아무도 되살리지 않습니다** — `dongminal service install` 로 감독자에 넣으면 되살아납니다 |
| 웹서버를 다시 띄우면 | **PTY 세션은 살아 있습니다.** 데몬이 소유하기 때문입니다 |
| 워크스페이스가 깨지면 | 격리하고 세대에서 되살립니다 (3세대) |
| 비정상 종료였으면 | 다음 기동의 로그가 말하고 `doctor --bundle` 이 담습니다 |

---

## 4. 재는 법

```bash
scripts/perf-probe.sh                 # 격리 인스턴스를 띄워 재고 치웁니다
scripts/perf-probe.sh --port 58146    # 이미 도는 인스턴스에 대고 잽니다
```

**격리가 기본입니다.** 운영 인스턴스에 대고 재면 그 인스턴스의 부하가 값에
섞이고, 반대로 측정이 그쪽을 느리게 만듭니다.

### 읽는 법

- **한 번의 숫자를 믿지 마세요.** 이 저장소는 부하 민감성을 여러 번 만났습니다 —
  같은 검사가 실행마다 다른 답을 냈습니다.
- 예산을 넘으면 **먼저 다시 재세요.** 두 번 넘으면 그때 쫓습니다.
- 쫓을 때 먼저 보는 것은 `GET /api/diag` 의 `goroutines`·`allocMB` 입니다.

---

## 5. 비목표

1. **성능 회귀 CI.** 러너의 부하가 값을 흔들어 게이트가 거짓 경보를 냅니다 —
   그러면 아무도 보지 않는 게이트가 됩니다 (로드맵 §4-3).
2. **부하 시험.** 단일 사용자 도구입니다. 동시 접속자를 재는 것이 뜻이 없습니다.
3. **프로파일 상시 수집.** `/debug/pprof` 를 열지 않습니다 — 인증이 없는 서버에
  프로파일 종단을 두는 것은 그 자체가 표면입니다.
4. **브라우저 렌더 성능 예산.** 렌더 파이프라인은 M6 의 것이고, 그 마일스톤이
   자기 기준을 세웁니다.

---

## 6. 변경 기록

| 날짜 | 내용 |
|---|---|
| 2026-09-12 | 신규. M5 `G9-2`. 측정 하네스 `scripts/perf-probe.sh` 와 함께 |

# SRS: md 포커스 상태에서 새 pane 의 cwd 를 md 파일 경로로 설정 (IEEE 29148 준수)

## 1. 개요 (Introduction)

### 1.1 목적 (Purpose)
md 뷰어 탭이 활성 상태인 region 에서 사용자가 split 하거나 같은 region 에 새 터미널 탭을 추가할 때, 신규 pane 의 작업 디렉터리(cwd)를 md 파일이 위치한 디렉터리로 설정한다. README TODO "md focus 상황에서 새탭, 창분할 시 경로 유지" 단일 원천 스펙.

### 1.2 범위 (Scope)
- 프론트엔드: `App.addTab` 의 terminal 분기, `App._splitInner` 의 신규 pane 생성 루프.
- 백엔드(`apiPanesCreate`): 변경 없음. 기존 `cwd=` 쿼리 파라미터 그대로 사용.
- 비포함: dmctl/MCP 의 split-h/v(외부 명령) 의 동작 변경 — 본 스펙은 UI 동작에 한정.

### 1.3 정의 (Definitions)
- **md region**: `activeTab` 이 `type==='markdown'` 인 region.
- **ref descriptor**: 신규 pane 생성 시 cwd 결정용 입력. `{cwd?: string, cwdPane?: string}`.
  - md region → `cwd = dirname(filePath)`.
  - terminal region → `cwdPane = activeTab.paneId` (현재 동작).
  - 빈 region/예외 → 둘 다 비움 (서버 폴백).

## 2. 현황 (Current State)
- `_focusedTermPane()` 은 active tab 이 terminal 일 때만 pane 을 반환. md 면 `null`.
- `_regionActivePaneId(sess, rid)` 은 md 탭에 `paneId` 가 없으므로 `null`.
- 결과: `_newPane(null, null)` → 서버 `apiPanesCreate` 가 `cwd==""` 로 진행 → `s.Panes.Create("")` → 프로세스 cwd(보통 사용자 home) 에서 시작.

## 3. 요구사항 (Requirements)

### 3.1 기능 요구사항 (Functional)
| ID | 요구사항 | 우선 |
|----|---------|------|
| FR-1 | 활성 탭이 markdown 인 region 에서 같은 region 에 terminal 탭을 `+` 추가하면, 신규 pane 의 cwd 는 `dirname(activeTab.filePath)` 여야 한다. | 필수 |
| FR-2 | 활성 탭이 markdown 인 region 에서 split(가로/세로)을 수행하면, 새로 생성되는 모든 pane 의 cwd 가 `dirname(activeTab.filePath)` 여야 한다. | 필수 |
| FR-3 | 활성 탭이 terminal 인 경우는 기존 동작(부모 pane 의 `cwdPane` 전달)을 유지해야 한다(회귀 금지). | 필수 |
| FR-4 | filePath 가 절대경로가 아니거나 디렉터리 추출이 비정상이면 cwd 를 비워 서버 폴백에 위임한다. | 권장 |

### 3.2 비기능 요구사항 (Non-functional)
- NFR-1 변경은 외과적이어야 하며 비-md 경로의 cwd 결정 로직을 바꾸지 않는다.
- NFR-2 백엔드/패키지 추가 없이 프론트 단일 헬퍼 추출 + 두 호출지점만 수정.
- NFR-3 `go test ./...` 및 기존 e2e 회귀 통과.

### 3.3 제약 (Constraints)
- 데이터 모델/`tab.filePath` 형식 변경 금지(현재 `_resolve` 결과는 항상 `/` 시작 절대경로).
- `apiPanesCreate` 의 쿼리 인터페이스(`cwd`, `cwdPane`) 변경 금지.

## 4. 설계 (Design)

### 4.1 헬퍼 도입
`App.prototype._regionNewPaneRef(sess, rid)` 추가:
```
input: 활성/대상 세션, region id
output: {cwd?, cwdPane?}
규칙:
  rg = findRg(sess.layout, rid); 없으면 {} 반환
  tab = rg.tabs[activeTab] || rg.tabs[0]
  tab.type==='markdown' && tab.filePath 가 '/' 로 시작:
    i = lastIndexOf('/');
    dir = i>0 ? slice(0,i) : '/'
    return {cwd: dir}
  tab.paneId: return {cwdPane: tab.paneId}
  default: {}
```

### 4.2 `addTab` 패치
terminal 분기에서:
```
const ref = this._regionNewPaneRef(s, rid);
const p = await this._newPane(ref.cwd || null, ref.cwdPane || null);
```
- md region 의 `+` 클릭은 동일 region 에 terminal 추가 → md 디렉터리 사용.
- 회귀 보호: 기존 `this._focusedTermPane()` 은 focused region 만 본 반면, 헬퍼는 `rid` 기반(타깃 일치). focused==rid 인 일반 사용에서는 동작 동일.

### 4.3 `_splitInner` 패치
루프 진입 전 ref 1회 계산:
```
const ref = this._regionNewPaneRef(s, tgtRegionId);
for(let i=0;i<count-1;i++){
  const p = await this._newPane(ref.cwd || null, ref.cwd ? null : (ref.cwdPane || refPaneId));
  ...
}
```
- `refPaneId` 변수는 잔존 호환을 위해 유지하되, ref 가 cwd 를 가지면 cwd 우선.
- 호출 시그니처 변경 없음.

## 5. 검증 (Validation)

### 5.1 e2e (Playwright)
`e2e/md-cwd-inherit.spec.ts`:
1. md 파일을 `/tmp/<dir>/X.md` 생성 → md 탭 열기 → focus 가 md region.
2. `app.addTab(focused, 'terminal')` 호출 → 새 paneId 얻기 → `/api/cwd?pane=<id>` 가 `/tmp/<dir>` 와 일치.
3. md region 에서 `app.split('h')` → 새 region 의 active terminal pane → `/api/cwd?pane=<id>` 가 `/tmp/<dir>`.
4. terminal 활성 region 에서의 split/addTab 은 기존 동작(cwd 가 부모 pane 의 cwd) 유지 — 회귀 케이스 1건.

### 5.2 수동 확인
- README.md 를 md 탭으로 열고 `+` → `pwd` 가 프로젝트 루트(README 디렉터리).
- `Ctrl+\` (split) → `pwd` 가 동일.

## 6. 완료 조건 (Definition of Done)
- [ ] `_regionNewPaneRef` 헬퍼 추가.
- [ ] `addTab`/`_splitInner` 사용처 갱신.
- [ ] e2e 추가 및 로컬 통과.
- [ ] `go test ./...` 및 기존 e2e 회귀 통과.
- [ ] 본 SRS 문서 commit.

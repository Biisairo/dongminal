# SRS: 다중 탭 타입 인프라 및 Markdown 뷰어

## 1. 개요

dongminal 웹 UI의 탭 시스템을 터미널 전용에서 다중 타입 구조로 확장한다.
첫 번째 비터미널 타입으로 Markdown 뷰어를 도입한다.

### 1.1 목적

- 탭이 항상 PTY(터미널)에 연결되던 구조를 타입별 뷰어로 일반화
- `marked.js`를 이용한 Markdown 뷰어 탭 구현
- `mdview` CLI 커맨드로 터미널에서 Markdown 파일을 뷰어 탭으로 열기
- 뷰어 테마는 현재 터미널 테마 색상을 그대로 사용
- 다른 열려있는 창으로 브로드캐스팅되어 동기화 유지

### 1.2 범위

**포함:**
- 탭 데이터 모델에 `type` 필드 추가 (하위호환 유지)
- `MdViewer` 프론트엔드 클래스 및 CSS
- `/api/md-file` 서버 엔드포인트
- `openMdTab` 커맨드 액션 및 `_execRemote` 핸들러
- `mdview` CLI 스크립트
- Markdown 내 링크 클릭 처리 (상대 `.md` 경로 → 새 탭, 외부 URL → 새 창)
- 워크스페이스 동기화에서 `filePath` 참조만 저장

**미포함:**
- 파일 변경 자동 감지(live reload) — 이후 확장
- Markdown 편집 기능
- `.md` 외 다른 파일 타입 뷰어

## 2. 데이터 모델

### 2.1 탭 데이터 모델 변경

**기존:**
```json
{"id": "t1", "name": "Shell", "paneId": "1"}
```

**변경 후:**
```json
// 터미널 탭 (하위호환: type 없으면 'terminal'로 간주)
{"id": "t1", "name": "Shell", "type": "terminal", "paneId": "1"}

// Markdown 뷰어 탭
{"id": "t2", "name": "README.md", "type": "markdown", "filePath": "/abs/path/to/README.md"}
```

| 필드 | 타입 | 필수 | 설명 |
|------|------|------|------|
| `id` | string | O | 탭 고유 식별자 (기존과 동일) |
| `name` | string | O | 탭 바에 표시할 이름 |
| `type` | string | O | `"terminal"` 또는 `"markdown"`. 누락 시 `"terminal"`로 간주 (하위호환) |
| `paneId` | string | terminal | 터미널 탭에서만 필수. PTY 프로세스 식별자 |
| `filePath` | string | markdown | 마크다운 탭에서만 필수. 읽을 파일의 절대 경로 |

### 2.2 워크스페이스 JSON에서의 처리

- Markdown 탭은 `filePath`(절대경로 문자열)만 저장
- Markdown 파일 내용은 워크스페이스 JSON에 포함하지 않음
- 브라우저가 탭을 렌더링할 때 `/api/md-file?path=<filePath>`로 내용을 fetch
- 다른 창이 `workspace_changed` SSE를 수신하면 filePath를 보고 새 MdViewer 인스턴스를 생성

## 3. 프론트엔드 변경

### 3.1 App 클래스 변경 (web/app.js)

#### 3.1.1 새로운 컬렉션

```javascript
class App {
  constructor() {
    this.panes = new Map();      // 기존: paneId → TermPane
    this.mdViewers = new Map();  // 신규: tabId → MdViewer
    // ...
  }
}
```

#### 3.1.2 탭 타입 분기점

다음 메서드에서 tab type에 따라 분기 처리:

| 메서드 | 변경 사항 |
|--------|----------|
| `_buildRg(n)` | tab type 확인 → `TermPane` 또는 `MdViewer`를 body에 append |
| `closeTab()` | type별 destroy 로직 분기 (TermPane: `_killBg`, MdViewer: `destroy`) |
| `_focusedPane()` | → `_focusedTermPane()`으로 명칭 변경 + `_focusedTab()` 제공 |
| `_mkPane()` | terminal 타입만 사용. `_mkMdViewer()` 신규 |
| `addTab()` | type 파라미터 추가. 기본값 `'terminal'` |
| `split()` | 새 region의 탭 type 인자로 받음. 기본값 `'terminal'` |
| `_applyRemoteWorkspace()` | type별 인스턴스 생성/정리 |
| `clean()` | paneId 검사 로직: type이 terminal인 tab만 검사 |

#### 3.1.3 addTab 메서드 변경

```javascript
async addTab(rid, type = 'terminal', opts = {}) {
  const s = this._as(); if (!s) return;
  const rg = findRg(s.layout, rid); if (!rg) return;
  const t = `t${++this._t}`;
  if (type === 'markdown' && opts.filePath) {
    const name = opts.name || filePath.split('/').pop();
    rg.tabs.push({id: t, name, type: 'markdown', filePath: opts.filePath});
  } else {
    const refPane = this._focusedTermPane();
    const p = await this._newPane(null, refPane?.id);
    rg.tabs.push({id: t, name: 'Shell', type: 'terminal', paneId: p.id});
  }
  rg.activeTab = t;
  this.render();
  this._save();
}
```

#### 3.1.4 `_execRemote` — openMdTab 핸들러

```javascript
if (action === 'openMdTab') {
  const {name, filePath, location} = args;
  if (location) this._focusLocation(location);
  this.addTab(this.focused, 'markdown', {name, filePath});
  return;
}
```

### 3.2 MdViewer 클래스 (web/app.js — 신규)

```javascript
class MdViewer {
  constructor(id, name, filePath) {
    this.id = id;           // tab id
    this.name = name;
    this.filePath = filePath;
    this.el = document.createElement('div');
    this.el.className = 'md-viewer';
    this._loading = true;
    this.fetchAndRender();
  }

  async fetchAndRender() {
    try {
      const r = await fetch('/api/md-file?path=' + encodeURIComponent(this.filePath));
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const md = await r.text();
      this.el.innerHTML = marked.parse(md);
      this._interceptLinks();
    } catch (e) {
      this.el.innerHTML = '<div class="md-error">파일을 불러올 수 없습니다: ' + 
        this._escHtml(this.filePath) + '</div>';
    }
    this._loading = false;
  }

  refresh() { this.fetchAndRender(); }

  _interceptLinks() {
    this.el.querySelectorAll('a').forEach(a => {
      a.addEventListener('click', e => {
        const href = a.getAttribute('href');
        if (!href) return;
        // 외부 URL → 새 창
        if (href.startsWith('http://') || href.startsWith('https://')) {
          e.preventDefault();
          window.open(href, '_blank');
          return;
        }
        // .md 상대경로 → 새 마크다운 탭
        if (href.endsWith('.md') || href.endsWith('.mdown') || href.endsWith('.markdown')) {
          e.preventDefault();
          const baseDir = this.filePath.substring(0, this.filePath.lastIndexOf('/'));
          const absPath = this._resolvePath(baseDir, href);
          app.addTab(app.focused, 'markdown', {name: href.split('/').pop(), filePath: absPath});
          return;
        }
        // 기타 상대경로 → download 엔드포인트
        if (href.startsWith('/') || href.startsWith('./') || href.startsWith('../')) {
          e.preventDefault();
          // 필요시 추후 확장
          return;
        }
      });
    });
  }

  _resolvePath(base, rel) {
    // 간단한 경로 결합 (..  처리)
    const parts = (base + '/' + rel).split('/').filter(Boolean);
    const stack = [];
    for (const p of parts) {
      if (p === '..') stack.pop();
      else if (p !== '.') stack.push(p);
    }
    return '/' + stack.join('/');
  }

  _escHtml(s) {
    const d = document.createElement('div'); d.textContent = s; return d.innerHTML;
  }

  destroy() { this.el.remove(); }
}
```

### 3.3 _buildRg 변경

```javascript
// _buildRg 내 body 렌더링 부분 변경:
// 기존:
// const at = (n.tabs||[]).find(t=>t.id===n.activeTab);
// if(at){const p=this.panes.get(at.paneId);if(p){body.appendChild(p.el);p.el.classList.add('vis')}}
//
// 변경:
for (const tab of (n.tabs || [])) {
  const isMd = tab.type === 'markdown';
  const isActive = tab.id === n.activeTab;

  if (isMd) {
    let viewer = this.mdViewers.get(tab.id);
    if (!viewer) {
      viewer = new MdViewer(tab.id, tab.name, tab.filePath);
      this.mdViewers.set(tab.id, viewer);
    }
    if (isActive) {
      body.appendChild(viewer.el);
      viewer.el.classList.add('vis');
    }
  } else {
    const pane = this.panes.get(tab.paneId);
    if (!pane) continue;
    if (isActive) {
      body.appendChild(pane.el);
      pane.el.classList.add('vis');
    }
  }
}
```

### 3.4 closeTab 변경

```javascript
// 탭 닫기 시 type별 정리:
if (tab.type === 'markdown') {
  const viewer = this.mdViewers.get(tab.id);
  if (viewer) { viewer.destroy(); this.mdViewers.delete(tab.id); }
} else {
  // 기존 _killBg(paneId) 로직
}
```

### 3.5 clean() 함수 변경

```javascript
function clean(n, okLive) {
  // okLive: 생존한 paneId 집합 (터미널 전용)
  if (n.type === 'region') {
    if (n.tabs) n.tabs = n.tabs.filter(t => {
      if (t.type === 'markdown') return true;  // markdown 탭은 항상 유지
      return okLive.has(t.paneId);             // terminal 탭은 paneId로 검사
    });
    if (!n.tabs || !n.tabs.length) return null;
    if (!n.tabs.find(t => t.id === n.activeTab)) n.activeTab = n.tabs[0].id;
    return n;
  }
  // ... split 노드 처리 기존과 동일
}
```

### 3.6 하위호환 처리

- 탭 객체에 `type` 필드가 없으면 `'terminal'`로 간주
- `paneId`가 있고 `type`이 없으면 → terminal
- `_as()`, `_applyRemoteWorkspace()`, Workspace 저장/로드 시 누락된 type 보완

## 4. 서버 변경

### 4.1 /api/md-file 엔드포인트 (handlers_api.go)

```
GET /api/md-file?path=<absPath>

Response 200: text/markdown (파일 내용)
Response 400: missing or invalid path
Response 404: file not found
Response 403: path is not a .md file
```

제약 조건:
- `path`는 절대 경로여야 함
- 확장자가 `.md`, `.mdown`, `.markdown` 중 하나여야 함
- 파일이 존재하고 읽기 가능해야 함
- 심볼릭 링크는 허용하되 파일 시스템 밖은 거부

구현:
```go
case p == "/api/md-file" && r.Method == http.MethodGet:
    fp := r.URL.Query().Get("path")
    if fp == "" {
        http.Error(w, "missing path", 400)
        return
    }
    if !filepath.IsAbs(fp) {
        http.Error(w, "path must be absolute", 400)
        return
    }
    ext := strings.ToLower(filepath.Ext(fp))
    if ext != ".md" && ext != ".mdown" && ext != ".markdown" {
        http.Error(w, "only markdown files (.md, .mdown, .markdown) are allowed", 403)
        return
    }
    f, err := os.Open(fp)
    if err != nil {
        http.Error(w, "file not found", 404)
        return
    }
    defer f.Close()
    stat, _ := f.Stat()
    if stat.IsDir() {
        http.Error(w, "not a file", 400)
        return
    }
    w.Header().Set("Content-Type", "text/markdown; charset=utf-8")
    io.Copy(w, f)
```

### 4.2 openMdTab 커맨드 액션 (commands.go)

`allowedCmdActions`에 `"openMdTab"` 추가.

Args 형식:
```json
{
  "action": "openMdTab",
  "args": {
    "name": "README.md",
    "filePath": "/abs/path/to/README.md",
    "location": "1.2"  // 선택사항
  }
}
```

프론트엔드 `_execRemote`에서 `openMdTab` 액션 처리:
1. (location이 있으면 `_focusLocation` 실행)
2. 현재 포커스된 region에 `type='markdown'` 탭 추가
3. `_save()` + `render()`

## 5. CLI: mdview

### 5.1 스크립트 (internal/runtime/scripts/mdview)

```sh
#!/bin/sh
# mdview — dongminal에서 Markdown 파일을 뷰어 탭으로 열기
#
# 사용법:
#   mdview <path>         Markdown 파일을 현재 포커스된 탭 위치에 열기
#   mdview -h, --help     도움말

set -e

PORT="${DONGMINAL_PORT:-8080}"
HOST="${DONGMINAL_HOST:-127.0.0.1}"
BASE="http://${HOST}:${PORT}"

usage() {
  cat <<'HELP'
사용법:
  mdview <path>    Markdown 파일을 뷰어 탭으로 열기
  mdview -h        도움말
HELP
  exit "${1:-0}"
}

case "${1:-}" in
  "" | -h | --help )
    usage 0
    ;;
esac

target="$1"
if [ ! -f "$target" ]; then
  echo "mdview: 파일 없음: $target" >&2
  exit 1
fi

# 절대경로 변환
abs=$(cd "$(dirname "$target")" && pwd)/$(basename "$target")
name=$(basename "$abs")

# JSON 이스케이핑 (간단한 경우)
# filePath에 /, " 등이 포함될 수 있으므로 python3 또는 jq 사용
if command -v python3 >/dev/null 2>&1; then
  name_escaped=$(python3 -c "import json; print(json.dumps('$name'))" 2>/dev/null || echo "\"$name\"")
  path_escaped=$(python3 -c "import json; print(json.dumps('$abs'))" 2>/dev/null || echo "\"$abs\"")
elif command -v jq >/dev/null 2>&1; then
  name_escaped=$(echo "$name" | jq -Rs .)
  path_escaped=$(echo "$abs" | jq -Rs .)
else
  # 폴백: 최소한의 이스케이핑
  name_escaped=$(echo "$name" | sed 's/"/\\"/g')
  path_escaped=$(echo "$abs" | sed 's/"/\\"/g')
  name_escaped="\"${name_escaped}\""
  path_escaped="\"${path_escaped}\""
fi

payload=$(printf '{"action":"openMdTab","args":{"name":%s,"filePath":%s}}' "$name_escaped" "$path_escaped")

resp=$(curl -sS -X POST \
  -H 'Content-Type: application/json' \
  -d "$payload" \
  "${BASE}/api/commands" 2>&1) || {
  echo "mdview: 서버 연결 실패 (port=$PORT)" >&2
  exit 1
}

echo "$resp"
```

## 6. CSS: Markdown 뷰어 스타일 (web/style.css)

### 6.1 .md-viewer 기본 규칙

```css
.md-viewer {
  position: absolute;
  inset: 0;
  overflow-y: auto;
  padding: 16px 24px;
  display: none;
  background: var(--bg);
  color: var(--text);
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  font-size: 14px;
  line-height: 1.6;
}
.md-viewer.vis { display: block; }
```

### 6.2 Markdown 요소별 스타일 (테마 색상 사용)

- `h1-h6`: `--text-bright` 색상, 계층적 크기
- `a`: `--accent` 색상, hover 시 `--accent-border` 밑줄
- `code`: `--sidebar-bg` 배경, `--text-bright` 전경
- `pre code`: `--sidebar-bg` 배경, `--border` 테두리, 가로 스크롤
- `blockquote`: `--border` 왼쪽 테두리, `--text-muted` 글자
- `table`: `--border` 테두리, `--sidebar-bg` 헤더 배경
- `hr`: `--border` 색상
- `img`: 최대 너비 100%
- `.md-error`: `--danger` 색상

## 7. 동기화

### 7.1 워크스페이스 저장

- Markdown 탭은 `type: "markdown"` + `filePath`만 저장
- Content는 저장하지 않음 (파일 시스템이 소스)

### 7.2 다른 창에서의 복원

1. `workspace_changed` SSE 수신 → `_applyRemoteWorkspace()` 호출
2. `_applyRemoteWorkspace()`에서 Markdown 탭 감지 시 `MdViewer` 인스턴스 생성
3. `MdViewer.fetchAndRender()`가 `/api/md-file`로 내용을 가져와 렌더링
4. 기존 `MdViewer`가 이미 있으면 재사용

### 7.3 파일 위치 시 고려사항

- `filePath`는 절대 경로로 저장
- 다른 머신의 창에서 열 경우 파일이 존재하지 않을 수 있음
- 이 경우 MdViewer는 "파일을 불러올 수 없습니다" 에러 메시지를 표시
- 서버 측에서 파일이 없으면 404 반환

## 8. 테마 적용

MdViewer의 렌더링은 `marked.parse()`를 사용하고, 스타일은 CSS 변수를 통해 터미널 테마 색상을 상속:

```javascript
// MdViewer는 별도의 테마 적용 로직 없이 CSS 변수를 사용
// .md-viewer의 배경은 var(--bg), 글자는 var(--text) 등
// 테마 변경 시 applyThemeObj()가 CSS 변수를 업데이트하므로 자동 반영
```

## 9. 비기능 요구사항

### 9.1 성능

- 대용량 Markdown 파일(1MB 이상)도 렌더링 가능해야 함
- `/api/md-file` 응답은 스트리밍 없이 전체 파일을 한 번에 전송

### 9.2 하위호환성

- 기존 워크스페이스 JSON에 `type` 필드가 없는 탭은 모두 `terminal`로 처리
- 기존 API 엔드포인트 영향 없음
- TermPane, WebSocket, PTY 로직 변경 없음

### 9.3 보안

- `/api/md-file`은 `.md/.mdown/.markdown` 확장자만 서빙
- 디렉토리 접근 거부
- 심볼릭 링크 파일은 허용하나 디바이스 파일/파이프는 거부

## 10. 향후 확장 포인트

- 파일 변경 자동 감지 (fsnotify → SSE 이벤트)
- `.md` 외 뷰어 타입 (이미지, PDF, 코드 하이라이트)
- Markdown 뷰어 내 새로고침 버튼
- 상대 경로 링크로 다른 `.md` 파일 열기 시 이동/교체 선택
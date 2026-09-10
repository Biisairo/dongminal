package httpapi

import (
	"encoding/json"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"sync"
)

// `/api/file/*` 의 경계 (FILE_API_BOUNDARY_SRS).
//
// 이 계층은 절대경로면 **어디든** 열었다. 가드가 없는 것은 사고가 아니라 명시된
// 설계였다 (`handlers_fs.go:22-25`): "사용자가 경로를 이미 알고 지목한 읽기·쓰기"
// 이므로 상한이 필요 없다는 것.
//
// 그 전제는 **대화형 사용자**에게 참이다. 그 사람은 터미널에서 무엇이든 할 수 있다.
// 브라우저 매개 공격자에게는 거짓이다 — PTY 를 쓰려면 WebSocket 을 열고 프레임
// 규약을 따라 명령을 타이핑하고 출력을 읽어야 하는데, `POST /api/file/write` 는
// 요청 하나이고 **응답을 읽을 필요가 없다.** 난이도가 다르면 같은 위험이 아니다.
//
// `requestGate` 가 그 요청의 **호출**을 닫는다. 여기는 **닿는 범위**를 닫는다.
// 게이트 하나에 전부 걸면, 게이트가 언젠가 새는 날 파일시스템 전체가 함께 샌다.

// fileRoots 는 이 계층이 닿아도 되는 자리들이다 (FR-FAB-2).
//
// 전부 서버가 이미 아는 값이며 **새 상태를 만들지 않는다.**
//
//	Editor 목록의 루트   편집기의 저장이 이 종단이다 — 여는 자리가 곧 여기다
//	살아 있는 도구의 cwd  터미널에서 `edit <파일>` 로 여는 자리
//	Notes · Plugins      제품이 스스로 쓰는 자리
//	$DONGMINAL_HOME      자기 상태 (설정·워크스페이스)
//
// **홈 디렉터리 전체는 루트가 아니다.** 넣으면 `~/.ssh`·`~/.aws` 가 다시 들어오고,
// 그것이 이 경계가 막으려는 바로 그 경로다.
//
// 매 요청 다시 읽는다 (FR-FAB-4). 도구를 새로 열거나 Editor 를 추가한 직후에 그
// 자리가 막혀 있으면 사용자는 제품이 고장 났다고 읽는다.
func (s *Server) fileRoots() ([]string, error) {
	var out []string
	add := func(p string) {
		if p == "" {
			return
		}
		if r, err := filepath.EvalSymlinks(p); err == nil {
			p = r
		}
		out = append(out, filepath.Clean(p))
	}

	if s.Entries != nil {
		roots, err := s.Entries.Roots()
		if err != nil {
			// FR-FAB-NFR-3: 읽지 못하면 **fail-closed** 다. 읽기 실패로 전부
			// 열리면 그 실패가 곧 우회 경로가 된다.
			return nil, err
		}
		for _, r := range roots {
			add(r)
		}
		if n, err := s.Entries.Notes(); err == nil {
			add(n)
		}
		if p, err := s.Entries.Plugins(); err == nil {
			add(p)
		}
	}
	if s.Tools != nil {
		// `List()` 가 도구 목록의 유일한 공개 창구다. `Cwd(id)` 는 데몬 모드에서
		// RPC 를 지나므로 살아 있는 값이다 (`Get(id).Cwd()` 는 아니다).
		for _, t := range s.Tools.List() {
			id, _ := t["id"].(string)
			if id != "" {
				add(s.Tools.Cwd(id))
			}
		}
	}
	add(s.cfg.DataDir)
	return out, nil
}

// fileUnrestricted 는 경계를 끄는 설정이다 (FR-FAB-5).
//
// 기본은 거짓이다. 참이면 종전 동작(절대경로면 어디든)으로 돌아가며, 그 사실이
// **로그에 한 번 남는다** (FR-FAB-6) — 조용히 열려 있으면 안 된다.
func (s *Server) fileUnrestricted() bool {
	if s.Settings == nil {
		return false
	}
	var cfg struct {
		FileAPIUnrestricted bool `json:"fileApiUnrestricted"`
	}
	if err := json.Unmarshal(s.Settings.get(), &cfg); err != nil {
		return false
	}
	if cfg.FileAPIUnrestricted {
		fileUnrestrictedOnce.Do(func() {
			log.Printf("file: fileApiUnrestricted=true — /api/file/* 의 경계가 꺼져 있습니다")
		})
	}
	return cfg.FileAPIUnrestricted
}

var fileUnrestrictedOnce sync.Once

// fileGuard 는 경로 하나를 허용 루트와 대조하고 **푼 경로**를 돌려준다.
//
// 대조는 `/api/fs/*` 의 것을 그대로 쓴다 (FR-FAB-3) — 두 벌을 만들지 않는다.
// `forWrite` 가 가르는 것은 마지막 조각을 따라가는가다:
//
//	읽기  fsResolveExisting  전량을 푼다. 그 파일이 실재해야 한다
//	쓰기  fsResolveTarget    부모만 푼다. 아직 없는 파일을 만들 수 있어야 한다
//
// 마지막 조각을 따라가지 않는 덕에 링크 자체를 다루는 것이 가능하고, 중간
// 디렉터리가 링크여서 루트를 벗어나는 경우는 걸린다 (FR-EDT-112).
func (s *Server) fileGuard(w http.ResponseWriter, r *http.Request, p string, forWrite bool) (string, bool) {
	if p == "" {
		http.Error(w, "missing path", http.StatusBadRequest)
		return "", false
	}
	if !filepath.IsAbs(p) {
		http.Error(w, "path must be absolute", http.StatusBadRequest)
		return "", false
	}
	if s.fileUnrestricted() {
		return p, true
	}

	roots, err := s.fileRoots()
	if err != nil {
		log.Printf("file: 루트 목록을 읽지 못했다 (%v) — 거절한다", err)
		http.Error(w, "forbidden", http.StatusForbidden)
		return "", false
	}

	resolve := fsResolveExisting
	if forWrite {
		// 쓰기는 **실재 여부**로 갈린다.
		//
		// 아직 없는 파일은 부모만 풀 수 있다 — 마지막 조각을 따라갈 대상이 없다.
		// 그런데 이미 있는 파일이 **심링크**면 그것을 풀지 않고는 어디에 쓰는지
		// 알 수 없다. 지금의 `WriteFileAtomic` 은 임시 파일을 만들어 rename 하므로
		// 링크를 따라가지 않고 대체하지만, **경계가 그 구현 세부에 기대면 안 된다** —
		// 언젠가 제자리 쓰기로 바뀌는 날 이 구멍이 조용히 열린다.
		if _, err := os.Lstat(p); err == nil {
			resolve = fsResolveExisting
		} else {
			resolve = fsResolveTarget
		}
	}
	for _, root := range roots {
		if got, err := resolve(root, p); err == nil {
			return got, true
		}
	}
	// 어느 루트에도 들지 않았다. **목록을 본문에 싣지 않는다** — 흘리면 그것이 곧
	// 다음 시도의 입력이 된다 (FR-ACL-8 승계). 사후 추적은 로그가 한다.
	log.Printf("file denied addr=%s %s path=%q", r.RemoteAddr, r.Method, p)
	http.Error(w, "forbidden", http.StatusForbidden)
	return "", false
}

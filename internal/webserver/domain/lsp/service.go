package lsp

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"dongminal/internal/shared/platform"
	"dongminal/internal/webserver/domain/ext"
)

// Service 는 HTTP 종단이 딛는 표면이다.
//
// 종단이 이것만 알고 프로토콜·프로세스를 모르는 것이 규칙이다 (D-4) — 방향은
// 샌드박스와 같다: httpapi 는 컨테이너 런타임을 알지 않는다.
//
// **서버를 조달하는 일은 여기에 없다** (LSP_PLUGIN_SRS). 무엇이 있고 어디서 오는지는
// 플러그인 선언의 것이며, 이 타입은 그 답을 받아 프로세스를 세운다. 이 패키지에
// 서버 이름이 없는 것이 그 경계다 (FR-EXT-1).
type Service struct {
	// Ext 는 플러그인 계층이다. 확장자를 서버로 풀고 실행 파일을 찾는다.
	Ext *ext.Service

	// Start 는 언어 서버 프로세스를 세운다. 비면 실제 프로세스를 쓴다.
	Start Starter
	// Now 는 시계다. 비면 time.Now — 백오프·TTL 검사가 시간을 쥔다.
	Now func() time.Time
	// OnDiagnostics 는 진단이 왔을 때 부를 함수다 (FR-LSP-32).
	//
	// **도메인 계층은 이것이 SSE 인지 모른다** (D-4) — 배선이 그것을 정한다.
	OnDiagnostics DiagFunc
	// IdleAfter·MaxSessions 가 0 이면 이 패키지의 기본값을 쓴다.
	IdleAfter   time.Duration
	MaxSessions int

	mu sync.Mutex
	// sessions 는 (루트, 팩/서버) → 세션이다 (FR-LSP-13 / FR-EXT-4).
	sessions map[string]*Session
	// failed 는 (루트, 서술자) → 실패 기억이다 (FR-LSP-16, REPO_FIX 02 §3A-4) —
	// 매 요청마다 같은 실패를 되풀이해 프로세스를 띄우지 않는다.
	failed map[string]*failure

	// paths 는 서버가 보관하는 실행 파일 경로 표다 (팩/서버 → 절대경로, §3A-3).
	// pathsFile 은 그 영속 자리(`<dataDir>/lsp-paths.json`)다.
	paths     map[string]string
	pathsFile string

	// extDesc 는 확장자 → 서술자 id 다 (PERFORMANCE_HARDENING_SRS FR-PRF-70).
	//
	// **세션 캐시를 먼저 보기 위한 열쇠다.** 세션은 (루트, 서술자) 로 키잉되는데
	// 서술자를 알려면 `Ext.Resolve` 를 지나야 했고, 그것이 격리 칸 전량 재파싱과
	// `LookPath` 를 뜻했다 — **살아 있는 세션을 쓰는 요청도 매번** 그랬다.
	// 호버는 커서를 움직일 때마다 뜬다 (`AUDIT-go-domain.md` HIGH 3).
	//
	// 이 표만으로 세션을 찾을 수 있으므로 캐시 히트면 `Resolve` 를 아예 부르지
	// 않는다. `Overrides` 는 여기 섞이지 않는다 — 그것은 **실행 파일 자리**를
	// 바꿀 뿐 확장자→서버 배정을 바꾸지 않는다 (`ext.Resolve` 의 `ServerForExt`).
	//
	// 선언이 바뀌면 지운다: `Install` 과 `Shutdown` 이 그 자리다.
	extDesc map[string]string
}

// NewService 는 플러그인 계층 위에 선 Service 다.
func NewService(e *ext.Service) *Service { return &Service{Ext: e} }

// Status 는 서버마다 한 줄의 관측이다. 서버 경로 표로 플러그인 계층에 묻는다 —
// 세션 기동과 같은 표다 (§3A-3).
//
//	이전 동작: 요청이 실은 표(브라우저 localStorage)로 조회했고 기동은 그것을 무시했다
//	새  동작: 서버가 보관한 한 벌을 상태·기동이 함께 쓴다
//	이유:     실행 파일은 서버 기계의 사실이고 세션은 브라우저가 아니라 서버에서 공유된다
func (s *Service) Status() ([]ext.Status, []string) {
	if s.Ext == nil {
		return nil, nil
	}
	return s.Ext.Status(s.locatorOverrides())
}

// Install 은 팩 하나를 조달한다 (FR-EXT-31).
//
// 조달을 시도했으면 그 팩의 실패 기억을 지운다 (FR-LSP-16). 성공이든 실패든 지우는
// 이유는, 실패한 조달도 상태를 바꿀 수 있고 무엇보다 **고쳐 놓고도 안 되는 것**이
// 사용자가 우리를 못 믿게 되는 자리이기 때문이다.
func (s *Service) Install(ctx context.Context, packID string) ext.Outcome {
	if s.Ext == nil {
		return ext.Outcome{Reason: "플러그인 계층이 배선되지 않았습니다"}
	}
	out := s.Ext.Install(ctx, packID)
	s.forgetPack(packID)
	return out
}

// forgetPack 은 그 팩이 낸 서버들의 실패 기억을 지운다.
//
// 키가 `팩/서버` 이므로 팩 하나가 여러 기억을 남길 수 있다 (FR-EXT-5).
func (s *Service) forgetPack(packID string) {
	prefix := packID + "/"
	s.mu.Lock()
	defer s.mu.Unlock()
	// FR-PRF-70: 선언이 바뀔 수 있는 자리다 — 확장자→서술자 표를 버린다.
	// 다음 요청이 `Resolve` 를 한 번 더 지날 뿐이고, 붙들고 있으면 새 팩이
	// 가져간 확장자가 옛 서버를 계속 가리킨다.
	s.extDesc = nil
	for k, f := range s.failed {
		if strings.HasPrefix(f.desc, prefix) {
			delete(s.failed, k)
		}
	}
}

// 경로 표의 거부 사유 (§3A-3). httpapi 가 코드를 고른다.
var (
	ErrUnknownServer   = errors.New("lsp: 모르는 서버 id")
	ErrPathNotAbsolute = errors.New("lsp: 절대경로가 아니다")
	ErrPathsSave       = errors.New("lsp: 경로 표를 저장하지 못했다")
)

type pathsFileBody struct {
	Paths map[string]string `json:"paths"`
}

// LoadPaths 는 영속된 경로 표를 읽는다. 파일이 없으면 빈 표다 — 첫 기동이다.
func (s *Service) LoadPaths(file string) error {
	s.mu.Lock()
	s.pathsFile = file
	s.mu.Unlock()
	raw, err := os.ReadFile(file)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	var body pathsFileBody
	if err := json.Unmarshal(raw, &body); err != nil {
		return fmt.Errorf("%s: %w", file, err)
	}
	s.mu.Lock()
	s.paths = body.Paths
	s.mu.Unlock()
	return nil
}

// Paths 는 경로 표의 사본이다.
func (s *Service) Paths() map[string]string {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make(map[string]string, len(s.paths))
	for k, v := range s.paths {
		out[k] = v
	}
	return out
}

// SetPaths 는 경로 표 전체를 바꾼다 (§3A-3). 키는 지금 서술자 id(팩/서버)여야 하고,
// 값은 절대경로이거나 빈 문자열(삭제)이다. 파일 존재는 보지 않는다 — 상태 조회가
// "없음" 을 보인다. 저장에 성공하면 값이 바뀐 서술자의 세션을 모든 루트에서 정지하고
// 실패 기억을 지운다. 바뀌지 않은 서술자의 세션은 남는다.
func (s *Service) SetPaths(next map[string]string) (map[string]string, error) {
	known := map[string]bool{}
	if s.Ext != nil {
		sts, _ := s.Ext.Status(nil)
		for _, st := range sts {
			known[st.Pack+"/"+st.ID] = true
		}
	}
	clean := map[string]string{}
	for k, v := range next {
		if !known[k] {
			return nil, fmt.Errorf("%w: %q", ErrUnknownServer, k)
		}
		if v == "" {
			continue
		}
		if !filepath.IsAbs(v) {
			return nil, fmt.Errorf("%w: %q", ErrPathNotAbsolute, v)
		}
		clean[k] = v
	}
	s.mu.Lock()
	file := s.pathsFile
	s.mu.Unlock()
	if file != "" {
		data, err := json.MarshalIndent(pathsFileBody{Paths: clean}, "", "  ")
		if err == nil {
			err = platform.WriteStateFile(file, data, 0o644)
		}
		if err != nil {
			return nil, fmt.Errorf("%w: %v", ErrPathsSave, err)
		}
	}
	s.mu.Lock()
	changed := map[string]bool{}
	for k, v := range clean {
		if s.paths[k] != v {
			changed[k] = true
		}
	}
	for k := range s.paths {
		if _, ok := clean[k]; !ok {
			changed[k] = true
		}
	}
	s.paths = clean
	var stop []*Session
	for k, sess := range s.sessions {
		if changed[sess.desc] {
			stop = append(stop, sess)
			delete(s.sessions, k)
		}
	}
	for k, f := range s.failed {
		if changed[f.desc] {
			delete(s.failed, k)
		}
	}
	s.mu.Unlock()
	for _, sess := range stop {
		sess.Close()
	}
	return s.Paths(), nil
}

// locatorOverrides 는 경로 표를 플러그인 계층의 표(서버 id → 경로)로 옮긴다.
func (s *Service) locatorOverrides() map[string]string {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make(map[string]string, len(s.paths))
	for desc, p := range s.paths {
		if i := strings.LastIndex(desc, "/"); i >= 0 {
			out[desc[i+1:]] = p
		}
	}
	return out
}

// exeKeyLocked 는 세션 키의 exe 조각이다 — 표에 경로가 있으면 그것, 없으면 default.
func (s *Service) exeKeyLocked(descID string) string {
	if p := s.paths[descID]; p != "" {
		return p
	}
	return "default"
}

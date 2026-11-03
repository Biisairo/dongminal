package lsp

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
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
	// IdleAfter·MaxSessions 가 0 이면 이 패키지의 기본값을 쓴다.
	IdleAfter   time.Duration
	MaxSessions int
	// WatchMax 는 끼워 넣기 한 번에 싣는 변경 수의 상한이다 (FR-CMR-113). 0 이면 DefaultWatchMax.
	WatchMax int

	mu sync.Mutex
	// tunnels 는 열린 통로들이고, tunnelPending 은 띄우는 중인 통로 수다
	// (CODEMIRROR_MIGRATION_SRS FR-CMR-102 — 상한은 둘을 합쳐 센다).
	tunnels       map[*tunnel]struct{}
	tunnelPending int

	// paths 는 서버가 보관하는 실행 파일 경로 표다 (팩/서버 → 절대경로, §3A-3).
	// pathsFile 은 그 영속 자리(`<dataDir>/lsp-paths.json`)다.
	paths     map[string]string
	pathsFile string
}

// NewService 는 플러그인 계층 위에 선 Service 다.
func NewService(e *ext.Service) *Service { return &Service{Ext: e} }

// Status 는 서버마다 한 줄의 관측이다. 서버 경로 표로 플러그인 계층에 묻는다 —
// 통로 기동과 같은 표다 (§3A-3).
//
//	이전 동작: 요청이 실은 표(브라우저 localStorage)로 조회했고 기동은 그것을 무시했다
//	새  동작: 서버가 보관한 한 벌을 상태·기동이 함께 쓴다
//	이유:     실행 파일은 서버 기계의 사실이다
func (s *Service) Status() ([]ext.Status, []string) {
	if s.Ext == nil {
		return nil, nil
	}
	return s.Ext.Status(s.locatorOverrides())
}

// Install 은 팩 하나를 조달한다 (FR-EXT-31). 새 통로는 다음 연결에서 새 실행 파일을 찾는다.
func (s *Service) Install(ctx context.Context, packID string) ext.Outcome {
	if s.Ext == nil {
		return ext.Outcome{Reason: "플러그인 계층이 배선되지 않았습니다"}
	}
	return s.Ext.Install(ctx, packID)
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
// "없음" 을 보인다. 저장에 성공하면 값이 바뀐 서술자의 통로를 모든 루트에서 닫는다.
// 바뀌지 않은 서술자의 통로는 남는다.
func (s *Service) SetPaths(next map[string]string) (map[string]string, error) {
	// 아는 id 는 선언에서 얻는다 — 탐색(Status)을 돌리지 않는다 (FR-OPT-6-4).
	known := map[string]bool{}
	if s.Ext != nil {
		known = s.Ext.ServerIDs()
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
	var stop []*tunnel
	for t := range s.tunnels {
		if changed[t.desc] {
			stop = append(stop, t)
		}
	}
	s.mu.Unlock()
	// §11.6 R: 옛 실행 파일로 선 통로를 닫는다 — 브라우저는 다음 쓰임에 새 실행 파일로 다시 연다.
	for _, t := range stop {
		t.Close()
	}
	return s.Paths(), nil
}

// locatorOverrides 는 경로 표의 사본이다 — 키(팩/서버)를 플러그인 계층이 그대로 쓴다.
//
//	이전 동작: 키를 서버 id 로 줄여 넘겼다 — 다른 팩의 같은 서버 id 에도 경로가 번졌다
//	새  동작: 팩/서버 그대로
//	이유:     FR-OPT-6-4 (DOM-13)
func (s *Service) locatorOverrides() map[string]string {
	return s.Paths()
}

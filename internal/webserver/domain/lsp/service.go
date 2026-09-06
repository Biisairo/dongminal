package lsp

import (
	"context"
	"sync"
	"time"

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
	// Overrides 는 설정이 적은 절대경로 표다 (FR-LSP-4b). 세션을 세울 때의
	// 탐색이 이것을 딛는다 — 상태 조회는 요청이 실은 표를 따로 받는다.
	Overrides map[string]string
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
	// failed 는 기동 실패의 기억이다 (FR-LSP-16) — 매 요청마다 같은 실패를
	// 되풀이해 프로세스를 띄우지 않는다.
	failed map[string]error
}

// NewService 는 플러그인 계층 위에 선 Service 다.
func NewService(e *ext.Service) *Service { return &Service{Ext: e} }

// Status 는 서버마다 한 줄의 관측이다. 플러그인 계층에 그대로 묻는다.
func (s *Service) Status(overrides map[string]string) ([]ext.Status, []string) {
	if s.Ext == nil {
		return nil, nil
	}
	return s.Ext.Status(overrides)
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
	for k := range s.failed {
		// key 는 `루트\x00팩/서버` 가 아니라 서술자 쪽만 담는다 (remember 참조).
		if k == packID || len(k) > len(prefix) && k[:len(prefix)] == prefix {
			delete(s.failed, k)
		}
	}
}

// Package gitapi는 /api/git/* HTTP 핸들러다. internal/webserver/httpapi 의
// Server 가 GitServer 를 보유하고 라우팅만 위임한다.
//
// 별도 패키지인 이유는 Go 의 메서드-패키지 제약이다 — 핸들러 48개가 *Server
// 메서드였던 탓에 파일만 옮길 수 없었고, 리시버를 *GitServer 로 바꿔야 했다.
// 대신 의존 표면이 드러났다: git 도메인 외에 필요한 것은 아래 세 인터페이스의
// 메서드 네 개뿐이다.
package gitapi

import (
	"dongminal/internal/webserver/domain/git/store"
	"dongminal/internal/webserver/domain/worktree"
)

// WorkspaceStore는 핀 목록을 읽고 쓰기 위한 최소 표면이다 (git_pins.go).
type WorkspaceStore interface {
	Snapshot() ([]byte, uint64)
	Save(blob []byte, ifMatch string) (uint64, error)
}

// Broadcaster는 핀 변경을 브라우저에 알리기 위한 최소 표면이다.
type Broadcaster interface {
	Broadcast(payload []byte) int
}

// ToolLocator는 follow 대상 도구의 cwd 를 해석하기 위한 최소 표면이다.
type ToolLocator interface {
	Cwd(id string) string
}

// GitServer는 /api/git/* 핸들러의 리시버다. 필드는 핸들러가 실제로 쓰는 것만
// 담는다 — 넓은 Server 를 그대로 들고 오면 경계를 옮긴 의미가 없다.
type GitServer struct {
	Git      *store.Store
	Work     WorkspaceStore
	Commands Broadcaster
	Tools    ToolLocator

	// gitUndo 는 방금 만든 커밋을 되돌릴 권한을 쥔다 (FR-GIT-83). 제로값도 쓸 수
	// 있다 — 클라이언트 타이머만으로는 만료를 강제할 수 없으므로 이 자리가 없어서
	// undo 가 무제한이 되는 경로를 만들지 않는다.
	gitUndo gitUndoStore

	// gitJobs 는 원격 작업(fetch/pull/push)의 수명을 쥔다 (FR-GIT-101·102).
	// 제로값도 쓸 수 있다 — 첫 사용에 만들어지고, Git 이 없으면 만들지 않는다.
	gitJobs gitJobHolder

	// UserWorktrees 는 사용자 worktree 영역의 Manager 다 (FR-WKT-13) —
	// $DONGMINAL_HOME/git-worktrees 를 자기 root 로 갖는, Run 격리 Manager 와는
	// 별개의 인스턴스다. worktree 의 git 실행은 전부 여기(domain/worktree)를 지난다
	// (FR-GIT-246) — domain/git 의 화이트리스트를 넓히지 않는다. nil 이면
	// Worktrees 탭의 목록·생성·제거가 전부 503 이다.
	UserWorktrees *worktree.Manager
	// RunWorktreeRoot 는 Run 격리 영역의 root 경로 문자열뿐이다 (FR-GIT-240 소유
	// 판정) — Run 의 Manager 전체를 들고 오지 않는다. 이 패키지가 그 Manager 로
	// git 을 실행할 일이 없기 때문이다(worktree 실행은 UserWorktrees 하나로 충분).
	RunWorktreeRoot string
}

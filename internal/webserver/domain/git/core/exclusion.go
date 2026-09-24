package core

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// 쓰기 한 번의 단계별 마감이다 (REPO_FIX 01 §5.5). 쓰기 단계는 DefaultTimeout 이다.
// 단계마다 마감 ctx 하나를 만들고 그 안의 git 전부가 그것을 쓴다 — 호출 수와
// 무관하게 단계 절대 상한이 마감+2·KillGrace 로 묶인다.
const (
	// LockWait 는 잠금 하나를 기다리는 상한이다. 넘으면 409 repo_busy 다.
	LockWait = 5 * time.Second
	// PrePhaseTimeout 은 쓰기 전 검사·조회 전체의 마감이다. 요청 ctx 에서 파생한다.
	PrePhaseTimeout = 10 * time.Second
	// PostPhaseTimeout 은 쓰기 뒤 무효화·재조회·lock 판정 전체의 마감이다.
	PostPhaseTimeout = 15 * time.Second
	// ManagerWriteTimeout 은 worktree·submodule Manager 경유 쓰기 단계의 마감이다.
	ManagerWriteTimeout = 180 * time.Second
)

// ExclusionKey 는 배타 키다 (§5.1). 존재하는 가장 가까운 조상까지 심링크를 풀고
// 나머지 조각을 붙인다 — 밖에서 지운 경로도 키가 나온다.
//
// **배타 키 전용이다.** Job.Repo·store 키·응답 repo 는 RepoRoot 출력 그대로 둔다
// (repo.go 의 "정규화하지 않는다" 계약). 키만 정규화하는 이유는 `/var` 와
// `/private/var` 로 들어온 같은 저장소가 서로 다른 잠금을 잡으면 배타가 뜻을 잃기
// 때문이다.
func ExclusionKey(p string) string {
	clean := filepath.Clean(p)
	dir := clean
	var tail []string
	for {
		resolved, err := filepath.EvalSymlinks(dir)
		if err == nil {
			return filepath.Join(append([]string{resolved}, tail...)...)
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			// 루트까지 풀지 못했다(권한 등) — 표기만 다듬은 원본이 키다.
			return clean
		}
		tail = append([]string{filepath.Base(dir)}, tail...)
		dir = parent
	}
}

// IndexLockPath 는 root 의 index.lock 절대 경로다 (§7.2). 링크드 worktree 는 자기
// gitdir 아래를 가리킨다 — `.git/index.lock` 으로 짐작하면 그 경우가 틀린다.
func (s *Service) IndexLockPath(ctx context.Context, root string) (string, error) {
	out, err := s.Exec(ctx, root, "rev-parse", "--git-path", "index.lock")
	if err != nil {
		return "", err
	}
	p := strings.TrimSpace(out.Stdout)
	if p == "" {
		return "", fmt.Errorf("%w: rev-parse 가 index.lock 경로를 주지 않았다: %s", ErrNotRepo, root)
	}
	if !filepath.IsAbs(p) {
		p = filepath.Join(root, p)
	}
	return filepath.Clean(p), nil
}

// LockInfo 는 index_locked 실패에 싣는 lock 정보다 (§7.2). 동기 응답과 잡 결과가
// 같은 모양을 쓴다. 파일이 이미 없으면 MtimeUnixMs 가 nil 이다 — 프런트는 지울 것
// 없이 "다시 시도" 로 안내한다.
type LockInfo struct {
	Path        string `json:"path"`
	MtimeUnixMs *int64 `json:"mtimeUnixMs,omitempty"`
}

// IndexLockInfo 는 root 의 index.lock 경로와 mtime 이다. 경로를 구하지 못하면 nil 이다.
func (s *Service) IndexLockInfo(ctx context.Context, root string) *LockInfo {
	p, err := s.IndexLockPath(ctx, root)
	if err != nil {
		return nil
	}
	info := &LockInfo{Path: p}
	if st, err := os.Lstat(p); err == nil {
		ms := st.ModTime().UnixMilli()
		info.MtimeUnixMs = &ms
	}
	return info
}

// IndexLockedStderr 는 stderr 가 index.lock 을 만들지 못한 실패인가다. 동기 실행의
// 분류(classify)와 잡의 완료 처리가 같은 판정을 쓴다.
func IndexLockedStderr(stderr string) bool {
	low := strings.ToLower(stderr)
	return strings.Contains(low, "unable to create '") && strings.Contains(low, "index.lock': file exists")
}

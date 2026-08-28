package gitapi

import (
	"dongminal/internal/webserver/domain/wsentry"
)

// 핀 목록은 workspace.json 최상위 `git.pinned[]` 에 산다 (FR-GIT-11, O1). 창
// 트리 안이 아닌 이유는 핀이 창과 무관하게 워크스페이스 하나에 하나이기 때문이다.
//
// 읽기·쓰기의 실체는 domain/wsentry 다 (FR-EDT-116, D-17). 그 패키지로 옮긴
// 이유는 핀 하나를 바꿀 때 같은 경로의 Editor 행이 **같은 저장 안에서** 함께
// 바뀌어야 하기 때문이다 (FR-EDT-31·32·35). 핀의 기존 동작 — 멱등, 문자열 일치
// 제거, 다른 키 보존, ErrStale 1회 재시도, workspace_changed 브로드캐스트 — 은
// 그대로다.

// entries 는 두 목록의 소유자다. RepoRoot 를 주입하지 않는다 — 핀 경로가 쓰는
// 규칙(LinkPinAdd·LinkPinRemove)은 저장소 루트 판정을 필요로 하지 않는다.
// 판정이 필요한 쪽은 Editor 추가(FR-EDT-33)이고 그것은 httpapi 가 조립한다.
func (s *GitServer) entries() *wsentry.Store {
	return &wsentry.Store{Work: s.Work, Commands: s.Commands}
}

// gitPinsRead 는 workspace.json 의 git.pinned[] 를 읽는다. 없으면 빈 목록이다.
func (s *GitServer) gitPinsRead() ([]string, error) {
	l, err := s.entries().Read()
	return l.Pinned, err
}

// gitPinsMutate 는 git.pinned[] **만** 고쳐 저장한다. 연동을 지나지 않는 경로다 —
// 지나야 하는 pin/unpin 은 wsentry 의 PinAdd·PinRemove 를 직접 쓴다.
func (s *GitServer) gitPinsMutate(fn func([]string) []string) ([]string, error) {
	l, err := s.entries().Mutate(func(cur wsentry.Lists) wsentry.Lists {
		cur.Pinned = fn(cur.Pinned)
		return cur
	})
	return l.Pinned, err
}

// Package wsentry 는 workspace.json 최상위의 두 목록 — `git.pinned[]` 와
// `editors.list[]` — 을 함께 소유한다 (EDITOR_TAB_SRS FR-EDT-116, D-17).
//
// 두 목록이 한 패키지에 있는 이유는 연동(FR-EDT-31~34) 때문이다. 핀 하나를
// 더하면 같은 경로의 Editor 행이 함께 생겨야 하고, 그 둘이 **따로** 저장되면 그
// 사이에 다른 브라우저가 절반만 반영된 상태를 읽는다 (FR-EDT-35). 그래서 변경은
// 언제나 한 번의 read-modify-write 다.
//
// git 을 실행하지 않는다 — 저장소 루트 판정은 `RepoRootFn` 으로 주입받는다.
// 그래야 httpapi 가 gitapi 를 import 하지 않고도 FR-EDT-33 을 판정한다 (D-17).
package wsentry

import (
	"context"
	"errors"
	"os"
	"path/filepath"
)

// WorkspaceStore 는 두 목록을 읽고 쓰기 위한 최소 표면이다. *workspace.Manager 가
// 이것을 만족한다.
type WorkspaceStore interface {
	Snapshot() ([]byte, uint64)
	Save(blob []byte, ifMatch string) (uint64, error)
}

// Broadcaster 는 목록 변경을 다른 브라우저 창에 알리기 위한 최소 표면이다.
type Broadcaster interface {
	Broadcast(payload []byte) int
}

// RepoRootFn 은 경로가 속한 git 저장소의 루트를 답한다 (FR-EDT-33 판정용).
// store.Store.RepoRoot 가 이 모양이다.
type RepoRootFn func(ctx context.Context, path string) (string, error)

// HomeFn 은 root 에디터의 경로다 (FR-EDT-13). nil 이면 os.UserHomeDir 이다 —
// 저장하지 않고 서버의 홈에서 파생한다 (FR-EDT-17).
type HomeFn func() (string, error)

// Lists 는 한 번의 저장에 함께 담기는 두 목록이다.
type Lists struct {
	Pinned  []string
	Editors []string
}

var (
	ErrNotAbsolute = errors.New("경로가 절대경로가 아니다")
	ErrNotFound    = errors.New("경로가 없다")
	ErrNotDir      = errors.New("디렉터리가 아니다")
	ErrUnavailable = errors.New("workspace 를 쓸 수 없다")
)

// Store 는 두 목록의 소유자다. 제로값은 쓸 수 없다 — Work 가 없으면 모든 변경이
// ErrUnavailable 이다.
type Store struct {
	Work     WorkspaceStore
	Commands Broadcaster
	// RepoRoot 가 nil 이면 FR-EDT-33 의 연동만 서지 않는다. Editor 행 자체는
	// 그대로 추가된다 — git 이 없는 환경에서 목록이 통째로 막히지 않는다.
	RepoRoot RepoRootFn
	HomeFn   HomeFn
	// NotesDir 은 메모 루트가 놓일 자리다 (NOTES_LIVE_EXPLORER_SRS FR-NOT-1).
	// 비면 메모장 표면이 없다 (FR-NOT-11) — 홈과 달리 이것 하나가 없다고
	// Editor 표면 전체가 죽지는 않는다.
	NotesDir string
}

// Home 은 정규화된 홈 디렉터리다. 저장하지 않고 매번 파생한다 (FR-EDT-17).
func (s *Store) Home() (string, error) {
	fn := s.HomeFn
	if fn == nil {
		fn = os.UserHomeDir
	}
	h, err := fn()
	if err != nil {
		return "", err
	}
	return NormalizePath(h), nil
}

// Notes 는 정규화된 메모 루트다 (FR-NOT-1·2). 홈과 같이 저장하지 않고 매번
// 파생하며, **없으면 만든다** — 메모장 행을 눌렀을 때 비로소 만드는 것이 아니라
// 경로를 묻는 자리가 곧 보장하는 자리다. 그래야 목록 조회 하나만으로 창·탐색기·
// 파일 조작이 전부 설 수 있다.
func (s *Store) Notes() (string, error) {
	if s.NotesDir == "" {
		return "", ErrUnavailable
	}
	if err := os.MkdirAll(s.NotesDir, 0o755); err != nil {
		return "", err
	}
	return NormalizePath(s.NotesDir), nil
}

// Read 는 저장된 두 목록을 준다.
func (s *Store) Read() (Lists, error) {
	if s.Work == nil {
		return Lists{}, ErrUnavailable
	}
	raw, _ := s.Work.Snapshot()
	_, l, err := parse(raw)
	return l, err
}

// List 는 `{home, list}` 다 (FR-EDT-29). home 은 list 에 들어 있지 않다.
func (s *Store) List() (string, []string, error) {
	home, err := s.Home()
	if err != nil {
		return "", nil, err
	}
	l, err := s.Read()
	if err != nil {
		return "", nil, err
	}
	return home, l.Editors, nil
}

// Roots 는 `[home, notes, ...editors.list]` 다 — 파일 조작이 신뢰할 수 있는 루트의
// 전부이며 (FR-EDT-113), 창 재조정이 딛는 집합과 같다 (FR-EDT-42).
//
// FR-NOT-4: 메모 루트가 여기 드는 **한 줄**이 메모장의 전부다. 이 목록이 곧 루트
// 가드(fsRoot)이므로, 드는 순간 메모 루트 아래의 조회·생성·이름변경·삭제·전송이
// 함께 열린다. 메모 루트를 쓸 수 없는 환경(FR-NOT-11)에서는 그냥 빠진다.
func (s *Store) Roots() ([]string, error) {
	home, list, err := s.List()
	if err != nil {
		return nil, err
	}
	out := make([]string, 0, len(list)+2)
	out = append(out, home)
	if notes, err := s.Notes(); err == nil {
		out = append(out, notes)
	}
	return append(out, list...), nil
}

// EditorAdd 는 Editor 행을 더한다 (FR-EDT-23~25·33).
//
// 경로는 EvalSymlinks + Clean 하나로 정규화한다 (FR-EDT-24) — Git 핀 추가와 같은
// 함수를 지나야 연동의 "같은 경로" 짝짓기가 성립한다.
func (s *Store) EditorAdd(ctx context.Context, path string) (Lists, error) {
	if !filepath.IsAbs(path) {
		return Lists{}, ErrNotAbsolute
	}
	norm := NormalizePath(path)
	st, err := os.Stat(norm)
	if err != nil {
		return Lists{}, ErrNotFound
	}
	if !st.IsDir() {
		return Lists{}, ErrNotDir
	}
	// 파일시스템 루트는 행이 될 수 없다. 행이 되면 그 루트를 기준으로 삼는
	// 파일 조작이 **파일시스템 전체**를 대상으로 삼아 D-16 의 상한이 통째로
	// 무력해진다.
	if filepath.Dir(norm) == norm {
		return Lists{}, ErrNotDir
	}
	home, err := s.Home()
	if err != nil {
		return Lists{}, err
	}
	// 홈은 root 행이 이미 대표한다 — 오류가 아니라 무변경이다 (FR-EDT-16).
	// 저장을 하지 않으므로 rev 도 오르지 않는다.
	if norm == home {
		return s.Read()
	}
	// FR-NOT-5: 메모 루트도 고정 행이 대표하므로 같다. 막지 않으면 같은 경로가
	// 고정 행과 일반 행에 두 번 서고, 창 재조정은 그 둘을 한 창으로 접는다 —
	// 지울 수 없는 행 하나가 목록에 남는다.
	if notes, err := s.Notes(); err == nil && norm == notes {
		return s.Read()
	}
	return s.Mutate(func(cur Lists) Lists {
		return LinkEditorAdd(cur, norm, home, s.isRepoRoot(ctx, norm))
	})
}

// isRepoRoot 는 그 경로가 **저장소의 루트인지**를 본다. 저장소 안이지만 루트가
// 아니면 거짓이다 — 핀은 루트로 정규화되므로 경로가 어긋나 대칭이 깨진다
// (FR-EDT-33).
func (s *Store) isRepoRoot(ctx context.Context, norm string) bool {
	if s.RepoRoot == nil {
		return false
	}
	root, err := s.RepoRoot(ctx, norm)
	if err != nil {
		return false
	}
	return NormalizePath(root) == norm
}

// EditorRemove 는 문자열 완전 일치로 지운다 (FR-EDT-26). 경로를 다시 정규화하지
// 않는다 — 사라진 디렉터리의 행도 지울 수 있어야 한다.
func (s *Store) EditorRemove(path string) (Lists, error) {
	home, err := s.Home()
	if err != nil {
		return Lists{}, err
	}
	return s.Mutate(func(cur Lists) Lists {
		return LinkEditorRemove(cur, path, home)
	})
}

// EditorReorder 는 (src, target, before) 델타를 적용한다 (FR-EDT-27).
func (s *Store) EditorReorder(src, target string, before bool) ([]string, error) {
	l, err := s.Mutate(func(cur Lists) Lists {
		cur.Editors = reorder(cur.Editors, src, target, before)
		return cur
	})
	return l.Editors, err
}

// PinAdd 는 핀을 더하고 같은 경로의 Editor 행을 함께 만든다 (FR-EDT-31·37).
// 저장한 정규 경로를 함께 돌려준다 — 호출자가 응답에 그대로 실어야 한다.
func (s *Store) PinAdd(root string) (string, Lists, error) {
	norm := NormalizePath(root)
	home, err := s.Home()
	if err != nil {
		// 홈을 모르면 홈 예외(FR-EDT-37)를 적용할 수 없다. 핀 자체를 막지는
		// 않는다 — 빈 문자열은 어떤 경로와도 같지 않다.
		home = ""
	}
	l, err := s.Mutate(func(cur Lists) Lists {
		return LinkPinAdd(cur, norm, home)
	})
	return norm, l, err
}

// PinRemove 는 문자열 완전 일치로 핀을 지우고 같은 경로의 Editor 행을 함께
// 지운다 (FR-EDT-32). 정규화하지 않는 이유는 EditorRemove 와 같다.
func (s *Store) PinRemove(path string) (Lists, error) {
	home, err := s.Home()
	if err != nil {
		home = ""
	}
	return s.Mutate(func(cur Lists) Lists {
		return LinkPinRemove(cur, path, home)
	})
}

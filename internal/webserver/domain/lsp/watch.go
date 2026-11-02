package lsp

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"sync"

	"dongminal/internal/shared/dmlog"
)

// LSP FileChangeType (CODEMIRROR_MIGRATION_SRS FR-CMR-112).
const (
	WatchCreated = 1
	WatchChanged = 2
	WatchDeleted = 3
)

// DefaultWatchMax 는 끼워 넣기 한 번에 싣는 변경 수의 기본 상한이다 (`LSP_WATCH_MAX`, FR-CMR-113).
const DefaultWatchMax = 2000

// FileEvent 는 열리지 않은 파일의 변경 하나다.
type FileEvent struct {
	Path string
	Type int
}

type watchChange struct {
	URI  string `json:"uri"`
	Type int    `json:"type"`
}

type watchNote struct {
	JSONRPC string `json:"jsonrpc"`
	Method  string `json:"method"`
	Params  struct {
		Changes []watchChange `json:"changes"`
	} `json:"params"`
}

func (s *Service) watchMax() int {
	if s.WatchMax > 0 {
		return s.WatchMax
	}
	return DefaultWatchMax
}

// NotifyFiles 는 열린 통로마다 그 루트 아래의 변경을 `workspace/didChangeWatchedFiles` 하나로
// 끼워 넣는다 (FR-CMR-110·111·113). 루트 아래의 것이 없으면 보내지 않는다. 통로의 줄에 넣을
// 뿐 기다리지 않는다 — 한 서버가 stdin 을 읽지 않아도 다른 통로와 호출자가 막히지 않는다.
func (s *Service) NotifyFiles(events []FileEvent) {
	if len(events) == 0 {
		return
	}
	s.mu.Lock()
	tunnels := s.tunnelsLocked()
	s.mu.Unlock()
	max := s.watchMax()
	for _, t := range tunnels {
		n := watchNote{JSONRPC: "2.0", Method: "workspace/didChangeWatchedFiles"}
		for _, e := range events {
			if len(n.Params.Changes) >= max {
				break
			}
			if underRoot(t.root, e.Path) {
				n.Params.Changes = append(n.Params.Changes, watchChange{URI: pathToURI(e.Path), Type: e.Type})
			}
		}
		if len(n.Params.Changes) == 0 {
			continue
		}
		body, err := json.Marshal(n)
		if err != nil {
			continue
		}
		if !t.enqueue(body) && t.ready.Load() {
			dmlog.Warnf(nil, "lsp: 끼워 넣기 줄이 찼다 (%s) — 변경 %d개를 버린다", t.root, len(n.Params.Changes))
		}
	}
}

// NameStatus 는 두 커밋 사이에서 바뀐 파일 하나다 (`git diff-tree --name-status`).
type NameStatus struct {
	Status   string // A D M R C T
	Path     string
	OrigPath string
}

// RepoSnap 은 저장소 하나의 관측이다. Files 는 작업 트리 변경(저장소 상대 경로 → 새 파일인가)이다.
type RepoSnap struct {
	Head  string
	Files map[string]bool
}

// RepoView 는 RepoWatch 가 딛는 git 관측이다. lsp 는 git 을 모른다 — 합성 루트가 채운다.
type RepoView interface {
	Snapshot(repo string) (RepoSnap, bool)
	NameStatus(ctx context.Context, repo, from, to string) ([]NameStatus, error)
}

// FileNotifier 는 변경을 받는 쪽이다 (Service).
type FileNotifier interface {
	NotifyFiles(events []FileEvent)
}

// RepoWatch 는 저장소마다 직전 관측을 기억하고, 저장소가 바뀌면 바뀐 파일 목록을 알린다 (FR-CMR-111).
type RepoWatch struct {
	View RepoView
	Out  FileNotifier
	// Exists 는 지금 디스크에 있는가다. 비면 os.Stat.
	Exists func(path string) bool

	mu   sync.Mutex
	last map[string]RepoSnap
}

// Seen 은 그 저장소의 기준선을 적는다. 알리지 않는다 (gitwatch 의 첫 표명).
func (w *RepoWatch) Seen(repo string) {
	cur, ok := w.View.Snapshot(repo)
	if !ok {
		return
	}
	w.mu.Lock()
	if w.last == nil {
		w.last = map[string]RepoSnap{}
	}
	w.last[repo] = cur
	w.mu.Unlock()
}

// Changed 는 git_changed 가 온 저장소의 바뀐 파일을 알린다. 관측이 없으면 아무것도 하지 않는다.
func (w *RepoWatch) Changed(repo string) {
	cur, ok := w.View.Snapshot(repo)
	if !ok {
		return
	}
	w.mu.Lock()
	if w.last == nil {
		w.last = map[string]RepoSnap{}
	}
	prev, had := w.last[repo]
	w.last[repo] = cur
	w.mu.Unlock()

	var ns []NameStatus
	if had && prev.Head != "" && cur.Head != "" && prev.Head != cur.Head {
		got, err := w.View.NameStatus(context.Background(), repo, prev.Head, cur.Head)
		if err != nil {
			dmlog.Warnf(nil, "lsp: %s 의 %s..%s 변경 목록을 얻지 못했다: %v", repo, prev.Head, cur.Head, err)
		}
		ns = got
	}
	var pp *RepoSnap
	if had {
		pp = &prev
	}
	exists := w.Exists
	if exists == nil {
		exists = func(p string) bool { _, err := os.Stat(p); return err == nil }
	}
	if evs := repoEvents(repo, pp, cur, ns, exists); len(evs) > 0 {
		w.Out.NotifyFiles(evs)
	}
}

// repoEvents 는 name-status ∪ 직전 작업 트리 집합 ∪ 지금 작업 트리 집합이다 (FR-CMR-111·112).
// 지금 디스크에 없으면 Deleted, 새 파일이라는 근거가 하나라도 있으면 Created, 그 밖은 Changed 다.
func repoEvents(repo string, prev *RepoSnap, cur RepoSnap, ns []NameStatus, exists func(string) bool) []FileEvent {
	created := map[string]bool{}
	mark := func(rel string, isNew bool) {
		if rel == "" {
			return
		}
		created[rel] = created[rel] || isNew
	}
	for _, n := range ns {
		switch n.Status {
		case "A":
			mark(n.Path, true)
		case "R":
			mark(n.OrigPath, false)
			mark(n.Path, true)
		case "C":
			mark(n.Path, true)
		default:
			mark(n.Path, false)
		}
	}
	if prev != nil {
		for rel := range prev.Files {
			mark(rel, false)
		}
	}
	for rel, isNew := range cur.Files {
		mark(rel, isNew)
	}
	out := make([]FileEvent, 0, len(created))
	for rel, isNew := range created {
		p := filepath.Join(repo, filepath.FromSlash(rel))
		typ := WatchChanged
		switch {
		case !exists(p):
			typ = WatchDeleted
		case isNew:
			typ = WatchCreated
		}
		out = append(out, FileEvent{Path: p, Type: typ})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Path < out[j].Path })
	return out
}

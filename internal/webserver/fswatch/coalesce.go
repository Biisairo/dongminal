// Package fswatch 는 화면에 보이는 디렉터리를 비재귀로 감시해 바뀐 항목을 알린다
// (EDITOR_LIVE_RELOAD_SRS 묶음 W).
//
// 규칙은 VS Code 의 비재귀 감시자(`src/vs/platform/files/node/watcher/nodejs/
// nodejsWatcherLib.ts`)와 병합(`src/vs/platform/files/common/watcher.ts`)을 옮긴
// 것이다 (D-6). 상수 이름 옆에 원래 이름을 적는다.
package fswatch

import (
	"path/filepath"
	"sort"
	"strings"
)

// Kind 는 병합한 뒤의 변화 종류다.
type Kind uint8

const (
	Added Kind = iota + 1
	Updated
	Deleted
)

func (k Kind) String() string {
	switch k {
	case Added:
		return "added"
	case Updated:
		return "updated"
	case Deleted:
		return "deleted"
	}
	return ""
}

// Change 는 경로 하나의 변화다.
type Change struct {
	Path string
	Kind Kind
}

// Coalesce 는 한 묶음 안에서 같은 경로의 변화를 합친다 (FR-ELR-57, VS Code `coalesceEvents`).
//
// caseSensitive 가 거짓이면 경로를 소문자로 바꿔 견준다. 철자만 다른 ADDED·DELETED 는
// 대소문자만 바꾼 rename 이므로 둘 다 남긴다.
func Coalesce(in []Change, caseSensitive bool) []Change {
	key := func(p string) string {
		if caseSensitive {
			return p
		}
		return strings.ToLower(p)
	}
	byKey := map[string]*Change{}
	var order []*Change
	for _, c := range in {
		k := key(c.Path)
		prev, ok := byKey[k]
		if !ok {
			cc := c
			byKey[k] = &cc
			order = append(order, &cc)
			continue
		}
		if prev.Path != c.Path && (c.Kind == Added || c.Kind == Deleted) {
			cc := c
			order = append(order, &cc)
			continue
		}
		switch {
		case prev.Kind == Added && c.Kind == Deleted:
			delete(byKey, k)
			prev.Kind = 0
		case prev.Kind == Deleted && c.Kind == Added:
			prev.Kind = Updated
		case prev.Kind == Added && c.Kind == Updated:
		default:
			prev.Kind = c.Kind
		}
	}

	var deletes, rest []Change
	for _, c := range order {
		switch c.Kind {
		case 0:
		case Deleted:
			deletes = append(deletes, *c)
		default:
			rest = append(rest, *c)
		}
	}
	sort.SliceStable(deletes, func(i, j int) bool { return len(deletes[i].Path) < len(deletes[j].Path) })
	var kept []Change
	for _, d := range deletes {
		if parentDeleted(kept, d.Path, caseSensitive) {
			continue
		}
		kept = append(kept, d)
	}
	return append(kept, rest...)
}

func parentDeleted(kept []Change, p string, caseSensitive bool) bool {
	for _, k := range kept {
		if isParent(k.Path, p, caseSensitive) {
			return true
		}
	}
	return false
}

func isParent(parent, child string, caseSensitive bool) bool {
	if !caseSensitive {
		parent, child = strings.ToLower(parent), strings.ToLower(child)
	}
	prefix := strings.TrimSuffix(parent, string(filepath.Separator)) + string(filepath.Separator)
	return strings.HasPrefix(child, prefix)
}

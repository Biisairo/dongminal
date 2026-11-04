package fswatch

import (
	"path/filepath"
	"reflect"
	"testing"
)

// V-ELR-20 (EDITOR_LIVE_RELOAD_SRS FR-ELR-57): VS Code `watcher.ts` `coalesceEvents` 의 규칙.

func TestCoalesce_AddedThenDeletedDropsBoth(t *testing.T) {
	got := Coalesce([]Change{{"/r/a", Added}, {"/r/a", Deleted}}, true)
	if len(got) != 0 {
		t.Fatalf("got %v, want none", got)
	}
}

func TestCoalesce_DeletedThenAddedIsUpdated(t *testing.T) {
	got := Coalesce([]Change{{"/r/a", Deleted}, {"/r/a", Added}}, true)
	want := []Change{{"/r/a", Updated}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
}

func TestCoalesce_AddedThenUpdatedStaysAdded(t *testing.T) {
	got := Coalesce([]Change{{"/r/a", Added}, {"/r/a", Updated}}, true)
	want := []Change{{"/r/a", Added}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
}

func TestCoalesce_OtherwiseLastWins(t *testing.T) {
	got := Coalesce([]Change{{"/r/a", Updated}, {"/r/a", Deleted}}, true)
	want := []Change{{"/r/a", Deleted}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
	got = Coalesce([]Change{{"/r/a", Updated}, {"/r/a", Updated}}, true)
	want = []Change{{"/r/a", Updated}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
}

func TestCoalesce_ChildDeleteDroppedWhenParentDeleted(t *testing.T) {
	p := filepath.FromSlash // 부모 판정은 OS 구분자로 한다
	got := Coalesce([]Change{{p("/r/d/x"), Deleted}, {p("/r/d"), Deleted}, {p("/r/d/y/z"), Deleted}, {p("/r/e"), Deleted}}, true)
	want := []Change{{p("/r/d"), Deleted}, {p("/r/e"), Deleted}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
}

func TestCoalesce_ParentPrefixIsNotParent(t *testing.T) {
	got := Coalesce([]Change{{"/r/d", Deleted}, {"/r/dd", Deleted}}, true)
	if len(got) != 2 {
		t.Fatalf("got %v, want both", got)
	}
}

func TestCoalesce_CaseOnlyRenameKeepsBoth(t *testing.T) {
	got := Coalesce([]Change{{"/r/A.txt", Deleted}, {"/r/a.txt", Added}}, false)
	want := []Change{{"/r/A.txt", Deleted}, {"/r/a.txt", Added}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
}

func TestCoalesce_CaseInsensitiveKeyMerges(t *testing.T) {
	got := Coalesce([]Change{{"/r/A.txt", Updated}, {"/r/a.txt", Updated}}, false)
	if len(got) != 1 || got[0].Kind != Updated {
		t.Fatalf("got %v, want one updated", got)
	}
}

func TestCoalesce_CaseSensitiveKeepsDistinct(t *testing.T) {
	got := Coalesce([]Change{{"/r/A.txt", Updated}, {"/r/a.txt", Updated}}, true)
	if len(got) != 2 {
		t.Fatalf("got %v, want two", got)
	}
}

func TestCoalesce_NonDeleteAfterDeletes(t *testing.T) {
	got := Coalesce([]Change{{"/r/b", Updated}, {"/r/a", Deleted}}, true)
	want := []Change{{"/r/a", Deleted}, {"/r/b", Updated}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
}

func TestKindString(t *testing.T) {
	for k, s := range map[Kind]string{Added: "added", Updated: "updated", Deleted: "deleted"} {
		if k.String() != s {
			t.Fatalf("%d → %q, want %q", k, k.String(), s)
		}
	}
}

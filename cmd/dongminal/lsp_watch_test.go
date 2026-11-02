package main

import (
	"context"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"dongminal/internal/shared/gittest"
	"dongminal/internal/webserver/domain/git/core"
	"dongminal/internal/webserver/domain/git/store"
	"dongminal/internal/webserver/domain/lsp"
)

// §11.6 W: 관측의 HEAD·작업 트리 변경(새 파일인가)과, 두 커밋 사이의 name-status.
func TestLSPRepoView_SnapshotAndNameStatus(t *testing.T) {
	repo := gittest.Init(t)
	write := func(rel, s string) {
		t.Helper()
		if err := os.WriteFile(filepath.Join(repo, rel), []byte(s), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("a.go", "package a\n")
	write("b.go", "package a\n\n// b 는 지워진다.\nfunc B() {}\n")
	write("r.go", "package a\n\n// r 은 이름이 바뀐다.\nfunc R() int { return 42 }\n")
	gittest.Run(t, repo, "add", ".")
	gittest.Run(t, repo, "commit", "-qm", "1")
	c1 := gittest.Run(t, repo, "rev-parse", "HEAD")
	gittest.Run(t, repo, "rm", "-q", "b.go")
	gittest.Run(t, repo, "mv", "r.go", "r2.go")
	write("c.go", "package a\n\nvar c = map[string]int{\"zz\": 9}\n")
	gittest.Run(t, repo, "add", ".")
	gittest.Run(t, repo, "commit", "-qm", "2")
	c2 := gittest.Run(t, repo, "rev-parse", "HEAD")
	write("a.go", "package a\n\nvar x = 1\n")
	write("u.go", "package a\n")
	write("s.go", "package a\n")
	gittest.Run(t, repo, "add", "s.go")

	st := store.NewStore(core.New())
	v := lspRepoView{st: st}
	if _, ok := v.Snapshot(repo); ok {
		t.Fatal("관측 전인데 스냅숏이 있다")
	}
	if _, _, err := st.Status(context.Background(), repo); err != nil {
		t.Fatal(err)
	}
	snap, ok := v.Snapshot(repo)
	if !ok {
		t.Fatal("관측 뒤 스냅숏이 없다")
	}
	if snap.Head != c2 {
		t.Fatalf("Head %q want %q", snap.Head, c2)
	}
	if want := map[string]bool{"a.go": false, "u.go": true, "s.go": true}; !reflect.DeepEqual(snap.Files, want) {
		t.Fatalf("Files %v want %v", snap.Files, want)
	}
	ns, err := v.NameStatus(context.Background(), repo, c1, c2)
	if err != nil {
		t.Fatal(err)
	}
	if want := []lsp.NameStatus{{Status: "D", Path: "b.go"}, {Status: "A", Path: "c.go"}, {Status: "R", Path: "r2.go", OrigPath: "r.go"}}; !reflect.DeepEqual(ns, want) {
		t.Fatalf("name-status %+v want %+v", ns, want)
	}
	if _, err := v.NameStatus(context.Background(), repo, c1, "nope"); err == nil {
		t.Fatal("없는 커밋인데 오류가 없다")
	}
}

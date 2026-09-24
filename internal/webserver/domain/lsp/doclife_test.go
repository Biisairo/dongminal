package lsp

import (
	"context"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

// REPO_FIX 02 §3A-6 — 문서 수명: close 와 디스크 재동기화.

type recorder struct {
	mu   sync.Mutex
	msgs []map[string]any
}

func (r *recorder) handle(s *fakeServer, m map[string]any) {
	r.mu.Lock()
	r.msgs = append(r.msgs, m)
	r.mu.Unlock()
	echoHandler(s, m)
}

// methods 는 textDocument 동기화 알림만 순서대로 준다.
func (r *recorder) methods() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	var out []string
	for _, m := range r.msgs {
		switch m["method"] {
		case "textDocument/didOpen", "textDocument/didChange", "textDocument/didClose":
			out = append(out, m["method"].(string))
		}
	}
	return out
}

func (r *recorder) last() map[string]any {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.msgs[len(r.msgs)-1]
}

func (r *recorder) waitN(t *testing.T, n int) []string {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for len(r.methods()) < n && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	return r.methods()
}

// docRoot 는 실제 파일이 있는 루트다(재동기화가 디스크를 읽는다).
func docRoot(t *testing.T) (string, string) {
	t.Helper()
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	p := filepath.Join(root, "a.go")
	if err := os.WriteFile(p, []byte("package a\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	return root, p
}

func docSvc(t *testing.T) (*Service, *recorder) {
	t.Helper()
	rec := &recorder{}
	start, _, _ := killableStarter(t, rec.handle)
	return svcWith(t, start, map[string]string{"gopls": "/fake/gopls"}), rec
}

// close: 열린 문서면 didClose, 다음 요청은 didOpen 으로 다시 연다. 열지 않은 문서는 no-op.
func TestDocLife_CloseThenReopen(t *testing.T) {
	svc, rec := docSvc(t)
	root, p := docRoot(t)
	if _, err := svc.Definition(context.Background(), root, p, "package a\n", 1, 1); err != nil {
		t.Fatal(err)
	}
	svc.CloseDoc(root, filepath.Join(root, "other.go")) // 열지 않은 문서
	svc.CloseDoc(root, p)
	if got := rec.waitN(t, 2); len(got) != 2 || got[1] != "textDocument/didClose" {
		t.Fatalf("close = %v", got)
	}
	svc.CloseDoc(root, p) // 두 번째는 no-op
	if _, err := svc.Definition(context.Background(), root, p, "package a\n", 1, 1); err != nil {
		t.Fatal(err)
	}
	if got := rec.waitN(t, 3); len(got) != 3 || got[2] != "textDocument/didOpen" {
		t.Fatalf("다시 열기 = %v", got)
	}
}

// 재동기화: 디스크가 마지막 전송과 같으면 아무것도 보내지 않고, 다르면 디스크 판으로
// didChange(판 +1), 파일이 없어지면 didClose.
func TestDocLife_ResyncFromDisk(t *testing.T) {
	svc, rec := docSvc(t)
	root, p := docRoot(t)
	if _, err := svc.Definition(context.Background(), root, p, "package a\n", 1, 1); err != nil {
		t.Fatal(err)
	}
	svc.ResyncPath(p)
	time.Sleep(20 * time.Millisecond)
	if got := rec.methods(); len(got) != 1 {
		t.Fatalf("같은 내용인데 보냈다: %v", got)
	}
	if err := os.WriteFile(p, []byte("package b\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	svc.ResyncPath(p)
	if got := rec.waitN(t, 2); len(got) != 2 || got[1] != "textDocument/didChange" {
		t.Fatalf("변경 = %v", got)
	}
	params, _ := rec.last()["params"].(map[string]any)
	td, _ := params["textDocument"].(map[string]any)
	changes, _ := params["contentChanges"].([]any)
	first, _ := changes[0].(map[string]any)
	if td["version"] != float64(2) || first["text"] != "package b\n" {
		t.Fatalf("didChange = %v", params)
	}
	os.Remove(p)
	svc.ResyncPath(p)
	if got := rec.waitN(t, 3); len(got) != 3 || got[2] != "textDocument/didClose" {
		t.Fatalf("삭제 = %v", got)
	}
}

// 저장소 재동기화는 그 아래의 열린 문서만 본다. 유효하지 않은 UTF-8 이면 닫는다.
func TestDocLife_ResyncRepoScopeAndInvalidUTF8(t *testing.T) {
	svc, rec := docSvc(t)
	root, p := docRoot(t)
	if _, err := svc.Definition(context.Background(), root, p, "package a\n", 1, 1); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte{0xff, 0xfe, 0x00}, 0o644); err != nil {
		t.Fatal(err)
	}
	svc.ResyncRepo(filepath.Join(filepath.Dir(root), "elsewhere"))
	time.Sleep(20 * time.Millisecond)
	if got := rec.methods(); len(got) != 1 {
		t.Fatalf("다른 저장소의 변화에 반응했다: %v", got)
	}
	svc.ResyncRepo(root)
	if got := rec.waitN(t, 2); len(got) != 2 || got[1] != "textDocument/didClose" {
		t.Fatalf("유효하지 않은 UTF-8 = %v", got)
	}
}

package httpapi

import (
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"testing"

	"dongminal/internal/shared/testpath"
	"dongminal/internal/webserver/domain/wsentry"
)

// M8 `GO-9`: 이 패키지 머리말의 계약 — "두 서버가 한 프로세스에 공존한다" — 가
// 성립한다. 상한·유예·컨텍스트 통지 기억이 패키지 전역이던 동안에는 거짓이었다:
// 한 서버의 상한을 낮추면 다른 서버도 낮아졌고, 통지 기억은 프로세스 수명이었다.
func TestTwoServersCoexist_LimitsAreIndependent(t *testing.T) {
	home := t.TempDir()
	t.Setenv(testpath.HomeEnv(), home)
	root := wsentry.NormalizePath(home)
	for i := 0; i < 3; i++ {
		if err := os.WriteFile(filepath.Join(root, fmt.Sprintf("f%d", i)), nil, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	newSrv := func() *Server {
		ws := newFakeWorkspaceStore()
		seedRoot(t, ws, root)
		s, err := New(Config{Port: "0", DataDir: t.TempDir()}, Deps{Work: ws, Commands: &fakeCommandBroker{}})
		if err != nil {
			t.Fatalf("New: %v", err)
		}
		return s
	}
	a, b := newSrv(), newSrv()
	a.limits.fsList = 1

	list := func(s *Server) map[string]any {
		code, out := fsReq(t, s, http.MethodGet, "/api/fs/list?root="+root+"&path="+root, "")
		if code != 200 {
			t.Fatalf("code=%d body=%v", code, out)
		}
		return out
	}
	if out := list(a); out["truncated"] != true {
		t.Fatalf("a 의 상한이 적용되지 않았다: %v", out)
	}
	if out := list(b); out["truncated"] != false {
		t.Fatalf("a 의 상한이 b 에 샜다: %v", out)
	}
	if b.limits != defaultLimits() {
		t.Fatalf("b 의 상한이 기본값이 아니다: %+v", b.limits)
	}
}

func TestTwoServersCoexist_ContextNoticesAreIndependent(t *testing.T) {
	a, err := New(Config{Port: "0", DataDir: t.TempDir()}, Deps{})
	if err != nil {
		t.Fatal(err)
	}
	b, err := New(Config{Port: "0", DataDir: t.TempDir()}, Deps{})
	if err != nil {
		t.Fatal(err)
	}
	if !a.contextNotices.claim("m1", "warn") {
		t.Fatal("첫 통지가 거절됐다")
	}
	if a.contextNotices.claim("m1", "warn") {
		t.Fatal("같은 서버의 두 번째 통지가 통과했다")
	}
	if !b.contextNotices.claim("m1", "warn") {
		t.Fatal("a 의 통지 기억이 b 에 샜다")
	}
}

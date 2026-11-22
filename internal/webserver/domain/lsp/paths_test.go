package lsp

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"dongminal/internal/shared/platform"
)

// REPO_FIX 02 §3A-3: 경로 표는 서술자를 검사하고 절대경로만 받고, 저장하고, 상태가 그 표를 쓴다.
func TestPaths_SetValidatesPersistsAndStatusUsesIt(t *testing.T) {
	svc := svcWith(t, nil, map[string]string{"gopls": "/fake/gopls", "typescript-language-server": "/fake/tsls"})
	file := filepath.Join(t.TempDir(), "lsp-paths.json")
	if err := svc.LoadPaths(file); err != nil {
		t.Fatal(err)
	}
	// 이전: 모르는 서술자는 ErrUnknownServer 로 거부됐다.
	// 새: 오류 없이 버린다. 이유: FR-ATF-73 (AT-LSP-7) — 지운 팩의 키가 남은 옛 표도 PUT 된다.
	if got, err := svc.SetPaths(map[string]string{"nope/nope": "/x"}); err != nil || len(got) != 0 {
		t.Fatalf("모르는 서술자 = %v %v", got, err)
	}
	if _, err := svc.SetPaths(map[string]string{"gopls/gopls": "rel/gopls"}); !errors.Is(err, ErrPathNotAbsolute) {
		t.Fatalf("상대경로 = %v", err)
	}
	// Windows 는 확장자로 실행 파일을 가린다 — 접미사가 없으면 표를 무시하고 탐색 결과를 쓴다(CI 실측).
	abs := filepath.Join(t.TempDir(), "my-gopls"+platform.Current().Paths.ExeSuffix())
	if err := os.WriteFile(abs, []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	got, err := svc.SetPaths(map[string]string{"gopls/gopls": abs})
	if err != nil || got["gopls/gopls"] != abs {
		t.Fatalf("SetPaths = %v %v", got, err)
	}
	raw, _ := os.ReadFile(file)
	var onDisk struct{ Paths map[string]string }
	if json.Unmarshal(raw, &onDisk) != nil || onDisk.Paths["gopls/gopls"] != abs {
		t.Fatalf("파일 = %s", raw)
	}
	sts, _ := svc.Status()
	for _, st := range sts {
		if st.ID == "gopls" && st.Exe != abs {
			t.Fatalf("상태가 서버 표를 쓰지 않았다: %+v", st)
		}
	}
	svc2 := svcWith(t, nil, nil)
	if err := svc2.LoadPaths(file); err != nil || svc2.Paths()["gopls/gopls"] != abs {
		t.Fatalf("LoadPaths = %v %v", svc2.Paths(), err)
	}
	if got, err := svc.SetPaths(map[string]string{"gopls/gopls": ""}); err != nil || len(got) != 0 {
		t.Fatalf("삭제 = %v %v", got, err)
	}
}

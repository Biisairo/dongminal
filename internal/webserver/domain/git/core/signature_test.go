package core

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// 묶음 C — signature (GIT_SRS §3.3 FR-GIT-19, 검증 V5).
//
// signature 는 status 재조회를 생략할 근거다. 값이 변화를 놓치면 UI 가 조용히
// 낡은 상태를 보여주므로, 실제 저장소에서 확인한다.

func gitIn(t *testing.T, dir string, args ...string) {
	t.Helper()
	cmd := exec.Command(gitPath(t), args...)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), "GIT_CONFIG_GLOBAL=/dev/null", "GIT_CONFIG_SYSTEM=/dev/null")
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git %s: %v\n%s", strings.Join(args, " "), err, out)
	}
}

// P8 (V5): index 를 건드리면 값이 바뀌고, 안 건드리면 같다.
func TestSignature_TracksIndex(t *testing.T) {
	repo := tempRepo(t)
	s := New()
	ctx := context.Background()

	first, err := s.Signature(ctx, repo)
	if err != nil {
		t.Fatalf("Signature: %v", err)
	}
	if first.Head == "" || first.RefName != "refs/heads/main" {
		t.Fatalf("signature = %+v", first)
	}
	if first.IndexMtimeNs == 0 || first.IndexSize == 0 {
		t.Fatalf("index stat 이 비었다: %+v", first)
	}
	if first.RefMtimeNs == 0 {
		t.Fatalf("ref mtime 이 비었다: %+v", first)
	}
	if first.Value == "" {
		t.Fatal("Value 가 비었다")
	}

	same, err := s.Signature(ctx, repo)
	if err != nil {
		t.Fatalf("Signature: %v", err)
	}
	if same.Value != first.Value {
		t.Fatalf("건드리지 않았는데 값이 바뀌었다: %q → %q", first.Value, same.Value)
	}

	if err := os.WriteFile(filepath.Join(repo, "new.txt"), []byte("y\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	gitIn(t, repo, "add", "new.txt")

	after, err := s.Signature(ctx, repo)
	if err != nil {
		t.Fatalf("Signature: %v", err)
	}
	if after.Value == first.Value {
		t.Fatalf("index 를 건드렸는데 값이 그대로다: %q", after.Value)
	}
}

// P9 (V5): ref 가 packed 상태면 개별 파일이 없다. 오류가 아니라 packed-refs 의
// mtime 을 쓴다.
func TestSignature_PackedRefsOnly(t *testing.T) {
	repo := tempRepo(t)
	gitIn(t, repo, "pack-refs", "--all")

	s := New()
	gitDir, commonDir, err := s.GitDirs(context.Background(), repo)
	if err != nil {
		t.Fatalf("GitDirs: %v", err)
	}
	if _, err := os.Stat(filepath.Join(gitDir, "refs", "heads", "main")); err == nil {
		t.Skip("pack-refs 가 loose ref 를 남겼다 — 이 git 에서는 확인할 수 없다")
	}
	if _, err := os.Stat(filepath.Join(commonDir, "packed-refs")); err != nil {
		t.Skipf("packed-refs 가 없다: %v", err)
	}

	sig, err := s.Signature(context.Background(), repo)
	if err != nil {
		t.Fatalf("Signature: %v", err)
	}
	if sig.RefName != "refs/heads/main" {
		t.Fatalf("RefName = %q", sig.RefName)
	}
	if sig.RefMtimeNs == 0 {
		t.Fatalf("packed-refs 의 mtime 을 쓰지 않았다: %+v", sig)
	}
}

// 없는 파일의 mtime·size 는 0 이며 오류가 아니다 — 초기 저장소에는 index 가
// 없을 수 있다.
func TestSignature_MissingIndexIsNotError(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "HEAD"), []byte("ref: refs/heads/main\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	s := New(WithRunner(func(_ context.Context, _ string, _ []string) (Output, error) {
		return Output{Stdout: dir + "\n" + dir + "\n"}, nil
	}))
	sig, err := s.Signature(context.Background(), "/r")
	if err != nil {
		t.Fatalf("Signature: %v", err)
	}
	if sig.IndexMtimeNs != 0 || sig.IndexSize != 0 || sig.RefMtimeNs != 0 {
		t.Fatalf("없는 파일이 0 이 아니다: %+v", sig)
	}
	if sig.Head != "ref: refs/heads/main" || sig.RefName != "refs/heads/main" {
		t.Fatalf("signature = %+v", sig)
	}
}

// detached HEAD 는 심볼릭이 아니다 — RefName 이 비고 ref stat 은 건너뛴다.
func TestSignature_DetachedHead(t *testing.T) {
	dir := t.TempDir()
	oid := "1111111111111111111111111111111111111111"
	if err := os.WriteFile(filepath.Join(dir, "HEAD"), []byte(oid+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	s := New(WithRunner(func(_ context.Context, _ string, _ []string) (Output, error) {
		return Output{Stdout: dir + "\n" + dir + "\n"}, nil
	}))
	sig, err := s.Signature(context.Background(), "/r")
	if err != nil {
		t.Fatalf("Signature: %v", err)
	}
	if sig.Head != oid || sig.RefName != "" {
		t.Fatalf("signature = %+v", sig)
	}
}

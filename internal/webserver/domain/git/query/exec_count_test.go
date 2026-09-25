package query

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"dongminal/internal/shared/gittest"
	"dongminal/internal/webserver/domain/git/core"
)

// OPTIMIZE_REFACTOR_SRS FR-OPT-7-3 (DOM-19): PreflightOf 는 git 을 두 번 띄운다
// (이전 5회: config --get ×4 + rev-parse). 설정 네 키는 `config --null --list`
// 한 번으로 읽는다.
func TestPreflightOf_TwoProcesses(t *testing.T) {
	isolateConfig(t)
	repo := gittest.Repo(t)
	gittest.Run(t, repo, "config", "commit.gpgsign", "yes")
	gittest.Run(t, repo, "config", "commit.template", "tmpl.txt")
	if err := os.WriteFile(filepath.Join(repo, "tmpl.txt"), []byte("subject\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	c := gittest.Count(t)

	pf, err := PreflightOf(core.New(), context.Background(), repo)
	if err != nil {
		t.Fatalf("PreflightOf: %v", err)
	}
	if n := c.N(); n != 2 {
		t.Fatalf("git %d 회 (%q), want 2", n, c.Calls())
	}
	if len(pf.Blocks) != 0 || len(pf.Warnings) != 0 || !pf.GPGSign || pf.Template != "subject\n" {
		t.Fatalf("preflight = %+v", pf)
	}
}

// isolateConfig 는 호스트의 전역·시스템 gitconfig 가 판정에 새지 않게 한다.
func isolateConfig(t *testing.T) {
	t.Setenv("GIT_CONFIG_GLOBAL", os.DevNull)
	t.Setenv("GIT_CONFIG_SYSTEM", os.DevNull)
}

// 설정 판독은 --get 과 같다 — 여러 값이면 마지막, 키는 대소문자를 가리지 않는다,
// 미설정은 빈 값이다. 값 안의 개행이 다른 키로 읽히지 않는다 (-z).
func TestPreflightOf_ConfigSemantics(t *testing.T) {
	isolateConfig(t)
	repo := gittest.Repo(t)
	gittest.Run(t, repo, "config", "--unset", "user.name")
	gittest.Run(t, repo, "config", "--add", "commit.gpgSign", "true")
	gittest.Run(t, repo, "config", "--add", "commit.gpgSign", "false")
	gittest.Run(t, repo, "config", "commit.template", "x\nuser.name=spoof")

	pf, err := PreflightOf(core.New(), context.Background(), repo)
	if err != nil {
		t.Fatalf("PreflightOf: %v", err)
	}
	if pf.GPGSign {
		t.Fatal("마지막 값(false)이 아니라 앞의 값을 읽었다")
	}
	if len(pf.Blocks) != 1 || pf.Blocks[0].Code != BlockIdentityMissing || !strings.Contains(pf.Blocks[0].Reason, configUserName) {
		t.Fatalf("user.name 미설정이 막히지 않았다 (값 안의 개행이 키로 읽혔나): %+v", pf.Blocks)
	}
}

// detached 경고는 HEAD 파일로 판정한다 — 커밋이 없는 저장소는 detached 가 아니다.
func TestPreflightOf_DetachedFromHeadFile(t *testing.T) {
	repo := gittest.Repo(t)
	gittest.Run(t, repo, "checkout", "-q", "--detach")
	pf, err := PreflightOf(core.New(), context.Background(), repo)
	if err != nil || len(pf.Warnings) != 1 || pf.Warnings[0].Code != WarnDetachedHead {
		t.Fatalf("detached: %+v %v", pf, err)
	}
	unborn := gittest.Init(t)
	pf, err = PreflightOf(core.New(), context.Background(), unborn)
	if err != nil || len(pf.Warnings) != 0 {
		t.Fatalf("unborn: %+v %v", pf, err)
	}
}

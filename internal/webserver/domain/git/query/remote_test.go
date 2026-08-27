package query

import (
	"context"
	"strings"
	"testing"

	"dongminal/internal/webserver/domain/git/core"
)

// 원격 목록 조회 (GIT_ACTIONS_SRS §3.5 FR-GIT-269, 검증 V196).
//
// **새 조회를 만들지 않는다.** DefaultRemote 가 이미 `config --list` 를 읽고 있고,
// 목록은 그 출력에서 이름과 URL 을 함께 뽑으면 된다 — `git remote -v` 를 쓰려면
// 읽기 허용 목록을 늘려야 하고, 늘리지 않고 얻을 수 있는 값이다 (FR-GIT-7).

func remotesSvc(config string) *core.Service {
	return core.New(core.WithRunner(func(_ context.Context, _ string, args []string) (core.Output, error) {
		if args[0] == "config" {
			return core.Output{Stdout: config}, nil
		}
		return core.Output{}, nil
	}))
}

func TestRemotes_NameAndURL(t *testing.T) {
	svc := remotesSvc(strings.Join([]string{
		"core.bare=false",
		"remote.origin.url=https://example.test/a.git",
		"remote.origin.fetch=+refs/heads/*:refs/remotes/origin/*",
		"remote.upstream.url=git@example.test:b/c.git",
		"remote.upstream.pushurl=git@example.test:b/c-push.git",
		// url 이 없는 키는 원격의 **존재**를 뜻하지 않는다.
		"remote.pushdefault=origin",
		"",
	}, "\n"))
	got, err := Remotes(svc, context.Background(), "/work/repo")
	if err != nil {
		t.Fatalf("Remotes: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("원격이 %d 개다: %+v", len(got), got)
	}
	if got[0].Name != "origin" || got[0].URL != "https://example.test/a.git" {
		t.Fatalf("origin = %+v", got[0])
	}
	if got[1].Name != "upstream" || got[1].PushURL != "git@example.test:b/c-push.git" {
		t.Fatalf("upstream = %+v", got[1])
	}
}

// FR-GIT-104: URL 에 자격증명이 박혀 올 수 있다. **나가는 값은 지운 값이다** —
// 목록·기록·화면 어디에도 원본이 흐르지 않는다.
func TestRemotes_RedactsURL(t *testing.T) {
	svc := remotesSvc("remote.origin.url=https://user:abc123@example.test/a.git\n" +
		"remote.origin.pushurl=https://ghp_zzzz@example.test/a.git\n")
	got, err := Remotes(svc, context.Background(), "/work/repo")
	if err != nil {
		t.Fatalf("Remotes: %v", err)
	}
	if len(got) != 1 {
		t.Fatalf("원격이 %d 개다: %+v", len(got), got)
	}
	if strings.Contains(got[0].URL, "abc123") || strings.Contains(got[0].PushURL, "ghp_zzzz") {
		t.Fatalf("자격증명이 그대로 나갔다: %+v", got[0])
	}
	if !strings.Contains(got[0].URL, "example.test") {
		t.Fatalf("호스트까지 지워졌다: %+v", got[0])
	}
}

// 이름에 점이 들 수 있다 (`remote.my.fork.url`). DefaultRemote 와 **같은 규칙**을
// 쓴다 — 두 벌이면 한쪽만 고쳐진다.
func TestRemotes_SharesNameRuleWithDefaultRemote(t *testing.T) {
	config := "remote.my.fork.url=/tmp/f.git\n"
	svc := remotesSvc(config)
	got, err := Remotes(svc, context.Background(), "/work/repo")
	if err != nil {
		t.Fatalf("Remotes: %v", err)
	}
	if len(got) != 1 || got[0].Name != "my.fork" {
		t.Fatalf("이름 = %+v", got)
	}
	def, err := DefaultRemote(svc, context.Background(), "/work/repo")
	if err != nil || def != "my.fork" {
		t.Fatalf("DefaultRemote = %q, %v", def, err)
	}
}

func TestRemotes_Empty(t *testing.T) {
	got, err := Remotes(remotesSvc("core.bare=false\n"), context.Background(), "/work/repo")
	if err != nil {
		t.Fatalf("Remotes: %v", err)
	}
	// nil 은 JSON 에서 null 이 된다 — 목록은 빈 슬라이스여야 한다 (FR-RPT-1).
	if got == nil || len(got) != 0 {
		t.Fatalf("빈 목록 = %#v", got)
	}
}

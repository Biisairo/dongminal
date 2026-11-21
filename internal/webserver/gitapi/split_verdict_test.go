package gitapi

import (
	"errors"
	"reflect"
	"testing"

	"dongminal/internal/webserver/action"
	"dongminal/internal/webserver/domain/git/query"
	"dongminal/internal/webserver/domain/git/store"
	"dongminal/internal/webserver/domain/worktree"
)

// REFACTOR3_GO_STRUCT_SRS FR-RGS-1: status·log·worktree 제거 처리기에서 뗀 판정·렌더 함수.

func TestGitStatusUnchanged(t *testing.T) {
	cases := []struct {
		name, ifMark, mark string
		want               bool
	}{
		{"인자 없음", "", "m", false},
		{"관측 없음과 빈 인자", "", "", false},
		{"같다", "m", "m", true},
		{"다르다", "m", "n", false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := gitStatusUnchanged(c.ifMark, c.mark); got != c.want {
				t.Fatalf("got %v, want %v", got, c.want)
			}
		})
	}
}

func TestGitStatusBodies(t *testing.T) {
	acts := map[string]action.Answer{"pull": {OK: true}}
	cases := []struct {
		name string
		v    gitStatusView
		root bool
	}{
		{"루트", gitStatusView{root: "/r", requested: "/r", resolved: "/r", mark: "m", actions: acts}, true},
		{"하위 경로", gitStatusView{root: "/r", requested: "/r/a", resolved: "/r/a", mark: "m", actions: acts}, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			un := gitStatusUnchangedBody(c.v)
			wantUn := map[string]any{
				"repo": "/r", "requested": c.v.requested, "isRepo": true, "rootMatch": c.root,
				"requestedResolved": c.v.resolved, "mark": "m", "unchanged": true, "actions": acts,
			}
			if !reflect.DeepEqual(un, wantUn) {
				t.Fatalf("unchanged: got %#v, want %#v", un, wantUn)
			}
			obs := store.Observation{ObservedAtUnixMs: 7}
			full := gitStatusBody(c.v, obs, true)
			wantFull := map[string]any{
				"repo": "/r", "requested": c.v.requested, "isRepo": true, "rootMatch": c.root,
				"requestedResolved": c.v.resolved, "cached": true, "observedAtUnixMs": int64(7),
				"signature": obs.Signature, "status": obs.Status, "mark": "m", "actions": acts,
				"rowActions": rowActions(obs.Status),
			}
			if !reflect.DeepEqual(full, wantFull) {
				t.Fatalf("full: got %#v, want %#v", full, wantFull)
			}
		})
	}
}

func TestGitStatusNotRepoBody(t *testing.T) {
	got := gitStatusNotRepoBody("/n")
	if got["isRepo"] != false || got["requested"] != "/n" || got["mark"] != "" || got["status"] != nil || got["repo"] != "" {
		t.Fatalf("got %#v", got)
	}
	if len(got) != 8 {
		t.Fatalf("키 수 = %d, want 8: %#v", len(got), got)
	}
}

func TestGitLogStopWithSkip(t *testing.T) {
	cases := []struct {
		name string
		req  gitLogRequested
		want bool
	}{
		{"둘 다 없음", gitLogRequested{}, false},
		{"stop 만", gitLogRequested{Stop: "abc"}, false},
		{"skip 만", gitLogRequested{Skip: 10}, false},
		{"둘 다", gitLogRequested{Stop: "abc", Skip: 10}, true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := gitLogStopWithSkip(c.req); got != c.want {
				t.Fatalf("got %v, want %v", got, c.want)
			}
		})
	}
}

func TestGitLogRejected(t *testing.T) {
	cases := []struct {
		name string
		err  error
		want bool
	}{
		{"오류 없음", nil, false},
		{"인자 거부(400)", query.ErrDiffTruncated, true},
		{"그 밖의 실패", errors.New("x"), false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := gitLogRejected(c.err); got != c.want {
				t.Fatalf("got %v, want %v", got, c.want)
			}
		})
	}
}

func TestListedWorktreeBranch(t *testing.T) {
	entries := []worktree.Entry{{Path: "/a", Branch: "ba"}, {Path: "/b", Branch: "bb"}}
	cases := []struct {
		name         string
		target       string
		deleteBranch bool
		branch       string
		found        bool
	}{
		{"없음", "/c", true, "", false},
		{"있고 브랜치도 지움", "/b", true, "bb", true},
		{"있고 브랜치는 남김", "/b", false, "", true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			b, f := listedWorktreeBranch(entries, c.target, c.deleteBranch)
			if b != c.branch || f != c.found {
				t.Fatalf("got (%q, %v), want (%q, %v)", b, f, c.branch, c.found)
			}
		})
	}
}

func TestWorktreeRemoveBody(t *testing.T) {
	res := worktree.Result{Path: "/a", Branch: "b", Removed: false, Residue: "dirty", Detail: "d"}
	want := map[string]any{"path": "/a", "branch": "b", "removed": false, "residue": "dirty", "detail": "d"}
	if got := worktreeRemoveBody(res); !reflect.DeepEqual(got, want) {
		t.Fatalf("got %#v, want %#v", got, want)
	}
}

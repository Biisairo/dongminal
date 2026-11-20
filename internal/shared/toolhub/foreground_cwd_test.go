package toolhub

import (
	"path/filepath"
	"testing"
	"time"
)

// UX_AUDIT_FIX_SRS FR-UXF-65 (TC-UXF-63): 전경이 셸이면 이름은 cwd 의 마지막 성분이다.

func TestCwdTabName(t *testing.T) {
	home := filepath.FromSlash("/home/u")
	sep := string(filepath.Separator)
	cases := []struct{ cwd, want string }{
		{home, "~"},
		{home + sep, "~"},
		{sep, sep},
		{filepath.FromSlash("/home/u/work/dongminal"), "dongminal"},
		{filepath.FromSlash("/home/u/work/dongminal/"), "dongminal"},
		// 16자로 자른다 (FR-TAN-13).
		{filepath.FromSlash("/x/abcdefghijklmnopqrst"), "abcdefghijklmnop"},
		// 모르면 이름 없음 — 탭은 Shell 이다 (FR-TAN-12).
		{"", ""},
	}
	for _, c := range cases {
		if got := cwdTabName(c.cwd, home); got != c.want {
			t.Errorf("cwdTabName(%q)=%q want %q", c.cwd, got, c.want)
		}
	}
	// 홈을 모르면 홈 판정을 하지 않는다.
	if got := cwdTabName(home, ""); got != "u" {
		t.Errorf("cwdTabName(home, \"\")=%q want u", got)
	}
}

// fakeFGCwds 는 fgCwds 를 결정론적 구현으로 갈아끼운다.
func fakeFGCwds(t *testing.T, cwds map[string]string) {
	t.Helper()
	orig, origHome := fgCwds, fgHome
	t.Cleanup(func() { fgCwds, fgHome = orig, origHome })
	fgCwds = func(reqs []fgRequest) map[string]string {
		out := map[string]string{}
		for _, r := range reqs {
			if v, ok := cwds[r.ID]; ok {
				out[r.ID] = v
			}
		}
		return out
	}
	fgHome = func() string { return filepath.FromSlash("/home/u") }
}

func TestForegroundShellFallsBackToCwd(t *testing.T) {
	pm := NewToolManager(t.TempDir(), nil)
	t.Cleanup(pm.StopSaving)
	adoptDetached(pm, "a", "b", "c", "d")
	fakeFGProbe(t, func([]fgRequest) map[string]string {
		return map[string]string{"a": "vim"}
	})
	fakeFGCwds(t, map[string]string{
		"a": filepath.FromSlash("/home/u/proj-a"),
		"b": filepath.FromSlash("/home/u/proj-b"),
		"c": filepath.FromSlash("/home/u"),
	})

	pm.refreshForeground(time.Now())
	got := pm.ForegroundNames()
	if got["a"] != "vim" {
		t.Errorf("a=%q — 셸이 아닌 전경은 그 이름이다", got["a"])
	}
	if got["b"] != "proj-b" {
		t.Errorf("b=%q want proj-b", got["b"])
	}
	if got["c"] != "~" {
		t.Errorf("c=%q want ~", got["c"])
	}
	if _, ok := got["d"]; ok {
		t.Errorf("d=%q — cwd 를 모르면 이름이 없어야 한다", got["d"])
	}
}

// 전경이 셸인 도구만 cwd 를 묻는다 — 셸이 아닌 전경까지 물으면 조회가 헛돈다.
func TestForegroundCwdAsksOnlyShellTools(t *testing.T) {
	pm := NewToolManager(t.TempDir(), nil)
	t.Cleanup(pm.StopSaving)
	adoptDetached(pm, "a", "b")
	fakeFGProbe(t, func([]fgRequest) map[string]string {
		return map[string]string{"a": "vim"}
	})
	fakeFGCwds(t, nil)
	var asked []string
	inner := fgCwds
	fgCwds = func(reqs []fgRequest) map[string]string {
		for _, r := range reqs {
			asked = append(asked, r.ID)
		}
		return inner(reqs)
	}
	pm.refreshForeground(time.Now())
	if len(asked) != 1 || asked[0] != "b" {
		t.Fatalf("cwd 를 물은 도구=%v want [b]", asked)
	}
}

// FR-UXF-65 (개정): 셸 훅이 알린 cwd 가 있으면 그것이 답이고 외부 조회(lsof)를 띄우지 않는다.
// 쉬는 셸에서는 마지막 프롬프트의 보고가 곧 지금의 cwd 다.
func TestForegroundCwdsPrefersReport(t *testing.T) {
	info := &countingInfo{}
	withProcInfo(t, info)
	got := foregroundCwds([]fgRequest{
		{ID: "a", ShellPID: 11, ReportedCwd: "/reported"},
		{ID: "b", ShellPID: 12, ReportedCwd: "/also"},
	})
	if info.cwds != 0 {
		t.Fatalf("보고가 있는데 CWDs 를 %d번 불렀다", info.cwds)
	}
	if got["a"] != "/reported" || got["b"] != "/also" {
		t.Fatalf("got=%v", got)
	}
}

// 보고가 없는 도구만 묶음 조회 한 번으로 읽는다.
func TestForegroundCwdsAsksOnlyUnreported(t *testing.T) {
	info := &countingInfo{}
	withProcInfo(t, info)
	got := foregroundCwds([]fgRequest{
		{ID: "a", ShellPID: 11, ReportedCwd: "/reported"},
		{ID: "b", ShellPID: 12},
		{ID: "c", ShellPID: 13},
	})
	if info.cwds != 1 {
		t.Fatalf("CWDs 호출 %d번 — 1번이어야 한다", info.cwds)
	}
	if got["a"] != "/reported" || got["b"] != "/many" || got["c"] != "/many" {
		t.Fatalf("got=%v", got)
	}
}

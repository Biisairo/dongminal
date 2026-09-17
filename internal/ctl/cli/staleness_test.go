package cli

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"dongminal/internal/shared/toolipc"
)

// DAEMON_STALENESS_SRS FR-DFP-8 — 판정의 네 상태.
//
// **모른다를 일치로 접지 않는다** (FR-DFP-3). 낡은 데몬 위에서 고친 줄 알았던
// 버그를 다시 보는 것이 이 판정이 없애려는 값이고, 그것은 침묵으로 되돌아온다.
func TestClassifyDaemon(t *testing.T) {
	cases := []struct {
		name     string
		alive    bool
		recorded string
		current  string
		want     DaemonState
	}{
		{"죽어 있으면 미실행", false, "abc", "abc", DaemonNotRunning},
		{"죽어 있으면 지문이 달라도 미실행", false, "abc", "def", DaemonNotRunning},
		{"같으면 일치", true, "abc", "abc", DaemonFresh},
		{"다르면 불일치", true, "abc", "def", DaemonStale},
		{"바이너리에 지문이 없으면 모른다", true, "abc", "", DaemonUnknown},
		{"데몬이 남긴 것이 없으면 모른다", true, "", "abc", DaemonUnknown},
		{"둘 다 없으면 모른다", true, "", "", DaemonUnknown},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := classifyDaemon(c.alive, c.recorded, c.current); got != c.want {
				t.Fatalf("classifyDaemon(%v,%q,%q)=%v want %v",
					c.alive, c.recorded, c.current, got, c.want)
			}
		})
	}
}

// FR-DFP-11 — 문구는 한 자리에서 나온다. 네 상태가 서로 다른 말을 하고, 어느
// 것도 비어 있지 않아야 세 호출자(build.sh·start·health)가 같은 사실을 말한다.
func TestDaemonStateLine_AllStatesDistinct(t *testing.T) {
	seen := map[string]DaemonState{}
	for _, s := range []DaemonState{DaemonUnknown, DaemonNotRunning, DaemonFresh, DaemonStale} {
		line := daemonStateLine(s)
		if strings.TrimSpace(line) == "" {
			t.Fatalf("daemonStateLine(%v) 가 비었다", s)
		}
		if prev, dup := seen[line]; dup {
			t.Fatalf("daemonStateLine(%v) 이 %v 와 같은 말을 한다: %q", s, prev, line)
		}
		seen[line] = s
	}
	// 불일치만이 조치를 부른다 — 그 한 줄에 조치가 없으면 사실을 알려도 쓸모가 없다.
	if !strings.Contains(daemonStateLine(DaemonStale), "--restart-daemon") {
		t.Fatalf("불일치 줄에 조치가 없다: %q", daemonStateLine(DaemonStale))
	}
	// 일치는 조치를 부르지 않는다. 늘 재시작을 권하면 세션 손실이 기본값이 된다.
	if strings.Contains(daemonStateLine(DaemonFresh), "--restart-daemon") {
		t.Fatalf("일치 줄이 재시작을 권한다: %q", daemonStateLine(DaemonFresh))
	}
}

// FR-DFP-4 의 읽는 쪽 — 데몬이 남긴 한 줄을 판정에 쓴다 (NFR-DFP-2: 소켓에
// 붙지 않는다).
func TestInspectDaemon_ReadsRecordedFile(t *testing.T) {
	home := t.TempDir()
	writePID(t, home, os.Getpid()) // 살아 있는 pid — 이 검사 프로세스 자신
	writeDaemonBuild(t, home, "deadbeef")

	old := DaemonBuild
	defer func() { DaemonBuild = old }()

	DaemonBuild = "deadbeef"
	if got := inspectDaemon(home); got != DaemonFresh {
		t.Fatalf("같은 지문인데 %v", got)
	}
	DaemonBuild = "cafebabe"
	if got := inspectDaemon(home); got != DaemonStale {
		t.Fatalf("다른 지문인데 %v", got)
	}
	DaemonBuild = ""
	if got := inspectDaemon(home); got != DaemonUnknown {
		t.Fatalf("지문이 없는데 %v", got)
	}
}

// 파일이 없으면 모른다 — 없음을 일치로 읽으면 이 판정은 늘 참이 된다.
func TestInspectDaemon_NoRecordIsUnknown(t *testing.T) {
	home := t.TempDir()
	writePID(t, home, os.Getpid())

	old := DaemonBuild
	defer func() { DaemonBuild = old }()
	DaemonBuild = "deadbeef"

	if got := inspectDaemon(home); got != DaemonUnknown {
		t.Fatalf("기록이 없는데 %v", got)
	}
}

// pidfile 이 없으면 미실행이다 — 그때 남아 있는 지문 파일은 앞선 데몬의 것이다.
func TestInspectDaemon_NoPIDIsNotRunning(t *testing.T) {
	home := t.TempDir()
	writeDaemonBuild(t, home, "deadbeef")

	old := DaemonBuild
	defer func() { DaemonBuild = old }()
	DaemonBuild = "cafebabe"

	if got := inspectDaemon(home); got != DaemonNotRunning {
		t.Fatalf("데몬이 없는데 %v", got)
	}
}

// FR-DFP-10 — 불일치는 어긋남이지 고장이 아니다. `health` 의 종료 코드는 생존의
// 답이므로 낡은 데몬이 그것을 1 로 바꾸지 않는다.
func TestRunHealth_DaemonOnly_StaleKeepsExitZero(t *testing.T) {
	home := t.TempDir()
	writePID(t, home, os.Getpid())
	writeDaemonBuild(t, home, "deadbeef")

	old := DaemonBuild
	defer func() { DaemonBuild = old }()
	DaemonBuild = "cafebabe"

	var out, errOut bytes.Buffer
	o := HealthOpts{DaemonOnly: true}
	o.Common.Home = home
	if code := RunHealth(o, &out, &errOut); code != 0 {
		t.Fatalf("종료 코드 %d, stderr=%q", code, errOut.String())
	}
	if !strings.Contains(out.String(), "--restart-daemon") {
		t.Fatalf("불일치를 말하지 않았다: %q", out.String())
	}
}

// FR-DFP-9 — 데몬을 살려 둔 채 뜨는 기동이 낡음을 말한다. 세 자리가 같은
// 문구를 쓰는지도 여기서 걸린다 (FR-DFP-11).
//
// 소켓의 존재를 **인자로** 받는 이유는 종단의 모양이 플랫폼마다 다르기
// 때문이다 — 유닉스는 파일이고 윈도우는 named pipe 라, 검사가 파일을 만들어
// 흉내 내면 한쪽에서만 성립한다 (WINDOWS_TEST_PARITY_SRS 와 같은 근거).
func TestRunningDaemonNotice(t *testing.T) {
	home := t.TempDir()
	old := DaemonBuild
	defer func() { DaemonBuild = old }()
	DaemonBuild = "cafebabe"

	// 데몬이 없으면 종전 문구 그대로다.
	if got := runningDaemonNotice(home, false); strings.Contains(got, "--restart-daemon") {
		t.Fatalf("데몬이 없는데 재시작을 권한다: %q", got)
	}

	// 돌고 있고 지문이 다르면 경고가 붙는다.
	writePID(t, home, os.Getpid())
	writeDaemonBuild(t, home, "deadbeef")
	got := runningDaemonNotice(home, true)
	if !strings.Contains(got, "세션 보존") {
		t.Fatalf("종전 문구가 사라졌다: %q", got)
	}
	if !strings.Contains(got, daemonStateLine(DaemonStale)) {
		t.Fatalf("낡음을 말하지 않았다: %q", got)
	}

	// 지문이 같으면 붙지 않는다.
	writeDaemonBuild(t, home, "cafebabe")
	if got := runningDaemonNotice(home, true); strings.Contains(got, "--restart-daemon") {
		t.Fatalf("일치인데 재시작을 권한다: %q", got)
	}
}

func writeDaemonBuild(t *testing.T, home, fp string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(home, toolipc.DaemonBuildFile),
		[]byte(fp+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
}

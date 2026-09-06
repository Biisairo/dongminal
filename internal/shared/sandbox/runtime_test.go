package sandbox

import (
	"errors"
	"strings"
	"testing"
)

// UX_BATCH5_SRS 묶음 B — 런타임 상태와 기동 (FR-SRT-1~4).
//
// 판정 로직 전량을 런타임 없는 호스트에서 시험한다 — `look` 과 `run` 을 주입하는
// 이유가 그것이고, 이 패키지 전체의 규약이다 (SRS §4.1).

func TestRuntimeStateMissing(t *testing.T) {
	// FR-SRT-2(1): 바이너리가 없으면 그 자리에서 끝난다 — 데몬을 묻지 않는다.
	called := false
	st := Probe("linux",
		func(string) (string, error) { return "", errors.New("not found") },
		func(string, []string) (string, error) { called = true; return "", nil },
	)
	if st.State != RuntimeMissing {
		t.Fatalf("state = %q, want %q", st.State, RuntimeMissing)
	}
	if st.Path != "" {
		t.Errorf("path = %q, want empty", st.Path)
	}
	if called {
		t.Error("바이너리가 없는데 런타임을 실행했다")
	}
}

func TestRuntimeStateOK(t *testing.T) {
	// FR-SRT-2(2): `docker info` 가 성공하면 ok 이고 detail 은 비어 있다.
	var gotPath string
	var gotArgs []string
	st := Probe("linux",
		func(string) (string, error) { return "/usr/local/bin/docker", nil },
		func(p string, a []string) (string, error) {
			gotPath, gotArgs = p, a
			return "27.1.1\n", nil
		},
	)
	if st.State != RuntimeOK {
		t.Fatalf("state = %q, want %q", st.State, RuntimeOK)
	}
	if st.Path != "/usr/local/bin/docker" {
		t.Errorf("path = %q", st.Path)
	}
	if st.Detail != "" {
		t.Errorf("ok 인데 detail 이 있다: %q", st.Detail)
	}
	if gotPath != "/usr/local/bin/docker" {
		t.Errorf("실행 경로 = %q — LookPath 가 준 것을 그대로 써야 한다", gotPath)
	}
	// 판정에 쓰는 명령이 무엇인지가 계약의 일부다 — 바뀌면 여기서 드러나야 한다.
	if len(gotArgs) == 0 || gotArgs[0] != "info" {
		t.Errorf("args = %v, want info …", gotArgs)
	}
}

func TestRuntimeStateStoppedByDaemonMessage(t *testing.T) {
	// FR-SRT-2(2): 데몬에 닿지 못한 출력은 stopped 다. 판정은 runtimeDown 하나를
	// 지난다 — 같은 사실을 두 곳에서 세면 어긋난다.
	out := "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?"
	st := Probe("linux",
		func(string) (string, error) { return "/usr/bin/docker", nil },
		func(string, []string) (string, error) { return out, errors.New("exit status 1") },
	)
	if st.State != RuntimeStopped {
		t.Fatalf("state = %q, want %q", st.State, RuntimeStopped)
	}
	if !strings.Contains(st.Detail, "Cannot connect") {
		t.Errorf("사유가 실리지 않았다: %q", st.Detail)
	}
}

func TestRuntimeStateStoppedOnAnyFailure(t *testing.T) {
	// FR-SRT-2(2) 마지막 줄: 사유를 알아보지 못한 실패도 stopped 다. 사용자에게는
	// "쓸 수 없다" 가 같으며, 알아보지 못한 출력을 ok 로 낮추면 창을 만드는
	// 순간까지 실패가 미뤄진다 (§2.3 이 고치려는 바로 그것이다).
	st := Probe("linux",
		func(string) (string, error) { return "/usr/bin/docker", nil },
		func(string, []string) (string, error) { return "permission denied", errors.New("exit status 1") },
	)
	if st.State != RuntimeStopped {
		t.Fatalf("state = %q, want %q", st.State, RuntimeStopped)
	}
	if !strings.Contains(st.Detail, "permission denied") {
		t.Errorf("사유가 실리지 않았다: %q", st.Detail)
	}
}

func TestRuntimeStateCarriesOS(t *testing.T) {
	// FR-SRT-1: 화면이 설치 명령을 고르는 근거다. 서버의 OS 여야 한다 — 브라우저의
	// 것이 아니다 (D-3).
	st := Probe("linux",
		func(string) (string, error) { return "/usr/bin/docker", nil },
		func(string, []string) (string, error) { return "27.1.1", nil },
	)
	// 주입한 값이 그대로 실린다 — `runtime.GOOS` 를 여기서 읽지 않는 것이
	// 이음매 규칙이다 (FR-XPL-5).
	if st.OS != "linux" {
		t.Fatalf("OS = %q, want linux", st.OS)
	}
	if st.Runtime != "docker" {
		t.Errorf("runtime = %q, want docker", st.Runtime)
	}
}

func TestProbeCarriesCommands(t *testing.T) {
	// FR-SRT-1: 명령을 **응답이 싣는다**. 화면이 os 로 다시 고르면 같은 표가 두
	// 벌이 되고, 안내한 명령과 서버가 실행하는 명령이 어긋날 수 있다 (D-3).
	//
	// 상태와 무관하게 채운다 — missing 갈래에서도 설치 명령이 있어야 한다.
	st := Probe("linux",
		func(string) (string, error) { return "", errors.New("not found") },
		func(string, []string) (string, error) { return "", nil },
	)
	if st.InstallCommand != InstallCommand(st.OS) {
		t.Errorf("installCommand = %q, want %q", st.InstallCommand, InstallCommand(st.OS))
	}
	wantCmd, wantTry := StartCommand(st.OS)
	if st.StartCommand != wantCmd || st.StartTryable != wantTry {
		t.Errorf("start = (%q,%v), want (%q,%v)", st.StartCommand, st.StartTryable, wantCmd, wantTry)
	}
}

func TestStartCommandPerOS(t *testing.T) {
	// FR-SRT-3: OS 별 명령. linux 는 **시도하지 않고** 사용자가 칠 명령을 준다
	// (D-5) — sudo 를 부르면 비밀번호를 받을 길이 없어 무응답으로 멈춘다.
	for _, tc := range []struct {
		os      string
		wantTry bool
		want    string
	}{
		{"darwin", true, "open -a Docker"},
		{"windows", true, "Docker Desktop"},
		{"linux", false, "systemctl start docker"},
	} {
		cmd, try := StartCommand(tc.os)
		if try != tc.wantTry {
			t.Errorf("%s: try = %v, want %v", tc.os, try, tc.wantTry)
		}
		if !strings.Contains(cmd, tc.want) {
			t.Errorf("%s: cmd = %q, want to contain %q", tc.os, cmd, tc.want)
		}
	}
}

func TestWSLIsTreatedAsLinux(t *testing.T) {
	// `platform.OSKind` 는 WSL 을 linux 와 가르지만(FR-XWS-2) 그것은 기록·표시를
	// 위해서다. 데몬을 띄우는 방법은 같으므로 여기서는 가르지 않는다 — 가르면
	// WSL 사용자가 "모르는 운영체제" 갈래로 떨어져 명령을 하나도 못 받는다.
	lc, lt := StartCommand("linux")
	wc, wt := StartCommand("wsl")
	if lc != wc || lt != wt {
		t.Errorf("wsl = (%q,%v), linux = (%q,%v) — 갈라졌다", wc, wt, lc, lt)
	}
	if InstallCommand("wsl") != InstallCommand("linux") {
		t.Errorf("설치 명령이 갈라졌다: %q vs %q", InstallCommand("wsl"), InstallCommand("linux"))
	}
}

func TestStartCommandUnknownOS(t *testing.T) {
	// 모르는 OS 에서 무엇인가를 실행하지 않는다. 명령을 지어내는 것보다 아무것도
	// 하지 않는 편이 낫다 — 사용자는 자기 OS 의 방법을 안다.
	cmd, try := StartCommand("plan9")
	if try {
		t.Error("모르는 OS 에서 실행을 시도한다")
	}
	if cmd == "" {
		t.Error("칠 명령조차 주지 않으면 사용자가 할 수 있는 일이 없다")
	}
}

func TestStartRuntimeSkipsWhenNotTryable(t *testing.T) {
	// FR-SRT-3: linux 에서는 아무것도 실행하지 않는다. `started:false` 와 명령이
	// 답이다.
	ran := false
	res := StartRuntime("linux", func(string, []string) (string, error) {
		ran = true
		return "", nil
	})
	if ran {
		t.Error("linux 에서 기동을 실행했다")
	}
	if res.Started {
		t.Error("started = true — 실행하지 않았는데 참이다")
	}
	if !strings.Contains(res.Command, "systemctl") {
		t.Errorf("command = %q", res.Command)
	}
}

func TestStartRuntimeReportsFailure(t *testing.T) {
	// FR-SRT-4: `started` 는 **명령이 오류 없이 반환됐다**는 뜻일 뿐이다. 실패는
	// 사유와 함께 온다 — 삼키면 사용자는 눌러도 아무 일이 없는 것으로 읽는다.
	res := StartRuntime("darwin", func(string, []string) (string, error) {
		return "Unable to find application named 'Docker'", errors.New("exit status 1")
	})
	if res.Started {
		t.Error("실패했는데 started = true")
	}
	if !strings.Contains(res.Detail, "Unable to find") {
		t.Errorf("사유가 실리지 않았다: %q", res.Detail)
	}
}

func TestStartRuntimeSuccess(t *testing.T) {
	res := StartRuntime("darwin", func(string, []string) (string, error) { return "", nil })
	if !res.Started {
		t.Error("started = false — 오류 없이 반환됐다")
	}
	if res.Command == "" {
		t.Error("시도한 명령을 밝히지 않았다")
	}
}

func TestInstallCommandPerOS(t *testing.T) {
	// FR-SRT-6: **그 OS 의 명령 하나**다. 셋을 다 보이면 자기 것이 아닌 둘은
	// 고를 것이 아니라 잡음이다.
	for _, tc := range []struct{ os, want string }{
		{"darwin", "brew"},
		{"linux", "get.docker.com"},
		{"windows", "winget"},
	} {
		if got := InstallCommand(tc.os); !strings.Contains(got, tc.want) {
			t.Errorf("%s: %q, want to contain %q", tc.os, got, tc.want)
		}
	}
	if InstallCommand("plan9") != "" {
		t.Error("모르는 OS 에 명령을 지어내면 안 된다")
	}
}

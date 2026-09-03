package sandbox

import (
	"errors"
	"strings"
	"testing"
)

// fakeDocker 는 주입된 컨테이너 런타임이다. 호출을 기록하고 정해진 답을 낸다 —
// 런타임 없이 판단 로직 전량을 검증하기 위한 자리다 (SRS §4.1).
type fakeDocker struct {
	calls [][]string
	reply func(args []string) (string, error)
}

func (f *fakeDocker) run(args []string) (string, error) {
	f.calls = append(f.calls, args)
	if f.reply != nil {
		return f.reply(args)
	}
	return "", nil
}

func (f *fakeDocker) sawSub(sub string) bool {
	for _, c := range f.calls {
		if len(c) > 0 && c[0] == sub {
			return true
		}
	}
	return false
}

func (f *fakeDocker) call(sub string) []string {
	for _, c := range f.calls {
		if len(c) > 0 && c[0] == sub {
			return c
		}
	}
	return nil
}

func joined(args []string) string { return strings.Join(args, " ") }

// stateReply 는 inspect 에 상태를 돌려주는 응답기다. state 가 빈 문자열이면
// "그런 컨테이너 없음" 으로 답한다.
func stateReply(state string) func([]string) (string, error) {
	return func(args []string) (string, error) {
		if len(args) > 0 && args[0] == "inspect" {
			if state == "" {
				return "", errors.New("No such object")
			}
			return state + "\n", nil
		}
		return "", nil
	}
}

func newMgr(f *fakeDocker) *Manager { return New(f.run, "/home/u/.dongminal") }

// ── FR-SBX-5: 이름과 라벨 ─────────────────────────────

func TestContainerName_IsWindowScoped(t *testing.T) {
	m := newMgr(&fakeDocker{})
	got := m.ContainerName("w-123")
	if got != "dongminal-sbx-w-123" {
		t.Fatalf("이름 규칙이 다르다: %q", got)
	}
}

// ── FR-SBX-6/7/26: 지연 생성·재사용·재시작 ─────────────

func TestEnsure_CreatesWhenAbsent(t *testing.T) {
	f := &fakeDocker{reply: stateReply("")}
	if err := newMgr(f).Ensure("w1", Scratch(), RunSpec{}); err != nil {
		t.Fatalf("Ensure 실패: %v", err)
	}
	run := f.call("run")
	if run == nil {
		t.Fatal("컨테이너를 만들지 않았다")
	}
	got := joined(run)
	for _, want := range []string{
		"-d", "--name dongminal-sbx-w1",
		"--label dongminal.window=w1",
		"--label dongminal.home=/home/u/.dongminal",
		"--network none", "debian:stable-slim",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("run argv 에 %q 가 없다: %s", want, got)
		}
	}
}

// FR-SBX-7: --rm 은 파일시스템을 날린다. 절대 붙어서는 안 된다.
func TestEnsure_NeverUsesRmFlag(t *testing.T) {
	f := &fakeDocker{reply: stateReply("")}
	if err := newMgr(f).Ensure("w1", Scratch(), RunSpec{}); err != nil {
		t.Fatalf("Ensure 실패: %v", err)
	}
	for _, a := range f.call("run") {
		if a == "--rm" {
			t.Fatal("--rm 이 붙었다 — 컨테이너 파일시스템이 소실된다 (FR-SBX-7)")
		}
	}
}

func TestEnsure_ReusesRunningContainer(t *testing.T) {
	f := &fakeDocker{reply: stateReply("running")}
	if err := newMgr(f).Ensure("w1", Scratch(), RunSpec{}); err != nil {
		t.Fatalf("Ensure 실패: %v", err)
	}
	if f.sawSub("run") || f.sawSub("start") {
		t.Fatalf("이미 도는 컨테이너를 건드렸다: %v", f.calls)
	}
}

// FR-SBX-26: 정지 상태에서는 exec 가 실패한다 (실기 확인 §2.6). 시작해야 한다.
func TestEnsure_StartsStoppedContainer(t *testing.T) {
	f := &fakeDocker{reply: stateReply("exited")}
	if err := newMgr(f).Ensure("w1", Scratch(), RunSpec{}); err != nil {
		t.Fatalf("Ensure 실패: %v", err)
	}
	if !f.sawSub("start") {
		t.Fatalf("정지된 컨테이너를 시작하지 않았다: %v", f.calls)
	}
	if f.sawSub("run") {
		t.Fatal("정지된 컨테이너가 있는데 새로 만들었다 — 파일시스템이 버려진다")
	}
}

// ── FR-SBX-20/21: 실패는 전파된다 ──────────────────────

func TestEnsure_PropagatesCreateFailure(t *testing.T) {
	f := &fakeDocker{reply: func(args []string) (string, error) {
		if args[0] == "inspect" {
			return "", errors.New("No such object")
		}
		return "", errors.New("Unable to find image")
	}}
	if err := newMgr(f).Ensure("w1", Scratch(), RunSpec{}); err == nil {
		t.Fatal("생성 실패가 오류로 전파되지 않았다 — 호스트 셸로 강등될 위험 (FR-SBX-21)")
	}
}

// ── FR-SBX-12: exec argv ──────────────────────────────

func TestExecSpec_ShapeAndInteractiveTTY(t *testing.T) {
	spec := newMgr(&fakeDocker{}).ExecSpec("w1", "/usr/bin/docker", Scratch(), ExecEnv{})
	if spec.Path != "/usr/bin/docker" {
		t.Errorf("Path 가 docker 가 아니다: %q", spec.Path)
	}
	got := joined(spec.Args)
	if spec.Args[0] != "/usr/bin/docker" {
		t.Errorf("argv[0] 이 실행 파일이 아니다: %q", spec.Args[0])
	}
	// -it 가 없으면 SIGWINCH 가 컨테이너로 전달되지 않는다 (§2.6 실기 확인).
	if !strings.Contains(got, "exec -it") {
		t.Errorf("exec -it 가 아니다: %s", got)
	}
	if !strings.Contains(got, "dongminal-sbx-w1") {
		t.Errorf("대상 컨테이너가 없다: %s", got)
	}
}

// FR-SBX-13: 마운트가 없는 프로파일은 이미지 기본 작업 디렉터리를 쓴다.
func TestExecSpec_NoWorkdirWithoutMounts(t *testing.T) {
	spec := newMgr(&fakeDocker{}).ExecSpec("w1", "docker", Scratch(), ExecEnv{})
	for _, a := range spec.Args {
		if a == "-w" {
			t.Fatal("마운트가 없는데 -w 를 붙였다 — 존재하지 않는 경로다 (FR-SBX-13)")
		}
	}
}

// ── FR-SBX-8: 제거 ────────────────────────────────────

func TestRemove_ForcesRemoval(t *testing.T) {
	f := &fakeDocker{}
	if err := newMgr(f).Remove("w1"); err != nil {
		t.Fatalf("Remove 실패: %v", err)
	}
	got := joined(f.call("rm"))
	if !strings.Contains(got, "-f") || !strings.Contains(got, "dongminal-sbx-w1") {
		t.Fatalf("rm argv 가 다르다: %s", got)
	}
}

// 이미 없는 컨테이너의 제거는 오류가 아니다 — Window 폐기 경로를 막으면 안 된다.
func TestRemove_ToleratesMissing(t *testing.T) {
	f := &fakeDocker{reply: func([]string) (string, error) {
		return "", errors.New("No such container")
	}}
	if err := newMgr(f).Remove("w1"); err != nil {
		t.Fatalf("없는 컨테이너 제거가 오류가 됐다: %v", err)
	}
}

// ── FR-SBX-9: 고아 회수 범위 ──────────────────────────

func TestReapOrphans_RemovesOnlyDeadWindows(t *testing.T) {
	f := &fakeDocker{reply: func(args []string) (string, error) {
		if args[0] == "ps" {
			return "dongminal-sbx-live w-live\ndongminal-sbx-dead w-dead\n", nil
		}
		return "", nil
	}}
	live := map[string]struct{}{"w-live": {}}
	if err := newMgr(f).ReapOrphans(live); err != nil {
		t.Fatalf("ReapOrphans 실패: %v", err)
	}
	var removed []string
	for _, c := range f.calls {
		if c[0] == "rm" {
			removed = append(removed, joined(c))
		}
	}
	if len(removed) != 1 || !strings.Contains(removed[0], "dongminal-sbx-dead") {
		t.Fatalf("살아 있는 Window 의 컨테이너를 지웠거나 고아를 남겼다: %v", removed)
	}
}

// 조회 자체가 자기 홈으로 좁혀져야 한다. 한 호스트에 여러 인스턴스가 돈다.
func TestReapOrphans_ScopesToOwnHome(t *testing.T) {
	f := &fakeDocker{}
	if err := newMgr(f).ReapOrphans(map[string]struct{}{}); err != nil {
		t.Fatalf("ReapOrphans 실패: %v", err)
	}
	got := joined(f.call("ps"))
	if !strings.Contains(got, "label=dongminal.home=/home/u/.dongminal") {
		t.Fatalf("조회가 자기 홈으로 좁혀지지 않았다: %s", got)
	}
}

// docker exec 는 호스트의 TERM 을 컨테이너로 전파하지 않는다. 넘기지 않으면
// 컨테이너 안이 dumb 터미널이 되어 TUI 와 색이 깨진다.
func TestExecSpec_CarriesTermIntoContainer(t *testing.T) {
	spec := newMgr(&fakeDocker{}).ExecSpec("w1", "docker", Scratch(), ExecEnv{})
	got := joined(spec.Args)
	if !strings.Contains(got, "-e TERM=xterm-256color") {
		t.Fatalf("TERM 을 컨테이너로 넘기지 않았다: %s", got)
	}
	// -e 는 대상 컨테이너 이름보다 앞에 와야 한다. 뒤에 두면 docker 가 그것을
	// 컨테이너 안에서 실행할 명령으로 읽는다.
	if strings.Index(got, "-e TERM") > strings.Index(got, "dongminal-sbx-w1") {
		t.Fatalf("-e 가 컨테이너 이름 뒤에 있다: %s", got)
	}
}

// ── FR-SBX-20: 런타임 부재와 컨테이너 부재는 다르다 ──

// 데몬이 꺼져 있으면 inspect 가 실패한다. 그것을 "컨테이너가 없다" 로 읽으면
// 생성으로 넘어가 다시 실패하고, 사용자는 "이미지를 만들지 못했다" 는 엉뚱한
// 사유를 본다. 원인을 가리키는 오류가 나와야 한다.
func TestEnsure_DaemonDownIsNotMistakenForMissingContainer(t *testing.T) {
	f := &fakeDocker{reply: func(args []string) (string, error) {
		return "Cannot connect to the Docker daemon at unix:///var/run/docker.sock.", errors.New("exit status 1")
	}}
	err := newMgr(f).Ensure("w1", Scratch(), RunSpec{})
	if err == nil {
		t.Fatal("데몬이 꺼졌는데 성공했다")
	}
	if f.sawSub("run") {
		t.Error("데몬이 꺼진 상태에서 컨테이너 생성을 시도했다")
	}
	if !strings.Contains(err.Error(), "런타임") {
		t.Errorf("사유가 런타임을 가리키지 않는다: %v", err)
	}
}

// 컨테이너만 없는 경우는 종전대로 생성으로 간다.
func TestEnsure_NoSuchObjectStillCreates(t *testing.T) {
	f := &fakeDocker{reply: func(args []string) (string, error) {
		if args[0] == "inspect" {
			return "Error: No such object: dongminal-sbx-w1", errors.New("exit status 1")
		}
		return "", nil
	}}
	if err := newMgr(f).Ensure("w1", Scratch(), RunSpec{}); err != nil {
		t.Fatalf("Ensure 실패: %v", err)
	}
	if !f.sawSub("run") {
		t.Fatal("컨테이너가 없는데 만들지 않았다")
	}
}

// ── FR-SBX-20: 런타임 탐색 ────────────────────────────

func TestFindRuntime_MissingGivesActionableError(t *testing.T) {
	_, err := FindRuntime(func(string) (string, error) { return "", errors.New("not found") })
	if err == nil {
		t.Fatal("런타임이 없는데 성공했다")
	}
	if !strings.Contains(err.Error(), "docker") {
		t.Errorf("무엇이 없는지 말하지 않는다: %v", err)
	}
}

func TestFindRuntime_ReturnsResolvedPath(t *testing.T) {
	got, err := FindRuntime(func(string) (string, error) { return "/usr/local/bin/docker", nil })
	if err != nil || got != "/usr/local/bin/docker" {
		t.Fatalf("경로가 다르다: %q %v", got, err)
	}
}

// ── FR-SBX-1/13/30: 마운트 · 작업 디렉터리 · 포트 ──

func devProfile() Profile {
	return Profile{Name: ProfileDev, Image: "node:22", Network: "bridge",
		Ports: []string{"3000", "5173-5180"}, Mount: true, Helper: true}
}

func TestEnsure_MountsWorkdirAndPublishesPorts(t *testing.T) {
	f := &fakeDocker{reply: stateReply("")}
	if err := newMgr(f).Ensure("w1", devProfile(), RunSpec{HostDir: "/Users/me/app"}); err != nil {
		t.Fatalf("Ensure: %v", err)
	}
	got := joined(f.call("run"))
	for _, want := range []string{
		"-v /Users/me/app:" + ContainerWorkdir,
		// 호스트와 같은 번호여야 한다. 컨테이너 안 서버가 찍는 localhost:3000 이
		// 호스트에서도 3000 이어야 그 안내가 맞다 (FR-SBX-30).
		"-p 3000:3000", "-p 5173-5180:5173-5180",
		"--network bridge",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("run argv 에 %q 가 없다: %s", want, got)
		}
	}
}

// 마운트할 자리가 없으면 마운트하지 않는다 — 빈 경로를 넘기면 런타임이 거부한다.
func TestEnsure_NoMountWithoutHostDir(t *testing.T) {
	f := &fakeDocker{reply: stateReply("")}
	if err := newMgr(f).Ensure("w1", devProfile(), RunSpec{}); err != nil {
		t.Fatalf("Ensure: %v", err)
	}
	for _, a := range f.call("run") {
		if a == "-v" {
			t.Fatal("호스트 경로가 없는데 마운트를 붙였다")
		}
	}
}

// scratch 는 마운트도 포트도 없다 — 그것이 격리 경계인 이유의 절반이다.
func TestEnsure_ScratchHasNoMountOrPorts(t *testing.T) {
	f := &fakeDocker{reply: stateReply("")}
	if err := newMgr(f).Ensure("w1", Scratch(), RunSpec{HostDir: "/Users/me/app"}); err != nil {
		t.Fatalf("Ensure: %v", err)
	}
	for _, a := range f.call("run") {
		if a == "-v" || a == "-p" {
			t.Fatalf("scratch 에 %s 가 붙었다", a)
		}
	}
}

// FR-SBX-13: 마운트가 있는 프로파일은 컨테이너 안 작업 디렉터리를 지정한다.
func TestExecSpec_UsesContainerWorkdirWhenMounted(t *testing.T) {
	spec := newMgr(&fakeDocker{}).ExecSpec("w1", "docker", devProfile(), ExecEnv{})
	got := joined(spec.Args)
	if !strings.Contains(got, "-w "+ContainerWorkdir) {
		t.Fatalf("작업 디렉터리를 지정하지 않았다: %s", got)
	}
}

// ── FR-SBX-16/17: 컨테이너 안의 헬퍼 ──

func TestEnsure_MountsHelperReadOnlyWhenProfileWantsIt(t *testing.T) {
	f := &fakeDocker{reply: stateReply("")}
	rs := RunSpec{HostDir: "/Users/me/app", HelperPath: "/h/cache/dmctl-dev-linux-arm64"}
	if err := newMgr(f).Ensure("w1", devProfile(), rs); err != nil {
		t.Fatalf("Ensure: %v", err)
	}
	got := joined(f.call("run"))
	want := "-v /h/cache/dmctl-dev-linux-arm64:" + HelperMountPath + ":ro"
	if !strings.Contains(got, want) {
		t.Fatalf("헬퍼를 읽기 전용으로 붙이지 않았다: %s", got)
	}
}

// FR-SBX-17: scratch 에는 헬퍼가 없다. 그것이 이 프로파일만 격리 경계인 이유다.
func TestEnsure_ScratchNeverGetsHelper(t *testing.T) {
	f := &fakeDocker{reply: stateReply("")}
	rs := RunSpec{HostDir: "/Users/me/app", HelperPath: "/h/cache/dmctl-dev-linux-arm64"}
	if err := newMgr(f).Ensure("w1", Scratch(), rs); err != nil {
		t.Fatalf("Ensure: %v", err)
	}
	if strings.Contains(joined(f.call("run")), HelperMountPath) {
		t.Fatal("scratch 에 헬퍼가 들어갔다 — 격리 경계가 사라진다")
	}
}

// FR-SBX-16: 컨테이너 안 dmctl 이 서버에 닿는 길. 전송 계층은 그대로이고
// 주소만 컨테이너에서 호스트를 가리키게 바꾼다.
func TestExecSpec_CarriesHelperEnvironment(t *testing.T) {
	env := ExecEnv{ToolID: "tool-9", Port: "58146"}
	spec := newMgr(&fakeDocker{}).ExecSpec("w1", "docker", devProfile(), env)
	got := joined(spec.Args)
	for _, want := range []string{
		"-e DONGMINAL_HOST=" + HostGateway,
		"-e DONGMINAL_PORT=58146",
		"-e DONGMINAL_TOOL_ID=tool-9",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("%q 가 없다: %s", want, got)
		}
	}
}

func TestExecSpec_ScratchGetsNoHelperEnvironment(t *testing.T) {
	env := ExecEnv{ToolID: "tool-9", Port: "58146"}
	spec := newMgr(&fakeDocker{}).ExecSpec("w1", "docker", Scratch(), env)
	if strings.Contains(joined(spec.Args), "DONGMINAL_TOOL_ID") {
		t.Fatal("scratch 에 서버 접속 정보가 들어갔다")
	}
}

// 컨테이너에서 호스트를 부르는 이름은 런타임이 풀어 준다. 리눅스 호스트에서도
// 같은 이름이 서도록 게이트웨이를 명시한다 (NFR-SBX-1).
func TestEnsure_AddsHostGatewayForHelperProfiles(t *testing.T) {
	f := &fakeDocker{reply: stateReply("")}
	rs := RunSpec{HostDir: "/a", HelperPath: "/h/dmctl"}
	if err := newMgr(f).Ensure("w1", devProfile(), rs); err != nil {
		t.Fatalf("Ensure: %v", err)
	}
	if !strings.Contains(joined(f.call("run")), "--add-host "+HostGateway+":host-gateway") {
		t.Fatalf("host-gateway 를 세우지 않았다: %s", joined(f.call("run")))
	}
}

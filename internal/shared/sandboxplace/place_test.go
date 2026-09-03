package sandboxplace

import (
	"errors"
	"io/fs"
	"strings"
	"testing"

	"dongminal/internal/shared/sandbox"
	"dongminal/internal/shared/toolhub"
)

type fakeDocker struct {
	calls [][]string
	fail  bool
}

func (f *fakeDocker) run(args []string) (string, error) {
	f.calls = append(f.calls, args)
	if f.fail {
		return "boom", errors.New("exit status 1")
	}
	// 기본은 "그런 컨테이너 없음" 이다 — 생성 경로를 지나야 마운트·포트·헬퍼가
	// argv 에 나타난다.
	if len(args) > 0 && args[0] == "inspect" {
		return "Error: No such object", errors.New("exit status 1")
	}
	return "", nil
}

func (f *fakeDocker) joined(sub string) string {
	for _, c := range f.calls {
		if len(c) > 0 && c[0] == sub {
			return strings.Join(c, " ")
		}
	}
	return ""
}

// helperDeps 는 이미 캐시에 있는 헬퍼를 흉내낸다 — 확보 경로는 sandbox 패키지가
// 따로 시험한다.
func helperDeps(present bool, err error) sandbox.HelperDeps {
	return sandbox.HelperDeps{
		Version: "v1.0.0", Arch: "arm64", Home: "/h",
		Stat: func(string) error {
			if present {
				return nil
			}
			return fs.ErrNotExist
		},
		Fetch:      func(string, string) error { return err },
		CrossBuild: func(string, string) error { return err },
	}
}

func devProfiles() map[string]sandbox.Profile {
	return map[string]sandbox.Profile{
		sandbox.ProfileScratch: sandbox.Scratch(),
		sandbox.ProfileDev: {Name: sandbox.ProfileDev, Image: "node:22", Network: "bridge",
			Ports: []string{"3000"}, Mount: true, Helper: true},
	}
}

func newPlacer(f *fakeDocker, profiles map[string]sandbox.Profile, h sandbox.HelperDeps) *Placer {
	return New(sandbox.New(f.run, "/h"), "/usr/bin/docker", profiles, h, "58146")
}

func TestPlace_ScratchYieldsContainerSpecWithoutHelper(t *testing.T) {
	f := &fakeDocker{}
	spec, err := newPlacer(f, devProfiles(), helperDeps(true, nil)).
		Place(toolhub.Placement{WindowUUID: "w1", Profile: sandbox.ProfileScratch, ToolID: "t1"})
	if err != nil {
		t.Fatalf("Place: %v", err)
	}
	got := strings.Join(spec.Args, " ")
	if !strings.Contains(got, "exec -it") || !strings.Contains(got, "dongminal-sbx-w1") {
		t.Fatalf("컨테이너 exec 명세가 아니다: %s", got)
	}
	// FR-SBX-17: scratch 에는 서버 접속 정보가 없다.
	if strings.Contains(got, "DONGMINAL_TOOL_ID") {
		t.Errorf("scratch 에 접속 정보가 들어갔다: %s", got)
	}
}

// FR-SBX-14/16: 헬퍼가 있는 프로파일은 헬퍼를 붙이고 접속 정보를 심는다.
func TestPlace_DevMountsHelperAndCarriesEnv(t *testing.T) {
	f := &fakeDocker{}
	pl := toolhub.Placement{WindowUUID: "w1", Profile: sandbox.ProfileDev,
		ToolID: "t1", HostDir: "/Users/me/app"}
	spec, err := newPlacer(f, devProfiles(), helperDeps(true, nil)).Place(pl)
	if err != nil {
		t.Fatalf("Place: %v", err)
	}
	run := f.joined("run")
	if !strings.Contains(run, "-v /Users/me/app:"+sandbox.ContainerWorkdir) {
		t.Errorf("작업 디렉터리를 마운트하지 않았다: %s", run)
	}
	if !strings.Contains(run, sandbox.HelperMountPath+":ro") {
		t.Errorf("헬퍼를 붙이지 않았다: %s", run)
	}
	if !strings.Contains(run, "-p 3000:3000") {
		t.Errorf("포트를 열지 않았다: %s", run)
	}
	got := strings.Join(spec.Args, " ")
	if !strings.Contains(got, "DONGMINAL_PORT=58146") || !strings.Contains(got, "DONGMINAL_TOOL_ID=t1") {
		t.Errorf("접속 정보가 없다: %s", got)
	}
}

// FR-SBX-21: 정의되지 않은 프로파일은 실패한다. 호스트로 내려가지 않는다.
func TestPlace_UndefinedProfileFailsLoudly(t *testing.T) {
	only := map[string]sandbox.Profile{sandbox.ProfileScratch: sandbox.Scratch()}
	spec, err := newPlacer(&fakeDocker{}, only, helperDeps(true, nil)).
		Place(toolhub.Placement{WindowUUID: "w1", Profile: sandbox.ProfileDev})
	if err == nil {
		t.Fatalf("정의되지 않은 프로파일이 통과했다 (spec=%v)", spec)
	}
	if !strings.Contains(err.Error(), sandbox.ProfilesFileName) {
		t.Errorf("어디에 적어야 하는지 알려주지 않는다: %v", err)
	}
}

// 헬퍼를 확보하지 못하면 기동하지 않는다 — 헬퍼 없이 뜨면 그 창의 dmctl 이
// 조용히 없는 채로 남는다.
func TestPlace_HelperFailureStopsStartup(t *testing.T) {
	h := helperDeps(false, errors.New("네트워크 없음"))
	_, err := newPlacer(&fakeDocker{}, devProfiles(), h).
		Place(toolhub.Placement{WindowUUID: "w1", Profile: sandbox.ProfileDev, HostDir: "/a"})
	if err == nil {
		t.Fatal("헬퍼 확보 실패가 전파되지 않았다")
	}
}

func TestPlace_RuntimeFailurePropagates(t *testing.T) {
	f := &fakeDocker{fail: true}
	_, err := newPlacer(f, devProfiles(), helperDeps(true, nil)).
		Place(toolhub.Placement{WindowUUID: "w1", Profile: sandbox.ProfileScratch})
	if err == nil {
		t.Fatal("런타임 실패가 전파되지 않았다")
	}
}

func TestReap_SkipsWhenWorkspaceUnknown(t *testing.T) {
	f := &fakeDocker{}
	newPlacer(f, devProfiles(), helperDeps(true, nil)).Reap(nil)
	if len(f.calls) != 0 {
		t.Fatalf("판단 근거가 없는데 조회했다: %v", f.calls)
	}
}

func TestReap_QueriesWithOwnHome(t *testing.T) {
	f := &fakeDocker{}
	newPlacer(f, devProfiles(), helperDeps(true, nil)).Reap([]string{"w-live"})
	if !strings.Contains(f.joined("ps"), "label=dongminal.home=/h") {
		t.Fatalf("자기 홈으로 좁히지 않았다: %s", f.joined("ps"))
	}
}

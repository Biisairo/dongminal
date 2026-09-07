package sandboxplace

import (
	"strings"
	"testing"

	"dongminal/internal/shared/sandbox"
	"dongminal/internal/shared/toolhub"
)

// UX_BATCH6_SRS 묶음 M — 창이 고른 작업 방식이 프로파일의 것을 덮는다.
//
// 접수한 말은 "마운트가 없어도 마운트 선택 가능" 이다. 프로파일 정의(`sandbox.json`)
// 에 dev 를 적지 않은 사용자에게 마운트를 고를 길이 화면에 없었고, 그 길이 여기로
// 온다.

// V-SBM-2: scratch(복사)를 마운트로 고르면 `-v <host>:/work` 가 붙는다.
func TestPlace_WorkOverrideMountsScratch(t *testing.T) {
	f := &fakeDocker{}
	pl := toolhub.Placement{
		WindowUUID: "w1", Profile: sandbox.ProfileScratch, ToolID: "t1",
		HostDir: "/Users/me/app", Work: string(sandbox.WorkMount),
	}
	if _, err := newPlacer(f, devProfiles(), helperDeps(true, nil)).Place(pl); err != nil {
		t.Fatalf("Place: %v", err)
	}
	run := f.joined("run")
	if !strings.Contains(run, "-v /Users/me/app:"+sandbox.ContainerWorkdir) {
		t.Fatalf("고른 마운트가 반영되지 않았다: %s", run)
	}
}

// V-SBM-2: dev(마운트)를 복사로 고르면 마운트가 붙지 않는다. 반대 방향도 성립해야
// 덮어쓰기가 "한 방향의 특례" 가 아니게 된다.
func TestPlace_WorkOverrideCopiesDev(t *testing.T) {
	f := &fakeDocker{}
	pl := toolhub.Placement{
		WindowUUID: "w1", Profile: sandbox.ProfileDev, ToolID: "t1",
		HostDir: t.TempDir(), Work: string(sandbox.WorkCopy),
	}
	if _, err := newPlacer(f, devProfiles(), helperDeps(true, nil)).Place(pl); err != nil {
		t.Fatalf("Place: %v", err)
	}
	run := f.joined("run")
	if strings.Contains(run, ":"+sandbox.ContainerWorkdir) {
		t.Fatalf("복사를 골랐는데 마운트했다: %s", run)
	}
}

// V-SBM-2: 모르는 값은 무시한다. 오타 하나로 창이 열리지 않는 것보다 프로파일의
// 뜻대로 여는 편이 낫다.
func TestPlace_UnknownWorkFallsBackToProfile(t *testing.T) {
	f := &fakeDocker{}
	pl := toolhub.Placement{
		WindowUUID: "w1", Profile: sandbox.ProfileDev, ToolID: "t1",
		HostDir: "/Users/me/app", Work: "mont",
	}
	if _, err := newPlacer(f, devProfiles(), helperDeps(true, nil)).Place(pl); err != nil {
		t.Fatalf("Place: %v", err)
	}
	if run := f.joined("run"); !strings.Contains(run, "-v /Users/me/app:"+sandbox.ContainerWorkdir) {
		t.Fatalf("모르는 값이 프로파일의 마운트까지 없앴다: %s", run)
	}
}

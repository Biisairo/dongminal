package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"dongminal/internal/shared/sandbox"
	"dongminal/internal/shared/workspace"
)

type fakeReaper struct {
	calls    [][]string
	profiles []sandbox.ProfileInfo
}

func (f *fakeReaper) Reap(live []string)              { f.calls = append(f.calls, live) }
func (f *fakeReaper) Profiles() []sandbox.ProfileInfo { return f.profiles }

// FR-SBX-11: 어느 Window 의 어떤 프로파일인지가 도구 생성 요청에 실려 온다.
func TestToolsCreate_CarriesSandboxContext(t *testing.T) {
	hub := newFakePaneHub()
	srv, _ := New(Config{DataDir: t.TempDir()}, Deps{Tools: hub})
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	resp, err := http.Post(ts.URL+"/api/tools?window=w-42&sandbox=scratch", "application/json", nil)
	if err != nil {
		t.Fatalf("post: %v", err)
	}
	defer resp.Body.Close()

	if hub.lastPlace.WindowUUID != "w-42" || hub.lastPlace.Profile != "scratch" {
		t.Fatalf("샌드박스 컨텍스트가 전달되지 않았다: %+v", hub.lastPlace)
	}
}

// 샌드박스 지정이 없으면 종전대로 빈 Placement 다 (NFR-SBX-2).
func TestToolsCreate_WithoutSandboxStaysHost(t *testing.T) {
	hub := newFakePaneHub()
	srv, _ := New(Config{DataDir: t.TempDir()}, Deps{Tools: hub})
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	resp, err := http.Post(ts.URL+"/api/tools", "application/json", nil)
	if err != nil {
		t.Fatalf("post: %v", err)
	}
	defer resp.Body.Close()

	if hub.lastPlace.Profile != "" {
		t.Fatalf("프로파일이 붙었다: %+v", hub.lastPlace)
	}
}

// FR-SBX-8: workspace 가 저장되면 사라진 Window 의 컨테이너를 회수한다.
// 브라우저가 어떤 경로로 창을 닫았든 이 자리를 지난다.
func TestWorkspacePut_ReapsWithLiveWindows(t *testing.T) {
	fw := newFakeWorkspaceStore()
	fw.windows = []workspace.WindowInfo{{UUID: "w-live", Sandbox: "scratch"}}
	reaper := &fakeReaper{}
	srv, _ := New(Config{DataDir: t.TempDir()}, Deps{Work: fw, Sandbox: reaper})
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	req, _ := http.NewRequest(http.MethodPut, ts.URL+"/api/workspace",
		strings.NewReader(`{"schemaVersion":2,"windows":[]}`))
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("put: %v", err)
	}
	defer resp.Body.Close()

	if len(reaper.calls) != 1 {
		t.Fatalf("회수가 %d 번 불렸다", len(reaper.calls))
	}
	if len(reaper.calls[0]) != 1 || reaper.calls[0][0] != "w-live" {
		t.Fatalf("살아 있는 Window 목록이 다르다: %v", reaper.calls[0])
	}
}

// workspace 를 읽지 못하면 회수하지 않는다. nil 은 "창이 없다" 가 아니라
// "판단 근거가 없다" 이며, 빈 목록으로 넘기면 사용자의 컨테이너를 전부 지운다.
func TestWorkspacePut_UnreadableWorkspaceSkipsReap(t *testing.T) {
	fw := newFakeWorkspaceStore()
	fw.windows = nil
	reaper := &fakeReaper{}
	srv, _ := New(Config{DataDir: t.TempDir()}, Deps{Work: fw, Sandbox: reaper})
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	req, _ := http.NewRequest(http.MethodPut, ts.URL+"/api/workspace",
		strings.NewReader(`{"schemaVersion":2,"windows":[]}`))
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("put: %v", err)
	}
	defer resp.Body.Close()

	if len(reaper.calls) != 0 {
		t.Fatalf("판단 근거가 없는데 회수했다: %v", reaper.calls)
	}
}

// FR-SBX-25: 화면이 고를 수 있도록 프로파일과 그 격리 등급을 낸다.
func TestSandboxProfiles_ReportsIsolationGrade(t *testing.T) {
	reaper := &fakeReaper{profiles: []sandbox.ProfileInfo{
		{Name: "scratch", Isolated: true},
		{Name: "dev", Image: "node:22", Isolated: false, Helper: true},
	}}
	srv, _ := New(Config{DataDir: t.TempDir()}, Deps{Sandbox: reaper})
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	resp, err := http.Get(ts.URL + "/api/sandbox/profiles")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	defer resp.Body.Close()
	var got []sandbox.ProfileInfo
	if err := json.NewDecoder(resp.Body).Decode(&got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(got) != 2 || !got[0].Isolated || got[1].Isolated {
		t.Fatalf("등급이 그대로 전달되지 않았다: %+v", got)
	}
}

// 런타임이 없는 서버는 빈 목록이다 — 오류가 아니다 (NFR-SBX-3).
func TestSandboxProfiles_EmptyWithoutRuntime(t *testing.T) {
	srv, _ := New(Config{DataDir: t.TempDir()}, Deps{})
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	resp, err := http.Get(ts.URL + "/api/sandbox/profiles")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("상태가 %d 다", resp.StatusCode)
	}
	var got []sandbox.ProfileInfo
	json.NewDecoder(resp.Body).Decode(&got)
	if len(got) != 0 {
		t.Fatalf("빈 목록이 아니다: %+v", got)
	}
}

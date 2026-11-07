package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"dongminal/internal/shared/sandbox"
	"dongminal/internal/webserver/action"
	"dongminal/internal/webserver/apierr"
)

// SERVER_DRIVEN_ACTIONS_SRS X-b · TC-SDA-1·10 — 샌드박스 런타임 시작의 답과 거절.

func sbxStatus(state, goos string) sandbox.RuntimeStatus {
	st := sandbox.RuntimeStatus{State: state, OS: goos, Runtime: "docker"}
	st.StartCommand, st.StartTryable = sandbox.StartCommand(goos)
	return st
}

func TestSandboxStartAnswer(t *testing.T) {
	cases := []struct {
		name  string
		st    sandbox.RuntimeStatus
		ok    bool
		why   string
		state int
	}{
		{"미실행 · darwin 은 시도할 수 있다", sbxStatus(sandbox.RuntimeStopped, "darwin"), true, "", 0},
		{"미실행 · windows 도 시도할 수 있다", sbxStatus(sandbox.RuntimeStopped, "windows"), true, "", 0},
		{"실행 중이어도 지금처럼 참", sbxStatus(sandbox.RuntimeOK, "darwin"), true, "", 0},
		{"미설치는 OS 와 무관하게 거짓", sbxStatus(sandbox.RuntimeMissing, "darwin"), false, apierr.CodeRuntimeMissing, http.StatusConflict},
		{"linux 는 사용자가 친다", sbxStatus(sandbox.RuntimeStopped, "linux"), false, apierr.CodeRuntimeStartManual, http.StatusConflict},
		{"wsl 도 linux 와 같다", sbxStatus(sandbox.RuntimeStopped, "wsl"), false, apierr.CodeRuntimeStartManual, http.StatusConflict},
		{"모르는 OS", sbxStatus(sandbox.RuntimeStopped, "plan9"), false, apierr.CodeRuntimeStartManual, http.StatusConflict},
		{"미설치가 먼저다", sbxStatus(sandbox.RuntimeMissing, "linux"), false, apierr.CodeRuntimeMissing, http.StatusConflict},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			a := sandboxStartAnswer(c.st)
			if a.OK != c.ok || a.Why != c.why || a.Status != c.state {
				t.Fatalf("answer = %+v, want ok=%v why=%q status=%d", a, c.ok, c.why, c.state)
			}
			if !a.OK && !action.Catalog.MayGive(action.SandboxRuntimeStart, a.Why) {
				t.Fatalf("%s 의 사유 %q 가 Catalog 에 없다", action.SandboxRuntimeStart, a.Why)
			}
		})
	}
}

func TestSandboxRuntimeViewCarriesAnswer(t *testing.T) {
	rec := httptest.NewRecorder()
	writeSandboxRuntime(rec, sbxStatus(sandbox.RuntimeStopped, "linux"))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	var got struct {
		State        string                   `json:"state"`
		StartTryable bool                     `json:"startTryable"`
		Actions      map[string]action.Answer `json:"actions"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if got.State != sandbox.RuntimeStopped {
		t.Fatalf("state = %q — 기존 필드가 그대로 실려야 한다", got.State)
	}
	a, ok := got.Actions[action.SandboxRuntimeStart]
	if !ok || a.OK || a.Why != apierr.CodeRuntimeStartManual {
		t.Fatalf("actions = %+v, want %s=runtime_start_manual", got.Actions, action.SandboxRuntimeStart)
	}
}

// SERVER_DRIVEN_ACTIONS_SRS K-i ①: 상태 이름의 뜻(`ready`·`installed`)을 함께 싣는다.
func TestSandboxRuntimeViewCarriesFacts(t *testing.T) {
	cases := []struct {
		state            string
		ready, installed bool
	}{
		{sandbox.RuntimeOK, true, true},
		{sandbox.RuntimeStopped, false, true},
		{sandbox.RuntimeMissing, false, false},
	}
	for _, c := range cases {
		rec := httptest.NewRecorder()
		writeSandboxRuntime(rec, sbxStatus(c.state, "darwin"))
		var got struct {
			Ready     *bool `json:"ready"`
			Installed *bool `json:"installed"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
			t.Fatal(err)
		}
		if got.Ready == nil || got.Installed == nil || *got.Ready != c.ready || *got.Installed != c.installed {
			t.Fatalf("%s: body = %s, want ready=%v installed=%v", c.state, rec.Body.String(), c.ready, c.installed)
		}
	}
}

// 답이 거짓이면 실행도 같은 코드로 거절되고, 아무것도 실행하지 않는다 (TC-SDA-1).
func TestSandboxStartRejectsWithAnswer(t *testing.T) {
	for _, st := range []sandbox.RuntimeStatus{
		sbxStatus(sandbox.RuntimeMissing, "darwin"),
		sbxStatus(sandbox.RuntimeStopped, "linux"),
	} {
		want := sandboxStartAnswer(st)
		ran := false
		rec := httptest.NewRecorder()
		writeSandboxStart(rec, st, func(string, []string) (string, error) { ran = true; return "", nil })
		if rec.Code != want.Status {
			t.Fatalf("%s/%s: status = %d, want %d", st.State, st.OS, rec.Code, want.Status)
		}
		if got := rec.Header().Get(apierr.CodeHeader); got != want.Why {
			t.Fatalf("%s/%s: code = %q, want %q", st.State, st.OS, got, want.Why)
		}
		if ran {
			t.Fatalf("%s/%s: 거절했는데 명령을 실행했다", st.State, st.OS)
		}
	}
}

func TestSandboxStartRunsWhenAllowed(t *testing.T) {
	ran := false
	rec := httptest.NewRecorder()
	writeSandboxStart(rec, sbxStatus(sandbox.RuntimeStopped, "darwin"),
		func(string, []string) (string, error) { ran = true; return "", nil })
	if rec.Code != http.StatusOK || !ran {
		t.Fatalf("status = %d ran = %v, want 200 and ran", rec.Code, ran)
	}
	var res sandbox.StartResult
	if err := json.Unmarshal(rec.Body.Bytes(), &res); err != nil || !res.Started {
		t.Fatalf("body = %s, want started:true", rec.Body.String())
	}
}

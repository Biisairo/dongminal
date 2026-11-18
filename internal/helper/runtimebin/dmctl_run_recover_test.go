package runtimebin

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
)

// RUN_RECOVERY_SRS TC-RRC-8 (FR-RRC-24) — dmctl run recover.

func recoverServer(t *testing.T, reply string) (*map[string]any, func()) {
	t.Helper()
	got := map[string]any{}
	cleanup := withDmctlServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/runs/recover" {
			t.Errorf("path=%s", r.URL.Path)
		}
		b, _ := io.ReadAll(r.Body)
		json.Unmarshal(b, &got)
		w.Write([]byte(reply))
	})
	return &got, cleanup
}

func TestRunRecover_RunWide(t *testing.T) {
	got, cleanup := recoverServer(t, `{"runId":"R","results":[
		{"target":"coordinator","toolId":"T0","outcome":"resumed"},
		{"target":"member","memberId":"01a1c99e-0000","toolId":"T1","outcome":"skipped","reason":"busy"}]}`)
	defer cleanup()
	var out, errs bytes.Buffer
	if rc := runDmctl([]string{"run", "recover", "--run", "R"}, &out, &errs); rc != 0 {
		t.Fatalf("rc=%d %s", rc, errs.String())
	}
	if (*got)["runId"] != "R" || (*got)["force"] != nil || (*got)["memberId"] != nil {
		t.Fatalf("body=%v", *got)
	}
	lines := strings.Split(strings.TrimSpace(out.String()), "\n")
	if len(lines) != 2 || !strings.HasPrefix(lines[0], "coordinator") || !strings.Contains(lines[0], "resumed") ||
		!strings.Contains(lines[1], "01a1c99e") || !strings.Contains(lines[1], "skipped") || !strings.Contains(lines[1], "busy") {
		t.Fatalf("출력=%q", out.String())
	}
}

func TestRunRecover_NothingResumedIsExit1(t *testing.T) {
	_, cleanup := recoverServer(t, `{"runId":"R","results":[{"target":"member","memberId":"M","toolId":"T1","outcome":"skipped","reason":"unknown","needsForce":true}]}`)
	defer cleanup()
	var out, errs bytes.Buffer
	if rc := runDmctl([]string{"run", "recover", "--run", "R", "--member", "M"}, &out, &errs); rc != 1 {
		t.Fatalf("rc=%d", rc)
	}
	if !strings.Contains(errs.String(), "--force") {
		t.Fatalf("needsForce 안내가 없다: %q", errs.String())
	}
}

func TestRunRecover_SingleForceAndCoordinator(t *testing.T) {
	got, cleanup := recoverServer(t, `{"runId":"R","results":[{"target":"coordinator","toolId":"T0","outcome":"resumed"}]}`)
	defer cleanup()
	var out, errs bytes.Buffer
	if rc := runDmctl([]string{"run", "recover", "--run", "R", "--coordinator", "--force"}, &out, &errs); rc != 0 {
		t.Fatalf("rc=%d %s", rc, errs.String())
	}
	if (*got)["coordinator"] != true || (*got)["force"] != true {
		t.Fatalf("body=%v", *got)
	}
}

func TestRunRecover_UsageErrors(t *testing.T) {
	for _, args := range [][]string{
		{"run", "recover"},
		{"run", "recover", "--run", "R", "--force"},
		{"run", "recover", "--run", "R", "--member", "M", "--coordinator"},
	} {
		var out, errs bytes.Buffer
		if rc := runDmctl(args, &out, &errs); rc != 2 {
			t.Errorf("%v: rc=%d want 2", args, rc)
		}
	}
}

// 리뷰 지적 4: 서버가 거절한 요청(닫힌 Run 등)은 요청 오류다 — 종료 코드 2.
func TestRunRecover_ServerRejectIsExit2(t *testing.T) {
	cleanup := withDmctlServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusConflict)
		w.Write([]byte(`{"error":"run_closed","detail":"run_closed"}`))
	})
	defer cleanup()
	var out, errs bytes.Buffer
	if rc := runDmctl([]string{"run", "recover", "--run", "R"}, &out, &errs); rc != 2 {
		t.Fatalf("rc=%d want 2 (%s)", rc, errs.String())
	}
}

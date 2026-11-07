package runtimebin

import (
	"bytes"
	"net/http"
	"strings"
	"testing"
)

// ISSUE_TREE_OPS_SRS FR-ITC-5·FR-ITS-1: dmctl status 의 글자 출력에 Run 상태와 사용량 줄.

func TestStatus_TextShowsRunStateAndUsage(t *testing.T) {
	cleanup := withDmctlServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"toolId":"t1","live":true,"state":"idle","quietMs":5,
"context":{"usedPct":57,"windowTokens":200000,"tokens":114000,"source":"statusline"},
"usage":{"model":{"id":"claude-x","displayName":"Opus"},"effort":"high","cost":{"totalCostUsd":1.234},
"rateLimits":{"five_hour":{"usedPct":12},"seven_day":{"usedPct":40}}},
"member":{"id":"m1","state":"waiting-children"}}`))
	})
	defer cleanup()
	var out, errs bytes.Buffer
	if rc := runDmctl([]string{"status", "--at", "t1"}, &out, &errs); rc != 0 {
		t.Fatalf("rc=%d %s", rc, errs.String())
	}
	for _, want := range []string{"run_state=waiting-children", "model=Opus", "effort=high", "cost=$1.23", "rate=five_hour:12%,seven_day:40%"} {
		if !strings.Contains(out.String(), want) {
			t.Errorf("%q 가 없다:\n%s", want, out.String())
		}
	}
}

func TestStatus_TextWithoutUsageOrMember(t *testing.T) {
	cleanup := withDmctlServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"toolId":"t1","live":true,"state":"idle","quietMs":5}`))
	})
	defer cleanup()
	var out, errs bytes.Buffer
	if rc := runDmctl([]string{"status", "--at", "t1"}, &out, &errs); rc != 0 {
		t.Fatalf("rc=%d %s", rc, errs.String())
	}
	if strings.Contains(out.String(), "run_state=") || strings.Contains(out.String(), "model=") {
		t.Fatalf("없는 값을 적었다:\n%s", out.String())
	}
}

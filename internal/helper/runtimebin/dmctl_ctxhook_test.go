package runtimebin

import (
	"bytes"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

// ISSUE_TREE_OPS_SRS FR-ITM-10~14: 맥락 훅은 서버 판정을 additionalContext 로 옮긴다.

func ctxHookRun(t *testing.T, verdict, stdin string) (string, int) {
	t.Helper()
	t.Setenv("DONGMINAL_TOOL_ID", "tool-1")
	var asked string
	cleanup := withDmctlServer(t, func(w http.ResponseWriter, r *http.Request) {
		asked = r.URL.RequestURI()
		w.Write([]byte(verdict))
	})
	defer cleanup()
	var out, errs bytes.Buffer
	rc := runDmctlCtxHook([]string{"claude"}, strings.NewReader(stdin), &out, &errs)
	if verdict != "" && asked != "/api/tools/migration-advice?id=tool-1" {
		t.Fatalf("물은 곳=%s", asked)
	}
	return out.String(), rc
}

func TestCtxHook_AdviseCarriesPctAndEvent(t *testing.T) {
	out, rc := ctxHookRun(t, `{"verdict":"advise","usedPct":57,"ctxPct":50,"judgePct":40,"capPct":85}`, `{"hook_event_name":"PostToolUse"}`)
	if rc != 0 {
		t.Fatalf("rc=%d", rc)
	}
	var got struct {
		H struct {
			Event string `json:"hookEventName"`
			Ctx   string `json:"additionalContext"`
		} `json:"hookSpecificOutput"`
	}
	if err := json.Unmarshal([]byte(out), &got); err != nil {
		t.Fatalf("출력=%q: %v", out, err)
	}
	if got.H.Event != "PostToolUse" {
		t.Errorf("event=%q", got.H.Event)
	}
	for _, want := range []string{"지금 맥락 57% · 기준 50%", "/dongminal:migration", "시작하지 말고 지금 넘겨라", "끝내고 넘겨라", "85%"} {
		if !strings.Contains(got.H.Ctx, want) {
			t.Errorf("%q 가 없다: %s", want, got.H.Ctx)
		}
	}
}

// FR-ITM-16: 상한이면 판단 없이 지금 넘긴다.
func TestCtxHook_MustSaysNowWithoutJudgement(t *testing.T) {
	out, rc := ctxHookRun(t, `{"verdict":"must","usedPct":86,"ctxPct":50,"judgePct":40,"capPct":85}`, `{"hook_event_name":"UserPromptSubmit"}`)
	if rc != 0 {
		t.Fatalf("rc=%d", rc)
	}
	for _, want := range []string{"지금 맥락 86%", "상한 85%", "판단하지 말고", "/dongminal:migration", "UserPromptSubmit"} {
		if !strings.Contains(out, want) {
			t.Errorf("%q 가 없다: %s", want, out)
		}
	}
}

func TestCtxHook_UnknownOnceAndQuietOtherwise(t *testing.T) {
	out, _ := ctxHookRun(t, `{"verdict":"unknown","ctxPct":50}`, `{"hook_event_name":"UserPromptSubmit"}`)
	if !strings.Contains(out, "맥락 사용률을 읽을 수 없") || !strings.Contains(out, "UserPromptSubmit") {
		t.Fatalf("unknown 출력=%q", out)
	}
	for _, v := range []string{`{"verdict":"ok","usedPct":10,"ctxPct":50}`, `{"verdict":"skip","ctxPct":50}`} {
		if out, rc := ctxHookRun(t, v, `{"hook_event_name":"PostToolUse"}`); out != "" || rc != 0 {
			t.Errorf("%s: out=%q rc=%d", v, out, rc)
		}
	}
}

func TestCtxHook_SilentOnFailure(t *testing.T) {
	cleanup := withDmctlServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	})
	defer cleanup()
	t.Setenv("DONGMINAL_TOOL_ID", "tool-1")
	var out, errs bytes.Buffer
	if rc := runDmctlCtxHook([]string{"claude"}, strings.NewReader("{}"), &out, &errs); rc != 0 || out.Len() != 0 {
		t.Fatalf("rc=%d out=%q", rc, out.String())
	}
	t.Setenv("DONGMINAL_TOOL_ID", "")
	if rc := runDmctlCtxHook([]string{"claude"}, strings.NewReader("{}"), &out, &errs); rc != 0 || out.Len() != 0 {
		t.Fatalf("도구 밖 rc=%d out=%q", rc, out.String())
	}
}

// 판이 섞였을 때(새 dmctl · 옛 서버): 응답에 judgePct·capPct 가 없으면 0 으로 지어내지 않는다.
// 종전에는 「판단은 0% 부터, 0% 이상이면 무조건 넘긴다」를 내 무조건 넘기라고 읽혔다.
func TestCtxHook_OldServerWithoutJudgeCap(t *testing.T) {
	out, rc := ctxHookRun(t, `{"verdict":"advise","usedPct":54,"ctxPct":50}`, `{"hook_event_name":"PostToolUse"}`)
	if rc != 0 {
		t.Fatalf("rc=%d", rc)
	}
	if strings.Contains(out, "0% 부터") || strings.Contains(out, "0% 이상이면") || strings.Contains(out, " 0% 에 닿") {
		t.Fatalf("없는 값을 0 으로 냈다: %s", out)
	}
	for _, want := range []string{"지금 맥락 54% · 기준 50%", "시작하지 말고 지금 넘겨라", "끝내고 넘겨라"} {
		if !strings.Contains(out, want) {
			t.Errorf("%q 가 없다: %s", want, out)
		}
	}
}

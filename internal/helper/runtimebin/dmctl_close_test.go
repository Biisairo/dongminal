package runtimebin

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
)

// M9_SRS FR-M9-4 / D-M9-4 — **닫기의 답을 미리 준다.**
//
// 실행 중인 프로세스가 있는 탭을 닫으면 브라우저가 확인창을 띄운다 (FR-BG-3).
// `dmctl` 로 닫는 쪽에는 그 창에 답할 손이 없다. 브라우저는 두 답을 이미 받는다 —
// `force`(그냥 닫기)와 `keepTool`(백그라운드로 보내기) — dmctl 만 보낼 길이 없었다.
//
// 두 플래그로 나눈 이유는 D-M9-4 다: 이름이 곧 뜻이고 `--force` 는 관용어다.

func closeArgs(t *testing.T, argv []string) (map[string]any, int, string) {
	t.Helper()
	var got map[string]any
	cleanup := withDmctlServer(t, func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		json.Unmarshal(body, &got)
		w.Write([]byte(`{"ok":true}`))
	})
	defer cleanup()
	var stdout, stderr bytes.Buffer
	rc := runDmctl(argv, &stdout, &stderr)
	args, _ := got["args"].(map[string]any)
	return args, rc, stderr.String()
}

// 플래그가 없으면 지금과 같다 — 기존 호출의 동작을 바꾸지 않는다 (D-M9-4).
func TestDmctlClose_NoFlagKeepsConfirm(t *testing.T) {
	for _, cmd := range []string{"close-tab", "close-window"} {
		t.Run(cmd, func(t *testing.T) {
			args, rc, errs := closeArgs(t, []string{cmd, "--at", "550e8400-e29b-41d4-a716-446655440000"})
			if rc != 0 {
				t.Fatalf("rc=%d stderr=%s", rc, errs)
			}
			if _, ok := args["force"]; ok {
				t.Errorf("플래그 없이 force 가 실렸다: %v", args)
			}
			if _, ok := args["keepTool"]; ok {
				t.Errorf("플래그 없이 keepTool 이 실렸다: %v", args)
			}
		})
	}
}

func TestDmctlClose_ForceSkipsConfirm(t *testing.T) {
	for _, cmd := range []string{"close-tab", "close-window"} {
		t.Run(cmd, func(t *testing.T) {
			args, rc, errs := closeArgs(t, []string{cmd, "--at", "550e8400-e29b-41d4-a716-446655440000", "--force"})
			if rc != 0 {
				t.Fatalf("rc=%d stderr=%s", rc, errs)
			}
			if args["force"] != true {
				t.Errorf("--force 가 force:true 로 가지 않았다: %v", args)
			}
			if _, ok := args["keepTool"]; ok {
				t.Errorf("--force 인데 keepTool 이 실렸다: %v", args)
			}
		})
	}
}

func TestDmctlClose_BackgroundKeepsTool(t *testing.T) {
	for _, cmd := range []string{"close-tab", "close-window"} {
		t.Run(cmd, func(t *testing.T) {
			args, rc, errs := closeArgs(t, []string{cmd, "--at", "550e8400-e29b-41d4-a716-446655440000", "--background"})
			if rc != 0 {
				t.Fatalf("rc=%d stderr=%s", rc, errs)
			}
			if args["keepTool"] != true {
				t.Errorf("--background 가 keepTool:true 로 가지 않았다: %v", args)
			}
			// 백그라운드로 보내는 것도 확인창을 지나지 않아야 한다 — 답을 이미 줬다.
			if args["force"] != true {
				t.Errorf("--background 인데 확인창을 건너뛰지 않는다: %v", args)
			}
		})
	}
}

// 두 답을 함께 주면 무엇을 원하는지 알 수 없다. 골라 주는 대신 거절한다.
func TestDmctlClose_BothFlagsRejected(t *testing.T) {
	var stdout, stderr bytes.Buffer
	rc := runDmctl([]string{"close-tab", "--force", "--background"}, &stdout, &stderr)
	if rc != 2 {
		t.Fatalf("rc=%d want 2 (stderr=%s)", rc, stderr.String())
	}
	if !strings.Contains(stderr.String(), "--force") || !strings.Contains(stderr.String(), "--background") {
		t.Fatalf("사유가 두 플래그를 말하지 않는다: %s", stderr.String())
	}
}

// 닫기가 아닌 명령에는 두 플래그가 뜻이 없다 — 조용히 받으면 사용자는 들은 줄 안다.
func TestDmctlClose_FlagsRejectedElsewhere(t *testing.T) {
	for _, argv := range [][]string{
		{"new-tab", "--force"},
		{"tab-next", "--background"},
	} {
		var stdout, stderr bytes.Buffer
		if rc := runDmctl(argv, &stdout, &stderr); rc != 2 {
			t.Errorf("%v: rc=%d want 2 (stderr=%s)", argv, rc, stderr.String())
		}
	}
}

func TestDmctlHelp_MentionsCloseFlags(t *testing.T) {
	if !strings.Contains(dmctlHelp, "--force") || !strings.Contains(dmctlHelp, "--background") {
		t.Fatalf("헬프가 닫기 플래그를 말하지 않는다:\n%s", dmctlHelp)
	}
}

package runtimebin

import (
	"bytes"
	"net/http"
	"strings"
	"testing"
)

// ISSUE_AGENT_TREE_SRS NFR-ORD-1 / TC-ORD-5 — **도움말을 청하면 아무것도 하지 않는다.**
//
// 2026-11-05 실측: `close-tab --help` 가 포커스 탭을 닫았고 `split-h --help` 가 칸을
// 나눴다. `parseDmctlFlags` 가 `-h`/`--help` 를 "최상위 도움말의 몫" 이라며 건너뛰기만
// 하고, 그 뒤 명령은 그대로 서버로 갔다.
func TestDmctl_HelpFlagNeverPosts(t *testing.T) {
	cmds := []string{"split-h", "split-v", "focus", "rename-tab", "rename-window", "close-tab", "close-window",
		"open-editor", "open-url", "send-input", "msg"}
	for cmd := range dmctlSimpleActions {
		cmds = append(cmds, cmd)
	}
	for _, cmd := range cmds {
		for _, flag := range []string{"--help", "-h"} {
			t.Run(cmd+flag, func(t *testing.T) {
				posted := false
				cleanup := withDmctlServer(t, func(w http.ResponseWriter, r *http.Request) {
					posted = true
					w.Write([]byte(`{"ok":true}`))
				})
				defer cleanup()
				var stdout, stderr bytes.Buffer
				rc := runDmctl([]string{cmd, flag}, &stdout, &stderr)
				if posted {
					t.Fatalf("%s %s 가 서버에 요청을 보냈다", cmd, flag)
				}
				if rc != 0 {
					t.Errorf("rc=%d stderr=%s", rc, stderr.String())
				}
				if !strings.Contains(stdout.String(), "dmctl") {
					t.Errorf("도움말이 나오지 않았다: %q", stdout.String())
				}
			})
		}
	}
}

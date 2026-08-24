package tools

import (
	"context"
	"strings"
	"testing"
)

// workspace_command 는 브로드캐스트 화이트리스트의 부분집합만 노출한다.
// detachTab/restoreTool 은 toolId 인자를 요구하지만 WorkspaceCommandArgs 에
// 그 필드가 없으므로, 허용하면 인자 없는 명령이 브라우저에 도달해 노옵이 된다.
func TestWorkspaceCommand_RejectsNonMCPActions(t *testing.T) {
	h := WorkspaceCommandHandler(WorkspaceCommandDeps{
		Broadcaster: &fakeBroadcaster{allowed: map[string]bool{
			"detachTab": true, "restoreTool": true, "focus": true,
		}},
	})
	for _, a := range []string{"detachTab", "restoreTool"} {
		if _, err := h(context.Background(), WorkspaceCommandArgs{Action: a}); err == nil {
			t.Errorf("action %q 가 거부되지 않았다 — toolId 를 전달할 수 없다", a)
		} else if !strings.Contains(err.Error(), "unknown action") {
			t.Errorf("action %q 의 오류 메시지가 예상과 다르다: %v", a, err)
		}
	}
}

// 스펙의 enum 과 핸들러 게이트가 같은 집합을 쓰는지 확인한다. 한쪽만 바뀌면
// 스키마가 광고하는 action 을 핸들러가 거부하거나 그 반대가 된다.
func TestWorkspaceCommand_EnumMatchesGate(t *testing.T) {
	props := WorkspaceCommandSpec["inputSchema"].(map[string]any)["properties"].(map[string]any)
	enum := props["action"].(map[string]any)["enum"].([]string)
	if len(enum) != len(workspaceCmdActions) {
		t.Fatalf("enum %d 개, 게이트 %d 개", len(enum), len(workspaceCmdActions))
	}
	for _, a := range enum {
		if !isWorkspaceCmdAction(a) {
			t.Errorf("enum 의 %q 를 게이트가 거부한다", a)
		}
	}
}

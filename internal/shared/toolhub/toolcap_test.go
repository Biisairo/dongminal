package toolhub

import (
	"errors"
	"testing"
)

// 04-secops P1-4 — 도구 생성에 상한이 없었다.
//
// 도구 하나는 PTY 와 로그인 셸 프로세스다. 진입점이 셋이고(`POST /api/tools`·
// `GET /ws`(tool 생략)·`POST /api/tools/headless`) 전부 이 함수를 지난다.
func TestToolManager_CapRejects(t *testing.T) {
	m := NewToolManager(t.TempDir(), nil)
	t.Cleanup(m.StopSaving)

	// 실제 PTY 를 상한만큼 띄우면 검사가 느리고 환경에 좌우된다. 상한 판정이
	// **기동 전에** 도는 것이 계약이므로, 맵을 채워 그 판정만 잰다.
	m.mu.Lock()
	for i := 0; i < ToolCap; i++ {
		m.tools[string(rune('a'+i%26))+string(rune('0'+i/26))] = &Tool{}
	}
	m.mu.Unlock()

	_, err := m.Create(t.TempDir(), 80, 24, Placement{})
	if !errors.Is(err, ErrToolCap) {
		t.Fatalf("상한을 넘겨 도구를 만들었다: err=%v", err)
	}
}

// 상한 안에서는 그대로 만들어진다 — 방어가 정상 경로를 막으면 안 된다.
func TestToolManager_UnderCapCreates(t *testing.T) {
	m := NewToolManager(t.TempDir(), nil)
	t.Cleanup(m.StopSaving)
	tool, err := m.Create(t.TempDir(), 80, 24, Placement{})
	if err != nil {
		t.Skipf("이 환경에서 도구를 만들 수 없다: %v", err)
	}
	t.Cleanup(func() { m.Delete(tool.ID) })
	if tool.ID == "" {
		t.Fatalf("도구가 만들어지지 않았다")
	}
}

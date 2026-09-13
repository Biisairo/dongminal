package toolhub

import (
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"dongminal/internal/shared/testpath"
)

// M8_UNIFIED_SRS 묶음 T — 에이전트 도구는 `Tool.Kind = agent` 인 변형이다 (D-U-4,
// FR-AGT-1·2·7·8, V-5·V-6). PTY 대신 파이프이고, 나머지 소비자 길은 같다.

// agentPlace 는 stdin 을 되읊는 가짜 에이전트 프로세스의 배치다 — 프로토콜은
// 여기서 상관없다. toolhub 는 바이트만 나른다.
func agentPlace(t *testing.T) Placement {
	t.Helper()
	if !testpath.POSIXShell() {
		t.Skip("sh 가 없다")
	}
	return Placement{Kind: KindAgent, Agent: "fake",
		Argv: []string{"/bin/sh", "-c", `echo '{"type":"hello"}'; while IFS= read -r l; do echo "echo:$l"; done`}}
}

// createAgent 는 가짜 에이전트 도구를 만들고 테스트 끝에 거둔다 — stdin 을 읽는
// 프로세스는 스스로 끝나지 않으므로, 남겨 두면 그 readPTY 고루틴이 다른 테스트의
// 시각 탐침(attnNow) 교체와 경합한다.
func createAgent(t *testing.T, m *ToolManager) *Tool {
	t.Helper()
	p, err := m.Create(t.TempDir(), 80, 24, agentPlace(t))
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	t.Cleanup(func() { _ = m.Delete(p.ID) })
	return p
}

// createShell 은 터미널 도구를 만들고 테스트 끝에 거둔다.
func createShell(t *testing.T, m *ToolManager) *Tool {
	t.Helper()
	p, err := m.Create(t.TempDir(), 80, 24, Placement{})
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	t.Cleanup(func() { _ = m.Delete(p.ID) })
	return p
}

// FR-AGT-1·8: 같은 Create 를 지나고, 종류와 라벨이 목록(ToolInfo)에 실린다.
func TestAgentKind_CreateAndList(t *testing.T) {
	m := newTestManager(t)
	p := createAgent(t, m)
	if p.Kind != KindAgent || p.Agent != "fake" || p.Name != "fake" {
		t.Fatalf("종류·라벨: kind=%q agent=%q name=%q", p.Kind, p.Agent, p.Name)
	}
	if p.CmdProcessPID() <= 0 {
		t.Fatal("프로세스가 있어야 한다 — 파이프가 PTY 를 대신할 뿐이다 (FR-AGT-3)")
	}
	waitOutput(t, p, `{"type":"hello"}`)
	var found bool
	for _, ti := range m.List() {
		if ti.ID == p.ID {
			found = true
			if ti.Kind != KindAgent || ti.Agent != "fake" {
				t.Fatalf("ToolInfo 에 종류가 실리지 않았다: %+v", ti)
			}
		}
	}
	if !found {
		t.Fatal("목록에 없다")
	}
	// 터미널 도구는 종류가 비어 있다 — 옛 데몬·옛 브라우저가 읽던 값과 같다.
	sh := createShell(t, m)
	if sh.Kind != "" || sh.Agent != "" {
		t.Fatalf("터미널 도구의 종류는 비어 있어야 한다: %q %q", sh.Kind, sh.Agent)
	}
}

// FR-AGT-2 (V-5): 리사이즈·붙여넣기는 오류가 아니라 무동작. Write 는 전송이다.
func TestAgentKind_NoopsAndWrite(t *testing.T) {
	m := newTestManager(t)
	p := createAgent(t, m)
	waitOutput(t, p, `{"type":"hello"}`)
	if err := m.Resize(p.ID, 200, 50); err != nil {
		t.Fatalf("Resize 는 무동작이어야 한다: %v", err)
	}
	if c, r, ok := p.Size(); ok && (c != 0 || r != 0) {
		t.Fatalf("크기가 있다: %d %d", c, r)
	}
	if err := m.SendPaste(p.ID, []byte("PASTED"), true); err != nil {
		t.Fatalf("SendPaste 는 무동작이어야 한다: %v", err)
	}
	if err := m.Write(p.ID, []byte(`{"type":"ping"}`+"\n")); err != nil {
		t.Fatalf("Write: %v", err)
	}
	waitOutput(t, p, `echo:{"type":"ping"}`)
	blob, _ := p.Stream().Snapshot()
	if strings.Contains(string(blob), "PASTED") {
		t.Fatal("붙여넣기가 파이프에 들어갔다 — 프레임이 아닌 바이트는 에이전트를 깨뜨린다")
	}
}

// D-C-5: 에이전트 도구는 tools.json 에 기재하지 않는다 — Restore 가 되살릴 수 없다.
func TestAgentKind_NotPersisted(t *testing.T) {
	m := newTestManager(t)
	ag := createAgent(t, m)
	sh := createShell(t, m)
	m.SaveAll()
	data, err := os.ReadFile(filepath.Join(m.DataDir(), "tools.json"))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(data), ag.ID) {
		t.Fatalf("에이전트 도구가 기재됐다: %s", data)
	}
	if !strings.Contains(string(data), sh.ID) {
		t.Fatalf("터미널 도구는 기재돼야 한다: %s", data)
	}
}

// FR-AAL-5: 에이전트 도구는 L2 idle 의 대상이 아니다. 활동을 보고했고 프로세스가
// 있어도 정적은 알람이 아니다 — 프로토콜이 턴의 끝을 말한다.
func TestAgentKind_NeverIdle(t *testing.T) {
	m := newTestManager(t)
	var fired []string
	var mu sync.Mutex
	m.SetAttentionNotifier(func(id, reason string) { mu.Lock(); fired = append(fired, reason); mu.Unlock() }, func(string) {})
	p := createAgent(t, m)
	waitOutput(t, p, `{"type":"hello"}`)
	restore := SetAttnBusyProbe(func(*Tool) bool { return true })
	defer restore()
	p.NoteUserPrompt()
	p.SetActivity("working", "", "")
	p.activity.Store(nil) // 굳은 working 이 억제하지 못하게 — 판정 대상은 종류다
	now := p.LastOutputAt.Load()
	p.maybeIdle(now+int64(time.Hour), int64(time.Second))
	mu.Lock()
	defer mu.Unlock()
	if len(fired) != 0 {
		t.Fatalf("에이전트 도구에 idle 알람이 섰다: %v", fired)
	}
	if p.Attention() {
		t.Fatal("attention 이 섰다")
	}
}

// D-C-2: 직접 모드의 해석층은 기동 전에 배선된 출력 관측자로 바이트를 받는다 —
// 절대 오프셋(end)과 함께.
func TestAgentKind_OutputObserver(t *testing.T) {
	m := newTestManager(t)
	type chunk struct {
		id   string
		kind ToolKind
		data string
		end  int64
	}
	var got []chunk
	var mu sync.Mutex
	m.SetOutputObserver(func(id string, kind ToolKind, data []byte, end int64) {
		mu.Lock()
		got = append(got, chunk{id, kind, string(data), end})
		mu.Unlock()
	})
	p := createAgent(t, m)
	waitOutput(t, p, `{"type":"hello"}`)
	waitFor(t, "관측자 호출", func() bool {
		mu.Lock()
		defer mu.Unlock()
		return len(got) > 0
	})
	mu.Lock()
	defer mu.Unlock()
	var all string
	var end int64
	for _, c := range got {
		if c.id != p.ID {
			t.Fatalf("다른 도구의 바이트: %+v", c)
		}
		// D-C-10: 종류가 청크와 함께 온다.
		if c.kind != KindAgent {
			t.Fatalf("청크의 kind: %+v", c)
		}
		all += c.data
		end = c.end
	}
	if !strings.Contains(all, `{"type":"hello"}`) {
		t.Fatalf("관측자가 본 바이트: %q", all)
	}
	if end != int64(len(all)) {
		t.Fatalf("end 는 누적 오프셋이어야 한다: end=%d len=%d", end, len(all))
	}
}

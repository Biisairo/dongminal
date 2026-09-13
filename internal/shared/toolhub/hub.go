package toolhub

import "time"

// ToolInfo 는 목록의 한 줄이다 (M8 `GO-13`). **와이어와 소비자가 같은 타입**을
// 쓴다 — 데몬의 `list` RPC 가 이 구조체를 그대로 JSON 으로 싣고, 서버는 그것을
// 이 구조체로 읽는다. 종전에는 `[]map[string]interface{}` 라 필드 하나가 문자열
// 키로 흩어졌고(`fgName`·`sizeCols`), 형 단언 실패는 런타임 패닉이었다. 이제
// 필드를 더하면 컴파일러가 빠뜨린 자리를 잡는다.
type ToolInfo struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	PID  int    `json:"pid"`
	Cols int    `json:"sizeCols"`
	Rows int    `json:"sizeRows"`
	// FgName 은 전경 프로세스 이름이다 (FR-TAN-7). 데몬 모드에서는 PTY 를 가진
	// 데몬이 조회해 목록에 실어 보낸다.
	FgName string `json:"fgName"`
}

// OutChunk 는 도구 출력 한 조각이다 — 프로세스 경계를 건너는 push 의 단위.
//
// 앞부분을 잘라내려면 그 조각이 스트림의 어디인지 알아야 한다
// (TERMINAL_RESUME_SRS FR-TRS-15·16). End 는 이 조각의 **끝** 절대 오프셋이며,
// 조각이 덮는 구간은 `[End-len(Data), End)` 다. 0 은 "모른다" 이고, 그때는
// 잘라내지 않는다.
type OutChunk struct {
	Data []byte
	End  int64
}

// DaemonHub 는 바이트 길이 **프로세스 경계를 건너는** 허브가 더 갖는 표면이다
// (M8 `GO-46`). 직접 모드에는 없다 — 그쪽은 Tool 이 같은 프로세스에 있어
// `Tool.AddClient` 로 붙는다. 종류(터미널·에이전트)를 묻는 메서드는 없다: 무엇이
// 흐르든 바이트이고, 해석은 소비자의 몫이다 (M8_UNIFIED_SRS §9.3 ④·⑤).
type DaemonHub interface {
	// Subscribe 는 도구의 출력 조각을 ch 로 받는다. 돌려주는 exitCh 는 도구가
	// 끝나면 닫힌다. unsubscribe 로 끊는다.
	Subscribe(toolID string, ch chan OutChunk) (exitCh <-chan struct{}, unsubscribe func())
	// SnapshotToolSince 는 재개 지점을 실어 스냅샷을 받는다 (FR-TRS-4·10).
	SnapshotToolSince(id string, since int64) (ToolSnapshot, error)
	// DaemonInfo 는 마지막 hello 가 말한 데몬의 판이다 (VERSION_HEALTH_SRS
	// FR-VHL-2). Reconnects 는 연결을 되살린 횟수다 (OBSERVABILITY_SRS FR-OBS-12).
	// 둘 다 진단 표면(health·diag)이 읽는다.
	DaemonInfo() DaemonInfo
	Reconnects() int64
}

// DaemonInfo 는 데몬이 hello 에서 말한 자기 판이다. 여기서 판정하지 않는다 —
// 이 겹이 아는 것은 "데몬이 뭐라고 했는가" 이고, 우리 판과 견주는 일은 헬스
// 종단의 몫이다 (FR-VHL-11).
type DaemonInfo struct {
	// Protocol 은 데몬이 말한 문법 판이다. 말하지 않았으면 현재 판으로 읽는다
	// (FR-VHL-5) — 옛 데몬을 거부하면 갱신 중인 인스턴스가 통째로 멈춘다.
	Protocol int
	// Build 는 데몬 바이너리의 판이다. **말하지 않았으면 빈 값**이며, 빈 것은
	// 불일치가 아니다 (FR-CBG-5 — 모른다 ≠ 다르다).
	Build string
}

// ToolHub is the minimum surface that HTTP/WS handlers need from the tool
// registry. *ToolManager satisfies it naturally.
type ToolHub interface {
	List() []ToolInfo
	// ListOK 는 목록과 함께 **그 목록이 관측된 사실인지**를 답한다
	// (TOOL_LIST_UNKNOWN_SRS FR-TLU-2). 직접 모드는 언제나 안다 — 모를 수 있는
	// 것은 목록이 다른 프로세스에 있는 데몬 모드뿐이다 (FR-TLU-3).
	ListOK() ([]ToolInfo, bool)
	// Connected 는 레지스트리에 **지금** 닿는지다. 직접 모드는 언제나 참이고,
	// 데몬 모드는 재접속 창에서 거짓이다 — 그때 없는 도구는 "사라진 것" 이 아니라
	// "모르는 것" 이다.
	Connected() bool
	// Daemon 은 프로세스 경계를 건너는 허브의 추가 표면이다. 직접 모드는 nil —
	// 이것이 모드 판별의 유일한 자리이며 타입 단언을 대신한다 (M8 `GO-46`).
	Daemon() DaemonHub
	// Create 는 도구를 띄운다. windowUUID 가 비어 있지 않고 그 Window 가
	// 샌드박스 창이면 도구는 대응 컨테이너 안에서 돈다 (FR-SBX-10).
	Create(cwd string, cols, rows uint16, place Placement) (*Tool, error)
	Get(id string) *Tool
	// Cwd resolves the live working directory of tool id (empty if unknown).
	// In daemon mode this routes through the daemon cwd RPC; Get(id).Cwd() is
	// not usable there because Get returns a cmd-less Tool (DAEMON_CWDPANE_RESOLVE_SRS).
	Cwd(id string) string
	// Busy reports whether tool id has a running foreground process.
	// In daemon mode this routes through the daemon busy RPC; Get(id).IsBusy()
	// is not usable there because Get returns a cmd-less Tool
	// (DAEMON_PANE_BUSY_RESOLVE_SRS).
	Busy(id string) bool
	// Delete 는 도구를 지운다. 없으면 `ErrToolNotFound` 다 (`GO-8`) — IPC 경계가
	// 실패를 성공으로 답하지 않기 위해서다. 이미 없는 것을 지우는 일이 정상인
	// 호출자는 그 오류를 명시로 무시한다.
	Delete(id string) error
	// Terminate 는 정중히 종료를 청하고(SIGTERM) grace 안에 끝나기를 기다린 뒤
	// 지운다 — 끝나지 않았으면 Delete 가 강제 종료한다 (FR-BGK-7). 없으면
	// `ErrToolNotFound` 다. **두 모드가 같은 유예를 갖는다** (M8 FBE-05/12):
	// 종전에는 유예가 httpapi 에 있어 데몬 모드에서는 pid 없는 합성 Tool 앞에서
	// 건너뛰어졌고, 데몬의 Delete 는 50ms 만 기다렸다.
	Terminate(id string, grace time.Duration) error
	Write(id string, data []byte) error
	// SendPaste 는 텍스트를 넣고 submit 이면 제출까지 한다. **감싸기 판단이
	// 구현 쪽에 있다** — 셸이 bracketed paste 모드를 켰는지는 PTY 출력을 읽는
	// 쪽만 알고, daemon 모드의 Get(id) 은 cmd 없는 Tool 을 주기 때문이다
	// (BRACKETED_PASTE_SRS FR-BPW-4/5). Cwd·Busy 와 같은 이유의 우회다.
	SendPaste(id string, text []byte, submit bool) error
	Resize(id string, cols, rows uint16) error
	SnapshotTool(id string) (ToolSnapshot, error)
	IsLive(id string) bool
	// SetBackground detaches tool id from its tab (bg=true) or restores it
	// (bg=false). False when the tool does not exist (FR-BG-2/4/7).
	SetBackground(id string, bg bool) bool
	// BackgroundList returns the tools currently sent to the background,
	// oldest first (FR-BG-6).
	BackgroundList() []BackgroundEntry
}

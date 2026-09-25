package toolipc

import "dongminal/internal/shared/toolhub"

// 메서드·이벤트 이름과 그 인자·결과의 모양이다 (OPTIMIZE_REFACTOR_SRS FR-OPT-2-6).
// 데몬과 서버가 같은 한 벌을 본다 — 두 벌로 적으면 한쪽만 바뀐다.
//
// **필드는 JSON 키의 사전순으로 둔다.** 종전의 와이어는 map 을 부호화한 것이라 키가
// 사전순이었고, 구조체는 선언 순서대로 부호화된다. 순서를 지켜야 바이트가 같다
// (FR-OPT-0-3). protocol_test.go 의 골든이 그것을 고정한다.
//
// **[]byte 필드는 nil 이 아니게 채운다.** nil 은 `null` 로, 빈 슬라이스는 `""` 로
// 나간다. 종전 와이어는 언제나 base64 문자열이었다.

const (
	MethodHello          = "hello"
	MethodCreate         = "create"
	MethodRestore        = "restore"
	MethodKill           = "kill"
	MethodTerminate      = "terminate"
	MethodWrite          = "write"
	MethodPaste          = "paste"
	MethodResize         = "resize"
	MethodList           = "list"
	MethodSnapshot       = "snapshot"
	MethodCwd            = "cwd"
	MethodBusy           = "busy"
	MethodSetBackground  = "setbackground"
	MethodBackgroundList = "backgroundlist"

	// 응답 없는 알림이다 (FR-OPT-2-2). 인자는 write·resize 와 같고 id 를 싣지 않는다.
	// 데몬은 답하지 않으므로 없는 도구에 보낸 것도 알리지 않는다 — 오류를 돌려줘야
	// 하는 자리(GO-8, HTTP send-input)는 write·resize RPC 를 쓴다.
	MethodInput        = "input"
	MethodResizeNotify = "resizenotify"
)

const (
	EventOutput     = "output"
	EventForeground = "fg"
	EventExit       = "exit"
	EventSize       = "size"
)

// HelloParams 는 서버가 hello 에 싣는 것이다. Features 는 서버가 아는 기능 이름이다
// (D-OPT-1). 비어 있으면 키째 빠진다 — 옛 서버가 보내던 것과 같은 뜻이다.
type HelloParams struct {
	Features []string `json:"features,omitempty"`
}

// HelloResult 는 판 둘(FR-VHL-1)과 데몬이 아는 기능 이름이다 (D-OPT-1).
//
// 기능은 ProtocolVersion 을 올리지 않고 늘리는 자리다. 판을 올리면 서버가 연결을
// 거부하고(FR-VHL-3), 데몬은 서버 업그레이드를 넘어 살아 PTY 를 쥐고 있다. 새
// 메서드는 이름을 여기 싣고, 상대가 그 이름을 말했을 때만 쓴다.
type HelloResult struct {
	Build    string   `json:"build"`
	Features []string `json:"features,omitempty"`
	Version  int      `json:"version"`
}

// 기능 이름 (D-OPT-1). 데몬이 말한다.
const (
	// FeatureForegroundTick: 데몬이 전경 조회 티커를 스스로 돌리고 바뀐 이름을 fg
	// push 로 빠짐없이 민다 (FR-OPT-2-1). 서버는 전경을 위한 list 폴을 돌리지 않는다.
	FeatureForegroundTick = "fgtick"
	// FeatureSnapshotNotFound: 없는 도구의 snapshot 을 CodeNotFound 로 답한다
	// (FR-OPT-2-5). 서버는 WS 연결 때 존재 확인용 list 를 건너뛴다.
	FeatureSnapshotNotFound = "snapnotfound"
	// FeatureNotify: input·resizenotify 알림을 안다 (FR-OPT-2-2). 서버는 WS 의 키
	// 입력·리사이즈를 응답 없이 보낸다.
	FeatureNotify = "notify"
)

// DaemonFeatures 는 이 데몬이 hello 에서 말하는 기능이다. ServerFeatures 는 서버가
// 말하는 기능이다. 새 기능이 이름을 여기 더한다.
var (
	DaemonFeatures = []string{FeatureForegroundTick, FeatureSnapshotNotFound, FeatureNotify}
	ServerFeatures []string
)

// HasFeature 는 상대가 말한 기능 목록에 name 이 있는가다. 말하지 않은 옛 상대는
// 아무것도 갖지 않는다.
func HasFeature(features []string, name string) bool {
	for _, f := range features {
		if f == name {
			return true
		}
	}
	return false
}

type CreateParams struct {
	Cols     uint16   `json:"cols"`
	Command  string   `json:"command"`
	Cwd      string   `json:"cwd"`
	ExtraEnv []string `json:"extraEnv"`
	Profile  string   `json:"profile"`
	Rows     uint16   `json:"rows"`
	Window   string   `json:"window"`
	Work     string   `json:"work"`
}

type CreateResult struct {
	Cols uint16 `json:"cols"`
	ID   string `json:"id"`
	Name string `json:"name"`
	PID  int    `json:"pid"`
	Rows uint16 `json:"rows"`
}

type RestoreParams struct {
	Cols uint16 `json:"cols"`
	Cwd  string `json:"cwd"`
	ID   string `json:"id"`
	Name string `json:"name"`
	Rows uint16 `json:"rows"`
}

type RestoreResult struct {
	Cols uint16 `json:"cols"`
	ID   string `json:"id"`
	Rows uint16 `json:"rows"`
}

// IDParams 는 도구 id 하나만 싣는 요청이다 — kill·cwd·busy.
type IDParams struct {
	ID string `json:"id"`
}

type TerminateParams struct {
	GraceMs int64  `json:"graceMs"`
	ID      string `json:"id"`
}

type WriteParams struct {
	Data []byte `json:"data"`
	ID   string `json:"id"`
}

type PasteParams struct {
	Data   []byte `json:"data"`
	ID     string `json:"id"`
	Submit bool   `json:"submit"`
}

type ResizeParams struct {
	Cols uint16 `json:"cols"`
	ID   string `json:"id"`
	Rows uint16 `json:"rows"`
}

// SnapshotParams 의 Since 가 없는 옛 요청은 -1(전량 재생)로 읽는다 (FR-TRS-3) —
// 받는 쪽이 -1 로 채운 뒤 해석한다.
type SnapshotParams struct {
	ID    string `json:"id"`
	Since int64  `json:"since"`
}

// SnapshotResult 는 toolhub.ToolSnapshot 의 와이어 모양이다. 필드를 모르는 옛
// 상대는 제로값으로 읽고, 제로값은 "모른다" 다 (FR-M9-3 ①, FR-TMR-24).
type SnapshotResult struct {
	Cols           uint16            `json:"cols"`
	Data           []byte            `json:"data"`
	End            int64             `json:"end"`
	Modes          toolhub.TermModes `json:"modes"`
	Resumed        bool              `json:"resumed"`
	Retained       int               `json:"retained"`
	Rows           uint16            `json:"rows"`
	TotalBytesDrop int64             `json:"totalBytesDrop"`
	TotalBytesIn   int64             `json:"totalBytesIn"`
}

type CwdResult struct {
	Cwd string `json:"cwd"`
}

type BusyResult struct {
	Busy bool `json:"busy"`
}

type SetBackgroundParams struct {
	Background bool   `json:"background"`
	ID         string `json:"id"`
}

type SetBackgroundResult struct {
	OK bool `json:"ok"`
}

// ListResult 의 Tools 는 도구가 없으면 nil 이고 와이어에서 `null` 이다. 받는 쪽은
// 키가 없는 것(목록이 아니다)과 null(0개)을 가른다 (TOOL_LIST_UNKNOWN_SRS FR-TLU-2).
type ListResult struct {
	Tools []toolhub.ToolInfo `json:"tools"`
}

type BackgroundListResult struct {
	Background []toolhub.BackgroundEntry `json:"background"`
}

// ── push ────────────────────────────────────────────────────────────────

// OutputEvent 의 End 는 이 청크 끝의 절대 오프셋이다 (TERMINAL_RESUME_SRS FR-TRS-15).
type OutputEvent struct {
	Data  []byte `json:"data"`
	End   int64  `json:"end"`
	Event string `json:"event"`
	Tool  string `json:"tool"`
}

type ExitEvent struct {
	Code  int    `json:"code"`
	Event string `json:"event"`
	Tool  string `json:"tool"`
}

type ForegroundEvent struct {
	Event string `json:"event"`
	Name  string `json:"name"`
	Tool  string `json:"tool"`
}

type SizeEvent struct {
	Cols  uint16 `json:"cols"`
	Event string `json:"event"`
	Rows  uint16 `json:"rows"`
	Tool  string `json:"tool"`
}

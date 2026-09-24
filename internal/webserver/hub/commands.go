package hub

import (
	"dongminal/internal/shared/dmenv"
	"dongminal/internal/shared/dmlog"
	"sync"
	"time"

	"dongminal/internal/shared/uuid"
)

type CmdSub struct {
	ch   chan []byte
	done chan struct{}
	once sync.Once

	// REPO_FIX 02 §3A-2 — 진단 슬롯. `lsp_diagnostics` 는 큐가 아니라 여기(키 →
	// 최신 payload)에 덮어쓴다. dready 는 "비울 것이 있다" 신호(1칸)다.
	dmu    sync.Mutex
	diag   map[string][]byte
	dready chan struct{}
}

// Messages는 이 구독에 브로드캐스트된 payload 채널이다. Closed는 구독이 닫힐
// 때 신호가 오는 채널이다. 둘 다 수신 전용으로 내보내 SSE 핸들러(internal/webserver/httpapi)
// 가 select 만 할 수 있게 한다 — 채널 자체를 노출하면 핸들러가 닫거나 쓸 수 있다.
func (s *CmdSub) Messages() <-chan []byte { return s.ch }
func (s *CmdSub) Closed() <-chan struct{} { return s.done }

// DiagnosticsReady 는 진단 슬롯에 비울 것이 생겼다는 신호다. TakeDiagnostics 로 비운다.
func (s *CmdSub) DiagnosticsReady() <-chan struct{} { return s.dready }

// TakeDiagnostics 는 슬롯의 payload 를 모두 꺼내고 비운다 — 키마다 최신 하나다.
func (s *CmdSub) TakeDiagnostics() [][]byte {
	s.dmu.Lock()
	defer s.dmu.Unlock()
	out := make([][]byte, 0, len(s.diag))
	for _, p := range s.diag {
		out = append(out, p)
	}
	s.diag = nil
	return out
}

func (s *CmdSub) putDiag(key string, payload []byte) {
	s.dmu.Lock()
	if s.diag == nil {
		s.diag = map[string][]byte{}
	}
	s.diag[key] = payload
	s.dmu.Unlock()
	select {
	case s.dready <- struct{}{}:
	default: // 이미 신호가 있다 — SSE 루프가 비울 때 이것도 함께 나간다
	}
}

// TabRef pairs a newly created tab's uuid with its server-assigned toolId
// (REMOTE_COMMAND_RESULT_SRS — 호출자가 uuid→toolId 재조회 불필요).
type TabRef struct {
	UUID   string `json:"uuid"`
	ToolID string `json:"toolId"`
}

// CmdResult is the set of entities a creating command produced, echoed back by
// the browser and returned to the caller via long-poll correlation.
type CmdResult struct {
	NewWindows []string `json:"newWindows"`
	NewPanes   []string `json:"newPanes"`
	NewTabs    []TabRef `json:"newTabs"`
}

// CommandHub broadcasts workspace UI commands to SSE subscribers.
type CommandHub struct {
	mu   sync.Mutex
	subs map[*CmdSub]struct{}
	// diagLatest 는 키(uri) → 최신 진단 payload 다 (REPO_FIX 02 §3A-2). 새 구독이
	// 이것을 스냅샷으로 받는다 — 진단은 푸시 전용이라 재연결하면 다시 받을 길이 없다.
	diagLatest map[string][]byte

	// pending maps a creating command's reqId to the channel awaiting the
	// browser's echo (REMOTE_COMMAND_RESULT_SRS FR-RCR-2/3). Guarded by pmu.
	pmu     sync.Mutex
	pending map[string]chan CmdResult
}

func NewCommandHub() *CommandHub {
	return &CommandHub{
		subs:       map[*CmdSub]struct{}{},
		pending:    map[string]chan CmdResult{},
		diagLatest: map[string][]byte{},
	}
}

// creatingActions are the commands that produce new entities and thus support
// result correlation. Others broadcast immediately with no await.
var creatingActions = map[string]bool{
	"newWindow": true,
	"newTab":    true,
	"splitH":    true,
	"splitV":    true,
}

// IsCreatingAction reports whether action creates new entities (FR-RCR-1).
func IsCreatingAction(action string) bool { return creatingActions[action] }

// singleExecutorActions are the commands that add an entity to the workspace
// tree and therefore must run on exactly ONE client
// (WORKSPACE_IDENTITY_SRS FR-SXE-1). It is wider than creatingActions:
// openEditorTab and restoreTool allocate a tab id without taking part in the
// reqId echo protocol.
//
// M11_SRS FR-M11-10 이 이 목록을 넓혔다. 종전 문장은 *"Everything else stays
// ungated — focus is per-client by definition, and the remaining mutations are
// idempotent across clients"* 였고, **뒷부분이 틀렸다**: 트리는 수렴하지만 시선은
// 수렴하지 않는다. 지금 게이팅 밖에 남는 것은 `renameTab`·`renameWindow` 뿐이다.
var singleExecutorActions = map[string]bool{
	"newWindow":     true,
	"newTab":        true,
	"splitH":        true,
	"splitV":        true,
	"openEditorTab": true,
	"restoreTool":   true,
	// VIEWER_URL_OPEN_SRS FR-VUO-16: 엔티티를 만들지는 않지만 **한 곳에서만**
	// 열려야 한다. 게이팅하지 않으면 붙어 있는 기기마다 같은 URL 이 열린다.
	"openUrl": true,

	// M11_SRS FR-M11-10 (M11-B9): **시선을 옮기는 명령도 한 곳에서만 돈다.**
	//
	// 종전 근거는 위 문단의 *"the remaining mutations are idempotent across
	// clients"* 였다. **트리는 그렇지만 시선은 그렇지 않다** — 실측에서 한 기기가
	// 낸 `window-next` 하나가 두 브라우저를 함께 옮겼고, `close-window` 는 그 창을
	// 보지도 않던 쪽까지 끌고 갔다 (SRS §2.7). `openUrl` 과 같은 성질이다.
	//
	// 지우는 셋(`closeTab`·`closeWindow`·`detachTab`)이 여기 드는 이유는 **시선
	// 부작용** 때문이다. 나머지는 `workspace_changed` 로 트리만 따라가며, 그 경로는
	// 이미 로컬 `activeWindow` 를 보존한다 (`app-cmd.js`).
	//
	// `renameTab`·`renameWindow` 는 **들지 않는다** — 순수 데이터이고 시선을
	// 건드리지 않는다. 좁히면 지명된 클라이언트가 없을 때 이름이 영영 안 바뀐다.
	"focus":       true,
	"closeTab":    true,
	"closeWindow": true,
	"detachTab":   true,
	"windowNext":  true,
	"windowPrev":  true,
	"tabNext":     true,
	"tabPrev":     true,
	"paneUp":      true,
	"paneDown":    true,
	"paneLeft":    true,
	"paneRight":   true,
}

// IsSingleExecutorAction reports whether action must run on one client only.
func IsSingleExecutorAction(action string) bool { return singleExecutorActions[action] }

const defaultCommandResultTimeout = 3 * time.Second

// CommandResultTimeout is the long-poll wait, overridable via env (NFR-RCR-1).
func CommandResultTimeout() time.Duration {
	return dmenv.MillisEnv(dmenv.EnvCmdResultTimeoutMS, defaultCommandResultTimeout, 1)
}

// NewReqId returns a fresh 1회성 correlation key.
func NewReqId() string {
	// FR-UNI-14: canonical uuid. 이전에는 16바이트 hex(32자, 구분자·버전 비트 없음)
	// 였다. 엔트로피가 동등하므로 echo 상관 동작(FR-RCR-*)은 불변이다.
	return uuid.NewString()
}

// BroadcastAndAwait broadcasts payload (which must already embed reqId) and
// blocks until the browser echoes the result for reqId or timeout elapses. If
// no subscriber received the broadcast (delivered=0) it returns immediately
// without waiting (FR-RCR-2).
func (h *CommandHub) BroadcastAndAwait(payload []byte, reqId string, timeout time.Duration) (CmdResult, int, bool) {
	ch := make(chan CmdResult, 1)
	h.pmu.Lock()
	h.pending[reqId] = ch
	h.pmu.Unlock()

	n := h.Broadcast(payload)
	if n == 0 {
		h.clearPending(reqId)
		return CmdResult{}, 0, false
	}
	select {
	case res := <-ch:
		return res, n, false
	case <-time.After(timeout):
		h.clearPending(reqId)
		return CmdResult{}, n, true
	}
}

// DeliverResult routes a browser echo to the awaiting BroadcastAndAwait. The
// first echo wins (channel removed); unknown/expired reqId is a no-op
// (FR-RCR-3, NFR-RCR-3).
func (h *CommandHub) DeliverResult(reqId string, res CmdResult) {
	h.pmu.Lock()
	ch, ok := h.pending[reqId]
	if ok {
		delete(h.pending, reqId)
	}
	h.pmu.Unlock()
	if ok {
		ch <- res // buffered cap 1, non-blocking
	}
}

func (h *CommandHub) clearPending(reqId string) {
	h.pmu.Lock()
	delete(h.pending, reqId)
	h.pmu.Unlock()
}

// pendingCount is a test helper for leak detection.
func (h *CommandHub) pendingCount() int {
	h.pmu.Lock()
	defer h.pmu.Unlock()
	return len(h.pending)
}

// cmdSubQueue는 구독당 미수신 payload 버퍼 크기다. 넘치면 그 구독을 닫는다
// — 느린 브라우저 하나가 다른 구독을 막지 않고, 닫힌 쪽은 재연결해 다시 받는다.
const cmdSubQueue = 16

// NewCmdSub는 허브에 등록되지 않은 홀로 선 구독을 만든다. Close는 그 구독을
// 닫는다(중복 호출 안전). CommandHub.Add/Remove 가 내부에서 하는 일과 같으며,
// 허브를 대역하는 다른 패키지의 CommandBroker 구현이 쓴다.
func NewCmdSub() *CmdSub {
	return &CmdSub{ch: make(chan []byte, cmdSubQueue), done: make(chan struct{}), dready: make(chan struct{}, 1)}
}

func (s *CmdSub) Close() { s.once.Do(func() { close(s.done) }) }

// SubCap 은 동시에 붙는 SSE 구독 수의 상한이다 (04-secops P1-4).
//
// 구독 하나가 goroutine 하나이고 채널 버퍼를 든다. 상한이 없으면 연결을 여는
// 것만으로 서버 메모리를 정할 수 있다.
//
// 64 는 사람이 여는 창·탭 수보다 한참 크다 — 화면 하나가 칸마다 구독을 열어도
// (`app-slots.js`) 그 사이가 넓다.
const SubCap = 64

// Add 는 구독 하나를 등록한다. 상한을 넘으면 **nil** 이며, 호출자는 그것을 503
// 으로 옮긴다 — 구독을 못 여는 것은 클라이언트의 잘못이 아니다.
func (h *CommandHub) Add() *CmdSub {
	h.mu.Lock()
	defer h.mu.Unlock()
	if len(h.subs) >= SubCap {
		dmlog.Infof(nil, "[cmd] 구독 상한 초과로 거절한다 (cap=%d)", SubCap)
		return nil
	}
	s := NewCmdSub()
	for k, p := range h.diagLatest {
		s.putDiag(k, p)
	}
	h.subs[s] = struct{}{}
	return s
}

func (h *CommandHub) Remove(s *CmdSub) {
	if s == nil {
		return
	}
	s.Close()
	h.mu.Lock()
	delete(h.subs, s)
	h.mu.Unlock()
}

// Broadcast delivers payload to all subscribers; returns delivered count.
//
// REPO_FIX 02 §3A-2: 큐가 가득 찬 구독은 **닫는다** — 그 구독의 SSE 핸들러가 돌아가고
// 클라이언트가 재연결해 `revalidateOn:['sse:open']` 으로 다시 받는다.
//
//	이전 동작: 그 이벤트만 조용히 버렸다
//	새  동작: 구독을 닫는다(로그 1줄). 닫힌 큐에 남은 명령은 재전송하지 않는다
//	이유:     git_changed·워크스페이스 이벤트를 잃은 화면이 안전망까지 낡았다 (#21)
func (h *CommandHub) Broadcast(payload []byte) int {
	h.mu.Lock()
	defer h.mu.Unlock()
	n := 0
	for s := range h.subs {
		select {
		case s.ch <- payload:
			n++
		default:
			dmlog.Infof(nil, "[cmd] 구독 큐(%d)가 가득 차 구독을 닫는다 — 클라이언트가 재연결해 다시 받는다", cmdSubQueue)
			s.Close()
			delete(h.subs, s)
		}
	}
	return n
}

// BroadcastDiagnostics 는 진단 하나를 모든 구독의 슬롯에 덮어쓴다 (REPO_FIX 02
// §3A-2). 큐를 쓰지 않으므로 git 이벤트를 밀어내지 않고 넘침 판정 대상도 아니다.
// clear 면(빈 진단) 스냅샷에서 그 키를 지운다 — 빈 payload 는 그래도 전달한다
// (앞선 밑줄을 걷어야 한다).
func (h *CommandHub) BroadcastDiagnostics(key string, payload []byte, clear bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if clear {
		delete(h.diagLatest, key)
	} else {
		h.diagLatest[key] = payload
	}
	for s := range h.subs {
		s.putDiag(key, payload)
	}
}

var AllowedCmdActions = map[string]bool{
	"newWindow":     true,
	"newTab":        true,
	"splitH":        true,
	"splitV":        true,
	"focus":         true,
	"closeTab":      true,
	"closeWindow":   true,
	"windowNext":    true,
	"windowPrev":    true,
	"tabNext":       true,
	"tabPrev":       true,
	"paneUp":        true,
	"paneDown":      true,
	"paneLeft":      true,
	"paneRight":     true,
	"openEditorTab": true,
	"renameTab":     true,
	"renameWindow":  true,
	"detachTab":     true,
	"restoreTool":   true,
	"openUrl":       true,
}

// AllowedAction reports whether the action is accepted by the hub.
func (h *CommandHub) AllowedAction(a string) bool { return AllowedCmdActions[a] }

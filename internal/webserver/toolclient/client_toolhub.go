package toolclient

import (
	"errors"

	"dongminal/internal/shared/toolhub"

	"dongminal/internal/shared/toolipc"

	"encoding/base64"
	"encoding/json"
	"fmt"
	"time"
)

// M9_SRS FR-M9-15 (D-A-10 — 분리는 **이동만**이다): `client.go` 에서 옮겨 왔다.
//
// 여기 모인 것은 **`toolhub.ToolHub` 계약의 구현**이다 — 목록·생성·삭제·입출력·
// 스냅샷. `client.go` 에 남은 것은 그 계약을 떠받치는 **연결**이며, 계약이 늘어도
// 연결은 늘지 않는다.

type OutChunk = toolhub.OutChunk

func (pc *ToolClient) Subscribe(toolID string, ch chan OutChunk) (exitCh <-chan struct{}, unsubscribe func()) {
	ex := make(chan struct{})
	pc.subMu.Lock()
	if pc.subbers[toolID] == nil {
		pc.subbers[toolID] = map[chan OutChunk]chan struct{}{}
	}
	pc.subbers[toolID][ch] = ex
	pc.subMu.Unlock()
	return ex, func() {
		pc.subMu.Lock()
		delete(pc.subbers[toolID], ch)
		pc.subMu.Unlock()
	}
}

// Daemon 은 자기 자신이다 — 이 클라이언트가 곧 프로세스 경계를 건너는 표면이다.
func (pc *ToolClient) Daemon() toolhub.DaemonHub { return pc }

// Connected reports whether a live daemon connection is currently established.
// During a reconnect window it returns false, so callers can distinguish a
// genuinely missing tool from a transient outage and avoid telling the browser
// the tool is gone.
func (pc *ToolClient) Connected() bool {
	pc.mu.Lock()
	cd, conn := pc.connDone, pc.conn
	pc.mu.Unlock()
	if conn == nil || cd == nil {
		return false
	}
	select {
	case <-cd:
		return false // connection dead, supervisor reconnecting
	default:
		return true
	}
}

// ── toolhub.ToolHub implementation ──────────────────────────────────────────────

func (pc *ToolClient) List() []toolhub.ToolInfo {
	out, _ := pc.ListOK()
	return out
}

// ListOK 는 목록과 함께 **그 목록이 관측된 사실인지**를 답한다
// (TOOL_LIST_UNKNOWN_SRS FR-TLU-2).
//
// `List` 의 nil 로는 "도구가 0개"와 "데몬에게 묻지 못했다"가 갈리지 않는다 —
// 데몬의 ToolManager 는 도구가 없으면 nil 슬라이스를 주고 그것이 JSON 에서
// `"tools": null` 로 나오기 때문이다 (SRS §2.3). 그 둘을 같게 다루면 재접속의
// 짧은 창에 클라이언트가 **살아 있는 도구 전부를 죽은 것으로 판정**한다.
//
// 그래서 판정을 RPC 를 실제로 하는 이 자리 하나에 둔다. 응답이 왔으면 목록이
// 비어 있어도 아는 것이고, 오지 않았으면 모르는 것이다.
func (pc *ToolClient) ListOK() ([]toolhub.ToolInfo, bool) {
	// 짧은 TTL 캐시 (M8 `GO-6`). Get·IsLive·Has 가 전부 이 목록을 딛는데, 요청
	// 하나가 멤버·도구마다 그것을 물어 `GET /api/runs` 한 번이 list RPC 를
	// 수십 번 직렬로 왕복했다. 재접속 창에서는 그 하나하나가 5초 시한에
	// 매달렸다. 캐시는 push(`exit`·`fg`)와 이 클라이언트를 지나는 변경(create·
	// kill·terminate·restore·setbackground)이 **보내기 전과 돌아온 뒤 두 번**
	// 무효화한다 — 데몬은 한 연결의 요청을 직렬로 처리하므로, 변경이 진행되는
	// 동안의 조회는 캐시가 아니라 RPC 로 가야 변경 뒤에 답을 받는다. 종전(캐시
	// 없음)의 관측 순서가 그것이었고, e2e skill-contract 가 그 순서를 단정한다.
	if tools, ok := pc.cachedList(); ok {
		return tools, true
	}
	// RPC 를 시작한 **세대**를 적어 둔다. 응답이 오기 전에 무효화가 끼면(예: 이
	// list 가 데몬에서 답해진 뒤 kill 이 지나갔다) 그 응답은 이미 낡은 것이라
	// 저장하지 않는다 — 저장하면 무효화를 덮어써 지운 도구가 TTL 동안 되살아난다
	// (e2e skill-contract 에서 실측).
	gen := pc.listGeneration()
	resp, err := pc.call("list", struct{}{})
	if err != nil {
		return nil, false
	}
	raw, ok := resp["tools"]
	if !ok {
		// 목록이 있어야 할 자리가 응답에 없다. 데몬의 `list` 는 언제나 그 키를
		// 넣으므로(`ipc/paned.go`), 없다는 것은 이 응답이 목록이 아니라는 뜻이다.
		return nil, false
	}
	if raw == nil {
		// 키는 있고 값이 null 이다 — 도구가 0개인 것이며, 아는 것이다.
		pc.storeList(nil, gen)
		return nil, true
	}
	// 와이어는 toolhub.ToolInfo 의 JSON 그대로다 (`GO-13`) — 한 번 다시 부호화해
	// 그 타입으로 읽는다. 형 단언으로 키를 하나씩 뜯던 자리다.
	blob, err := json.Marshal(raw)
	if err != nil {
		return nil, false
	}
	var out []toolhub.ToolInfo
	if err := json.Unmarshal(blob, &out); err != nil {
		return nil, false
	}
	pc.storeList(out, gen)
	return out, true
}

// listCacheTTL 은 목록 캐시의 수명이다. 낡은 값이 살 수 있는 최대 창이며, 그
// 안의 변경은 push 와 변경 호출이 무효화로 덮는다.
const listCacheTTL = 200 * time.Millisecond

func (pc *ToolClient) cachedList() ([]toolhub.ToolInfo, bool) {
	pc.listMu.Lock()
	defer pc.listMu.Unlock()
	if pc.listAt.IsZero() || time.Since(pc.listAt) > listCacheTTL {
		return nil, false
	}
	return pc.listCache, true
}

func (pc *ToolClient) listGeneration() uint64 {
	pc.listMu.Lock()
	defer pc.listMu.Unlock()
	return pc.listGen
}

// storeList 는 gen 이 지금 세대일 때만 저장한다 — 그 사이 무효화가 있었으면 이
// 응답은 낡은 것이다.
func (pc *ToolClient) storeList(tools []toolhub.ToolInfo, gen uint64) {
	pc.listMu.Lock()
	if pc.listGen == gen {
		pc.listCache, pc.listAt = tools, time.Now()
	}
	pc.listMu.Unlock()
}

// invalidateList 는 캐시를 버리고 세대를 올린다 — 목록을 바꿨거나 바뀌었다는
// push 를 받은 자리. 진행 중인 list 응답은 이 세대 앞의 것이라 저장되지 않는다.
func (pc *ToolClient) invalidateList() {
	pc.listMu.Lock()
	pc.listAt = time.Time{}
	pc.listGen++
	pc.listMu.Unlock()
}

// 데몬 모드에서는 PTY 를 데몬이 소유하므로 샌드박스 배치도 그쪽에서 일어난다.
// 여기서는 어느 Window 의 도구인지만 실어 보낸다 (FR-SBX-11).
func (pc *ToolClient) Create(cwd string, cols, rows uint16, place toolhub.Placement) (*toolhub.Tool, error) {
	pc.invalidateList()
	resp, err := pc.call("create", map[string]interface{}{
		"cwd": cwd, "cols": cols, "rows": rows,
		"window": place.WindowUUID, "profile": place.Profile,
		// UX_BATCH6_SRS FR-BGP-3: 셸 대신 띄울 명령. 데몬 모드에서도 프로세스를
		// 세우는 것은 데몬이므로 값만 실어 보낸다 — 프로파일과 같은 방향이다.
		"command": place.Command,
		// UX_BATCH6_SRS FR-SBM-3: 작업 방식도 데몬이 배치할 때 쓴다.
		"work": place.Work,
	})
	if err != nil {
		// M8 D-A-16: 상한 초과는 코드로 건너온다 — 핸들러의 `errors.Is` 가 두 모드에서 같다.
		var rpc *toolipc.RPCError
		if errors.As(err, &rpc) && rpc.Code == toolipc.CodeToolCap {
			return nil, fmt.Errorf("%w: %s", toolhub.ErrToolCap, rpc.Message)
		}
		return nil, err
	}
	pc.invalidateList()
	id, _ := resp["id"].(string)
	name, _ := resp["name"].(string)
	return &toolhub.Tool{ID: id, Name: name}, nil
}

// Get 은 **신원만 든 합성 Tool** 이다 (`GO-47`, ToolHub.Get 의 계약) — ID·Name 은
// 목록에서 오고, 전송·프로세스가 필요한 메서드는 무동작·영값이다.
func (pc *ToolClient) Get(id string) *toolhub.Tool {
	// ToolClient doesn't have local state; we check liveness via List
	for _, t := range pc.List() {
		if t.ID == id {
			return &toolhub.Tool{ID: id, Name: t.Name}
		}
	}
	return nil
}

// Delete 는 데몬에게 그 도구를 지우라 한다. **RPC 의 실패를 그대로 돌려준다**
// (`GO-8`) — 종전에는 반환이 없어 데몬이 무엇을 답하든 성공으로 읽혔다.
func (pc *ToolClient) Delete(id string) error {
	pc.invalidateList()
	_, err := pc.call("kill", map[string]interface{}{"id": id})
	pc.invalidateList()
	return err
}

// Terminate 는 데몬에게 유예를 실어 보낸다 (FBE-05/12). 데몬은 그 유예를 자기
// 쪽에서 기다린 뒤 지우므로, 이 호출의 시한은 기본 시한에 유예를 더한 값이다.
func (pc *ToolClient) Terminate(id string, grace time.Duration) error {
	pc.invalidateList()
	_, err := pc.callWithin("terminate", map[string]interface{}{
		"id": id, "graceMs": grace.Milliseconds(),
	}, panedCallTimeout+grace)
	pc.invalidateList()
	return err
}

func (pc *ToolClient) Restore(id, name, cwd string, cols, rows uint16) error {
	pc.invalidateList()
	_, err := pc.call("restore", map[string]interface{}{
		"id": id, "name": name, "cwd": cwd, "cols": cols, "rows": rows,
	})
	pc.invalidateList()
	return err
}

func (pc *ToolClient) IsLive(id string) bool {
	return pc.Get(id) != nil
}

func (pc *ToolClient) SaveAll()                    {}
func (pc *ToolClient) LoadAll(map[string]struct{}) {}

func (pc *ToolClient) Write(id string, data []byte) error {
	_, err := pc.call("write", map[string]interface{}{
		"id":   id,
		"data": base64.StdEncoding.EncodeToString(data),
	})
	return err
}

// SendPaste 는 감싸기와 제출을 데몬에 맡긴다 — 판단이 클라이언트로 새면 안 된다
// (BRACKETED_PASTE_SRS FR-BPW-4).
func (pc *ToolClient) SendPaste(id string, text []byte, submit bool) error {
	_, err := pc.call("paste", map[string]interface{}{
		"id":     id,
		"data":   base64.StdEncoding.EncodeToString(text),
		"submit": submit,
	})
	return err
}

func (pc *ToolClient) Resize(id string, cols, rows uint16) error {
	_, err := pc.call("resize", map[string]interface{}{
		"id": id, "cols": cols, "rows": rows,
	})
	return err
}

func (pc *ToolClient) Cwd(id string) string {
	resp, err := pc.call("cwd", map[string]interface{}{"id": id})
	if err != nil {
		return ""
	}
	cwd, _ := resp["cwd"].(string)
	return cwd
}

func (pc *ToolClient) Busy(id string) bool {
	resp, err := pc.call("busy", map[string]interface{}{"id": id})
	if err != nil {
		return false
	}
	busy, _ := resp["busy"].(bool)
	return busy
}

func (pc *ToolClient) SetBackground(id string, bg bool) bool {
	pc.invalidateList()
	resp, err := pc.call("setbackground", map[string]interface{}{"id": id, "background": bg})
	pc.invalidateList()
	if err != nil {
		return false
	}
	ok, _ := resp["ok"].(bool)
	return ok
}

func (pc *ToolClient) BackgroundList() []toolhub.BackgroundEntry {
	resp, err := pc.call("backgroundlist", map[string]interface{}{})
	if err != nil {
		return nil
	}
	raw, ok := resp["background"]
	if !ok {
		return nil
	}
	blob, err := json.Marshal(raw)
	if err != nil {
		return nil
	}
	var out []toolhub.BackgroundEntry
	if json.Unmarshal(blob, &out) != nil {
		return nil
	}
	return out
}

func (pc *ToolClient) SnapshotTool(id string) (toolhub.ToolSnapshot, error) {
	return pc.SnapshotToolSince(id, -1)
}

// SnapshotToolSince 는 재개 지점을 실어 스냅샷을 부른다 (TERMINAL_RESUME_SRS
// FR-TRS-3). since<0 은 전량 재생이다.
//
// `resumed` 를 보내지 않는 옛 데몬에서는 false 로 읽히므로 전량 재생으로
// 취급된다 — 강등이지 오류가 아니다.
func (pc *ToolClient) SnapshotToolSince(id string, since int64) (toolhub.ToolSnapshot, error) {
	resp, err := pc.call("snapshot", map[string]interface{}{"id": id, "since": since})
	if err != nil {
		return toolhub.ToolSnapshot{}, err
	}
	dataStr, _ := resp["data"].(string)
	data, _ := base64.StdEncoding.DecodeString(dataStr)
	totalIn, _ := resp["totalBytesIn"].(float64)
	totalDrop, _ := resp["totalBytesDrop"].(float64)
	retained, _ := resp["retained"].(float64)
	end, _ := resp["end"].(float64)
	resumed, _ := resp["resumed"].(bool)
	// FR-M9-3 ①: 크기. 옛 데몬은 이 필드를 보내지 않으므로 0 이 되고, 0 은
	// "모른다" 라 통보하지 않는다 — 그때의 동작은 이 요구가 없던 때와 같다.
	cols, _ := resp["cols"].(float64)
	rows, _ := resp["rows"].(float64)
	// FR-TMR-24·25: 앱이 켜 둔 모드. **필드를 보내지 않는 옛 데몬에서는 제로값**이
	// 되고, 제로값은 "전부 꺼짐" 이라 복원이 없을 뿐이다 — 이 요구가 없던 때의
	// 동작과 같다.
	modes := decodeModes(resp["modes"])
	return toolhub.ToolSnapshot{
		Data:           data,
		TotalBytesIn:   int64(totalIn),
		TotalBytesDrop: int64(totalDrop),
		Retained:       int(retained),
		End:            int64(end),
		Resumed:        resumed,
		Cols:           uint16(cols),
		Rows:           uint16(rows),
		Modes:          modes,
	}, nil
}

// decodeModes 는 RPC 가 실어 온 모드다. JSON 을 지난 수는 float64 이므로 한 자리에
// 모아 옮긴다 — 흩어 두면 새 모드가 늘 때마다 같은 실수를 되풀이한다.
func decodeModes(v interface{}) toolhub.TermModes {
	m, ok := v.(map[string]interface{})
	if !ok {
		return toolhub.TermModes{}
	}
	num := func(k string) int {
		f, _ := m[k].(float64)
		return int(f)
	}
	b := func(k string) bool {
		x, _ := m[k].(bool)
		return x
	}
	return toolhub.TermModes{
		BracketedPaste: b("bracketedPaste"),
		MouseProtocol:  num("mouseProtocol"),
		MouseEncoding:  num("mouseEncoding"),
		FocusEvent:     b("focusEvent"),
	}
}

// Ensure ToolClient implements toolhub.ToolHub.
var _ toolhub.ToolHub = (*ToolClient)(nil)

// Reconnects 는 이 손잡이가 연결을 **되살린 횟수**다
// (OBSERVABILITY_SRS FR-OBS-12).
//
// 진단이 읽는 집계 수치다. 0 이 아니면 데몬이 죽었다 살아났다는 뜻이고, 그
// 사실은 "도구가 가끔 멎는다" 류의 신고에서 가장 먼저 필요한 값이다.
func (pc *ToolClient) Reconnects() int64 { return pc.reconnects.Load() }

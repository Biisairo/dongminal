package ipc

import (
	"errors"

	"dongminal/internal/shared/toolhub"

	"dongminal/internal/shared/toolipc"

	"encoding/base64"
	"encoding/json"
	"time"
)

// M9_SRS FR-M9-15 (D-A-10 — 분리는 **이동만**이다): `paned.go` 에서 옮겨 왔다.
//
// 여기 모인 것은 **요청 하나를 처리하는 일**과 **밀어 보내는 일**이다. `paned.go` 에
// 남은 것은 연결의 수명(쓰기 루프·큐·dispatch)과 소켓 서버이며, 메서드가 하나 더
// 늘어도 그 수명은 바뀌지 않는다.

// ── Request handlers ────────────────────────────────────────────────────

// decodeParams 는 요청 파라미터를 T 로 읽는다 (M8 D-A-16, GO-22). 실패는
// CodeInvalidParams 하나다 — 핸들러 열둘이 같은 두 줄을 베끼지 않는다.
func decodeParams[T any](req *toolipc.PanedRequest) (T, *toolipc.PanedError) {
	var p T
	return p, decodeParamsInto(req, &p)
}

// decodeParamsInto 는 기본값을 미리 채운 p 에 읽는다. base64 가 깨진 data 는 종전
// 문구("invalid base64")를 그대로 싣는다 — 문자열로 받아 따로 풀던 때의 것이다.
func decodeParamsInto(req *toolipc.PanedRequest, p any) *toolipc.PanedError {
	err := json.Unmarshal(req.Params, p)
	if err == nil {
		return nil
	}
	msg := err.Error()
	var bad base64.CorruptInputError
	if errors.As(err, &bad) {
		msg = "invalid base64"
	}
	return &toolipc.PanedError{ID: req.ID, Error: toolipc.PanedErrObj{Code: toolipc.CodeInvalidParams, Message: msg}}
}

// createError 는 생성 실패를 코드로 옮긴다. 상한 초과는 CodeToolCap — 서버가 그것을
// `toolhub.ErrToolCap` 으로 되돌려 두 모드가 같은 429 를 낸다 (D-A-16).
func createError(req *toolipc.PanedRequest, err error) toolipc.PanedError {
	code := toolipc.CodeInternal
	if errors.Is(err, toolhub.ErrToolCap) {
		code = toolipc.CodeToolCap
	}
	return toolipc.PanedError{ID: req.ID, Error: toolipc.PanedErrObj{Code: code, Message: err.Error()}}
}

func errResp(req *toolipc.PanedRequest, code int, err error) toolipc.PanedError {
	return toolipc.PanedError{ID: req.ID, Error: toolipc.PanedErrObj{Code: code, Message: err.Error()}}
}

func okResp(req *toolipc.PanedRequest, result any) toolipc.PanedResponse {
	return toolipc.PanedResponse{ID: req.ID, Result: result}
}

func (pc *panedConn) hello(req *toolipc.PanedRequest) interface{} {
	// 서버가 말한 기능을 적어 둔다 (D-OPT-1). 읽지 못하면 옛 서버와 같게 — 아무것도
	// 없는 것으로 — 둔다. hello 를 실패시키면 판이 맞는 서버도 붙지 못한다.
	if p, perr := decodeParams[toolipc.HelloParams](req); perr == nil {
		pc.serverFeatures = p.Features
	}
	// FR-VHL-1: 판을 **둘로 나눠** 싣는다.
	//
	//   version — 프로토콜(문법) 판. 호환의 판정자이며 거의 바뀌지 않는다
	//   build   — 이 바이너리의 판. 릴리스마다 바뀐다
	//
	// 합치면 모든 릴리스가 프로토콜 불일치로 읽힌다 (D-1). 서버는 둘을 다르게
	// 다룬다 — 프로토콜이 다르면 연결을 거부하고(FR-VHL-3), 빌드가 다르면
	// 연결은 두고 헬스에 싣는다(FR-VHL-4).
	return okResp(req, toolipc.HelloResult{
		Version:  toolipc.ProtocolVersion,
		Build:    pc.build,
		Features: toolipc.DaemonFeatures,
	})
}

func (pc *panedConn) create(req *toolipc.PanedRequest) interface{} {
	p, perr := decodeParams[toolipc.CreateParams](req)
	if perr != nil {
		return *perr
	}
	tool, err := pc.pm.Create(p.Cwd, p.Cols, p.Rows,
		toolhub.Placement{WindowUUID: p.Window, Profile: p.Profile, Command: p.Command, Work: p.Work,
			ExtraEnv: p.ExtraEnv})
	if err != nil {
		return createError(req, err)
	}
	if pc.wireTool != nil {
		pc.wireTool(tool)
	}
	return okResp(req, toolipc.CreateResult{
		ID: tool.ID, Name: tool.Name, PID: tool.CmdProcessPID(), Cols: p.Cols, Rows: p.Rows,
	})
}

func (pc *panedConn) restore(req *toolipc.PanedRequest) interface{} {
	p, perr := decodeParams[toolipc.RestoreParams](req)
	if perr != nil {
		return *perr
	}
	if err := pc.pm.Restore(p.ID, p.Name, p.Cwd, p.Cols, p.Rows); err != nil {
		return errResp(req, toolipc.CodeInternal, err)
	}
	if pc.wireTool != nil {
		if restored := pc.pm.Get(p.ID); restored != nil {
			pc.wireTool(restored)
		}
	}
	return okResp(req, toolipc.RestoreResult{ID: p.ID, Cols: p.Cols, Rows: p.Rows})
}

func (pc *panedConn) kill(req *toolipc.PanedRequest) interface{} {
	p, perr := decodeParams[toolipc.IDParams](req)
	if perr != nil {
		return *perr
	}
	// `GO-8`: 없는 도구를 지운 것도 사실대로 답한다. 클라이언트가 그것을 정상으로
	// 볼지는 클라이언트가 정한다.
	if err := pc.pm.Delete(p.ID); err != nil {
		return errResp(req, toolipc.CodeServer, err)
	}
	return okResp(req, struct{}{})
}

// terminate 는 정중한 종료 뒤의 kill 이다 (FBE-05/12). 유예는 클라이언트가 싣는다
// — 값의 주인은 서버(httpapi 의 toolKillGrace)이고 데몬은 그것을 집행한다.
func (pc *panedConn) terminate(req *toolipc.PanedRequest) interface{} {
	p, perr := decodeParams[toolipc.TerminateParams](req)
	if perr != nil {
		return *perr
	}
	if err := pc.pm.Terminate(p.ID, time.Duration(p.GraceMs)*time.Millisecond); err != nil {
		return errResp(req, toolipc.CodeServer, err)
	}
	return okResp(req, struct{}{})
}

func (pc *panedConn) write(req *toolipc.PanedRequest) interface{} {
	p, perr := decodeParams[toolipc.WriteParams](req)
	if perr != nil {
		return *perr
	}
	// `GO-8`: **반환값을 버리지 않는다.** 종전에는 없는 도구에 쓴 것도 성공으로
	// 답했고, 브라우저는 자기가 보낸 키가 들어간 줄 알았다.
	if err := pc.pm.Write(p.ID, p.Data); err != nil {
		return errResp(req, toolipc.CodeServer, err)
	}
	return okResp(req, struct{}{})
}

// paste 는 감싸기 판단까지 **데몬에서** 한다. 셸이 bracketed paste 모드를 켰는지는
// PTY 출력을 읽는 이쪽만 알고, 클라이언트의 Get(id) 은 cmd 없는 합성 Tool 을 주기
// 때문이다 (BRACKETED_PASTE_SRS FR-BPW-4). cwd·busy 가 데몬 RPC 를 경유하는 것과
// 같은 이유다.
func (pc *panedConn) paste(req *toolipc.PanedRequest) interface{} {
	p, perr := decodeParams[toolipc.PasteParams](req)
	if perr != nil {
		return *perr
	}
	if err := pc.pm.SendPaste(p.ID, p.Data, p.Submit); err != nil {
		return errResp(req, toolipc.CodeServer, err)
	}
	return okResp(req, struct{}{})
}

func (pc *panedConn) resize(req *toolipc.PanedRequest) interface{} {
	p, perr := decodeParams[toolipc.ResizeParams](req)
	if perr != nil {
		return *perr
	}
	// `GO-8`: 리사이즈도 같다 — 없는 도구의 크기를 바꿨다고 답하지 않는다.
	if err := pc.pm.Resize(p.ID, p.Cols, p.Rows); err != nil {
		return errResp(req, toolipc.CodeServer, err)
	}
	return okResp(req, struct{}{})
}

func (pc *panedConn) list(req *toolipc.PanedRequest) interface{} {
	return okResp(req, toolipc.ListResult{Tools: pc.pm.List()})
}

func (pc *panedConn) snapshot(req *toolipc.PanedRequest) interface{} {
	// Since 가 없는 옛 요청은 -1 로 읽혀 전량 재생이 된다 (FR-TRS-3).
	p := toolipc.SnapshotParams{Since: -1}
	if perr := decodeParamsInto(req, &p); perr != nil {
		return *perr
	}
	snap, err := pc.pm.SnapshotToolSince(p.ID, p.Since)
	if err != nil {
		return errResp(req, toolipc.CodeInternal, err)
	}
	data := snap.Data
	if data == nil {
		data = []byte{}
	}
	return okResp(req, toolipc.SnapshotResult{
		Data:           data,
		TotalBytesIn:   snap.TotalBytesIn,
		TotalBytesDrop: snap.TotalBytesDrop,
		Retained:       snap.Retained,
		End:            snap.End,
		Resumed:        snap.Resumed,
		// FR-M9-3 ①: 크기를 함께 싣는다. 받는 쪽은 PTY 가 다른 프로세스에 있어
		// 이것 없이는 접속 직후의 폭을 알 길이 없다. 필드를 모르는 옛 웹서버는
		// 0 으로 읽고 통보하지 않는다 — 지금 동작과 같다.
		Cols: snap.Cols,
		Rows: snap.Rows,
		// FR-TMR-24: 앱이 켜 둔 모드. 같은 근거로 같은 자리다 — 웹서버는 PTY 를
		// 보지 못하므로 이것 없이는 재접속한 xterm 에 모드를 되세울 수 없다.
		Modes: snap.Modes,
	})
}

func (pc *panedConn) cwd(req *toolipc.PanedRequest) interface{} {
	p, perr := decodeParams[toolipc.IDParams](req)
	if perr != nil {
		return *perr
	}
	return okResp(req, toolipc.CwdResult{Cwd: pc.pm.Cwd(p.ID)})
}

func (pc *panedConn) busy(req *toolipc.PanedRequest) interface{} {
	p, perr := decodeParams[toolipc.IDParams](req)
	if perr != nil {
		return *perr
	}
	return okResp(req, toolipc.BusyResult{Busy: pc.pm.Busy(p.ID)})
}

func (pc *panedConn) setBackground(req *toolipc.PanedRequest) interface{} {
	p, perr := decodeParams[toolipc.SetBackgroundParams](req)
	if perr != nil {
		return *perr
	}
	return okResp(req, toolipc.SetBackgroundResult{OK: pc.pm.SetBackground(p.ID, p.Background)})
}

func (pc *panedConn) backgroundList(req *toolipc.PanedRequest) interface{} {
	return okResp(req, toolipc.BackgroundListResult{Background: pc.pm.BackgroundList()})
}

// ── Push events ────────────────────────────────────────────────────────

// pushExit notifies dongminal that a tool exited.
func (pc *panedConn) pushExit(toolID string, info toolhub.ExitInfo) {
	pc.enqueue(toolipc.ExitEvent{Event: toolipc.EventExit, Tool: toolID, Code: info.Code}, false)
}

// pushForeground notifies dongminal that a tool's foreground process name
// changed (FR-TAN-9). Droppable: the same value also rides in every `list`
// response, so a push lost to backpressure self-heals on the next poll — and
// a name update must never stall the daemon.
func (pc *panedConn) pushForeground(toolID, name string) {
	pc.enqueue(toolipc.ForegroundEvent{Event: toolipc.EventForeground, Tool: toolID, Name: name}, true)
}

// pushSize 는 `size` push 다 — PTY 크기가 **바뀌었다** (M9_SRS FR-M9-3 ②).
//
// droppable 이 아니다. 크기 통보를 잃으면 그 클라이언트는 어긋난 폭으로 계속
// 읽으며 스스로 낫지 않는다 — `fg` 처럼 다음 폴링이 메워 주는 값이 아니다.
// 다음에 이 값을 다시 말하는 자리는 **다음 접속의 snapshot** 뿐이다.
func (pc *panedConn) pushSize(toolID string, cols, rows uint16) {
	pc.enqueue(toolipc.SizeEvent{Event: toolipc.EventSize, Tool: toolID, Cols: cols, Rows: rows}, false)
}

// end 는 이 청크의 끝 절대 오프셋이다 (TERMINAL_RESUME_SRS FR-TRS-15). 받는 쪽이
// 스냅샷과 겹치는 앞부분을 정확히 잘라내는 근거다. data 는 writeLoop 가 부호화할
// 때까지 쥐고 있다 — 넘기는 쪽(readPTY 릴레이)은 청크마다 새 사본을 준다.
func (pc *panedConn) pushOutputData(toolID string, data []byte, end int64) {
	pc.enqueue(toolipc.OutputEvent{Event: toolipc.EventOutput, Tool: toolID, Data: data, End: end}, true)
}

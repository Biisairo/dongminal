package httpapi

import (
	"dongminal/internal/shared/dmlog"
	"dongminal/internal/webserver/apierr"
	"dongminal/internal/webserver/hub"

	"encoding/json"
	"fmt"
	"net/http"

	"dongminal/internal/shared/httpreq"
	"dongminal/internal/shared/httpresp"
	"dongminal/internal/webserver/sse"
	"time"
)

// translateLocationUUID rewrites args.location in-place when the value is a
// UUID, replacing it with the canonical "W{n}.P{n}.T{n}" coordinate that the
// browser parses. Non-UUID values (coordinate / toolId / label / empty) and
// missing location field pass through with no rewrite, preserving every
// existing dmctl and MCP call (NFR-UID-0). Returns (origLoc, finalLoc) so the
// caller can log both forms when the input was a UUID.
//
// keepUUID 이면 검사와 좌표 계산만 하고 args 는 그대로 둔다 (TAB_NAME_DELIVERY_SRS
// FR-TND-1). 모든 브라우저에 방송하는 명령은 낡은 브라우저가 좌표를 다른 탭으로
// 읽을 수 있다 — uuid 는 모르는 브라우저에서 무동작이다.
func translateLocationUUID(rawArgs *json.RawMessage, ws WorkspaceStore, keepUUID bool) (orig, final string, err error) {
	if rawArgs == nil || len(*rawArgs) == 0 || ws == nil {
		return "", "", nil
	}
	var args map[string]any
	if uerr := json.Unmarshal(*rawArgs, &args); uerr != nil {
		return "", "", nil // not an object — leave untouched
	}
	loc, ok := args["location"].(string)
	if !ok || loc == "" {
		return "", "", nil
	}
	// FR-DMC-9: location 은 list-workspace 의 uuid (tab.id) 만 허용. 좌표/라벨/toolId
	// 는 거부 — 사용자가 reflow 위험이 있는 식별자를 무의식적으로 쓰는 표면을 차단.
	if !ws.IsKnownTabID(loc) {
		return loc, "", fmt.Errorf("location 은 list-workspace 의 uuid 만 허용 (좌표/라벨/toolId 거부): %q", loc)
	}
	coord, cerr := ws.CoordinateOf(loc)
	if cerr != nil {
		return loc, "", cerr
	}
	if keepUUID {
		return loc, coord, nil
	}
	args["location"] = coord
	patched, merr := json.Marshal(args)
	if merr != nil {
		return loc, coord, merr
	}
	*rawArgs = patched
	return loc, coord, nil
}

// uuidLocationActions 는 location 을 좌표로 바꾸지 않고 방송하는 액션이다
// (TAB_NAME_DELIVERY_SRS FR-TND-1).
var uuidLocationActions = map[string]bool{"renameTab": true, "renameWindow": true}

func (s *Server) handleCommandSSE(w http.ResponseWriter, r *http.Request) {
	if !sse.Supported(w) {
		httpErr(w, "streaming unsupported", http.StatusInternalServerError, apierr.CodeStreamUnsupport)
		return
	}
	// REPO_FIX 02 §3A-2: 매 flush 에 시한을 건다 — 읽지 않는 클라이언트에서 쓰기가
	// 막혀도 핸들러가 돌아가 구독 정리(Remove·Detach)가 돈다 (#21). 시한과 프레임
	// 조립은 `sse.Stream` 한 벌이다 (OPTIMIZE_REFACTOR_SRS FR-OPT-8-1).
	st := sse.Start(w, sseWriteTimeout)

	// OPTIMIZE_REFACTOR_SRS FR-OPT-4-12 (D-OPT-4): `presence=1` 은 칸 구독이다
	// (WINDOW_SLOTS_SRS FR-WSL-11). 소유권 수명(Focus·git 임대)만 쥐고 방송 구독을
	// 만들지 않는다 — 받은 메시지를 버리는 구독에 방송을 칸 수만큼 싣지 않는다.
	// 인사(keepalive)는 그대로 보낸다. 옛 서버는 이 파라미터를 모르고 전부 보내며,
	// 칸 구독은 그것을 처리하지 않으므로 교차 판에서도 같다.
	presence := r.URL.Query().Get("presence") == "1"
	msgs, closed, release, ok := s.subscribeCommandSSE(st, presence)
	if !ok {
		return
	}
	defer release()

	cid := r.URL.Query().Get("clientId")
	plan := sseSubPlanFor(cid, presence)
	defer s.attachSSELeases(plan, cid, r.RemoteAddr)()

	// UPDATE_NOTICE_SRS FR-UPD-2 ② — **새로고침과 재연결이 여기 하나로 온다.**
	//
	// 그 둘을 따로 세는 코드를 두지 않는다 (D-UPD-7). 화면이 열리는 순간이
	// 안내를 볼 수 있는 유일한 때이므로, 그때 캐시를 새로 채우는 것이 가장
	// 정직하다. **기다리지 않는다** — Trigger 는 즉시 돌아오고, 결과가 바뀌면
	// `update_changed` 가 그때 배지를 세운다 (FR-UPD-8a / NFR-UPD-2).
	//
	// **고루틴으로 떨어뜨리는 것이 이 계층의 책임이다.** Trigger 가 즉시
	// 돌아온다는 것은 지금 구현의 성질이고, 이 연결이 막히지 않는다는 것은
	// 이 계층의 요구다 (NFR-UPD-2). 둘을 같은 것으로 보면, 협력자가 언젠가
	// 느려질 때 SSE 가 함께 선다.
	if s.Updates != nil && plan.update {
		go s.Updates.Trigger()
	}

	// RELOAD_CONTINUITY_SRS FR-RLC-20: **첫 이벤트로 자기 판을 말한다.** 자산은
	// 바이너리에 박혀 있어(`web/embed.go`) 그것이 바뀌는 길은 프로세스 교체뿐이고,
	// 프로세스가 바뀌면 이 구독은 반드시 끊긴다 — 그러므로 **구독이 열리는 순간이
	// 곧 "자산이 바뀌었을 수 있는 순간"** 이며, 화면은 주기적으로 물어볼 필요가 없다.
	hello := s.helloEvent()
	// 연결 주석과 인사는 한 번에 flush 한다(종전과 같다) — 첫 읽기가 인사를 본다.
	st.Comment("connected")
	st.Data(hello)
	if !st.Flush() {
		return
	}
	if !presence && s.foregroundOnConnect(st) && !st.Flush() {
		return
	}
	s.pumpCommandSSE(r, st, msgs, closed, hello)
}

// foregroundOnConnect 는 구독이 열린 뒤 도구마다 지금의 전경 이름을 싣는다 (QUALITY_FLAKY_SRS FR-FLK-3).
//
//	이전 동작: 전경 이름은 바뀔 때의 방송뿐이었다. 화면의 부팅 조회(`/api/state`)와 이 구독 사이에
//	          바뀐 이름(새 셸의 첫 틱 `"" → "~"` 등)은 받을 구독이 없어 사라졌고, 다음 변화까지 낡았다
//	새  동작: 인사 뒤에 도구마다 `tool_foreground` 를 한 번 싣는다
//	이유:     구독(`Add`)이 이미 열렸으므로 이 목록 뒤의 변화는 큐에 쌓여 이 줄들 **뒤에** 나간다 —
//	          틈이 닫힌다. 인사를 먼저 flush 하는 것은 목록 조회(데몬 RPC)가 인사를 늦추지 않게 하려는 것이다
//
// 목록을 모르면 싣지 않는다 — 모르는 목록의 빈 이름이 화면의 이름을 지우면 안 된다 (FR-TLU-7).
func (s *Server) foregroundOnConnect(st *sse.Stream) bool {
	if s.Tools == nil {
		return false
	}
	tools, known := s.Tools.ListOK()
	if !known || len(tools) == 0 {
		return false
	}
	for _, ev := range hub.ForegroundSnapshot(tools) {
		st.Data(ev)
	}
	return true
}

// subscribeCommandSSE 는 SSE 하나의 구독을 연다. 칸 구독(presence)은 방송 구독 없이
// 상한만 센다. 상한을 넘으면 거절 한 줄을 보내고 ok 가 거짓이다.
func (s *Server) subscribeCommandSSE(st *sse.Stream, presence bool) (msgs <-chan []byte, closed <-chan struct{}, release func(), ok bool) {
	// 상한 초과 (04-secops P1-4). 헤더를 이미 썼으므로 상태 코드를 바꿀 수
	// 없다 — 대신 인사 대신 사유를 한 줄 보내고 닫는다. 화면은 SSE 재연결
	// 규약(`CONNECTIVITY_RESILIENCE_SRS`)으로 다시 붙는다.
	reject := func() {
		st.Data([]byte(`{"action":"subscribeRejected"}`))
		st.Flush()
	}
	if presence {
		// presence 구독도 goroutine 하나다 — 방송 구독과 같은 상한을 따로 센다.
		if s.conn.presenceSubs.Add(1) > hub.SubCap {
			s.conn.presenceSubs.Add(-1)
			reject()
			return nil, nil, nil, false
		}
		return nil, nil, func() { s.conn.presenceSubs.Add(-1) }, true
	}
	sub := s.Commands.Add()
	if sub == nil {
		reject()
		return nil, nil, nil, false
	}
	return sub.Messages(), sub.Closed(), func() { s.Commands.Remove(sub) }, true
}

// sseSubPlan 은 SSE 구독 하나가 쥐는 수명들이다.
type sseSubPlan struct {
	focus    bool // Focus 소유권
	gitWatch bool // git 감시 임대
	fsWatch  bool // 파일 감시 등록
	update   bool // 업데이트 확인 계기
}

// sseSubPlanFor 는 구독이 쥘 수명을 정한다.
//
// FR-XDF-8: 구독에 clientId 를 결선한다. hub.cmdSub 자체에는 신원이 없으므로
// 이 결선 없이는 구독 해제와 소유권 해제를 이을 수 없다.
//
// GIT_WATCH_LEASE_SRS FR-GWL-3: **git 감시 임대도 이 구독이 쥔다.**
//
// 종전에는 임대의 주체가 `GET /api/git/status` 요청이었고 수명이 90초였다.
// 그래서 안전망 폴링을 끄거나 늦추면 본줄인 `git_changed` 방송까지 함께
// 죽었다 (11-git-polling GP-1). 보고 있는 동안을 아는 것은 요청이 아니라
// 연결이므로, Focus 와 같은 자리에서 같은 규약으로 건다.
//
// EDITOR_LIVE_RELOAD_SRS FR-ELR-52: 파일 감시 등록도 같은 구독이 쥔다. 칸 구독(presence)은
// 방송을 받지 않으므로 `fs_changed` 에 반응할 수 없다 — 임대를 쥐지 않는다.
//
// 칸 구독은 화면이 열리는 순간이 아니다 — 같은 화면의 칸 0 구독이 업데이트 확인을
// 이미 걸었다 (FR-OPT-4-12).
func sseSubPlanFor(cid string, presence bool) sseSubPlan {
	return sseSubPlan{
		focus:    cid != "",
		gitWatch: cid != "",
		fsWatch:  cid != "" && !presence,
		update:   !presence,
	}
}

// attachSSELeases 는 plan 의 수명을 걸고, 건 역순으로 푸는 함수를 돌려준다.
func (s *Server) attachSSELeases(plan sseSubPlan, cid, remoteAddr string) (release func()) {
	var undo []func()
	// FR-XDF-9: 구독이 끊기면 그 Client 의 소유권을 즉시 해제한다 —
	// grace period 없음. epoch 로 재연결 경합을 막는다 (FR-XDF-10).
	if plan.focus && s.Focus != nil {
		// VIEWER_URL_OPEN_SRS FR-VUO-1: 구독의 원격 주소를 함께 남긴다. 이 값이
		// "보고 있는 기기가 서버와 같은 컴퓨터인가" 의 유일한 근거다.
		ep := s.Focus.AttachFrom(cid, remoteAddr)
		undo = append(undo, func() {
			if s.Focus.Detach(cid, ep) {
				s.broadcastFocusOwners()
			}
		})
	}
	if plan.gitWatch && s.gitWatch != nil {
		ep := s.gitWatch.Attach(cid)
		undo = append(undo, func() { s.gitWatch.Detach(cid, ep) })
	}
	if plan.fsWatch && s.fs.watch != nil {
		ep := s.fs.watch.Attach(cid)
		undo = append(undo, func() { s.fs.watch.Detach(cid, ep) })
	}
	return func() {
		for i := len(undo) - 1; i >= 0; i-- {
			undo[i]()
		}
	}
}

// pumpCommandSSE 는 방송과 인사를 구독이 끝날 때까지 흘린다.
func (s *Server) pumpCommandSSE(r *http.Request, st *sse.Stream, msgs <-chan []byte, closed <-chan struct{}, hello []byte) {
	// FR-RLC-20a: 인사가 keepalive 를 **대신한다.** 종전의 `: keep` 주석은 연결을
	// 살려 두기만 했다 — `EventSource` 는 주석에 이벤트를 발화하지 않으므로 화면은
	// 그것이 왔는지 알 수 없었고, 따라서 구독이 살아 있는지도 알 수 없었다.
	// 잠에서 깬 기기의 half-open 소켓이 정확히 그 틈에 산다 (FR-RLC-20b).
	keep := time.NewTicker(s.helloInterval())
	defer keep.Stop()

	for {
		select {
		case <-r.Context().Done():
			return
		case <-closed:
			return
		case msg := <-msgs:
			// IPC-12: 이미 쌓인 것을 함께 꺼내 한 번에 쓴다 — 버스트 하나가 flush
			// (syscall) N번이 되지 않는다.
			st.Data(msg)
			st.DrainData(msgs)
		case <-keep.C:
			st.Data(hello)
		}
		if !st.Flush() {
			return
		}
	}
}

// commandPostReq 는 `POST /api/commands` 의 본문이자 방송 payload 다.
type commandPostReq struct {
	Action string          `json:"action"`
	Args   json.RawMessage `json:"args,omitempty"`
	ReqId  string          `json:"reqId,omitempty"`
	// ExecClientId names the single client that must perform this command
	// (FR-SXE-2). Empty for ungated actions and when nothing is subscribed,
	// which FR-SXE-3 reads as "do not gate".
	ExecClientId string `json:"execClientId,omitempty"`
}

func (s *Server) handleCommandPost(w http.ResponseWriter, r *http.Request) {
	req, ok := parseCommandPost(w, r)
	if !ok {
		return
	}
	// VIEWER_URL_OPEN_SRS: 열 URL 을 먼저 거르고(FR-VUO-18) 어디서 열지 정한다.
	// 로컬이면 브로드캐스트하지 않는다 — 부른 쉘이 직접 연다 (FR-VUO-2).
	openURLWhere := ""
	if req.Action == OpenURLAction {
		if _, verr := openURLTarget(req.Args); verr != nil {
			// `openurl.go` 가 사용자에게 하려고 쓴 말이다 — 어느 인자가 왜
			// 거부됐는지가 그 문구에 있고, 내부 사정은 담기지 않는다.
			fail(w, http.StatusBadRequest, verr.Error(), nil)
			return
		}
		openURLWhere, _ = s.openURLWhere()
	}

	origLoc, finalLoc, err := translateLocationUUID(&req.Args, s.Work, uuidLocationActions[req.Action])
	if err != nil {
		// 사용자가 보낸 `location` 값에 대한 말이다 (commands.go:36).
		fail(w, http.StatusBadRequest, err.Error(), nil)
		return
	}
	locField := commandLocField(origLoc, finalLoc)

	// FR-SXE-2: 지명은 브로드캐스트 직전에 한다. 여기서 정하지 않으면 구독 중인
	// 모든 브라우저가 각자 엔터티를 만들어 하나만 참조되고 나머지가 고아가 된다.
	req.ExecClientId = ""
	if hub.IsSingleExecutorAction(req.Action) && s.Focus != nil {
		req.ExecClientId = s.Focus.Executor()
	}

	resp := map[string]interface{}{
		"ok":                true,
		"action":            req.Action,
		"location":          finalLoc,
		"requestedLocation": origLoc,
	}

	if openURLWhere != "" {
		// FR-VUO-1: dmctl 이 이 값을 보고 로컬 실행 여부를 정한다.
		resp["where"] = openURLWhere
	}
	if openURLWhere == whereLocal {
		resp["delivered"] = 0
		dmlog.Infof(nil, "[cmd] action=%s where=local (뷰어가 서버와 같은 컴퓨터 — 부른 셸이 연다)", req.Action)
		httpresp.JSON(w, http.StatusOK, resp)
		return
	}
	s.dispatchCommand(req, resp, locField)
	httpresp.JSON(w, http.StatusOK, resp)
}

// parseCommandPost 는 방식·본문·액션 이름을 검사한다. 거절했으면 답을 쓰고 ok 가 거짓이다.
func parseCommandPost(w http.ResponseWriter, r *http.Request) (req commandPostReq, ok bool) {
	if r.Method != http.MethodPost {
		httpErr(w, "method not allowed", http.StatusMethodNotAllowed, apierr.CodeNotAllowed)
		return req, false
	}
	body, err := httpreq.Read(w, r, 0)
	if err != nil {
		failRead(w, err)
		return req, false
	}
	if err := json.Unmarshal(body, &req); err != nil {
		httpErr(w, httpreq.Message(r, "invalid json", err), http.StatusBadRequest, apierr.CodeInvalidJSON)
		return req, false
	}
	if !hub.IsAllowedCmdAction(req.Action) {
		httpErr(w, "unknown action: "+req.Action, http.StatusBadRequest, apierr.CodeUnknownAction)
		return req, false
	}
	// SERVER_DRIVEN_ACTIONS_SRS F-4: 이름의 길이 상한은 서버가 정한다 — 화면을 거치지 않는
	// dmctl 도 같은 상한을 지난다.
	//	이전 동작: 서버는 길이를 보지 않았고, 받은 브라우저가 64자로 잘랐다
	if a := commandNameAnswer(req.Action, req.Args); !a.OK {
		rejectCommandAnswer(w, a)
		return req, false
	}
	return req, true
}

// commandLocField 는 명령 로그의 location 꼬리다. uuid 로 받았으면 두 형태를 다 적는다.
func commandLocField(origLoc, finalLoc string) string {
	switch {
	case finalLoc == "":
		return ""
	case origLoc != finalLoc:
		return fmt.Sprintf(" location=%s uuid=%s", finalLoc, origLoc)
	default:
		return " location=" + finalLoc
	}
}

// dispatchCommand 는 명령을 방송하고 결과를 resp 에 싣는다.
func (s *Server) dispatchCommand(req commandPostReq, resp map[string]interface{}, locField string) {
	if hub.AwaitsResult(req.Action) {
		// FR-RCR-4: reqId 발급 → broadcast → 브라우저 echo 대기 → 새 id 포함 반환.
		req.ReqId = hub.NewReqId()
		payload, _ := json.Marshal(req)
		res, n, timedOut := s.Commands.BroadcastAndAwait(payload, req.ReqId, hub.CommandResultTimeout())
		putCommandResult(resp, res, n, timedOut)
		dmlog.Infof(nil, "[cmd] action=%s%s delivered=%d newTabs=%d timedOut=%t",
			req.Action, locField, n, len(res.NewTabs), timedOut)
		return
	}
	// FR-RCR-5: 비생성 명령은 기존과 완전히 동일 (대기 없음, 새 필드 없음).
	payload, _ := json.Marshal(req)
	n := s.Commands.Broadcast(payload)
	resp["delivered"] = n
	// OPTIMIZE_REFACTOR_SRS FR-OPT-8-6 (HTTP-28): 전문(openUrl 의 URL·이름 인자)은
	// Debug 로만 남긴다 — 로그 상한(FR-LOG-1)이 있는 제품이고, 생성 명령 쪽 로그에도
	// payload 가 없다.
	dmlog.Infof(nil, "[cmd] action=%s%s delivered=%d bytes=%d", req.Action, locField, n, len(payload))
	dmlog.Debugf(nil, "[cmd] action=%s payload=%s", req.Action, string(payload))
}

// putCommandResult 는 생성 명령의 echo 를 응답 필드로 옮긴다. 빈 선택 필드는 싣지 않는다.
func putCommandResult(resp map[string]interface{}, res hub.CmdResult, n int, timedOut bool) {
	resp["delivered"] = n
	resp["newWindows"] = res.NewWindows
	resp["newPanes"] = res.NewPanes
	resp["newTabs"] = res.NewTabs
	resp["timedOut"] = timedOut
	if len(res.NewGroups) > 0 {
		resp["newGroups"] = res.NewGroups
	}
	if res.Position != nil {
		resp["position"] = res.Position
	}
	if res.Error != "" {
		resp["error"] = res.Error
	}
}

// handleCommandResult receives the browser's echo for a creating command and
// routes it to the awaiting handleCommandPost / MCP handler (FR-RCR-3).
func (s *Server) handleCommandResult(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		httpErr(w, "method not allowed", http.StatusMethodNotAllowed, apierr.CodeNotAllowed)
		return
	}
	var body struct {
		ReqId      string           `json:"reqId"`
		NewWindows []string         `json:"newWindows"`
		NewPanes   []string         `json:"newPanes"`
		NewTabs    []hub.TabRef     `json:"newTabs"`
		NewGroups  []string         `json:"newGroups"`
		Position   *hub.CmdPosition `json:"position"`
		Error      string           `json:"error"`
	}
	ok, answered := readBodyHTTP(w, r, &body)
	if answered {
		return
	}
	if !ok {
		httpErr(w, "invalid json", http.StatusBadRequest, apierr.CodeInvalidJSON)
		return
	}
	if body.ReqId != "" {
		s.Commands.DeliverResult(body.ReqId, hub.CmdResult{
			NewWindows: body.NewWindows,
			NewPanes:   body.NewPanes,
			NewTabs:    body.NewTabs,
			NewGroups:  body.NewGroups,
			Position:   body.Position,
			Error:      body.Error,
		})
	}
	w.WriteHeader(http.StatusOK)
}

// sseHelloEvery 는 SSE 인사의 기본 주기다 (RELOAD_CONTINUITY_SRS FR-RLC-20a).
// 종전 keepalive 주석과 같은 값이라 오가는 양이 늘지 않는다.
const sseHelloEvery = 15 * time.Second

// sseWriteTimeout 은 SSE flush 하나의 시한이다 (REPO_FIX 02 §3A-2). 테스트만 줄인다.
var sseWriteTimeout = sse.WriteTimeout

func (s *Server) helloInterval() time.Duration {
	if s.helloEvery > 0 {
		return s.helloEvery
	}
	return sseHelloEvery
}

// helloEvent 는 구독에 보낼 인사 한 줄이다.
//
// FR-RLC-22: 판을 모르면 **판만 뺀다.** 빈 값을 실으면 받는 쪽이 "달라졌다" 로 읽고,
// 인사를 통째로 거르면 생존 신호가 함께 사라져 화면이 멀쩡한 구독을 죽었다고
// 판정한다 (FR-RLC-25).
func (s *Server) helloEvent() []byte {
	var args any
	if v := s.assetVersion(); v != "" {
		args = map[string]any{"assetVersion": v}
	}
	return sse.Payload("server_hello", args)
}

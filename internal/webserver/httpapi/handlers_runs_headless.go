package httpapi

import (
	"crypto/sha256"
	"dongminal/internal/shared/dmlog"
	"dongminal/internal/shared/toolhub"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"time"

	"dongminal/internal/webserver/domain/run"
	"dongminal/internal/webserver/hub"
)

// 묶음 H — 헤드리스 멤버 (ORCHESTRATION_V2_SRS §3.2).
//
// 헤드리스 멤버는 어떤 탭도 참조하지 않는 Tool 에 결속한 Member 다. 인프라는 이미
// 있다 — toolhub.ToolManager.Create 는 워크스페이스 트리와 무관하고, background
// 레지스트리가 "탭에 붙지 않은 살아있는 도구" 를 이미 다룬다. 새 개념이 아니라
// 그 둘의 결합이다.

// 화면이 없으므로 크기는 리사이즈 대상이 아니다 (FR-HLM-2). 고정값이 필요한
// 이유가 그것이고, 값은 브라우저가 새 도구를 만들 때 쓰는 것과 같다
// (web/js/core/app-tool.js `_newTool`).
const (
	headlessCols = 120
	headlessRows = 40
)

// attachSettleTimeout 은 부착·분리를 브라우저가 반영하기를 기다리는 상한이다.
//
// restoreTool·detachTab 은 생성 명령이 아니라서 reqId echo 규약에 참여하지 않는다
// (hub/commands.go `creatingActions`). 그래서 새 탭의 uuid 를 동기적으로 받을 길이
// 없고, 워크스페이스 색인이 갱신되기를 관측하는 수밖에 없다.
const (
	attachSettleTimeout = 3 * time.Second
	attachPollInterval  = 50 * time.Millisecond
)

// apiToolsHeadless implements POST /api/tools/headless (FR-HLM-2).
//
// 탭 없는 Tool 을 만들어 백그라운드 레지스트리에 등록한다. Run 과 무관한 1급
// 종단인 이유는 SRS §4.2 가 그렇게 열거하기 때문이고, 멤버 생성 경로도 같은
// 헬퍼를 쓴다 — 두 경로가 다른 도구를 만들면 안 된다.
func (s *Server) apiToolsHeadless(w http.ResponseWriter, r *http.Request) {
	if s.Tools == nil {
		writeToolIOError(w, http.StatusServiceUnavailable, "tool hub unavailable")
		return
	}
	var body struct {
		Cwd string `json:"cwd"`
		// UX_BATCH6_SRS FR-BGP-3: 띄울 명령. 비면 종전대로 로그인 셸이다.
		Command string `json:"command"`
	}
	if !decodeJSONBody(w, r, &body) {
		return
	}
	toolID, err := s.createHeadlessTool(body.Cwd, body.Command)
	if err != nil {
		writeToolIOError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, map[string]any{
		"toolId": toolID, "cwd": body.Cwd, "command": body.Command,
		"cols": headlessCols, "rows": headlessRows, "headless": true,
	})
}

// redactCmdForLog 는 명령을 **길이와 해시로** 줄인다 (04-secops P1-6).
//
// 로그에 명령 전문을 남기면 토큰·비밀번호가 그 파일에 눕는다. 같은 감사 항목의
// 나머지(홈 `0700` · 소켓·로그 `0600` · 로그 위치를 `/tmp` 밖으로)는 이미
// 닫혔고, 남은 자리가 여기였다.
//
// **진단을 잃지 않는다.** 로그가 답해야 하는 물음은 "같은 명령이 다시 돌았나 ·
// 비어 있었나(로그인 셸인가) · 얼마나 긴가" 이고 길이와 해시가 그것에 답한다.
// 해시를 12자로 자르는 것은 git 의 약칭과 같은 근거다 — 대조에 충분하고 한 줄을
// 덜 먹는다.
func redactCmdForLog(command string) string {
	if command == "" {
		// 비었다는 사실은 비밀이 아니고, 그것이 곧 "로그인 셸" 이라는 뜻이다.
		return "none"
	}
	sum := sha256.Sum256([]byte(command))
	return fmt.Sprintf("len:%d sha256:%s", len(command), hex.EncodeToString(sum[:])[:12])
}

// createHeadlessTool spawns a tab-less tool and registers it as background
// (FR-HLM-2).
//
// 백그라운드 등록이 생성의 일부인 이유: 등록하지 않으면 "어떤 탭도 참조하지 않는
// 살아있는 도구" 가 되어 ⏻ 목록에도 탭에도 없는 — 어디서도 닿을 수 없는 상태가
// 된다. 기존 detach 경로가 대상 확정을 백그라운드 해제보다 앞세우는 것과 같은
// 이유다 (FR-BGR-5).
//
// UX_BATCH6_SRS FR-BGP-3·4: `command` 가 있으면 **그 명령이 도구의 프로세스**다.
// 셸을 띄우고 그 안에 타이핑하던 종전 방식과 달리, 명령이 끝나면 도구가 죽고
// 죽으면 백그라운드 목록에서 사라진다 — "명령이 끝났다" 를 따로 감지하는 자리가
// 없어야 한다는 것이 요구다 ("프로세스가 있으면 살아있고 없으면 죽는것").
//
// 비면 종전대로 로그인 셸이다. Run 의 멤버 기동(`run launch | send-input`)이 그
// 경로를 그대로 쓴다 (FR-BGP-5).
func (s *Server) createHeadlessTool(cwd, command string) (string, error) {
	tool, err := s.Tools.Create(cwd, headlessCols, headlessRows, toolhub.Placement{Command: command})
	if err != nil {
		return "", err
	}
	s.Tools.SetBackground(tool.ID, true)
	dmlog.Infof(nil, "[run] headless tool=%s cwd=%s cmd=%s %dx%d", tool.ID, cwd, redactCmdForLog(command), headlessCols, headlessRows)
	// UX_REVISION_SRS FR-BGV-1: 브라우저의 ⏻ 목록은 **자기 행동**(detach·복귀)과
	// SSE 재연결로만 갱신된다. 서버가 만든 백그라운드 도구를 알리지 않으면 배지가
	// 0 인 채로 남고, 사용자는 모달을 열거나 새로고침해야 그것을 본다 —
	// FR-HLM-2("헤드리스 도구는 ⏻ 목록에 함께 보인다")가 그 사이 성립하지 않는다.
	s.broadcastLayout("tools_background_changed", nil)
	return tool.ID, nil
}

// apiRunAttach implements POST /api/runs/attach (FR-HLM-6).
//
// 백그라운드 복귀와 **같은 경로**를 쓴다 — `restoreTool` 은 detach --restore 가
// 이미 쓰는 명령이고, 브라우저 쪽 처리(`_restoreTool`)가 백그라운드 해제와 탭
// 생성을 한 묶음으로 한다. 경로가 둘이어도 결과는 하나여야 한다 (FR-HLM-9).
func (s *Server) apiRunAttach(w http.ResponseWriter, r *http.Request) {
	if !s.runsReady(w) {
		return
	}
	var body struct {
		MemberID string `json:"memberId"`
		// Location 은 탭 uuid 다. 비면 브라우저의 현재 포커스 분할 칸이 대상이다
		// (FR-HLM-6, FR-BGR-4 와 같은 규약).
		Location string `json:"location"`
	}
	if !decodeJSONBody(w, r, &body) {
		return
	}
	_, m, ok := s.runMember(w, body.MemberID)
	if !ok {
		return
	}
	if m.TabID != "" {
		writeRunError(w, run.ErrMemberAttached, map[string]any{"memberId": m.ID, "tabId": m.TabID})
		return
	}
	if !s.toolLive(m.ToolID) {
		// 죽은 도구를 화면에 붙일 수는 없다. lost 는 진단이지 오류가 아니므로
		// 사유를 그대로 낸다 — 조정자는 승계를 결정해야 한다.
		writeToolIOError(w, http.StatusNotFound, "멤버의 도구가 살아 있지 않다: "+m.ToolID)
		return
	}
	args := map[string]any{"toolId": m.ToolID}
	if body.Location != "" {
		args["location"] = body.Location
	}
	if n := s.broadcastLayout("restoreTool", args); n == 0 {
		writeToolIOError(w, http.StatusServiceUnavailable,
			"구독 중인 브라우저가 없다 — 부착은 화면이 있어야 한다")
		return
	}
	tabID := s.awaitTab(m.ToolID, true)
	if tabID == "" {
		// 기록을 고치지 않는다. 브라우저가 늦게 탭을 만들었다면 다시 부르면
		// 그 탭을 관측해 성공한다 — 재시도가 스스로 낫는다.
		writeToolIOError(w, http.StatusGatewayTimeout,
			"브라우저가 탭 생성을 반영하지 않았다 — 잠시 후 다시 시도한다")
		return
	}
	rec, updated, err := s.Runs.Attach(m.ID, tabID)
	if errors.Is(err, run.ErrMemberAttached) {
		// 같은 복귀를 백그라운드 해제 종단이 먼저 관측해 기록했다
		// (reconcileMemberTab). 둘은 같은 답에 도달하므로 경합은 성공이다 —
		// 다만 **같은 탭일 때만** 그렇다.
		if cur, got, ok := s.Runs.FindMember(m.ID); ok && got.TabID == tabID {
			rec, updated, err = cur, got, nil
		}
	}
	if err != nil {
		writeRunError(w, err, map[string]any{"memberId": m.ID})
		return
	}
	s.markWorkspaceRun(rec, tabID, rec.ID)
	dmlog.Infof(nil, "[run] attach run=%s member=%s tool=%s tab=%s", rec.ID, updated.ID, updated.ToolID, tabID)
	writeJSON(w, memberView{Member: updated, State: s.deriveMemberState(updated)})
}

// apiRunDetach implements POST /api/runs/detach (FR-HLM-7).
//
// 탭은 닫히고 도구는 산다. 전환과 탭 닫기를 하나의 명령(`detachTab`)으로 보내는
// 이유는 기존 detach 헬퍼와 같다 — 두 단계로 나누면 그 사이에 탭이 닫혀 도구가
// 종료될 수 있다.
func (s *Server) apiRunDetach(w http.ResponseWriter, r *http.Request) {
	if !s.runsReady(w) {
		return
	}
	var body struct {
		MemberID string `json:"memberId"`
	}
	if !decodeJSONBody(w, r, &body) {
		return
	}
	_, m, ok := s.runMember(w, body.MemberID)
	if !ok {
		return
	}
	if m.TabID == "" {
		writeRunError(w, run.ErrMemberNotAttached, map[string]any{"memberId": m.ID})
		return
	}
	if n := s.broadcastLayout("detachTab", map[string]any{"toolId": m.ToolID}); n == 0 {
		writeToolIOError(w, http.StatusServiceUnavailable,
			"구독 중인 브라우저가 없다 — 분리는 화면이 있어야 한다")
		return
	}
	if s.awaitTab(m.ToolID, false) != "" {
		writeToolIOError(w, http.StatusGatewayTimeout,
			"브라우저가 탭 닫기를 반영하지 않았다 — 잠시 후 다시 시도한다")
		return
	}
	rec, updated, err := s.Runs.Detach(m.ID)
	if err != nil {
		writeRunError(w, err, map[string]any{"memberId": m.ID})
		return
	}
	dmlog.Infof(nil, "[run] detach run=%s member=%s tool=%s", rec.ID, updated.ID, updated.ToolID)
	writeJSON(w, memberView{Member: updated, State: s.deriveMemberState(updated)})
}

// broadcastLayout sends one workspace command and reports how many browsers
// received it. 지명(ExecClientId)은 /api/commands 와 같은 근거로 붙인다 — 두 개의
// 브라우저가 각자 탭을 만들면 하나만 참조되고 나머지가 고아가 된다 (FR-SXE-1/2).
func (s *Server) broadcastLayout(action string, args map[string]any) int {
	if s.Commands == nil {
		return 0
	}
	req := map[string]any{"action": action, "args": args}
	if hub.IsSingleExecutorAction(action) && s.Focus != nil {
		req["execClientId"] = s.Focus.Executor()
	}
	payload, err := json.Marshal(req)
	if err != nil {
		return 0
	}
	return s.Commands.Broadcast(payload)
}

// awaitTab waits until the workspace index agrees that toolID has (want=true)
// or has not (want=false) a tab, and returns the tab uuid it observed.
//
// 폴링인 이유는 위 attachSettleTimeout 의 주석과 같다. 브라우저가 workspace.json
// 을 저장해야 색인이 움직이므로, 이 관측이 "화면에 실제로 반영됐다"의 유일한
// 근거다.
func (s *Server) awaitTab(toolID string, want bool) string {
	deadline := time.Now().Add(attachSettleTimeout)
	for {
		tabID := s.tabIDOfTool(toolID)
		if (tabID != "") == want {
			return tabID
		}
		if !time.Now().Before(deadline) {
			return tabID
		}
		time.Sleep(attachPollInterval)
	}
}

// closeHeadlessTools terminates the tools of members that hold no tab
// (FR-HLM-4) and reports what was left behind (FR-HLM-5).
//
// **부착된 도구는 닫지 않는다.** 탭 부착 멤버는 조정자가 /exit → close-tab 으로
// 정리하며, 그것이 브라우저 확인창을 피하는 유일한 순서다 (FR-BG-3). 헤드리스는
// 닫을 탭이 없으므로 Run 이 소유권을 갖는다.
func (s *Server) closeHeadlessTools(rec run.Record, keep bool) []map[string]any {
	out := []map[string]any{}
	for _, m := range rec.Members {
		if !m.HeadlessTool() || !s.toolLive(m.ToolID) {
			continue
		}
		if keep {
			// --keep-tools 는 전부 보존한다. 보존도 **보고**된다 — 조용히 남는
			// 자원이 없어야 한다 (FR-WKT-12 와 같은 규약).
			out = append(out, map[string]any{
				"memberId": m.ID, "role": m.Role, "toolId": m.ToolID, "kept": true,
			})
			continue
		}
		if s.Tools != nil {
			// `GO-8`: 오류를 **명시로** 무시한다. 이 경로에서 "이미 없다" 는 정상이며
			// (목록이 앞서 걷혔거나 사용자가 두 번 눌렀다) 치울 것이 없다는 뜻이다.
			// 버리는 것과 판단한 것은 다르므로 그 사실을 여기 적어 둔다.
			_ = s.Tools.Delete(m.ToolID)
		}
		dmlog.Infof(nil, "[run] headless close run=%s member=%s tool=%s", rec.ID, m.ID, m.ToolID)
	}
	return out
}

// orphanHeadless lists headless tools still alive under a Run that has already
// ended (FR-HLM-5). worktree 잔여물과 같은 규약이다 — 정리하지 못한 것은 close
// 출력과 이후의 run status 양쪽에 남는다.
func (s *Server) orphanHeadless(rec run.Record) []map[string]any {
	if rec.State == run.Open {
		return nil
	}
	out := []map[string]any{}
	for _, m := range rec.Members {
		if !m.HeadlessTool() || !s.toolLive(m.ToolID) {
			continue
		}
		out = append(out, map[string]any{
			"memberId": m.ID, "role": m.Role, "toolId": m.ToolID,
		})
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

// reconcileMemberTab records the tab a Run member's tool just returned to
// (FR-HLM-6).
//
// **복귀의 단일 관문에서 부른다.** `⏻` 모달의 행 클릭도, `dmctl run attach` 도
// 결국 브라우저의 `_restoreTool` 을 지나고, 그것이 백그라운드 해제를 부른다.
// 여기서 기록을 맞추면 **경로가 둘이어도 기록은 하나**가 된다 — 프런트에 갈래를
// 만들면 탭이 둘이 되거나 복귀가 왕복 지연에 매인다.
//
// 비동기여야 한다. 브라우저는 백그라운드 해제를 **기다린 뒤에** 탭을 만들므로
// (web/js/core/app-tool.js `_restoreTool`), 여기서 탭을 기다리면 서로가 서로를
// 기다린다.
func (s *Server) reconcileMemberTab(toolID string) {
	if s.Runs == nil {
		return
	}
	m, ok := s.Runs.MemberByTool(toolID)
	if !ok || m.TabID != "" {
		return
	}
	go func() {
		tabID := s.awaitTab(toolID, true)
		if tabID == "" {
			// 브라우저가 탭을 만들지 않았다. 기록은 그대로 두는 편이 낫다 —
			// 없는 탭을 가리키는 기록보다 빈 기록이 정직하다.
			return
		}
		rec, updated, err := s.Runs.Attach(m.ID, tabID)
		if err != nil {
			// ErrMemberAttached 는 경합의 정상 결과다 — dmctl run attach 가
			// 같은 복귀를 관측해 먼저 기록했다. 둘은 같은 답에 도달한다.
			if !errors.Is(err, run.ErrMemberAttached) {
				dmlog.Errorf(nil, "[run] 탭 결속 기록 실패 member=%s: %v", m.ID, err)
			}
			return
		}
		s.markWorkspaceRun(rec, tabID, rec.ID)
		dmlog.Infof(nil, "[run] 탭 결속 반영 run=%s member=%s tool=%s tab=%s",
			rec.ID, updated.ID, toolID, tabID)
	}()
}

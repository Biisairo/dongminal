// 묶음 S — 상태·대기 계약의 서버측 절반이다 (RUN_ORCHESTRATION_SRS §3.2).
//
// 활동 상태(working/waiting/done/idle)는 이미 에이전트 훅이 보고해 서버 메모리에
// 있었지만(AAP), 읽을 수 있는 것은 브라우저뿐이었다. 그 결손이 team 스킬을 화면
// 스크래핑으로 내몰았고, 그 판정은 waiting(권한 확인 대기)을 준비완료로 오인한다.
// 여기서 두 엔드포인트로 그 경로를 연다 — 조회(get)와 대기(wait).
//
// 대기는 서버가 붙잡는다 (FR-STA-3). 클라이언트가 sleep 루프를 돌지 않게 하는 것이
// 목적이며, 서버 내부는 짧은 주기로 재평가한다 — 정적 판정(FR-STA-4 3단계)은 이벤트가
// 아니라 "마지막 출력 이후 경과 시간"이라 시간축 재평가가 원리적으로 필요하다.
package server

import (
	"dongminal/internal/shared/toolhub"

	"net/http"
	"strconv"
	"time"

	"dongminal/internal/shared/agentadapter"
)

const (
	// activityStateUnknown 은 "훅이 한 번도 보고하지 않았다"이며 오류가 아니다.
	activityStateUnknown = "unknown"

	// readyQuietMS: 훅 상태가 없을 때 준비완료로 볼 출력 정적 구간 (FR-STA-4 3단계).
	readyQuietMS = 3000

	waitDefaultTimeoutMS = 300_000   // 5분 (FR-STA-2)
	waitMaxTimeoutMS     = 1_800_000 // 30분 (FR-STA-2)
	waitMinTimeoutMS     = 100

	// 상태 재평가는 메모리 읽기라 촘촘해도 싸다.
	waitPollInterval = 100 * time.Millisecond
	// liveness 는 daemon 모드에서 데몬 RPC 다 (toolclient.ToolClient.Get → list). 매 tick
	// 확인하면 30분 대기가 RPC 수만 건이 된다 — L2 idle 스위퍼와 같은 1초 주기로
	// 낮춘다 (NFR-RUN-4).
	waitLivenessInterval = 1 * time.Second
)

// toolStatus 는 도구 하나의 에이전트 상태 관측이다. state 는 훅이 보고한 값이며,
// quietMs 는 마지막 출력 이후 경과(ms)로 -1 은 "출력을 관측한 적이 없다"이다.
type toolStatus struct {
	ToolID       string `json:"toolId"`
	Live         bool   `json:"live"`
	State        string `json:"state"`
	Tool         string `json:"tool,omitempty"`
	Detail       string `json:"detail,omitempty"`
	UpdatedAt    int64  `json:"updatedAt"`
	LastOutputAt int64  `json:"lastOutputAt"`
	QuietMs      int64  `json:"quietMs"`
}

// waitResult 는 대기의 결말이다. status 는 ready|done|blocked|timeout|gone 이고,
// timeout 은 실패가 아니라 체크포인트다 (FR-STA-6) — 그래서 마지막 관측을 함께 싣는다.
type waitResult struct {
	toolStatus
	Status    string `json:"status"`
	Reason    string `json:"reason,omitempty"`
	WaitedMs  int64  `json:"waitedMs"`
	TimeoutMs int64  `json:"timeoutMs"`
}

// toolActivity reads the hook-reported activity. Daemon mode keeps it in the
// AttnTracker (dongminald owns the PTY, dongminal owns the observation);
// direct mode keeps it on the toolhub.Tool itself.
func (s *Server) toolActivity(toolID string) *toolhub.ActivityState {
	if s.AttnTracker != nil {
		return s.AttnTracker.Activity(toolID)
	}
	if s.Tools != nil {
		if p := s.Tools.Get(toolID); p != nil {
			return p.Activity()
		}
	}
	return nil
}

// toolLastOutputAt reports the last observed output time in unix nanos, 0 when
// no output was ever observed. Mode split mirrors toolActivity.
func (s *Server) toolLastOutputAt(toolID string) int64 {
	if s.AttnTracker != nil {
		return s.AttnTracker.LastOutputAt(toolID)
	}
	if s.Tools != nil {
		if p := s.Tools.Get(toolID); p != nil {
			return p.LastOutputAt.Load()
		}
	}
	return 0
}

// toolLive probes liveness. In daemon mode this is an RPC, so callers that
// repeat it must rate-limit (see waitLivenessInterval).
func (s *Server) toolLive(toolID string) bool {
	return s.ToolIO != nil && s.ToolIO.Has(toolID)
}

// toolStatusOf assembles the observation. live is passed in so a repeating
// caller can probe it on its own cadence.
func (s *Server) toolStatusOf(toolID string, live bool) toolStatus {
	st := toolStatus{
		ToolID:  toolID,
		Live:    live,
		State:   activityStateUnknown,
		QuietMs: -1,
	}
	if a := s.toolActivity(toolID); a != nil {
		st.State, st.Tool, st.Detail, st.UpdatedAt = a.State, a.Tool, a.Detail, a.UpdatedAt
	}
	if last := s.toolLastOutputAt(toolID); last > 0 {
		st.LastOutputAt = last
		st.QuietMs = (time.Now().UnixNano() - last) / int64(time.Millisecond)
	}
	return st
}

// quiescenceAllowed reports whether the static fallback (FR-STA-4 3단계) may
// decide readiness for this tool.
//
// **훅으로 준비완료를 말하는 에이전트에는 쓰지 않는다.** 실측으로 밟은 결함이다 —
// Claude Code 멤버가 폴더 신뢰 확인 모달에 막혀 있는 동안 화면은 조용하고
// (quietMs=21023) 훅은 아무것도 보고하지 않아(state=unknown), 폴백이 그 상태를
// 준비완료로 오인해 `wait --for ready` 가 waitedMs=0 으로 성공을 냈다. 거기서
// Kickoff 를 보내면 모달이 삼킨다. 시작 모달은 시간이 지난다고 풀리지 않으므로,
// 훅을 주는 에이전트는 훅을 기다리다 타임아웃(체크포인트)으로 돌아가는 편이 정직하다.
//
// 어떤 에이전트가 도는지는 Run 멤버 기록이 안다. 멤버가 아닌 도구는 알 수 없으므로
// 기존 동작(폴백 허용)을 유지한다 — Run 을 쓰지 않는 경로는 전후가 같다 (NFR-RUN-1).
func (s *Server) quiescenceAllowed(toolID string) bool {
	if s.Runs == nil {
		return true
	}
	m, ok := s.Runs.MemberByTool(toolID)
	if !ok {
		return true
	}
	ad, err := agentadapter.Get(m.Agent)
	if err != nil {
		return true
	}
	return !ad.Readiness.Hooks
}

// evaluateWait applies the readiness ladder (FR-STA-4) and the blocked rule
// (FR-STA-5). It returns settled=false while the caller should keep waiting.
//
// 사다리의 2단계(어댑터가 선언한 준비완료 화면 패턴)는 여기 비어 있다 —
// 스펙에는 남아 있으나 구현을 보류했다. 화면 패턴은 사용자가 하단 스테이터스라인
// 하나만 붙여도 깨지며, FR-SKL-2 가 스킬에서 삭제하려는 fingerprint 와 같은
// 취약성이기 때문이다.
//
// allowQuiescence 는 3단계 적용 여부이며 출처는 어댑터 선언이다
// (quiescenceAllowed 참조).
func evaluateWait(cond string, st toolStatus, allowQuiescence bool) (status, reason string, settled bool) {
	if !st.Live {
		return "gone", "tool 이 사라졌다", true
	}
	switch st.State {
	case "waiting":
		// 권한 확인 대기는 시간이 지난다고 풀리지 않는다. 매달리지 말고 알린다.
		return "blocked", "waiting", true
	case "idle":
		if cond == "ready" {
			return "ready", "hook", true
		}
	case "done":
		if cond == "ready" {
			return "ready", "hook", true
		}
		return "done", "hook", true
	}
	// 정적 폴백은 ready 전용이다 — 침묵은 완료의 근거가 아니다.
	if allowQuiescence && cond == "ready" && st.State == activityStateUnknown && st.QuietMs >= readyQuietMS {
		return "ready", "quiescence", true
	}
	return "", "", false
}

// apiToolStatus implements GET /api/tools/activity/get?id= (FR-STA-1).
func (s *Server) apiToolStatus(w http.ResponseWriter, r *http.Request) {
	if !s.toolIOReady(w) {
		return
	}
	toolID, ok := s.resolveToolID(w, r.URL.Query().Get("id"))
	if !ok {
		return
	}
	writeJSON(w, s.toolStatusOf(toolID, s.toolLive(toolID)))
}

// apiToolStatusWait implements GET /api/tools/activity/wait?id=&for=&timeoutMs=
// (FR-STA-2/3). It holds the request until the condition settles or the
// timeout elapses; every outcome is a 200 whose `status` names the result.
func (s *Server) apiToolStatusWait(w http.ResponseWriter, r *http.Request) {
	if !s.toolIOReady(w) {
		return
	}
	cond := r.URL.Query().Get("for")
	if cond != "ready" && cond != "done" {
		writeToolIOError(w, http.StatusBadRequest, "for 는 ready 또는 done 이어야 한다: "+cond)
		return
	}
	timeoutMS := int64(waitDefaultTimeoutMS)
	if v := r.URL.Query().Get("timeoutMs"); v != "" {
		parsed, err := strconv.ParseInt(v, 10, 64)
		if err != nil {
			writeToolIOError(w, http.StatusBadRequest, "timeoutMs 는 정수여야 한다: "+v)
			return
		}
		timeoutMS = parsed
	}
	// 클램프는 조용하지 않다 — 유효값을 응답에 실어 호출자가 알 수 있게 한다.
	if timeoutMS < waitMinTimeoutMS {
		timeoutMS = waitMinTimeoutMS
	}
	if timeoutMS > waitMaxTimeoutMS {
		timeoutMS = waitMaxTimeoutMS
	}
	toolID, ok := s.resolveToolID(w, r.URL.Query().Get("id"))
	if !ok {
		return
	}

	start := time.Now()
	deadline := start.Add(time.Duration(timeoutMS) * time.Millisecond)
	ticker := time.NewTicker(waitPollInterval)
	defer ticker.Stop()
	// 폴백 적용 여부는 대기 중에 바뀌지 않는다 — 루프 밖에서 한 번만 정한다.
	allowQuiescence := s.quiescenceAllowed(toolID)
	// resolveToolID 가 방금 liveness 를 증명했다.
	live, liveCheckedAt := true, time.Now()
	for {
		if time.Since(liveCheckedAt) >= waitLivenessInterval {
			live, liveCheckedAt = s.toolLive(toolID), time.Now()
		}
		st := s.toolStatusOf(toolID, live)
		if status, reason, settled := evaluateWait(cond, st, allowQuiescence); settled {
			writeWaitResult(w, st, status, reason, start, timeoutMS)
			return
		}
		if !time.Now().Before(deadline) {
			writeWaitResult(w, st, "timeout", "", start, timeoutMS)
			return
		}
		select {
		case <-r.Context().Done():
			// 호출자가 끊었다. 응답할 상대가 없다.
			return
		case <-ticker.C:
		}
	}
}

func writeWaitResult(w http.ResponseWriter, st toolStatus, status, reason string, start time.Time, timeoutMS int64) {
	writeJSON(w, waitResult{
		toolStatus: st,
		Status:     status,
		Reason:     reason,
		WaitedMs:   time.Since(start).Milliseconds(),
		TimeoutMs:  timeoutMS,
	})
}

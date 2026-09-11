package httpapi

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strings"
	"sync"
	"time"

	"dongminal/internal/webserver/domain/run"
)

// 묶음 C — 컨텍스트 예산과 승계 (ORCHESTRATION_V2_SRS FR-CBG-*).
//
// 설계 원칙: **감지는 서버가, 판단은 에이전트가.** 서버는 등급과 경고까지만 낸다.
// 멤버를 교체할지는 조정자가 정하고 절차도 조정자가 부른다 — RUN_ORCHESTRATION_SRS
// §2.5 "조정자는 서버의 스케줄러가 아니라 에이전트다" 를 그대로 잇는다.
//
// 그래서 이 파일에는 자동 교체가 없다. critical 을 본 서버가 할 수 있는 일은
// 조정자에게 한 번 말하는 것뿐이고, 그 뒤에 무엇을 할지는 조정자가 정한다.

// handoffWaitDefault 는 `run succeed` 가 인수인계 요약을 기다리는 기본 상한이다.
// 조정자가 --timeout-ms 로 줄이거나 늘린다. 무한정 기다리지 않는 이유는
// 승계당하는 멤버가 이미 응답 능력을 잃었을 수 있기 때문이다 — 그것이 애초에
// 승계하는 이유다 (V-CBG-7).
//
// UX_BATCH6_SRS FR-RUN-3: **180초다.**
//
//	이전 동작: 30초
//	새  동작: 180초
//	이유:     에이전트가 인수인계 요약을 쓰는 데 걸리는 시간이 30초보다 길다.
//	          그래서 이 시한은 거의 언제나 초과됐고, 승계는 늘 "요약 없음" 으로
//	          끝났다 — 접수 ⑫("승계 문서가 버려진다")의 절반이 그것이다
//
// 나머지 절반은 시한을 늘려도 남는다. 그쪽은 FR-RUN-4 가 맡는다 — 늦게 온 요약도
// 후임의 프리앰블에 실린다.
const handoffWaitDefault = 180 * time.Second

// handoffPreambleWait 는 **프리앰블이** 늦은 요약을 기다리는 상한이다 (FR-RUN-4).
//
// 승계보다 짧다. 여기 오기까지 이미 승계의 시한만큼 기다렸으므로, 같은 길이를 한
// 번 더 주면 조정자의 한 명령이 6분을 먹는다.
const handoffPreambleWait = 90 * time.Second

// handoffPollInterval 은 요약이 도착했는지 되짚어 보는 간격이다.
const handoffPollInterval = 250 * time.Millisecond

// contextNotices 는 이미 보낸 컨텍스트 통지를 기억한다 (FR-CBG-7, SRS §3.3.2).
//
// 같은 멤버·같은 등급에 통지는 한 번뿐이다. 등급은 단조가 아니라 내려갈 수
// 있으므로 ratio 가 떨어졌다 다시 올라오면 저장소는 그것을 **전이로 감지한다.**
// 두 번째부터 알리지 않게 막는 것이 여기다 — 조정자의 컨텍스트를 서버가
// 오염시키면 본말전도다.
//
// 뮤텍스로 지키고 **쓰기 경로를 claim 하나로 모은다** (SRS §3.3.2).
//
// **영속하지 않는 이유**: 열린 Run 은 서버 재기동을 넘지 못한다. epoch 펜싱이
// 이전 incarnation 의 열린 Run 을 전부 aborted 로 만들기 때문이다 (FR-RUN-5).
// 기억의 수명이 Run 의 수명과 정확히 같으므로 Member 에 필드를 늘리지 않는다.
type contextNoticeLog struct {
	mu   sync.Mutex
	sent map[string]bool // memberID + "/" + level
}

// claim 은 이 (멤버, 등급) 조합의 통지 권한을 한 번만 내준다. 두 번째부터는
// 거짓이다.
func (l *contextNoticeLog) claim(memberID, level string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	key := memberID + "/" + level
	if l.sent[key] {
		return false
	}
	l.sent[key] = true
	return true
}

var contextNotices = &contextNoticeLog{sent: map[string]bool{}}

// contextPolicy 는 추정 공식과 임계를 설정에서 읽는다 (FR-CBG-2). 설정이 없거나
// 읽히지 않으면 기본값이다 — 관측 층의 설정 문제로 Run 이 멈추면 안 된다.
//
// settings.json 은 서버가 해석하지 않는 blob 이므로(handlers_settings.go) 여기서
// 필요한 가지만 꺼내 본다. 없는 키는 없는 대로 두고, run.ContextPolicy 가
// 기본값으로 메운다.
func (s *Server) contextPolicy() run.ContextPolicy {
	if s.Settings == nil {
		return run.DefaultContextPolicy()
	}
	var cfg struct {
		Orchestration struct {
			ContextBytesPerToken float64 `json:"contextBytesPerToken"`
			ContextLimitTokens   float64 `json:"contextLimitTokens"`
			ContextWarnRatio     float64 `json:"contextWarnRatio"`
			ContextCriticalRatio float64 `json:"contextCriticalRatio"`
		} `json:"orchestration"`
	}
	if err := json.Unmarshal(s.Settings.get(), &cfg); err != nil {
		return run.DefaultContextPolicy()
	}
	o := cfg.Orchestration
	return run.ContextPolicy{
		BytesPerToken: o.ContextBytesPerToken,
		LimitTokens:   o.ContextLimitTokens,
		WarnRatio:     o.ContextWarnRatio,
		CriticalRatio: o.ContextCriticalRatio,
	}
}

// apiRunContext implements POST /api/runs/context — 컨텍스트 관측 수신 (FR-CBG-2/3).
//
// activity/set 에 필드를 붙이지 않고 전용 경로를 둔 이유: 컨텍스트 관측은
// activity(지금 무엇을 하는가)와 **직교하는 레이어**이고, activity 핸들러는
// 다른 워크스트림의 파일이다.
//
// 받는 것은 **숫자와 식별자뿐**이다 — transcript 의 크기·세션 id·압축 여부.
// 내용은 어떤 경로로도 서버에 오지 않는다 (NFR-4). 이를 고정하는 테스트를 둔다.
//
// 발신 도구가 멤버가 아니면 조용히 200 이다. 이 훅은 Run 과 무관한 claude
// 전부에서 돌기 때문에, 멤버가 아닌 것은 오류가 아니라 정상이다.
func (s *Server) apiRunContext(w http.ResponseWriter, r *http.Request) {
	if !s.runsReady(w) {
		return
	}
	var body struct {
		ToolID string `json:"toolId"`
		// Bytes 는 포인터다. 재지 못한 것과 0 바이트를 구분해야 하고, 그 구분이
		// 곧 "모른다" 와 "괜찮다" 의 구분이다 (FR-CBG-5).
		Bytes     *int64 `json:"bytes"`
		SessionID string `json:"sessionId"`
		Compacted bool   `json:"compacted"`
		// UX_BATCH6_SRS FR-CTX-1·5: 실측 토큰과 그것을 낸 모델. Bytes 와 같은
		// 규약으로 포인터다 — 재지 못한 것과 0 을 가른다.
		Tokens *int64 `json:"tokens"`
		Model  string `json:"model"`
	}
	if !decodeJSONBody(w, r, &body) {
		return
	}
	obs := run.ContextObservation{
		SessionID: body.SessionID, Compacted: body.Compacted, Model: body.Model,
	}
	if body.Bytes != nil && *body.Bytes >= 0 {
		obs.Bytes, obs.HasBytes = *body.Bytes, true
	}
	if body.Tokens != nil && *body.Tokens >= 0 {
		obs.Tokens, obs.HasTokens = *body.Tokens, true
	}
	sender := s.callerToolID(r, body.ToolID)
	m, entered, found := s.Runs.ObserveContext(sender, obs, s.contextPolicy())
	if !found {
		writeJSON(w, map[string]any{"observed": false})
		return
	}
	// 기록은 이미 갱신됐다. 통지가 실패해도 그 사실은 남는다 (FR-CBG-8).
	//
	// ALERT_MOBILE_CONTEXT_SRS FR-RCX-10 / D-14: 조정자 관측은 `entered` 를 내지
	// 않으므로 이 갈래를 지나지 않는다. 조정자 자신의 등급을 조정자에게 알리면
	// 그 통지가 조정자의 컨텍스트를 더 먹는다.
	if entered != "" {
		s.notifyContextAlert(m, entered)
	}
	// FR-RCX-6·7: 멤버가 아니라 **조정자 자리**에 앉은 관측은 멤버 id 가 없다.
	// 빈 문자열을 내는 대신 그 사실을 말한다 — 받는 쪽이 "멤버를 못 찾았다" 와
	// 구분할 수 있어야 한다.
	out := map[string]any{
		"observed": true, "level": m.ContextLevel,
		"ratio": m.ContextRatio, "compactCount": m.CompactCount, "entered": entered,
		// FR-CTX-5·8: 무엇을 무엇으로 나눈 값인지 함께 낸다 — 비율만 보이면
		// "200k 로 재는가" 를 화면에서도 CLI 에서도 물을 수 없다.
		"tokens": m.ContextTokens, "limit": m.ContextLimit,
	}
	if m.ID == "" {
		out["coordinator"] = true
		out["runId"] = m.RunID
	} else {
		out["memberId"] = m.ID
	}
	writeJSON(w, out)
}

// notifyContextAlert 는 등급 전이를 조정자에게 한 번 알린다 (FR-CBG-6).
//
// 발신자는 `dongminal-server` 다. 사람이 보낸 것처럼 꾸미지 않는다 — 조정자가
// 이것이 관측 층의 기계적 통보임을 알아야 판단을 자기 것으로 유지한다.
//
// 조정자 도구가 죽었거나 없으면 **건너뛴다** (FR-CBG-8). 통지 실패가 Run 상태를
// 바꾸지 않으며 오류로도 새지 않는다 — 관측이 팀을 멈추게 하면 본말전도다.
//
// 등급은 내려갈 수 있으므로 같은 등급에 두 번 오르는 일이 있다. 그때 두 번
// 알리지 않게 막는 것이 contextNotices 다 (FR-CBG-7). 통지 기회는 등급마다 한
// 번이며, 조정자가 죽어 건너뛴 경우에도 소진된다 — 건너뛴 사실은 로그에 남고
// 레코드는 그대로 갱신된다 (FR-CBG-8).
func (s *Server) notifyContextAlert(m run.Member, level string) {
	if s.Runs == nil || s.ToolIO == nil {
		return
	}
	if !contextNotices.claim(m.ID, level) {
		return
	}
	rec, ok := s.Runs.Get(m.RunID)
	if !ok || rec.CoordinatorToolID == "" {
		return
	}
	if !s.ToolIO.Has(rec.CoordinatorToolID) {
		log.Printf("[run] context-alert 생략 run=%s member=%s level=%s — 조정자 도구가 없다",
			rec.Short, m.ID, level)
		return
	}
	body := fmt.Sprintf(
		"[CONTEXT-ALERT run=%s member=%s role=%s level=%s]\n%s\n승계: dmctl run succeed --member %s --at <새 탭 uuid> | --headless",
		rec.Short, m.ID, m.Role, level, contextAlertAdvice(m, level), m.ID)
	envelope := fmt.Sprintf(
		"[DONGMINAL-AGENT-MSG from=dongminal-server to=%s ts=%s]\n%s\n[/DONGMINAL-AGENT-MSG]",
		rec.CoordinatorToolID, time.Now().Format("15:04:05"), body)
	if err := s.ToolIO.SendPaste(rec.CoordinatorToolID, []byte(envelope), true); err != nil {
		// 통지 실패는 로그로 끝난다. Run 은 그대로 살아 있다.
		log.Printf("[run] context-alert 전달 실패 run=%s member=%s: %v", rec.Short, m.ID, err)
		return
	}
	log.Printf("[run] context-alert run=%s member=%s role=%s level=%s ratio=%.2f compact=%d",
		rec.Short, m.ID, m.Role, level, m.ContextRatio, m.CompactCount)
}

// contextAlertAdvice 는 통지 본문 한 줄이다. **추정임을 반드시 드러낸다**
// (NFR-CBG-3) — 조정자가 이 숫자를 측정값으로 믿고 멤버를 버리면 안 된다.
func contextAlertAdvice(m run.Member, level string) string {
	pct := int(m.ContextRatio*100 + 0.5)
	compact := ""
	if m.CompactCount > 0 {
		compact = fmt.Sprintf(" (압축 %d회)", m.CompactCount)
	}
	if level == run.LevelCritical {
		return fmt.Sprintf("추정 사용률 ~%d%%%s. 이 멤버에게 새 작업을 주지 마라. 승계를 검토해라.", pct, compact)
	}
	return fmt.Sprintf("추정 사용률 ~%d%%%s. 이 멤버에게 새 **큰** 작업을 주지 마라.", pct, compact)
}

// apiRunSucceed implements POST /api/runs/succeed (FR-CBG-9).
// 승계는 worktree 를 새로 만들지 않고 물려준다 (FR-CBG-11) — 진행 중인 작업이
// 거기 있다.
//
// 한 번의 호출로 다섯 단계를 수행한다: 인수인계 요청 → 대기(또는 시한 초과) →
// 새 멤버 생성 → 이전 멤버 succeeded → 사슬 기록. 이전 멤버의 Tool 은 **닫지
// 않는다** (FR-CBG-12).
func (s *Server) apiRunSucceed(w http.ResponseWriter, r *http.Request) {
	if !s.runsReady(w) || !s.toolIOReady(w) {
		return
	}
	var body struct {
		MemberID  string `json:"memberId"`
		At        string `json:"at"`
		Headless  bool   `json:"headless"`
		TimeoutMs int    `json:"timeoutMs"`
		ToolID    string `json:"toolId"`
	}
	if !decodeJSONBody(w, r, &body) {
		return
	}
	if strings.TrimSpace(body.MemberID) == "" {
		writeRunError(w, fmt.Errorf("%w: --member 는 필수다", run.ErrInvalidArgument), nil)
		return
	}
	if body.Headless && body.At != "" {
		writeRunError(w, fmt.Errorf("%w: --at 과 --headless 는 함께 쓸 수 없다", run.ErrInvalidArgument), nil)
		return
	}
	rec, prev, ok := s.runMember(w, body.MemberID)
	if !ok {
		return
	}
	if rec.State != run.Open {
		writeRunError(w, run.ErrRunClosed, nil)
		return
	}
	// 새 멤버가 들어앉을 도구를 확정한다 — 탭이 지목됐으면 그것을, --headless
	// 면 여기서 만든다 (FR-HLM-1 의 배타는 위에서 이미 걸렀다).
	//
	// **cwd 는 전임자의 자리다.** 승계는 worktree 를 새로 만들지 않고 물려받으므로
	// (FR-CBG-11) 격리 Run 이면 전임자의 트리가 그대로 새 멤버의 작업 위치다.
	// 격리가 없으면 전임자의 도구가 실제로 서 있던 디렉터리를 쓴다 — 헤드리스
	// 멤버에게는 cd 를 대신 쳐 줄 사람이 없고(FR-HLM-2), 잇는 일이 놓인 자리가
	// 곧 그 일을 이어받을 자리다. 전임자의 도구가 이미 죽었으면 빈 값이 되어
	// 서버 기본 cwd 로 떨어진다.
	toolID := ""
	if body.Headless {
		cwd := ""
		if prev.Worktree != nil && prev.Worktree.Path != "" {
			cwd = prev.Worktree.Path
		} else if s.Tools != nil {
			cwd = s.Tools.Cwd(prev.ToolID)
		}
		var err error
		if toolID, err = s.createHeadlessTool(cwd, ""); err != nil {
			writeToolIOError(w, http.StatusInternalServerError, "헤드리스 도구 생성 실패: "+err.Error())
			return
		}
	} else {
		var resolved bool
		if toolID, resolved = s.resolveToolID(w, body.At); !resolved {
			return
		}
	}

	// 1) 인수인계를 청한다. 이전 멤버가 이미 죽었으면 청할 곳이 없으므로
	//    곧바로 요약 없는 승계로 간다 (V-CBG-7).
	summary, asked := s.requestHandoff(rec, prev, body.TimeoutMs)

	// 2) 사슬을 잇는다. worktree 는 물려받고 새로 만들지 않는다.
	prevAfter, next, err := s.Runs.Succeed(run.SucceedSpec{
		PrevMemberID: prev.ID,
		ToolID:       toolID,
		TabID:        s.tabIDOfTool(toolID),
		Headless:     body.Headless,
		Summary:      summary,
		// FR-RUN-4: 청했는데 시한 안에 오지 않았다면 표식을 남긴다 — 후임의
		// 프리앰블이 그것을 기다린다.
		HandoffAsked: asked,
	})
	if err != nil {
		// 보상 삭제 — 우리가 만든 도구인데 승계가 거부되면 그 도구는 누구의 것도
		// 아니다. 탭에서 지목받은 도구는 원래 남의 것이므로 건드리지 않는다
		// (apiRunMemberAdd 와 같은 규약).
		if body.Headless && s.Tools != nil {
			// `GO-8`: 오류를 **명시로** 무시한다. 이 경로에서 "이미 없다" 는 정상이며
			// (목록이 앞서 걷혔거나 사용자가 두 번 눌렀다) 치울 것이 없다는 뜻이다.
			// 버리는 것과 판단한 것은 다르므로 그 사실을 여기 적어 둔다.
			_ = s.Tools.Delete(toolID)
			log.Printf("[run] headless 롤백 — 승계 실패: tool=%s", toolID)
		}
		writeRunError(w, err, nil)
		return
	}
	view := memberView{Member: next, State: s.deriveMemberState(next)}
	if cur, ok := s.Runs.Get(rec.ID); ok {
		s.markWorkspaceRun(cur, next.TabID, cur.ID)
		view.Preamble = run.Preamble(cur, next)
	}
	log.Printf("[run] succeed run=%s prev=%s next=%s role=%s tool=%s tab=%s summary=%v worktree=%v",
		rec.Short, prevAfter.ID, next.ID, next.Role, next.ToolID, next.TabID,
		prevAfter.HandoffSummary != "", next.Worktree != nil)
	writeJSON(w, map[string]any{
		"member":       view,
		"prevMemberId": prevAfter.ID,
		"prevState":    prevAfter.State,
		// hasSummary 는 조정자가 "인수인계가 실제로 있었나" 를 산문에서 읽지
		// 않아도 알게 한다. 없는 것은 없다고 말한다.
		"hasSummary": prevAfter.HandoffSummary != "",
	})
}

// requestHandoff 는 이전 멤버에게 인수인계 요약을 청하고 기다린다 (FR-CBG-9 의
// 1·2단계). 요약이 오지 않으면 빈 문자열이며, 그것은 실패가 아니라 **요약 없는
// 승계**다 — 응답 능력을 잃은 멤버를 교체하는 것이 승계의 본래 쓰임이다.
//
// 요청 문안은 서버가 조립한다. 이전 멤버는 `dmctl run handoff --summary -` 로
// 답하고, 그 응답이 저장소에 적히는 것을 여기서 되짚어 본다.
//
// 두 번째 값은 **청했는가**다 (UX_BATCH6_SRS FR-RUN-4). 청하지도 못한 것과 청했는데
// 늦는 것은 다르다 — 앞은 기다릴 이유가 없고, 뒤는 오는 중일 수 있다.
func (s *Server) requestHandoff(rec run.Record, prev run.Member, timeoutMs int) (string, bool) {
	baseline := prev.HandoffSummary
	if s.ToolIO == nil || !s.ToolIO.Has(prev.ToolID) {
		// 청할 상대가 없다. 이미 남겨 둔 요약이 있으면 그것을 쓴다.
		return baseline, false
	}
	ask := fmt.Sprintf(
		"[HANDOFF-REQUEST run=%s member=%s]\n"+
			"너는 곧 승계된다 — 같은 역할·같은 작업 트리의 새 멤버가 이 일을 이어받는다.\n"+
			"지금까지의 상태를 후임이 읽을 수 있게 남겨라. 무엇을 했는가 / 지금 어디까지\n"+
			"왔는가 / 다음에 무엇을 해야 하는가 / 알아야 할 함정. 아래를 한 번 실행한다.\n"+
			"dmctl run handoff --member %s --summary - <<'SUM'\n...본문...\nSUM",
		rec.Short, prev.ID, prev.ID)
	envelope := fmt.Sprintf(
		"[DONGMINAL-AGENT-MSG from=dongminal-server to=%s ts=%s]\n%s\n[/DONGMINAL-AGENT-MSG]",
		prev.ID, time.Now().Format("15:04:05"), ask)
	if err := s.ToolIO.SendPaste(prev.ToolID, []byte(envelope), true); err != nil {
		log.Printf("[run] handoff 요청 실패 run=%s member=%s: %v", rec.Short, prev.ID, err)
		return baseline, false
	}

	wait := handoffWaitDefault
	if timeoutMs > 0 {
		wait = time.Duration(timeoutMs) * time.Millisecond
	}
	deadline := time.Now().Add(wait)
	for {
		remaining := time.Until(deadline)
		if remaining <= 0 {
			break
		}
		// 남은 시간보다 오래 자지 않는다 — 아주 짧은 --timeout-ms 를 준 조정자가
		// 폴링 간격만큼 붙들리면 시한이 시한 노릇을 못 한다.
		if remaining > handoffPollInterval {
			remaining = handoffPollInterval
		}
		time.Sleep(remaining)
		if _, cur, ok := s.Runs.FindMember(prev.ID); ok && cur.HandoffSummary != baseline {
			return cur.HandoffSummary, true
		}
	}
	log.Printf("[run] handoff 시한 초과 run=%s member=%s wait=%s — 요약 없이 승계하고 기다림을 프리앰블로 넘긴다",
		rec.Short, prev.ID, wait)
	return baseline, true
}

// apiRunHandoff implements POST /api/runs/handoff (FR-CBG-9 의 1단계 응답).
// 발신자 정체 기반 권한을 따른다: 멤버는 자기 자신에 대해서만 쓸 수 있다.
func (s *Server) apiRunHandoff(w http.ResponseWriter, r *http.Request) {
	if !s.runsReady(w) {
		return
	}
	var body struct {
		MemberID string `json:"memberId"`
		ToolID   string `json:"toolId"`
		Summary  string `json:"summary"`
	}
	if !decodeJSONBody(w, r, &body) {
		return
	}
	sender := s.callerToolID(r, body.ToolID)
	m, err := s.Runs.Handoff(sender, body.MemberID, body.Summary)
	if err != nil {
		writeRunError(w, err, nil)
		return
	}
	log.Printf("[run] handoff run=%s member=%s tool=%s len=%d", m.RunID, m.ID, m.ToolID, len(m.HandoffSummary))
	writeJSON(w, map[string]any{"memberId": m.ID, "runId": m.RunID, "len": len(m.HandoffSummary)})
}

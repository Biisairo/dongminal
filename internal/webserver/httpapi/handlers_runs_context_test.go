package httpapi

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"dongminal/internal/webserver/domain/run"
)

// 묶음 C — 컨텍스트 예산과 승계의 서버 계층 (ORCHESTRATION_V2_SRS §3.3, V-CBG-*).

// ctxServer 는 조정자(tool-a)와 멤버(tool-b)가 있는 열린 Run 을 세운다.
// 승계용 빈 도구 tool-c 도 함께 등록해 둔다.
func ctxServer(t *testing.T) (*Server, *run.Store, *fakeToolIO, run.Record, run.Member) {
	t.Helper()
	s, _, _, _ := runsServer(t, "tool-a")
	io := s.ToolIO.(*fakeToolIO)

	// 저장소는 여기서 다시 세운다 — runs.json 이 어디에 쓰이는지 알아야
	// NFR-4 를 파일에서 직접 확인할 수 있다.
	storeDir := t.TempDir()
	store := run.NewStore(storeDir, "epoch-ctx")
	if err := store.Load(); err != nil {
		t.Fatalf("store load: %v", err)
	}
	s.Runs = store
	t.Setenv("DONGMINAL_TEST_RUNS_DIR", storeDir)
	wi := s.WorkIndex.(*fakeWorkIndex)
	io.setHas("tool-c", true)
	wi.resolve["tool-c"] = "tool-c"
	wi.resolve["tab-c"] = "tool-c"

	rec, err := store.Start(run.StartOptions{
		Objective: "장편 집필", Projection: run.DedicatedWindow,
		Isolation: run.IsolationPerMember, CoordinatorToolID: "tool-a",
	})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	m, err := store.AddMember(rec.ID, run.MemberSpec{
		Role: "작가", Agent: "claude", Brief: "1장을 쓴다", ToolID: "tool-b", TabID: "tab-b",
		Worktree: &run.Worktree{Path: "/tmp/wt/작가", Branch: "run/x/작가", Base: "main"},
	})
	if err != nil {
		t.Fatalf("AddMember: %v", err)
	}
	return s, store, io, rec, m
}

// bytesFor 는 기본 정책에서 원하는 사용률을 만드는 transcript 크기다.
func bytesFor(ratio float64) int64 {
	p := run.DefaultContextPolicy()
	return int64(ratio * p.LimitTokens * p.BytesPerToken)
}

// observe 는 컨텍스트 관측 한 건을 보낸다. 발신자는 멤버 도구다.
func observe(t *testing.T, s *Server, toolID string, bytes int64, compacted bool) map[string]any {
	t.Helper()
	who := s.WhoAmI.(*fakeWhoAmI)
	prev := who.toolID
	who.toolID = toolID
	defer func() { who.toolID = prev }()

	body := fmt.Sprintf(`{"toolId":%q,"bytes":%d,"compacted":%v}`, toolID, bytes, compacted)
	code, out := postRun(t, s, "/api/runs/context", body)
	if code != 200 {
		t.Fatalf("관측이 %d 로 거부됐다: %v", code, out)
	}
	return out
}

// alerts 는 조정자에게 간 CONTEXT-ALERT 엔벨로프만 골라낸다.
func alerts(io *fakeToolIO) []string {
	var out []string
	for _, p := range io.pastes {
		if strings.Contains(p.Text, "[CONTEXT-ALERT") {
			out = append(out, p.Text)
		}
	}
	return out
}

// V-CBG-4 (FR-CBG-6/7): warn 전이 1회, critical 전이 1회. 되돌아갔다 다시
// 올라와도 재통지하지 않는다 — 조정자의 컨텍스트를 서버가 오염시키면 본말전도다.
func TestApiRunContext_NotifiesOncePerLevel(t *testing.T) {
	s, _, io, rec, m := ctxServer(t)

	observe(t, s, "tool-b", bytesFor(0.20), false) // ok — 통지 없음
	if got := alerts(io); len(got) != 0 {
		t.Fatalf("ok 등급에 통지가 갔다: %v", got)
	}

	observe(t, s, "tool-b", bytesFor(0.75), false) // warn 진입
	observe(t, s, "tool-b", bytesFor(0.80), false) // 같은 등급 — 통지 없음
	observe(t, s, "tool-b", bytesFor(0.90), false) // critical 진입
	// **여기가 FR-CBG-7 의 핵심이다.** 등급은 내려가므로 ok 까지 떨어졌다 같은
	// 사다리를 다시 오를 수 있다. 저장소는 그 되오름을 전이로 **감지하지만**
	// 통지 계층이 막는다 — 조정자의 컨텍스트를 서버가 두 번 오염시키지 않는다.
	// 이 경로를 밟지 않으면 그 조항을 검증하는 테스트가 없어진다.
	if out := observe(t, s, "tool-b", bytesFor(0.50), false); out["level"] != run.LevelOK {
		t.Fatalf("등급은 현재 상태를 따라 내려가야 한다: %v", out)
	}
	if out := observe(t, s, "tool-b", bytesFor(0.78), false); out["entered"] != run.LevelWarn {
		t.Fatalf("warn 되오름이 전이로 감지되지 않았다: %v", out)
	}
	if out := observe(t, s, "tool-b", bytesFor(0.90), false); out["entered"] != run.LevelCritical {
		t.Fatalf("critical 되오름이 전이로 감지되지 않았다: %v", out)
	}

	got := alerts(io)
	if len(got) != 2 {
		t.Fatalf("통지는 멤버당 warn 1회·critical 1회가 상한이다: %d건\n%v", len(got), got)
	}
	if !strings.Contains(got[0], "level=warn") || !strings.Contains(got[1], "level=critical") {
		t.Fatalf("전이 순서가 어긋난다:\n%v", got)
	}
	for _, a := range got {
		// FR-CBG-6: 발신자는 dongminal-server 다. 사람이 보낸 것처럼 꾸미지 않는다.
		if !strings.Contains(a, "from=dongminal-server") {
			t.Fatalf("발신자가 서버로 표시되지 않았다:\n%s", a)
		}
		if !strings.Contains(a, "member="+m.ID) || !strings.Contains(a, "role=작가") {
			t.Fatalf("누구의 경고인지 알 수 없다:\n%s", a)
		}
		if !strings.Contains(a, "run="+rec.Short) {
			t.Fatalf("어느 Run 인지 알 수 없다:\n%s", a)
		}
		// NFR-CBG-3: 추정임이 드러나야 한다.
		if !strings.Contains(a, "~") || !strings.Contains(a, "추정") {
			t.Fatalf("측정값처럼 보이는 통지다:\n%s", a)
		}
		// 서버는 판단하지 않는다 — 승계 **명령을 안내**할 뿐 스스로 부르지 않는다.
		if !strings.Contains(a, "dmctl run succeed --member "+m.ID) {
			t.Fatalf("승계 경로가 안내되지 않았다:\n%s", a)
		}
	}
}

// V-CBG-2 (FR-CBG-4): PreCompact 는 크기와 무관하게 즉시 critical 이다.
func TestApiRunContext_CompactGoesCriticalImmediately(t *testing.T) {
	s, _, io, _, m := ctxServer(t)
	out := observe(t, s, "tool-b", bytesFor(0.05), true)
	if out["level"] != run.LevelCritical {
		t.Fatalf("압축 1회가 critical 을 만들지 않았다: %v", out)
	}
	if int(out["compactCount"].(float64)) != 1 {
		t.Fatalf("압축 횟수가 세어지지 않았다: %v", out)
	}
	got := alerts(io)
	if len(got) != 1 || !strings.Contains(got[0], "압축 1회") {
		t.Fatalf("압축 사실이 통지에 없다: %v", got)
	}
	_ = m
}

// V-CBG-5 (FR-CBG-8): 조정자 도구가 죽었으면 통지를 건너뛴다. **레코드는
// 갱신되고 오류도 나지 않는다** — 관측이 Run 을 멈추게 하면 안 된다.
func TestApiRunContext_DeadCoordinatorSkipsNotifyOnly(t *testing.T) {
	s, store, io, _, m := ctxServer(t)
	io.setHas("tool-a", false) // 조정자 도구가 죽었다

	out := observe(t, s, "tool-b", bytesFor(0.90), false)
	if out["level"] != run.LevelCritical {
		t.Fatalf("등급이 매겨지지 않았다: %v", out)
	}
	if got := alerts(io); len(got) != 0 {
		t.Fatalf("죽은 조정자에게 통지를 보냈다: %v", got)
	}
	_, cur, ok := store.FindMember(m.ID)
	if !ok || cur.ContextLevel != run.LevelCritical {
		t.Fatalf("통지가 생략됐다고 기록까지 빠졌다: %+v", cur)
	}
}

// FR-CBG-5: 멤버가 아닌 도구의 관측은 조용한 무동작이다. 이 훅은 Run 과 무관한
// claude 전부에서 돌기 때문에, 이것이 정상 경로다.
func TestApiRunContext_NonMemberIsQuietlyIgnored(t *testing.T) {
	s, _, io, _, _ := ctxServer(t)
	who := s.WhoAmI.(*fakeWhoAmI)
	who.toolID = "tool-c"
	code, out := postRun(t, s, "/api/runs/context", `{"toolId":"tool-c","bytes":999999}`)
	if code != 200 || out["observed"] != false {
		t.Fatalf("멤버가 아닌 관측이 오류가 됐다: %d %v", code, out)
	}
	if got := alerts(io); len(got) != 0 {
		t.Fatalf("멤버가 아닌데 통지가 갔다: %v", got)
	}
}

// **V-CBG-11 / NFR-4 — 서버 쪽 잠금장치.**
//
// 클라이언트가 보내지 않는 것만으로는 부족하다. 누가 무엇을 실어 보내든
// transcript 의 내용이 runs.json 에 **적히는 경로가 없어야** 한다. 관측 종단이
// 받아들이는 것은 숫자와 식별자뿐이며, 나머지는 통째로 버려진다.
func TestApiRunContext_TranscriptContentCannotReachTheRecord(t *testing.T) {
	s, store, _, _, m := ctxServer(t)
	const canary = "CANARY-SECRET-DO-NOT-PERSIST"
	who := s.WhoAmI.(*fakeWhoAmI)
	who.toolID = "tool-b"

	// 악의적이든 실수든, 본문을 실어 보내도 서버는 그것을 담지 않는다.
	body := fmt.Sprintf(`{"toolId":"tool-b","bytes":%d,"sessionId":"s-1",`+
		`"transcript":%q,"transcriptPath":%q,"text":%q,"detail":%q}`,
		bytesFor(0.75), canary, "/tmp/"+canary+".jsonl", canary, canary)
	code, out := postRun(t, s, "/api/runs/context", body)
	if code != 200 {
		t.Fatalf("관측이 거부됐다: %d %v", code, out)
	}
	// 숫자는 정상적으로 반영됐다 — 버려진 것은 본문뿐이다.
	_, cur, ok := store.FindMember(m.ID)
	if !ok || cur.ContextBytes != bytesFor(0.75) || cur.SessionID != "s-1" {
		t.Fatalf("숫자·식별자가 반영되지 않았다: %+v", cur)
	}

	blob, err := os.ReadFile(filepath.Join(os.Getenv("DONGMINAL_TEST_RUNS_DIR"), "runs.json"))
	if err != nil {
		t.Fatalf("runs.json: %v", err)
	}
	if strings.Contains(string(blob), canary) {
		t.Fatalf("transcript 내용이 기록에 남았다 (NFR-4):\n%s", blob)
	}
	// 응답으로도 새지 않는다.
	raw, _ := json.Marshal(out)
	if strings.Contains(string(raw), canary) {
		t.Fatalf("transcript 내용이 응답으로 샜다: %s", raw)
	}
}

// V-CBG-6 (FR-CBG-9/11/12): 격리 Run 의 승계. 새 멤버가 **같은 worktree 경로**를
// 쓰고, 이전 멤버는 succeeded 가 되며, 이전 멤버의 도구는 살아 있다.
func TestApiRunSucceed_InheritsWorktreeAndKeepsOldTool(t *testing.T) {
	s, store, io, _, m := ctxServer(t)

	// 이전 멤버가 요약을 남긴 뒤 승계한다.
	who := s.WhoAmI.(*fakeWhoAmI)
	who.toolID = "tool-b"
	if code, out := postRun(t, s, "/api/runs/handoff", `{"summary":"1장 초고까지 했다. 2장은 개요만 있다."}`); code != 200 {
		t.Fatalf("handoff: %d %v", code, out)
	}
	who.toolID = "tool-a"

	code, out := postRun(t, s, "/api/runs/succeed",
		fmt.Sprintf(`{"memberId":%q,"at":"tab-c","timeoutMs":1}`, m.ID))
	if code != 200 {
		t.Fatalf("succeed 가 %d 로 실패했다: %v", code, out)
	}
	if out["hasSummary"] != true {
		t.Fatalf("남겨 둔 요약이 쓰이지 않았다: %v", out)
	}
	if out["prevState"] != string(run.Succeeded) {
		t.Fatalf("이전 멤버가 succeeded 가 아니다: %v", out)
	}

	member := out["member"].(map[string]any)
	wt := member["worktree"].(map[string]any)
	if wt["path"] != "/tmp/wt/작가" {
		t.Fatalf("worktree 를 새로 만들었다: %v", wt)
	}
	if member["role"] != "작가" || member["brief"] != "1장을 쓴다" {
		t.Fatalf("역할·brief 를 물려받지 못했다: %v", member)
	}
	// FR-CBG-9: 프리앰블에 인수인계 절이 들어간다.
	pre, _ := member["preamble"].(string)
	if !strings.Contains(pre, "[인수인계]") || !strings.Contains(pre, "1장 초고까지 했다") {
		t.Fatalf("프리앰블에 인수인계가 없다:\n%s", pre)
	}
	if !strings.Contains(pre, "승계") {
		t.Fatalf("승계임이 프리앰블에 드러나지 않는다:\n%s", pre)
	}

	// FR-CBG-12: 이전 멤버의 도구는 자동 종료하지 않는다.
	if !io.Has("tool-b") {
		t.Fatal("이전 멤버의 도구가 종료됐다 — 인수인계를 다시 읽을 길이 사라진다")
	}
	// FR-CBG-11: 정리 대상 트리는 여전히 하나다.
	cur, _ := store.Get(m.RunID)
	if targets := cur.WorktreeTargets(); len(targets) != 1 {
		t.Fatalf("승계가 정리 대상을 늘렸다: %+v", targets)
	}
}

// V-CBG-7 (FR-CBG-9): 이전 멤버가 무응답이면 시한을 넘겨 **요약 없이** 승계하고,
// 프리앰블이 "요약 없음"을 명시한다. 없는 맥락을 있다고 가정하게 두지 않는다.
func TestApiRunSucceed_TimeoutSucceedsWithoutSummary(t *testing.T) {
	s, _, _, _, m := ctxServer(t)

	start := time.Now()
	code, out := postRun(t, s, "/api/runs/succeed",
		fmt.Sprintf(`{"memberId":%q,"at":"tab-c","timeoutMs":600}`, m.ID))
	if code != 200 {
		t.Fatalf("무응답 멤버의 승계가 실패했다: %d %v", code, out)
	}
	if elapsed := time.Since(start); elapsed > 5*time.Second {
		t.Fatalf("시한을 지키지 않았다: %s", elapsed)
	}
	if out["hasSummary"] != false {
		t.Fatalf("있지도 않은 요약이 있다고 보고됐다: %v", out)
	}
	pre, _ := out["member"].(map[string]any)["preamble"].(string)
	if !strings.Contains(pre, "요약 없음") {
		t.Fatalf("요약이 없다는 사실이 프리앰블에 없다:\n%s", pre)
	}
}

// FR-CBG-9 의 1·2단계: 승계는 이전 멤버에게 요약을 **청하고**, 기다리는 동안
// 도착한 응답을 물려준다.
func TestApiRunSucceed_WaitsForTheHandoffItAskedFor(t *testing.T) {
	s, _, io, _, m := ctxServer(t)

	go func() {
		time.Sleep(150 * time.Millisecond)
		who := s.WhoAmI.(*fakeWhoAmI)
		who.toolID = "tool-b"
		postRun(t, s, "/api/runs/handoff", `{"toolId":"tool-b","summary":"막 도착한 요약이다"}`)
		who.toolID = "tool-a"
	}()

	code, out := postRun(t, s, "/api/runs/succeed",
		fmt.Sprintf(`{"memberId":%q,"at":"tab-c","timeoutMs":4000}`, m.ID))
	if code != 200 {
		t.Fatalf("succeed: %d %v", code, out)
	}
	if out["hasSummary"] != true {
		t.Fatalf("기다리는 동안 도착한 요약을 놓쳤다: %v", out)
	}
	pre, _ := out["member"].(map[string]any)["preamble"].(string)
	if !strings.Contains(pre, "막 도착한 요약이다") {
		t.Fatalf("도착한 요약이 프리앰블에 실리지 않았다:\n%s", pre)
	}
	// 요청 문안은 서버가 조립해 이전 멤버에게 보낸다.
	var asked bool
	for _, p := range io.pastes {
		if p.ToolID == "tool-b" && strings.Contains(p.Text, "HANDOFF-REQUEST") {
			asked = true
			if !strings.Contains(p.Text, "dmctl run handoff") {
				t.Fatalf("응답 방법을 알려 주지 않았다:\n%s", p.Text)
			}
		}
	}
	if !asked {
		t.Fatal("이전 멤버에게 인수인계를 청하지 않았다")
	}
}

// FR-PRE-5 와 같은 규칙: 인수인계의 권한은 발신 도구의 정체다.
func TestApiRunHandoff_RejectsSomeoneElsesMemberID(t *testing.T) {
	s, store, _, rec, m := ctxServer(t)
	other, err := store.AddMember(rec.ID, run.MemberSpec{Role: "비평가", Agent: "claude", ToolID: "tool-c"})
	if err != nil {
		t.Fatalf("AddMember: %v", err)
	}
	who := s.WhoAmI.(*fakeWhoAmI)
	who.toolID = "tool-b"

	code, out := postRun(t, s, "/api/runs/handoff",
		fmt.Sprintf(`{"memberId":%q,"summary":"남의 몫"}`, other.ID))
	if code != 403 || out["error"] != "run_member_mismatch" {
		t.Fatalf("남의 memberId 가 통과했다: %d %v", code, out)
	}
	// 자기 자신은 통과한다.
	if code, out := postRun(t, s, "/api/runs/handoff",
		fmt.Sprintf(`{"memberId":%q,"summary":"내 몫"}`, m.ID)); code != 200 {
		t.Fatalf("자기 자신에 대한 인수인계가 막혔다: %d %v", code, out)
	}
	// 멤버가 아닌 도구는 거부된다.
	who.toolID = "tool-a"
	if code, out := postRun(t, s, "/api/runs/handoff", `{"summary":"조정자의 요약"}`); code != 403 {
		t.Fatalf("멤버가 아닌 발신자가 통과했다: %d %v", code, out)
	}
}

// FR-CBG-2: 임계는 settings.json 에서 온다. 하드코딩돼 있으면 여기서 걸린다.
func TestContextPolicy_ReadsSettings(t *testing.T) {
	s, _, _, _, _ := ctxServer(t)
	// 설정 저장소가 아예 없으면 기본값이다 — 관측 층의 설정 문제로 Run 이
	// 멈추면 안 된다.
	if got := s.contextPolicy(); got != run.DefaultContextPolicy() {
		t.Fatalf("설정이 없으면 기본값이어야 한다: %+v", got)
	}

	dir := t.TempDir()
	st := newSettingsStore(filepath.Join(dir, "settings.json"))
	st.set([]byte(`{"orchestration":{"contextWarnRatio":0.4,"contextCriticalRatio":0.6,` +
		`"contextBytesPerToken":4,"contextLimitTokens":1000}}`))
	s.Settings = st

	p := s.contextPolicy()
	if p.WarnRatio != 0.4 || p.CriticalRatio != 0.6 || p.BytesPerToken != 4 || p.LimitTokens != 1000 {
		t.Fatalf("설정이 반영되지 않았다: %+v", p)
	}
	// 2000바이트 = 500토큰 / 1000 = 0.5 → 설정된 warn(0.4) 구간이다.
	// 기본 임계(0.70)였다면 ok 가 나온다.
	if lv := p.Level(2000, 0); lv != run.LevelWarn {
		t.Fatalf("설정된 임계가 쓰이지 않았다: %q", lv)
	}

	// 망가진 설정은 기본값으로 되돌아간다 — 설정 오타가 Run 을 멈추면 안 된다.
	st.set([]byte(`{{{`))
	if got := s.contextPolicy(); got != run.DefaultContextPolicy() {
		t.Fatalf("깨진 설정이 기본값으로 회복되지 않았다: %+v", got)
	}
}

// ── FR-CBG-9 × FR-HLM-2: 헤드리스 승계 ────────────────────────────
//
// 이 경로는 묶음 H 의 도구 생성이 서기 전까지 501 이었다. 여는 것이 조정자의
// 잔여 판정이었고, 여기서 고정하는 것은 **어디에 서느냐**다 — 승계는 worktree 를
// 새로 만들지 않으므로(FR-CBG-11) 새 멤버는 전임자의 트리에서 시작해야 한다.
// `createHeadlessTool("")` 로 두면 조용히 서버 기본 cwd 에 서고, 헤드리스 멤버에게는
// 그것을 알아채고 cd 를 칠 사람이 없다.
func TestApiRunSucceed_HeadlessInheritsPredecessorWorktree(t *testing.T) {
	s, store, io, _, m := ctxServer(t)
	hub := newHeadlessHub(io)
	s.Tools = hub

	code, out := postRun(t, s, "/api/runs/succeed",
		fmt.Sprintf(`{"memberId":%q,"headless":true,"timeoutMs":1}`, m.ID))
	if code != 200 {
		t.Fatalf("헤드리스 승계가 %d 로 실패했다 (501 이면 분기가 안 열린 것이다): %v", code, out)
	}

	member := out["member"].(map[string]any)
	if member["headless"] != true {
		t.Fatalf("새 멤버가 헤드리스로 기록되지 않았다: %v", member)
	}
	if tab, _ := member["tabId"].(string); tab != "" {
		t.Fatalf("헤드리스 승계자에게 탭이 붙었다: %q", tab)
	}
	if out["prevState"] != string(run.Succeeded) {
		t.Fatalf("이전 멤버가 succeeded 가 아니다: %v", out)
	}

	// FR-CBG-11: 트리를 물려받는다 — 그리고 도구가 **그 트리 위에** 선다.
	wt := member["worktree"].(map[string]any)
	if wt["path"] != "/tmp/wt/작가" {
		t.Fatalf("worktree 를 새로 만들었다: %v", wt)
	}
	hub.mu.Lock()
	cwd, cols, rows := hub.lastCwd, hub.lastCols, hub.lastRows
	hub.mu.Unlock()
	if cwd != "/tmp/wt/작가" {
		t.Fatalf("cwd = %q — 전임자의 트리가 아니다. 헤드리스 멤버는 cd 를 칠 수 없다", cwd)
	}
	if cols != headlessCols || rows != headlessRows {
		t.Fatalf("크기 = %dx%d, want %dx%d", cols, rows, headlessCols, headlessRows)
	}

	// FR-HLM-2: 생성의 일부로 백그라운드에 등록된다 — 아니면 어디서도 닿을 수 없다.
	created, _, bg := hub.counts()
	if created != 1 || bg != 1 {
		t.Fatalf("created=%d background=%d, want 1/1", created, bg)
	}
	// FR-CBG-12: 이전 멤버의 도구는 살아 있다.
	if !io.Has("tool-b") {
		t.Fatal("이전 멤버의 도구가 종료됐다")
	}
	// 정리 대상 트리는 여전히 하나다 (FR-CBG-11).
	cur, _ := store.Get(m.RunID)
	if targets := cur.WorktreeTargets(); len(targets) != 1 {
		t.Fatalf("헤드리스 승계가 정리 대상을 늘렸다: %+v", targets)
	}
}

// 승계가 거부되면 방금 만든 헤드리스 도구를 되돌린다. 탭에서 지목받은 도구와
// 달리 이것은 **우리가 만든 것**이므로 남기면 아무의 것도 아닌 고아가 된다.
func TestApiRunSucceed_HeadlessRollsBackToolWhenSucceedFails(t *testing.T) {
	s, store, io, _, m := ctxServer(t)
	hub := newHeadlessHub(io)
	s.Tools = hub

	// 먼저 한 번 승계해 두면 그 멤버는 succeeded 가 되고, 같은 멤버를 다시
	// 승계하는 것은 저장소가 거부한다 — 도구를 만든 **뒤에** 실패하는 경로다.
	if code, out := postRun(t, s, "/api/runs/succeed",
		fmt.Sprintf(`{"memberId":%q,"headless":true,"timeoutMs":1}`, m.ID)); code != 200 {
		t.Fatalf("첫 승계가 실패했다: %d %v", code, out)
	}
	createdBefore, deletedBefore, bgBefore := hub.counts()

	code, out := postRun(t, s, "/api/runs/succeed",
		fmt.Sprintf(`{"memberId":%q,"headless":true,"timeoutMs":1}`, m.ID))
	if code == 200 {
		t.Fatalf("이미 승계된 멤버의 재승계가 통과했다: %v", out)
	}
	created, deleted, bg := hub.counts()
	if created != createdBefore+1 {
		t.Fatalf("도구가 만들어지지 않아 보상 삭제를 검증할 수 없다 (created=%d→%d)", createdBefore, created)
	}
	if deleted != deletedBefore+1 {
		t.Fatalf("보상 삭제가 일어나지 않았다 — 고아가 남는다 (deleted=%d→%d)", deletedBefore, deleted)
	}
	if bg != bgBefore {
		t.Fatalf("백그라운드에 고아가 남았다 (background=%d→%d)", bgBefore, bg)
	}
	// 기록에도 늘지 않는다.
	cur, _ := store.Get(m.RunID)
	if len(cur.Members) != 2 {
		t.Fatalf("실패한 승계가 멤버를 남겼다: %d명 %+v", len(cur.Members), cur.Members)
	}
}

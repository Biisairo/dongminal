package agentsess

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"dongminal/internal/shared/agentadapter"
	"dongminal/internal/shared/toolhub"
)

// M8_UNIFIED_SRS 묶음 B (P5) — 휴면·오류는 세션의 상태다 (D-C-11), 디스크 로그·스냅샷
// (D-C-12·13), 휴면 레코드와 되살림 (D-C-14), EvExit 의 사유 (D-C-15), 신원 없는 휴면 거절
// (D-C-16), 휴면 목록 (D-C-17). 어댑터는 session_test.go 의 장난감이다.

// newDiskMgr 는 DataDir 이 있는 관리자다 — 디스크 로그·agents.json 이 그 아래 선다.
func newDiskMgr(t *testing.T, dir string, cap int) (*Manager, *fakeSink) {
	t.Helper()
	f := &fakeSink{}
	m := New(Deps{Sink: f, Write: f.write, Snapshot: f.snapshot, LogCap: cap, DataDir: dir, ExitWait: 200 * time.Millisecond,
		Adapter: func(id string) (agentadapter.Adapter, error) {
			return agentadapter.Adapter{ID: id, Proto: fakeProto()}, nil
		}})
	return m, f
}

func pushLines(m *Manager, off *int64, lines ...string) {
	for _, l := range lines {
		*off += int64(len(l))
		feed(m, l, *off)
	}
}

// D-C-11·15 · FR-ABG-20: 프로세스가 죽어도 세션은 남는다 — 오류 상태, exit 이벤트가 사유를 든다.
func TestDormant_ExitBecomesError(t *testing.T) {
	m, f := newMgr(t)
	openFake(t, m)
	off := int64(0)
	pushLines(m, &off, `{"k":"init","sid":"s1"}`+"\n")
	m.Exit("tool-1", toolhub.ExitInfo{Code: 1, Stderr: []string{"401 unauthorized", "boom"}})
	s := m.Get("tool-1")
	if s == nil {
		t.Fatal("죽은 세션이 사라졌다 — 오류 상태로 남아야 한다 (D-C-11)")
	}
	st := s.State()
	if st.Dormant != DormantError || !st.Exited || !st.Resumable {
		t.Fatalf("상태: %+v", st)
	}
	last := f.events[len(f.events)-1].Ev
	if last.Kind != agentadapter.EvExit || last.Text != ExitDied || !last.IsError {
		t.Fatalf("exit 이벤트: %+v", last)
	}
	if !strings.Contains(last.Detail, "exit 1") || !strings.Contains(last.Detail, "boom") {
		t.Fatalf("사유에 exit code·stderr 꼬리: %q", last.Detail)
	}
	if f.activity[len(f.activity)-1] != "ended" {
		t.Fatalf("활동: %v", f.activity)
	}
	// 죽은 세션의 바이트는 여전히 이 층의 것이다(터미널 경로로 새지 않는다) — 그러나 해석하지 않는다.
	n := len(f.events)
	if !m.Feed("tool-1", []byte(`{"k":"txt","t":"late"}`+"\n"), off+30) || len(f.events) != n {
		t.Fatal("휴면 세션이 바이트를 해석했다")
	}
	if err := s.Prompt("x"); !errors.Is(err, ErrDormant) {
		t.Fatalf("휴면 중 프롬프트: %v", err)
	}
	// 두 번째 Exit 은 무해하다.
	m.Exit("tool-1", toolhub.ExitInfo{})
	if len(f.events) != n {
		t.Fatal("exit 이 두 번 남았다")
	}
}

// D-C-16: 신원 없는 도구는 휴면하지 않는다. D-C-15: 휴면 절차의 exit 은 hibernated 다.
func TestDormant_HibernateNeedsIdentityThenHibernates(t *testing.T) {
	m, f := newMgr(t)
	openFake(t, m)
	var stopped atomic.Int32
	stop := func() error { stopped.Add(1); return nil }
	if err := m.Hibernate("tool-1", stop); !errors.Is(err, ErrNoIdentity) || stopped.Load() != 0 {
		t.Fatalf("신원 없는 휴면: err=%v stopped=%d", err, stopped.Load())
	}
	off := int64(0)
	pushLines(m, &off, `{"k":"init","sid":"s1"}`+"\n")
	// 프로세스의 끝은 stop 뒤에 비동기로 온다 — toolhub 의 exit 관측자가 그것이다.
	done := make(chan error, 1)
	go func() { done <- m.Hibernate("tool-1", stop) }()
	waitFor(t, "stop", func() bool { return stopped.Load() == 1 })
	m.Exit("tool-1", toolhub.ExitInfo{Code: 0})
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	s := m.Get("tool-1")
	st := s.State()
	if st.Dormant != DormantHibernated || !st.Resumable || st.SessionID != "s1" {
		t.Fatalf("휴면 상태: %+v", st)
	}
	last := f.events[len(f.events)-1].Ev
	if last.Kind != agentadapter.EvExit || last.Text != ExitHibernated || last.IsError {
		t.Fatalf("exit 이벤트: %+v", last)
	}
	// 이미 휴면인 것을 다시 휴면하지 않는다.
	if err := m.Hibernate("tool-1", stop); !errors.Is(err, ErrDormant) {
		t.Fatalf("이중 휴면: %v", err)
	}
	// 휴면 목록에 있다 (D-C-17).
	d := m.Dormant()
	if len(d) != 1 || d[0].ID != "tool-1" || d[0].Kind != toolhub.KindAgent || d[0].Agent != "fake" || d[0].Dormant != DormantHibernated {
		t.Fatalf("휴면 목록: %+v", d)
	}
}

// 휴면 절차에서 exit 이 오지 않아도(옛 데몬·경합) 시한 뒤 휴면으로 마감한다.
func TestDormant_HibernateTimeoutFinalizes(t *testing.T) {
	m, _ := newDiskMgr(t, "", 8)
	openFake(t, m)
	off := int64(0)
	pushLines(m, &off, `{"k":"init","sid":"s1"}`+"\n")
	if err := m.Hibernate("tool-1", func() error { return nil }); err != nil {
		t.Fatal(err)
	}
	if st := m.Get("tool-1").State(); st.Dormant != DormantHibernated {
		t.Fatalf("시한 뒤 마감: %+v", st)
	}
}

// stop 이 실패하면 휴면하지 않는다 — 세션은 활성으로 남는다.
func TestDormant_HibernateStopFails(t *testing.T) {
	m, _ := newMgr(t)
	openFake(t, m)
	off := int64(0)
	pushLines(m, &off, `{"k":"init","sid":"s1"}`+"\n")
	boom := errors.New("boom")
	if err := m.Hibernate("tool-1", func() error { return boom }); !errors.Is(err, boom) {
		t.Fatalf("stop 실패: %v", err)
	}
	if st := m.Get("tool-1").State(); st.Dormant != "" {
		t.Fatalf("실패한 휴면이 상태를 바꿨다: %+v", st)
	}
}

// D-C-11: 재개는 같은 toolId 다 — 핸드셰이크가 Resume 을 싣고, 오프셋은 0 부터 다시, seq 는 이어진다.
func TestDormant_ReopenSameID(t *testing.T) {
	m, f := newMgr(t)
	s := openFake(t, m)
	off := int64(0)
	pushLines(m, &off, `{"k":"init","sid":"s1"}`+"\n", `{"k":"txt","t":"a"}`+"\n")
	m.Exit("tool-1", toolhub.ExitInfo{Code: 1})
	seqBefore := f.events[len(f.events)-1].Seq
	if err := m.Reopen("tool-1", agentadapter.LaunchOpts{Resume: "s1", Cwd: "/w"}); err != nil {
		t.Fatal(err)
	}
	if got := f.writes[len(f.writes)-1]; got != `{"hs":1,"resume":"s1"}` {
		t.Fatalf("재개 핸드셰이크: %v", f.writes)
	}
	st := s.State()
	if st.Dormant != "" || st.Exited || st.SessionID != "s1" || st.Cwd != "/w" {
		t.Fatalf("재개 뒤 상태: %+v", st)
	}
	// 새 프로세스의 스트림은 0 부터다 — 옛 오프셋(off) 보다 작은 end 가 틈으로 읽히면 안 된다.
	line := `{"k":"txt","t":"b"}` + "\n"
	feed(m, line, int64(len(line)))
	last := f.events[len(f.events)-1]
	if last.Ev.Kind != agentadapter.EvTextDelta || last.Ev.Text != "b" || last.Seq != seqBefore+1 {
		t.Fatalf("재개 뒤 첫 이벤트: %+v", last)
	}
	// 활성 세션은 Reopen 할 수 없다.
	if err := m.Reopen("tool-1", agentadapter.LaunchOpts{}); !errors.Is(err, ErrNotDormant) {
		t.Fatalf("활성 재개: %v", err)
	}
	if err := m.Reopen("nope", agentadapter.LaunchOpts{}); !errors.Is(err, ErrNoSession) {
		t.Fatalf("없는 세션 재개: %v", err)
	}
}

// D-C-13: 스냅샷은 버려진 이벤트의 접힘이다 — 열린 요청의 열림·닫힘, 마지막 메시지, 상태.
func TestDormant_SnapshotFold(t *testing.T) {
	m, _ := newMgr(t) // cap 8
	ad := agentadapter.Adapter{ID: "fake", Proto: fakeProto()}
	base := ad.Proto.Decode
	ad.Proto.Decode = func(line []byte, st *agentadapter.ProtoState) ([]agentadapter.Event, bool) {
		var fr struct{ K, ID, M string }
		json.Unmarshal(line, &fr)
		switch fr.K {
		case "msg":
			return []agentadapter.Event{{Kind: agentadapter.EvMessage, Message: json.RawMessage(`[{"type":"text","text":"` + fr.M + `"}]`)}}, true
		case "close":
			delete(st.Open, fr.ID)
			return []agentadapter.Event{{Kind: agentadapter.EvApprovalClosed, Approval: &agentadapter.ApprovalRequest{ID: fr.ID}}}, true
		case "use":
			return []agentadapter.Event{{Kind: agentadapter.EvUsage, Usage: &agentadapter.ProtoUsage{Tokens: 42}}}, true
		}
		return base(line, st)
	}
	s, err := m.Open("tool-1", ad, agentadapter.LaunchOpts{})
	if err != nil {
		t.Fatal(err)
	}
	off := int64(0)
	// 1 init · 2 req r1 · 3 msg m1 · 4 close r1 · 5 req r2 · 6 msg m2 · 7 use · 8..13 txt ×6 → 상한 8 이면 1..5 가 버려진다.
	pushLines(m, &off,
		`{"k":"init","sid":"s1"}`+"\n", `{"k":"req","id":"r1"}`+"\n", `{"k":"msg","m":"m1"}`+"\n", `{"k":"close","id":"r1"}`+"\n",
		`{"k":"req","id":"r2"}`+"\n", `{"k":"msg","m":"m2"}`+"\n", `{"k":"use"}`+"\n")
	for i := 0; i < 6; i++ {
		pushLines(m, &off, `{"k":"txt","t":"x"}`+"\n")
	}
	evs, trunc, snap := s.Replay(0)
	if !trunc || snap == nil || len(evs) != 8 || evs[0].Seq != 6 {
		t.Fatalf("재생: trunc=%v snap=%v n=%d", trunc, snap != nil, len(evs))
	}
	if snap.Seq != 5 || snap.SessionID != "s1" {
		t.Fatalf("스냅샷 경계: %+v", snap)
	}
	if string(snap.LastMessage) != `[{"type":"text","text":"m1"}]` {
		t.Fatalf("버려진 마지막 메시지는 m1 이다 (m2 는 남은 이벤트에 있다): %s", snap.LastMessage)
	}
	if len(snap.Open) != 1 || snap.Open[0].ID != "r2" {
		t.Fatalf("버려진 구간에서 r1 은 닫혔고 r2 는 열려 있다: %+v", snap.Open)
	}
	if snap.Usage.Tokens != 0 {
		t.Fatal("use(7) 는 버려지지 않았다 — 스냅샷에 들면 안 된다")
	}
	// 잘리지 않은 since 는 스냅샷이 없다.
	if _, trunc, snap := s.Replay(5); trunc || snap != nil {
		t.Fatal("since=5 는 빠진 것이 없다")
	}
}

func readLog(t *testing.T, dir, toolID string) (snaps int, seqs []int64) {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(dir, "agents", toolID+".jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	for _, l := range strings.Split(strings.TrimSpace(string(b)), "\n") {
		var row struct {
			Snap *Snapshot `json:"snap"`
			Seq  int64     `json:"seq"`
		}
		if json.Unmarshal([]byte(l), &row) != nil {
			t.Fatalf("줄 파싱: %s", l)
		}
		if row.Snap != nil {
			snaps++
		} else {
			seqs = append(seqs, row.Seq)
		}
	}
	return
}

// D-C-12: 디스크 로그는 이벤트마다 append 되고, 버려진 수가 상한에 이르면 스냅샷+링으로 압축된다.
// D-C-14: 재시동 뒤 레코드가 세션을 디스크 로그에서 되살린다 — 도구가 없으면 오류 상태.
func TestDisk_AppendCompactRestore(t *testing.T) {
	dir := t.TempDir()
	m, _ := newDiskMgr(t, dir, 4)
	openFake(t, m)
	off := int64(0)
	pushLines(m, &off, `{"k":"init","sid":"s1"}`+"\n")
	for i := 0; i < 5; i++ {
		pushLines(m, &off, `{"k":"txt","t":"x"}`+"\n")
	}
	// 6 이벤트, 상한 4 → 버려진 것 2, 아직 압축 전(append 그대로).
	if snaps, seqs := readLog(t, dir, "tool-1"); snaps != 0 || len(seqs) != 6 {
		t.Fatalf("append: snaps=%d seqs=%v", snaps, seqs)
	}
	for i := 0; i < 2; i++ {
		pushLines(m, &off, `{"k":"txt","t":"y"}`+"\n")
	}
	// 8 이벤트, 버려진 것 4 = 상한 → 압축: snap(seq 4) + 5..8.
	if snaps, seqs := readLog(t, dir, "tool-1"); snaps != 1 || len(seqs) != 4 || seqs[0] != 5 {
		t.Fatalf("압축: snaps=%d seqs=%v", snaps, seqs)
	}
	// 레코드가 있다.
	recs := loadRecords(filepath.Join(dir, "agents.json"))
	if len(recs) != 1 || recs["tool-1"].SessionID != "s1" || recs["tool-1"].Agent != "fake" || recs["tool-1"].Dormant != "" {
		t.Fatalf("레코드: %+v", recs)
	}

	// 재시동: 도구는 없다(직접 모드) → 오류 상태로 되살아나고 재생이 이어진다.
	m2, f2 := newDiskMgr(t, dir, 4)
	m2.Restore(func(string) bool { return false }, func(string) bool { return true })
	s := m2.Get("tool-1")
	if s == nil {
		t.Fatal("레코드에서 세션이 되살아나지 않았다")
	}
	st := s.State()
	if st.Dormant != DormantError || st.Reason != ReasonServerRestart || !st.Resumable || st.SessionID != "s1" || st.Agent != "fake" {
		t.Fatalf("되살린 상태: %+v", st)
	}
	evs, trunc, snap := s.Replay(0)
	if !trunc || snap == nil || snap.Seq != 4 || len(evs) != 4 || evs[0].Seq != 5 || evs[3].Seq != 8 {
		t.Fatalf("되살린 재생: trunc=%v snap=%v n=%d", trunc, snap != nil, len(evs))
	}
	if len(f2.events) != 0 {
		t.Fatal("되살림은 SSE 를 내지 않는다 — 브라우저는 재생으로 읽는다")
	}
	// 되살린 세션에서 재개하면 seq 가 이어진다.
	if err := m2.Reopen("tool-1", agentadapter.LaunchOpts{Resume: "s1"}); err != nil {
		t.Fatal(err)
	}
	line := `{"k":"txt","t":"z"}` + "\n"
	m2.Feed("tool-1", []byte(line), int64(len(line)))
	if last := f2.events[len(f2.events)-1]; last.Seq != 9 {
		t.Fatalf("seq 이어짐: %+v", last)
	}
	if recs := loadRecords(filepath.Join(dir, "agents.json")); recs["tool-1"].Dormant != "" {
		t.Fatalf("재개가 레코드에 반영되지 않았다: %+v", recs["tool-1"])
	}
}

// D-C-14: 신원 없는 레코드와 어느 탭도 참조하지 않는 레코드는 버린다; 살아 있는 도구는 Resume 으로 Open.
func TestDisk_RestoreAdoptsAndDrops(t *testing.T) {
	dir := t.TempDir()
	m, _ := newDiskMgr(t, dir, 8)
	ad := agentadapter.Adapter{ID: "fake", Proto: fakeProto()}
	for _, id := range []string{"alive", "orphan", "noid"} {
		if _, err := m.Open(id, ad, agentadapter.LaunchOpts{Cwd: "/c", Approval: "ask"}); err != nil {
			t.Fatal(err)
		}
	}
	line := `{"k":"init","sid":"S"}` + "\n"
	m.Feed("alive", []byte(line), int64(len(line)))
	m.Feed("orphan", []byte(line), int64(len(line)))

	m2, f2 := newDiskMgr(t, dir, 8)
	m2.Restore(func(id string) bool { return id == "alive" }, func(id string) bool { return id != "orphan" })
	if m2.Get("orphan") != nil || m2.Get("noid") != nil {
		t.Fatal("참조 없는 것·신원 없는 것이 남았다")
	}
	s := m2.Get("alive")
	if s == nil || s.State().Dormant != "" {
		t.Fatalf("살아 있는 도구는 활성으로 채택된다: %+v", s)
	}
	if got := strings.Join(f2.writes, " "); !strings.Contains(got, `"resume":"S"`) {
		t.Fatalf("채택 핸드셰이크는 Resume 을 싣는다 (codex rejoin): %v", f2.writes)
	}
	recs := loadRecords(filepath.Join(dir, "agents.json"))
	if len(recs) != 1 || recs["alive"].Cwd != "/c" || recs["alive"].Approval != "ask" {
		t.Fatalf("버린 레코드가 파일에 남았다 / 기동 옵션: %+v", recs)
	}
	if _, err := os.Stat(filepath.Join(dir, "agents", "orphan.jsonl")); !os.IsNotExist(err) {
		t.Fatal("버린 레코드의 로그가 남았다")
	}
}

// D-C-11·17: 닫기(Forget)만이 세션을 지운다 — 레코드·로그도 함께.
func TestDisk_Forget(t *testing.T) {
	dir := t.TempDir()
	m, f := newDiskMgr(t, dir, 8)
	openFake(t, m)
	line := `{"k":"init","sid":"s1"}` + "\n"
	m.Feed("tool-1", []byte(line), int64(len(line)))
	m.Forget("tool-1")
	if m.Get("tool-1") != nil || len(m.Dormant()) != 0 {
		t.Fatal("잊은 세션이 남았다")
	}
	if recs := loadRecords(filepath.Join(dir, "agents.json")); len(recs) != 0 {
		t.Fatalf("레코드가 남았다: %+v", recs)
	}
	if _, err := os.Stat(filepath.Join(dir, "agents", "tool-1.jsonl")); !os.IsNotExist(err) {
		t.Fatal("로그가 남았다")
	}
	// 그 뒤 오는 exit 은 무해하고 이벤트를 내지 않는다.
	n := len(f.events)
	m.Exit("tool-1", toolhub.ExitInfo{Code: 1})
	if len(f.events) != n {
		t.Fatal("잊은 세션의 exit 이 이벤트를 냈다")
	}
}

// 레코드는 신원·권한 모드가 바뀔 때 다시 쓰인다 — 재개 옵션의 근거다.
func TestDisk_RecordTracksIdentityAndMode(t *testing.T) {
	dir := t.TempDir()
	m, _ := newDiskMgr(t, dir, 8)
	ad := agentadapter.Adapter{ID: "fake", Proto: fakeProto()}
	base := ad.Proto.Decode
	ad.Proto.Decode = func(line []byte, st *agentadapter.ProtoState) ([]agentadapter.Event, bool) {
		switch strings.TrimSpace(string(line)) {
		case "reset":
			st.SessionID = "s2"
			return []agentadapter.Event{{Kind: agentadapter.EvReset, SessionID: "s2"}}, true
		case "plan":
			return []agentadapter.Event{{Kind: agentadapter.EvStatus, Status: &agentadapter.ProtoStatus{PermissionMode: "plan", Model: "m9"}}}, true
		}
		return base(line, st)
	}
	if _, err := m.Open("tool-1", ad, agentadapter.LaunchOpts{PermissionMode: "default"}); err != nil {
		t.Fatal(err)
	}
	off := int64(0)
	pushLines(m, &off, `{"k":"init","sid":"s1"}`+"\n")
	if r := loadRecords(filepath.Join(dir, "agents.json"))["tool-1"]; r.SessionID != "s1" || r.PermissionMode != "default" {
		t.Fatalf("첫 레코드: %+v", r)
	}
	pushLines(m, &off, "reset\n", "plan\n")
	r := loadRecords(filepath.Join(dir, "agents.json"))["tool-1"]
	if r.SessionID != "s2" || r.PermissionMode != "plan" || r.Model != "m9" {
		t.Fatalf("갱신된 레코드: %+v", r)
	}
	// 재개 옵션은 레코드에서 파생한다 — Model 은 싣지 않는다 (U-4).
	o := m.Get("tool-1").ResumeOpts()
	if o.Resume != "s2" || o.PermissionMode != "plan" || o.Model != "" {
		t.Fatalf("재개 옵션: %+v", o)
	}
}

func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("%s 를 기다리다 시한", what)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

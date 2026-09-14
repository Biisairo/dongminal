package agentsess

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"dongminal/internal/shared/agentadapter"
)

// histAdapter 는 한 줄이 곧 텍스트 이벤트 하나인 장난감 기록 형식이다.
// `#` 로 시작하는 줄은 살림살이다 — 대화가 아니다.
func histAdapter() agentadapter.Adapter {
	return agentadapter.Adapter{ID: "fake", Proto: fakeProto(),
		ParseHistory: func(line string) ([]agentadapter.Event, bool) {
			if line == "" || strings.HasPrefix(line, "#") {
				return nil, false
			}
			return []agentadapter.Event{{Kind: agentadapter.EvUser, Text: line}}, true
		}}
}

func writeLines(t *testing.T, lines []string) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), "t.jsonl")
	if err := os.WriteFile(p, []byte(strings.Join(lines, "\n")+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	return p
}

// V-M9-41 ② (FR-M9-41): **읽는 일의 분업.** 파일을 열고 꼬리를 자르는 것은 이 층이고,
// 한 줄의 뜻은 어댑터의 것이다 (FR-AAC-11 과 같은 규약).
func TestLoadHistory_ReadsTailAndMarksTheCut(t *testing.T) {
	ad := histAdapter()

	// ① 상한 안이면 전부 읽고 잘리지 않았다.
	h := LoadHistory(ad, writeLines(t, []string{"a", "#meta", "b"}), 1<<20)
	if !h.OK || h.Truncated || len(h.Events) != 2 ||
		h.Events[0].Text != "a" || h.Events[1].Text != "b" {
		t.Fatalf("꼬리 전부를 읽지 못했다: %+v", h)
	}

	// ② 상한을 넘으면 **꼬리만** 읽고 잘렸음을 말한다. 반 토막 난 첫 줄은 버린다 —
	// 해석하면 오답이 아니라 없는 내용이 된다.
	lines := make([]string, 0, 100)
	for i := 0; i < 100; i++ {
		lines = append(lines, strings.Repeat("x", 50))
	}
	lines[99] = "마지막"
	h = LoadHistory(ad, writeLines(t, lines), 200)
	if !h.OK || !h.Truncated {
		t.Fatalf("잘렸는데 그 사실을 말하지 않았다: %+v", h)
	}
	if len(h.Events) == 0 || h.Events[len(h.Events)-1].Text != "마지막" {
		t.Fatalf("꼬리를 읽지 않았다: %d개", len(h.Events))
	}
	if len(h.Events) > 5 {
		t.Fatalf("상한을 넘겨 읽었다: %d개", len(h.Events))
	}

	// ③ **부재는 선언이다** (FR-APS-4). 읽지 않는 어댑터 · 경로 없음 · 없는 파일 —
	// 셋 다 "읽지 못했다" 이며, 빈 기록과 다르다.
	plain := agentadapter.Adapter{ID: "fake", Proto: fakeProto()}
	if h := LoadHistory(plain, writeLines(t, []string{"a"}), 1<<20); h.OK {
		t.Fatalf("ParseHistory 가 없는 어댑터에서 읽었다고 했다: %+v", h)
	}
	if h := LoadHistory(ad, "", 1<<20); h.OK {
		t.Fatalf("경로가 없는데 읽었다고 했다: %+v", h)
	}
	if h := LoadHistory(ad, filepath.Join(t.TempDir(), "없다.jsonl"), 1<<20); h.OK {
		t.Fatalf("없는 파일을 읽었다고 했다: %+v", h)
	}
}

// V-M9-41 ② (FR-M9-41): **올린 세션은 빈 로그로 열리지 않는다.**
//
// 재는 것은 재생이다 — 기록을 심은 뒤 `Replay(0)` 이 그것을 내놓아야 화면이 찬다.
// 화면의 경로는 바뀌지 않는다 (기존 재생 경로를 그대로 탄다).
func TestOpenWithHistory_SeedsTheLogBeforeTheFirstFrame(t *testing.T) {
	m, f := newMgr(t)
	h := LoadHistory(histAdapter(), writeLines(t, []string{"과거1", "#meta", "과거2"}), 1<<20)
	s, err := m.OpenWithHistory("tool-1", histAdapter(), agentadapter.LaunchOpts{Resume: "s1"}, h)
	if err != nil {
		t.Fatal(err)
	}
	evs, truncated, _ := s.Replay(0)
	if truncated {
		t.Fatalf("잘리지 않았는데 잘렸다고 했다")
	}
	if len(evs) != 2 || evs[0].Ev.Text != "과거1" || evs[1].Ev.Text != "과거2" {
		t.Fatalf("기록이 재생되지 않았다: %s %+v", kindsOf(evs), evs)
	}
	// seq 는 1부터 이어진다 — 라이브 이벤트가 그 뒤를 잇는다.
	if evs[0].Seq != 1 || evs[1].Seq != 2 {
		t.Fatalf("seq 가 이어지지 않았다: %+v", evs)
	}
	if s.State().History != HistoryLoaded {
		t.Fatalf("기록을 읽었다는 사실이 상태에 없다: %q", s.State().History)
	}
	// **과거는 알람을 울리지 않는다.** 심은 이벤트에서 활동이 파생되면 이미 지난
	// 일로 지금의 상태가 덮이고, 사용자는 끝난 턴을 도는 중으로 본다.
	for _, a := range f.activity {
		if a != "" {
			t.Fatalf("기록이 활동을 파생했다: %v", f.activity)
		}
	}
	// 라이브 이벤트는 기록 **뒤에** 붙는다.
	live := `{"k":"txt","t":"지금"}` + "\n"
	feed(m, live, int64(len(live)))
	evs, _, _ = s.Replay(0)
	if len(evs) != 3 || evs[2].Ev.Text != "지금" || evs[2].Seq != 3 {
		t.Fatalf("라이브가 기록 뒤에 붙지 않았다: %+v", evs)
	}
}

// V-M9-41 ② (FR-M9-41 / FR-ABG-21): **잘렸으면 그 사실이 재생에 실린다.**
// 장치는 이미 있다 — `truncated` 는 브라우저가 "이전 기록은 잘렸다" 를 그리는 신호다.
func TestOpenWithHistory_TruncatedTravelsToReplay(t *testing.T) {
	m, _ := newMgr(t)
	lines := make([]string, 60)
	for i := range lines {
		lines[i] = strings.Repeat("y", 50)
	}
	h := LoadHistory(histAdapter(), writeLines(t, lines), 200)
	s, err := m.OpenWithHistory("tool-1", histAdapter(), agentadapter.LaunchOpts{Resume: "s1"}, h)
	if err != nil {
		t.Fatal(err)
	}
	if _, truncated, _ := s.Replay(0); !truncated {
		t.Fatal("꼬리만 읽었는데 재생이 그 사실을 말하지 않았다")
	}
}

// V-M9-41 ③ (FR-M9-41 / FR-APS-4): **부재는 문장이 된다.**
//
// 읽지 못한 것과 읽을 것이 없던 것을 상태가 가른다. 조용히 비면 사용자는 세션이
// 이어지지 않은 줄 안다 — 그것이 접수한 증상 그대로다.
func TestOpenWithHistory_AbsenceIsSaidNotSwallowed(t *testing.T) {
	m, _ := newMgr(t)
	plain := agentadapter.Adapter{ID: "fake", Proto: fakeProto()}
	h := LoadHistory(plain, "/없는/경로.jsonl", 1<<20)
	s, err := m.OpenWithHistory("tool-1", plain, agentadapter.LaunchOpts{Resume: "s1"}, h)
	if err != nil {
		t.Fatal(err)
	}
	if s.State().History != HistoryUnavailable {
		t.Fatalf("읽지 못한 사실이 상태에 없다: %q", s.State().History)
	}

	// 재개가 아닌 세션은 **물어본 적이 없다** — 빈 화면이 정상이고 문장을 붙이지 않는다.
	m2, _ := newMgr(t)
	s2, err := m2.Open("tool-2", plain, agentadapter.LaunchOpts{})
	if err != nil {
		t.Fatal(err)
	}
	if s2.State().History != "" {
		t.Fatalf("묻지 않은 것에 답했다: %q", s2.State().History)
	}
}

// 기록이 로그 상한을 넘으면 **기존 링이 접는다** (D-C-13) — 새 장치를 만들지 않는다.
func TestOpenWithHistory_RingFoldsWhatItDrops(t *testing.T) {
	m, _ := newMgr(t) // LogCap 8
	lines := make([]string, 20)
	for i := range lines {
		lines[i] = "줄"
	}
	h := LoadHistory(histAdapter(), writeLines(t, lines), 1<<20)
	s, err := m.OpenWithHistory("tool-1", histAdapter(), agentadapter.LaunchOpts{Resume: "s1"}, h)
	if err != nil {
		t.Fatal(err)
	}
	evs, truncated, snap := s.Replay(0)
	if len(evs) != 8 {
		t.Fatalf("링 상한이 지켜지지 않았다: %d", len(evs))
	}
	if !truncated || snap == nil {
		t.Fatalf("버린 것을 접지 않았다: truncated=%v snap=%v", truncated, snap)
	}
	blob, _ := json.Marshal(snap)
	if len(blob) == 0 {
		t.Fatal("스냅샷이 비었다")
	}
}

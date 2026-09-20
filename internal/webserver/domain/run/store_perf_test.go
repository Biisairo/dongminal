package run

import (
	"bytes"
	"os"
	"strconv"
	"testing"
)

// PERFORMANCE_HARDENING_SRS 묶음 P-D 항목 5 (`AUDIT-go-domain.md` P3).
//
// 팀 통신 **한 줄**이 `runs.json` 전체를 다시 쓰고 모든 Record·Member 를 다시
// 복사한다. 이 패키지가 그 사실을 이미 알고 있다 — `store_messages.go` 의
// `MaxMessages = 500` 이 그 근거로 선 상한이다.
//
// 벽시계가 아니라 **할당**을 기록한다 (FR-PRF-3 · TC-PRF-28).
func benchStore(b *testing.B, runs, members, msgs int) (*Store, []string) {
	b.Helper()
	s := NewStore(b.TempDir(), "epoch-bench")
	if err := s.Load(); err != nil {
		b.Fatal(err)
	}
	ids := make([]string, 0, runs)
	for r := 0; r < runs; r++ {
		rec, err := s.Start(StartOptions{
			Objective: "bench " + strconv.Itoa(r), Projection: Inline,
			Isolation: IsolationNone, CoordinatorToolID: "tool-coord",
		})
		if err != nil {
			b.Fatal(err)
		}
		ids = append(ids, rec.ID)
		for m := 0; m < members; m++ {
			mem, err := s.AddMember(rec.ID, MemberSpec{
				Role: "r" + strconv.Itoa(m), Agent: "claude", ToolID: "tool-" + strconv.Itoa(r) + "-" + strconv.Itoa(m),
			})
			if err != nil {
				b.Fatal(err)
			}
			for k := 0; k < msgs/members; k++ {
				if err := s.AppendMessage(rec.ID, MsgEvent{
					From: CoordinatorParty, To: mem.ID, At: int64(k + 1),
					Kind: MsgKindAgent, Size: k,
				}); err != nil {
					b.Fatal(err)
				}
			}
		}
	}
	return s, ids
}

func BenchmarkAppendMessage(b *testing.B) {
	s, ids := benchStore(b, 10, 5, 500)
	m, err := s.AddMember(ids[0], MemberSpec{Role: "last", Agent: "claude", ToolID: "tool-bench-last"})
	if err != nil {
		b.Fatal(err)
	}
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if err := s.AppendMessage(ids[0], MsgEvent{
			From: CoordinatorParty, To: m.ID, At: int64(i + 1), Kind: MsgKindAgent, Size: i,
		}); err != nil {
			b.Fatal(err)
		}
	}
}

// TC-PRF-22: `runs.json` 이 **한 줄**이 된다 (FR-PRF-74 · D-PRF-8).
//
// 동작 변경이므로 검사가 잠근다. 이 파일은 기계가 쓰고 기계가 읽는다 — 사람이
// 읽는 자리는 `config show`·`doctor` 이고 그쪽은 자기 형식으로 낸다. 들여쓰기는
// 팀 통신 한 줄마다 다시 쓰이고, 그 비용이 통신 속도에 실린다.
func TestSave_RunsFileIsCompact(t *testing.T) {
	dir := t.TempDir()
	s := NewStore(dir, "epoch-compact")
	if err := s.Load(); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Start(StartOptions{
		Objective: "압축", Projection: Inline, Isolation: IsolationNone,
		CoordinatorToolID: "tool-coord",
	}); err != nil {
		t.Fatal(err)
	}
	blob, err := os.ReadFile(s.path())
	if err != nil {
		t.Fatal(err)
	}
	if n := bytes.Count(blob, []byte("\n")); n > 1 {
		t.Fatalf("runs.json 에 줄바꿈이 %d개 — 들여쓴 JSON 이다 (FR-PRF-74)", n)
	}
	if !bytes.Contains(blob, []byte(`"objective":"압축"`)) {
		t.Fatalf("압축된 형식이 아니다: %s", blob)
	}
}

// TC-PRF-22: 되돌림이 **깊은 복사 없이도** 성립한다 (FR-PRF-73).
//
// 성공 경로의 복사를 없앤 것이 이 항목이다. 없앤 자리가 실제로 쓰이던 자리를
// 무너뜨리지 않았는지 — 그것이 이 검사다.
func TestSave_RollbackWorksFromBlob(t *testing.T) {
	dir := t.TempDir()
	s := NewStore(dir, "epoch-rb")
	if err := s.Load(); err != nil {
		t.Fatal(err)
	}
	rec, err := s.Start(StartOptions{
		Objective: "되돌림", Projection: Inline, Isolation: IsolationNone,
		CoordinatorToolID: "tool-coord",
	})
	if err != nil {
		t.Fatal(err)
	}
	before := len(s.List())

	freeze(t, s)
	if _, err := s.Start(StartOptions{
		Objective: "두 번째", Projection: Inline, Isolation: IsolationNone,
		CoordinatorToolID: "tool-two",
	}); err == nil {
		t.Fatal("쓰기가 실패해야 하는데 성공했다")
	}
	if got := len(s.List()); got != before {
		t.Fatalf("저장 실패 뒤 목록이 %d개 — 되돌지 않았다 (`FBE-17`)", got)
	}
	if got := s.List()[0].ID; got != rec.ID {
		t.Fatalf("되돌린 목록의 머리가 %s — 원래는 %s", got, rec.ID)
	}
}

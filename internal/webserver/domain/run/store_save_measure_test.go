package run

import (
	"encoding/json"
	"strconv"
	"testing"
)

// REFACTOR3_GO_STRUCT_SRS FR-RGS-20 (GD-11): `save` 한 번의 비용을 Run 수별로 잰다.
//
// 저장은 변경마다 전체 Run 을 직렬화하고 파일 전체를 다시 쓴다. 증분 직렬화가 줄일
// 수 있는 것은 직렬화(Marshal)뿐이고 쓰기(세대 회전 + 원자적 쓰기)는 그대로다 — 두
// 몫을 따로 재어 어느 쪽이 지배하는지 남긴다. Run 하나는 멤버 5·메시지 500(상한)이다.
var saveMeasureRuns = []int{10, 50, 200}

// measureStore 는 Run n 개를 메모리에 바로 세우고 한 번 저장한다. Start·AppendMessage 로
// 세우면 준비가 저장 n×500 번이 되어 측정보다 길다.
func measureStore(b *testing.B, n int) (*Store, string) {
	b.Helper()
	s := NewStore(b.TempDir())
	if err := s.Load(); err != nil {
		b.Fatal(err)
	}
	runs := make([]Record, 0, n)
	for r := 0; r < n; r++ {
		id := "run-" + strconv.Itoa(r)
		rec := Record{ID: id, Short: Short(id), Objective: "measure " + strconv.Itoa(r), Projection: Inline,
			Isolation: IsolationNone, State: Open, CoordinatorToolID: "tool-coord", CreatedAt: 1}
		for m := 0; m < 5; m++ {
			rec.Members = append(rec.Members, Member{ID: id + "-m" + strconv.Itoa(m), Role: "r" + strconv.Itoa(m),
				Agent: "claude", ToolID: "tool-" + strconv.Itoa(r) + "-" + strconv.Itoa(m)})
		}
		for k := 0; k < MaxMessages; k++ {
			rec.Messages = append(rec.Messages, MsgEvent{From: CoordinatorParty, To: rec.Members[k%5].ID,
				At: int64(k + 1), Kind: MsgKindAgent, Size: k})
		}
		runs = append(runs, rec)
	}
	s.mu.Lock()
	s.runs = runs
	err := s.save()
	s.mu.Unlock()
	if err != nil {
		b.Fatal(err)
	}
	return s, runs[0].Members[0].ID
}

func BenchmarkSave_Marshal(b *testing.B) {
	for _, n := range saveMeasureRuns {
		b.Run("runs="+strconv.Itoa(n), func(b *testing.B) {
			s, _ := measureStore(b, n)
			body := fileBody{SchemaVersion: schemaVersion, Runs: s.runs}
			blob, err := json.Marshal(body)
			if err != nil {
				b.Fatal(err)
			}
			b.ReportMetric(float64(len(blob)), "bytes/save")
			b.ReportAllocs()
			b.ResetTimer()
			for i := 0; i < b.N; i++ {
				if _, err := json.Marshal(body); err != nil {
					b.Fatal(err)
				}
			}
		})
	}
}

// BenchmarkSave_AppendMessage 는 팀 통신 한 줄의 저장 전체(직렬화 + 세대 회전 + 쓰기)다.
func BenchmarkSave_AppendMessage(b *testing.B) {
	for _, n := range saveMeasureRuns {
		b.Run("runs="+strconv.Itoa(n), func(b *testing.B) {
			s, to := measureStore(b, n)
			b.ReportAllocs()
			b.ResetTimer()
			for i := 0; i < b.N; i++ {
				if err := s.AppendMessage("run-0", MsgEvent{
					From: CoordinatorParty, To: to, At: int64(i + 1), Kind: MsgKindAgent, Size: i,
				}); err != nil {
					b.Fatal(err)
				}
			}
		})
	}
}

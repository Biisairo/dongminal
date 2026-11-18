package httpapi

import (
	"os"
	"strings"
	"testing"
)

// V-RPS-7: WS 배선이 좌석 통보를 **재생보다 앞에** 보낸다 (TERM_REPLY_SEAT_SRS FR-RPS-2·4).
// 배선은 데몬 하나다 (DIRECT_MODE_REMOVAL_SRS).
//
// 소스를 읽는 검사인 것은 `TestBuildReplay_IsTheOnlyAssembler` 와 같은 근거다 —
// 재는 것이 바이트가 아니라 **배선이 규약을 지키는가** 이고, 그것은 핸들러를 띄우지
// 않고도 결정적으로 답할 수 있다.
func TestReplySeat_NotifiedBeforeReplay(t *testing.T) {
	raw, err := os.ReadFile("handlers_ws.go")
	if err != nil {
		t.Fatalf("read handlers_ws.go: %v", err)
	}
	src := string(raw)

	joins := indexesOf(src, "Seats.Join(")
	replays := indexesOf(src, "buildReplay(")
	if len(joins) != 1 {
		t.Fatalf("좌석 통보가 한 곳이 아니다: %d 곳", len(joins))
	}
	if len(replays) != 1 {
		t.Fatalf("재생이 한 곳이 아니다: %d 곳", len(replays))
	}
	if joins[0] >= replays[0] {
		t.Errorf("통보가 재생보다 앞이 아니다: joins=%v replays=%v", joins, replays)
	}
	if strings.Count(src, "Seats.Leave(") != 1 {
		t.Error("좌석 해제가 없다 — 떠난 연결이 좌석을 쥔 채로 남는다")
	}
}

func indexesOf(s, sub string) []int {
	var out []int
	for i := 0; ; {
		j := strings.Index(s[i:], sub)
		if j < 0 {
			return out
		}
		out = append(out, i+j)
		i += j + len(sub)
	}
}

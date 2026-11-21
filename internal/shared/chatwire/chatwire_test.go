package chatwire

import (
	"os"
	"strings"
	"testing"

	"dongminal/internal/shared/humancmd"
)

// REFACTOR3_DEDUP_GO_SRS TC-RDG-40: 사람 명령의 op 는 채팅 소켓 → 데몬 → 서명한 본문(humancmd)으로
// 그대로 건네진다. 이름이 어긋나면 applyCmdLocked 가 조용히 아무것도 하지 않는다.
func TestHumanOpsAreHumancmd(t *testing.T) {
	if OpKill != humancmd.OpKill || OpKick != humancmd.OpKick {
		t.Fatalf("kill=%q/%q kick=%q/%q", OpKill, humancmd.OpKill, OpKick, humancmd.OpKick)
	}
	body, err := os.ReadFile("chatwire.go")
	if err != nil {
		t.Fatal(err)
	}
	for _, lit := range []string{`"kill"`, `"kick"`} {
		if strings.Contains(string(body), lit) {
			t.Errorf("chatwire.go 가 %s 를 따로 적는다 — humancmd 의 것을 가리킨다", lit)
		}
	}
}

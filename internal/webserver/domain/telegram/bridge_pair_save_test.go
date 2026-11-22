package telegram

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// ATTIC_FIX_SRS TC-ATF-42: 코드는 맞았는데 저장이 실패하면 실패를 알린다 (AT-TG-5).
func TestBridgePairSaveFailureReplies(t *testing.T) {
	r := newRig(t)
	_ = r.st.SetUser(0)
	code, _ := r.b.Pairing().Issue()
	blocker := filepath.Join(t.TempDir(), "file")
	if err := os.WriteFile(blocker, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	r.st.path = filepath.Join(blocker, "telegram.json")
	r.msg(77, "/pair "+code)
	body, ok := r.tg.last("sendMessage")
	if !ok || body["chat_id"] != float64(77) || !strings.Contains(body["text"].(string), "저장하지 못했") {
		t.Fatalf("저장 실패를 알리지 않았다: %v", body)
	}
	if r.st.Config().UserID != 0 {
		t.Fatal("저장하지 못했는데 등록됐다")
	}
}

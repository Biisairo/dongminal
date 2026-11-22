package telegram

import (
	"testing"
	"time"
)

// ATTIC_FIX_SRS TC-ATF-43: transcript 를 읽는 동안 b.mu 를 쥐지 않는다 (AT-TG-6 · FR-RD3-40).
func TestBridgeClassifyOutsideLock(t *testing.T) {
	r := newRig(t)
	entered, release := make(chan struct{}), make(chan struct{})
	readReply = func(string) string {
		close(entered)
		<-release
		return "끝"
	}
	t.Cleanup(func() { readReply = LastReply })
	r.act(Event{ToolID: tabA, Hook: "Stop", Transcript: "/never/read.jsonl"})
	done := make(chan struct{})
	go func() {
		r.attn(tabA, "done")
		close(done)
	}()
	select {
	case <-entered:
	case <-time.After(5 * time.Second):
		t.Fatal("transcript 를 읽지 않았다")
	}
	observed := make(chan struct{})
	go func() {
		r.act(Event{ToolID: tabA, Hook: "UserPromptSubmit"})
		close(observed)
	}()
	select {
	case <-observed:
	case <-time.After(2 * time.Second):
		close(release)
		<-done
		t.Fatal("transcript 를 읽는 동안 hook 기록이 b.mu 를 기다렸다")
	}
	close(release)
	<-done
	if got := folded(r.sent(t)); got != "끝" {
		t.Fatalf("내용 %q", got)
	}
}

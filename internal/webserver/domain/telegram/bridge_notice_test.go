package telegram

import "testing"

// CLAUDE_ACCOUNTS_SRS FR-CAC-100a: 탭과 무관한 글 한 통.

func TestNoticeSendsPlainText(t *testing.T) {
	r := newRig(t)
	r.b.process(item{notice: "Claude 계정 자동 전환: ab***@ → cd***@"})
	body, ok := r.tg.last("sendMessage")
	if !ok {
		t.Fatal("not sent")
	}
	if body["chat_id"] != float64(me) || body["text"] != "Claude 계정 자동 전환: ab***@ → cd***@" {
		t.Fatalf("%v", body)
	}
	if _, ok := body["parse_mode"]; ok {
		t.Fatal("plain text — no HTML parsing of account names")
	}
	if _, ok := body["disable_notification"]; ok {
		t.Fatal("silent rule is per tab; notices are never muted")
	}
}

func TestNoticeDroppedWhenDisabled(t *testing.T) {
	r := newRig(t)
	_ = r.st.SetEnabled(false)
	r.b.OnNotice("x")
	select {
	case <-r.b.q:
		t.Fatal("disabled bridge queues nothing")
	default:
	}
}

func TestNoticeQueued(t *testing.T) {
	r := newRig(t)
	r.b.OnNotice("hello")
	it := <-r.b.q
	if it.notice != "hello" {
		t.Fatalf("%+v", it)
	}
}

package boot

import (
	"errors"
	"testing"
)

// PEER_CHAT_SRS §3.12a R-7: 키는 얻으면 바로 싣고, 비우는 것은 연속 3번 실패한 뒤다.
func TestHelperWatchDropsAfterThreeFailures(t *testing.T) {
	var w helperWatch
	fail := errors.New("down")
	if k, set := w.next("K", nil); !set || k != "K" {
		t.Fatalf("성공 = %q,%v", k, set)
	}
	for i := 1; i <= 2; i++ {
		if _, set := w.next("", fail); set {
			t.Fatalf("%d번째 실패에 키를 바꿨다", i)
		}
	}
	if k, set := w.next("", fail); !set || k != "" {
		t.Fatalf("3번째 실패 = %q,%v — 비워야 한다", k, set)
	}
	if k, set := w.next("K2", nil); !set || k != "K2" {
		t.Fatalf("다시 성공 = %q,%v", k, set)
	}
	if _, set := w.next("", fail); set {
		t.Fatal("성공 뒤 첫 실패에 키를 바꿨다 — 횟수가 0 부터여야 한다")
	}
}

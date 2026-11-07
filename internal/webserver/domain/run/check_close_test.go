package run

import (
	"errors"
	"testing"
)

// SERVER_DRIVEN_ACTIONS_SRS R-c: 종료 판정은 이 함수 하나다 — `Store.Close` 도 부른다.
func TestCheckClose(t *testing.T) {
	open := Record{State: Open, Members: []Member{{ID: "a", State: Released}, {ID: "b"}}}
	if pending, err := CheckClose(open, false); !errors.Is(err, ErrUnreportedMembers) || len(pending) != 1 || pending[0].ID != "b" {
		t.Fatalf("미보고: pending=%v err=%v", pending, err)
	}
	if _, err := CheckClose(open, true); err != nil {
		t.Fatalf("force: %v", err)
	}
	closed := Record{State: Closed}
	if _, err := CheckClose(closed, true); !errors.Is(err, ErrRunClosed) {
		t.Fatalf("끝난 Run: %v", err)
	}
}

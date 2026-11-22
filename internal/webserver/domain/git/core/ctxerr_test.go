package core

import (
	"context"
	"errors"
	"testing"
	"time"
)

// TC-ATF-9 (ATTIC_FIX_SRS FR-ATF-9, AT-GJB-7): ctx 오류 분류는 한 함수다 —
// DeadlineExceeded → ErrTimeout, Canceled → ErrCanceled, 끝나지 않았으면 nil.
func TestCtxErr_Classifies(t *testing.T) {
	if err := CtxErr(context.Background(), "기다리는 중"); err != nil {
		t.Fatalf("끝나지 않은 ctx = %v", err)
	}

	dl, cancelDL := context.WithDeadline(context.Background(), time.Now().Add(-time.Second))
	defer cancelDL()
	if err := CtxErr(dl, "기다리는 중"); !errors.Is(err, ErrTimeout) || !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("마감 = %v, want ErrTimeout", err)
	}

	gone, cancel := context.WithCancel(context.Background())
	cancel()
	err := CtxErr(gone, "기다리는 중")
	if !errors.Is(err, ErrCanceled) || errors.Is(err, ErrTimeout) {
		t.Fatalf("취소 = %v, want ErrCanceled", err)
	}
}

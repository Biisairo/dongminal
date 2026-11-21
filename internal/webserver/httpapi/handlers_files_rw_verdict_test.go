package httpapi

import (
	"testing"

	"dongminal/internal/webserver/domain/lsp"
)

// REFACTOR3_GO_STRUCT_SRS FR-RGS-1: 파일 쓰기 처리기에서 뗀 판정 함수.

func TestStampConflict(t *testing.T) {
	cases := []struct {
		name, want, cur string
		conflict        bool
	}{
		{"같은 표식", "a", "a", false},
		{"디스크가 바뀌었다", "a", "b", true},
		{"파일이 없으면 경합이 아니다", "a", "", false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := stampConflict(c.want, c.cur); got != c.conflict {
				t.Fatalf("got %v, want %v", got, c.conflict)
			}
		})
	}
}

func TestLSPWatchType(t *testing.T) {
	cases := []struct {
		existed bool
		want    int
	}{
		{true, lsp.WatchChanged},
		{false, lsp.WatchCreated},
	}
	for _, c := range cases {
		if got := lspWatchType(c.existed); got != c.want {
			t.Fatalf("existed=%v: got %d, want %d", c.existed, got, c.want)
		}
	}
}

package dmlog_test

import (
	"bytes"
	"context"
	"strings"
	"testing"

	"dongminal/internal/shared/dmlog"
)

// TC-OBS-1: 수준 하한이 듣는다.
func TestLevelFilters(t *testing.T) {
	var buf bytes.Buffer
	dmlog.Init(dmlog.Options{Level: "warn", Out: &buf})
	t.Cleanup(dmlog.Reset)

	dmlog.Infof(nil, "숨어야 한다")
	dmlog.Warnf(nil, "보여야 한다")
	s := buf.String()
	if strings.Contains(s, "숨어야") {
		t.Errorf("info 가 warn 하한을 넘었다:\n%s", s)
	}
	if !strings.Contains(s, "보여야") {
		t.Errorf("warn 이 나오지 않았다:\n%s", s)
	}
}

// TC-OBS-2: 알 수 없는 수준은 `info` 로 떨어지고 **오류가 아니다**.
// 로그 설정 하나가 기동을 시끄럽게 만들 이유가 없다.
func TestUnknownLevelFallsBackToInfo(t *testing.T) {
	var buf bytes.Buffer
	dmlog.Init(dmlog.Options{Level: "nonsense", Out: &buf})
	t.Cleanup(dmlog.Reset)
	if got := dmlog.Level(); got != "info" {
		t.Fatalf("수준 = %q, 기대 info", got)
	}
	dmlog.Infof(nil, "보여야 한다")
	if !strings.Contains(buf.String(), "보여야") {
		t.Error("info 가 나오지 않았다")
	}
}

// 요청 ID 가 컨텍스트를 타고 로그 줄에 실린다 (FR-OBS-3·9).
func TestReqIDRidesContext(t *testing.T) {
	var buf bytes.Buffer
	dmlog.Init(dmlog.Options{Level: "debug", Out: &buf})
	t.Cleanup(dmlog.Reset)

	ctx := dmlog.WithReqID(context.Background(), "abc123")
	if got := dmlog.ReqID(ctx); got != "abc123" {
		t.Fatalf("ReqID = %q", got)
	}
	dmlog.Warnf(ctx, "무언가 %d", 7)
	s := buf.String()
	if !strings.Contains(s, "abc123") {
		t.Errorf("요청 ID 가 줄에 없다:\n%s", s)
	}
	if !strings.Contains(s, "무언가 7") {
		t.Errorf("서식이 적용되지 않았다:\n%s", s)
	}
}

// ctx 가 nil 이거나 ID 가 없으면 그 필드를 싣지 않는다 — 빈 값을 실으면
// 로그가 넓어지기만 한다.
func TestNoReqIDNoField(t *testing.T) {
	var buf bytes.Buffer
	dmlog.Init(dmlog.Options{Level: "debug", Out: &buf})
	t.Cleanup(dmlog.Reset)
	dmlog.Infof(context.Background(), "민짜")
	if strings.Contains(buf.String(), "reqId") {
		t.Errorf("빈 요청 ID 를 실었다:\n%s", buf.String())
	}
}

// 키-값 호출은 새로 쓰는 자리의 형태다 (FR-OBS-4).
func TestStructuredCall(t *testing.T) {
	var buf bytes.Buffer
	dmlog.Init(dmlog.Options{Level: "debug", Out: &buf})
	t.Cleanup(dmlog.Reset)
	dmlog.Info(dmlog.WithReqID(context.Background(), "r1"), "열었다", "tool", "t-9")
	s := buf.String()
	for _, want := range []string{"열었다", "tool", "t-9", "r1"} {
		if !strings.Contains(s, want) {
			t.Errorf("%q 가 없다:\n%s", want, s)
		}
	}
}

// FR-OBS-7: 클라이언트가 준 값은 **검사를 지나야** 쓰인다. 줄바꿈이 섞이면
// 로그가 위조된다.
func TestSanitizeReqID(t *testing.T) {
	for _, tc := range []struct{ in, want string }{
		{"abc-123_XY", "abc-123_XY"},
		{"", ""},
		{"has space", ""},
		{"new\nline", ""},
		{"세미콜론;", ""},
		{strings.Repeat("a", 64), strings.Repeat("a", 64)},
		{strings.Repeat("a", 65), ""},
	} {
		if got := dmlog.SanitizeReqID(tc.in); got != tc.want {
			t.Errorf("SanitizeReqID(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
}

// 새로 만든 ID 는 자기 검사를 통과해야 한다 — 게이트가 자기 발을 밟지 않는지 본다.
func TestNewReqIDIsValid(t *testing.T) {
	seen := map[string]bool{}
	for i := 0; i < 100; i++ {
		id := dmlog.NewReqID()
		if dmlog.SanitizeReqID(id) != id {
			t.Fatalf("스스로 만든 ID 가 검사에 걸린다: %q", id)
		}
		if seen[id] {
			t.Fatalf("ID 가 겹쳤다: %q", id)
		}
		seen[id] = true
	}
}

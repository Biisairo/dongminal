package cli

import (
	"testing"
)

// REFACTOR3_DEDUP_GO_SRS FR-RDG-25: 하위 명령이 모르는 인자는 공통 적용기 하나가 Common 에
// 넘기고, Common 도 모르면 그 명령의 unknownFlag 다. 문구는 종전과 같다.
func TestTakeOrUnknown(t *testing.T) {
	var c Common
	args := []string{"--port", "1234", "--bogus", "--home="}
	i := 0
	if err := c.takeOr("start", args, &i); err != nil || c.Port != "1234" || i != 1 {
		t.Fatalf("--port: err=%v port=%q i=%d", err, c.Port, i)
	}
	i = 2
	if err := c.takeOr("start", args, &i); err == nil || err.Error() != unknownFlag("start", "--bogus").Error() {
		t.Fatalf("--bogus: %v", err)
	}
	i = 3
	if err := c.takeOr("start", args, &i); err == nil || err.Error() != "--home 에 값이 없습니다" {
		t.Fatalf("--home=: %v", err)
	}
}

// 여섯 파서가 모두 그 적용기를 지난다 — 모르는 인자의 오류가 unknownFlag 와 바이트로 같다.
func TestParsersUnknownViaTakeOr(t *testing.T) {
	cases := map[string]func([]string) error{
		"start":   func(a []string) error { _, e := ParseStart(a); return e },
		"stop":    func(a []string) error { _, e := ParseStop(a); return e },
		"doctor":  func(a []string) error { _, e := ParseDoctor(a); return e },
		"health":  func(a []string) error { _, e := ParseHealth(a); return e },
		"window":  func(a []string) error { _, e := ParseWindow(a); return e },
		"migrate": func(a []string) error { _, e := ParseMigrate(a); return e },
	}
	for name, fn := range cases {
		if err := fn([]string{"--bogus"}); err == nil || err.Error() != unknownFlag(name, "--bogus").Error() {
			t.Errorf("%s: %v", name, err)
		}
		if err := fn([]string{"--port", "x"}); err == nil || err.Error() != "--port 값이 포트 번호가 아닙니다: x" {
			t.Errorf("%s --port x: %v", name, err)
		}
	}
}

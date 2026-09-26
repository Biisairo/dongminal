package runtimebin

import "testing"

// FR-OPT-10-2 (SHR-17): run 과 wait 의 클라이언트 여유는 한 값이다.
func TestClientSlackSingleSource(t *testing.T) {
	if runClientSlack != clientSlack || waitClientSlack != clientSlack {
		t.Fatalf("run=%v wait=%v clientSlack=%v", runClientSlack, waitClientSlack, clientSlack)
	}
}

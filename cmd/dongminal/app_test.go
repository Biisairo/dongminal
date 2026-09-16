package main

import "testing"

// M8 D-A-12 (GO-16): 종료 순서는 주석이 아니라 표다. 마커를 먼저 쓰고(정상 종료의
// 증거), 데몬 연결을 먼저 놓아야 새 서버가 붙고, 도구 저장 → 샌드박스 정지 →
// 언어 서버 정지 → 워크스페이스 flush 순이다. 이름의 순서를 잰다.
func TestShutdownSteps_OrderIsTheContract(t *testing.T) {
	a := &app{}
	want := []string{"마커", "데몬 연결", "도구 저장", "샌드박스", "LSP", "판 확인", "워크스페이스"}
	steps := a.shutdownSteps()
	if len(steps) != len(want) {
		t.Fatalf("단계 수 %d, want %d", len(steps), len(want))
	}
	for i, s := range steps {
		if s.name != want[i] {
			t.Fatalf("[%d] = %q, want %q", i, s.name, want[i])
		}
	}
	// 조립되지 않은 구성원(nil)은 단계가 건너뛴다 — 빈 app 의 shutdown 이 패닉하지 않는다.
	a.shutdown()
}

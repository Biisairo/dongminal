package workspace

import "testing"

// 샌드박스 창이 섞인 workspace. FR-SBX-18 의 `sandbox` 는 선택 필드이므로 일반
// Window 와 한 파일에 공존한다.
const sampleSandboxWS = `{
  "schemaVersion": 2,
  "activeWindow": "w1",
  "windows": [
    {"id":"w1","name":"host","focusedPane":"p1","layout":{"type":"pane","id":"p1","tabs":[]}},
    {"id":"w2","name":"box","sandbox":"scratch","focusedPane":"p2","layout":{"type":"pane","id":"p2","tabs":[]}}
  ]
}`

func TestWindowsOf_ReadsSandboxProfile(t *testing.T) {
	got := windowsOf([]byte(sampleSandboxWS))
	if len(got) != 2 {
		t.Fatalf("Window 수가 다르다: %d", len(got))
	}
	// FR-SBX-19: 필드가 없으면 일반 Window 다. 구 파일이 그대로 이 의미로 읽힌다.
	if got[0].UUID != "w1" || got[0].Sandbox != "" {
		t.Errorf("일반 Window 가 잘못 읽혔다: %+v", got[0])
	}
	if got[1].UUID != "w2" || got[1].Sandbox != "scratch" {
		t.Errorf("샌드박스 창이 잘못 읽혔다: %+v", got[1])
	}
}

// 탭이 하나도 없는 Window 도 목록에 들어야 한다. 빠지면 그 창의 대응 컨테이너가
// 고아로 오인되어 회수된다 — 사용자가 탭을 다 닫아 둔 샌드박스 창이 그렇다
// (FR-SBX-8/9).
func TestWindowsOf_IncludesTablessWindows(t *testing.T) {
	got := windowsOf([]byte(sampleSandboxWS))
	for _, w := range got {
		if w.UUID == "w2" {
			return
		}
	}
	t.Fatal("탭 없는 샌드박스 창이 목록에서 빠졌다")
}

// 구 스키마·빈 입력은 오류가 아니라 빈 목록이다 — 회수 경로가 이것을 "살아 있는
// Window 가 없다" 로 읽으면 모든 컨테이너를 지운다. 그래서 호출자가 빈 결과와
// 실패를 구분할 수 있어야 한다.
func TestWindowsOf_EmptyBlobYieldsNothing(t *testing.T) {
	if got := windowsOf(nil); len(got) != 0 {
		t.Fatalf("빈 blob 에서 Window 가 나왔다: %+v", got)
	}
}

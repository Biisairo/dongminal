package toolhub

import (
	"strings"
	"testing"
	"time"

	"dongminal/internal/shared/platform"
	"dongminal/internal/shared/testpath"
)

// FR-SBX-12: place 가 주어지면 호스트 셸 대신 그 명세가 뜬다. 샌드박스 창의
// 도구가 컨테이너 안에서 도는 것이 이 갈래이며, 여기서 갈리는 것은 **무엇을
// 띄우는가** 뿐이다 — PTY·출력 스트림·종료 수확은 호스트 도구와 같은 경로다.
//
// 컨테이너 런타임을 쓰지 않는다. 이 시험이 확인하는 것은 대체가 일어나는가이지
// docker 가 도는가가 아니다.
func TestStartTool_PlaceReplacesHostShell(t *testing.T) {
	if !testpath.POSIXShell() {
		t.Skip("place 를 POSIX 셸 문법으로 확인한다")
	}
	// 곧바로 끝나는 명령은 쓸 수 없다. 프로세스가 즉시 종료하면 PTY 마스터가
	// 버퍼를 다 읽기 전에 닫혀 출력이 사라진다 — EchoCommand 로 처음 썼다가
	// 빈 스트림을 받았다.
	place := &platform.ProcSpec{
		Path: "/bin/sh",
		Args: []string{"/bin/sh", "-c", "echo PLACED-HERE; sleep 5"},
	}

	p, err := StartTool("t-place", "place", "", 80, 24, nil, nil, place)
	if err != nil {
		t.Fatalf("StartTool: %v", err)
	}
	defer p.kill()

	for deadline := time.Now().Add(5 * time.Second); time.Now().Before(deadline); {
		blob, _ := p.Stream().Snapshot()
		if strings.Contains(string(blob), "PLACED-HERE") {
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
	blob, _ := p.Stream().Snapshot()
	t.Fatalf("place 명세가 뜨지 않았습니다. got:\n%s", blob)
}

// NFR-SBX-2: place 가 nil 이면 종전과 완전히 같다. 샌드박스가 아닌 창의 동작이
// 이 변경으로 달라져서는 안 된다.
func TestStartTool_NilPlaceKeepsHostShell(t *testing.T) {
	p, err := StartTool("t-host", "host", "", 80, 24, nil, nil, nil)
	if err != nil {
		t.Fatalf("StartTool: %v", err)
	}
	defer p.kill()

	sh := platform.Current().Shell.Shell("").Path
	if got := p.term.PID(); got == 0 {
		t.Fatal("호스트 셸이 뜨지 않았다")
	}
	if sh == "" {
		t.Fatal("호스트 셸 경로가 비었다")
	}
}

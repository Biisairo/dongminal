package sandbox

import "testing"

// REFACTOR3_DEDUP_GO_SRS FR-RDG-46: 보이는 시작 명령과 실제로 실행하는 인자는 표의 같은 한 줄에서 나온다.
func TestStartCommandMatchesExecutedArgs(t *testing.T) {
	for _, goos := range []string{"darwin", "windows"} {
		var ran []string
		StartRuntime(goos, func(path string, args []string) (string, error) {
			ran = append([]string{path}, args...)
			return "", nil
		})
		cmd, _ := StartCommand(goos)
		if got := commandLine(ran); got != cmd {
			t.Errorf("%s: 실행=%q 보임=%q", goos, got, cmd)
		}
	}
}

func TestCommandLine(t *testing.T) {
	if got, want := commandLine([]string{"cmd", "/c", "start", "", "Docker Desktop.exe"}), `cmd /c start "" "Docker Desktop.exe"`; got != want {
		t.Fatalf("commandLine=%q want %q", got, want)
	}
}

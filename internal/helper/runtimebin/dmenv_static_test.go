package runtimebin

import (
	"os"
	"strconv"
	"strings"
	"testing"

	"dongminal/internal/shared/dmenv"
)

// 환경변수 이름과 기본 엔드포인트는 dmenv 한 곳에만 있다.
//
// 이 검사가 동작이 아니라 **부재**를 고정하는 이유는, 값을 복제해도 아무것도
// 깨지지 않기 때문이다 — 깨지는 것은 나중에 한쪽만 고쳐졌을 때이고, 그때는
// dmctl 이 옛 포트로 붙거나 심는 이름과 읽는 이름이 갈라진 뒤다.
func TestNoHardcodedEnvContract(t *testing.T) {
	banned := []string{
		`os.Getenv("` + "DONGMINAL", // 이름을 박고 읽는 자리 — selfToolID/envOr 를 써라
		dmenv.DefaultPort,
		dmenv.DefaultHost,
	}
	entries, err := os.ReadDir(".")
	if err != nil {
		t.Fatalf("ReadDir: %v", err)
	}
	scanned := 0
	var offenders []string
	for _, e := range entries {
		name := e.Name()
		if e.IsDir() || !strings.HasSuffix(name, ".go") || strings.HasSuffix(name, "_test.go") {
			continue
		}
		body, err := os.ReadFile(name)
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		scanned++
		for i, line := range strings.Split(string(body), "\n") {
			trimmed := strings.TrimSpace(line)
			if strings.HasPrefix(trimmed, "//") {
				continue
			}
			for _, b := range banned {
				if strings.Contains(line, b) {
					offenders = append(offenders, name+":"+strconv.Itoa(i+1)+": "+trimmed)
				}
			}
		}
	}
	// 훑은 파일이 없으면 통과가 무의미하다.
	if scanned < 10 {
		t.Fatalf("검사한 .go 파일이 %d 개뿐이다 — 탐색이 깨졌다", scanned)
	}
	if len(offenders) > 0 {
		t.Fatalf("dmenv 를 두고 값을 복제했다:\n%s", strings.Join(offenders, "\n"))
	}
}

// 도움말은 상수에서 만들어진다 — 문서가 코드보다 늦게 고쳐지면 사용자가 없는
// 포트로 붙는다.
func TestDmctlHelpUsesEnvContract(t *testing.T) {
	for _, want := range []string{dmenv.EnvPort, dmenv.EnvHost, dmenv.DefaultPort, dmenv.DefaultHost} {
		if !strings.Contains(dmctlHelp, want) {
			t.Errorf("도움말에 %q 가 없다", want)
		}
	}
}

// selfToolID 는 dmenv 가 정한 이름을 읽는다.
func TestSelfToolIDReadsEnvContract(t *testing.T) {
	t.Setenv(dmenv.EnvToolID, "tool-7")
	if got := selfToolID(); got != "tool-7" {
		t.Fatalf("selfToolID() = %q, want %q", got, "tool-7")
	}
}

package cli

import (
	"bytes"
	"strings"
	"testing"
)

// serve 를 nil 로 둔다 — 아래 경우 중 어느 것도 서버를 띄워서는 안 된다.
// 띄우려 하면 nil 역참조로 즉시 드러난다.
func dispatch(t *testing.T, args ...string) (int, string, string) {
	t.Helper()
	var out, errOut bytes.Buffer
	code := Dispatch(args, nil, &out, &errOut)
	return code, out.String(), errOut.String()
}

// FR-CLI-1/2: 무인자·-h·--help 는 help 를 내고 0 으로 끝난다.
func TestDispatch_Help(t *testing.T) {
	for _, args := range [][]string{nil, {"-h"}, {"--help"}, {"help"}} {
		code, out, errOut := dispatch(t, args...)
		if code != 0 {
			t.Errorf("%v → rc=%d", args, code)
		}
		if !strings.Contains(out, "사용법") {
			t.Errorf("%v → help 아님: %q", args, out)
		}
		if errOut != "" {
			t.Errorf("%v → stderr=%q", args, errOut)
		}
	}
}

// V-WIN-6: `window` 가 액션으로 선다.
//
// RunWindow 까지 태우지 않는다 — 개발 기계에 서버가 떠 있으면 **진짜 창이 열린다.**
// `--help` 로 태우면 ParseWindow 와 Usage 까지 지나므로 배선은 그대로 증명된다.
func TestDispatch_Window(t *testing.T) {
	code, out, errOut := dispatch(t, "window", "--help")
	if code != 0 {
		t.Errorf("rc=%d stderr=%q", code, errOut)
	}
	if !strings.Contains(out, "dongminal window") {
		t.Errorf("window 사용법이 아니다: %q", out)
	}
}

// FR-CLI-5: 알 수 없는 액션은 rc=2.
func TestDispatch_UnknownAction(t *testing.T) {
	code, out, errOut := dispatch(t, "bogus")
	if code != 2 {
		t.Errorf("rc=%d, want 2", code)
	}
	if !strings.Contains(errOut, "bogus") {
		t.Errorf("stderr 에 액션명 없음: %q", errOut)
	}
	if out != "" {
		t.Errorf("stdout 이 비어야 한다: %q", out)
	}
}

// FR-CLI-6: 액션 help 는 부수효과 없이 rc=0.
func TestDispatch_ActionHelp(t *testing.T) {
	for _, a := range Actions {
		code, out, _ := dispatch(t, a, "--help")
		if code != 0 {
			t.Errorf("%s --help → rc=%d", a, code)
		}
		if !strings.Contains(out, "dongminal "+a) {
			t.Errorf("%s --help → %q", a, out)
		}
	}
}

// FR-CLI-7: 알 수 없는 옵션은 부수효과 없이 rc=2.
func TestDispatch_UnknownFlag(t *testing.T) {
	for _, a := range Actions {
		code, out, errOut := dispatch(t, a, "--bogus")
		if code != 2 {
			t.Errorf("%s --bogus → rc=%d", a, code)
		}
		if !strings.Contains(errOut, "--bogus") {
			t.Errorf("%s --bogus → stderr=%q", a, errOut)
		}
		if out != "" {
			t.Errorf("%s --bogus → stdout=%q", a, out)
		}
	}
}

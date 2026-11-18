package cli

import (
	"bytes"
	"strings"
	"testing"
)

// OTP 도우미의 이름은 `otp` 다. 옛 이름 `helper` 는 목록에 보이지 않는 별칭으로만 남는다 —
// 이미 설치된 LaunchDaemon 이 `helper run` 을 부르기 때문이다.
func TestOTPActionListedAndHelperAlias(t *testing.T) {
	h := Help()
	if !strings.Contains(h, "  otp ") || !strings.Contains(h, "OTP") {
		t.Errorf("목록에 otp 가 없다:\n%s", h)
	}
	if strings.Contains(h, "  helper ") {
		t.Errorf("옛 이름 helper 가 목록에 보인다:\n%s", h)
	}
	for _, name := range []string{"otp", "helper"} {
		var out, errw bytes.Buffer
		if code := Dispatch([]string{name, "--help"}, nil, &out, &errw); code != 0 || !strings.Contains(out.String(), "dongminal otp") {
			t.Errorf("%s --help → %d %q %q", name, code, out.String(), errw.String())
		}
	}
}

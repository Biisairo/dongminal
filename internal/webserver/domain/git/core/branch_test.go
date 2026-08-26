package core

import (
	"errors"
	"testing"
)

// B8 (FR-GIT-7): `check-ref-format` 은 읽기 목록에 있으나 **인자가 묶여 있다.**
// 다른 형태로 부르면 검사가 아닌 것을 할 수 있다.
func TestGuardArgs_CheckRefFormat(t *testing.T) {
	cases := []struct {
		args []string
		ok   bool
	}{
		{[]string{"check-ref-format", "--branch", "feat"}, true},
		{[]string{"check-ref-format", "feat"}, false},
		{[]string{"check-ref-format", "--branch"}, false},
		{[]string{"check-ref-format", "--branch", "a", "b"}, false},
		{[]string{"check-ref-format", "--allow-onelevel", "--branch", "a"}, false},
	}
	for _, c := range cases {
		err := guardArgs(c.args)
		if c.ok && err != nil {
			t.Errorf("guardArgs(%v) = %v, want nil", c.args, err)
		}
		if !c.ok && !errors.Is(err, ErrUnsafeArgument) {
			t.Errorf("guardArgs(%v) = %v, want ErrUnsafeArgument", c.args, err)
		}
	}
}

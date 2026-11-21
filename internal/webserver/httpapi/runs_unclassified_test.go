package httpapi

import (
	"errors"
	"net/http"
	"testing"

	"dongminal/internal/webserver/apierr"
	"dongminal/internal/webserver/domain/run"
)

// REFACTOR3_GO_STRUCT_SRS FR-RGS-7 (GH-11): 동작 답의 `Why` 는 사유 **코드**다. 미분류
// 실패가 아래 계층의 자유 문구를 싣지 않는다.
func TestRunErrAnswer_UnclassifiedIsFixedCode(t *testing.T) {
	a := runErrAnswer(errors.New("open /secret/path: permission denied"))
	if a.OK || a.Status != http.StatusInternalServerError || a.Why != apierr.CodeInternal {
		t.Fatalf("answer=%+v, want 500 %s", a, apierr.CodeInternal)
	}
	// 분류된 sentinel 은 종전 그대로다.
	if a := runErrAnswer(run.ErrMemberNotAttached); a.Why != apierr.CodeMemberNotAttached {
		t.Fatalf("answer=%+v", a)
	}
}

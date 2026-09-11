package httpapi

import (
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
)

// STATE_FILE_DURABILITY_SRS 묶음 W — 빈 판 덮어쓰기 방지 (V-SFD-20·21).
//
// `FE-2` 는 이 저장소의 **P0** 다. 부팅에 실패한 브라우저가 빈 판을 만들고 그것을
// 저장하면 사용자의 창·탭이 통째로 사라진다. 지금 서버는 `If-Match` 를 **요구하지
// 않으므로**(`manager.go` 의 `if ifMatch != ""`) 그 PUT 이 성공한다.

func putWorkspace(t *testing.T, s *Server, body, ifMatch string) (int, string) {
	t.Helper()
	rec := httptest.NewRecorder()
	req := apiTestRequest(http.MethodPut, "/api/workspace", strings.NewReader(body))
	if ifMatch != "" {
		req.Header.Set("If-Match", ifMatch)
	}
	s.apiWorkspacePut(rec, req)
	return rec.Code, rec.Body.String()
}

const okWorkspace = `{"schemaVersion":2,"windows":[]}`

// V-SFD-20: **조건 없는 PUT 은 428 이고 디스크는 그대로다** (FR-SFD-20).
//
// 428 을 고른 이유: 409 는 "경합했다", 412 는 "조건이 틀렸다" 이고, 여기서 일어난
// 일은 **조건을 아예 보내지 않았다** 이다. 셋을 같은 코드로 답하면 클라이언트가
// 무엇을 해야 할지 가릴 수 없다 — 여기서 할 일은 **재조회부터 다시** 다.
func TestWorkspacePutRequiresIfMatch(t *testing.T) {
	work := newFakeWorkspaceStore()
	s := &Server{Deps: Deps{Work: work}}
	before := work.CurrentRev()

	code, body := putWorkspace(t, s, okWorkspace, "")
	if code != http.StatusPreconditionRequired {
		t.Fatalf("status=%d want 428 — 조건 없는 쓰기가 통과했다 (FE-2): %s", code, body)
	}
	if work.CurrentRev() != before {
		t.Fatal("거절했는데 저장됐다")
	}
}

// V-SFD-21: 조건이 맞으면 종전대로 저장된다 (회귀).
func TestWorkspacePutWithIfMatchStillWorks(t *testing.T) {
	work := newFakeWorkspaceStore()
	s := &Server{Deps: Deps{Work: work}}

	code, body := putWorkspace(t, s, okWorkspace, strconv.FormatUint(work.CurrentRev(), 10))
	if code != http.StatusOK {
		t.Fatalf("status=%d want 200: %s", code, body)
	}
}

// 어긋난 조건은 종전대로 **409** 다 — 428 과 뜻이 다르다.
func TestWorkspacePutStaleIsStillConflict(t *testing.T) {
	work := newFakeWorkspaceStore()
	s := &Server{Deps: Deps{Work: work}}

	if code, _ := putWorkspace(t, s, okWorkspace, "9999"); code != http.StatusConflict {
		t.Fatalf("status=%d want 409", code)
	}
}

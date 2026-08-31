package gitapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"dongminal/internal/webserver/apierr"
	"dongminal/internal/webserver/domain/worktree"
)

func decodeFail(t *testing.T, rec *httptest.ResponseRecorder) (int, string) {
	t.Helper()
	var body struct {
		Error string `json:"error"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("응답이 JSON 이 아니다: %q", rec.Body.String())
	}
	return rec.Code, body.Error
}

// Git 이 없는 배선에서 **모든** git 종단이 503 이다 — 어느 것도 패닉하지 않는다.
//
// `httpapi.New` 는 GitServer 를 **무조건** 만들므로(server.go:143) `Git == nil` 인
// GitServer 는 실재한다. 이전에는 검사가 호출자 20곳에 복제돼 있었고 그중
// `apiGitWorktrees` 하나가 빠져 있어서, worktree 관리자만 있는 배선에서
// `/api/git/worktrees` 가 nil 역참조로 죽었다 (FR-DPN-24).
//
//	이전 동작 — panic: invalid memory address or nil pointer dereference
//	새 동작   — 503 git_unavailable
//
// 검사가 `gitRepoParam` 안으로 들어가면서 빠질 자리가 없어졌다. 이 테스트가
// 그것을 못 박는다.
func TestNilGitNeverPanics(t *testing.T) {
	// UserWorktrees 는 채워 둔다 — 그 필드가 있는데 Git 이 없는 조합이 문제였던
	// 자리이고, nil 로 두면 앞단 검사가 먼저 막아 정작 재현하려던 경로를 못 본다.
	g := &GitServer{UserWorktrees: &worktree.Manager{}}

	type probe struct {
		method, path, body string
	}
	probes := []probe{
		{http.MethodGet, "/api/git/worktrees?repo=/tmp/x", ""},
		{http.MethodGet, "/api/git/status?repo=/tmp/x", ""},
		{http.MethodGet, "/api/git/log?repo=/tmp/x", ""},
		{http.MethodGet, "/api/git/refs?repo=/tmp/x", ""},
		{http.MethodGet, "/api/git/blame?repo=/tmp/x&path=a", ""},
		{http.MethodGet, "/api/git/stash?repo=/tmp/x", ""},
		{http.MethodGet, "/api/git/policy?repo=/tmp/x", ""},
		{http.MethodGet, "/api/git/records?repo=/tmp/x", ""},
		{http.MethodGet, "/api/git/preflight?repo=/tmp/x", ""},
		{http.MethodGet, "/api/git/signature?repo=/tmp/x", ""},
		{http.MethodGet, "/api/git/remotes?repo=/tmp/x", ""},
		{http.MethodGet, "/api/git/hunks?repo=/tmp/x&path=a", ""},
		{http.MethodGet, "/api/git/repos", ""},
		{http.MethodPost, "/api/git/commit", `{"repo":"/tmp/x","message":"m"}`},
		{http.MethodPost, "/api/git/stage", `{"repo":"/tmp/x","paths":["a"]}`},
		{http.MethodPost, "/api/git/discard", `{"repo":"/tmp/x","confirm":true}`},
		{http.MethodPost, "/api/git/branch", `{"repo":"/tmp/x","name":"b"}`},
		{http.MethodPost, "/api/git/tag", `{"repo":"/tmp/x","name":"v1"}`},
		{http.MethodPost, "/api/git/checkout", `{"repo":"/tmp/x","ref":"main"}`},
		{http.MethodPost, "/api/git/fetch", `{"repo":"/tmp/x"}`},
		{http.MethodPost, "/api/git/reset", `{"repo":"/tmp/x","oid":"abc","mode":"soft"}`},
		{http.MethodPost, "/api/git/worktrees/create", `{"repo":"/tmp/x","name":"wt","ref":"main"}`},
		{http.MethodPost, "/api/git/worktrees/remove", `{"repo":"/tmp/x","path":"/tmp/wt","confirm":true}`},
	}
	for _, p := range probes {
		t.Run(p.method+" "+p.path, func(t *testing.T) {
			var r *http.Request
			if p.body == "" {
				r = httptest.NewRequest(p.method, p.path, nil)
			} else {
				r = httptest.NewRequest(p.method, p.path, strings.NewReader(p.body))
			}
			rec := httptest.NewRecorder()
			defer func() {
				if rv := recover(); rv != nil {
					t.Fatalf("패닉했다: %v", rv)
				}
			}()
			if !g.Handle(rec, r) {
				t.Fatal("라우팅되지 않았다 — 경로가 틀렸는가?")
			}
			// **응답이 정확히 하나여야 한다.** 파이프라인의 실패는 끈적하므로
			// 두 번 쓰이지 않지만, 핸들러가 `stop()` 을 묻지 않고 `t.root` 를
			// 쓰면 빈 루트로 두 번째 응답이 나갈 수 있다. 그 부류를 종단 전체에서
			// 막는다 — 본문이 둘이면 클라이언트는 앞의 것만 보고 로그에는
			// superfluous WriteHeader 가 남는다.
			if n := strings.Count(rec.Body.String(), `"error"`); n != 1 {
				t.Fatalf("응답이 %d개 — 정확히 1개여야 한다: %s", n, rec.Body.String())
			}
			status, code := decodeFail(t, rec)
			if status != http.StatusServiceUnavailable {
				t.Fatalf("상태 %d, want 503 (본문 %s)", status, rec.Body.String())
			}
			// worktree 표면은 자기 사유를 낸다 — Git 이 아니라 worktree 관리자가
			// 없다고 말해야 사용자가 무엇을 고칠지 안다.
			if code != apierr.CodeUnavailable && !strings.Contains(code, "worktree") {
				t.Fatalf("코드 %q — git_unavailable 도 worktree 사유도 아니다", code)
			}
		})
	}
}

// 쓰기 파이프라인은 응답을 **정확히 한 번** 낸다. 두 번 쓰면 HTTP 가 헤더를 두 번
// 쓸 수 없어 로그에 superfluous WriteHeader 가 남고, 클라이언트는 앞의 것만 본다.
func TestWritePipelineRespondsOnce(t *testing.T) {
	g := &GitServer{}
	r := httptest.NewRequest(http.MethodPost, "/api/git/discard", strings.NewReader(`{}`))
	rec := httptest.NewRecorder()

	var req gitDiscardReq
	tx := g.beginWrite(rec, r, &req)
	if !tx.stop() {
		t.Fatal("Git 이 nil 인데 열렸다")
	}
	// 이미 응답한 뒤의 모든 단계는 무동작이어야 한다.
	tx.requireConfirm(true, false, "무시돼야 한다")
	tx.resolve("/tmp/x")
	tx.reject(nil)
	tx.rejectWith(http.StatusTeapot, "teapot", "무시돼야 한다")
	tx.apply(func(context.Context) error { t.Fatal("apply 가 돌았다"); return nil })
	tx.ok(nil)

	status, code := decodeFail(t, rec)
	if status != http.StatusServiceUnavailable || code != apierr.CodeUnavailable {
		t.Fatalf("첫 응답이 덮였다: %d %q", status, code)
	}
	if n := strings.Count(rec.Body.String(), `"error"`); n != 1 {
		t.Fatalf("본문에 응답이 %d개 — 정확히 1개여야 한다: %s", n, rec.Body.String())
	}
}

// snapshot 은 멱등이다 — 두 번 불러도 실행 전 상태를 한 번만 찍는다. 그렇지
// 않으면 `apply` 가 부르는 것과 핸들러가 부르는 것이 다른 기준선이 되고, 부분
// 적용 판정이 무엇을 비교하는지 알 수 없게 된다.
func TestSnapshotIsIdempotent(t *testing.T) {
	g := &GitServer{}
	r := httptest.NewRequest(http.MethodPost, "/api/git/discard", strings.NewReader(`{}`))
	tx := &gitWrite{s: g, w: httptest.NewRecorder(), r: r}
	tx.gotBefore = true
	tx.before.Branch = "기준선"

	if got := tx.snapshot(); got.Branch != "기준선" {
		t.Fatalf("이미 찍은 상태를 다시 찍었다: %q", got.Branch)
	}
	if got := tx.snapshot(); got.Branch != "기준선" {
		t.Fatalf("두 번째 호출이 상태를 바꿨다: %q", got.Branch)
	}
}

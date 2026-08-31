package gitapi

import (
	"context"
	"net/http"

	"dongminal/internal/webserver/domain/git/query"
)

// gitWrite 는 쓰기 한 번의 진행 상태다 (DEEPENING_REFACTOR_SRS 묶음 B).
//
// **핸들러에서 오류 배관을 없애는 것이 목적이다.** 이전에는 표준형 쓰기 하나가
// 이런 사다리였다:
//
//	root, ok := s.gitResolveRepo(w, r, req.Repo)
//	if !ok { return }
//	before, ok := s.gitStatusBefore(w, r, root)
//	if !ok { return }
//	after, ok := s.gitApply(w, r, req.Repo, root, before, run)
//	if !ok { return }
//	gitWriteOK(w, req.Repo, root, after, nil)
//
// 단계마다 `(T, bool)` 을 받아 `if !ok { return }` 를 다시 쓴다. 인터페이스(6함수
// × `(w, r) → (T, bool)`)가 구현만큼 복잡하고, 무엇보다 **순서 불변식이 타입이
// 아니라 주석에만** 있었다 — `handlers_git_branch.go` 가 "규약은 위와 같다" 고
// 적어 둔 것이 그 증거다.
//
// 여기서는 실패가 **끈적하다** (sticky). 한 번 응답한 뒤의 모든 단계는 무동작이므로
// 호출자는 검사하지 않는다. `bufio.Writer` 나 `sql.Rows` 가 오류를 들고 있는 것과
// 같은 방식이다.
//
// 응답은 **정확히 한 번** 나간다. `done` 이 그것을 보장하며, 두 번 쓰려 하면
// 두 번째가 무동작이 된다 — HTTP 는 헤더를 두 번 쓸 수 없다.
type gitWrite struct {
	s *GitServer
	w http.ResponseWriter
	r *http.Request

	// done 은 이미 응답했다는 뜻이다. 성공이든 실패든 참이 된다.
	done bool

	requested string
	root      string

	// before 는 실행 전 상태, after 는 실행 후 상태다. **두 필드로 가른다** —
	// 하나에 담으면 `apply` 뒤에 그 이름이 거짓이 되고, 부분 적용 판정이 무엇을
	// 무엇과 비교하는지 읽을 수 없다.
	before    query.Status
	gotBefore bool
	after     query.Status
}

// beginWrite 는 쓰기를 연다 — git 가용성 검사와 본문 디코드까지가 여기다.
//
// 둘 다 **모든** 쓰기가 하는 일이고, 하지 않으면 nil 역참조이거나 빈 요청으로
// 실행하는 것이다. 그래서 선택지로 두지 않는다.
func (s *GitServer) beginWrite(w http.ResponseWriter, r *http.Request, req any) *gitWrite {
	t := &gitWrite{s: s, w: w, r: r}
	if s.Git == nil {
		gitUnavailable(w)
		t.done = true
		return t
	}
	if !gitDecodeBody(w, r, req) {
		t.done = true
	}
	return t
}

// stop 은 이미 응답했는지다. 핸들러가 **자기 고유의** 검사를 끼우기 전에 묻는다 —
// 파이프라인이 대신할 수 없는 검사(이름 충돌 조회·경로 판정)가 root 를 읽기
// 때문이다.
func (t *gitWrite) stop() bool { return t.done }

// requireConfirm 은 파괴적 동작의 2단계 확인이다 (FR-GIT-89).
//
// **서버가 마지막 방어선이다** — 클라이언트만 막으면 API 직접 호출이 그대로
// 우회한다. `need` 가 거짓이면 확인을 묻지 않는다: force 가 아닌 checkout 이나
// hard 가 아닌 reset 처럼 되돌릴 것이 없는 경우다.
func (t *gitWrite) requireConfirm(need, confirmed bool, reason string) {
	if t.done || !need || confirmed {
		return
	}
	gitFail(t.w, http.StatusBadRequest, gitErrConfirmRequired, reason)
	t.done = true
}

// reject 는 실행 **전에** 걸린 오류를 공용 규약으로 답한다.
//
// 실행 전에 답하는 것이 요점이다 — `apply` 를 지나면 코드가 500 이 되고,
// 클라이언트는 자기 요청이 틀렸다는 것을 알 수 없다.
func (t *gitWrite) reject(err error) {
	if t.done || err == nil {
		return
	}
	gitError(t.w, err)
	t.done = true
}

// rejectWith 는 sentinel 이 아니라 핸들러가 코드를 정하는 거부다 (경로 판정·
// 정책 위반). 사유를 코드로 줘야 클라이언트가 무엇을 할지 정할 수 있다.
func (t *gitWrite) rejectWith(status int, code, msg string) {
	if t.done {
		return
	}
	gitFail(t.w, status, code, msg)
	t.done = true
}

// resolve 는 요청이 보낸 repo 를 정규 루트로 옮긴다 (FR-GIT-62). 클라이언트가
// 보낸 경로를 그대로 신뢰해 저장소를 바꾸지 않는다.
func (t *gitWrite) resolve(repo string) {
	if t.done {
		return
	}
	root, ok := t.s.gitResolveRepo(t.w, t.r, repo)
	if !ok {
		t.done = true
		return
	}
	t.requested, t.root = repo, root
}

// snapshot 은 실행 전 상태를 찍는다. **멱등이다** — 두 번 불러도 한 번만 찍는다.
//
// 캐시된 값을 써도 된다: 실패했을 때 무엇이 바뀌었는지를 재는 기준선이고,
// 200ms 안의 관측은 같은 기준선이다.
//
// 핸들러가 직접 부르는 것은 실행 전 판정에 이 상태가 필요할 때뿐이다
// (`gitBranchDeleteBlocked` 처럼). 그렇지 않으면 `apply` 가 알아서 부른다 —
// **"실행 전 status 를 빼먹는" 경로가 없어야** 부분 적용 판정이 성립한다.
func (t *gitWrite) snapshot() query.Status {
	if t.done || t.gotBefore {
		return t.before
	}
	before, ok := t.s.gitStatusBefore(t.w, t.r, t.root)
	if !ok {
		t.done = true
		return query.Status{}
	}
	t.before, t.gotBefore = before, true
	return before
}

// apply 는 쓰기를 실행하고 상태를 다시 찍는다.
//
// 실행 전 status 가 없으면 여기서 찍는다 — 순서 불변식이 주석이 아니라 이
// 호출에 있다. 실패하면 실행 전과 비교해 `partial` 과 무엇이 바뀌었는지를
// 응답에 담는다 (FR-GIT-73).
func (t *gitWrite) apply(run func(ctx context.Context) error) {
	if t.done {
		return
	}
	before := t.snapshot()
	if t.done {
		return
	}
	after, ok := t.s.gitApply(t.w, t.r, t.requested, t.root, before, run)
	if !ok {
		t.done = true
		return
	}
	t.after = after
}

// ok 는 성공 응답이다. **실행 후 status 를 함께 담는다** (FR-GIT-71) —
// 클라이언트가 폴링 주기를 기다리지 않는다.
//
// `apply` 가 실패했으면 무동작이다. 그래서 핸들러는 `apply` 뒤에 검사하지 않는다.
func (t *gitWrite) ok(extra map[string]any) {
	if t.done {
		return
	}
	gitWriteOK(t.w, t.requested, t.root, t.after, extra)
	t.done = true
}

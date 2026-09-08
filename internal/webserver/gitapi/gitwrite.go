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

// beginWrite 는 domain/git 이 실행하는 쓰기를 연다.
//
// 가용성 검사와 본문 디코드는 **모든** 쓰기가 하는 일이고, 하지 않으면 nil
// 역참조이거나 빈 요청으로 실행하는 것이다. 그래서 선택지로 두지 않는다.
func (s *GitServer) beginWrite(w http.ResponseWriter, r *http.Request, req any) *gitWrite {
	return s.beginServiceWrite(w, r, req, s.Git != nil, gitUnavailable)
}

// beginServiceWrite 는 `s.Git` 이 **아닌** 관리자가 실행하는 쓰기를 연다
// (DRIFT_RECLAIM_SRS FR-DRC-1).
//
// Submodules·Worktrees 는 domain/git 의 어느 화이트리스트에도 들어갈 수 없다 —
// `git submodule`·`git worktree` 는 한 하위 명령에 읽기와 쓰기가 함께 있어 어느
// 목록에 넣어도 반대쪽이 함께 열린다 (FR-GIT-95 의 교집합-금지). 그래서 그 둘은
// 자기 Manager 를 딛고, 가용성도 자기 Manager 로 판정한다.
//
// **그 차이가 파이프라인 전체를 못 쓸 이유는 아니었다.** 이전에는 `s.Git == nil`
// 이 `beginWrite` 안에 박혀 있어서 두 표면이 사다리를 통째로 복제했고, 복제본은
// 이미 갈라져 있었다 — 같은 "confirm 이 없다"가 한쪽은 `bad_request`,
// 다른 쪽은 `confirmation_required` 로 나갔다 (FR-DRC-5).
//
// `unavailable` 을 함수로 받는 이유는 사유 문구가 표면마다 다르기 때문이다 —
// "git 서비스가" 와 "서브모듈 관리자가" 는 사용자가 할 일이 다르다.
func (s *GitServer) beginServiceWrite(w http.ResponseWriter, r *http.Request, req any, available bool, unavailable func(http.ResponseWriter)) *gitWrite {
	t := &gitWrite{s: s, w: w, r: r}
	if !available {
		unavailable(w)
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

// rejectBody 는 실행 전 거부에 표면 고유의 맥락을 함께 싣는다 — `okPlain` 의 거울.
//
// 충돌 응답이 그것을 필요로 한다: "이미 있는 이름이다" 만으로는 화면이 **무엇이**
// 이미 있는지 말할 수 없어서, 사용자가 다음에 무엇을 바꿔야 하는지 모른다.
// `requested`·`repo` 는 성공 응답과 같은 자리에 둔다 — 같은 요청의 두 결말이
// 서로 다른 모양이면 클라이언트가 그 둘을 따로 읽어야 한다.
func (t *gitWrite) rejectBody(status int, code, msg string, extra map[string]any) {
	if t.done {
		return
	}
	body := map[string]any{
		"error":     code,
		"message":   msg,
		"requested": t.requested,
		"repo":      t.root,
	}
	for k, v := range extra {
		body[k] = v
	}
	gitJSON(t.w, status, body)
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

// exec 는 관리자의 조작을 실행한다 (FR-DRC-3) — `apply` 의 자매다.
//
// `apply` 와 갈라 두는 이유는 **status 왕복이 여기서 값을 벌지 않기** 때문이다.
// `apply` 는 실행 전후의 status 를 찍어 부분 적용을 판정한다 (FR-GIT-73). 그 판정은
// 작업 트리를 건드리는 쓰기에만 뜻이 있다 — 서브모듈 체크아웃 이동이나 worktree
// 생성은 부모의 status 를 그런 식으로 갈라 놓지 않는다. 판정하지 않을 값을 위해
// git 을 두 번 더 부르지 않는다.
//
// 오류 번역기를 **표면이 준다.** `gitSubmoduleError` 는 안전 가드의 거부(400)와
// 실행 실패(500)를 가르고, `gitError` 는 sentinel 등록부를 본다 — 판정이 다르므로
// 한쪽으로 접으면 다른 쪽이 틀린 코드를 내보낸다.
func (t *gitWrite) exec(run func(root string) error, fail func(http.ResponseWriter, error)) {
	if t.done {
		return
	}
	if err := run(t.root); err != nil {
		fail(t.w, err)
		t.done = true
	}
}

// invalidate 는 관측 캐시를 버린다.
//
// `apply` 는 이것을 스스로 한다 (`handlers_git_write.go:250`). `exec` 로 도는
// 쓰기는 **부모 저장소의 status 를 바꿨는지가 조작마다 다르므로** 호출을 남긴다 —
// `git submodule update` 는 체크아웃을 옮겨 부모의 status 를 바꾸고, `sync` 는
// `.git/config` 만 건드려 바꾸지 않는다. 그 차이를 파이프라인이 대신 정하면
// 한쪽이 반드시 틀린다.
//
// `s.Git` 이 없는 배선에서도 무해하게 지나간다 — 이 표면들은 `s.Git` 을 실행에
// 쓰지 않으므로 그것 없이도 돈다 (FR-GIT-246).
func (t *gitWrite) invalidate() {
	if t.done || t.s.Git == nil {
		return
	}
	t.s.Git.Invalidate(t.root)
}

// okPlain 은 status 없이 답하는 성공이다 (FR-DRC-2) — `exec` 의 종단.
//
// `ok` 와 같은 세 필드(`ok`·`repo`·`requested`)를 싣는다. `ok` 가 **클라이언트의
// 성공 판정**이고 (`panel-write.js:166` 의 `!!(r&&r.ok&&d&&d.ok)`), `requested` 는
// 늦게 온 남의 응답을 자기 것으로 읽지 않게 하는 대조 근거다 (`:185`).
//
// `status` 를 싣지 않으므로 화면의 `adopt` 는 이 응답에서 그냥 되돌아간다 — 그것이
// 맞다: 여기 담을 실행 후 status 가 없다.
func (t *gitWrite) okPlain(extra map[string]any) {
	if t.done {
		return
	}
	body := map[string]any{
		"ok":        true,
		"repo":      t.root,
		"requested": t.requested,
	}
	for k, v := range extra {
		body[k] = v
	}
	gitJSON(t.w, http.StatusOK, body)
	t.done = true
}

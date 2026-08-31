package gitapi

import (
	"context"
	"errors"
	"net/http"

	"dongminal/internal/webserver/apierr"
	"dongminal/internal/webserver/domain/git/core"
	"dongminal/internal/webserver/domain/git/query"
	"dongminal/internal/webserver/domain/git/write"
)

// /api/git/tag{,/validate,/delete,/push,/delete-remote} — 태그 표면
// (GIT_ACTIONS_SRS §3.3 FR-GIT-260~262).
//
// **목록은 /api/git/refs 다** (FR-GIT-147) — `refs/tags` 를 이미 준다. 여기에 새
// 조회를 만들지 않는다.
//
// **서버가 마지막 방어선이다.** 이름 규칙·이름 충돌·파괴적 동작의 확인을
// 클라이언트만 막으면 API 직접 호출이 그대로 우회한다 (FR-GIT-250.1·250.3).
//
// 삭제는 **두 라우트**다 (FR-GIT-261) — 로컬(`tag -d`)과 원격(`push --delete`) 은
// 하나가 다른 하나를 자동으로 하지 않는다. 원격을 지나는 둘(push·delete-remote)은
// 기존 job 경로를 그대로 탄다 (FR-GIT-101~104) — 새 실행 경로를 만들지 않는다.

// 태그 고유의 거부 코드. 상태 코드만으로는 무엇이 왜 막혔는지 구분할 수 없다.
const gitErrTagExists = apierr.CodeTagExists

// gitTagCreateReq 는 생성 다이얼로그의 본문이다 (FR-GIT-260).
type gitTagCreateReq struct {
	Repo    string `json:"repo"`
	Name    string `json:"name"`
	Ref     string `json:"ref"`
	Kind    string `json:"kind"`
	Message string `json:"message"`
}

// gitTagDeleteReq 는 로컬 삭제의 본문이다 (FR-GIT-261).
//
// Confirm 은 2단계 확인이다 (FR-GIT-89·250.1) — 파괴적 동작이므로 확인 없이는
// 실행되지 않는다.
type gitTagDeleteReq struct {
	Repo    string `json:"repo"`
	Name    string `json:"name"`
	Confirm bool   `json:"confirm"`
}

// gitTagRemoteReq 는 원격을 지나는 둘의 본문이다 (FR-GIT-261·262).
//
// Remote 가 비면 서버가 정한다 (query.DefaultRemote) — 클라이언트가 원격 이름을
// 짐작하면 origin 이 아닌 저장소에서 틀린다.
//
// **자격증명을 담는 필드가 없다** (FR-GIT-104) — 만들지 않는 것이 유일한 보장이다.
type gitTagRemoteReq struct {
	Repo    string `json:"repo"`
	Remote  string `json:"remote"`
	Name    string `json:"name"`
	All     bool   `json:"all"`
	Confirm bool   `json:"confirm"`
}

// POST /api/git/tag — 태그를 만든다 (FR-GIT-260).
func (s *GitServer) apiGitTagCreate(w http.ResponseWriter, r *http.Request) {
	var req gitTagCreateReq
	t := s.beginWrite(w, r, &req)
	t.resolve(req.Repo)
	opts := write.TagCreateOpts{Name: req.Name, Ref: req.Ref, Kind: req.Kind, Message: req.Message}
	// 잘못된 요청은 실행 **전에** 답한다. apply 를 지나면 코드가 500 이 되고,
	// 클라이언트는 자기 요청이 틀렸다는 것을 알 수 없다.
	if _, err := write.TagCreateArgs(opts); err != nil {
		t.reject(err)
	}
	// 이름 충돌은 저장소를 조회해야 안다 — 파이프라인이 대신할 수 없는 검사다.
	if t.stop() || s.gitTagNameTaken(w, r, req.Repo, t.root, req.Name) {
		return
	}
	t.apply(func(ctx context.Context) error {
		_, err := write.TagCreate(s.Git.Service(), ctx, t.root, opts)
		return err
	})
	t.ok(map[string]any{"tag": req.Name})
}

// POST /api/git/tag/delete — 로컬 태그를 지운다. **파괴적이다** (FR-GIT-89·261).
//
// `confirm:true` 가 없으면 실행하지 않는다. recovery hint 는 write 가 실행
// **전에** 남긴다 (FR-GIT-92) — 지운 뒤에는 oid 를 읽을 수 없다.
//
// **원격은 건드리지 않는다** — 그것은 다른 항목이다 (FR-GIT-261).
func (s *GitServer) apiGitTagDelete(w http.ResponseWriter, r *http.Request) {
	var req gitTagDeleteReq
	t := s.beginWrite(w, r, &req)
	t.requireConfirm(true, req.Confirm,
		"태그 삭제는 파괴적이다: confirm:true 를 요구한다 (FR-GIT-89·261)")
	if _, err := write.TagDeleteArgs(req.Name); err != nil {
		t.reject(err)
	}
	t.resolve(req.Repo)
	if t.stop() {
		return
	}
	// 없는 태그는 실행 **전에** 404 로 답한다. apply 를 지나면 코드가 500 이 되고,
	// 클라이언트는 "저장소가 고장났다" 와 "그런 태그가 없다" 를 구분할 수 없다.
	exists, err := query.TagExists(s.Git.Service(), r.Context(), t.root, req.Name)
	if err != nil {
		gitError(w, err)
		return
	}
	if !exists {
		t.rejectWith(http.StatusNotFound, gitErrNotFound, "태그 "+req.Name+" 가 없다")
		return
	}
	t.apply(func(ctx context.Context) error {
		_, err := write.TagDelete(s.Git.Service(), ctx, t.root, req.Name)
		return err
	})
	t.ok(map[string]any{"tag": req.Name})
}

// POST /api/git/tag/push — 태그 하나 또는 전부를 민다 (FR-GIT-262).
//
// 원격 작업이므로 job 경로를 탄다 — 진행·취소·인증 안내가 공짜로 따라온다.
func (s *GitServer) apiGitTagPush(w http.ResponseWriter, r *http.Request) {
	s.gitTagRemoteRoute(w, r, false, func(root string, o write.TagRemoteOpts) (core.WriteSpec, error) {
		return write.TagPushSpec(o)
	})
}

// POST /api/git/tag/delete-remote — 원격의 태그를 지운다. **파괴적이다**
// (FR-GIT-261, `remote_ref_delete`).
//
// **로컬은 건드리지 않는다** — 그것은 다른 항목이다.
func (s *GitServer) apiGitTagDeleteRemote(w http.ResponseWriter, r *http.Request) {
	s.gitTagRemoteRoute(w, r, true, func(root string, o write.TagRemoteOpts) (core.WriteSpec, error) {
		return write.TagDeleteRemoteSpec(s.Git.Service(), r.Context(), root, o)
	})
}

// GET /api/git/tag/validate?repo=&name= — 이름 규칙 검사 (FR-GIT-260).
//
// **위반을 요청 실패로 답하지 않는다.** 입력 중 부르는 엔드포인트이므로 판정은
// 200 의 본문에 담긴다 — 400 이면 클라이언트가 "규칙 위반" 과 "요청이 틀렸다" 를
// 구분할 수 없다 (branch/validate 와 같은 규약).
//
// exists 는 규칙 위반이 아니다 — 같은 이름이 이미 있다는 사실은 따로 알려야
// 클라이언트가 다른 이름을 권할 수 있다.
func (s *GitServer) apiGitTagValidate(w http.ResponseWriter, r *http.Request) {
	root, requested, ok := s.gitRepoParam(w, r)
	if !ok {
		return
	}
	name := r.URL.Query().Get("name")
	body := map[string]any{
		"requested": map[string]any{"repo": requested, "name": name},
		"repo":      root,
		"ok":        true,
		"reason":    "",
		"exists":    false,
		"kinds":     write.TagKinds,
	}
	if err := query.ValidTagName(s.Git.Service(), r.Context(), root, name); err != nil {
		if !errors.Is(err, core.ErrRefName) {
			// 이름의 문제가 아니라 저장소·git 의 문제다. 판정으로 뭉개면 사용자는
			// 이름을 고치며 헤맨다.
			gitError(w, err)
			return
		}
		body["ok"], body["reason"] = false, gitTail(err.Error())
		gitJSON(w, http.StatusOK, body)
		return
	}
	exists, err := query.TagExists(s.Git.Service(), r.Context(), root, name)
	if err != nil {
		gitError(w, err)
		return
	}
	body["exists"] = exists
	gitJSON(w, http.StatusOK, body)
}

// gitTagRemoteRoute 는 원격을 지나는 둘의 공통 절차다 (FR-GIT-261·262). 둘은 본문과
// 응답이 같고 무엇을 실행하는지와 확인을 요구하는지만 다르다.
//
// **spec 을 실행 전에 만든다** — 잘못된 요청과 없는 원격을 job 으로 넘기면 사유가
// 스트림 끝에서야 오고, 그때는 이미 확인을 지난 뒤다.
func (s *GitServer) gitTagRemoteRoute(w http.ResponseWriter, r *http.Request, confirm bool, spec func(root string, o write.TagRemoteOpts) (core.WriteSpec, error)) {
	var req gitTagRemoteReq
	t := s.beginWrite(w, r, &req)
	if t.stop() {
		return
	}
	if confirm && !req.Confirm {
		gitFail(w, http.StatusBadRequest, gitErrConfirmRequired,
			"원격 ref 삭제는 파괴적이다: confirm:true 를 요구한다 (FR-GIT-89·261)")
		return
	}
	root, ok := s.gitResolveRepo(w, r, req.Repo)
	if !ok {
		return
	}
	remote := req.Remote
	if remote == "" {
		got, err := query.DefaultRemote(s.Git.Service(), r.Context(), root)
		if err != nil {
			gitError(w, err)
			return
		}
		remote = got
	}
	sp, err := spec(root, write.TagRemoteOpts{Remote: remote, Name: req.Name, All: req.All})
	if err != nil {
		gitError(w, err)
		return
	}
	s.gitStartJob(w, req.Repo, root, "push", sp, map[string]any{"remote": remote, "tag": req.Name, "all": req.All})
}

// gitTagNameTaken 은 이름 규칙과 이름 충돌을 실행 **전에** 답한다 (FR-GIT-250.3).
//
// 참을 돌려주면 응답이 이미 쓰였다는 뜻이다.
func (s *GitServer) gitTagNameTaken(w http.ResponseWriter, r *http.Request, requested, root, name string) bool {
	if err := write.CheckNewTagName(s.Git.Service(), r.Context(), root, name); err != nil {
		if errors.Is(err, write.ErrTagExists) {
			gitJSON(w, http.StatusConflict, map[string]any{
				"error":     gitErrTagExists,
				"message":   "태그 " + name + " 가 이미 있다",
				"requested": requested,
				"repo":      root,
				"tag":       name,
			})
			return true
		}
		gitError(w, err)
		return true
	}
	return false
}

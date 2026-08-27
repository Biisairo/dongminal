package write

import (
	"context"
	"errors"
	"fmt"

	"dongminal/internal/webserver/domain/git/core"
	"dongminal/internal/webserver/domain/git/query"
)

// 태그 조작 (GIT_ACTIONS_SRS §3.3 FR-GIT-260~262).
//
// **목록을 여기서 만들지 않는다** — Refs 가 `refs/tags` 를 이미 준다 (FR-GIT-147).
// 이름 규칙·존재 확인은 조회이므로 query 에 있다 (ValidTagName·TagExists·TagOid) —
// 생성 경로가 그것을 실행 **전에** 부른다 (FR-GIT-250.3).
//
// **기본값은 항상 안전한 쪽이다** (FR-GIT-97) — `-f` 를 만들지 않는다: 기존 태그를
// 옮기는 것은 생성이 아니다.
//
// 삭제는 로컬과 원격이 **다른 함수**다 (FR-GIT-261) — 하나가 다른 하나를 자동으로
// 하지 않는다. 원격 것은 `git push` 이므로 여기서 실행하지 않고 WriteSpec 만
// 만들어 준다: 실행은 jobs 의 스트리밍 경로가 한다 (FR-GIT-101~104).

// 태그 argv 의 플래그. 상수로 못박는다 — 호출 지점마다 다른 문자열이 흩어지면
// 무엇이 붙는지 한 자리에서 볼 수 없다.
const (
	tagAnnotateFlag = "-a"
	tagSignFlag     = "-s"
	tagMessageFlag  = "-m"
	tagDeleteFlag   = "-d"
	pushDeleteFlag  = "--delete"
	pushAllTagsFlag = "--tags"
)

// 태그의 종류 (FR-GIT-260). **빈 값이 기본이며 그것이 lightweight 다** — 객체를
// 만들지 않는 쪽이 안전한 쪽이고, 메시지도 서명 키도 필요 없다.
const (
	TagLightweight = ""
	TagAnnotated   = "annotated"
	TagSigned      = "signed"
)

// TagKinds 는 다이얼로그가 제시하는 종류 전부다. **API 로 노출한다** — 클라이언트가
// 목록을 복제하면 서버가 종류를 늘려도 그것을 보이지 못한다 (BranchConflictOptions
// 와 같은 규약).
var TagKinds = []string{TagLightweight, TagAnnotated, TagSigned}

var (
	// ErrTagExists 는 같은 이름의 태그가 이미 있다는 것이다 (FR-GIT-260).
	ErrTagExists = errors.New("tag_exists")
	// ErrTagNotFound 는 그 이름의 태그가 없다는 것이다. 없는 것을 지우려는 요청은
	// 저장소·git 의 실패가 아니므로 갈라 둔다 — 500 으로 뭉개면 클라이언트는 자기
	// 요청이 틀렸다는 것을 알 수 없다.
	ErrTagNotFound = errors.New("tag_not_found")
	// ErrTagKind 는 다이얼로그가 제공하지 않는 종류다.
	ErrTagKind = errors.New("tag_kind_invalid")
	// ErrTagMessage 는 annotated·signed 인데 메시지가 없다는 것이다 — 그 둘은 태그
	// 객체를 만들고, 객체에는 메시지가 있어야 한다.
	ErrTagMessage = errors.New("tag_message_required")
	// ErrTagPushTarget 은 무엇을 밀지 정할 수 없다는 것이다 (FR-GIT-262).
	ErrTagPushTarget = errors.New("tag_push_target_invalid")
)

// TagCreateOpts 는 태그 생성 다이얼로그의 선택이다 (FR-GIT-260).
//
// Message 는 annotated·signed 에서만 뜻이 있다 — lightweight 는 객체를 만들지
// 않으므로 담을 자리가 없다.
type TagCreateOpts struct {
	Name    string `json:"name"`
	Ref     string `json:"ref"` // 비면 HEAD
	Kind    string `json:"kind"`
	Message string `json:"message"`
}

// TagRemoteOpts 는 원격을 지나는 태그 동작의 선택이다 (FR-GIT-261·262).
//
// All 은 `--tags` 다 — 태그 하나가 아니라 전부를 민다. Name 과 함께 오면 무엇을
// 밀지 가릴 수 없으므로 거부한다.
type TagRemoteOpts struct {
	Remote string `json:"remote"`
	Name   string `json:"name"`
	All    bool   `json:"all"`
}

// TagCreateArgs 는 선택을 argv 로 옮긴다. **실행하지 않는다** — 서버가 잘못된
// 요청을 실행 전에 400 으로 답할 수 있어야 하고, 판정이 두 벌이면 한쪽만 고쳐진다
// (CheckoutArgs 의 선례).
//
// 메시지는 `-m` 의 **인자**로 간다. stdin 으로 넘기지 않는다 — stdin 규약은 커밋의
// 것이고(FR-GIT-77), `git tag` 에는 그런 자리가 없다. `-m` 다음 인자는 `-` 로
// 시작해도 git 이 옵션으로 읽지 않는다 (git 2.50.1 실측).
//
// `-f` 를 붙이지 않는다 — 기존 태그를 옮기는 것은 생성이 아니다 (FR-GIT-97).
func TagCreateArgs(o TagCreateOpts) ([]string, error) {
	if err := core.CheckRefArg("name", o.Name); err != nil {
		return nil, err
	}
	if o.Ref != "" {
		if err := core.CheckRefArg("ref", o.Ref); err != nil {
			return nil, err
		}
	}
	argv := []string{"tag"}
	switch o.Kind {
	case TagLightweight:
		// 메시지는 여기서 **뜻이 없다.** 붙여 주면 사용자가 적은 것이 사라진 것도,
		// 다른 종류로 만들어진 것도 아니게 되므로 조용히 버린다 (FR-GIT-260).
	case TagAnnotated:
		argv = append(argv, tagAnnotateFlag)
	case TagSigned:
		argv = append(argv, tagSignFlag)
	default:
		return nil, fmt.Errorf("%w: %q", ErrTagKind, o.Kind)
	}
	if o.Kind != TagLightweight {
		if o.Message == "" {
			return nil, fmt.Errorf("%w: %s 태그에는 메시지가 필요하다", ErrTagMessage, o.Kind)
		}
		argv = append(argv, tagMessageFlag, o.Message)
	}
	argv = append(argv, o.Name)
	if o.Ref != "" {
		argv = append(argv, o.Ref)
	}
	return argv, nil
}

// TagDeleteArgs 는 로컬 삭제의 argv 다 (FR-GIT-261).
func TagDeleteArgs(name string) ([]string, error) {
	if err := core.CheckRefArg("name", name); err != nil {
		return nil, err
	}
	return []string{"tag", tagDeleteFlag, name}, nil
}

// TagPushArgs 는 태그를 미는 argv 다 (FR-GIT-262).
//
// 하나면 `refs/tags/<name>` 을 그대로 준다 — 이름만 주면 같은 이름의 브랜치가
// 있을 때 git 이 어느 쪽인지 되묻는다. 전부면 `--tags` 다.
func TagPushArgs(o TagRemoteOpts) ([]string, error) {
	argv, err := tagRemoteArgv(o)
	if err != nil {
		return nil, err
	}
	if o.All {
		return append(argv, pushAllTagsFlag), nil
	}
	return append(argv, query.TagRefPrefix+o.Name), nil
}

// TagDeleteRemoteArgs 는 원격 삭제의 argv 다 (FR-GIT-261). `--tags` 는 받지
// 않는다 — 한 번의 확인으로 원격의 태그 전부를 지우는 자리를 만들지 않는다.
func TagDeleteRemoteArgs(o TagRemoteOpts) ([]string, error) {
	if o.All {
		return nil, fmt.Errorf("%w: 원격 삭제는 태그 하나만 받는다", ErrTagPushTarget)
	}
	argv, err := tagRemoteArgv(o)
	if err != nil {
		return nil, err
	}
	return append(argv, pushDeleteFlag, o.Name), nil
}

// TagCreate 는 태그를 만든다 (FR-GIT-260).
//
// 이름 규칙과 같은 이름의 태그를 실행 **전에** 확인한다 (FR-GIT-250.3) —
// 클라이언트만 막으면 API 직접 호출이 우회하고, git 에 맡기면 exit 128 의 문구로만
// 알 수 있다.
func TagCreate(s *core.Service, ctx context.Context, repo string, o TagCreateOpts) (core.Output, error) {
	argv, err := TagCreateArgs(o)
	if err != nil {
		return denied(), err
	}
	if err := CheckNewTagName(s, ctx, repo, o.Name); err != nil {
		return denied(), err
	}
	return s.ExecWrite(ctx, repo, core.WriteSpec{Argv: argv})
}

// TagDelete 는 로컬 태그를 지운다. **파괴적이다** (FR-GIT-89·261).
//
// 실행 **전에** recovery hint 를 남긴다 (FR-GIT-92·250.2). 실행 후에 남기면 이미
// 지워진 태그의 oid 를 읽을 수 없고, 실패한 경로에서는 hint 가 아예 없다.
func TagDelete(s *core.Service, ctx context.Context, repo, name string) (core.Output, error) {
	argv, err := TagDeleteArgs(name)
	if err != nil {
		return denied(), err
	}
	oid, err := query.TagOid(s, ctx, repo, name)
	if err != nil {
		// 지우지 않은 것의 복구 안내는 거짓이므로 hint 도 남기지 않는다.
		return denied(), tagMissing(name, err)
	}
	s.AddHint(TagDeleteHint(repo, name, oid))
	return s.ExecWrite(ctx, repo, core.WriteSpec{Argv: argv, Destructive: true})
}

// TagPushSpec 은 태그 push 의 WriteSpec 이다 (FR-GIT-262). 파괴적이 아니다 —
// 원격에 없던 ref 를 더하는 것이므로 잃는 것이 없다.
//
// 여기서 실행하지 않는다: 원격 작업은 jobs 의 스트리밍 경로가 한다 — 진행·취소·
// 인증 안내가 그것에 이미 있다 (FR-GIT-101~104).
func TagPushSpec(o TagRemoteOpts) (core.WriteSpec, error) {
	argv, err := TagPushArgs(o)
	if err != nil {
		return core.WriteSpec{}, err
	}
	return core.WriteSpec{Argv: argv}, nil
}

// TagDeleteRemoteSpec 은 원격 태그 삭제의 WriteSpec 이다. **파괴적이다**
// (FR-GIT-261, `remote_ref_delete`).
//
// hint 는 로컬의 oid 로 만든다 — 원격이 가리키던 값을 우리가 따로 물을 수 없고,
// 로컬에 같은 태그가 있으면 그것이 되살릴 값이다. 로컬에도 없으면 **값 없이**
// 남긴다: 조용히 빈 hint 를 만들지 않고 왜 못 얻었는지를 Note 에 적는다
// (core.Hint 의 규약).
func TagDeleteRemoteSpec(s *core.Service, ctx context.Context, repo string, o TagRemoteOpts) (core.WriteSpec, error) {
	argv, err := TagDeleteRemoteArgs(o)
	if err != nil {
		return core.WriteSpec{}, err
	}
	oid, oidErr := query.TagOid(s, ctx, repo, o.Name)
	if oidErr != nil {
		oid = ""
	}
	s.AddHint(TagDeleteRemoteHint(repo, o.Remote, o.Name, oid))
	return core.WriteSpec{Argv: argv, Destructive: true}, nil
}

// CheckNewTagName 은 "이 이름으로 새 태그를 만들 수 있는가" 다 — 규칙 위반과 이름
// 충돌을 한 자리에서 본다. 서버 라우트도 이것을 부른다 (판정이 두 벌이면 한쪽만
// 고쳐진다).
func CheckNewTagName(s *core.Service, ctx context.Context, repo, name string) error {
	if err := query.ValidTagName(s, ctx, repo, name); err != nil {
		return err
	}
	exists, err := query.TagExists(s, ctx, repo, name)
	if err != nil {
		return err
	}
	if exists {
		return fmt.Errorf("%w: 태그 %q 가 이미 있다", ErrTagExists, name)
	}
	return nil
}

// TagDeleteHint 는 지워지는 태그를 되살리는 명령이다 (FR-GIT-250.2).
//
// **Values 에 oid 가 있다** — annotated 태그의 객체를 가리키므로 그 값으로 만들면
// 메시지·서명까지 그대로 돌아온다 (실측). 안내문만 남기면 되살릴 수 없다.
func TagDeleteHint(repo, name, oid string) core.Hint {
	return core.Hint{
		Repo:    repo,
		Action:  core.ActionTagDelete,
		Targets: []string{query.TagRefPrefix + name},
		Values:  []string{oid},
		Command: fmt.Sprintf("git tag %s %s", name, oid),
		Note:    "로컬 태그만 지운다 — 원격의 같은 태그는 그대로 남는다 (FR-GIT-261).",
	}
}

// TagDeleteRemoteHint 는 원격에서 지워지는 태그를 되살리는 명령이다.
//
// oid 를 못 얻었으면 **명령을 지어내지 않는다** — 실행되지 않을 명령을 남기면
// 사용자가 그것을 복구 수단으로 믿는다.
func TagDeleteRemoteHint(repo, remote, name, oid string) core.Hint {
	h := core.Hint{
		Repo:    repo,
		Action:  core.ActionRemoteRefDelete,
		Targets: []string{remote + " " + query.TagRefPrefix + name},
		Note:    "원격의 태그만 지운다 — 로컬의 같은 태그는 그대로 남는다 (FR-GIT-261).",
	}
	if oid == "" {
		h.Note = "로컬에 같은 태그가 없어 되살릴 oid 를 얻지 못했다 — 원격이 가리키던 값은 그 원격에만 있다."
		return h
	}
	h.Values = []string{oid}
	h.Command = fmt.Sprintf("git push %s %s:%s%s", remote, oid, query.TagRefPrefix, name)
	return h
}

// tagMissing 은 "그 ref 가 없다" 는 rev-parse 의 실패를 사유로 갈라 준다. 분류된
// 실패(저장소 없음·마감 초과)는 그대로 올린다 — 그것은 요청의 문제가 아니다.
func tagMissing(name string, err error) error {
	var xe *core.ExecError
	if errors.As(err, &xe) && xe.Unwrap() == nil {
		return fmt.Errorf("%w: 태그 %q 가 없다", ErrTagNotFound, name)
	}
	return err
}

// tagRemoteArgv 는 원격을 지나는 태그 동작의 공통 앞부분이다. 진행 표시를 강제하는
// 이유는 push 와 같다 — tty 가 아니면 git 이 진행을 내지 않는다 (FR-GIT-103).
func tagRemoteArgv(o TagRemoteOpts) ([]string, error) {
	if err := core.CheckRefArg("remote", o.Remote); err != nil {
		return nil, err
	}
	if o.All == (o.Name != "") {
		return nil, fmt.Errorf("%w: 태그 하나 또는 전부(--tags) 중 하나여야 한다: name=%q all=%v",
			ErrTagPushTarget, o.Name, o.All)
	}
	if o.Name != "" {
		if err := core.CheckRefArg("name", o.Name); err != nil {
			return nil, err
		}
	}
	return []string{"push", progressFlag, o.Remote}, nil
}

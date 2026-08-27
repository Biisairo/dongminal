package write

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"

	"dongminal/internal/webserver/domain/git/core"
	"dongminal/internal/webserver/domain/git/query"
)

// 묶음 C — 태그 (GIT_ACTIONS_SRS §3.3 FR-GIT-260~262, 검증 V187·V188).
//
// 목록은 여기서 다루지 않는다 — Refs 가 이미 답한다 (FR-GIT-147).

// T1 (V187, FR-GIT-260): lightweight·annotated·signed 각각의 argv 가 **다르고**,
// 메시지는 annotated·signed 에만 붙는다. 순서를 고정해 두면 테스트가 무엇을
// 실행하지 않았는가까지 볼 수 있다.
func TestTagCreateArgs_KindAndMessage(t *testing.T) {
	cases := []struct {
		name string
		o    TagCreateOpts
		want []string
	}{
		{
			"lightweight — 플래그도 메시지도 없다",
			TagCreateOpts{Name: "v1.0"},
			[]string{"tag", "v1.0"},
		},
		{
			"lightweight 는 메시지를 받아도 붙이지 않는다",
			TagCreateOpts{Name: "v1.0", Message: "뜻이 없다"},
			[]string{"tag", "v1.0"},
		},
		{
			"lightweight + 대상 커밋",
			TagCreateOpts{Name: "v1.0", Ref: "abc123"},
			[]string{"tag", "v1.0", "abc123"},
		},
		{
			"annotated",
			TagCreateOpts{Name: "v1.0", Kind: TagAnnotated, Message: "릴리스"},
			[]string{"tag", "-a", "-m", "릴리스", "v1.0"},
		},
		{
			"annotated + 대상 커밋",
			TagCreateOpts{Name: "v1.0", Kind: TagAnnotated, Message: "릴리스", Ref: "abc123"},
			[]string{"tag", "-a", "-m", "릴리스", "v1.0", "abc123"},
		},
		{
			"signed",
			TagCreateOpts{Name: "v1.0", Kind: TagSigned, Message: "서명"},
			[]string{"tag", "-s", "-m", "서명", "v1.0"},
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, err := TagCreateArgs(c.o)
			if err != nil {
				t.Fatalf("TagCreateArgs: %v", err)
			}
			if fmt.Sprint(got) != fmt.Sprint(c.want) {
				t.Fatalf("argv = %v, want %v", got, c.want)
			}
		})
	}
}

// T2 (V187·V188, FR-GIT-260·250.3): 인자로 넘기기 전에 거부되는 값들. 옵션처럼
// 생긴 이름이 통과하면 git 이 그것을 옵션으로 읽는다.
func TestTagCreateArgs_Rejects(t *testing.T) {
	cases := []struct {
		name string
		o    TagCreateOpts
		want error
	}{
		{"이름 없음", TagCreateOpts{}, core.ErrRefName},
		{"- 로 시작하는 이름", TagCreateOpts{Name: "-x"}, core.ErrRefName},
		{"범위 표현", TagCreateOpts{Name: "a..b"}, core.ErrRefName},
		{"NUL 포함", TagCreateOpts{Name: "a\x00b"}, core.ErrRefName},
		{"- 로 시작하는 대상", TagCreateOpts{Name: "v1", Ref: "-x"}, core.ErrRefName},
		{"모르는 종류", TagCreateOpts{Name: "v1", Kind: "gpg"}, ErrTagKind},
		{"annotated 인데 메시지 없음", TagCreateOpts{Name: "v1", Kind: TagAnnotated}, ErrTagMessage},
		{"signed 인데 메시지 없음", TagCreateOpts{Name: "v1", Kind: TagSigned}, ErrTagMessage},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if _, err := TagCreateArgs(c.o); !errors.Is(err, c.want) {
				t.Fatalf("err = %v, want %v", err, c.want)
			}
		})
	}
}

// T3 (V187, FR-GIT-261·262): 삭제·push 의 argv. 로컬 삭제와 원격 삭제가 **다른
// 명령**이라는 것이 여기서 드러난다 — 하나가 다른 하나를 겸하지 않는다.
func TestTagRemoteAndDeleteArgs(t *testing.T) {
	local, err := TagDeleteArgs("v1.0")
	if err != nil {
		t.Fatalf("TagDeleteArgs: %v", err)
	}
	if want := []string{"tag", "-d", "v1.0"}; fmt.Sprint(local) != fmt.Sprint(want) {
		t.Fatalf("로컬 삭제 argv = %v, want %v", local, want)
	}

	cases := []struct {
		name string
		fn   func(TagRemoteOpts) ([]string, error)
		o    TagRemoteOpts
		want []string
	}{
		{
			"태그 하나 push", TagPushArgs,
			TagRemoteOpts{Remote: "origin", Name: "v1.0"},
			[]string{"push", "--progress", "origin", "refs/tags/v1.0"},
		},
		{
			"전부 push", TagPushArgs,
			TagRemoteOpts{Remote: "origin", All: true},
			[]string{"push", "--progress", "origin", "--tags"},
		},
		{
			"원격 삭제", TagDeleteRemoteArgs,
			TagRemoteOpts{Remote: "origin", Name: "v1.0"},
			[]string{"push", "--progress", "origin", "--delete", "v1.0"},
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, err := c.fn(c.o)
			if err != nil {
				t.Fatalf("%v", err)
			}
			if fmt.Sprint(got) != fmt.Sprint(c.want) {
				t.Fatalf("argv = %v, want %v", got, c.want)
			}
		})
	}
}

// T4 (FR-GIT-262): 무엇을 밀지 정할 수 없는 요청은 거부된다. `--tags` 와 이름이
// 함께 오면 어느 쪽인지 가릴 수 없고, 원격 삭제에 `--tags` 는 **만들지 않는다** —
// 한 번의 확인으로 원격의 태그 전부를 지우는 자리를 열지 않는다.
func TestTagRemoteArgs_Rejects(t *testing.T) {
	cases := []struct {
		name string
		fn   func(TagRemoteOpts) ([]string, error)
		o    TagRemoteOpts
		want error
	}{
		{"대상 없음", TagPushArgs, TagRemoteOpts{Remote: "origin"}, ErrTagPushTarget},
		{"이름 + 전부", TagPushArgs, TagRemoteOpts{Remote: "origin", Name: "v1", All: true}, ErrTagPushTarget},
		{"원격 삭제에 전부", TagDeleteRemoteArgs, TagRemoteOpts{Remote: "origin", All: true}, ErrTagPushTarget},
		{"원격 없음", TagPushArgs, TagRemoteOpts{Name: "v1"}, core.ErrRefName},
		{"- 로 시작하는 원격", TagPushArgs, TagRemoteOpts{Remote: "-x", Name: "v1"}, core.ErrRefName},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if _, err := c.fn(c.o); !errors.Is(err, c.want) {
				t.Fatalf("err = %v, want %v", err, c.want)
			}
		})
	}
}

// T5 (V188, FR-GIT-260·250.3): 이름 검증이 **진짜 `check-ref-format --normalize`**
// 를 지나고, 중복은 실행 **전에** 거부된다. 클라이언트만 막으면 API 직접 호출이
// 우회하고, git 에 맡기면 exit 코드의 문구로만 알 수 있다.
func TestTagCreate_RejectsBeforeExecuting(t *testing.T) {
	repo := tempRepoWithTag(t, "v1.0")
	ctx := context.Background()
	cases := []struct {
		name string
		o    TagCreateOpts
		want error
	}{
		{"이름 규칙 위반 — 공백", TagCreateOpts{Name: "bad name"}, core.ErrRefName},
		{"이름 규칙 위반 — .lock 으로 끝남", TagCreateOpts{Name: "v2.lock"}, core.ErrRefName},
		{"정규화가 이름을 고친다 — 겹친 슬래시", TagCreateOpts{Name: "a//b"}, core.ErrRefName},
		{"이미 있는 이름", TagCreateOpts{Name: "v1.0"}, ErrTagExists},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			f := &writeFake{}
			s := core.New(core.WithRunner(realReader(t, repo)), core.WithWriteRunner(f.runner))
			if _, err := TagCreate(s, ctx, repo, c.o); !errors.Is(err, c.want) {
				t.Fatalf("err = %v, want %v", err, c.want)
			}
			if len(f.argvs) != 0 {
				t.Fatalf("거부됐는데 실행됐다: %v", f.argvs)
			}
		})
	}
}

// T6 (V188, FR-GIT-260): 규칙을 지키는 이름은 실제로 만들어진다 — argv 만 보면 그
// 명령이 성공하는지 알 수 없다. annotated 는 태그 **객체**가 되어야 한다.
func TestTagCreate_RealGit(t *testing.T) {
	repo := tempRepo(t)
	s := core.New()
	ctx := context.Background()

	if _, err := TagCreate(s, ctx, repo, TagCreateOpts{Name: "v1.0"}); err != nil {
		t.Fatalf("lightweight: %v", err)
	}
	if _, err := TagCreate(s, ctx, repo,
		TagCreateOpts{Name: "v2.0", Kind: TagAnnotated, Message: "두 번째"}); err != nil {
		t.Fatalf("annotated: %v", err)
	}
	for name, want := range map[string]string{"v1.0": "commit", "v2.0": "tag"} {
		out, err := s.Exec(ctx, repo, "cat-file", "-t", query.TagRefPrefix+name)
		if err != nil {
			t.Fatalf("cat-file %s: %v", name, err)
		}
		if got := strings.TrimSpace(out.Stdout); got != want {
			t.Fatalf("%s 의 객체 종류 = %q, want %q", name, got, want)
		}
	}
	// 같은 이름을 다시 만들면 **실행 전에** 거부된다 — `-f` 는 만들지 않는다.
	if _, err := TagCreate(s, ctx, repo, TagCreateOpts{Name: "v1.0"}); !errors.Is(err, ErrTagExists) {
		t.Fatalf("중복 err = %v, want ErrTagExists", err)
	}
}

// T7 (V187·V189, FR-GIT-261·89·92): 로컬 삭제는 **파괴적으로 선언되고**, recovery
// hint 가 지우기 **전의 oid** 를 싣는다. 안내문만 남으면 되살릴 수 없다.
func TestTagDelete_DestructiveWithRecoverableHint(t *testing.T) {
	repo := tempRepoWithTag(t, "v1.0")
	s := core.New()
	ctx := context.Background()

	oid, err := query.TagOid(s, ctx, repo, "v1.0")
	if err != nil {
		t.Fatalf("TagOid: %v", err)
	}
	if _, err := TagDelete(s, ctx, repo, "v1.0"); err != nil {
		t.Fatalf("TagDelete: %v", err)
	}

	recs := s.Records(0)
	last := recs[len(recs)-1]
	if !last.Destructive {
		t.Fatalf("삭제가 파괴적으로 선언되지 않았다: %v", last.Argv)
	}
	hints := s.Hints(0)
	if len(hints) != 1 {
		t.Fatalf("hint = %d개, want 1", len(hints))
	}
	h := hints[0]
	if h.Action != core.ActionTagDelete {
		t.Fatalf("action = %q, want %q", h.Action, core.ActionTagDelete)
	}
	if len(h.Values) != 1 || h.Values[0] != oid {
		t.Fatalf("hint 의 값 = %v, want [%s] — 지우기 전 oid 여야 한다", h.Values, oid)
	}
	if !strings.Contains(h.Command, oid) {
		t.Fatalf("hint 명령에 oid 가 없다: %q", h.Command)
	}

	// hint 의 명령이 **실제로 되살린다** — 되살리지 못하는 문구는 hint 가 아니다.
	gitRun(t, repo, "tag", "v1.0", oid)
	if got, err := query.TagOid(s, ctx, repo, "v1.0"); err != nil || got != oid {
		t.Fatalf("되살린 태그 = %q (%v), want %s", got, err, oid)
	}
}

// T8 (V189, FR-GIT-261): 없는 태그의 삭제는 **실행하지 않고** 사유로 갈라진다.
// 500 으로 뭉개면 클라이언트는 자기 요청이 틀렸다는 것을 알 수 없다.
func TestTagDelete_MissingTagNotExecuted(t *testing.T) {
	repo := tempRepo(t)
	f := &writeFake{}
	s := core.New(core.WithRunner(realReader(t, repo)), core.WithWriteRunner(f.runner))

	if _, err := TagDelete(s, context.Background(), repo, "nope"); !errors.Is(err, ErrTagNotFound) {
		t.Fatalf("err = %v, want ErrTagNotFound", err)
	}
	if len(f.argvs) != 0 {
		t.Fatalf("거부됐는데 실행됐다: %v", f.argvs)
	}
	if n := len(s.Hints(0)); n != 0 {
		t.Fatalf("지우지 않았는데 hint 가 %d개다 — 거짓 복구 안내다", n)
	}
}

// T9 (V189, FR-GIT-261·250.2): 원격 삭제도 파괴적으로 선언되고 hint 는 **되살리는
// push** 다. 로컬에 같은 태그가 없으면 값을 지어내지 않는다.
func TestTagDeleteRemoteSpec_HintAndDestructive(t *testing.T) {
	repo := tempRepoWithTag(t, "v1.0")
	s := core.New()
	ctx := context.Background()
	oid, err := query.TagOid(s, ctx, repo, "v1.0")
	if err != nil {
		t.Fatalf("TagOid: %v", err)
	}

	spec, err := TagDeleteRemoteSpec(s, ctx, repo, TagRemoteOpts{Remote: "origin", Name: "v1.0"})
	if err != nil {
		t.Fatalf("TagDeleteRemoteSpec: %v", err)
	}
	if !spec.Destructive {
		t.Fatalf("원격 삭제가 파괴적으로 선언되지 않았다: %v", spec.Argv)
	}
	h := s.Hints(0)[0]
	if h.Action != core.ActionRemoteRefDelete {
		t.Fatalf("action = %q, want %q", h.Action, core.ActionRemoteRefDelete)
	}
	want := "git push origin " + oid + ":refs/tags/v1.0"
	if h.Command != want {
		t.Fatalf("hint 명령 = %q, want %q", h.Command, want)
	}

	// 로컬에 없는 태그면 값을 지어내지 않는다 — 실행되지 않을 명령을 남기면
	// 사용자가 그것을 복구 수단으로 믿는다.
	if _, err := TagDeleteRemoteSpec(s, ctx, repo, TagRemoteOpts{Remote: "origin", Name: "ghost"}); err != nil {
		t.Fatalf("TagDeleteRemoteSpec(ghost): %v", err)
	}
	hints := s.Hints(0)
	if g := hints[len(hints)-1]; g.Command != "" || len(g.Values) != 0 {
		t.Fatalf("값을 모르는데 명령을 남겼다: %+v", g)
	}
}

// T10 (FR-GIT-262): push 는 파괴적이 아니다 — 원격에 없던 ref 를 더할 뿐이다.
// 여기서 파괴적으로 선언하면 확인이 늘어 사용자가 확인을 흘려 읽는다.
func TestTagPushSpec_NotDestructive(t *testing.T) {
	spec, err := TagPushSpec(TagRemoteOpts{Remote: "origin", Name: "v1.0"})
	if err != nil {
		t.Fatalf("TagPushSpec: %v", err)
	}
	if spec.Destructive {
		t.Fatalf("push 가 파괴적으로 선언됐다: %v", spec.Argv)
	}
	// 쓰기 허용 목록을 지난다 — jobs 가 같은 가드를 쓰므로 여기서 막히면 거기서도
	// 막힌다 (FR-GIT-95).
	if err := core.GuardWriteArgs(spec.Argv); err != nil {
		t.Fatalf("GuardWriteArgs: %v", err)
	}
}

// T11 (FR-GIT-260): 종류 목록은 **서버가 준다.** 클라이언트가 목록을 복제하면
// 서버가 종류를 늘려도 그것을 보이지 못한다 (BranchConflictOptions 와 같은 규약).
func TestTagKinds_Enumerated(t *testing.T) {
	want := []string{TagLightweight, TagAnnotated, TagSigned}
	if fmt.Sprint(TagKinds) != fmt.Sprint(want) {
		t.Fatalf("kinds = %v, want %v", TagKinds, want)
	}
}

// tempRepoWithTag 는 커밋 하나 + annotated 태그 하나인 저장소다. annotated 인 이유는
// 되살리기가 가장 어려운 쪽이기 때문이다 — 태그 객체를 가리키는 oid 로 되살려야
// 메시지가 남는다.
func tempRepoWithTag(t *testing.T, name string) string {
	t.Helper()
	repo := tempRepo(t)
	gitRun(t, repo, "tag", "-a", "-m", "픽스처 태그", name)
	return repo
}

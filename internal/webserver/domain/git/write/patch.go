package write

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"dongminal/internal/webserver/domain/git/core"
	"dongminal/internal/webserver/domain/git/query"
)

// 부분 스테이징 — hunk·줄 범위 (GIT_ACTIONS_SRS §3.7 FR-GIT-278·279).
//
// **패치는 서버가 만든다** (D6). 클라이언트가 만든 패치 문자열을 받아 `git apply`
// 에 넘기는 경로는 이 패키지에 없다 — 그것은 임의 쓰기 표면이다. 클라이언트가
// 보내는 것은 좌표뿐이고(경로·축·hunk 번호·줄 범위), 서버가 **자기가 방금 만든**
// diff 에서 그 조각을 잘라 패치를 짓는다.
//
// 관측이 그 사이 바뀌었으면 거부한다 — 낡은 hunk 번호로 다른 곳을 고치지 않는다.

// 부분 스테이징의 동작. 값은 클라이언트가 보내는 문자열 그대로이며 **여기 없는
// 동작은 실행되지 않는다.**
const (
	PatchStage   = "stage"   // worktree → index
	PatchUnstage = "unstage" // index → HEAD 로 되돌린다
	PatchRevert  = "revert"  // 워킹 트리의 그 줄을 버린다. **파괴적이다**
)

// 거부 사유는 열거한다 — 서버가 400·409 를 구분해 답해야 하고, 전부 500 으로
// 낮추면 클라이언트가 자기 요청이 잘못된 것인지 알 수 없다.
var (
	ErrPatchOp    = errors.New("patch_op_invalid")
	ErrPatchAxis  = errors.New("patch_axis_invalid")
	ErrPatchStale = errors.New("patch_stale")
	ErrPatchRange = errors.New("patch_range_invalid")
	ErrPatchEmpty = errors.New("patch_empty")
)

// PatchOpts 는 부분 스테이징 한 번의 요청이다.
//
// **패치·본문을 담는 필드가 없다** (D6, 검증 V204). 문자열 필드는 좌표를 가리키는
// 것뿐이며, 그 어느 것도 git 에 넘길 내용이 되지 않는다. 필드 하나가 늘어나는
// 순간 `git apply` 가 임의 쓰기 표면이 되므로 구조를 테스트로 고정한다.
type PatchOpts struct {
	Op   string
	Axis string
	Path string
	// Hunk 는 0-기반 덩어리 번호다. From·To 는 그 덩어리 **본문 안**의 1-기반 줄
	// 번호이며 둘 다 0 이면 덩어리 전체다 (FR-GIT-279).
	Hunk int
	From int
	To   int
	// DiffID 는 클라이언트가 보고 고른 관측의 식별자다. 서버가 다시 만든 diff 의
	// 값과 다르면 실행하지 않는다.
	DiffID string
}

// patchAxis 는 동작마다 **정해진** 축이다. 방향이 축에서 갈리므로 짝이 맞지 않는
// 요청은 실행 전에 거부한다 — 반대 축의 변경에 조각을 넣으면 사용자가 고르지 않은
// 것을 고친다.
var patchAxis = map[string]string{
	PatchStage:   query.AxisWorktreeIndex,
	PatchUnstage: query.AxisIndexHead,
	PatchRevert:  query.AxisWorktreeIndex,
}

// patchReverse 는 조각을 되돌려 넣는 동작이다. 되돌리는 쪽은 패치의 **새 쪽**이
// 현재 내용이므로, 고르지 않은 줄을 다루는 규칙이 뒤집힌다 (patchBody 참고).
var patchReverse = map[string]bool{
	PatchStage:   false,
	PatchUnstage: true,
	PatchRevert:  true,
}

// PatchArgs 는 동작 하나의 argv 와 파괴적 여부다. **git 을 돌리지 않는다**
// (FR-GIT-250.1) — 서버가 잘못된 요청을 실행 전에 400 으로 답할 수 있어야 하고,
// 테스트가 "무엇을 실행하지 않았는가"를 볼 수 있어야 한다.
//
// 파괴적 여부는 **동작에서 파생한다** — revert 만 참이다. stage·unstage 는 index 를
// 옮길 뿐이고 워킹 트리의 내용을 잃지 않는다.
func PatchArgs(op string) ([]string, bool, error) {
	switch op {
	case PatchStage:
		return []string{"apply", "--cached", "--whitespace=nowarn", "-"}, false, nil
	case PatchUnstage:
		return []string{"apply", "--cached", "-R", "--whitespace=nowarn", "-"}, false, nil
	case PatchRevert:
		// `--cached` 가 없다 — 워킹 트리를 되돌리는 것이고 index 는 그대로 둔다.
		return []string{"apply", "-R", "--whitespace=nowarn", "-"}, true, nil
	}
	return nil, false, fmt.Errorf("%w: %q 는 부분 스테이징의 동작이 아니다", ErrPatchOp, op)
}

// Patch 는 조각 하나를 적용한다 (FR-GIT-278·279).
//
// 순서가 뜻을 만든다: 동작·축·관측 식별자를 **git 을 돌리기 전에** 본다. diff 를
// 먼저 만들면 거부될 요청이 저장소를 읽고, 관측 식별자 검사가 뒤로 밀리면 낡은
// 번호가 다른 곳을 가리킨 채로 패치가 만들어진다.
func Patch(s *core.Service, ctx context.Context, repo string, o PatchOpts) (core.Output, error) {
	argv, destructive, err := PatchArgs(o.Op)
	if err != nil {
		return denied(), err
	}
	if want := patchAxis[o.Op]; o.Axis != want {
		return denied(), fmt.Errorf("%w: %s 는 %s 축의 동작이다 (받은 축 %q)",
			ErrPatchAxis, o.Op, want, o.Axis)
	}
	if strings.TrimSpace(o.DiffID) == "" {
		return denied(), fmt.Errorf("%w: 관측 식별자가 없다 — 무엇을 보고 고른 조각인지 알 수 없다",
			ErrPatchStale)
	}
	fd, err := query.HunksOf(s, ctx, repo, o.Axis, o.Path)
	if err != nil {
		return denied(), err
	}
	if fd.DiffID != o.DiffID {
		return denied(), fmt.Errorf("%w: 관측이 그 사이 바뀌었다 — 낡은 hunk 번호로 다른 곳을 고치지 않는다",
			ErrPatchStale)
	}
	if o.Hunk < 0 || o.Hunk >= len(fd.Hunks) {
		return denied(), fmt.Errorf("%w: hunk %d 은 %d 개 중에 없다", ErrPatchRange, o.Hunk, len(fd.Hunks))
	}
	patch, err := buildPatch(fd, fd.Hunks[o.Hunk], o.From, o.To, patchReverse[o.Op])
	if err != nil {
		return denied(), err
	}
	// 실행 **전에** hint 를 남긴다 (FR-GIT-92). 실행 후에 남기면 실패한 경로에서
	// hint 가 없고, 사용자는 무엇을 잃었는지조차 알 수 없다.
	if destructive {
		s.AddHint(patchHint(repo, fd.Path))
	}
	return s.ExecWrite(ctx, repo, core.WriteSpec{Argv: argv, Destructive: destructive, Stdin: patch})
}

// buildPatch 는 덩어리 하나짜리 패치를 짓는다. 머리는 서버가 만든 diff 의 것을
// 그대로 쓰고, 본문만 고른 범위로 다시 센다.
//
// 시작 줄 번호는 **원본 그대로** 둔다. 앞선 덩어리를 적용하지 않았으므로 옛 쪽의
// 시작은 그대로이고, 되돌려 넣을 때 git 이 보는 새 쪽의 시작도 그대로다.
func buildPatch(fd query.FileDiff, h query.Hunk, from, to int, reverse bool) (string, error) {
	sel, err := patchSelect(h, from, to)
	if err != nil {
		return "", err
	}
	body, oldN, newN, changed := patchBody(h, sel, reverse)
	if changed == 0 {
		return "", fmt.Errorf("%w: 고른 범위에 바뀐 줄이 없다", ErrPatchEmpty)
	}
	var b strings.Builder
	for _, l := range fd.Preamble {
		b.WriteString(l)
		b.WriteByte('\n')
	}
	fmt.Fprintf(&b, "@@ -%d,%d +%d,%d @@\n", h.OldStart, oldN, h.NewStart, newN)
	for _, l := range body {
		b.WriteString(l)
		b.WriteByte('\n')
	}
	return b.String(), nil
}

// patchSelect 는 고른 줄을 판정하는 함수다. 번호는 덩어리 본문 안의 1-기반이며,
// 둘 다 0 이면 덩어리 전체다.
//
// 뒤집힌 범위와 범위 밖 번호는 **실행 전에** 거부한다 — 조용히 잘라 맞추면
// 사용자가 고르지 않은 줄이 들어간다.
func patchSelect(h query.Hunk, from, to int) (func(int) bool, error) {
	if from == 0 && to == 0 {
		return func(int) bool { return true }, nil
	}
	n := len(h.Lines)
	if from < 1 || to < from || to > n {
		return nil, fmt.Errorf("%w: 줄 범위 %d~%d 은 %d 줄짜리 덩어리에 없다", ErrPatchRange, from, to, n)
	}
	return func(i int) bool { return i >= from && i <= to }, nil
}

// patchBody 는 고른 줄만 남긴 본문과 양쪽 줄 수다.
//
// **고르지 않은 줄의 처리가 방향에 따라 뒤집힌다.** 패치가 적용되는 쪽의 내용이
// 온전해야 git 이 자리를 찾기 때문이다:
//
//   - 그대로 넣을 때(stage)는 옛 쪽이 현재 내용이다. 고르지 않은 `+` 는 현재
//     내용에 없으므로 **뺀다**. 고르지 않은 `-` 는 남아야 하므로 **문맥으로** 바꾼다.
//   - 되돌려 넣을 때(unstage·revert)는 새 쪽이 현재 내용이다. 규칙이 뒤집힌다 —
//     고르지 않은 `-` 를 빼고, 고르지 않은 `+` 를 문맥으로 바꾼다.
func patchBody(h query.Hunk, sel func(int) bool, reverse bool) (body []string, oldN, newN, changed int) {
	drop, keep := byte(query.HunkAddMark), byte(query.HunkDelMark)
	if reverse {
		drop, keep = keep, drop
	}
	kept := false
	for i, l := range h.Lines {
		if l == "" {
			continue
		}
		mark := l[0]
		// `\ No newline at end of file` 은 앞 줄에 딸린 표식이다. 앞 줄을 뺐으면
		// 함께 뺀다 — 남기면 없는 줄에 대한 표식이 된다.
		if mark == query.HunkNoNewline {
			if kept {
				body = append(body, l)
			}
			continue
		}
		switch {
		case mark == query.HunkContextMark:
			body, oldN, newN, kept = append(body, l), oldN+1, newN+1, true
		case sel(i + 1):
			body, changed, kept = append(body, l), changed+1, true
			if mark == query.HunkDelMark {
				oldN++
			} else {
				newN++
			}
		case mark == drop:
			kept = false
		default: // mark == keep
			body, oldN, newN, kept = append(body, string(query.HunkContextMark)+l[1:]), oldN+1, newN+1, true
		}
	}
	return body, oldN, newN, changed
}

// patchHint 는 revert 의 recovery hint 다 (FR-GIT-92·250.2).
//
// **되살릴 수 있는 명령을 준다** — 워킹 트리의 그 줄은 git 에 저장된 적이 없어
// 사후에 되살릴 값이 없으므로, hint 는 **버리기 전에** 실행할 명령이다. discard 의
// 선례와 같은 어휘이며 자동 실행하지 않는다.
func patchHint(repo, path string) core.Hint {
	return core.Hint{
		Repo:    repo,
		Action:  core.ActionDiscard,
		Targets: []string{path},
		Command: "git stash push -- " + patchShQuote(path),
		Note: "고른 줄의 워킹 트리 내용은 git 에 저장된 적이 없어 되살릴 값이 없다. " +
			"버리기 전에 위 명령을 실행하면 stash 로 남는다.",
	}
}

// patchShQuote 는 경로를 셸에 그대로 붙여넣을 수 있게 감싼다. hint 는 사용자가
// 터미널에 붙여넣는 것이므로 공백·따옴표가 든 경로에서 명령이 깨지면 안 된다.
func patchShQuote(p string) string {
	return "'" + strings.ReplaceAll(p, "'", `'\''`) + "'"
}

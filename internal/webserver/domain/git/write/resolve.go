package write

import (
	"context"
	"fmt"
	"strings"

	"dongminal/internal/webserver/domain/git/core"
)

// 충돌 파일을 한쪽으로 해결한다 (FR-GIT-224).
//
// **`ours`/`theirs` 의 뜻은 진행 중인 조작에 따라 뒤집힌다.** merge 중에는 ours 가
// 현재 브랜치이지만 rebase 중에는 ours 가 올려놓는 대상이고 내 커밋이 theirs 다.
// 여기서는 git 의 낱말을 그대로 전달하고, 어느 쪽인지 밝히는 것은 화면의 일이다.
const (
	ResolveOurs   = "ours"
	ResolveTheirs = "theirs"
)

// ResolveResult 는 경로 하나의 해결 결과다 (REPO_FIX 01 §7.4).
type ResolveResult struct {
	Path    string `json:"path"`
	OK      bool   `json:"ok"`
	Skipped bool   `json:"skipped,omitempty"`
	Error   string `json:"error,omitempty"`
	// Err 는 분류(index_locked 등)를 위한 원래 오류다. 응답에는 싣지 않는다.
	Err error `json:"-"`
}

// 충돌 stage 번호 (git index: 1=base, 2=ours, 3=theirs).
const (
	stageOurs   = "2"
	stageTheirs = "3"
)

// Resolve 는 충돌 파일들을 한쪽 내용으로 받고 해결됨으로 표시한다.
//
// **경로마다 따로 실행한다** (REPO_FIX 01 §7.4). 한 경로의 실패가 배치의 다른
// 경로를 막지 않고, 결과는 경로별로 돌려준다. 오류는 실행 전 검증 실패와 stage
// 조회 실패뿐이다.
//
// 경로마다: 선택한 쪽의 stage 가 없으면(그쪽이 지웠다 — UD 의 theirs, DU 의 ours,
// DD) `git rm`, 있으면 `checkout --<side>` + `add`. 실측(git 2.50.1):
// `checkout --ours` 는 워킹 트리만 바꾸고 unmerged stage 를 두므로 `add` 가
// 뒤따라야 해결이 된다. 지운 쪽을 고르면 `checkout` 이 "does not have their
// version" 으로 실패했다.
//
// ctx 가 끝나면(쓰기 단계 마감) 남은 경로는 실행하지 않고 Skipped 로 싣는다.
func Resolve(s *core.Service, ctx context.Context, repo, side string, paths Paths) ([]ResolveResult, error) {
	if side != ResolveOurs && side != ResolveTheirs {
		return nil, fmt.Errorf("%w: 알 수 없는 side: %q", core.ErrUnsafeArgument, side)
	}
	cp, err := checkPaths(paths)
	if err != nil {
		return nil, err
	}
	stages, err := unmergedStages(s, ctx, repo, cp)
	if err != nil {
		return nil, err
	}
	// 실행 **전에** 남긴다 (FR-GIT-92). 실행 후에 남기면 실패한 경로에서 hint 가
	// 없고, 사용자는 무엇을 잃었는지조차 알 수 없다.
	s.AddHint(resolveHint(repo, side, cp))

	want := stageOurs
	if side == ResolveTheirs {
		want = stageTheirs
	}
	results := make([]ResolveResult, 0, len(cp))
	for _, p := range cp {
		r := ResolveResult{Path: p}
		if ctx.Err() != nil {
			r.Skipped, r.Error = true, "시간 초과로 실행하지 않음"
			results = append(results, r)
			continue
		}
		st, conflicted := stages[p]
		if conflicted && !st[want] {
			r.Err = resolveRemove(s, ctx, repo, p)
		} else {
			r.Err = resolveCheckout(s, ctx, repo, side, p)
		}
		r.OK = r.Err == nil
		if r.Err != nil {
			r.Error = r.Err.Error()
		}
		results = append(results, r)
	}
	return results, nil
}

// resolveCheckout 은 한쪽 내용을 받고 해결됨으로 표시한다. checkout 은
// 파괴적이다 — 워킹 트리의 충돌 표식과 손댄 내용이 사라지고 git 에 저장된 적이
// 없어 되살릴 값이 없다 (FR-GIT-95, 해석 I5). 받아 오지 못하면 add 하지 않는다 —
// 충돌이 조용히 사라진다.
func resolveCheckout(s *core.Service, ctx context.Context, repo, side, p string) error {
	if _, err := s.ExecWrite(ctx, repo, core.WriteSpec{Argv: []string{"checkout", "--" + side, pathsSep, p}, Destructive: true}); err != nil {
		return err
	}
	_, err := s.ExecWrite(ctx, repo, core.WriteSpec{Argv: []string{"add", pathsSep, p}})
	return err
}

// resolveRemove 는 선택한 쪽이 지운 경로를 지우고 해결됨으로 표시한다.
func resolveRemove(s *core.Service, ctx context.Context, repo, p string) error {
	_, err := s.ExecWrite(ctx, repo, core.WriteSpec{Argv: []string{"rm", "-q", pathsSep, p}, Destructive: true})
	return err
}

// unmergedStages 는 경로별로 존재하는 충돌 stage 집합이다. 충돌이 아닌 경로는
// 맵에 없다.
func unmergedStages(s *core.Service, ctx context.Context, repo string, paths Paths) (map[string]map[string]bool, error) {
	argv := append([]string{"ls-files", "-u", "-z", pathsSep}, paths...)
	out, err := s.Exec(ctx, repo, argv...)
	if err != nil {
		return nil, err
	}
	stages := map[string]map[string]bool{}
	for _, rec := range strings.Split(out.Stdout, "\x00") {
		// "<mode> <oid> <stage>\t<path>"
		meta, path, ok := strings.Cut(rec, "\t")
		if !ok {
			continue
		}
		fields := strings.Fields(meta)
		if len(fields) != 3 {
			continue
		}
		if stages[path] == nil {
			stages[path] = map[string]bool{}
		}
		stages[path][fields[2]] = true
	}
	return stages, nil
}

// resolveHint 는 무엇을 잃는지 적는다 (FR-GIT-92).
//
// **Values 는 비어 있다.** 충돌 표식이 든 워킹 트리 파일은 git 에 저장된 적이
// 없어 되살릴 값이 없다 — discard 와 같은 성질이다. 대신 되돌리는 방법을 적는다:
// `git checkout -m -- <path>` 가 충돌 상태를 다시 만든다.
func resolveHint(repo, side string, paths Paths) core.Hint {
	return core.Hint{
		Repo:    repo,
		Action:  core.ActionResolveSide,
		Targets: append([]string(nil), paths...),
		Note: fmt.Sprintf(
			"%s 쪽 내용으로 덮고 해결됨으로 표시한다. 충돌 표식과 손대던 내용은 git 에 저장된 적이 없어 되살릴 값이 없다. "+
				"충돌 상태로 되돌리려면 `git checkout -m -- <경로>` 다.", side),
	}
}

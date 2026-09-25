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
// 경로마다: 선택한 쪽의 stage 가 없으면(그쪽이 지웠다 — UD 의 theirs, DU 의 ours,
// DD) `git rm`, 있으면 `checkout --<side>` + `add`. 실측(git 2.50.1):
// `checkout --ours` 는 워킹 트리만 바꾸고 unmerged stage 를 두므로 `add` 가
// 뒤따라야 해결이 된다. 지운 쪽을 고르면 `checkout` 이 "does not have their
// version" 으로 실패했다.
//
// **경로를 묶어 실행한다** (OPTIMIZE_REFACTOR_SRS FR-OPT-7-3, REPO_FIX 01 §7.4 개정).
//
//	이전 동작: 경로마다 checkout·add 를 따로 띄웠다 — N 경로면 2N 프로세스
//	새  동작: checkout 묶음·add 묶음·rm 묶음(상한 MaxPathsPerCall 단위)이다. 묶음이
//	          경로 때문에 실패하면(분류되지 않은 종료) **그 묶음만** 경로별로 다시
//	          실행한다
//	이유:     결과는 여전히 경로별이고 한 경로의 실패가 다른 경로를 막지 않는다 —
//	          git 의 checkout·rm 은 경로 하나가 틀리면 아무것도 쓰지 않고 실패하므로
//	          다시 실행해도 두 번 적용되지 않는다
//
// 분류된 실패(index.lock·마감 초과)는 경로의 문제가 아니므로 다시 실행하지 않고 그
// 묶음의 경로 모두에 싣는다. ctx 가 끝나면(쓰기 단계 마감) 남은 묶음은 실행하지
// 않고 Skipped 로 싣는다. 오류는 실행 전 검증 실패와 stage 조회 실패뿐이다.
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
	var checkout, remove []int
	for i, p := range cp {
		if st, conflicted := stages[p]; conflicted && !st[want] {
			remove = append(remove, i)
		} else {
			checkout = append(checkout, i)
		}
	}
	results := make([]ResolveResult, len(cp))
	for i, p := range cp {
		results[i] = ResolveResult{Path: p}
	}
	r := resolver{s: s, ctx: ctx, repo: repo, side: side, paths: cp, results: results}
	r.run(checkout, r.checkoutAll, func(p string) error { return resolveCheckout(s, ctx, repo, side, p) })
	r.run(remove, r.removeAll, func(p string) error { return resolveRemove(s, ctx, repo, p) })
	return results, nil
}

// resolver 는 Resolve 한 번의 묶음 실행 상태다.
type resolver struct {
	s       *core.Service
	ctx     context.Context
	repo    string
	side    string
	paths   Paths
	results []ResolveResult
}

// run 은 인덱스 묶음을 상한 단위로 실행한다. batch 가 묶음 하나를, single 이 경로
// 하나를 실행한다.
func (r *resolver) run(idx []int, batch func(Paths) error, single func(string) error) {
	for len(idx) > 0 {
		n := min(len(idx), MaxPathsPerCall)
		chunk := idx[:n]
		idx = idx[n:]
		if r.ctx.Err() != nil {
			for _, i := range chunk {
				r.results[i].Skipped, r.results[i].Error = true, "시간 초과로 실행하지 않음"
			}
			continue
		}
		ps := make(Paths, len(chunk))
		for j, i := range chunk {
			ps[j] = r.paths[i]
		}
		err := batch(ps)
		// 경로 하나 때문에 실패한 묶음만 경로별로 다시 실행한다. 경로가 하나면 다시
		// 실행해도 같은 답이다.
		if _, plain := core.PlainExit(err); plain && len(chunk) > 1 && r.ctx.Err() == nil {
			for _, i := range chunk {
				r.set(i, single(r.paths[i]))
			}
			continue
		}
		for _, i := range chunk {
			r.set(i, err)
		}
	}
}

func (r *resolver) set(i int, err error) {
	r.results[i].Err, r.results[i].OK = err, err == nil
	if err != nil {
		r.results[i].Error = err.Error()
	}
}

// checkoutAll 은 묶음의 경로들에 한쪽 내용을 받고 해결됨으로 표시한다. checkout
// 묶음이 성공하고 add 묶음이 경로 때문에 실패하면, 경로별 재실행이 checkout 까지
// 다시 하지만 같은 쪽의 같은 내용이므로 결과는 같다.
func (r *resolver) checkoutAll(ps Paths) error {
	if _, err := r.s.ExecWrite(r.ctx, r.repo, core.WriteSpec{Argv: append([]string{"checkout", "--" + r.side, pathsSep}, ps...), Destructive: true}); err != nil {
		return err
	}
	_, err := r.s.ExecWrite(r.ctx, r.repo, core.WriteSpec{Argv: append([]string{"add", pathsSep}, ps...)})
	return err
}

func (r *resolver) removeAll(ps Paths) error {
	_, err := r.s.ExecWrite(r.ctx, r.repo, core.WriteSpec{Argv: append([]string{"rm", "-q", pathsSep}, ps...), Destructive: true})
	return err
}

// resolveCheckout 은 한쪽 내용을 받고 해결됨으로 표시한다 (경로 하나 — 묶음이
// 실패했을 때의 재실행). checkout 은 파괴적이다 — 워킹 트리의 충돌 표식과 손댄
// 내용이 사라지고 git 에 저장된 적이 없어 되살릴 값이 없다 (FR-GIT-95, 해석 I5).
// 받아 오지 못하면 add 하지 않는다 — 충돌이 조용히 사라진다.
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

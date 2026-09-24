package gitapi

import (
	"context"

	"dongminal/internal/webserver/domain/git/core"
	"dongminal/internal/webserver/domain/git/jobs"
	"dongminal/internal/webserver/domain/git/query"
)

// REPO_FIX 01 §5.2·6 — 느린 쓰기를 잡으로 돌린다 (사용자 결정).
//
// 잡을 여는 종단은 사전 단계(잠금 안)까지만 동기다: 이름 충돌·부모 판정·preflight·
// before 스냅샷을 마치고 등록하면 200 `{requested, repo, job}` 으로 곧바로 답한다.
// 실행 전 거부(4xx)는 여전히 동기다. 결과(쓰기 이후 status·partial·undo 토큰)는
// 잡의 완료 처리가 `result` 에 싣는다.

// usesIndex 는 kind 가 index 칸을 쓰는가다 — 결과에 status 를 실을 잡이다.
func usesIndex(kind string) bool {
	for _, slot := range jobs.SlotsOf(kind) {
		if slot == jobs.SlotIndex {
			return true
		}
	}
	return false
}

// startWriteJob 은 index 잡을 연다. extra 는 kind 고유의 완료 처리(⑦ — 커밋의 undo
// 토큰)이고, hint 는 등록이 **성공한 뒤에만** 남긴다 — 사전 단계는 부작용이 없다
// (§5.1). 실행이 시작되지 않은 잡의 복구 안내는 거짓이다.
func (t *gitWrite) startWriteJob(spec core.WriteSpec, before query.Status, extra jobs.Finisher, hint *core.Hint) {
	if t.done || len(spec.Argv) == 0 {
		return
	}
	finish := jobs.OnFinish(t.s.indexFinisher(t.root, before, extra))
	t.launchJob(func(h *jobs.Jobs, k jobs.Keys) (*jobs.Job, error) {
		jb, err := h.Start(t.root, k, spec.Argv[0], spec, finish)
		if err == nil && hint != nil {
			t.s.Git.Service().AddHint(*hint)
		}
		return jb, err
	}, nil)
}

// indexFinisher 는 index 잡의 완료 처리 ④(재조회)와 kind 고유의 ⑦ 이다 (§6.3).
// ③ 무효화는 허브의 공용 훅이 먼저 했다. 루트가 이미 끝났으면(종료 중) 재조회를
// 건너뛴다 — 종료 7s 상한이 우선이다.
//
// 완료 처리의 실패는 잡의 성패를 바꾸지 않는다 — `statusError` 로만 싣는다.
func (s *GitServer) indexFinisher(root string, before query.Status, extra jobs.Finisher) jobs.Finisher {
	return func(ctx context.Context, jb *jobs.Job) {
		if ctx.Err() != nil {
			return
		}
		res := &jobs.Result{}
		obs, _, err := s.Git.Status(ctx, root)
		if err != nil {
			res.StatusError = gitTail(err.Error())
		} else {
			st := obs.Status
			res.Status = &st
			if jb.Err != "" {
				if changed := gitStatusDelta(before, st); len(changed) > 0 {
					res.Partial, res.Changed = true, changed
				}
			}
		}
		jb.Result = res
		if extra != nil {
			extra(ctx, jb)
		}
	}
}

// jobSucceeded 는 잡이 exit 0 으로 끝났는가다.
func jobSucceeded(jb *jobs.Job) bool { return jb.Err == "" && jb.ExitCode == 0 }

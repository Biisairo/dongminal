package main

import (
	"context"
	"fmt"

	"dongminal/internal/webserver/domain/git/query"
	"dongminal/internal/webserver/domain/git/store"
	"dongminal/internal/webserver/domain/lsp"
)

// lspRepoView 는 lsp.RepoWatch 가 딛는 git 관측이다 (CODEMIRROR_MIGRATION_SRS §11.6 W).
// lsp 는 git 을 모른다 — 두 도메인을 여기서 잇는다.
type lspRepoView struct{ st *store.Store }

// Snapshot 은 마지막 유효 관측이다 — gitwatch 가 git_changed 를 내기 직전에 관측한 값이다.
// 새 파일은 미추적이거나 index 에 추가(`A`)된 것이다. 디렉터리 항목(중첩 저장소·서브모듈)은 뺀다.
func (v lspRepoView) Snapshot(repo string) (lsp.RepoSnap, bool) {
	obs, ok := v.st.Observed(repo)
	if !ok {
		return lsp.RepoSnap{}, false
	}
	s := obs.Status
	files := map[string]bool{}
	for _, group := range [][]query.FileEntry{s.Staged, s.Changes, s.Untracked, s.Conflicts} {
		for _, e := range group {
			if e.Dir {
				continue
			}
			isNew := e.Untracked || (len(e.XY) > 0 && e.XY[0] == 'A')
			files[e.Path] = files[e.Path] || isNew
			if e.OrigPath != "" {
				files[e.OrigPath] = files[e.OrigPath] || false
			}
		}
	}
	return lsp.RepoSnap{Head: s.Oid, Files: files}, true
}

// NameStatus 는 두 커밋 사이의 바뀐 파일이다 (`diff-tree --name-status -r -z -M`).
func (v lspRepoView) NameStatus(ctx context.Context, repo, from, to string) ([]lsp.NameStatus, error) {
	out, err := v.st.Service().Exec(ctx, repo, "diff-tree", "--no-commit-id", "--name-status", "-r", "-z", "-M", from, to)
	if err != nil {
		return nil, err
	}
	if out.ExitCode != 0 {
		return nil, fmt.Errorf("git diff-tree %s %s: exit %d: %s", from, to, out.ExitCode, out.Stderr)
	}
	if out.StdoutTruncated {
		return nil, fmt.Errorf("git diff-tree %s %s: 출력이 상한에서 잘렸다", from, to)
	}
	files, err := query.ParseNameStatusZ(out.Stdout)
	if err != nil {
		return nil, err
	}
	ns := make([]lsp.NameStatus, 0, len(files))
	for _, f := range files {
		ns = append(ns, lsp.NameStatus{Status: f.Status, Path: f.Path, OrigPath: f.OrigPath})
	}
	return ns, nil
}

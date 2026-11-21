package write

import "dongminal/internal/webserver/domain/git/core"

// 되돌림 안내 (FR-GIT-92). 파괴적 브랜치 조작이 실행 전에 남기는 "되살리는 명령"이다.

// branchDeleteHint 는 지워질 브랜치의 oid 로 **되살리는 명령**을 만든다
// (FR-GIT-92·250.2). 안내문만 남기면 되살릴 수 없다.
func branchDeleteHint(repo, name, oid string) core.Hint {
	return core.Hint{
		Repo:    repo,
		Action:  core.ActionBranchDelete,
		Targets: []string{name},
		Values:  []string{oid},
		Command: "git branch " + name + " " + oid,
		Note:    "지우기 전 " + name + " 는 " + oid + " 를 가리켰다. 위 명령이 그 자리로 되돌린다.",
	}
}

// rebaseHint 는 rebase 전 HEAD 로 되돌리는 명령이다 (FR-GIT-256). 커밋 해시가
// 바뀌므로 원래 oid 없이는 reflog 를 뒤져야 한다.
func rebaseHint(repo string, o RebaseOpts, head string) core.Hint {
	target := o.Ref
	if o.Onto != "" {
		target = o.Onto + " ← " + o.Ref
	}
	return core.Hint{
		Repo:    repo,
		Action:  core.ActionRebase,
		Targets: []string{target},
		Values:  []string{head},
		Command: "git reset --hard " + head,
		Note:    "rebase 전 HEAD 는 " + head + " 였다. 커밋 해시가 바뀌므로 위 명령이 유일한 되돌림이다.",
	}
}

// remoteBranchDeleteHint 는 지워질 원격 ref 를 되살리는 push 다 (FR-GIT-268).
func remoteBranchDeleteHint(repo string, o RemoteBranchOpts, oid string) core.Hint {
	return core.Hint{
		Repo:    repo,
		Action:  core.ActionRemoteRefDelete,
		Targets: []string{o.Remote + "/" + o.Branch},
		Values:  []string{oid},
		Command: "git push " + o.Remote + " " + oid + ":refs/heads/" + o.Branch,
		Note:    "지우기 전 " + o.Remote + "/" + o.Branch + " 는 " + oid + " 였다. 위 명령이 원격에 그 ref 를 다시 만든다.",
	}
}

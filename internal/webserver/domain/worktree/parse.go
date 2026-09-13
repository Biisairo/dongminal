package worktree

import (
	"path/filepath"
	"strings"
)

// Entry 는 `git worktree list` 한 줄이다 (FR-GIT-240). 화면이 보일 최소 정보만
// 남긴다 — 경로·브랜치(또는 detached)·main 여부. 소유(사용자/Run/바깥) 판정은 이
// 패키지가 Run 을 모르므로(패키지 doc 참고) 호출자의 일이다.
type Entry struct {
	Path     string
	Branch   string
	Detached bool
	// Main 은 이 항목이 git 의 main worktree(저장소를 clone·init 한 자리)인지다
	// (V162). **파싱 순서에서 낸다** — "조회에 쓴 경로와 같다"로 판정하지 않는다.
	// 후자는 main worktree 를 링크드 worktree 에서 조회하면(예: 사용자가 그 링크드
	// worktree 를 활성 리포로 열고 다시 조회하면) 판정이 조회 대상을 따라 옮겨간다 —
	// "main" 배지가 탐색 위치를 따라다니는 결함이었다.
	Main bool
}

// parseWorktreeList 는 porcelain 출력을 해석한다. 레코드는 빈 줄로 갈린다 —
// `worktree <path>` 로 시작하고 `HEAD <sha>`·`branch <ref>`(또는 `detached`)가
// 뒤따른다 (git worktree add --help, PORCELAIN FORMAT).
//
// **첫 레코드가 main worktree 다 (Entry.Main, V162).** 근거는 git-worktree(1)
// 매뉴얼의 list 절 — "The main worktree is listed first, followed by each of the
// linked worktrees." — 이며, 이 파일이 실측으로도 확인한다
// (TestList_MainIsAlwaysFirstEntry). 순서에 의존한다는 사실을 여기 명시적으로
// 적어 두는 이유는, 예전에 "조회 대상 경로와 같다"로 판정했다가 링크드 worktree
// 를 활성 리포로 열면 main 배지가 그리로 옮겨가던 결함을 겪었기 때문이다 — 근거
// 없이 가정을 재도입하는 사고가 다시 나지 않게 한다.
func parseWorktreeList(out string) []Entry {
	var entries []Entry
	var cur *Entry
	flush := func() {
		if cur != nil {
			entries = append(entries, *cur)
			cur = nil
		}
	}
	for _, ln := range strings.Split(out, "\n") {
		ln = strings.TrimRight(ln, "\r")
		switch {
		case ln == "":
			flush()
		case strings.HasPrefix(ln, "worktree "):
			flush()
			cur = &Entry{Path: normalizeGitPath(strings.TrimPrefix(ln, "worktree ")), Main: len(entries) == 0}
		case ln == "detached":
			if cur != nil {
				cur.Detached = true
			}
		case strings.HasPrefix(ln, "branch "):
			if cur != nil {
				cur.Branch = strings.TrimPrefix(strings.TrimPrefix(ln, "branch "), "refs/heads/")
			}
		}
	}
	flush()
	return entries
}

// normalizeGitPath 는 git 이 낸 경로를 **OS 형태로** 옮긴다 (FR-WTP-3).
//
// Windows 의 git 은 `C:/Users/x` 처럼 드라이브 문자에 슬래시를 붙여 낸다. 이
// 저장소의 다른 모든 경로는 `filepath` 가 만든 OS 형태(`C:\Users\x`)다. 두
// 형태가 섞이면 문자열 비교가 조용히 어긋난다 — `gone` 의 `e.Path == path`
// 와 `gitWorktreeOwner` 의 접두사 판정이 그 자리다. 그러면 Windows 에서
// worktree 소유가 전부 "outside" 로 떨어지고, 살아 있는 worktree 를 사라졌다고
// 본다.
//
// 정규화를 **파싱 경계 한 곳**에 두는 이유는 FR-GIT-246 과 같다 — 소비처마다
// 옮기면 한 곳이 빠지고, 빠진 곳은 조용하다. POSIX 에서는 아무 변화가 없다.
func normalizeGitPath(p string) string {
	if strings.TrimSpace(p) == "" {
		return p
	}
	return filepath.Clean(p)
}

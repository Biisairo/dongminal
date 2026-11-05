// Package action 은 동작 하나에 대한 서버의 답이다 (SERVER_DRIVEN_ACTIONS_SRS 묶음 M).
//
// 화면은 버튼을 켤지 끌지를 스스로 정하지 않는다 — 서버가 "할 수 있는가 · 못 하면
// 왜" 를 답하고 화면은 그것을 그린다 (D-SDA-1). 답과 실행 거절은 같은 판정 함수에서
// 나온다 (D-SDA-6). 이 패키지는 그 답의 모양과, 동작마다 낼 수 있는 사유의 목록을
// 갖는다. 판정 자체는 각 표면(gitapi 등)에 있다.
package action

import (
	"regexp"
	"sort"
)

// Answer 는 동작 하나의 답이다 (FR-SDA-1).
type Answer struct {
	OK bool `json:"ok"`
	// Why 는 사유 **코드**다 — apierr 의 와이어 코드와 같은 값이다 (FR-SDA-2 · M-1).
	Why  string         `json:"why,omitempty"`
	Args map[string]any `json:"args,omitempty"`
	// Status 는 실행 요청을 거절할 때의 상태다 (409 상태 때문 · 400 입력 때문).
	// 답 종단에는 나가지 않는다.
	Status int `json:"-"`
}

// Allow 는 할 수 있다는 답이다.
func Allow() Answer { return Answer{OK: true} }

// Deny 는 할 수 없다는 답이다.
func Deny(status int, why string, args map[string]any) Answer {
	return Answer{Why: why, Args: args, Status: status}
}

// First 는 거짓인 첫 답이고, 모두 참이면 허용이다. 판정이 여럿 겹친 동작(칸 → 상태
// 사실)이 실행 종단과 같은 순서로 묻는다 (GR-2a).
func First(as ...Answer) Answer {
	for _, a := range as {
		if !a.OK {
			return a
		}
	}
	return Allow()
}

// WhyLoading 은 첫 답이 오기 전의 사유다 (FR-SDA-6). 서버가 내지 않고 화면이 쓰지만,
// 문구가 있어야 하는 것은 같으므로 게이트가 함께 본다.
const WhyLoading = "loading"

// 동작 ID (§1.3).
const (
	GitStashCreate = "git.stash.create"

	// 1층 — 작업 칸 (SERVER_DRIVEN_ACTIONS_SRS GR-1b)
	GitFetch              = "git.fetch"
	GitPull               = "git.pull"
	GitPush               = "git.push"
	GitBranchPush         = "git.branch.push"
	GitBranchFetch        = "git.branch.fetch"
	GitBranchDeleteRemote = "git.branch.delete_remote"
	GitTagPush            = "git.tag.push"
	GitTagDeleteRemote    = "git.tag.delete_remote"
	// GitWrite 는 index 칸을 쓰는 동기 쓰기·index 잡 시작 전반이다 — 메뉴의
	// checkout·merge·stash apply 같은 항목이 이것을 본다.
	GitWrite = "git.write"
	// GitCommit 은 1층이 아니라 묻는 동작이다 — 메시지·옵션이 답을 바꾼다 (GR-3a).
	GitCommit          = "git.commit"
	GitLockRemove      = "git.lock.remove"
	GitWorktreeCreate  = "git.worktree.create"
	GitSubmoduleUpdate = "git.submodule.update"

	// GitWorktreeRemove 는 worktree 목록의 행마다 싣는다 (GR-1h).
	GitWorktreeRemove = "git.worktree.remove"

	// 1층 — 상태 사실 (GR-2). GitStashNew 는 stash 탭의 "새로" 와 커밋 안 된 행의
	// Stash 가 함께 쓴다 — 둘 다 같은 생성 대화상자를 연다.
	GitStashNew         = "git.stash.new"
	GitUncommittedReset = "git.uncommitted.reset"
	GitUncommittedClean = "git.uncommitted.clean"

	// 2층 — 커밋 행 메뉴 (GT-a). `kind=commit&oid=` 로 묻는다.
	GitCommitCherryPick = "git.commit.cherry_pick"
	GitCommitRevert     = "git.commit.revert"
	GitCommitReset      = "git.commit.reset"
	GitCommitDrop       = "git.commit.drop"
)

// Table 은 동작 ID → 그 판정이 낼 수 있는 사유 코드다 (M-3).
type Table map[string][]string

// MayGive 는 그 동작이 그 사유를 낼 수 있는가다. 판정 시험이 이것으로 낸 사유를
// 목록에 묶는다 — 목록에 없는 사유는 게이트가 문구를 확인하지 못한다.
func (t Table) MayGive(id, why string) bool {
	for _, w := range t[id] {
		if w == why {
			return true
		}
	}
	return false
}

// MissingPhrases 는 문구가 없는 사유를 `<로케일>: why.<코드>` 로 돌려준다 (FR-SDA-8).
// src 는 로케일 → 카탈로그 원문(`web/js/i18n/<로케일>.js`)이다. 순서는 로케일·코드의
// 사전순이다.
func MissingPhrases(t Table, src map[string]string) []string {
	codes := map[string]bool{WhyLoading: true}
	for _, whys := range t {
		for _, w := range whys {
			codes[w] = true
		}
	}
	keys := make([]string, 0, len(codes))
	for c := range codes {
		keys = append(keys, "why."+c)
	}
	sort.Strings(keys)
	locales := make([]string, 0, len(src))
	for l := range src {
		locales = append(locales, l)
	}
	sort.Strings(locales)

	var out []string
	for _, l := range locales {
		for _, k := range keys {
			if !hasKey(src[l], k) {
				out = append(out, l+": "+k)
			}
		}
	}
	return out
}

func hasKey(src, key string) bool {
	return regexp.MustCompile(`['"]` + regexp.QuoteMeta(key) + `['"]\s*:`).MatchString(src)
}

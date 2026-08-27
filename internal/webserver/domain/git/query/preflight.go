package query

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"dongminal/internal/webserver/domain/git/core"
)

// preflight 의 코드값. 클라이언트가 이 문자열로 분기하므로 한 자리에 둔다.
const (
	BlockIdentityMissing      = "identity_missing"
	BlockMergeInProgress      = "merge_in_progress"
	BlockRebaseInProgress     = "rebase_in_progress"
	BlockCherryPickInProgress = "cherry_pick_in_progress"
	BlockRevertInProgress     = "revert_in_progress"

	WarnDetachedHead = "detached_head"
)

// 읽는 설정 키.
const (
	configUserName       = "user.name"
	configUserEmail      = "user.email"
	configGPGSign        = "commit.gpgsign"  // FR-GIT-85
	configCommitTemplate = "commit.template" // FR-GIT-76
)

// 진행 중 상태를 뜻하는 gitdir 안의 이름들. **git 을 실행하지 않는다** — 존재
// 여부가 그대로 답이다.
const (
	mergeHeadFile      = "MERGE_HEAD"
	rebaseMergeDir     = "rebase-merge"
	rebaseApplyDir     = "rebase-apply"
	cherryPickHeadFile = "CHERRY_PICK_HEAD"
	revertHeadFile     = "REVERT_HEAD"
)

// configUnsetExit 은 `git config --get` 이 없는 키에 주는 종료 코드다 (git 2.50.1
// 실측: exit 1, stderr 비어 있음). **미설정은 실패가 아니다** — 오류로 올려보내면
// identity 가 없는 저장소에서 preflight 자체가 막혀 차단 사유를 보일 수 없다.
const configUnsetExit = 1

// Block 은 실행을 막은 이유 하나다. **무엇이 왜 막혔고 어떻게 푸는지**를 함께
// 준다 (FR-GIT-88) — 단순 실패 메시지로 끝내면 사용자가 갈 곳이 없다.
type Block struct {
	Code   string `json:"code"`   // identity_missing | merge_in_progress | …
	Reason string `json:"reason"` // 무엇이 왜
	Fix    string `json:"fix"`    // 어떻게 푸는지
}

// Warning 은 막지는 않되 알려야 하는 것이다 (FR-GIT-87 의 detached).
type Warning struct {
	Code   string `json:"code"`
	Reason string `json:"reason"`
}

type Preflight struct {
	Blocks   []Block   `json:"blocks"`
	Warnings []Warning `json:"warnings"`
	GPGSign  bool      `json:"gpgSign"`  // FR-GIT-85
	Template string    `json:"template"` // FR-GIT-76. commit.template 의 내용
}

// inProgressChecks 는 진행 중 상태 판정이다. 하나라도 있으면 커밋을 막고, 그
// 해소법을 함께 준다 (FR-GIT-86·88).
//
// **표식 이름을 여기 적지 않는다** (FR-GIT-251) — `operationMarkers` 가 그것의 유일한
// 근거이고 여기서는 종류만 가리킨다. 두 벌로 두면 한쪽만 고쳐져, 커밋은 막히는데
// 진행 중 표시와 출구는 안 보이는 상태가 된다.
//
// 여기서는 **일치하는 것을 모두** 막는다 — `DetectOperation` 이 하나만 고르는 것과
// 다른 질문이기 때문이다: 저것은 "지금 어느 작업 중인가"(출구를 고르려고), 이것은
// "커밋을 막을 이유 전부"(FR-GIT-88 이 사유마다 해소법을 요구한다)다.
var inProgressChecks = []struct {
	code   string
	kind   string
	reason string
	fix    string
}{
	{
		BlockMergeInProgress, OpMerge,
		"머지가 진행 중입니다 — 지금 커밋하면 머지 커밋이 됩니다",
		"충돌을 해결한 뒤 커밋하거나, `git merge --abort` 로 머지를 되돌리세요",
	},
	{
		BlockRebaseInProgress, OpRebase,
		"리베이스가 진행 중입니다 — 이 상태의 커밋은 리베이스의 일부가 됩니다",
		"`git rebase --continue` 로 진행하거나 `git rebase --abort` 로 되돌리세요",
	},
	{
		BlockCherryPickInProgress, OpCherryPick,
		"체리픽이 진행 중입니다",
		"`git cherry-pick --continue` 로 진행하거나 `git cherry-pick --abort` 로 되돌리세요",
	},
	{
		BlockRevertInProgress, OpRevert,
		"리버트가 진행 중입니다",
		"`git revert --continue` 로 진행하거나 `git revert --abort` 로 되돌리세요",
	},
}

// PreflightOf 는 커밋 실행 전 검사다 (FR-GIT-86~88).
//
// **여기서 막힌 것은 사용자가 풀 수 있는 것뿐이다.** 그래서 모든 Block 이 Fix 를
// 갖고, detached 처럼 사용자가 의도했을 수 있는 상태는 막지 않고 경고만 한다
// (FR-GIT-87).
func PreflightOf(s *core.Service, ctx context.Context, repo string) (Preflight, error) {
	pf := Preflight{Blocks: []Block{}, Warnings: []Warning{}}

	name, err := configGet(s, ctx, repo, configUserName)
	if err != nil {
		return Preflight{}, err
	}
	email, err := configGet(s, ctx, repo, configUserEmail)
	if err != nil {
		return Preflight{}, err
	}
	if b, missing := identityBlock(name, email); missing {
		pf.Blocks = append(pf.Blocks, b)
	}

	gitDir, commonDir, err := s.GitDirs(ctx, repo)
	if err != nil {
		return Preflight{}, err
	}
	for _, c := range inProgressChecks {
		if anyExists(gitDir, markersOf(c.kind)) {
			pf.Blocks = append(pf.Blocks, Block{Code: c.code, Reason: c.reason, Fix: c.fix})
		}
	}

	// HEAD 가 심볼릭인지는 파일이 답한다. rev-parse 로 묻지 않는 이유는 커밋이 없는
	// 저장소에서 그것이 실패하기 때문이다 — 아직 태어나지 않은 브랜치는 detached 가
	// 아니다.
	sig, err := ReadSignature(gitDir, commonDir)
	if err != nil {
		return Preflight{}, err
	}
	if sig.RefName == "" {
		pf.Warnings = append(pf.Warnings, Warning{
			Code:   WarnDetachedHead,
			Reason: "HEAD 가 브랜치를 가리키지 않습니다 (detached) — 여기서 만든 커밋은 어느 브랜치에도 속하지 않습니다",
		})
	}

	sign, err := configGet(s, ctx, repo, configGPGSign)
	if err != nil {
		return Preflight{}, err
	}
	pf.GPGSign = gitBool(sign)

	tmpl, err := configGet(s, ctx, repo, configCommitTemplate)
	if err != nil {
		return Preflight{}, err
	}
	pf.Template = readCommitTemplate(repo, tmpl)
	return pf, nil
}

// identityBlock 은 없는 키를 그대로 말한다 — "설정이 없다"만으로는 무엇을 설정할지
// 알 수 없다.
func identityBlock(name, email string) (Block, bool) {
	var missing []string
	if strings.TrimSpace(name) == "" {
		missing = append(missing, configUserName)
	}
	if strings.TrimSpace(email) == "" {
		missing = append(missing, configUserEmail)
	}
	if len(missing) == 0 {
		return Block{}, false
	}
	var fix strings.Builder
	for i, key := range missing {
		if i > 0 {
			fix.WriteString(" && ")
		}
		fmt.Fprintf(&fix, "git config --global %s \"…\"", key)
	}
	return Block{
		Code:   BlockIdentityMissing,
		Reason: strings.Join(missing, " · ") + " 이 설정되지 않아 커밋의 작성자를 정할 수 없습니다",
		Fix:    fix.String(),
	}, true
}

// configGet 은 설정값 하나를 읽는다. **미설정은 빈 문자열이며 실패가 아니다**
// (configUnsetExit 참고). exit 1 이 아닌 실패는 그대로 올린다.
func configGet(s *core.Service, ctx context.Context, repo, key string) (string, error) {
	out, err := s.Exec(ctx, repo, "config", "--get", key)
	if err != nil {
		var xe *core.ExecError
		if errors.As(err, &xe) && xe.Unwrap() == nil && xe.ExitCode == configUnsetExit {
			return "", nil
		}
		return "", err
	}
	return strings.TrimSpace(out.Stdout), nil
}

// anyExists 는 gitdir 안의 이름 중 하나라도 있는지 본다. 파일인지 디렉터리인지는
// 묻지 않는다 — 리베이스는 디렉터리, 머지는 파일이다.
func anyExists(gitDir string, names []string) bool {
	for _, n := range names {
		if _, err := os.Lstat(filepath.Join(gitDir, n)); err == nil {
			return true
		}
	}
	return false
}

// gitTrue 는 git 이 참으로 읽는 표기다. `--type=bool` 로 정규화하지 않는 이유는
// config 인자 가드를 좁게 두기 위해서다.
var gitTrue = map[string]bool{"true": true, "yes": true, "on": true, "1": true}

func gitBool(v string) bool { return gitTrue[strings.ToLower(strings.TrimSpace(v))] }

// readCommitTemplate 은 commit.template 의 내용을 읽는다 (FR-GIT-76).
//
// 설정이 없거나 파일을 읽을 수 없으면 빈 문자열이다 — 템플릿이 없는 것은 실패가
// 아니고, 그것 때문에 커밋 화면이 열리지 않아서는 안 된다. 크기 상한은 diff 와 같은
// 값을 쓴다.
func readCommitTemplate(repo, p string) string {
	if strings.TrimSpace(p) == "" {
		return ""
	}
	abs := p
	if rest, ok := strings.CutPrefix(abs, "~/"); ok {
		home, err := os.UserHomeDir()
		if err != nil {
			return ""
		}
		abs = filepath.Join(home, rest)
	}
	if !filepath.IsAbs(abs) {
		abs = filepath.Join(repo, abs)
	}
	f, err := os.Open(abs)
	if err != nil {
		return ""
	}
	defer f.Close()
	body, err := io.ReadAll(io.LimitReader(f, DiffMaxBytes))
	if err != nil {
		return ""
	}
	return string(body)
}

package query

import (
	"context"
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
	// GIT_DETECT_TIER_SRS FR-GDT-18·19: 이 둘도 **커밋을 막을 이유**다.
	BlockAmInProgress     = "am_in_progress"
	BlockBisectInProgress = "bisect_in_progress"

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
	mergeHeadFile  = "MERGE_HEAD"
	rebaseMergeDir = "rebase-merge"
	rebaseApplyDir = "rebase-apply"
	// GIT_DETECT_TIER_SRS FR-GDT-19 / D-GDT-6: `git am` 만 만드는 표식이다.
	// `git rebase --apply` 갈래는 같은 디렉터리를 쓰되 이 파일을 만들지 않는다.
	rebaseApplying = "applying"
	// FR-GDT-18: bisect 의 표식. `git bisect start` 가 만들고 `reset` 이 지운다.
	bisectLogFile      = "BISECT_LOG"
	cherryPickHeadFile = "CHERRY_PICK_HEAD"
	revertHeadFile     = "REVERT_HEAD"
)

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
	// GIT_DETECT_TIER_SRS FR-GDT-19 (`11 GP-18`): 종전에는 `git am` 이
	// `rebase_in_progress` 로 막혔고, 그 해소법이 **맞지 않는 명령**을 안내했다.
	{
		BlockAmInProgress, OpAm,
		"패치 적용(git am)이 진행 중입니다",
		"충돌을 해결한 뒤 `git am --continue` 로 진행하거나 `git am --abort` 로 되돌리세요",
	},
	// FR-GDT-18 (`11 GP-11g`): bisect 중의 커밋은 탐색을 오염시킨다. 종전에는
	// 막는 이유도 나갈 길도 화면에 없었다 — detached HEAD 로만 보였다.
	{
		BlockBisectInProgress, OpBisect,
		"bisect 탐색이 진행 중입니다 — 지금 커밋하면 탐색 결과를 믿을 수 없습니다",
		"`git bisect reset` 으로 탐색을 끝내고 원래 자리로 돌아가세요",
	},
}

// PreflightOf 는 커밋 실행 전 검사다 (FR-GIT-86~88).
//
// **여기서 막힌 것은 사용자가 풀 수 있는 것뿐이다.** 그래서 모든 Block 이 Fix 를
// 갖고, detached 처럼 사용자가 의도했을 수 있는 상태는 막지 않고 경고만 한다
// (FR-GIT-87).
func PreflightOf(s *core.Service, ctx context.Context, repo string) (Preflight, error) {
	pf := Preflight{Blocks: []Block{}, Warnings: []Warning{}}

	// FR-OPT-7-3 (DOM-19): git 은 두 번이다 — 설정 한 번, gitdir 한 번.
	//
	//	이전 동작: config --get 네 번 + rev-parse 한 번(5회)이고, HEAD 하나를 읽으려고
	//	          signature 전체(refs 트리 워크 포함)를 계산했다
	//	새  동작: `config --null --list` 한 번으로 네 키를 읽고, HEAD 는 파일만 읽는다
	//	이유:     커밋 화면을 열 때와 커밋 사전 단계마다 도는 조회다
	cfg, err := preflightConfig(s, ctx, repo)
	if err != nil {
		return Preflight{}, err
	}
	if b, missing := identityBlock(cfg[configUserName], cfg[configUserEmail]); missing {
		pf.Blocks = append(pf.Blocks, b)
	}

	gitDir, _, err := s.GitDirs(ctx, repo)
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
	head, err := os.ReadFile(filepath.Join(gitDir, headFile))
	if err != nil {
		return Preflight{}, err
	}
	if !strings.HasPrefix(strings.TrimSpace(string(head)), symrefPrefix) {
		pf.Warnings = append(pf.Warnings, Warning{
			Code:   WarnDetachedHead,
			Reason: "HEAD 가 브랜치를 가리키지 않습니다 (detached) — 여기서 만든 커밋은 어느 브랜치에도 속하지 않습니다",
		})
	}

	pf.GPGSign = gitBool(cfg[configGPGSign])
	pf.Template = readCommitTemplate(repo, cfg[configCommitTemplate])
	return pf, nil
}

// preflightKeys 는 preflight 가 읽는 설정 키다. `--list` 는 키를 소문자로 준다
// (섹션·변수 이름은 대소문자를 가리지 않는다).
var preflightKeys = map[string]bool{
	configUserName: true, configUserEmail: true, configGPGSign: true, configCommitTemplate: true,
}

// preflightConfig 는 네 키를 `config --null --list` 한 번으로 읽는다. 판독은
// `config --get` 과 같다: 여러 값이면 **마지막** 값, 미설정은 빈 문자열(실패가
// 아니다), 값은 앞뒤를 다듬는다. `--null` 이라 값 안의 개행이 다른 키로 읽히지
// 않는다.
func preflightConfig(s *core.Service, ctx context.Context, repo string) (map[string]string, error) {
	out, err := s.Exec(ctx, repo, "config", "--null", "--list")
	if err != nil {
		return nil, err
	}
	cfg := map[string]string{}
	for _, rec := range strings.Split(out.Stdout, "\x00") {
		// 값이 없는 키(`[commit] gpgsign`)는 개행 없이 온다 — 값은 빈 문자열이다.
		key, val, _ := strings.Cut(rec, "\n")
		if key = strings.ToLower(key); preflightKeys[key] {
			cfg[key] = strings.TrimSpace(val)
		}
	}
	return cfg, nil
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

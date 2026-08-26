package query

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"strings"

	"dongminal/internal/webserver/domain/git/core"
)

// 상세 레코드의 필드 배치. 목록 포맷(logFormat) 뒤에 커미터와 메시지 전문을 더한
// 것이며, 앞 9개는 자리까지 같다 — 두 포맷이 어긋나면 상세가 목록과 다른 커밋을
// 보인다.
const (
	detailFields = 12
	detailFormat = logFormat + "%x00%cn%x00%ce%x00%B"
)

// CommitNoParent 는 "비교한 부모가 없다" 다. 루트 커밋에 0 을 답하면 "첫 부모와
// 비교했다" 로 읽힌다.
const CommitNoParent = -1

// name-status -z 의 조각 수. rename/copy 는 원본 경로가 뒤따르므로 하나 더 먹는다.
const (
	nameStatusFields  = 2 // <status> <path>
	nameStatusRenamed = 3 // <status><score> <origPath> <path>
)

var ErrCommitParent = errors.New("bad_parent_index")

// CommitFile 은 커밋 하나가 바꾼 파일이다 (FR-GIT-137).
type CommitFile struct {
	Status   string `json:"status"` // M A D R C T
	Path     string `json:"path"`
	OrigPath string `json:"origPath,omitempty"` // rename/copy 원본 (FR-GIT-36)
	Score    int    `json:"score,omitempty"`    // rename/copy 유사도 (R100 의 100)
}

// CommitDetail 은 커밋 하나의 상세다. 머지 커밋은 비교 부모를 골라야 하므로
// parentIndex 를 받는다 (FR-GIT-139).
type CommitDetail struct {
	Commit
	CommitterName string       `json:"committerName"`
	CommitterMail string       `json:"committerMail"`
	Body          string       `json:"body"`        // 메시지 전문 (FR-GIT-136)
	Files         []CommitFile `json:"files"`       // FR-GIT-137
	ParentIndex   int          `json:"parentIndex"` // 어느 부모와 비교했는지. 루트면 -1
}

// CommitDetailOf 는 커밋 하나의 상세를 준다 (FR-GIT-136·137·139).
//
// 두 번 실행한다 — 메타는 log 가, 변경 파일은 diff-tree 가 안다. 하나로 합치면
// 부모 선택이 메타 파싱에 섞이고, 어느 쪽이 실패했는지 갈라 볼 수 없다.
func CommitDetailOf(s *core.Service, ctx context.Context, repo, oid string, parentIndex int) (CommitDetail, error) {
	if err := checkRev("oid", oid); err != nil {
		return CommitDetail{}, err
	}
	out, err := s.Exec(ctx, repo, "log", "-z", detailFormat, logDecorate, "-n", "1", oid)
	if err != nil {
		return CommitDetail{}, revError(err)
	}
	d, err := parseCommitDetail(out.Stdout)
	if err != nil {
		return CommitDetail{}, err
	}

	args, err := commitFilesArgs(oid, d.Parents, parentIndex)
	if err != nil {
		return CommitDetail{}, err
	}
	tree, err := s.Exec(ctx, repo, args...)
	if err != nil {
		return CommitDetail{}, revError(err)
	}
	if tree.StdoutTruncated {
		return CommitDetail{}, fmt.Errorf("git diff-tree 의 출력이 상한(%dB)에서 잘렸다: 변경 파일 목록을 온전히 줄 수 없다", s.MaxOutput())
	}
	if d.Files, err = ParseNameStatusZ(tree.Stdout); err != nil {
		return CommitDetail{}, err
	}
	if len(d.Parents) == 0 {
		d.ParentIndex = CommitNoParent
	} else {
		d.ParentIndex = parentIndex
	}
	return d, nil
}

// commitFilesArgs 는 비교할 두 트리를 정한다. 부모 n 은 `<oid>^<n+1>` 이며, 부모가
// 없는 루트 커밋만 `--root` 로 간다.
//
// `-M` 을 준다 — diff-tree 는 plumbing 이라 rename 을 스스로 찾지 않고, 없으면
// rename 이 D+A 두 줄로 갈라져 origPath 를 잃는다 (FR-GIT-36, git 2.50.1 실측).
// `-C`(copy 탐지)는 주지 않는다 — 비용이 크고 요구된 것이 아니다.
//
// 계약이 적은 `-m` 은 주지 않는다. 두 트리를 명시하는 형태에서는 아무 일도 하지
// 않으며(실측), 하는 일이 없는 플래그는 다음 사람을 헷갈리게 한다.
func commitFilesArgs(oid string, parents []string, parentIndex int) ([]string, error) {
	base := []string{"diff-tree", "--no-commit-id", "--name-status", "-r", "-z", "-M"}
	if len(parents) == 0 {
		// 루트 커밋에 부모를 지정하는 요청은 잘못된 요청이다.
		if parentIndex > 0 {
			return nil, fmt.Errorf("%w: 루트 커밋에는 부모가 없다 (parent=%d)", ErrCommitParent, parentIndex)
		}
		if parentIndex < 0 {
			return nil, fmt.Errorf("%w: 부모 번호가 음수다 (parent=%d)", ErrCommitParent, parentIndex)
		}
		return append(base, "--root", oid), nil
	}
	// 범위를 클램프하지 않는다 — 사용자는 자기가 고르지 않은 부모와의 비교를 보고
	// 있다고 모른 채 읽는다 (FR-GIT-139).
	if parentIndex < 0 || parentIndex >= len(parents) {
		return nil, fmt.Errorf("%w: 부모 %d 가 없다 (부모 %d개)", ErrCommitParent, parentIndex, len(parents))
	}
	return append(base, oid+"^"+strconv.Itoa(parentIndex+1), oid), nil
}

// parseCommitDetail 은 상세 레코드 하나를 읽는다. `-n 1` 이므로 레코드는 하나이며,
// 빈 stdout 은 그 커밋이 없다는 뜻이다 — 빈 상세를 성공으로 돌려주면 사용자는
// 내용 없는 커밋을 본다.
func parseCommitDetail(out string) (CommitDetail, error) {
	if out == "" {
		return CommitDetail{}, fmt.Errorf("%w: git log 가 커밋을 주지 않았다", ErrRevNotFound)
	}
	f := strings.SplitN(out, "\x00", detailFields)
	if len(f) < detailFields {
		return CommitDetail{}, fmt.Errorf("git log(상세): 필드가 %d개다 (want %d)", len(f), detailFields)
	}
	c, err := commitFromFields(f[:logFields])
	if err != nil {
		return CommitDetail{}, err
	}
	// %B 는 제목까지 포함한 전문이며 꼬리 개행을 그대로 둔다 — 다듬는 것은 표시
	// 계층의 일이고, 서버가 뭉개면 되돌릴 수 없다.
	return CommitDetail{Commit: c, CommitterName: f[9], CommitterMail: f[10], Body: f[11]}, nil
}

// ParseNameStatusZ 는 `git diff-tree --name-status -r -z` 의 stdout 을 해석한다.
//
// `-z` 는 여기서 **모든 필드를 NUL 로 끝낸다** (git 2.50.1 실측) — log -z 와 규약이
// 다르므로 꼬리의 빈 토큰을 뗀다. rename/copy 는 `R100\0old\0new` 세 조각이며,
// 두 조각으로 세면 다음 파일의 상태가 경로 자리에 들어간다.
//
// 조각이 모자란 레코드는 **오류다.** 조용히 버리면 상세가 변경 파일을 빠뜨리고,
// 사용자는 그 커밋이 그 파일을 건드리지 않았다고 믿는다.
func ParseNameStatusZ(out string) ([]CommitFile, error) {
	if out == "" {
		return []CommitFile{}, nil
	}
	toks := strings.Split(out, "\x00")
	if n := len(toks); n > 0 && toks[n-1] == "" {
		toks = toks[:n-1]
	}
	files := make([]CommitFile, 0, len(toks)/nameStatusFields)
	for i := 0; i < len(toks); {
		st := toks[i]
		if st == "" {
			return nil, fmt.Errorf("diff-tree -z: 상태 조각이 비었다 (조각 %d)", i)
		}
		f := CommitFile{Status: st[:1]}
		// <X><score> 는 R100·C75 형태다. 점수가 붙는 것은 rename/copy 뿐이다.
		if len(st) > 1 {
			n, err := strconv.Atoi(st[1:])
			if err != nil {
				return nil, fmt.Errorf("diff-tree -z: 상태 %q 의 점수를 읽지 못했다", st)
			}
			f.Score = n
		}
		want := nameStatusFields
		if f.Status == "R" || f.Status == "C" {
			want = nameStatusRenamed
		}
		if i+want > len(toks) {
			return nil, fmt.Errorf("diff-tree -z: %q 레코드의 조각이 %d개다 (want %d)", st, len(toks)-i, want)
		}
		if want == nameStatusRenamed {
			f.OrigPath, f.Path = toks[i+1], toks[i+2]
		} else {
			f.Path = toks[i+1]
		}
		files = append(files, f)
		i += want
	}
	return files, nil
}

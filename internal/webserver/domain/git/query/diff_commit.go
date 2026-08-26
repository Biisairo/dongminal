package query

import (
	"context"
	"fmt"
	"strings"

	"dongminal/internal/webserver/domain/git/core"
)

// AxisCommitParent 는 커밋과 그 부모를 비교한다 (FR-GIT-138·139).
//
// 다른 세 축과 달리 **리비전을 인자로 받는다** — worktree·index·HEAD 는 암묵적
// 리비전이지만 커밋 축은 두 커밋을 명시해야 한다. 그래서 진입점을 따로 둔다:
// DiffContent 의 인자에 커밋 둘을 끼워 넣으면 나머지 세 축에서 늘 빈 값이 된다.
const AxisCommitParent = "commit-parent"

// DiffCommit 은 `<parentOid>:<origPath>` 와 `<oid>:<path>` 를 비교한다.
//
// parentOid 가 비면 루트 커밋이다 — original 쪽은 absent 이고 오류가 아니다.
// 그 커밋이 저장소의 시작이라는 사실을 빈 diff 로 뭉개지 않는다 (FR-GIT-45).
func DiffCommit(s *core.Service, ctx context.Context, repo, oid, parentOid, p, origPath string) (DiffContent, error) {
	// oid 가 비면 `:<path>` 가 되어 **index 를 가리킨다** — 커밋 축이 조용히 다른
	// 축이 된다. 빈 값은 거부한다.
	if strings.TrimSpace(oid) == "" {
		return DiffContent{}, fmt.Errorf("%w: oid 가 비었다", ErrUnsafeRev)
	}
	if err := checkRev("oid", oid); err != nil {
		return DiffContent{}, err
	}
	if parentOid != "" {
		if err := checkRev("parentOid", parentOid); err != nil {
			return DiffContent{}, err
		}
	}
	rel, err := diffRelPath(p)
	if err != nil {
		return DiffContent{}, err
	}
	origRel := rel
	if origPath != "" {
		if origRel, err = diffRelPath(origPath); err != nil {
			return DiffContent{}, err
		}
	}

	dc := DiffContent{Repo: repo, Axis: AxisCommitParent, Path: rel, OrigPath: origRel}
	if parentOid == "" {
		dc.Original = DiffSide{Kind: DiffKindAbsent}
	} else if dc.Original, err = diffBlobSide(s, ctx, repo, parentOid+":"+origRel); err != nil {
		return DiffContent{}, err
	}
	if dc.Modified, err = diffBlobSide(s, ctx, repo, oid+":"+rel); err != nil {
		return DiffContent{}, err
	}
	if dc.Original.Kind == DiffKindAbsent && dc.Modified.Kind == DiffKindAbsent {
		return DiffContent{}, fmt.Errorf("%w: %s 의 %s..%s 양쪽에 %q 가 없다", ErrDiffBothAbsent, repo, parentOid, oid, rel)
	}
	dc.Note = diffNote(dc.Original, dc.Modified)
	return dc, nil
}

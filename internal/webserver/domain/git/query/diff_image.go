package query

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strings"

	"dongminal/internal/shared/mimeprobe"
	"dongminal/internal/webserver/domain/git/core"
)

// M9_SRS FR-M9-20·21 — **그림으로 볼 수 있는 diff 는 그림으로 보인다.**
//
// 여기 있는 것은 둘이다: 그 판정(`ImageMimeOf`)과 한쪽의 원본 바이트
// (`SideBytes`). `DiffContentOf` 는 그대로 둔다 — 그쪽은 Monaco 에 줄 **줄 두
// 벌**을 만드는 자리이고 이쪽은 `<img src>` 가 걸 바이트를 내는 자리다.
//
// **넘겨받는 `*core.Service` 는 그림 전용이다** (D-M9-16). 공용 서비스의 출력
// 상한은 서비스 전체에 하나이고(1MiB, FR-GIT-6) 그것으로는 흔한 스크린샷 하나가
// 상한에 걸린다. 부르는 쪽이 `core.New(core.WithMaxOutput(…))` 로 만든 것을 준다.

// diff 의 한쪽. `<img>` 두 개가 각각 이 이름으로 바이트를 받는다.
const (
	DiffSideOriginal = "original"
	DiffSideModified = "modified"
)

// ErrDiffSide 는 side 인자가 둘 중 하나가 아니라는 뜻이다 — 축·경로의 거부와
// 구분되어야 서버가 무엇이 잘못됐는지 말할 수 있다.
var ErrDiffSide = errors.New("unknown_diff_side")

// sideRev 는 (축, side) 를 **무엇을 읽을지**로 푼다.
//
// rev 가 비면 작업 트리다 — `git show` 는 index/HEAD 만 알고 워킹 트리는
// 파일시스템이 진실이다 (`diffWorktreeSide` 와 같은 근거).
//
// **해석은 `DiffContentOf`·`DiffCommit` 과 같은 규칙을 따른다.** 두 벌이 되면
// diff 가 보여 준 것과 다른 바이트를 내주게 되고, 그 어긋남은 화면에서
// "이상한 그림" 으로만 보인다.
func sideRev(axis, side, rel, origRel, oid, parentOid string) (rev string, err error) {
	if side != DiffSideOriginal && side != DiffSideModified {
		return "", fmt.Errorf("%w: %q", ErrDiffSide, side)
	}
	switch axis {
	case AxisWorktreeIndex:
		if side == DiffSideOriginal {
			return indexRevPrefix + origRel, nil
		}
		return "", nil // 작업 트리
	case AxisWorktreeHead:
		if side == DiffSideOriginal {
			return headRevPrefix + origRel, nil
		}
		return "", nil // 작업 트리
	case AxisIndexHead:
		if side == DiffSideOriginal {
			return headRevPrefix + origRel, nil
		}
		return indexRevPrefix + rel, nil
	case AxisCommitParent:
		if side == DiffSideOriginal {
			if strings.TrimSpace(parentOid) == "" {
				// 첫 커밋이다 — 이전 판이 없다 (`DiffCommit` 이 absent 로 두는 자리).
				return "", ErrDiffBothAbsent
			}
			if err := checkRev("parentOid", parentOid); err != nil {
				return "", err
			}
			return parentOid + ":" + origRel, nil
		}
		if strings.TrimSpace(oid) == "" {
			return "", fmt.Errorf("%w: oid 가 비었다", ErrUnsafeRev)
		}
		if err := checkRev("oid", oid); err != nil {
			return "", err
		}
		return oid + ":" + rel, nil
	}
	return "", fmt.Errorf("%w: %q", ErrDiffAxis, axis)
}

// SideBytes 는 한쪽의 **원본 바이트**를 준다 (FR-M9-21).
//
// 없으면 `ErrDiffBothAbsent` 다 — 이름이 "양쪽" 이지만 뜻은 "비교할 것이 없다"
// 이고, 서버는 그것을 404 로 옮긴다.
func SideBytes(img *core.Service, ctx context.Context, repo, axis, p, origPath, oid, parentOid, side string) ([]byte, error) {
	rel, origRel, err := diffRelPair(p, origPath)
	if err != nil {
		return nil, err
	}
	rev, err := sideRev(axis, side, rel, origRel, oid, parentOid)
	if err != nil {
		return nil, err
	}
	if rev == "" {
		abs, err := diffWorktreeAbs(repo, rel)
		if err != nil {
			return nil, err
		}
		b, err := os.ReadFile(abs)
		if os.IsNotExist(err) {
			return nil, ErrDiffBothAbsent
		}
		return b, err
	}
	out, err := img.Exec(ctx, repo, "show", rev)
	if err != nil {
		if diffAbsent(err) {
			return nil, ErrDiffBothAbsent
		}
		return nil, err
	}
	// 잘린 그림은 그림이 아니다. 상한을 넘은 것을 "온전한 바이트" 로 답하면
	// 브라우저가 깨진 그림을 그리고 사용자는 파일이 깨졌다고 읽는다.
	if out.StdoutTruncated {
		return nil, ErrDiffTooLarge
	}
	return []byte(out.Stdout), nil
}

// ErrDiffTooLarge 는 그림이 상한을 넘었다는 뜻이다. 서버는 413 으로 옮긴다.
var ErrDiffTooLarge = errors.New("diff_image_too_large")

// ImageMimeOf 는 이 diff 를 **그림으로 볼 수 있는지** 묻는다 (FR-M9-20).
//
// 그림이면 그 MIME 을, 아니면 빈 문자열을 준다. 판정은 **내용**이고
// (`mimeprobe.ImageMime` — `/api/file/raw` 와 같은 한 벌이다) 확장자는 근거가
// 아니다.
//
// **현재 판을 먼저 본다.** 그쪽이 대개 작업 트리라 512바이트 디스크 읽기 하나로
// 끝나고, 그림이면 거기서 돌아간다. 이전 판까지 가는 것은 **지워진 그림**처럼
// 현재 판이 없는 회차뿐이다.
func ImageMimeOf(img *core.Service, ctx context.Context, repo, axis, p, origPath, oid, parentOid string) string {
	for _, side := range []string{DiffSideModified, DiffSideOriginal} {
		b, err := SideBytes(img, ctx, repo, axis, p, origPath, oid, parentOid, side)
		if err != nil {
			continue
		}
		if m := mimeprobe.ImageMime(b); m != "" {
			return m
		}
	}
	return ""
}

// diffRelPair 는 두 경로를 함께 검증한다. `DiffContentOf`·`DiffCommit` 이 각자
// 적던 네 줄이며, 세 번째 자리가 생겨 한 자리로 모았다.
func diffRelPair(p, origPath string) (rel, origRel string, err error) {
	if rel, err = diffRelPath(p); err != nil {
		return "", "", err
	}
	origRel = rel
	if origPath != "" {
		if origRel, err = diffRelPath(origPath); err != nil {
			return "", "", err
		}
	}
	return rel, origRel, nil
}

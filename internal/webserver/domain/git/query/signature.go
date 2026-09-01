package query

import (
	"context"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"dongminal/internal/webserver/domain/git/core"
)

// Signature 는 .git 상태 변화를 싸게 감지하는 값이다 (FR-GIT-19, §2.6: 0.02ms).
// 값이 그대로면 status 재조회를 생략한다.
type Signature struct {
	Head         string `json:"head"`    // .git/HEAD 내용 (trim)
	RefName      string `json:"refName"` // HEAD 가 심볼릭이면 그 ref. 아니면 ""
	IndexMtimeNs int64  `json:"indexMtimeNs"`
	IndexSize    int64  `json:"indexSize"`
	RefMtimeNs   int64  `json:"refMtimeNs"`
	// RefsMtimeNs 는 refs 아래 **디렉터리들**의 mtime 을 합친 값이다
	// (GIT_VIEW_REFRESH_SRS FR-GVR-21). ref 파일이 생기거나 사라지면 그 부모
	// 디렉터리의 mtime 이 바뀌므로, 브랜치·태그·원격 추적 ref 의 추가·삭제가
	// 여기 잡힌다 — 종전 근거(HEAD·index·현재 브랜치)로는 보이지 않던 축이다.
	RefsMtimeNs int64  `json:"refsMtimeNs"`
	Value       string `json:"value"` // 위 전부를 합친 비교용 문자열
}

const (
	headFile       = "HEAD"
	indexFile      = "index"
	packedRefsFile = "packed-refs"
	refsDir        = "refs"
	symrefPrefix   = "ref: "
	sigSep         = "|"

	// refsWalkMaxDirs 는 refs 트리를 걸을 때 보는 디렉터리 수의 상한이다.
	// 디렉터리는 ref 수보다 훨씬 적지만(보통 한 자릿수), 남이 만든 저장소가
	// 어떤 모양일지는 알 수 없다 — 감지 하나가 폴링 주기를 먹지 않게 막는다.
	refsWalkMaxDirs = 256
)

// SignatureOf 는 gitdir 을 해석한 뒤 파일만 읽는다.
//
// gitdir 해석에는 rev-parse 가 한 번 필요하다. 그것을 캐시해 **git 실행 없는**
// 감지 경로를 만드는 것은 Store 의 일이다 (§4 의 DefaultGitDirsTTL).
func SignatureOf(s *core.Service, ctx context.Context, repo string) (Signature, error) {
	gitDir, commonDir, err := s.GitDirs(ctx, repo)
	if err != nil {
		return Signature{}, err
	}
	return ReadSignature(gitDir, commonDir)
}

// ReadSignature 는 read 1회 + stat 2회다. git 을 실행하지 않는다.
func ReadSignature(gitDir, commonDir string) (Signature, error) {
	head, err := os.ReadFile(filepath.Join(gitDir, headFile))
	if err != nil {
		// HEAD 가 없는 gitdir 은 저장소가 아니다. 여기서 조용히 빈 값을 내면
		// signature 가 영원히 같아 보이고 UI 는 낡은 상태를 확신한다.
		return Signature{}, err
	}
	sig := Signature{Head: strings.TrimSpace(string(head))}
	// index·ref 의 mtime·size 는 없으면 0 이다. **오류가 아니다** — 초기 저장소에는
	// index 가 없을 수 있다.
	sig.IndexMtimeNs, sig.IndexSize = statMtimeSize(filepath.Join(gitDir, indexFile))
	if rest, ok := strings.CutPrefix(sig.Head, symrefPrefix); ok {
		sig.RefName = strings.TrimSpace(rest)
		// packed 상태의 ref 는 개별 파일이 없다 — 그때는 packed-refs 가 변화를 담는다.
		if sig.RefMtimeNs, _ = statMtimeSize(filepath.Join(commonDir, filepath.FromSlash(sig.RefName))); sig.RefMtimeNs == 0 {
			sig.RefMtimeNs, _ = statMtimeSize(filepath.Join(commonDir, packedRefsFile))
		}
	}
	// FR-GVR-21·23: ref 의 추가·삭제. `commonDir` 을 쓰는 이유는 worktree 가
	// 자기 gitdir 을 갖더라도 refs 는 공용이기 때문이다 (위 RefMtimeNs 와 같은 규약).
	sig.RefsMtimeNs = refsTreeMtime(commonDir)
	sig.Value = strings.Join([]string{
		sig.Head,
		strconv.FormatInt(sig.IndexMtimeNs, 10),
		strconv.FormatInt(sig.IndexSize, 10),
		sig.RefName,
		strconv.FormatInt(sig.RefMtimeNs, 10),
		strconv.FormatInt(sig.RefsMtimeNs, 10),
	}, sigSep)
	return sig, nil
}

// refsTreeMtime 은 `refs` 아래 디렉터리들의 mtime 과 `packed-refs` 를 하나로 접는다
// (FR-GVR-21·22·23).
//
// **파일마다 stat 하지 않는다.** 감지는 0.5초마다 도는 자리이고(FR-GIT-19), ref 는
// 수백 개일 수 있지만 그것을 담는 디렉터리는 보통 한 자릿수다. 파일이 생기거나
// 사라지면 **부모 디렉터리의 mtime 이 바뀌므로**, 추가·삭제를 잡는 데는 디렉터리만
// 보아도 충분하다.
//
// 남는 한계는 ref 가 **제자리에서 움직이는 것**이다 (FR-GVR-24) — 그때 디렉터리
// mtime 은 그대로다. 자기 저장소의 이동은 HEAD·index 가, 원격의 이동은
// `ahead`·`behind` 가 잡는다 (FR-GVR-11).
//
// git 을 실행하지 않는다 — stat 뿐이다.
func refsTreeMtime(commonDir string) int64 {
	// packed-refs 는 개별 파일이 사라진 뒤 전부를 담는 자리다.
	mt, size := statMtimeSize(filepath.Join(commonDir, packedRefsFile))
	sum := mt ^ size
	n := 0
	var walk func(dir string)
	walk = func(dir string) {
		if n >= refsWalkMaxDirs {
			return
		}
		ents, err := os.ReadDir(dir)
		if err != nil {
			return
		}
		n++
		if fi, err := os.Stat(dir); err == nil {
			// 경로를 섞지 않고 시각만 접으면 두 디렉터리가 같은 나노초에 바뀔 때
			// 서로를 지운다. 이름 길이를 함께 넣어 그 우연을 줄인다.
			sum ^= fi.ModTime().UnixNano() + int64(len(dir))
		}
		for _, e := range ents {
			if e.IsDir() {
				walk(filepath.Join(dir, e.Name()))
			}
		}
	}
	walk(filepath.Join(commonDir, refsDir))
	return sum
}

// statMtimeSize 는 stat 한 번으로 둘을 준다. size 를 함께 넣는 이유는 비용이 0 이고,
// mtime 해상도가 낮은 파일시스템에서 같은 초 안의 두 번째 쓰기를 놓치지 않기
// 위해서다.
func statMtimeSize(path string) (mtimeNs, size int64) {
	fi, err := os.Stat(path)
	if err != nil {
		return 0, 0
	}
	return fi.ModTime().UnixNano(), fi.Size()
}

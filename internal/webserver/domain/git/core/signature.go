package core

import (
	"context"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// Signature 는 .git 상태 변화를 싸게 감지하는 값이다 (FR-GIT-19, §2.6: 0.02ms).
// 값이 그대로면 status 재조회를 생략한다.
type Signature struct {
	Head         string `json:"head"`    // .git/HEAD 내용 (trim)
	RefName      string `json:"refName"` // HEAD 가 심볼릭이면 그 ref. 아니면 ""
	IndexMtimeNs int64  `json:"indexMtimeNs"`
	IndexSize    int64  `json:"indexSize"`
	RefMtimeNs   int64  `json:"refMtimeNs"`
	Value        string `json:"value"` // 위 전부를 합친 비교용 문자열
}

const (
	headFile       = "HEAD"
	indexFile      = "index"
	packedRefsFile = "packed-refs"
	symrefPrefix   = "ref: "
	sigSep         = "|"
)

// Signature 는 gitdir 을 해석한 뒤 파일만 읽는다.
//
// gitdir 해석에는 rev-parse 가 한 번 필요하다. 그것을 캐시해 **git 실행 없는**
// 감지 경로를 만드는 것은 Store 의 일이다 (§4 의 DefaultGitDirsTTL).
func (s *Service) Signature(ctx context.Context, repo string) (Signature, error) {
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
	sig.Value = strings.Join([]string{
		sig.Head,
		strconv.FormatInt(sig.IndexMtimeNs, 10),
		strconv.FormatInt(sig.IndexSize, 10),
		sig.RefName,
		strconv.FormatInt(sig.RefMtimeNs, 10),
	}, sigSep)
	return sig, nil
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

package gitapi

import (
	"net/http"
	"os"
	"path/filepath"

	"dongminal/internal/webserver/domain/git/core"
	"dongminal/internal/webserver/domain/wsentry"
)

// `git init` (REPO_TAB_UNIFY_SRS 묶음 C · FR-RTU-25~29).
//
// **왜 서버에 종단이 필요한가.** 화면에는 이미 Console 뷰가 있어 사용자가 손으로
// `git init` 을 칠 수 있다. 그런데 그 길은 세 가지를 남기지 못한다.
//
//  1. **핀** — init 한 자리가 저장소 목록에 들어가야 한다 (FR-RTU-27)
//  2. **캐시 무효화** — `RepoRoot` 는 실패를 2초 캐시하므로 그동안 화면이 여전히
//     "저장소가 아닙니다" 를 보인다 (FR-RTU-28)
//  3. **거부의 사유** — 이미 저장소인 자리, 디렉터리가 아닌 자리를 가려 준다
//
// 초기 브랜치 이름을 **주지 않는다.** 사용자의 `init.defaultBranch` 설정이 있고,
// 우리가 이름을 정하면 그 설정과 어긋난 저장소가 만들어진다.

func (s *GitServer) apiGitInit(w http.ResponseWriter, r *http.Request) {
	if s.Git == nil {
		gitUnavailable(w)
		return
	}
	path, ok := gitDecodePath(w, r)
	if !ok {
		return
	}
	if !filepath.IsAbs(path) {
		gitFail(w, http.StatusBadRequest, gitErrBadRequest, "path 는 절대경로여야 한다")
		return
	}
	// 정규화는 핀·Editor 목록과 **같은 함수**를 지나야 한다 (FR-EDT-24) — 갈리면
	// 방금 init 한 자리와 목록의 항목이 다른 문자열이 되어 짝이 조용히 깨진다.
	dir := wsentry.NormalizePath(path)
	fi, err := os.Stat(dir)
	if err != nil {
		gitFail(w, http.StatusBadRequest, gitErrBadRequest, "그런 폴더가 없습니다: "+dir)
		return
	}
	if !fi.IsDir() {
		gitFail(w, http.StatusBadRequest, gitErrBadRequest, "디렉터리가 아닙니다: "+dir)
		return
	}
	// 이미 저장소면 거부한다. **하위 디렉터리는 거부하지 않는다** — 저장소 안에
	// 또 저장소를 만드는 것은 사용자가 의도할 수 있는 일이고(서브모듈의 원본이
	// 그렇게 생긴다), 그 판정은 `RepoRoot` 가 이 경로 자신을 돌려줄 때만 참이다.
	if root, err := s.Git.RepoRoot(r.Context(), dir); err == nil && root == dir {
		gitFail(w, http.StatusConflict, gitErrExists, "이미 git 저장소입니다: "+dir)
		return
	}
	// **쓰기 경로를 지난다** (FR-GIT-95). `Exec` 은 읽기 전용이며 그 가드가
	// 이것을 막는다 — 거부된 호출도 기록에 남는 것이 그 설계의 요점이다.
	spec := core.WriteSpec{Argv: []string{"init"}}
	if out, err := s.Git.Service().ExecWrite(r.Context(), dir, spec); err != nil {
		gitFail(w, http.StatusInternalServerError, gitErrFailed, gitTail(gitInitErr(out.Stderr, err)))
		return
	}
	// FR-RTU-28: 실패의 기억을 지운다. 이것이 없으면 방금 만든 저장소가 2초 동안
	// 없는 것으로 보이고, 사용자는 init 이 실패했다고 읽는다.
	//
	// **둘 다 지운다.** 캐시의 키는 "물어본 cwd" 이고 화면은 사용자가 추가한
	// 형태(정규화 전)로 묻는다 — macOS 의 `/var` → `/private/var` 처럼 둘이
	// 갈리면 정규화된 쪽만 지워서는 그 실패가 그대로 남는다 (실측).
	s.Git.ForgetRoot(dir)
	if path != dir {
		s.Git.ForgetRoot(path)
	}
	// FR-RTU-27: 핀에 더한다. 같은 저장 안에서 Editor 행도 함께 선다 (FR-EDT-31).
	stored, lists, err := s.entries().PinAdd(dir)
	if err != nil {
		// 저장소는 이미 만들어졌다 — 그 사실을 되돌리지 않고 목록만 실패로 알린다.
		gitFail(w, http.StatusInternalServerError, gitErrFailed, gitTail(err.Error()))
		return
	}
	// `"ok": true` 는 이 표면의 성공 규약이다 (FR-GIT-73) — 200 만으로는 성공이
	// 아니며, 클라이언트의 `post()` 가 그 필드를 본다. 빠뜨리면 저장소는 만들어진
	// 채 화면만 실패로 남는다(실측).
	gitJSON(w, http.StatusOK, map[string]any{
		"ok": true, "repo": stored, "pinned": lists.Pinned, "editors": lists.Editors,
	})
}

// gitInitErr 는 사용자가 읽을 사유를 고른다. git 이 stderr 로 말했으면 그것이
// 우리 문장보다 낫다 — 권한·잠금 같은 실제 사유가 거기 있다.
func gitInitErr(stderr string, err error) string {
	if s := gitTail(stderr); s != "" {
		return s
	}
	return err.Error()
}

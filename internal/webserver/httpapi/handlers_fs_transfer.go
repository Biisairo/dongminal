package httpapi

import (
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

// GET /api/fs/download?root=<abs>&path=<abs> (FR-FTR-12).
func (s *Server) apiFSDownload(w http.ResponseWriter, r *http.Request) {
	root, ok := s.fsRoot(w, r.URL.Query().Get("root"))
	if !ok {
		return
	}
	// 다운로드는 **실재하는** 파일을 읽는다 — 링크는 따라간다. 조작(rename·delete)이
	// 링크 자신을 다루려고 fsResolveTarget 을 쓰는 것과 다른 자리다.
	target, err := fsResolveExisting(root, r.URL.Query().Get("path"))
	if err != nil {
		fsFailErr(w, err)
		return
	}
	serveDownload(w, target, jsonFail(w))
}

// POST /api/fs/upload?root=<abs>&dir=<abs> (FR-FTR-15·16).
//
// 같은 이름이 있으면 **거부한다.** 탐색기의 다른 조작이 전부 그렇다
// (FR-EDT-86·115) — 터미널 업로드의 자동 개명과 다른 것은 의도다 (D-3).
func (s *Server) apiFSUpload(w http.ResponseWriter, r *http.Request) {
	root, ok := s.fsRoot(w, r.URL.Query().Get("root"))
	if !ok {
		return
	}
	dir, err := fsResolveExisting(root, r.URL.Query().Get("dir"))
	if err != nil {
		fsFailErr(w, err)
		return
	}
	outPath, written, ok := s.uploadInto(w, r, dir, func(d, n string) (string, error) {
		if n == "" || n == "." || n == string(filepath.Separator) {
			return "", fsError{fsErrBadRequest, "파일 이름이 없다"}
		}
		// FR-ETR-17: `relPath` 가 있으면 대상 **아래로** 구조를 세운다. 없으면
		// 지금과 같다 — 확장이지 대체가 아니다 (D-8).
		//
		// 이 자리에서 읽는 이유: `uploadInto` 가 `r.FormFile` 로 본문을 이미
		// 파싱한 뒤라 폼 값이 서 있다. 그 전에 읽으려면 MaxBytesReader 보다
		// 앞서 파싱해야 하고, 그러면 상한이 무의미해진다 (FR-FTR-5).
		return fsUploadTarget(root, d, r.FormValue("relPath"), n)
	}, jsonFail(w))
	if !ok {
		return
	}
	fsJSON(w, http.StatusOK, map[string]any{
		"ok": true, "name": filepath.Base(outPath), "size": written, "path": outPath,
	})
}

// fsUploadTarget 은 업로드가 놓일 자리를 정한다 (FR-ETR-17·18·19).
//
// `rel` 이 비면 지금까지와 같이 `dir/name` 이다. 있으면 그것이 **대상 아래의
// 상대경로**이며 중간 디렉터리를 만든다 — 대상 `dir` 자신은 만들지 않는다
// (FR-FTR-6 은 그대로다, D-8).
//
// 경계 판정을 세 번 한다. 겹쳐 보이지만 각각 다른 탈출을 막는다:
//
//  1. `rel` 이 절대경로이거나 Clean 뒤 `..` 로 시작하는가 — 문자열 수준의 탈출
//  2. 합친 경로가 루트 아래인가 — 1 을 지난 뒤에도 남는 경계
//  3. **실재하는 가장 깊은 조상**이 루트 아래인가 — 중간에 링크가 있으면
//     `MkdirAll` 이 그것을 따라가 루트 밖에 쓴다. 1·2 는 문자열만 보므로
//     이것을 잡지 못한다
func fsUploadTarget(root, dir, rel, name string) (string, error) {
	if rel == "" {
		// 경계 판정을 이 자리에서 되풀이하는 비용이 잘못 놓인 파일 하나보다 싸다.
		return fsUnderRoot(root, filepath.Join(dir, name))
	}
	// 브라우저는 언제나 `/` 로 준다 (webkitRelativePath). 플랫폼 구분자로 옮겨야
	// Windows 에서 한 조각짜리 이름으로 읽히지 않는다.
	cleaned := filepath.Clean(filepath.FromSlash(rel))
	// **뿌리 붙은 경로도 거부한다.** Windows 의 `filepath.IsAbs` 는 볼륨이 없는
	// `\abs.txt` 를 절대경로로 보지 않아, POSIX 에서 400 이던 `/abs.txt` 가 그
	// 판에서만 통과해 `dir\abs.txt` 로 다시 읽혔다 — 같은 입력이 판마다 다른 뜻을
	// 갖는 것이 결함이다. 새는 자리는 아니지만(합친 경로는 대상 아래에 남는다)
	// 계약은 한 벌이어야 한다.
	if filepath.IsAbs(cleaned) || filepath.VolumeName(cleaned) != "" ||
		strings.HasPrefix(cleaned, string(filepath.Separator)) || strings.HasPrefix(rel, "/") {
		return "", fsError{fsErrBadRequest, "relPath 는 상대경로여야 한다"}
	}
	if cleaned == "." || cleaned == ".." ||
		strings.HasPrefix(cleaned, ".."+string(filepath.Separator)) {
		return "", fsError{fsErrBadRequest, "relPath 가 대상 밖을 가리킨다"}
	}
	target, err := fsUnderRoot(root, filepath.Join(dir, cleaned))
	if err != nil {
		return "", err
	}
	parent := filepath.Dir(target)
	if err := fsExistingAncestorUnderRoot(root, parent); err != nil {
		return "", err
	}
	// FR-ETR-19·20: 중간 디렉터리는 만든다. 이미 있는 것은 충돌이 아니다 —
	// 충돌 판정은 마지막 조각에 대해 O_EXCL 이 한다 (uploadInto).
	if err := os.MkdirAll(parent, 0o755); err != nil {
		return "", fsFromOS(err)
	}
	return target, nil
}

// fsExistingAncestorUnderRoot 은 **실재하는 가장 깊은 조상**을 풀어 루트 아래인지
// 본다. 아직 없는 조각은 링크일 수 없으므로 볼 것이 없고, 있는 조각 중 하나가
// 링크면 `MkdirAll` 이 그것을 따라간다.
func fsExistingAncestorUnderRoot(root, dir string) error {
	p := dir
	for {
		if _, err := os.Lstat(p); err == nil {
			break
		}
		up := filepath.Dir(p)
		if up == p {
			return fsError{fsErrNotFound, "대상의 조상을 찾을 수 없다"}
		}
		p = up
	}
	resolved, err := filepath.EvalSymlinks(p)
	if err != nil {
		return fsResolveErr(err)
	}
	_, err = fsUnderRoot(root, resolved)
	return err
}

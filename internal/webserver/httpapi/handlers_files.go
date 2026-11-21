package httpapi

import (
	"fmt"
	"net/http"

	"os"
	"path/filepath"
	"strings"

	"dongminal/internal/shared/httpresp"
)

// 파일 종단의 경로 가드(safeResolve·uniquePath)와 실패 형식. 경로 가드를 손볼 때 봐야
// 할 면이 이 파일에 모인다. 종단은 주제별 파일에 있다 — 업로드·다운로드·cwd
// (`handlers_files_transfer.go`) · 표식(`handlers_files_stamp.go`) · 읽기·쓰기
// (`handlers_files_rw.go`).

func uniquePath(dir, name string) string {
	p := filepath.Join(dir, name)
	if _, err := os.Stat(p); err != nil {
		return p
	}
	ext := filepath.Ext(name)
	base := strings.TrimSuffix(name, ext)
	for i := 1; ; i++ {
		p = filepath.Join(dir, fmt.Sprintf("%s (%d)%s", base, i, ext))
		if _, err := os.Stat(p); err != nil {
			return p
		}
	}
}

// safeResolve verifies that userPath resolves within baseDir, preventing
// path-traversal attacks.
func safeResolve(baseDir, userPath string) (string, error) {
	cleaned := filepath.Clean(userPath)
	if !filepath.IsAbs(cleaned) {
		var err error
		cleaned, err = filepath.Abs(cleaned)
		if err != nil {
			return "", err
		}
	}
	// 베이스가 파일시스템 루트면 **제한이 없다는 뜻**이다 — 전송 종단은
	// safeResolve("/", …) 로 부르며, 그 "/" 는 "POSIX 루트 아래" 가 아니라
	// "어디든" 을 적은 것이다 (handlers_fs.go:21 의 대비 설명 참조).
	//
	// 이 갈래가 없으면 Windows 에서 전송이 통째로 막힌다 (FR-WTP-7).
	// filepath.Rel("/", `C:\Users\x`) 는 볼륨이 달라 오류이고, 그 오류가
	// 그대로 403 forbidden 이 된다. 업로드도 다운로드도 한 건도 되지 않는다.
	//
	// POSIX 에서는 동작이 같다 — 루트를 베이스로 한 Rel 은 절대경로에 대해
	// 언제나 성공하고 ".." 로 시작하지 않는다.
	if isFilesystemRoot(baseDir) {
		return cleaned, nil
	}
	rel, err := filepath.Rel(baseDir, cleaned)
	if err != nil {
		return "", err
	}
	if strings.HasPrefix(rel, "..") {
		return "", fmt.Errorf("path escapes base directory")
	}
	return cleaned, nil
}

// isFilesystemRoot 은 그 경로가 파일시스템의 꼭대기인지 본다. POSIX 는 "/",
// Windows 는 `\` 와 `C:\` 류다. 호출부가 적는 "/" 는 Windows 에서
// filepath.Clean 을 거치면 `\` 가 되므로 둘 다 받는다.
func isFilesystemRoot(p string) bool {
	c := filepath.Clean(p)
	sep := string(filepath.Separator)
	return c == sep || c == filepath.VolumeName(c)+sep
}

// failFn 은 전송 종단의 실패 형식이다. 두 표면이 다른 것은 이것뿐이라
// (터미널은 text/plain, 탐색기는 JSON 코드) 나머지를 전부 공유할 수 있다.
type failFn func(status int, code, msg string)

// textFail 은 터미널 표면의 형식이다 — 브라우저가 직접 내비게이션하는 종단이라
// JSON 을 읽을 사람이 없다. 본문에 서버 경로를 싣지 않는다 (FR-FTR-3).
func textFail(w http.ResponseWriter) failFn {
	// 코드를 버리지 않는다 (FR-ERR-4). 본문은 종전대로 평문이고, 코드는
	// 헤더로 간다 — 이 종단의 소비자가 사람이라는 사실과 기계가 분기할 수 있다는
	// 사실이 서로를 밀어내지 않는다.
	return func(status int, code, msg string) { httpErr(w, msg, status, code) }
}

// jsonFail 은 탐색기 표면의 형식이다 — /api/fs/* 의 코드 규약을 그대로 쓴다
// (FR-EDT-117).
func jsonFail(w http.ResponseWriter) failFn {
	// FR-ERR-7: 본문의 코드와 같은 값을 헤더로도 낸다 — `FailCode` 가 둘을 함께 쓴다.
	return func(status int, code, msg string) { httpresp.FailCode(w, status, code, msg) }
}

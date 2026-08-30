package httpapi

import (
	"archive/zip"
	"errors"
	"io"
	"io/fs"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"
)

// GET /api/fs/download-dir — 폴더를 zip 으로 흘려보낸다
// (EXPLORER_TRANSFER_IGNORE_SRS 묶음 B, FR-ETR-9~16).
//
// **왜 zip 인가.** 폴더를 구조 그대로 로컬 디스크에 쓰는 것은 브라우저에서
// File System Access API 로만 가능하고, 그것은 secure context(HTTPS 또는
// localhost)를 요구한다. 서버는 평문 HTTP 로 뜨고 접속은 Tailscale IP 이므로
// 조건이 성립하지 않는다 (D-4).
//
// **순서가 설계다.** 세기가 쓰기보다 **먼저**다 (D-6). 헤더가 한 줄이라도 나간
// 뒤에는 오류를 보낼 자리가 없다 — 그래서 상한 초과는 본문 0바이트의 400 이고,
// 스트리밍이 시작된 뒤의 실패는 그 파일을 건너뛰는 것으로만 다룬다 (FR-ETR-15).

// 상한. const 가 아닌 것은 테스트가 낮춰 잡기 위해서다 — 실제 값으로 픽스처를
// 만들면 테스트가 파일 5만 개를 만든다 (fsListMax·uploadMaxBytes 와 같은 관례).
var (
	// FR-ETR-12: 항목 수 상한. 트리 전체를 걷는 비용의 상한이기도 하다.
	zipMaxEntries = 50000
	// FR-ETR-12: 압축 **전** 총 바이트의 상한.
	zipMaxBytes int64 = 2 << 30
)

func (s *Server) apiFSDownloadDir(w http.ResponseWriter, r *http.Request) {
	root, ok := s.fsRoot(w, r.URL.Query().Get("root"))
	if !ok {
		return
	}
	// 파일 다운로드와 같이 **실재하는** 경로를 푼다 — 링크로 가리킨 폴더도
	// 내려받을 수 있어야 한다 (apiFSDownload 와 같은 자리).
	target, err := fsResolveExisting(root, r.URL.Query().Get("path"))
	if err != nil {
		fsFailErr(w, err)
		return
	}
	st, err := os.Stat(target)
	if err != nil {
		fsFailErr(w, fsFromOS(err))
		return
	}
	// FR-ETR-11: 파일은 /api/fs/download 의 자리다. 두 종단이 서로의 일을
	// 대신하지 않는다.
	if !st.IsDir() {
		fsFail(w, fsErrBadRequest, "디렉터리가 아니다")
		return
	}
	// FR-ETR-12 (D-6): **헤더를 쓰기 전에** 판정을 끝낸다.
	if err := zipWithinLimits(target); err != nil {
		fsFailErr(w, err)
		return
	}

	w.Header().Set("Content-Type", "application/zip")
	w.Header().Set("Content-Disposition", attachmentDisposition(zipDownloadName(target)))
	// Content-Length 를 싣지 않는다 — 압축 후 크기를 미리 알 수 없다.
	// 청크 전송이 되며, 그것이 스트리밍의 대가다.
	writeZipTree(w, target)
}

// zipWithinLimits 는 항목 수와 총 바이트를 함께 센다. 상한을 넘는 것이 확정된
// 순간 멈춘다 — 남은 트리를 계속 걸을 이유가 없다 (fsCountEntries 와 같은 관례).
//
// 링크는 세지 않는다. zip 에 담기지 않으므로(FR-ETR-14) 세면 상한이 담기지도
// 않을 것에 소모된다.
func zipWithinLimits(root string) error {
	entries := 0
	var total int64
	err := filepath.WalkDir(root, func(_ string, d fs.DirEntry, err error) error {
		if err != nil {
			// 읽을 수 없는 자리는 **세기에서 건너뛴다.** 쓰기 단계도 같은
			// 자리를 건너뛰므로(FR-ETR-15) 판정과 결과가 어긋나지 않는다.
			if errors.Is(err, fs.ErrPermission) {
				return nil
			}
			return err
		}
		if d.Type()&os.ModeSymlink != 0 {
			return nil
		}
		entries++
		if entries > zipMaxEntries {
			return errFSCountOver
		}
		if d.IsDir() {
			return nil
		}
		info, err := d.Info()
		if err != nil {
			return nil
		}
		total += info.Size()
		if total > zipMaxBytes {
			return errFSCountOver
		}
		return nil
	})
	if errors.Is(err, errFSCountOver) {
		return fsError{fsErrBadRequest, "폴더가 상한을 넘었다 — 더 작은 폴더를 받으세요"}
	}
	if err != nil {
		return fsFromOS(err)
	}
	return nil
}

// writeZipTree 는 트리를 zip 으로 쓴다. **이 함수가 시작된 뒤의 실패는 응답으로
// 알릴 수 없다** — 헤더가 이미 나갔다. 그래서 개별 파일의 실패는 건너뛰고
// 계속한다 (FR-ETR-15).
//
// 엔트리 이름은 **대상 폴더 이름을 뿌리로** 하는 상대경로다. 풀었을 때 폴더
// 하나가 나와야 사용자가 "복사" 로 읽는다.
func writeZipTree(w io.Writer, root string) {
	zw := zip.NewWriter(w)
	defer zw.Close()

	base := filepath.Base(root)
	filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			// 읽을 수 없는 디렉터리는 그 아래를 건너뛴다. WalkDir 은 이 오류를
			// 디렉터리 자신에 대해 준다.
			return nil
		}
		// FR-ETR-14: 링크는 담지 않는다. 따라가면 순환과 루트 밖 유출이 함께
		// 열리고, 링크로 저장하면 푸는 쪽 플랫폼마다 결과가 갈린다 (D-7).
		if d.Type()&os.ModeSymlink != 0 {
			return nil
		}
		name, ok := zipEntryName(root, base, p)
		if !ok {
			return nil
		}
		if d.IsDir() {
			// 루트 자신은 엔트리로 넣지 않는다 — 하위 이름이 이미 그것으로
			// 시작한다. 빈 디렉터리는 넣어야 구조가 보존된다 (FR-ETR-14).
			if p == root {
				return nil
			}
			zw.Create(name + "/")
			return nil
		}
		if !d.Type().IsRegular() {
			// 소켓·디바이스 따위. 담을 뜻이 없다.
			return nil
		}
		writeZipFile(zw, p, name, d)
		return nil
	})
}

// zipEntryName 은 zip 안의 경로를 만든다. zip 은 구분자로 `/` 만 쓰므로
// Windows 의 `\` 를 바꾼다 — 그러지 않으면 푸는 쪽이 이름에 역슬래시가 든
// 파일 하나로 읽는다.
func zipEntryName(root, base, p string) (string, bool) {
	rel, err := filepath.Rel(root, p)
	if err != nil {
		return "", false
	}
	if rel == "." {
		return base, true
	}
	return path.Join(base, filepath.ToSlash(rel)), true
}

// writeZipFile 은 파일 하나를 담는다. 실패하면 **조용히 건너뛴다** — 헤더가 이미
// 나갔으므로 알릴 자리가 없고, 절반짜리 zip 보다 하나 빠진 zip 이 낫다
// (FR-ETR-15).
func writeZipFile(zw *zip.Writer, p, name string, d fs.DirEntry) {
	f, err := os.Open(p)
	if err != nil {
		return
	}
	defer f.Close()

	hdr := &zip.FileHeader{Name: name, Method: zip.Deflate}
	// mtime 과 권한을 보존한다. 정보를 못 읽어도 담는 것 자체는 계속한다.
	if info, err := d.Info(); err == nil {
		hdr.Modified = info.ModTime()
		hdr.SetMode(info.Mode())
	}
	dst, err := zw.CreateHeader(hdr)
	if err != nil {
		return
	}
	io.Copy(dst, f)
}

// zipSuffix 는 이름 규칙을 한 자리에 둔다. 클라이언트가 `<a download>` 로 쓰는
// 이름과 서버의 헤더가 어긋나지 않아야 한다 (FR-ETR-10).
const zipSuffix = ".zip"

// zipDownloadName 은 폴더 이름에서 내려받을 파일 이름을 만든다. 이름이 비면
// (파일시스템 루트 등) attachmentDisposition 의 폴백이 받는다.
func zipDownloadName(dir string) string {
	base := filepath.Base(dir)
	if base == "" || base == string(filepath.Separator) || strings.TrimSpace(base) == "" {
		return "download" + zipSuffix
	}
	return base + zipSuffix
}

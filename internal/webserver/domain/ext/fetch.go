package ext

import (
	"archive/tar"
	"archive/zip"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"slices"
	"strings"
	"time"
)

// FetchTimeout 은 아카이브 하나를 받는 시간 상한이다 (FR-EXT-18).
//
// 넉넉한 이유는 런타임이 100 MB 대이기 때문이다. 그래도 상한이 있어야 한다 —
// 없으면 답하지 않는 네트워크에서 조달이 영영 끝나지 않고, 사용자는 버튼이 죽은
// 것으로 읽는다.
const FetchTimeout = 10 * time.Minute

// MaxArchiveBytes 는 아카이브 하나의 크기 상한이다 (OPTIMIZE_REFACTOR_SRS
// FR-OPT-1-11). 시간 상한만 있으면 끝없이 흘러오는 응답이 그 시간 동안 임시
// 디스크를 채운다. 런타임이 100 MB 대이므로 넉넉히 잡는다. 검사가 낮춰 쓸 수
// 있도록 var 다.
var MaxArchiveBytes int64 = 1 << 30

// stagingSuffix 는 새 설치를 풀어 두는 옆 자리의 꼬리다. 팩 id 는 이것으로 끝날 수
// 없다 (FR-ATF-22).
const stagingSuffix = ".new"

// ErrArchiveTooLarge 는 받는 중에 MaxArchiveBytes 를 넘었다는 뜻이다.
var ErrArchiveTooLarge = errors.New("아카이브가 크기 상한을 넘었습니다")

// capWriter 는 상한을 넘는 쓰기를 거절한다. 상한까지만 쓰고 끊어, 넘은 것을
// 해시 대조 전에 가린다.
type capWriter struct {
	w    io.Writer
	left int64
}

func (c *capWriter) Write(p []byte) (int, error) {
	if int64(len(p)) > c.left {
		return 0, ErrArchiveTooLarge
	}
	c.left -= int64(len(p))
	return c.w.Write(p)
}

// Fetch 는 URL 하나를 받아 쓴다. **주입점이다** (§2.5 ③) — 네트워크도 툴체인도
// 없는 호스트에서 조달의 판정을 잴 수 있어야 한다.
type Fetch func(ctx context.Context, url string, w io.Writer) error

// HTTPFetch 는 실제 네트워크다.
func HTTPFetch(ctx context.Context, url string, w io.Writer) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("%s: %s", url, resp.Status)
	}
	_, err = io.Copy(w, resp.Body)
	return err
}

// FetchArchive 는 타깃 하나를 받아 `dest` 에 푼다 (FR-EXT-11·15·39).
//
// 순서가 규칙이다: **받고 → 해시를 대조하고 → 푼다.** 스트리밍으로 풀면서 검증하면
// 어긋난 것을 알았을 때 이미 파일이 놓여 있다. 그리고 실패는 **아무것도 남기지
// 않는다** — 반쯤 풀린 자리가 남으면 다음 탐색이 그것을 서버로 삼는다.
func FetchArchive(ctx context.Context, fetch Fetch, t Target, dest string) error {
	if fetch == nil {
		return fmt.Errorf("조달을 실행할 수 없습니다")
	}
	if err := t.validate(); err != nil {
		return err
	}

	tmp, err := os.CreateTemp("", "dm-ext-*")
	if err != nil {
		return fmt.Errorf("임시 파일을 만들지 못했습니다: %w", err)
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)

	h := sha256.New()
	err = fetch(ctx, t.URL, &capWriter{w: io.MultiWriter(tmp, h), left: MaxArchiveBytes})
	closeErr := tmp.Close()
	if err != nil {
		return fmt.Errorf("%s 를 받지 못했습니다: %w", t.URL, err)
	}
	if closeErr != nil {
		return fmt.Errorf("받은 것을 저장하지 못했습니다: %w", closeErr)
	}

	// FR-EXT-15: 여기가 검증의 자리다. 어긋나면 풀지 않는다.
	if got := hex.EncodeToString(h.Sum(nil)); !strings.EqualFold(got, t.SHA256) {
		return fmt.Errorf("받은 것의 sha256 이 선언과 다릅니다 (선언 %s, 실제 %s) — 풀지 않았습니다",
			t.SHA256, got)
	}

	// 옆에 풀고 통째로 갈아 끼운다 — 반쯤 풀린 상태가 보이는 창을 만들지 않고,
	// 옛 판의 파일이 새 판에 섞이지도 않는다 (FR-EXT-24).
	staging := dest + stagingSuffix
	_ = os.RemoveAll(staging)
	if err := os.MkdirAll(staging, 0o755); err != nil {
		return fmt.Errorf("풀 자리를 만들지 못했습니다: %w", err)
	}
	if err := place(tmpName, staging, t); err != nil {
		_ = os.RemoveAll(staging)
		return err
	}
	// server 팩은 선언과 같은 자리에 받는다 — 갈아 끼울 때 선언을 옮겨 담는다. 지우면 그 팩이
	// 목록에서 빠지고 같은 확장자의 다른 팩이 대신 풀린다 (EDITOR_LINK_LSP_SRS FR-ELS-3).
	if err := keepManifest(dest, staging); err != nil {
		_ = os.RemoveAll(staging)
		return err
	}
	if err := os.MkdirAll(filepath.Dir(dest), 0o755); err != nil {
		_ = os.RemoveAll(staging)
		return fmt.Errorf("자리를 만들지 못했습니다: %w", err)
	}
	_ = os.RemoveAll(dest)
	if err := os.Rename(staging, dest); err != nil {
		_ = os.RemoveAll(staging)
		return fmt.Errorf("풀어 둔 것을 옮기지 못했습니다: %w", err)
	}
	return nil
}

// keepManifest 는 `dest` 의 선언을 `staging` 으로 옮겨 담는다. 선언이 없으면 아무것도 하지 않는다.
func keepManifest(dest, staging string) error {
	f, err := os.Open(filepath.Join(dest, ManifestName))
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("선언을 읽지 못했습니다: %w", err)
	}
	defer f.Close()
	if err := writeFile(filepath.Join(staging, ManifestName), f, 0o644); err != nil {
		return fmt.Errorf("선언을 옮기지 못했습니다: %w", err)
	}
	return nil
}

// place 는 받은 것을 `dir` 에 놓는다. raw 이면 `bin` 자리에 그대로, 아니면 푼다.
func place(blob, dir string, t Target) error {
	if !t.Raw {
		return extract(blob, dir, t.Strip)
	}
	f, err := os.Open(blob)
	if err != nil {
		return fmt.Errorf("받은 것을 열지 못했습니다: %w", err)
	}
	defer f.Close()
	return writeFile(filepath.Join(dir, filepath.FromSlash(t.Bin)), f, 0o755)
}

// extract 는 확장자로 갈라 푼다.
//
// 형식을 URL 이 아니라 **파일 내용**으로 판정하지 않는 이유는 단순함이다 — 공식
// 배포본의 이름은 안정적이고, 틀린 형식은 파싱에서 곧바로 실패한다.
func extract(archive, dest string, strip int) error {
	u, err := newUnpacker(dest)
	if err != nil {
		return err
	}
	if strings.HasSuffix(strings.ToLower(archive), ".zip") || isZip(archive) {
		return extractZip(archive, u, strip)
	}
	return extractTarGz(archive, u, strip)
}

// unpacker 는 엔트리를 격리 칸 하나에 놓는다 (FR-ATF-20).
//
// 이름·링크 문자열의 검사(entryPath·checkLinkTarget)는 앞서 놓인 링크를 모른다 —
// `b→c/..`, `a→b/..` 는 둘 다 칸 안을 가리키는 문자열이지만 `a/evil` 은 칸의 부모에
// 쓰인다. 그래서 쓰기 전에 **디스크의 실경로**를 본다.
type unpacker struct {
	dest string
	// real 은 dest 의 실경로다. 비교의 기준이다.
	real string
}

func newUnpacker(dest string) (*unpacker, error) {
	real, err := filepath.EvalSymlinks(dest)
	if err != nil {
		return nil, fmt.Errorf("풀 자리를 확인하지 못했습니다: %w", err)
	}
	return &unpacker{dest: dest, real: real}, nil
}

func (u *unpacker) inside(real string) bool {
	rel, err := filepath.Rel(u.real, real)
	if err != nil || filepath.IsAbs(rel) {
		return false
	}
	return rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
}

// mkdir 은 dir 을 만든다. 이미 있는 가장 가까운 조상의 실경로가 칸 안일 때만이다 —
// MkdirAll 이 링크를 따라 칸 밖에 디렉터리를 만들기 전에 본다.
func (u *unpacker) mkdir(dir string) error {
	p := dir
	for {
		if _, err := os.Lstat(p); err == nil {
			break
		}
		parent := filepath.Dir(p)
		if parent == p {
			break
		}
		p = parent
	}
	real, err := filepath.EvalSymlinks(p)
	if err != nil {
		return fmt.Errorf("아카이브의 경로를 확인하지 못했습니다: %w", err)
	}
	if !u.inside(real) {
		return fmt.Errorf("아카이브의 경로가 격리 칸 밖으로 이어집니다: %q", dir)
	}
	return os.MkdirAll(dir, 0o755)
}

// file 은 보통 파일 하나를 쓴다. 그 자리에 링크가 있으면 따라가지 않고 지운 뒤 쓴다.
func (u *unpacker) file(target string, r io.Reader, perm os.FileMode) error {
	if err := u.mkdir(filepath.Dir(target)); err != nil {
		return err
	}
	if fi, err := os.Lstat(target); err == nil && fi.Mode()&os.ModeSymlink != 0 {
		if err := os.Remove(target); err != nil {
			return err
		}
	}
	return writeFile(target, r, perm)
}

// symlink 는 상대 경로이고 해석 결과가 칸 안인 링크만 만든다. 아직 대상이 없는
// 링크는 남기되, 그 뒤의 쓰기가 mkdir 의 실경로 검사를 지난다.
func (u *unpacker) symlink(rel, target, link string) error {
	// FR-EXT-39: 이름은 안쪽인데 **가리키는 곳이 밖**인 갈래다. 엔트리
	// 이름만 보는 가드로는 막지 못한다.
	if err := checkLinkTarget(rel, link); err != nil {
		return err
	}
	if err := u.mkdir(filepath.Dir(target)); err != nil {
		return err
	}
	_ = os.Remove(target)
	if err := os.Symlink(link, target); err != nil {
		return err
	}
	real, err := filepath.EvalSymlinks(target)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil || !u.inside(real) {
		_ = os.Remove(target)
		return fmt.Errorf("링크가 격리 칸 밖을 가리킵니다: %q → %q", rel, link)
	}
	return nil
}

// hardlink 는 tar 하드링크를 복사로 놓는다. 대상 이름은 아카이브 뿌리 기준이라
// strip 을 똑같이 적용한다 (AT-EXT-8).
//
//	이전 동작: 하드링크를 심볼릭 링크로 만들고 strip 을 적용하지 않았다 — 깨진 링크
//	새  동작: strip 을 적용한 칸 안의 보통 파일을 복사한다
//	이유:     FR-ATF-20
func (u *unpacker) hardlink(target, linkname string, strip int) error {
	srcRel, skip, err := entryPath(linkname, strip)
	if err != nil {
		return err
	}
	if skip {
		return fmt.Errorf("하드링크의 대상이 없습니다: %q", linkname)
	}
	src := filepath.Join(u.dest, srcRel)
	fi, err := os.Lstat(src)
	if err != nil || !fi.Mode().IsRegular() {
		return fmt.Errorf("하드링크의 대상이 보통 파일이 아닙니다: %q", linkname)
	}
	real, err := filepath.EvalSymlinks(src)
	if err != nil || !u.inside(real) {
		return fmt.Errorf("하드링크가 격리 칸 밖을 가리킵니다: %q", linkname)
	}
	f, err := os.Open(real)
	if err != nil {
		return err
	}
	defer f.Close()
	return u.file(target, f, fi.Mode().Perm())
}

func isZip(p string) bool {
	f, err := os.Open(p)
	if err != nil {
		return false
	}
	defer f.Close()
	var magic [4]byte
	if _, err := io.ReadFull(f, magic[:]); err != nil {
		return false
	}
	return magic[0] == 'P' && magic[1] == 'K'
}

func extractTarGz(archive string, u *unpacker, strip int) error {
	f, err := os.Open(archive)
	if err != nil {
		return err
	}
	defer f.Close()
	gz, err := gzip.NewReader(f)
	if err != nil {
		return fmt.Errorf("아카이브를 열지 못했습니다: %w", err)
	}
	defer gz.Close()

	tr := tar.NewReader(gz)
	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return fmt.Errorf("아카이브가 온전하지 않습니다: %w", err)
		}
		rel, skip, err := entryPath(hdr.Name, strip)
		if err != nil {
			return err
		}
		if skip {
			continue
		}
		target := filepath.Join(u.dest, rel)

		switch hdr.Typeflag {
		case tar.TypeDir:
			if err := u.mkdir(target); err != nil {
				return err
			}
		case tar.TypeReg:
			if err := u.file(target, tr, os.FileMode(hdr.Mode).Perm()); err != nil {
				return err
			}
		case tar.TypeSymlink:
			if err := u.symlink(rel, target, hdr.Linkname); err != nil {
				return err
			}
		case tar.TypeLink:
			if err := u.hardlink(target, hdr.Linkname, strip); err != nil {
				return err
			}
		default:
			// 장치·FIFO 따위는 만들지 않는다. 언어 서버 배포본에 있을 것이
			// 아니며, 만들 수 있게 두면 그 자체가 표면이 된다.
			continue
		}
	}
}

func extractZip(archive string, u *unpacker, strip int) error {
	zr, err := zip.OpenReader(archive)
	if err != nil {
		return fmt.Errorf("아카이브를 열지 못했습니다: %w", err)
	}
	defer zr.Close()

	for _, f := range zr.File {
		rel, skip, err := entryPath(f.Name, strip)
		if err != nil {
			return err
		}
		if skip {
			continue
		}
		target := filepath.Join(u.dest, rel)
		if f.FileInfo().IsDir() {
			if err := u.mkdir(target); err != nil {
				return err
			}
			continue
		}
		rc, err := f.Open()
		if err != nil {
			return err
		}
		err = u.file(target, rc, f.Mode().Perm())
		rc.Close()
		if err != nil {
			return err
		}
	}
	return nil
}

// entryPath 는 아카이브 엔트리 이름을 **격리 칸 안의 상대경로**로 푼다
// (FR-EXT-39 / V-EXT-6).
//
// tar·zip 은 엔트리 이름에 아무 경로나 적을 수 있다. 이 가드가 없으면 매니페스트
// 하나로 사용자 홈의 파일이 덮인다 (zip slip).
func entryPath(name string, strip int) (rel string, skip bool, err error) {
	n := strings.ReplaceAll(name, `\`, "/")
	if strings.HasPrefix(n, "/") {
		return "", false, fmt.Errorf("아카이브가 절대경로를 담고 있습니다: %q", name)
	}
	if len(n) >= 2 && n[1] == ':' {
		return "", false, fmt.Errorf("아카이브가 드라이브 경로를 담고 있습니다: %q", name)
	}
	// Clean **전에** 본다. `a/../../x` 는 Clean 뒤에 `../x` 가 되지만, 그 전에
	// 어느 칸이 `..` 인지를 봐야 "가운데로 파고드는" 갈래도 같은 자리에서 막힌다.
	if slices.Contains(strings.Split(n, "/"), "..") {
		return "", false, fmt.Errorf("아카이브가 상위 경로를 담고 있습니다: %q", name)
	}
	c := path.Clean(n)
	if c == "." || c == "" {
		return "", true, nil
	}

	if strip > 0 {
		segs := strings.Split(c, "/")
		if len(segs) <= strip {
			// 벗겨내면 남는 것이 없는 엔트리다 — 씌운 겹 자체이므로 지난다.
			return "", true, nil
		}
		c = strings.Join(segs[strip:], "/")
	}
	return filepath.FromSlash(c), false, nil
}

// checkLinkTarget 은 링크가 격리 칸 안을 가리키는가다.
func checkLinkTarget(rel, link string) error {
	if link == "" {
		return fmt.Errorf("링크가 빈 곳을 가리킵니다: %q", rel)
	}
	l := strings.ReplaceAll(link, `\`, "/")
	if strings.HasPrefix(l, "/") || (len(l) >= 2 && l[1] == ':') {
		return fmt.Errorf("링크가 절대경로를 가리킵니다: %q → %q", rel, link)
	}
	// 링크가 놓일 자리에서 출발해 따라간 결과가 칸 밖이면 거절한다.
	joined := path.Join(path.Dir(filepath.ToSlash(rel)), l)
	if joined == ".." || strings.HasPrefix(joined, "../") {
		return fmt.Errorf("링크가 격리 칸 밖을 가리킵니다: %q → %q", rel, link)
	}
	return nil
}

func writeFile(target string, r io.Reader, perm os.FileMode) error {
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		return err
	}
	if perm == 0 {
		perm = 0o644
	}
	f, err := os.OpenFile(target, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, perm)
	if err != nil {
		return err
	}
	if _, err := io.Copy(f, r); err != nil {
		f.Close()
		return err
	}
	return f.Close()
}

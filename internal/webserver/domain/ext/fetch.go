package ext

import (
	"archive/tar"
	"archive/zip"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
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
	err = fetch(ctx, t.URL, io.MultiWriter(tmp, h))
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
	staging := dest + ".new"
	_ = os.RemoveAll(staging)
	if err := os.MkdirAll(staging, 0o755); err != nil {
		return fmt.Errorf("풀 자리를 만들지 못했습니다: %w", err)
	}
	if err := extract(tmpName, staging, t.Strip); err != nil {
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

// extract 는 확장자로 갈라 푼다.
//
// 형식을 URL 이 아니라 **파일 내용**으로 판정하지 않는 이유는 단순함이다 — 공식
// 배포본의 이름은 안정적이고, 틀린 형식은 파싱에서 곧바로 실패한다.
func extract(archive, dest string, strip int) error {
	if strings.HasSuffix(strings.ToLower(archive), ".zip") || isZip(archive) {
		return extractZip(archive, dest, strip)
	}
	return extractTarGz(archive, dest, strip)
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

func extractTarGz(archive, dest string, strip int) error {
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
		target := filepath.Join(dest, rel)

		switch hdr.Typeflag {
		case tar.TypeDir:
			if err := os.MkdirAll(target, 0o755); err != nil {
				return err
			}
		case tar.TypeReg:
			if err := writeFile(target, tr, os.FileMode(hdr.Mode).Perm()); err != nil {
				return err
			}
		case tar.TypeSymlink, tar.TypeLink:
			// FR-EXT-39: 이름은 안쪽인데 **가리키는 곳이 밖**인 갈래다. 엔트리
			// 이름만 보는 가드로는 막지 못한다.
			if err := checkLinkTarget(rel, hdr.Linkname); err != nil {
				return err
			}
			if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
				return err
			}
			_ = os.Remove(target)
			if err := os.Symlink(hdr.Linkname, target); err != nil {
				return err
			}
		default:
			// 장치·FIFO 따위는 만들지 않는다. 언어 서버 배포본에 있을 것이
			// 아니며, 만들 수 있게 두면 그 자체가 표면이 된다.
			continue
		}
	}
}

func extractZip(archive, dest string, strip int) error {
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
		target := filepath.Join(dest, rel)
		if f.FileInfo().IsDir() {
			if err := os.MkdirAll(target, 0o755); err != nil {
				return err
			}
			continue
		}
		rc, err := f.Open()
		if err != nil {
			return err
		}
		err = writeFile(target, rc, f.Mode().Perm())
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

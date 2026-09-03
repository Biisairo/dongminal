package sandbox

import (
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"time"
)

// DefaultHelperDeps 는 실제 환경의 주입값이다.
func DefaultHelperDeps(home, version string) HelperDeps {
	return HelperDeps{
		Version:    version,
		Arch:       runtime.GOARCH,
		Home:       home,
		Stat:       func(p string) error { _, err := os.Stat(p); return err },
		Fetch:      fetchHelper,
		CrossBuild: crossBuildHelper,
		ListCache:  listCacheFiles,
		Remove:     os.Remove,
	}
}

// fetchHelper 는 릴리스 자산을 내려받아 실행 가능하게 놓는다.
//
// 임시 파일에 받아 두었다가 옮기는 것은, 받다 만 파일이 캐시에 남으면 다음
// 기동이 그것을 "이미 있다" 로 읽기 때문이다 (EnsureHelper 의 첫 갈래).
func fetchHelper(url, dest string) error {
	if err := os.MkdirAll(filepath.Dir(dest), 0o755); err != nil {
		return err
	}
	client := &http.Client{Timeout: 5 * time.Minute}
	resp, err := client.Get(url)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("응답 %s", resp.Status)
	}

	tmp, err := os.CreateTemp(filepath.Dir(dest), ".dmctl-*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if _, err := io.Copy(tmp, resp.Body); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Chmod(tmp.Name(), 0o755); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), dest)
}

// crossBuildHelper 는 소스 트리에서 리눅스용 바이너리를 만든다 (개발 빌드 경로).
func crossBuildHelper(goarch, dest string) error {
	root, err := sourceRoot()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(dest), 0o755); err != nil {
		return err
	}
	cmd := exec.Command("go", "build", "-o", dest, "./cmd/dongminal")
	cmd.Dir = root
	cmd.Env = append(os.Environ(), "GOOS=linux", "GOARCH="+goarch, "CGO_ENABLED=0")
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("%w: %s", err, out)
	}
	return nil
}

// sourceRoot 는 이 패키지가 **컴파일된** 소스 트리의 모듈 루트다.
//
// runtime.Caller 를 쓰는 것은 개발 빌드에서만 이 경로가 필요하기 때문이다.
// 릴리스 판은 태그에서 내려받으므로 여기까지 오지 않으며, 소스에서 빌드한
// 사람은 정의상 그 소스를 갖고 있다. 트리를 옮겼다면 실패하고, 그때의 도피구는
// 캐시 경로에 직접 놓는 것이다 (FR-SBX-29).
func sourceRoot() (string, error) {
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		return "", fmt.Errorf("소스 위치를 알 수 없습니다")
	}
	dir := filepath.Dir(file)
	for {
		if _, err := os.Stat(filepath.Join(dir, "go.mod")); err == nil {
			return dir, nil
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return "", fmt.Errorf("소스 트리를 찾을 수 없습니다(%s 에서 위로 go.mod 없음)", filepath.Dir(file))
		}
		dir = parent
	}
}

func listCacheFiles(dir string) ([]string, error) {
	ents, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	out := make([]string, 0, len(ents))
	for _, e := range ents {
		if !e.IsDir() {
			out = append(out, filepath.Join(dir, e.Name()))
		}
	}
	return out, nil
}

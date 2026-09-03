package sandbox

import (
	"fmt"
	"path/filepath"
	"strings"
)

const (
	// HelperName 은 컨테이너 안에서의 헬퍼 이름이다.
	HelperName = "dmctl"
	// HelperMountPath 는 헬퍼를 읽기 전용으로 붙일 컨테이너 안 자리다.
	//
	// 이미 PATH 에 있는 자리를 고르는 것이 요점이다. 별도 디렉터리에 두면 PATH 를
	// 손봐야 하고, `-e PATH=` 로 덮으면 이미지가 세운 PATH 가 통째로 날아간다.
	HelperMountPath = "/usr/local/bin/" + HelperName
	// helperCacheDir 은 인스턴스 홈 아래 캐시 칸이다.
	helperCacheDir = "cache"
	// devVersion 은 새겨지지 않은 판이다 (cli.Version 의 기본값).
	devVersion = "dev"
	// releaseRepo 는 릴리스 자산을 받을 곳이다.
	releaseRepo = "Biisairo/dongminal"
)

// HelperDeps 는 헬퍼 확보에 필요한 바깥 세계다. 주입인 것은 네트워크도 툴체인도
// 없는 호스트에서 이 판단을 시험할 수 있어야 하기 때문이다.
type HelperDeps struct {
	// Version 은 이 서버의 판이다 (cli.Version). Arch 는 컨테이너의 아키텍처다.
	Version string
	Arch    string
	Home    string

	Stat       func(path string) error
	Fetch      func(url, dest string) error
	CrossBuild func(goarch, dest string) error
	ListCache  func(dir string) ([]string, error)
	Remove     func(path string) error
}

// HelperCachePath 는 이 판에 맞는 리눅스 헬퍼의 자리다 (FR-SBX-14).
//
// **경로에 버전이 들어가는 것이 요점이다.** 버전 없는 고정 경로를 쓰면 서버를
// 올린 뒤에도 옛 헬퍼를 계속 쓰게 되고, 그 불일치는 오류가 아니라 조용한
// 오동작으로 나타난다.
func HelperCachePath(home, version, arch string) string {
	return filepath.Join(home, helperCacheDir, HelperName+"-"+version+"-linux-"+arch)
}

// EnsureHelper 는 컨테이너에 넣을 리눅스 헬퍼를 확보하고 그 경로를 낸다.
//
// 이미 있으면 아무것도 하지 않는다 — 사용자가 그 자리에 직접 놓아둔 파일도 이
// 갈래로 쓰이며, 그것이 네트워크도 툴체인도 없는 환경의 도피구다 (FR-SBX-29).
func EnsureHelper(d HelperDeps) (string, error) {
	dest := HelperCachePath(d.Home, d.Version, d.Arch)
	if d.Stat(dest) == nil {
		return dest, nil
	}

	// 소스 빌드에는 대응하는 릴리스가 없다(version.go: 새기지 않으면 dev). 대신
	// 소스와 툴체인이 있으므로 크로스 빌드가 성립한다 (FR-SBX-15).
	if d.Version == devVersion {
		if err := d.CrossBuild(d.Arch, dest); err != nil {
			return "", fmt.Errorf("리눅스용 %s 를 만들지 못했습니다(개발 빌드): %w\n"+
				"  직접 놓아두려면: GOOS=linux GOARCH=%s go build -o %s ./cmd/dongminal",
				HelperName, err, d.Arch, dest)
		}
		return dest, nil
	}

	url := releaseAssetURL(d.Version, d.Arch)
	if err := d.Fetch(url, dest); err != nil {
		return "", fmt.Errorf("리눅스용 %s 를 받지 못했습니다(%s): %w", HelperName, url, err)
	}
	return dest, nil
}

// releaseAssetURL 은 **그 태그의** 자산을 가리킨다.
//
// `latest` 를 쓰지 않는 이유는 버전을 고정하는 이유와 같다 — 서버보다 새 헬퍼가
// 들어오면 HelperCachePath 가 막으려던 불일치가 그대로 재현된다.
func releaseAssetURL(version, arch string) string {
	return "https://github.com/" + releaseRepo + "/releases/download/" +
		version + "/dongminal-linux-" + arch
}

// PruneHelperCache 는 지금 판이 아닌 헬퍼 캐시를 치운다 (FR-SBX-29).
//
// 실패는 삼킨다. 정리는 곁다리이므로 그 실패가 서버 기동이나 창 생성을 막아서는
// 안 된다.
func PruneHelperCache(d HelperDeps) {
	if d.ListCache == nil || d.Remove == nil {
		return
	}
	cur := HelperCachePath(d.Home, d.Version, d.Arch)
	files, err := d.ListCache(filepath.Join(d.Home, helperCacheDir))
	if err != nil {
		return
	}
	for _, f := range files {
		if f == cur || !strings.HasPrefix(filepath.Base(f), HelperName+"-") {
			continue
		}
		d.Remove(f)
	}
}

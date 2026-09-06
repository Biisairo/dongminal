package ext

import (
	"os"
	"path/filepath"
	"strings"
)

// 캐시 칸의 하위 자리들. 도구마다 갈라 두는 이유는 정리(FR-EXT-23)가 한쪽만
// 지울 수 있어야 하기 때문이다 — 빌드 캐시는 버려도 되지만 받아 둔 모듈은 다르다.
const (
	cacheHome  = "home"
	cacheNPM   = "npm"
	cacheGoMod = "gomod"
	cacheGoBld = "gobuild"
	cacheXDG   = "xdg"
)

// IsolatedEnv 는 조달과 실행이 쓸 환경이다 (FR-EXT-21).
//
// **이 함수가 "컴퓨터에 영향을 주지 않는다" 의 실제 내용이다.** 종전 구현은
// 산출물의 자리만 격리하고(`GOBIN`·`--prefix`) 캐시를 사용자 홈에 그대로 쌓았으며,
// 그것을 격리라고 적어 두었다 — 실측으로 889 MB 였다 (§2.1). 그러므로 여기서
// 빠지는 변수 하나가 곧 남의 기계에 남는 흔적 하나다.
//
// 반환은 `KEY=VALUE` 들이며 `os.Environ()` **뒤에** 붙여 쓴다. 뒤가 이긴다.
func IsolatedEnv(root string, m Manifest) []string {
	return IsolatedEnvWithPath(root, m, nil, os.Getenv("PATH"))
}

// IsolatedEnvWithPath 는 PATH 앞에 세울 자리들을 함께 받는다.
//
// 런타임의 `bin` 이 그 자리다 — npm 이 자기 하위 프로세스로 `node` 를 부를 때
// 사용자의 node 가 아니라 **우리가 받아 둔 것**을 잡아야 판이 어긋나지 않는다.
func IsolatedEnvWithPath(root string, m Manifest, prepend []string, basePath string) []string {
	cache := CacheDir(root)
	home := filepath.Join(cache, cacheHome)
	xdg := filepath.Join(cache, cacheXDG)

	env := []string{
		// 홈이 먼저다. 이름을 모르는 도구가 홈 아래 자기 자리를 만드는 것을
		// 여기서 한 번에 막는다.
		//
		// **둘 다 심는다.** 홈을 정하는 변수가 OS 마다 다른데(POSIX 는 HOME,
		// Windows 는 USERPROFILE), 여기서 OS 로 갈리면 그것은 `platform` 이
		// 아닌 자리에서 OS 를 아는 일이 된다 (FR-XPL-5). 쓰이지 않는 쪽을 심는
		// 것은 해롭지 않다.
		"HOME=" + home,
		"USERPROFILE=" + home,

		// XDG 를 따르는 도구들이 홈 밖 자기 자리를 잡는 것도 막는다.
		"XDG_CACHE_HOME=" + filepath.Join(xdg, "cache"),
		"XDG_CONFIG_HOME=" + filepath.Join(xdg, "config"),
		"XDG_DATA_HOME=" + filepath.Join(xdg, "data"),

		// npm: 캐시·설치 자리·사용자 설정을 모두 우리 칸으로.
		"npm_config_cache=" + filepath.Join(cache, cacheNPM),
		"npm_config_prefix=" + PluginDir(root, m.ID),
		"npm_config_userconfig=" + filepath.Join(cache, cacheNPM, "npmrc"),
		"npm_config_global=false",

		// go: 모듈·빌드 캐시가 §2.1 의 889 MB 다.
		"GOMODCACHE=" + filepath.Join(cache, cacheGoMod),
		"GOCACHE=" + filepath.Join(cache, cacheGoBld),
		"GOBIN=" + ManagedBinDir(root, m),

		// 사용자의 전역 설정이 우리 조달을 막지 않게 한다. `-mod=vendor` 하나가
		// `go install` 을 세우면 그 실패는 우리가 설명할 수 없는 실패로 보인다.
		"GOFLAGS=",
		"NODE_OPTIONS=",
		// 대문자 쪽은 npm 이 따로 본다 — 소문자만 덮으면 사용자 것이 남는다.
		"NPM_CONFIG_PREFIX=",
	}

	path := strings.Join(append(append([]string{}, prepend...), basePath), string(filepath.ListSeparator))
	return append(env, "PATH="+path)
}

// toolchainBinSub 는 toolchain 조달물이 놓이는 팩 안 자리의 기본값이다.
const toolchainBinSub = "bin"

// ManagedBinDir 은 toolchain 조달물이 놓일 자리다.
//
// **탐색과 조달이 이 하나를 함께 쓴다** (FR-EXT-19) — `GOBIN` 이 가리키는 곳과
// `ManagedExe` 가 보는 곳이 갈리면 조달은 성공이라 하고 탐색은 없다고 한다.
// 선언이 자리를 바꿀 수 있으므로(Source.Bin) 그 값을 여기서 한 번만 푼다.
func ManagedBinDir(root string, m Manifest) string {
	sub := m.Source.Bin
	if sub == "" {
		sub = toolchainBinSub
	}
	return filepath.Join(PluginDir(root, m.ID), filepath.FromSlash(sub))
}

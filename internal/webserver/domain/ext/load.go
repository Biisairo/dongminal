package ext

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"sort"
)

// Load 는 격리 칸의 플러그인들을 읽는다 (FR-EXT-1·2).
//
// **목록이 여기서 온다.** 코드에는 없다 — 그것이 이 패키지의 첫 요구이며, 기본 셋이
// Go 로 돌아오면 그 순간 플러그인이라는 말이 뜻을 잃는다.
//
// 오류를 **모아서** 낸다. 하나가 전체를 멈추면 사용자가 손으로 고친 파일 한 줄에
// 편집기의 코드 탐색이 통째로 사라진다 (FR-EXT-8) — 깨진 팩만 죽고 나머지는 선다.
func Load(root string) ([]Manifest, []error) {
	dir := PluginsDir(root)
	entries, err := os.ReadDir(dir)
	if err != nil {
		// 플러그인이 하나도 없는 상태는 정상이다 (FR-EXT-16) — 그때 편집기는
		// 그냥 종전의 편집기다. 오류로 만들면 첫 기동이 실패로 보인다.
		if errors.Is(err, os.ErrNotExist) {
			return nil, nil
		}
		return nil, []error{fmt.Errorf("플러그인 디렉터리를 읽지 못했습니다: %w", err)}
	}

	var out []Manifest
	var errs []error
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		id := e.Name()
		blob, err := os.ReadFile(filepath.Join(dir, id, ManifestName))
		if err != nil {
			// 선언이 없는 디렉터리는 팩이 아니다. 조달이 남긴 곁다리일 수 있으므로
			// 조용히 지난다.
			if errors.Is(err, os.ErrNotExist) {
				continue
			}
			errs = append(errs, fmt.Errorf("%s: 선언을 읽지 못했습니다: %w", id, err))
			continue
		}
		m, err := ParseManifest(blob)
		if err != nil {
			errs = append(errs, fmt.Errorf("%s: %w", id, err))
			continue
		}
		// 자리를 정하는 것은 id 다 (PluginDir). 디렉터리 이름과 어긋나면 조달은
		// 이곳이 아닌 데 쓰고 탐색은 여기를 본다 — 받아 두고도 못 찾는다.
		if m.ID != id {
			errs = append(errs, fmt.Errorf("%s: 선언의 id 가 디렉터리와 다릅니다: %q", id, m.ID))
			continue
		}
		out = append(out, m)
	}
	// 순서를 고정한다 — 화면의 목록이 기동마다 뒤바뀌면 사용자가 같은 줄을 다시
	// 찾지 못한다.
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out, errs
}

// Runtimes 는 읽어 둔 것들 중 런타임 팩만이다 (FR-EXT-6).
func Runtimes(ms []Manifest) []Manifest {
	var out []Manifest
	for _, m := range ms {
		if m.Kind == KindRuntime {
			out = append(out, m)
		}
	}
	return out
}

// Packs 는 서버를 내는 팩들이다.
func Packs(ms []Manifest) []Manifest {
	var out []Manifest
	for _, m := range ms {
		if m.Kind == KindServer {
			out = append(out, m)
		}
	}
	return out
}

// ServerForExt 는 확장자를 (팩, 서버) 로 푼다.
//
// 서버가 세션의 단위이므로(FR-EXT-4 / FR-LSP-13) 푸는 것도 그 단위다. 어느 팩에도
// 없는 확장자는 풀리지 않으며, 그것이 "세션을 세우지 않는다" 의 자리다.
func ServerForExt(ms []Manifest, ext string) (Manifest, Server, bool) {
	e := normalizeExt(ext)
	if e == "" {
		return Manifest{}, Server{}, false
	}
	for _, m := range ms {
		if m.Kind != KindServer {
			continue
		}
		for _, s := range m.Servers {
			if slices.Contains(s.Exts, e) {
				return m, s, true
			}
		}
	}
	return Manifest{}, Server{}, false
}

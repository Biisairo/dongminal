package ext

import (
	"embed"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
)

// builtinFS 는 동봉된 **선언들**이다 (FR-EXT-34).
//
// **선언만 담는다** (FR-EXT-35 / I-2). 서버도 런타임도 배포물에 넣지 않는다 —
// 그것을 넣는 순간 우리는 집행기가 아니라 재배포자가 되고 보안 패치를 추적할 의무를
// 진다 (D-P2). 여기 있는 것은 수 KB 짜리 JSON 뿐이며, 그것은 우리가 쓴 글이다.
//
//go:embed builtin/*.json
var builtinFS embed.FS

// deployedName 은 **무엇을 이미 전개했는지**의 기록이다.
//
// 이 파일이 필요한 이유는 FR-EXT-36 의 뒷문장이다 — "지운 것을 되살리지 않는다".
// 디렉터리의 부재만 보면 "처음 켰다" 와 "사용자가 지웠다" 를 구별할 수 없고, 그러면
// 지운 팩이 재기동마다 되살아난다.
const deployedName = "deployed.json"

// Builtins 는 동봉된 선언들을 읽는다.
//
// 여기서 실패하면 그것은 **우리 잘못**이다 — 사용자의 파일이 아니라 우리가 넣은
// 것이므로, 검사가 이 함수를 부르는 것으로 회귀를 잡는다 (TC-EXT-60).
func Builtins() ([]Manifest, error) {
	entries, err := fs.ReadDir(builtinFS, "builtin")
	if err != nil {
		return nil, err
	}
	var out []Manifest
	for _, e := range entries {
		blob, err := builtinFS.ReadFile("builtin/" + e.Name())
		if err != nil {
			return nil, err
		}
		m, err := ParseManifest(blob)
		if err != nil {
			return nil, fmt.Errorf("동봉된 %s: %w", e.Name(), err)
		}
		out = append(out, m)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out, nil
}

// builtinBlob 은 그 팩의 원본 바이트다. 전개가 이것을 그대로 쓴다 — 다시 직렬화하면
// 우리가 손으로 적은 줄바꿈과 순서가 사라지고, 사용자가 읽을 파일이 기계의 것이 된다.
func builtinBlob(id string) ([]byte, error) {
	return builtinFS.ReadFile("builtin/" + id + ".json")
}

// Deploy 는 동봉 선언을 격리 칸으로 편다 (FR-EXT-34·35·36).
//
// 세 규칙이 있다:
//
//  1. **한 번만 편다.** 이미 편 팩은 다시 쓰지 않는다 — 사용자가 고친 것을 덮지
//     않기 위해서다.
//  2. **지운 것을 되살리지 않는다.** 지움은 의사표시다 (FR-EXT-9).
//  3. 전개의 실패는 **그 팩만** 죽인다. 하나가 전체 기동을 막지 않는다.
func Deploy(root string) []error {
	ms, err := Builtins()
	if err != nil {
		return []error{err}
	}
	done, err := readDeployed(root)
	if err != nil {
		return []error{err}
	}

	var errs []error
	changed := false
	for _, m := range ms {
		if _, ok := done[m.ID]; ok {
			continue // 이미 폈다 — 고쳤든 지웠든 사용자의 것이다
		}
		blob, err := builtinBlob(m.ID)
		if err != nil {
			errs = append(errs, fmt.Errorf("%s: %w", m.ID, err))
			continue
		}
		dir := PluginDir(root, m.ID)
		if err := os.MkdirAll(dir, 0o755); err != nil {
			errs = append(errs, fmt.Errorf("%s: 자리를 만들지 못했습니다: %w", m.ID, err))
			continue
		}
		if err := os.WriteFile(filepath.Join(dir, ManifestName), blob, 0o644); err != nil {
			errs = append(errs, fmt.Errorf("%s: 선언을 쓰지 못했습니다: %w", m.ID, err))
			continue
		}
		done[m.ID] = m.Version
		changed = true
	}
	if changed {
		if err := writeDeployed(root, done); err != nil {
			errs = append(errs, err)
		}
	}
	return errs
}

func readDeployed(root string) (map[string]string, error) {
	blob, err := os.ReadFile(filepath.Join(root, deployedName))
	if errors.Is(err, os.ErrNotExist) {
		return map[string]string{}, nil
	}
	if err != nil {
		return nil, fmt.Errorf("전개 기록을 읽지 못했습니다: %w", err)
	}
	out := map[string]string{}
	if err := json.Unmarshal(blob, &out); err != nil {
		// 기록이 깨졌다. 되살리기보다 **비어 있는 것으로 보는 쪽**이 위험하다 —
		// 사용자가 지운 팩이 되살아난다. 그래서 오류로 올린다.
		return nil, fmt.Errorf("전개 기록이 깨졌습니다 (%s): %w", deployedName, err)
	}
	return out, nil
}

func writeDeployed(root string, m map[string]string) error {
	if err := os.MkdirAll(root, 0o755); err != nil {
		return err
	}
	blob, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(root, deployedName), append(blob, '\n'), 0o644)
}

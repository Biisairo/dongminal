// Package runtime는 dongminal 이 런타임에 배포하는 헬퍼 스크립트(download/edit,
// zsh/bash 프롬프트 훅 등)를 임베드하고 대상 bin 디렉터리에 설치한다.
package runtime

import (
	"embed"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
)

//go:embed all:scripts
var scripts embed.FS

// Install은 scripts/ 이하의 모든 파일을 binDir 에 복사한다.
// 실행 비트는 파일 확장자 기준으로 부여한다 (.sh 또는 확장자 없음 → 0755, 그 외 → 0644).
// binDir 및 하위 디렉터리는 필요 시 생성된다.
func Install(binDir string) error {
	if err := os.MkdirAll(binDir, 0o755); err != nil {
		return fmt.Errorf("mkdir %s: %w", binDir, err)
	}
	return fs.WalkDir(scripts, "scripts", func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel("scripts", p)
		if rel == "." {
			return nil
		}
		dst := filepath.Join(binDir, rel)
		if d.IsDir() {
			return os.MkdirAll(dst, 0o755)
		}
		data, err := scripts.ReadFile(p)
		if err != nil {
			return err
		}
		mode := os.FileMode(0o644)
		ext := filepath.Ext(rel)
		if ext == "" || ext == ".sh" {
			mode = 0o755
		}
		if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
			return err
		}
		return os.WriteFile(dst, data, mode)
	})
}

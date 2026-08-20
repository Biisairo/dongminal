package migrate

import (
	"fmt"
	"os"
	"path/filepath"
)

const (
	workspaceFile = "workspace.json"
	panesFile     = "panes.json"
	toolsFile     = "tools.json"
	backupSuffix  = ".v1.bak"
)

// Apply는 home 의 workspace.json·panes.json 을 v2 로 변환한다 (NFR-EM-2).
//
// 쓰기 순서: 변환을 모두 끝낸 뒤에만 디스크를 건드린다. 따라서 입력이 깨져
// 있으면 어떤 파일도 변경되지 않는다.
//
//	workspace.json → workspace.json.v1.bak 로 복사 후 v2 로 덮어쓰기
//	panes.json     → panes.json.v1.bak 로 이동, tools.json 을 새로 생성
//
// panes.json 을 복사가 아니라 이동하는 이유는 stale 파일을 남기지 않기
// 위해서다. 백업이 이미 있으면 덮어쓰지 않는다 — 재실행이 원본을 파괴하는
// 것을 막는다. 재실행 시에는 panes.json 이 없으므로 도구 컬렉션을
// tools.json 에서 읽어 멱등성을 유지한다.
func Apply(home string, dryRun bool) (Report, error) {
	wsPath := filepath.Join(home, workspaceFile)
	pnPath := filepath.Join(home, panesFile)

	wsBlob, err := readOptional(wsPath)
	if err != nil {
		return Report{}, err
	}
	pnBlob, err := readOptional(pnPath)
	if err != nil {
		return Report{}, err
	}
	// 재실행 경로: 1차 실행이 panes.json 을 백업으로 이동했으므로 도구
	// 컬렉션은 tools.json 에서 읽는다. 그러지 않으면 리포트가 Tool 0개 +
	// 깨진 참조 전량으로 잘못 산출된다.
	fromTools := false
	if len(pnBlob) == 0 {
		pnBlob, err = readOptional(filepath.Join(home, toolsFile))
		if err != nil {
			return Report{}, err
		}
		fromTools = len(pnBlob) > 0
	}

	res, err := Run(wsBlob, pnBlob)
	if err != nil {
		return Report{}, err
	}
	if res.Report.Empty || dryRun {
		return res.Report, nil
	}

	if res.Workspace != nil {
		if err := backupOnce(wsPath); err != nil {
			return Report{}, err
		}
		if err := os.WriteFile(wsPath, res.Workspace, 0o644); err != nil {
			return Report{}, fmt.Errorf("%s 쓰기: %w", workspaceFile, err)
		}
	}
	if res.Tools != nil {
		if !fromTools {
			if err := backupOnce(pnPath); err != nil {
				return Report{}, err
			}
			if err := os.Remove(pnPath); err != nil && !os.IsNotExist(err) {
				return Report{}, fmt.Errorf("%s 제거: %w", panesFile, err)
			}
		}
		if err := os.WriteFile(filepath.Join(home, toolsFile), res.Tools, 0o644); err != nil {
			return Report{}, fmt.Errorf("%s 쓰기: %w", toolsFile, err)
		}
	}
	return res.Report, nil
}

func readOptional(path string) ([]byte, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, fmt.Errorf("%s 읽기: %w", filepath.Base(path), err)
	}
	return b, nil
}

// backupOnce는 path 를 백업한다. 백업이 이미 존재하면 아무것도 하지 않는다.
func backupOnce(path string) error {
	bak := path + backupSuffix
	if _, err := os.Stat(bak); err == nil {
		return nil
	}
	b, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return fmt.Errorf("%s 백업 읽기: %w", filepath.Base(path), err)
	}
	if err := os.WriteFile(bak, b, 0o644); err != nil {
		return fmt.Errorf("%s 백업 쓰기: %w", filepath.Base(bak), err)
	}
	return nil
}

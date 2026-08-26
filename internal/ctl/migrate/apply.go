package migrate

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
)

// ErrDaemonRunning은 dongminald 가 살아있을 때 반환된다. 데몬은 pane 생성·
// 삭제마다 SaveAll 로 도구 컬렉션을 다시 쓰므로, 마이그레이션 산출물이
// 즉시 덮어써지고 폐기한 고아가 되살아난다.
var ErrDaemonRunning = errors.New("dongminald 가 실행 중입니다 — `dongminal stop --all` 로 정지한 뒤 다시 실행하세요")

const (
	workspaceFile = "workspace.json"
	daemonPIDFile = "paned.pid"
	panesFile     = "panes.json"
	toolsFile     = "tools.json"
	settingsFile  = "settings.json"
	backupSuffix  = ".v1.bak"
	// preUUIDSuffix는 구 식별자 재작성 직전 상태의 백업이다 (FR-MGU-8).
	// `.v1.bak` 을 재사용할 수 없다 — backupOnce 는 백업이 이미 있으면
	// 무동작이라, 이미 v2 인 홈에서는 직전 상태가 어디에도 남지 않는다.
	preUUIDSuffix = ".preuuid.bak"
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
	if !dryRun {
		if pid, alive := daemonAlive(home); alive {
			return Report{}, fmt.Errorf("%w (pid=%d)", ErrDaemonRunning, pid)
		}
	}

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

	// 묶음 M: 구 식별자를 uuid 로 재작성한다 (SRS §3.5). Run 의 산출을 입력으로
	// 받으므로, v1 사용자는 스키마 변환과 id 정리가 1회 실행으로 함께 끝난다.
	wsRewritten, toolsRewritten, idRep, err := RewriteIdentifiers(res.Workspace, res.Tools, nil)
	if err != nil {
		return Report{}, err
	}
	res.Report.Identity = idRep
	if idRep.Total() > 0 {
		res.Workspace, res.Tools = wsRewritten, toolsRewritten
	}

	stPath := filepath.Join(home, settingsFile)
	stBlob, err := readOptional(stPath)
	if err != nil {
		return Report{}, err
	}
	stOut, renamed, err := Settings(stBlob)
	if err != nil {
		return Report{}, err
	}
	res.Report.ShortcutsRenamed = renamed

	if res.Report.Empty && stOut == nil {
		return res.Report, nil
	}
	if dryRun {
		return res.Report, nil
	}

	if res.Workspace != nil {
		if err := backupOnce(wsPath, backupSuffix); err != nil {
			return Report{}, err
		}
		if idRep.Total() > 0 {
			if err := backupOnce(wsPath, preUUIDSuffix); err != nil {
				return Report{}, err
			}
		}
		if err := os.WriteFile(wsPath, res.Workspace, 0o644); err != nil {
			return Report{}, fmt.Errorf("%s 쓰기: %w", workspaceFile, err)
		}
	}
	if res.Tools != nil {
		if !fromTools {
			if err := backupOnce(pnPath, backupSuffix); err != nil {
				return Report{}, err
			}
			if err := os.Remove(pnPath); err != nil && !os.IsNotExist(err) {
				return Report{}, fmt.Errorf("%s 제거: %w", panesFile, err)
			}
		}
		if idRep.Total() > 0 {
			if err := backupOnce(filepath.Join(home, toolsFile), preUUIDSuffix); err != nil {
				return Report{}, err
			}
		}
		if err := os.WriteFile(filepath.Join(home, toolsFile), res.Tools, 0o644); err != nil {
			return Report{}, fmt.Errorf("%s 쓰기: %w", toolsFile, err)
		}
	}
	if stOut != nil {
		if err := backupOnce(stPath, backupSuffix); err != nil {
			return Report{}, err
		}
		if err := os.WriteFile(stPath, stOut, 0o644); err != nil {
			return Report{}, fmt.Errorf("%s 쓰기: %w", settingsFile, err)
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

// backupOnce는 path 를 suffix 백업으로 남긴다. 백업이 이미 존재하면 아무것도
// 하지 않는다.
func backupOnce(path, suffix string) error {
	bak := path + suffix
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

// daemonAlive는 paned.pid 가 가리키는 프로세스가 살아있는지 본다. 파일이
// 없거나 stale pid 면 (0, false).
func daemonAlive(home string) (int, bool) {
	b, err := os.ReadFile(filepath.Join(home, daemonPIDFile))
	if err != nil {
		return 0, false
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(b)))
	if err != nil || pid <= 0 {
		return 0, false
	}
	p, err := os.FindProcess(pid)
	if err != nil {
		return 0, false
	}
	if err := p.Signal(syscall.Signal(0)); err != nil {
		return 0, false
	}
	return pid, true
}

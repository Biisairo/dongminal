package agentadapter

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"

	"dongminal/internal/shared/platform"
)

// ErrNoResume 은 재개 방법을 확인하지 못한 에이전트다 (RUN_RECOVERY_SRS FR-RRC-1).
var ErrNoResume = errors.New("no_resume")

// ErrBadSession 은 형식이 어긋난 세션 id 다 (FR-RRC-4).
var ErrBadSession = errors.New("bad_session")

// sessionIDMax 는 세션 id 길이의 상한이다 (FR-RRC-4).
const sessionIDMax = 128

// CanResume 은 이 에이전트의 재개 방법이 선언돼 있는가다.
func (a Adapter) CanResume() bool { return a.Resume != nil }

// ValidSessionID 는 재개줄에 실을 수 있는 세션 id 인가다 (FR-RRC-4).
//
// 세션 id 는 훅 보고에서 온 값이다. 인용은 셸이 하지만, 명령줄에 실리는 값은
// 그 앞에서 한 번 더 좁힌다 — 영문·숫자·`.`·`_`·`-` 만, 1~128자. 첫 글자는 영문·숫자다 —
// `-` 로 시작하면 에이전트가 그 값을 옵션으로 읽는다(`--resume --dangerously-…`).
func ValidSessionID(id string) bool {
	if id == "" || len(id) > sessionIDMax {
		return false
	}
	for i, r := range id {
		alnum := r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9'
		if !alnum && (i == 0 || (r != '.' && r != '_' && r != '-')) {
			return false
		}
	}
	return true
}

// ResumeLine 은 빈 셸에 타이핑할 재개 명령줄이다 (FR-RRC-3). member 가 참이면 멤버로
// 띄울 때의 인자(MemberArgs)를 붙인다 — 붙이지 않으면 재개된 멤버가 첫 dmctl 호출의
// 승인 대기에서 멈춘다. 모델과 프롬프트는 싣지 않는다. 재개한 세션이 이미 갖고 있다.
func (a Adapter) ResumeLine(hooksDir, sessionID string, member bool) (string, error) {
	return a.resumeLine(platform.Current().Shell, hooksDir, sessionID, member)
}

func (a Adapter) resumeLine(sh platform.ShellProvider, hooksDir, sessionID string, member bool) (string, error) {
	if a.Resume == nil {
		return "", fmt.Errorf("%w: %s", ErrNoResume, a.ID)
	}
	if !ValidSessionID(sessionID) {
		return "", ErrBadSession
	}
	parts := append([]string{}, a.Launch...)
	for _, arg := range a.Resume(sessionID) {
		parts = append(parts, sh.Quote(arg))
	}
	if member {
		extra, err := a.memberArgs(sh, hooksDir)
		if err != nil {
			return "", err
		}
		parts = append(parts, extra...)
	}
	return strings.Join(parts, " "), nil
}

// claudeSessionsDir 는 claude 설정 폴더 안의 세션 등록부 폴더다 (§2.4).
const claudeSessionsDir = "sessions"

// claudeSessionPIDs 는 claude 의 세션 등록부를 읽는다 (FR-RRC-5, D-RRC-11).
//
// 실행 중인 claude 는 `<설정 폴더>/sessions/<pid>.json` 을 남긴다. 비공개 형식이므로
// 필요한 두 필드만 읽고, 깨진 파일 하나는 건너뛴다. 폴더가 없으면 실행 중인 claude 가
// 없는 것이고, 폴더를 읽지 못하면 모르는 것이다.
func claudeSessionPIDs(sessionID string, configDirs []string) ([]int, bool) {
	var pids []int
	for _, dir := range configDirs {
		reg := filepath.Join(dir, claudeSessionsDir)
		entries, err := os.ReadDir(reg)
		if errors.Is(err, fs.ErrNotExist) {
			continue
		}
		if err != nil {
			return nil, false
		}
		for _, e := range entries {
			if e.IsDir() || filepath.Ext(e.Name()) != ".json" {
				continue
			}
			blob, err := os.ReadFile(filepath.Join(reg, e.Name()))
			if err != nil {
				continue
			}
			var v struct {
				PID       int    `json:"pid"`
				SessionID string `json:"sessionId"`
			}
			if json.Unmarshal(blob, &v) == nil && v.PID > 0 && v.SessionID == sessionID {
				pids = append(pids, v.PID)
			}
		}
	}
	return pids, true
}

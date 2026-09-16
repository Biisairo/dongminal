package serverconf

import (
	"encoding/json"
	"os"
	"path/filepath"

	"dongminal/internal/shared/platform"
)

// SetUpdateCheck 는 자동 판 확인 토글을 `server.json` 에 적는다
// (UPDATE_NOTICE_SRS FR-UPD-13).
//
// **다른 키를 보존한다.** 구조체로 읽고 다시 쓰면 이 패키지가 모르는 키가
// 조용히 사라진다 — 사용자가 손으로 적어 둔 것이 토글 한 번에 지워지는 셈이다.
// 그래서 표(raw map)로 읽고 한 칸만 바꾼 뒤 그대로 쓴다.
//
// 읽지 못한 파일은 **빈 표로 친다.** 깨진 파일 때문에 토글이 안 먹는 것보다,
// 고칠 수 없게 된 파일을 사용자가 쓴 적 없는 값으로 덮는 편이 낫다 — 이 파일은
// 경계가 아니라 편의이기 때문이다 (D-CFG-3).
func SetUpdateCheck(home string, on bool) error {
	if home == "" {
		return ErrNoHome
	}
	path := filepath.Join(home, FileName)
	m := map[string]json.RawMessage{}
	if data, err := os.ReadFile(path); err == nil {
		if uerr := json.Unmarshal(data, &m); uerr != nil {
			m = map[string]json.RawMessage{}
		}
	} else if !os.IsNotExist(err) {
		return err
	}
	b, err := json.Marshal(on)
	if err != nil {
		return err
	}
	m["updateCheck"] = b
	out, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		return err
	}
	out = append(out, '\n')
	if err := os.MkdirAll(home, 0o700); err != nil {
		return err
	}
	return platform.WriteFileAtomic(path, out, 0o600)
}

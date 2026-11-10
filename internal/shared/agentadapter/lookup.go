package agentadapter

import (
	"os"
	"os/exec"
	"path/filepath"

	"dongminal/internal/shared/dmenv"
)

// ByCommand 는 전경 프로그램 이름이 그 어댑터의 실행 파일인 어댑터다
// (PEER_NETWORK_SRS §1.4 "에이전트 도구"). 없으면 ok 가 거짓이다.
func ByCommand(name string) (Adapter, bool) {
	if name == "" {
		return Adapter{}, false
	}
	for _, ad := range registry {
		if ad.DetectCmd == name {
			return ad, true
		}
	}
	return Adapter{}, false
}

// Installed 는 이 어댑터의 실행 파일이 이 기계에 있는가다. DONGMINAL_AGENT_BIN_DIR
// 을 먼저, 그다음 PATH 를 본다 (M8_UNIFIED_SRS D-C-7 과 같은 순서).
func (a Adapter) Installed() bool {
	if dir := os.Getenv(dmenv.EnvAgentBinDir); dir != "" {
		if _, err := exec.LookPath(filepath.Join(dir, a.DetectCmd)); err == nil {
			return true
		}
	}
	_, err := exec.LookPath(a.DetectCmd)
	return err == nil
}

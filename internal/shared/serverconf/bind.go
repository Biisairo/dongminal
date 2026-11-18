package serverconf

import (
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"dongminal/internal/shared/platform"
)

// AddrDir·AddrFileName 은 서버가 지금 리슨하는 `host:port` 한 줄을 담는 주소 파일의
// 자리다 (HOT_REBIND_SRS FR-HRB-10). 폴더째 샌드박스에 마운트하므로 전용 폴더에 두고,
// 폴더는 지우지 않는다 (D-HRB-9).
const (
	AddrDir      = "run"
	AddrFileName = "server.addr"
)

// AddrPath 는 홈의 주소 파일 경로다.
func AddrPath(home string) string { return filepath.Join(home, AddrDir, AddrFileName) }

// SetBind 는 바인드를 `server.json` 에 쓴다 (FR-HRB-3 / D-HRB-2). 빈 값은 그 키를
// 건드리지 않는다. 다른 키는 보존한다.
func SetBind(home, host, port string) error {
	kv := map[string]any{}
	if host != "" {
		kv["host"] = host
	}
	if port != "" {
		kv["port"] = port
	}
	if len(kv) == 0 {
		return nil
	}
	return setKeys(home, kv)
}

// ReadAddr 는 홈의 주소 파일을 읽는다 (FR-HRB-7·12). 없거나 틀리면 ok=false 다.
func ReadAddr(home string) (host, port string, ok bool) {
	if home == "" {
		return "", "", false
	}
	return ReadAddrFile(AddrPath(home))
}

// ReadAddrFile 은 경로로 주소 파일을 읽는다. 컨테이너 안의 마운트 자리가 이것을 쓴다 (FR-HRB-13).
func ReadAddrFile(path string) (host, port string, ok bool) {
	data, err := os.ReadFile(path)
	if err != nil {
		return "", "", false
	}
	h, p, err := net.SplitHostPort(strings.TrimSpace(string(data)))
	if err != nil || h == "" {
		return "", "", false
	}
	if n, err := strconv.Atoi(p); err != nil || n < 1 || n > 65535 {
		return "", "", false
	}
	return h, p, true
}

// WriteAddr 는 주소 파일을 원자적으로 쓴다. 파일 0600, 폴더 0700 이다 (FR-HRB-10).
func WriteAddr(home, addr string) error {
	if home == "" {
		return ErrNoHome
	}
	path := AddrPath(home)
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	return platform.WriteFileAtomic(path, []byte(addr+"\n"), 0o600)
}

// RemoveAddr 는 주소 파일이 addr 일 때만 지운다. 폴더는 남긴다 (D-HRB-9).
func RemoveAddr(home, addr string) {
	if home == "" {
		return
	}
	data, err := os.ReadFile(AddrPath(home))
	if err != nil || strings.TrimSpace(string(data)) != addr {
		return
	}
	_ = os.Remove(AddrPath(home))
}

package serverconf

import (
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// AddrFileName 은 서버가 지금 리슨하는 `host:port` 한 줄을 담는 주소 파일이다
// (HOT_REBIND_SRS FR-HRB-10). `<home>` 아래다.
const AddrFileName = "server.addr"

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

// ReadAddr 는 주소 파일을 읽는다 (FR-HRB-7·12). 없거나 틀리면 ok=false 다.
func ReadAddr(home string) (host, port string, ok bool) {
	if home == "" {
		return "", "", false
	}
	data, err := os.ReadFile(filepath.Join(home, AddrFileName))
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

//go:build windows

package swap

import "os"

// fileOwner 는 Windows 에서 묻지 않는다 — 교체 자체를 지원하지 않는다 (D-DSK-7).
func fileOwner(os.FileInfo) (int, bool) { return 0, false }

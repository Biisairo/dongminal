//go:build linux

package fswatch

const (
	fsCaseSensitive = true
	fsNFC           = false
)

func onNetworkVolume(string) bool { return false }

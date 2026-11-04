//go:build !darwin && !linux

package fswatch

const (
	fsCaseSensitive = false
	fsNFC           = false
)

func onNetworkVolume(string) bool { return false }

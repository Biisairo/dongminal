package browser

import (
	"errors"

	"dongminal/internal/shared/platform"
)

type fakeEngine struct{ path string }

func (f fakeEngine) Find() (string, error) {
	if f.path == "" {
		return "", platform.ErrChromeNotFound
	}
	return f.path, nil
}
func (fakeEngine) InstallHint() string {
	return "Google Chrome 을 설치하세요: https://www.google.com/chrome/"
}
func (fakeEngine) StartPiped(platform.PipedSpec) (*platform.PipedProcess, error) {
	return nil, errors.New("fake")
}
func (fakeEngine) ModIsMeta() bool { return false }

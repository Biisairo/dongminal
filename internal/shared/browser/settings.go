package browser

import (
	"encoding/json"
	"os"
	"path/filepath"

	"dongminal/internal/shared/dmenv"
)

// 설정 키 (NFR-BRT-Q2). 설정 blob 은 평면 키를 쓴다 (`settings-schema.js`).
const (
	SettingOpenPlacement  = "browserOpenPlacement"
	SettingLinkTarget     = "browserLinkTarget"
	SettingDefaultProfile = "browserDefaultProfile"
	SettingAudio          = "browserAudio"
	SettingDownloadDir    = "browserDownloadDir"
)

// DownloadDirSetting 은 다운로드 폴더다 (FR-BRT-80). 비면 매니저가 ~/Downloads 를 쓴다.
// 절대 경로만 받는다 — 상대 경로는 어디 기준인지 말할 수 없다.
func DownloadDirSetting(home string) string {
	if s, ok := readSetting(home, SettingDownloadDir).(string); ok && filepath.IsAbs(s) {
		return s
	}
	return ""
}

// 소리의 셋 (FR-BRT-90·91).
const (
	AudioOff    = "off"
	AudioServer = "server"
	AudioViewer = "viewer"
)

// AudioSetting 은 `settings.json` 의 소리 설정이다. 값은 프로필 브라우저를 **다음에 띄울 때**
// 읽는다 — CDP 에 탭 단위 음소거가 없다. 없거나 모르는 값은 끔이다(기본).
func AudioSetting(home string) string {
	switch v, _ := readSetting(home, SettingAudio).(string); v {
	case AudioServer, AudioViewer:
		return v
	}
	return AudioOff
}

// DefaultProfileSetting 은 새 탭의 프로필이다 (FR-BRT-14). 없으면 default.
func DefaultProfileSetting(home string) string {
	if s, ok := readSetting(home, SettingDefaultProfile).(string); ok && profileNameRe.MatchString(s) {
		return s
	}
	return DefaultProfile
}

// OpenPlacementSetting 은 터미널에서 연 탭의 위치다 (FR-BRT-32) — split | tab.
func OpenPlacementSetting(home string) string {
	if s, _ := readSetting(home, SettingOpenPlacement).(string); s == "tab" {
		return s
	}
	return "split"
}

func readSetting(home, key string) any {
	b, err := os.ReadFile(filepath.Join(home, dmenv.SettingsFile))
	if err != nil {
		return nil
	}
	var m map[string]any
	if json.Unmarshal(b, &m) != nil {
		return nil
	}
	return m[key]
}

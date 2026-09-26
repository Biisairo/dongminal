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
	SettingServerAudio    = "browserServerAudio"
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

// ServerAudioSetting 은 `settings.json` 의 서버 재생 여부다 (FR-BRT-90). 값은
// 프로필 브라우저를 **다음에 띄울 때** 읽는다 — CDP 에 탭 단위 음소거가 없다.
// 읽지 못하면 끔이다(기본).
func ServerAudioSetting(home string) bool {
	return readSetting(home, SettingServerAudio) == true
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

package cli

import (
	"encoding/json"
	"os"
	"path/filepath"
)

// 노출 게이트 (REQUEST_GATE_SRS FR-RQG-20).
//
// `--expose`/`DONGMINAL_HOST` 는 부수 기능이 아니라 이 제품이 존재하는 이유이고
// 기본 사용 형태다. 그런데 인증이 아직 없으므로, 허용 목록마저 꺼진 채 노출하면
// **같은 Wi-Fi 의 누구나 셸을 얻는다.**
//
// 그 상태를 기본으로 두지 않는다. 되돌리는 길은 `--insecure-no-acl` 하나이며
// 그 이름이 곧 경고다 — 잊고 켜 둔 사람이 자기 명령줄에서 그것을 본다.
//
// **여기서 `access.json` 을 직접 읽는다.** 서버의 `accessStore` 는 서버가 뜬 뒤에야
// 있고, 이 판정은 뜨기 **전**에 나야 한다. 읽는 것이 두 곳이 되지만 읽는 **형태**는
// 한 곳이다 — 아래 구조체가 서버의 `accessConfig` 와 같은 JSON 태그를 쓴다.

// exposeACLConfig 는 판정에 필요한 만큼만 읽는다. 항목의 값·이름표는 서버가
// 다루며 여기서는 "켜져 있고 쓸 항목이 있는가" 만 묻는다.
type exposeACLConfig struct {
	Enabled bool `json:"enabled"`
	Entries []struct {
		Value   string `json:"value"`
		Enabled bool   `json:"enabled"`
	} `json:"entries"`
}

// exposeACLBlocked 는 기동을 막을 사유다. 빈 문자열이면 통과.
//
// 사유를 문자열로 돌려주는 이유는 **사용자가 무엇을 고쳐야 하는지**가 셋으로
// 갈리기 때문이다: 파일이 없다 / 꺼져 있다 / 켜져 있는데 항목이 없다.
// 셋을 "허용 목록이 꺼져 있습니다" 하나로 뭉치면, 항목만 빠진 사람이 토글을
// 다시 켜 보다 시간을 쓴다.
func exposeACLBlocked(home string) string {
	if home == "" {
		return "허용 목록을 확인할 수 없습니다 (DONGMINAL_HOME 이 없습니다)."
	}
	data, err := os.ReadFile(filepath.Join(home, "access.json"))
	if err != nil {
		if os.IsNotExist(err) {
			return "허용 목록이 아직 없습니다."
		}
		// 읽지 못하면 **막는다.** 노출 상태에서 읽기 실패로 통과시키면 그 실패가
		// 곧 우회 경로가 된다 (FR-RQG-21 과 같은 논리).
		return "허용 목록을 읽지 못했습니다: " + err.Error()
	}
	var cfg exposeACLConfig
	if err := json.Unmarshal(data, &cfg); err != nil {
		return "허용 목록이 깨졌습니다: " + err.Error()
	}
	if !cfg.Enabled {
		return "허용 목록이 꺼져 있습니다."
	}
	for _, e := range cfg.Entries {
		if e.Enabled && e.Value != "" {
			return ""
		}
	}
	return "허용 목록이 켜져 있으나 쓸 항목이 없습니다."
}

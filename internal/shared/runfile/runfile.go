// Package runfile 은 runs.json 을 **읽기만** 한다 — Run 의 어휘·상태 전이·펜싱은
// `webserver/domain/run` 의 것이고 여기에는 없다.
//
// 따로 있는 이유는 실행 주체다. "지난 세대가 끝날 때 열려 있던 Run 의 headless
// 도구" 는 서버(③)의 부팅 배선과 데몬(②)의 `SetOwnedTools` 가 함께 묻는데,
// 데몬에는 Store 가 없고 `domain/run` 은 ③ 의 패키지다. 둘이 실행하는 것은
// `shared/` 에 있어야 한다 (M8 `GO-4`). 스키마의 주인은 여전히 `domain/run` 이며
// 그쪽 테스트가 Store 로 쓴 파일을 이 리더가 같게 읽는지 지킨다.
package runfile

import (
	"encoding/json"
	"os"
	"path/filepath"
)

// FileName 은 Run 레코드 파일의 이름이다. `domain/run` 의 Store 와 같은 값이어야
// 하며, 그 일치는 `domain/run` 의 테스트가 지킨다.
const FileName = "runs.json"

// StateOpen 은 "열린 Run" 의 와이어 값이다 (`run.Open`).
const StateOpen = "open"

// 이 프로젝션은 헤드리스 판정에 필요한 필드만 든다. 나머지 필드는 무시된다 —
// 스키마가 자라도 이 리더는 깨지지 않는다.
type fileBody struct {
	Runs []record `json:"runs"`
}

type record struct {
	State   string   `json:"state"`
	Members []member `json:"members"`
}

type member struct {
	ToolID   string `json:"toolId"`
	TabID    string `json:"tabId,omitempty"`
	Headless bool   `json:"headless,omitempty"`
}

// headlessTool 은 `run.Member.HeadlessTool` 과 같은 판정이다 — 헤드리스로
// 태어났고, 탭에 붙지 않았고, 도구가 있다.
func (m member) headlessTool() bool {
	return m.Headless && m.TabID == "" && m.ToolID != ""
}

// HeadlessToolIDs 는 runs.json 을 직접 읽어 **디스크에서 열린** Run 에 속한
// headless 멤버의 도구 id 를 돌려준다 (FR-HLM-3).
//
// Store 를 거치지 않는 이유 — 부팅 시 이 값이 필요한 시점은 Store 가 펜싱하기
// 전이다. Load 는 이전 세대가 열어 둔 Run 을 aborted 로 확정하므로(FR-RUN-5), 그
// 뒤에 물으면 "열린 Run" 이 하나도 없다. 되살릴지는 **지난 세대가 끝날 때의
// 사실**로 정해야 한다.
//
// 열린 Run 으로 한정하는 이유: 끝난 Run 의 도구는 FR-HLM-5 의 **고아**이고,
// 고아를 부팅마다 되살리면 영원히 쌓인다. 정리는 close 의 몫이다.
//
// 실패는 빈 집합이다. 되살리지 못하는 것보다 닿을 수 없는 셸을 늘리는 쪽이
// 나쁘다 — workspace 참조 해석이 같은 판단을 한다 (FR-EM-14).
func HeadlessToolIDs(dir string) map[string]struct{} {
	out := map[string]struct{}{}
	blob, err := os.ReadFile(filepath.Join(dir, FileName))
	if err != nil {
		return out
	}
	var body fileBody
	if err := json.Unmarshal(blob, &body); err != nil {
		return out
	}
	for _, rec := range body.Runs {
		if rec.State != StateOpen {
			continue
		}
		for _, m := range rec.Members {
			if m.headlessTool() {
				out[m.ToolID] = struct{}{}
			}
		}
	}
	return out
}

package httpapi

import (
	"encoding/json"
	"fmt"
	"net/http"
	"unicode/utf16"

	"dongminal/internal/webserver/action"
	"dongminal/internal/webserver/apierr"
)

// 창·탭·그룹 이름의 길이 상한 (SERVER_DRIVEN_ACTIONS_SRS F-4 · FR-SDA-54).
//
// 상한의 주인은 서버다. 화면은 `GET /api/meta` 로 받아 자르고(`clampEntityName`), 화면을
// 거치지 않는 dmctl 은 `/api/commands` 에서 거절된다. workspace 저장(`PUT /api/workspace`)은
// 막지 않는다 — 옛 데이터의 긴 이름 하나가 저장 전체를 막으면 안 된다(사용자 결정 2026-11-07).
//
// 단위는 UTF-16 코드 단위다 — 화면의 `String.slice` 와 같은 단위여야 서버가 받는 길이와
// 화면이 자른 길이가 같다.
const entityNameMax = 64

// entityNameCommands 는 이름(`args.name`)을 싣는 명령이다.
var entityNameCommands = map[string]bool{
	"newWindow": true, "newTab": true, "openEditorTab": true,
	"renameTab": true, "renameWindow": true, "newGroup": true, "renameGroup": true,
}

// entityNameAnswer 는 이름 하나의 길이 판정이다.
func entityNameAnswer(name string) action.Answer {
	if len(utf16.Encode([]rune(name))) > entityNameMax {
		return action.Deny(http.StatusBadRequest, apierr.CodeNameTooLong, map[string]any{"max": entityNameMax})
	}
	return action.Allow()
}

// commandNameAnswer 는 명령이 싣는 이름을 판정한다. 이름을 싣지 않는 명령은 지나간다.
func commandNameAnswer(act string, args json.RawMessage) action.Answer {
	if !entityNameCommands[act] || len(args) == 0 {
		return action.Allow()
	}
	var a struct {
		Name string `json:"name"`
	}
	if json.Unmarshal(args, &a) != nil {
		return action.Allow()
	}
	return entityNameAnswer(a.Name)
}

// rejectCommandAnswer 는 `/api/commands` 의 평문 방언으로 거절한다 — 코드는 헤더에, 본문은
// 영어 코드 서술이다. dmctl 은 본문을 그대로 오류로 보인다 (FR-SDA-9).
func rejectCommandAnswer(w http.ResponseWriter, a action.Answer) {
	httpErr(w, fmt.Sprintf("%s: max %v", a.Why, a.Args["max"]), a.Status, a.Why)
}

// GET /api/meta — 화면이 부팅 때 한 번 받는 서버 상수 (FR-SDA-80). 묶음 K 가 넓힌다.
func (s *Server) apiMeta(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, map[string]any{"entityNameMax": entityNameMax})
}

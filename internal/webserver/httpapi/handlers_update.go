package httpapi

import (
	"encoding/json"
	"net/http"

	"dongminal/internal/webserver/apierr"
	"dongminal/internal/webserver/httpreq"
)

// `/api/update` — 배지가 읽는 자리와 토글이 쓰는 자리 (UPDATE_NOTICE_SRS 묶음 안내).
//
// **여기서 밖으로 나가지 않는다** (FR-UPD-8). 캐시를 채우는 것은 트리거 넷이고
// 이 핸들러는 그중 어느 것도 아니다 — 배지를 읽는 것과 캐시를 채우는 것은 다른
// 일이다. 둘을 한 자리에 묶으면 브라우저 폴링이 곧 GitHub 호출로 번역된다.

// apiUpdateGet 은 마지막 확인 결과다 (FR-UPD-7).
func (s *Server) apiUpdateGet(w http.ResponseWriter, r *http.Request) {
	if s.Updates == nil {
		httpErr(w, "update check unavailable", http.StatusServiceUnavailable, apierr.CodeUpdateUnready)
		return
	}
	writeJSON(w, s.Updates.Snapshot())
}

// apiUpdatePut 은 토글이다 (FR-UPD-13·14).
//
// **설정 블롭에 쓰지 않는다** (D-UPD-2). 서버가 읽어야 하는 값이고, 블롭에 두면
// 서버가 블롭을 파싱해야 해서 D-CFG-1 이 그 자리에서 깨진다.
func (s *Server) apiUpdatePut(w http.ResponseWriter, r *http.Request) {
	if s.Updates == nil {
		httpErr(w, "update check unavailable", http.StatusServiceUnavailable, apierr.CodeUpdateUnready)
		return
	}
	body, err := httpreq.Read(w, r, 0)
	if err != nil {
		failRead(w, err)
		return
	}
	var in struct {
		Enabled *bool `json:"enabled"`
	}
	if err := json.Unmarshal(body, &in); err != nil || in.Enabled == nil {
		fail(w, http.StatusBadRequest, "enabled 가 true/false 여야 합니다", nil)
		return
	}
	if err := s.Updates.SetEnabled(*in.Enabled); err != nil {
		fail(w, http.StatusInternalServerError, "설정을 저장하지 못했습니다: "+err.Error(), nil)
		return
	}
	writeJSON(w, s.Updates.Snapshot())
}

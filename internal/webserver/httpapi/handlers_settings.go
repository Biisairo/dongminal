package httpapi

import (
	"encoding/json"
	"log"
	"net/http"

	"dongminal/internal/webserver/httpreq"
	"os"
	"sync"

	"dongminal/internal/shared/platform"
)

// settingsStore 와 그 종단. 브라우저 설정은 서버가 해석하지 않는 JSON blob 이라
// 다른 핸들러와 공유하는 상태가 없다 — 저장소와 종단을 한 파일에 둔다.

// settingsStore is a simple JSON blob persisted to <dataDir>/settings.json.
type settingsStore struct {
	mu   sync.Mutex
	raw  []byte
	path string
}

func newSettingsStore(path string) *settingsStore {
	s := &settingsStore{path: path}
	data, err := os.ReadFile(path)
	if err == nil {
		s.raw = data
		log.Printf("settings loaded %d bytes", len(data))
	} else if !os.IsNotExist(err) {
		log.Printf("loadSettings: %v", err)
	}
	return s
}

func (s *settingsStore) get() []byte {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.raw
}

func (s *settingsStore) set(b []byte) {
	s.mu.Lock()
	s.raw = b
	s.mu.Unlock()
}

func (s *settingsStore) save() {
	s.mu.Lock()
	data := s.raw
	s.mu.Unlock()
	if len(data) == 0 {
		return
	}
	// 원자적으로 쓴다 (FR-CAF-11). 설정은 사용자가 손으로 만든 것이고
	// (테마·단축키·레이아웃 취향), 잘리면 되돌릴 방법이 없다.
	if err := platform.WriteStateFile(s.path, data, 0644); err != nil {
		log.Printf("saveSettings: %v", err)
	}
}

func (s *Server) apiSettingsGet(w http.ResponseWriter, r *http.Request) {
	var data []byte
	if s.Settings != nil {
		data = s.Settings.get()
	}
	w.Header().Set("Content-Type", "application/json")
	if len(data) > 0 {
		w.Write(data)
	} else {
		w.Write([]byte("{}"))
	}
}

// settingsChangedPayload 는 "설정이 바뀌었으니 다시 받으라" 는 신호다
// (SETTINGS_LIVE, 2026-09-08 접수).
//
// **본문을 싣지 않는다.** 이 blob 은 서버가 해석하지 않는 것이고(파일 머리의
// 규약), 방송에 실으면 그 순간부터 서버가 그 모양을 아는 셈이 된다. 받는 쪽은
// `GET /api/settings` 로 자기가 읽는다 — `tools_background_changed` 와 같은
// 규약이며, 그래서 클라이언트의 병합 정책도 같은 `latest` 다.
func settingsChangedPayload() []byte {
	b, _ := json.Marshal(map[string]any{
		"action": "settings_changed",
		"args":   map[string]any{},
	})
	return b
}

func (s *Server) apiSettingsPut(w http.ResponseWriter, r *http.Request) {
	body, err := httpreq.Read(w, r, 0)
	if err != nil {
		http.Error(w, "read body", httpreq.Status(err))
		return
	}
	// FR-RQG-16: **JSON 인지 보고 쓴다.** 종전에는 받은 바이트를 검증 없이 그대로
	// `settings.json` 에 썼다 — 그 파일이 깨지면 다음 기동이 설정을 잃는다.
	if !json.Valid(body) {
		http.Error(w, "settings must be JSON", http.StatusBadRequest)
		return
	}
	if s.Settings != nil {
		s.Settings.set(body)
		s.Settings.save()
	}
	// 저장이 끝난 **뒤에** 알린다 — 받은 창이 곧바로 GET 하므로, 먼저 알리면
	// 그 GET 이 옛 값을 읽을 수 있다.
	if s.Commands != nil {
		s.Commands.Broadcast(settingsChangedPayload())
	}
	w.WriteHeader(200)
}

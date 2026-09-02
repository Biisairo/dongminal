package httpapi

import (
	"io"
	"log"
	"net/http"
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
	if err := platform.WriteFileAtomic(s.path, data, 0644); err != nil {
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

func (s *Server) apiSettingsPut(w http.ResponseWriter, r *http.Request) {
	body, _ := io.ReadAll(r.Body)
	if s.Settings != nil {
		s.Settings.set(body)
		s.Settings.save()
	}
	w.WriteHeader(200)
}

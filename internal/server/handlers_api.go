package server

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"math"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"dongminal/internal/workspace"
)

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
	if err := os.WriteFile(s.path, data, 0644); err != nil {
		log.Printf("saveSettings: %v", err)
	}
}

func fmtDuration(d time.Duration) string {
	if d.Hours() >= 24 {
		return fmt.Sprintf("%dd %dh", int(d.Hours()/24), int(d.Hours())%24)
	} else if d.Hours() >= 1 {
		return fmt.Sprintf("%dh %dm", int(d.Hours()), int(d.Minutes())%60)
	}
	return fmt.Sprintf("%dm", int(d.Minutes()))
}

func (s *Server) getStats() map[string]interface{} {
	hostname, _ := os.Hostname()

	cpu := 0.0
	if out, err := exec.Command("bash", "-c", `top -l 1 -n 0 | grep "CPU usage"`).Output(); err == nil {
		parts := strings.Fields(string(out))
		if len(parts) >= 5 {
			u, _ := strconv.ParseFloat(strings.TrimSuffix(parts[2], "%"), 64)
			sv, _ := strconv.ParseFloat(strings.TrimSuffix(parts[4], "%"), 64)
			cpu = math.Round((u+sv)*10) / 10
		}
	}

	memTotal, memUsed := uint64(0), uint64(0)
	if out, err := exec.Command("sysctl", "-n", "hw.memsize").Output(); err == nil {
		if v, err := strconv.ParseUint(strings.TrimSpace(string(out)), 10, 64); err == nil {
			memTotal = v
		}
	}
	if memTotal > 0 {
		if out, err := exec.Command("vm_stat").Output(); err == nil {
			var freePages uint64
			for _, line := range strings.Split(string(out), "\n") {
				line = strings.TrimRight(line, ".")
				if strings.Contains(line, "Pages free") {
					fmt.Sscanf(line, "Pages free: %d", &freePages)
				} else if strings.Contains(line, "Pages inactive") {
					var v uint64
					fmt.Sscanf(line, "Pages inactive: %d", &v)
					freePages += v
				}
			}
			memUsed = memTotal - freePages*4096
		}
	}

	diskPct := 0.0
	var stat syscall.Statfs_t
	if syscall.Statfs("/", &stat) == nil {
		used := stat.Blocks - stat.Bavail
		diskPct = math.Round(float64(used)/float64(stat.Blocks)*1000) / 10
	}

	sysUptime := ""
	if out, err := exec.Command("sysctl", "-n", "kern.boottime").Output(); err == nil {
		if parts := strings.Split(string(out), "="); len(parts) >= 2 {
			secStr := strings.TrimSpace(strings.Split(parts[1], ",")[0])
			if sec, err := strconv.ParseInt(secStr, 10, 64); err == nil {
				sysUptime = fmtDuration(time.Since(time.Unix(sec, 0)))
			}
		}
	}
	srvUptime := fmtDuration(time.Since(s.started))

	return map[string]interface{}{
		"hostname":  hostname,
		"cpu":       cpu,
		"memUsed":   memUsed,
		"memTotal":  memTotal,
		"diskPct":   diskPct,
		"sysUptime": sysUptime,
		"srvUptime": srvUptime,
	}
}

func uniquePath(dir, name string) string {
	p := filepath.Join(dir, name)
	if _, err := os.Stat(p); err != nil {
		return p
	}
	ext := filepath.Ext(name)
	base := strings.TrimSuffix(name, ext)
	for i := 1; ; i++ {
		p = filepath.Join(dir, fmt.Sprintf("%s (%d)%s", base, i, ext))
		if _, err := os.Stat(p); err != nil {
			return p
		}
	}
}

func (s *Server) handleAPI(w http.ResponseWriter, r *http.Request) {
	p := r.URL.Path
	switch {
	case p == "/api/state" && r.Method == http.MethodGet:
		if s.Panes == nil {
			http.Error(w, "panes unavailable", 500)
			return
		}
		var rawWS []byte
		var rev uint64
		if s.Work != nil {
			rawWS = s.Work.Raw()
			rev = s.Work.CurrentRev()
		}
		var ws interface{}
		if len(rawWS) > 0 {
			json.Unmarshal(rawWS, &ws)
		}
		w.Header().Set("ETag", strconv.FormatUint(rev, 10))
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{
			"panes":     s.Panes.List(),
			"workspace": ws,
		})

	case p == "/api/panes" && r.Method == http.MethodPost:
		if s.Panes == nil {
			http.Error(w, "panes unavailable", 500)
			return
		}
		cols, rows := ParseSize(r)
		cwd := r.URL.Query().Get("cwd")
		if cwd == "" {
			if refID := r.URL.Query().Get("cwdPane"); refID != "" {
				if ref := s.Panes.Get(refID); ref != nil {
					cwd = ref.Cwd()
				}
			}
		}
		pane, err := s.Panes.Create(cwd, cols, rows)
		if err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]string{"id": pane.ID, "name": pane.Name})

	case strings.HasPrefix(p, "/api/panes/") && strings.HasSuffix(p, "/busy") && r.Method == http.MethodGet:
		id := strings.TrimSuffix(strings.TrimPrefix(p, "/api/panes/"), "/busy")
		var busy bool
		if s.Panes != nil {
			if pane := s.Panes.Get(id); pane != nil {
				busy = pane.IsBusy()
			}
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]bool{"busy": busy})

	case strings.HasPrefix(p, "/api/panes/") && r.Method == http.MethodDelete:
		id := strings.TrimPrefix(p, "/api/panes/")
		if s.Panes != nil {
			s.Panes.Delete(id)
		}
		w.WriteHeader(200)

	case p == "/api/workspace" && r.Method == http.MethodGet:
		var raw []byte
		var rev uint64
		if s.Work != nil {
			raw = s.Work.Raw()
			rev = s.Work.CurrentRev()
		}
		w.Header().Set("ETag", strconv.FormatUint(rev, 10))
		w.Header().Set("Content-Type", "application/json")
		if len(raw) > 0 {
			w.Write(raw)
		} else {
			w.Write([]byte("null"))
		}

	case p == "/api/workspace" && r.Method == http.MethodPut:
		if s.Work == nil {
			http.Error(w, "workspace unavailable", 500)
			return
		}
		body, _ := io.ReadAll(r.Body)
		ifMatch := r.Header.Get("If-Match")
		rev, err := s.Work.Save(body, ifMatch)
		if err != nil {
			if errors.Is(err, workspace.ErrStale) {
				w.Header().Set("ETag", strconv.FormatUint(s.Work.CurrentRev(), 10))
				http.Error(w, "stale revision", http.StatusConflict)
				return
			}
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		w.Header().Set("ETag", strconv.FormatUint(rev, 10))
		w.WriteHeader(200)
		if s.Commands != nil {
			payload, _ := json.Marshal(map[string]any{
				"action": "workspace_changed",
				"args":   map[string]any{"rev": rev},
			})
			s.Commands.Broadcast(payload)
		}

	case p == "/api/settings" && r.Method == http.MethodGet:
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

	case p == "/api/settings" && r.Method == http.MethodPut:
		body, _ := io.ReadAll(r.Body)
		if s.Settings != nil {
			s.Settings.set(body)
			s.Settings.save()
		}
		w.WriteHeader(200)

	case p == "/api/upload" && r.Method == http.MethodPost:
		file, header, err := r.FormFile("file")
		if err != nil {
			http.Error(w, err.Error(), 400)
			return
		}
		defer file.Close()
		dir := r.URL.Query().Get("dir")
		if dir == "" {
			dir = "."
		}
		outPath := uniquePath(dir, header.Filename)
		out, err := os.Create(outPath)
		if err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		defer out.Close()
		written, err := io.Copy(out, file)
		if err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{"name": filepath.Base(outPath), "size": written, "path": outPath})

	case p == "/api/download" && r.Method == http.MethodGet:
		fp := r.URL.Query().Get("path")
		if fp == "" {
			http.Error(w, "missing path", 400)
			return
		}
		if !filepath.IsAbs(fp) {
			abs, err := filepath.Abs(fp)
			if err != nil {
				http.Error(w, err.Error(), 400)
				return
			}
			fp = abs
		}
		f, err := os.Open(fp)
		if err != nil {
			http.Error(w, err.Error(), 404)
			return
		}
		defer f.Close()
		stat, _ := f.Stat()
		w.Header().Set("Content-Disposition", "attachment; filename="+filepath.Base(fp))
		w.Header().Set("Content-Type", "application/octet-stream")
		if stat != nil {
			w.Header().Set("Content-Length", fmt.Sprintf("%d", stat.Size()))
		}
		io.Copy(w, f)

	case p == "/api/cwd" && r.Method == http.MethodGet:
		paneID := r.URL.Query().Get("pane")
		var cwd string
		if paneID != "" && s.Panes != nil {
			if pane := s.Panes.Get(paneID); pane != nil {
				cwd = pane.Cwd()
			}
		}
		if cwd == "" {
			cwd, _ = os.Getwd()
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]string{"cwd": cwd})

	case p == "/api/code-server" && r.Method == http.MethodGet:
		var list []map[string]interface{}
		if s.CS != nil {
			list = s.CS.List()
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(list)

	case p == "/api/code-server" && r.Method == http.MethodPost:
		if s.CS == nil {
			http.Error(w, "code-server unavailable", 500)
			return
		}
		folder := r.URL.Query().Get("path")
		inst, err := s.CS.Start(folder)
		if err != nil {
			log.Printf("code-server start error: %v", err)
			http.Error(w, err.Error(), 500)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{
			"id": inst.ID, "path": "/cs/" + inst.ID + "/", "folder": inst.Folder,
		})

	case p == "/api/code-server/heartbeat" && r.Method == http.MethodPost:
		id := r.URL.Query().Get("id")
		if s.CS == nil || !s.CS.Touch(id) {
			http.Error(w, "not found", 404)
			return
		}
		w.WriteHeader(200)

	case p == "/api/code-server/stop" && r.Method == http.MethodPost:
		id := r.URL.Query().Get("id")
		if s.CS != nil {
			s.CS.Stop(id)
		}
		w.WriteHeader(200)

	case p == "/api/ping":
		w.Write([]byte("ok"))

	case p == "/api/stats" && r.Method == http.MethodGet:
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(s.getStats())

	case p == "/api/md-file" && r.Method == http.MethodGet:
		fp := r.URL.Query().Get("path")
		if fp == "" {
			http.Error(w, "missing path", http.StatusBadRequest)
			return
		}
		if !filepath.IsAbs(fp) {
			http.Error(w, "path must be absolute", http.StatusBadRequest)
			return
		}
		ext := strings.ToLower(filepath.Ext(fp))
		if ext != ".md" && ext != ".mdown" && ext != ".markdown" {
			http.Error(w, "only markdown files (.md, .mdown, .markdown) are allowed", http.StatusForbidden)
			return
		}
		f, err := os.Open(fp)
		if err != nil {
			http.Error(w, "file not found", http.StatusNotFound)
			return
		}
		defer f.Close()
		stat, _ := f.Stat()
		if stat.IsDir() {
			http.Error(w, "not a file", http.StatusBadRequest)
			return
		}
		w.Header().Set("Content-Type", "text/markdown; charset=utf-8")
		io.Copy(w, f)

	default:
		http.Error(w, "not found", 404)
	}
}

package httpapi

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

// 파일 종단 — 업로드·다운로드·읽기·쓰기와 그 기준 경로(cwd). 경로를 사용자 입력에서
// 받는 것은 이 파일뿐이므로 safeResolve·uniquePath 도 여기 둔다. 경로 가드를 손볼 때
// 봐야 할 면이 한 파일에 모인다.

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

// safeResolve verifies that userPath resolves within baseDir, preventing
// path-traversal attacks.
func safeResolve(baseDir, userPath string) (string, error) {
	cleaned := filepath.Clean(userPath)
	if !filepath.IsAbs(cleaned) {
		var err error
		cleaned, err = filepath.Abs(cleaned)
		if err != nil {
			return "", err
		}
	}
	rel, err := filepath.Rel(baseDir, cleaned)
	if err != nil {
		return "", err
	}
	if strings.HasPrefix(rel, "..") {
		return "", fmt.Errorf("path escapes base directory")
	}
	return cleaned, nil
}

func (s *Server) apiUpload(w http.ResponseWriter, r *http.Request) {
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
	safeDir, err := safeResolve("/", dir)
	if err != nil {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	outPath := uniquePath(safeDir, header.Filename)
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
}

func (s *Server) apiDownload(w http.ResponseWriter, r *http.Request) {
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
	if _, err := safeResolve("/", fp); err != nil {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
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
}

func (s *Server) apiCwd(w http.ResponseWriter, r *http.Request) {
	toolID := r.URL.Query().Get("tool")
	var cwd string
	if toolID != "" && s.Tools != nil {
		cwd = s.Tools.Cwd(toolID)
	}
	if cwd == "" {
		cwd, _ = os.Getwd()
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"cwd": cwd})
}

func (s *Server) apiFileRead(w http.ResponseWriter, r *http.Request) {
	fp := r.URL.Query().Get("path")
	if fp == "" {
		http.Error(w, "missing path", http.StatusBadRequest)
		return
	}
	if !filepath.IsAbs(fp) {
		http.Error(w, "path must be absolute", http.StatusBadRequest)
		return
	}
	if _, err := safeResolve("/", fp); err != nil {
		http.Error(w, "forbidden", http.StatusForbidden)
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
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	io.Copy(w, f)
}

type fileWriteReq struct {
	Path    string `json:"path"`
	Content string `json:"content"`
}

func (s *Server) apiFileWrite(w http.ResponseWriter, r *http.Request) {
	body, err := io.ReadAll(r.Body)
	if err != nil {
		http.Error(w, "read body: "+err.Error(), http.StatusBadRequest)
		return
	}
	var req fileWriteReq
	if err := json.Unmarshal(body, &req); err != nil {
		http.Error(w, "invalid json: "+err.Error(), http.StatusBadRequest)
		return
	}
	if req.Path == "" {
		http.Error(w, "missing path", http.StatusBadRequest)
		return
	}
	if !filepath.IsAbs(req.Path) {
		http.Error(w, "path must be absolute", http.StatusBadRequest)
		return
	}
	if _, err := safeResolve("/", req.Path); err != nil {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	if err := os.WriteFile(req.Path, []byte(req.Content), 0o644); err != nil {
		log.Printf("file write error: %v", err)
		http.Error(w, "write failed: "+err.Error(), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]bool{"ok": true})
}

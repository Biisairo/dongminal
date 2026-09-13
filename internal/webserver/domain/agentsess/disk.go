package agentsess

import (
	"bufio"
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"sort"

	"dongminal/internal/shared/dmlog"
	"dongminal/internal/shared/platform"
)

// 디스크 (M8_UNIFIED_SRS D-C-12 · D-C-14). 둘이 있다 — `agents.json` 의 **레코드**(세션을
// 되살릴 근거: 어댑터·신원·cwd·기동 옵션·휴면 상태)와 `agents/<toolId>.jsonl` 의 **로그**
// (SSE 와 같은 줄 `Logged`, 압축 뒤에는 `{"snap":…}` 한 줄이 앞에 선다). DataDir 이 비면
// 둘 다 없다 — P3 의 메모리 링만 남는다.

const (
	recordsFile = "agents.json"
	logsDir     = "agents"
	// diskLogMaxBytes 는 압축의 바이트 조건이다 (NFR-C-2). 이벤트 수 조건(LogCap)과 둘 중
	// 먼저 닿는 쪽.
	diskLogMaxBytes = 8 << 20
)

// Record 는 레코드 한 줄이다. 활성 세션도 레코드가 있다 — 서버가 죽어도 되살릴 근거다.
type Record struct {
	ToolID         string `json:"toolId"`
	Agent          string `json:"agent"`
	Name           string `json:"name"`
	SessionID      string `json:"sessionId,omitempty"`
	Cwd            string `json:"cwd,omitempty"`
	Approval       string `json:"approval,omitempty"`
	PermissionMode string `json:"permissionMode,omitempty"`
	Model          string `json:"model,omitempty"`
	Dormant        string `json:"dormant,omitempty"`
	Reason         string `json:"reason,omitempty"`
	At             int64  `json:"at"`
	LastSeq        int64  `json:"lastSeq"`
}

func (m *Manager) recordsPath() string { return filepath.Join(m.deps.DataDir, recordsFile) }

func (m *Manager) logPath(toolID string) string {
	return filepath.Join(m.deps.DataDir, logsDir, toolID+".jsonl")
}

// loadRecords 는 파일을 읽는다. 없거나 깨졌으면 빈 맵 — 되살릴 것이 없는 것이지 오류가 아니다.
func loadRecords(path string) map[string]Record {
	out := map[string]Record{}
	b, err := os.ReadFile(path)
	if err != nil {
		return out
	}
	var list []Record
	if err := json.Unmarshal(b, &list); err != nil {
		dmlog.Warnf(nil, "[agent] %s: %v", path, err)
		return out
	}
	for _, r := range list {
		if r.ToolID != "" {
			out[r.ToolID] = r
		}
	}
	return out
}

// saveRecords 는 지금 열린 세션 전부의 레코드를 원자적으로 쓴다. m.mu 밖에서 부른다 —
// 세션마다 자기 잠금으로 레코드를 만든다.
func (m *Manager) saveRecords() {
	if m.deps.DataDir == "" {
		return
	}
	m.mu.Lock()
	sess := make([]*Session, 0, len(m.sess))
	for _, s := range m.sess {
		sess = append(sess, s)
	}
	m.mu.Unlock()
	recs := make([]Record, 0, len(sess))
	for _, s := range sess {
		recs = append(recs, s.record())
	}
	sort.Slice(recs, func(i, j int) bool { return recs[i].ToolID < recs[j].ToolID })
	b, err := json.Marshal(recs)
	if err != nil {
		return
	}
	if err := os.MkdirAll(m.deps.DataDir, 0o755); err != nil {
		return
	}
	if err := platform.WriteStateFile(m.recordsPath(), b, 0o644); err != nil {
		dmlog.Warnf(nil, "[agent] agents.json: %v", err)
	}
}

// record 는 이 세션의 레코드다. s.mu 를 잡는다.
func (s *Session) record() Record {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.recordLocked()
}

func (s *Session) recordLocked() Record {
	mode := s.status.PermissionMode
	if mode == "" {
		mode = s.opts.PermissionMode
	}
	model := s.status.Model
	if model == "" {
		model = s.opts.Model
	}
	return Record{
		ToolID: s.toolID, Agent: s.ad.ID, Name: s.ad.ID, SessionID: s.st.SessionID,
		Cwd: s.opts.Cwd, Approval: s.opts.Approval, PermissionMode: mode, Model: model,
		Dormant: s.dormant, Reason: s.reason, At: s.at, LastSeq: s.nextSeq,
	}
}

// ── 로그 ──

// appendLog 는 이벤트 한 줄을 덧붙인다. s.mu 아래에서 부른다 — 순서가 곧 seq 순서다.
func (s *Session) appendLog(le Logged) {
	if s.mgr.deps.DataDir == "" {
		return
	}
	path := s.mgr.logPath(s.toolID)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		dmlog.Warnf(nil, "[agent %s] log: %v", s.toolID, err)
		return
	}
	defer f.Close()
	b, _ := json.Marshal(le)
	b = append(b, '\n')
	if _, err := f.Write(b); err != nil {
		dmlog.Warnf(nil, "[agent %s] log write: %v", s.toolID, err)
		return
	}
	s.logBytes += int64(len(b))
}

// compactLog 는 `{snap}` + 링으로 파일을 다시 쓴다 (D-C-12). s.mu 아래.
func (s *Session) compactLog() {
	if s.mgr.deps.DataDir == "" {
		return
	}
	var buf bytes.Buffer
	if s.snap != nil {
		b, _ := json.Marshal(map[string]any{"snap": s.snap})
		buf.Write(b)
		buf.WriteByte('\n')
	}
	for _, le := range s.log {
		b, _ := json.Marshal(le)
		buf.Write(b)
		buf.WriteByte('\n')
	}
	path := s.mgr.logPath(s.toolID)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return
	}
	if err := platform.WriteFileAtomic(path, buf.Bytes(), 0o644); err != nil {
		dmlog.Warnf(nil, "[agent %s] log compact: %v", s.toolID, err)
		return
	}
	s.logBytes = int64(buf.Len())
	s.droppedSinceCompact = 0
}

// loadLog 는 파일에서 스냅샷과 링을 되살린다 (D-C-14). 파싱되지 않는 줄(쓰다 끊긴 꼬리)은
// 버린다. 돌려주는 것은 마지막 snap 뒤의 이벤트들이다.
func loadLog(path string) (snap *Snapshot, evs []Logged, size int64) {
	f, err := os.Open(path)
	if err != nil {
		return nil, nil, 0
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, 64*1024), 16<<20)
	for sc.Scan() {
		line := sc.Bytes()
		size += int64(len(line)) + 1
		var row struct {
			Snap *Snapshot `json:"snap"`
		}
		if json.Unmarshal(line, &row) == nil && row.Snap != nil {
			snap, evs = row.Snap, nil
			continue
		}
		var le Logged
		if json.Unmarshal(line, &le) != nil || le.Seq == 0 {
			continue
		}
		evs = append(evs, le)
	}
	return snap, evs, size
}

// removeLog 는 세션의 로그 파일을 지운다. 레코드 자체는 다음 saveRecords 가 비운다.
func (m *Manager) removeLog(toolID string) {
	if m.deps.DataDir == "" {
		return
	}
	_ = os.Remove(m.logPath(toolID))
}

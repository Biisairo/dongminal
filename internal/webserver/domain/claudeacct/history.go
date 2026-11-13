package claudeacct

import (
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sync"
)

const (
	historyFile = "history.jsonl"
	historyMax  = 1000
)

// 전환 기록의 trigger (FR-CAC-110).
const (
	TriggerManual        = "manual"
	TriggerNext          = "next"
	TriggerNextAvailable = "next-available"
	TriggerBest          = "best"
	TriggerProactive     = "proactive"
	TriggerAtLimit       = "at-limit"
	TriggerFailover      = "failover"
	TriggerConsumeFirst  = "consume-first"
	TriggerPriority      = "priority"
)

// 전환 기록의 by (FR-CAC-110a).
const (
	ByUI    = "ui"
	ByDmctl = "dmctl"
	ByAuto  = "auto"
)

// HistoryEntry 는 history.jsonl 의 한 줄이다. 헤드룸을 모르면 nil 이다.
type HistoryEntry struct {
	At           int64    `json:"at"`
	From         string   `json:"from"`
	To           string   `json:"to"`
	Trigger      string   `json:"trigger"`
	HeadroomFrom *float64 `json:"headroomFrom"`
	HeadroomTo   *float64 `json:"headroomTo"`
	By           string   `json:"by"`
}

var historyMu sync.Mutex

func readHistoryLines(dir string) ([][]byte, error) {
	b, err := os.ReadFile(filepath.Join(dir, historyFile))
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var out [][]byte
	for _, l := range bytes.Split(b, []byte("\n")) {
		if len(bytes.TrimSpace(l)) > 0 {
			out = append(out, l)
		}
	}
	return out, nil
}

// appendHistory 는 한 줄을 더하고 historyMax 줄을 넘으면 오래된 것부터 지운다 (FR-CAC-110).
func appendHistory(dir string, h HistoryEntry) error {
	historyMu.Lock()
	defer historyMu.Unlock()
	line, err := json.Marshal(h)
	if err != nil {
		return err
	}
	lines, err := readHistoryLines(dir)
	if err != nil {
		return err
	}
	lines = append(lines, line)
	if len(lines) > historyMax {
		lines = lines[len(lines)-historyMax:]
	}
	var buf bytes.Buffer
	for _, l := range lines {
		buf.Write(l)
		buf.WriteByte('\n')
	}
	return writeSecretFile(filepath.Join(dir, historyFile), buf.Bytes())
}

// ReadHistory 는 최신 limit 건을 최신 먼저 돌려준다. 읽을 수 없는 줄은 건너뛴다.
func ReadHistory(dir string, limit int) ([]HistoryEntry, error) {
	historyMu.Lock()
	lines, err := readHistoryLines(dir)
	historyMu.Unlock()
	if err != nil {
		return nil, err
	}
	out := []HistoryEntry{}
	for i := len(lines) - 1; i >= 0 && len(out) < limit; i-- {
		var h HistoryEntry
		if json.Unmarshal(lines[i], &h) == nil {
			out = append(out, h)
		}
	}
	return out, nil
}

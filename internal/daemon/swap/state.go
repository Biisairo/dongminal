package swap

import (
	"encoding/json"
	"fmt"
	"io"
	"os"

	"dongminal/internal/shared/toolhub"
)

// State 는 exec 를 넘는 데몬의 기억이다 (DAEMON_SESSION_KEEP_SRS FR-DSK-14).
type State struct {
	Version  int                        `json:"version"`
	Tools    []toolhub.HandoverTool     `json:"tools"`
	Global   map[string]json.RawMessage `json:"global,omitempty"`
	PanedFD  uintptr                    `json:"panedFd"`
	ReportFD uintptr                    `json:"reportFd"`
}

// WriteState 는 st 를 이름 없는 임시 파일에 쓰고 처음으로 되감은 파일을 돌려준다 (D-DSK-12).
// dir 은 이름 있는 임시 파일이 잠시 놓일 자리다(memfd 가 없는 OS).
func WriteState(dir string, st State) (*os.File, error) {
	blob, err := json.Marshal(st)
	if err != nil {
		return nil, err
	}
	f, err := anonFile(dir)
	if err != nil {
		return nil, fmt.Errorf("인계 파일: %w", err)
	}
	if _, err := f.Write(blob); err != nil {
		f.Close()
		return nil, fmt.Errorf("인계 파일 쓰기: %w", err)
	}
	if _, err := f.Seek(0, io.SeekStart); err != nil {
		f.Close()
		return nil, err
	}
	return f, nil
}

// ReadState 는 f 에서 인계 상태를 읽고 f 를 닫는다. 닫는 순간 OS 가 내용을 치운다 (FR-DSK-25).
func ReadState(f *os.File) (State, error) {
	defer f.Close()
	var st State
	if err := json.NewDecoder(f).Decode(&st); err != nil {
		return State{}, fmt.Errorf("인계 상태 읽기: %w", err)
	}
	return st, nil
}

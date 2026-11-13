package runtimebin

import (
	"encoding/json"
	"fmt"
	"io"
	"maps"
	"path/filepath"
	"slices"
)

// CLAUDE_ACCOUNTS_SRS FR-CAC-102 — 탭 지정·폴더 연결 (묶음 H).

const accountMappingsPath = "/api/claude-accounts/mappings"

type accountMappings struct {
	Folders map[string]struct {
		AccountID string `json:"accountId"`
	} `json:"folders"`
	Tabs map[string]struct {
		AccountID string `json:"accountId"`
	} `json:"tabs"`
}

// accountByRef 는 계정 목록을 받아 ref 의 계정을 찾는다. 없으면 오류를 쓰고 rc 1 이다.
func accountByRef(ref string, stderr io.Writer) (accountRow, int) {
	v, _, rc := loadAccounts(stderr)
	if rc != 0 {
		return accountRow{}, rc
	}
	a, ok := resolveAccount(v, ref)
	if !ok {
		fmt.Fprintf(stderr, "dmctl account: 그런 계정이 없습니다: %s\n", clean(ref))
		return accountRow{}, 1
	}
	return a, 0
}

func accountPin(pa peerArgs, stdout, stderr io.Writer) int {
	unpin := pa.bools["clear"]
	if unpin == (len(pa.pos) == 1) || len(pa.pos) > 1 {
		fmt.Fprint(stderr, "dmctl account pin: <계정> 하나 또는 --clear 가 필요합니다\n")
		return 2
	}
	tool := pa.flags["tab"]
	if tool == "" {
		tool = selfToolID()
	}
	if tool == "" {
		fmt.Fprint(stderr, "dmctl account pin: 이 셸의 탭을 알 수 없습니다. --tab <toolId> 를 주세요\n")
		return 2
	}
	id, label := "", ""
	if !unpin {
		a, rc := accountByRef(pa.pos[0], stderr)
		if rc != 0 {
			return rc
		}
		id, label = a.ID, a.label()
	}
	if _, rc := accountAPI("PUT", accountMappingsPath, map[string]any{"toolId": tool, "accountId": id}, stderr); rc != 0 {
		return rc
	}
	if unpin {
		fmt.Fprintf(stdout, "탭 지정을 풀었습니다: %s\n", clean(tool))
	} else {
		fmt.Fprintf(stdout, "탭 지정: %s → %s\n", clean(tool), clean(label))
	}
	fmt.Fprintln(stdout, "실행 중인 claude 에는 적용되지 않고 다음 실행부터 적용됩니다.")
	return 0
}

// accountFolderArg 는 경로 인자를 절대 경로로 바꾼다. 비면 현재 폴더다.
func accountFolderArg(p string, stderr io.Writer) (string, int) {
	if p == "" {
		p = "."
	}
	abs, err := filepath.Abs(p)
	if err != nil {
		fmt.Fprintf(stderr, "dmctl account: 경로를 알 수 없습니다: %v\n", err)
		return "", 1
	}
	return abs, 0
}

func accountMap(pa peerArgs, stdout, stderr io.Writer) int {
	if len(pa.pos) < 1 || len(pa.pos) > 2 {
		fmt.Fprint(stderr, "dmctl account map: <계정> [경로] 가 필요합니다\n")
		return 2
	}
	a, rc := accountByRef(pa.pos[0], stderr)
	if rc != 0 {
		return rc
	}
	path := ""
	if len(pa.pos) == 2 {
		path = pa.pos[1]
	}
	dir, rc := accountFolderArg(path, stderr)
	if rc != 0 {
		return rc
	}
	if _, rc := accountAPI("PUT", accountMappingsPath, map[string]any{"folder": dir, "accountId": a.ID}, stderr); rc != 0 {
		return rc
	}
	fmt.Fprintf(stdout, "폴더 연결: %s → %s\n다음 claude 실행부터 적용됩니다.\n", clean(dir), clean(a.label()))
	return 0
}

func accountUnmap(pa peerArgs, stdout, stderr io.Writer) int {
	if len(pa.pos) > 1 {
		fmt.Fprint(stderr, "dmctl account unmap: [경로] 하나만 받습니다\n")
		return 2
	}
	path := ""
	if len(pa.pos) == 1 {
		path = pa.pos[0]
	}
	dir, rc := accountFolderArg(path, stderr)
	if rc != 0 {
		return rc
	}
	if _, rc := accountAPI("PUT", accountMappingsPath, map[string]any{"folder": dir, "accountId": ""}, stderr); rc != 0 {
		return rc
	}
	fmt.Fprintf(stdout, "폴더 연결을 풀었습니다: %s\n", clean(dir))
	return 0
}

func accountMaps(_ peerArgs, stdout, stderr io.Writer) int {
	v, _, rc := loadAccounts(stderr)
	if rc != 0 {
		return rc
	}
	raw, rc := accountAPI("GET", accountMappingsPath, nil, stderr)
	if rc != 0 {
		return rc
	}
	var m accountMappings
	if err := json.Unmarshal(raw, &m); err != nil {
		fmt.Fprintf(stderr, "dmctl account: 응답을 읽지 못했습니다: %v\n", err)
		return 1
	}
	name := func(id string) string {
		if a, ok := resolveAccount(v, id); ok {
			return clean(a.label())
		}
		return "(삭제된 계정)"
	}
	fmt.Fprintln(stdout, "폴더 연결:")
	for _, k := range slices.Sorted(maps.Keys(m.Folders)) {
		fmt.Fprintf(stdout, "  %s → %s\n", clean(k), name(m.Folders[k].AccountID))
	}
	fmt.Fprintln(stdout, "탭 지정:")
	for _, k := range slices.Sorted(maps.Keys(m.Tabs)) {
		fmt.Fprintf(stdout, "  %s → %s\n", clean(k), name(m.Tabs[k].AccountID))
	}
	return 0
}

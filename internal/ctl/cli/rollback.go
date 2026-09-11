package cli

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"time"

	"dongminal/internal/shared/platform"
)

// `G3-2`(PRODUCTION_ROADMAP §M3) — **되돌릴 길.**
//
// 세대는 `G4-1` 이 세웠고(`platform.WriteStateFile`), 손상 복원은 `G4-2` 가
// 기동에서 자동으로 한다. 없던 것은 **사용자가 스스로 되돌리는 길**이다 — 상위
// 스키마로 올라갔다가 내려왔거나, 판을 잘못 올려 화면이 깨졌을 때 쓴다.
//
// 자동으로 하지 않는 이유: 어느 세대가 맞는지는 사용자만 안다. 기동이 대신 고르면
// 사용자가 원한 적 없는 배치로 되돌아간다.

// RollbackOpts 는 `dongminal rollback` 의 입력이다.
type RollbackOpts struct {
	Common
	// Gen 은 되돌릴 세대다. 0 이면 **목록만 보인다** — 무엇으로 되돌릴지 모르는
	// 채 되돌리게 하지 않는다.
	Gen int
	// File 은 되돌릴 상태 파일이다. 비면 `workspace.json` — 잃어서 가장 아픈 것이다.
	File string
}

// rollbackTargets 는 되돌릴 수 있는 상태 파일이다.
//
// **목록으로 막는다.** 임의 경로를 받으면 이 명령이 파일 덮어쓰기 도구가 되고,
// 그것은 이 명령이 하려는 일이 아니다. 여기 있는 것은 전부 `WriteStateFile` 이
// 세대를 남기는 자리다 (`G4-1`).
//
// `settings.json` 이 여기 있는 것이 `G4-4` 다 — 설정 가져오기는 현재 설정을
// 통째로 덮는데, 그 직전 판은 이미 `.bak.1` 로 남는다. 없던 것은 **그것을
// 되돌릴 길**이었다. 기계를 새로 만들지 않고 이 명령을 넓힌다.
var rollbackTargets = []string{"workspace.json", "settings.json", "access.json", "runs.json", "tools.json"}

const defaultRollbackTarget = "workspace.json"

// resolveTarget 은 고른 파일이 되돌릴 수 있는 것인지 본다.
func resolveTarget(name string) (string, error) {
	if name == "" {
		return defaultRollbackTarget, nil
	}
	for _, t := range rollbackTargets {
		if t == name {
			return t, nil
		}
	}
	return "", fmt.Errorf("되돌릴 수 있는 대상이 아닙니다: %q (가능: %v)", name, rollbackTargets)
}

// ParseRollback 은 `rollback` 의 인자를 읽는다.
func ParseRollback(args []string) (RollbackOpts, error) {
	var o RollbackOpts
	for i := 0; i < len(args); i++ {
		switch args[i] {
		case "--gen":
			if i+1 >= len(args) {
				return o, fmt.Errorf("--gen 에 번호가 필요합니다")
			}
			i++
			n, err := strconv.Atoi(args[i])
			if err != nil || n < 1 {
				return o, fmt.Errorf("--gen 은 1 이상의 번호입니다: %q", args[i])
			}
			o.Gen = n
		case "--file":
			if i+1 >= len(args) {
				return o, fmt.Errorf("--file 에 이름이 필요합니다")
			}
			i++
			o.File = args[i]
		case "--home":
			if i+1 >= len(args) {
				return o, fmt.Errorf("--home 에 경로가 필요합니다")
			}
			i++
			o.Home = args[i]
		default:
			return o, fmt.Errorf("알 수 없는 인자: %q", args[i])
		}
	}
	return o, nil
}

// RunRollback 은 `dongminal rollback` 이다.
func RunRollback(o RollbackOpts, stdout, stderr io.Writer) int {
	home, err := o.ResolveHome()
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	target, err := resolveTarget(o.File)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	path := filepath.Join(home, target)

	if o.Gen == 0 {
		return listGenerations(path, stdout, stderr)
	}

	// **도는 인스턴스가 있으면 거부한다.** 지금 되돌려도 그 서버가 곧 자기
	// 메모리로 덮어쓴다 — 성공처럼 보이고 아무 일도 일어나지 않는 것이 가장 나쁘다.
	//
	// 판정은 `daemonOurs` 와 같은 재료다(소켓이 답하는가). 다만 여기서는 **답하는
	// 상대가 있다는 사실**만으로 충분하다 — 그것이 우리 데몬이든 아니든, 그 홈을
	// 누군가 쓰고 있다.
	transport := platform.Current().IPC
	if conn, err := transport.Dial(transport.Endpoint(home), daemonProbeTimeout); err == nil {
		conn.Close()
		fmt.Fprintln(stderr, "이 홈에서 dongminald 가 돌고 있습니다.")
		fmt.Fprintln(stderr, "되돌리기 전에 `dongminal stop --all` 로 내려 주세요 (터미널 세션을 잃습니다).")
		return 1
	}

	src := fmt.Sprintf("%s.bak.%d", path, o.Gen)
	blob, err := os.ReadFile(src)
	if err != nil {
		fmt.Fprintf(stderr, "세대 %d 를 읽을 수 없습니다: %v\n", o.Gen, err)
		return 1
	}

	// **되돌리기도 되돌릴 수 있어야 한다.** 지금 판을 지우지 않고 옆에 남긴다 —
	// 사용자가 세대를 잘못 골랐을 때 돌아올 자리다.
	if _, err := os.Stat(path); err == nil {
		keep := fmt.Sprintf("%s.before-rollback-%s", path, time.Now().UTC().Format("20060102T150405Z"))
		if err := os.Rename(path, keep); err != nil {
			fmt.Fprintf(stderr, "지금 판을 남기지 못했습니다: %v\n", err)
			return 1
		}
		fmt.Fprintf(stdout, "지금 판을 %s 로 남겼습니다\n", filepath.Base(keep))
	}
	if err := platform.WriteFileAtomic(path, blob, 0o644); err != nil {
		fmt.Fprintf(stderr, "되돌리기 실패: %v\n", err)
		return 1
	}
	fmt.Fprintf(stdout, "✅ %s 를 세대 %d 로 되돌렸습니다\n", target, o.Gen)
	return 0
}

// listGenerations 는 되돌릴 수 있는 자리를 보인다. **읽히는지까지는 묻지 않는다** —
// 그 판단은 되돌린 뒤 기동이 하고, 여기서 미리 걸러 내면 사용자가 고를 수 있는
// 것이 줄어든다.
func listGenerations(path string, stdout, stderr io.Writer) int {
	fmt.Fprintf(stdout, "되돌릴 수 있는 세대 (%s):\n", filepath.Base(path))
	found := 0
	for i := 1; i <= platform.StateFileGenerations; i++ {
		p := fmt.Sprintf("%s.bak.%d", path, i)
		st, err := os.Stat(p)
		if err != nil {
			continue
		}
		found++
		fmt.Fprintf(stdout, "  %d  %s  %d bytes  %s\n",
			i, filepath.Base(p), st.Size(), st.ModTime().Format("2006-01-02 15:04:05"))
	}
	if found == 0 {
		fmt.Fprintln(stdout, "  (없음 — 아직 덮어쓴 적이 없거나 세대가 지워졌습니다)")
		return 0
	}
	fmt.Fprintln(stdout, "\n되돌리려면: dongminal rollback --gen <번호>")
	return 0
}

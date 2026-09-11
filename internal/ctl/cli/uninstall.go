package cli

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

// `dongminal uninstall` — **무엇을 지울지 먼저 보인다** (M5 `G3-4`).
//
// 제거 절차가 없었다. 그래서 사람들은 `rm -rf ~/.dongminal` 을 쳤고, 그것은
// 메모장과 워크스페이스까지 함께 가져간다 — 되돌릴 수 없다.
//
// **기본이 목록이다.** 지우려면 `--yes` 를 명시해야 하고, 그 앞에 `--dry-run`
// 으로 전체를 볼 수 있다. 되돌릴 수 없는 동작 앞에서 기본값은 "하지 않는 것" 이다.

// UninstallOpts 는 `dongminal uninstall` 의 옵션이다.
type UninstallOpts struct {
	Common
	DryRun bool
	Yes    bool
	// Purge 는 되살릴 수 있는 상태까지 지운다. 기본은 **남긴다** — 다시 설치할
	// 사람이 배치와 설정을 잃지 않는다.
	Purge bool
}

// ParseUninstall 은 `uninstall [--dry-run] [--yes] [--purge] [--home …]` 이다.
func ParseUninstall(args []string) (UninstallOpts, error) {
	var o UninstallOpts
	for i := 0; i < len(args); i++ {
		switch a := args[i]; a {
		case "-h", "--help":
			return UninstallOpts{}, ErrHelp
		case "--dry-run", "-n":
			o.DryRun = true
		case "--yes", "-y":
			o.Yes = true
		case "--purge":
			o.Purge = true
		default:
			took, err := o.Common.take(args, &i)
			if err != nil {
				return UninstallOpts{}, err
			}
			if !took {
				return UninstallOpts{}, unknownFlag("uninstall", a)
			}
		}
	}
	return o, nil
}

// RunUninstall 은 `dongminal uninstall` 이다.
func RunUninstall(o UninstallOpts, stdout, stderr io.Writer) int {
	home, err := o.ResolveHome()
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	plan := uninstallPlan(home, o.Purge)

	fmt.Fprintf(stdout, "홈: %s\n\n", home)
	if len(plan) == 0 {
		fmt.Fprintln(stdout, "지울 것이 없습니다 — 홈이 비었거나 이미 제거됐습니다.")
		return 0
	}
	fmt.Fprintf(stdout, "지울 항목 %d개:\n", len(plan))
	for _, p := range plan {
		mark := " "
		if p.entry.Backup {
			// **되살릴 수 있는 것**에 표시를 단다. 사람이 멈출 자리가 여기다.
			mark = "!"
		}
		fmt.Fprintf(stdout, " %s %-24s %s\n", mark, p.entry.Name, p.entry.What)
	}
	if !o.Purge {
		kept := keptNames(home)
		if len(kept) > 0 {
			fmt.Fprintf(stdout, "\n남기는 항목 %d개 (되살릴 수 있는 상태):\n  %s\n",
				len(kept), strings.Join(kept, " · "))
			fmt.Fprintln(stdout, "  전부 지우려면: --purge")
		}
	}

	if o.DryRun {
		fmt.Fprintln(stdout, "\n(--dry-run — 아무것도 지우지 않았습니다)")
		return 0
	}
	if !o.Yes {
		// 되돌릴 수 없는 동작이다. **기본값은 하지 않는 것**이고, 되돌리는 길의
		// 이름이 곧 경고다 (`--insecure-no-acl` 과 같은 규약).
		fmt.Fprintln(stderr, "\n지우려면 --yes 를 함께 주세요. 되돌릴 수 없습니다.")
		fmt.Fprintln(stderr, "먼저 백업하려면: dongminal backup --out <파일.zip>")
		return 1
	}

	var failed int
	for _, p := range plan {
		if err := os.RemoveAll(p.path); err != nil {
			fmt.Fprintf(stderr, "✗ %s: %v\n", p.entry.Name, err)
			failed++
		}
	}
	if failed > 0 {
		return 1
	}
	fmt.Fprintf(stdout, "\n✅ %d개를 지웠습니다.\n", len(plan))
	if !o.Purge {
		fmt.Fprintln(stdout, "   설정과 배치는 남아 있습니다 — 다시 설치하면 그대로 돌아옵니다.")
	}
	return 0
}

type uninstallItem struct {
	entry homeEntry
	path  string
}

// uninstallPlan 은 **실제로 있는 것만** 담는다. 없는 것을 목록에 넣으면 그 목록이
// "이만큼 잃는다" 를 과장한다.
func uninstallPlan(home string, purge bool) []uninstallItem {
	var out []uninstallItem
	for _, e := range homeLayout() {
		if e.Backup && !purge {
			continue
		}
		p := filepath.Join(home, e.Name)
		if _, err := os.Lstat(p); err != nil {
			continue
		}
		out = append(out, uninstallItem{entry: e, path: p})
	}
	return out
}

func keptNames(home string) []string {
	var out []string
	for _, e := range homeLayout() {
		if !e.Backup {
			continue
		}
		if _, err := os.Lstat(filepath.Join(home, e.Name)); err == nil {
			out = append(out, e.Name)
		}
	}
	return out
}

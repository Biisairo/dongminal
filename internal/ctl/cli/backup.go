package cli

import (
	"archive/zip"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"strings"
)

// `dongminal backup` / `restore` — 홈 전체를 옮긴다 (M5 `G4-3`).
//
// M3 이 상태 파일마다 **세대**를 만들고 `rollback` 을 주었다. 남아 있던 것은
// 홈 **전체**를 한 파일로 옮기는 길이다 — 기계를 바꾸거나, 크게 고치기 전에
// 통째로 쥐고 싶을 때의 것.
//
// ── 담는 것과 담지 않는 것 ─────────────────────────────────
//
// 목록은 `homeLayout` 이 소유한다. 담을 것과 `uninstall` 이 지울 것은 **같은
// 물음의 두 답**이고, 두 벌로 적으면 한쪽만 고쳐진다.
//
// 소켓·pid·로그는 담지 않는다. 다음 기동이 다시 만드는 것이고, 소켓은 zip 에
// 담기지도 않는다. 복원이 로그를 건드리지 않는 것도 같은 이유의 반대쪽이다 —
// 사고 직후의 증거를 복원이 지우면 안 된다.

// BackupOpts 는 `dongminal backup` 의 옵션이다.
type BackupOpts struct {
	Common
	Out string
}

// ParseBackup 은 `backup --out <파일.zip> [--home …]` 이다.
func ParseBackup(args []string) (BackupOpts, error) {
	var o BackupOpts
	for i := 0; i < len(args); i++ {
		a := args[i]
		switch {
		case a == "-h" || a == "--help":
			return BackupOpts{}, ErrHelp
		case a == "--out" || strings.HasPrefix(a, "--out="):
			v, adv, err := flagValue(args, i, "--out")
			if err != nil {
				return BackupOpts{}, err
			}
			o.Out = v
			i += adv
		default:
			took, err := o.Common.take(args, &i)
			if err != nil {
				return BackupOpts{}, err
			}
			if !took {
				return BackupOpts{}, unknownFlag("backup", a)
			}
		}
	}
	if o.Out == "" {
		return BackupOpts{}, fmt.Errorf("backup: --out <파일.zip> 이 필요합니다")
	}
	return o, nil
}

// RunBackup 은 `dongminal backup` 이다.
func RunBackup(o BackupOpts, stdout, stderr io.Writer) int {
	home, err := o.ResolveHome()
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	f, err := os.Create(o.Out)
	if err != nil {
		fmt.Fprintf(stderr, "백업 파일을 만들 수 없습니다: %v\n", err)
		return 1
	}
	defer f.Close()
	z := zip.NewWriter(f)

	var n int
	for _, e := range homeLayout() {
		if !e.Backup {
			continue
		}
		src := filepath.Join(home, e.Name)
		st, err := os.Lstat(src)
		if err != nil {
			continue // 없는 것은 정상이다
		}
		if st.IsDir() {
			added, err := addDir(z, src, e.Name)
			if err != nil {
				fmt.Fprintf(stderr, "✗ %s: %v\n", e.Name, err)
				return 1
			}
			n += added
			continue
		}
		if !st.Mode().IsRegular() {
			// 소켓·심링크는 담지 않는다. 이 표에서는 일어나지 않아야 하지만,
			// 항목이 늘었을 때 조용히 이상한 것이 담기는 길을 막는다.
			continue
		}
		if err := addFile(z, src, e.Name); err != nil {
			fmt.Fprintf(stderr, "✗ %s: %v\n", e.Name, err)
			return 1
		}
		n++
	}
	if err := z.Close(); err != nil {
		fmt.Fprintf(stderr, "백업을 닫지 못했습니다: %v\n", err)
		return 1
	}
	fmt.Fprintf(stdout, "✅ 백업 %d개 항목: %s\n", n, o.Out)
	fmt.Fprintln(stdout, "   담기지 않은 것: 로그·소켓·pid·런타임 헬퍼 — 다음 기동이 다시 만듭니다.")
	return 0
}

func addFile(z *zip.Writer, src, name string) error {
	w, err := z.Create(name)
	if err != nil {
		return err
	}
	r, err := os.Open(src)
	if err != nil {
		return err
	}
	defer r.Close()
	_, err = io.Copy(w, r)
	return err
}

func addDir(z *zip.Writer, root, prefix string) (int, error) {
	var n int
	err := filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			return nil
		}
		info, err := d.Info()
		if err != nil || !info.Mode().IsRegular() {
			return nil
		}
		rel, err := filepath.Rel(root, p)
		if err != nil {
			return err
		}
		if err := addFile(z, p, path.Join(prefix, filepath.ToSlash(rel))); err != nil {
			return err
		}
		n++
		return nil
	})
	return n, err
}

// RestoreOpts 는 `dongminal restore` 의 옵션이다.
type RestoreOpts struct {
	Common
	Zip string
	Yes bool
}

// ParseRestore 는 `restore <파일.zip> [--yes] [--home …]` 이다.
func ParseRestore(args []string) (RestoreOpts, error) {
	var o RestoreOpts
	for i := 0; i < len(args); i++ {
		a := args[i]
		switch {
		case a == "-h" || a == "--help":
			return RestoreOpts{}, ErrHelp
		case a == "--yes" || a == "-y":
			o.Yes = true
		case strings.HasPrefix(a, "-"):
			took, err := o.Common.take(args, &i)
			if err != nil {
				return RestoreOpts{}, err
			}
			if !took {
				return RestoreOpts{}, unknownFlag("restore", a)
			}
		case o.Zip == "":
			o.Zip = a
		default:
			return RestoreOpts{}, fmt.Errorf("restore: 인자가 너무 많습니다: %s", a)
		}
	}
	if o.Zip == "" {
		return RestoreOpts{}, fmt.Errorf("restore: 백업 파일(.zip)이 필요합니다")
	}
	return o, nil
}

// RunRestore 는 `dongminal restore` 다.
//
// **담긴 것만 되돌린다.** 담기지 않은 것은 건드리지 않는다 — 복원이 로그를
// 지우면 사고 직후의 증거가 사라진다.
func RunRestore(o RestoreOpts, stdout, stderr io.Writer) int {
	home, err := o.ResolveHome()
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	r, err := zip.OpenReader(o.Zip)
	if err != nil {
		fmt.Fprintf(stderr, "백업을 열 수 없습니다: %v\n", err)
		return 1
	}
	defer r.Close()

	fmt.Fprintf(stdout, "홈: %s\n백업: %s (%d개 항목)\n", home, o.Zip, len(r.File))
	if !o.Yes {
		// 복원은 되돌릴 수 없다. **먼저 지금 것을 백업하라**고 안내한다 —
		// 되돌릴 길을 말하지 않는 확인은 확인이 아니다.
		fmt.Fprintln(stderr, "\n지금 홈의 파일을 덮어씁니다. 되돌릴 수 없습니다.")
		fmt.Fprintln(stderr, "진행하려면 --yes 를 함께 주세요.")
		fmt.Fprintln(stderr, "먼저 지금 것을 담아 두려면: dongminal backup --out <파일.zip>")
		return 1
	}

	var done, skipped int
	for _, f := range r.File {
		dst, ok := safeJoin(home, f.Name)
		if !ok {
			// zip slip. 복원이 홈 밖의 파일을 덮으면 그것은 복원이 아니라
			// 임의 쓰기다. **조용히 넘기지 않는다** — 건너뛴 사실을 말한다.
			fmt.Fprintf(stderr, "건너뜀 (홈 밖을 가리킵니다): %s\n", f.Name)
			skipped++
			continue
		}
		if f.FileInfo().IsDir() {
			continue
		}
		if err := os.MkdirAll(filepath.Dir(dst), 0o700); err != nil {
			fmt.Fprintf(stderr, "✗ %s: %v\n", f.Name, err)
			return 1
		}
		rc, err := f.Open()
		if err != nil {
			fmt.Fprintf(stderr, "✗ %s: %v\n", f.Name, err)
			return 1
		}
		out, err := os.OpenFile(dst, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
		if err != nil {
			rc.Close()
			fmt.Fprintf(stderr, "✗ %s: %v\n", f.Name, err)
			return 1
		}
		_, cerr := io.Copy(out, rc)
		rc.Close()
		out.Close()
		if cerr != nil {
			fmt.Fprintf(stderr, "✗ %s: %v\n", f.Name, cerr)
			return 1
		}
		done++
	}
	fmt.Fprintf(stdout, "✅ %d개를 되돌렸습니다.\n", done)
	if skipped > 0 {
		fmt.Fprintf(stdout, "   %d개는 건너뛰었습니다 (홈 밖을 가리킴).\n", skipped)
	}
	fmt.Fprintln(stdout, "   돌고 있는 서버가 있으면 다시 띄워야 반영됩니다.")
	return 0
}

// safeJoin 은 zip 항목 이름을 홈 아래 경로로 옮긴다. 밖으로 나가면 거부한다.
func safeJoin(home, name string) (string, bool) {
	if name == "" || strings.HasPrefix(name, "/") || filepath.IsAbs(name) {
		return "", false
	}
	// `path.Clean` 이 `../` 를 접는다. 접고도 남으면 밖으로 나가는 것이다.
	clean := path.Clean(name)
	if clean == ".." || strings.HasPrefix(clean, "../") {
		return "", false
	}
	dst := filepath.Join(home, filepath.FromSlash(clean))
	// 접은 뒤에도 한 번 더 본다 — 심링크가 아닌 경로 계산만으로 판정한다.
	rel, err := filepath.Rel(home, dst)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return "", false
	}
	return dst, true
}

// flagValue 는 `--x v` 와 `--x=v` 를 함께 받는다. adv 는 소비한 추가 인자 수다.
func flagValue(args []string, i int, name string) (string, int, error) {
	a := args[i]
	if v, ok := strings.CutPrefix(a, name+"="); ok {
		if v == "" {
			return "", 0, fmt.Errorf("%s 에 값이 없습니다", name)
		}
		return v, 0, nil
	}
	if i+1 >= len(args) {
		return "", 0, fmt.Errorf("%s 에 값이 없습니다", name)
	}
	return args[i+1], 1, nil
}

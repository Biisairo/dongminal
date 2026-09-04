package sandbox

import (
	"fmt"
	"io/fs"
	"path/filepath"
	"strings"
)

// 작업 폴더를 **복사**로 받는 프로파일의 구현 (SANDBOX_PICK_COPY_SRS 묶음 C).
//
// 마운트는 컨테이너 안 코드에 호스트 파일을 내주므로 그 창은 격리 경계가 아니다
// (FR-SBX-39b). 복사에는 돌아오는 통로가 없어 그 근거에 걸리지 않고, 그래서
// `scratch` 에 작업 폴더를 줄 수 있는 유일한 방식이다 (D-SPK-2).
//
// **대가는 단방향이라는 것이다.** 컨테이너 안에서 고친 것은 호스트로 돌아오지
// 않으며, 그 사실은 화면 세 자리에 적힌다 (FR-SPK-21) — 여기서 조용히 처리하고
// 넘어갈 성질이 아니다.

// WorkKind 는 프로파일이 작업 폴더를 다루는 방식이다 (FR-SPK-10).
type WorkKind string

const (
	// WorkNone 은 작업 폴더를 쓰지 않는다. 고른 값이 있어도 버린다 (FR-SPK-6).
	WorkNone WorkKind = "none"
	// WorkMount 는 호스트 경로를 컨테이너에 **잇는다.** 컨테이너 안 변경이
	// 호스트에 그대로 남고, 그래서 그 창은 격리 경계가 아니다.
	WorkMount WorkKind = "mount"
	// WorkCopy 는 내용을 컨테이너 안으로 **넣는다.** 컨테이너 안 변경은
	// 호스트로 돌아오지 않는다.
	WorkCopy WorkKind = "copy"
)

// 복사의 상한 (FR-SPK-14).
//
// `const` 가 아니라 `var` 인 것은 테스트 때문이다 — 실제 값으로 상한 픽스처를
// 만들면 테스트가 파일 5만 개를 만든다 (EDITOR_TAB_SRS D-23 과 같은 관례).
// 프로덕션 경로에서는 바꾸지 않는다.
var (
	CopyMaxBytes int64 = 2 << 30 // 2 GiB
	CopyMaxFiles       = 50_000
)

// VerifyCopySource 는 복사할 원본이 상한 안인지 본다.
//
// **먼저 전부 세고, 넘으면 아무것도 하지 않는다** (FR-SPK-14). 세다가 중간에
// 멈추면 절반만 들어간 컨테이너가 남는데, 그것이 거부보다 나쁘다 —
// FR-EDT-118 이 재귀 삭제에서 내린 것과 같은 판단이다.
//
// 제외 규칙은 없다 (FR-SPK-16 / D-SPK-6). `.git` 도 `node_modules` 도 그대로
// 센다 — 무엇이 빠졌는지 사용자가 알 수 없는 복사는 "복사했다" 를 거짓으로
// 만든다. 큰 폴더는 조용히 줄이는 것이 아니라 거부로 다룬다.
func VerifyCopySource(p Profile, hostDir string, maxBytes int64, maxFiles int) error {
	if p.Work != WorkCopy || hostDir == "" {
		return nil
	}
	var bytes int64
	var files int
	err := filepath.WalkDir(hostDir, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			return nil
		}
		files++
		// 심볼릭 링크는 따라가지 않는다 — `docker cp` 도 링크를 그대로 담고,
		// 따라가면 순환에서 세기가 끝나지 않는다.
		if d.Type()&fs.ModeSymlink != 0 {
			return nil
		}
		info, err := d.Info()
		if err != nil {
			return err
		}
		bytes += info.Size()
		if bytes > maxBytes || files > maxFiles {
			// 상한을 넘은 것이 확정됐다 — 더 세는 것은 답을 바꾸지 않는다.
			return errCopyOverLimit
		}
		return nil
	})
	if err != nil && err != errCopyOverLimit {
		// 셀 수 없으면 복사하지 않는다 (FR-SPK-15). 없는 경로도 여기로 온다 —
		// 그쪽은 FR-SBX-41 이 이미 정한 규칙이다.
		return fmt.Errorf("작업 폴더를 읽을 수 없습니다: %w", err)
	}
	if bytes > maxBytes {
		return fmt.Errorf("작업 폴더가 너무 큽니다(%s > %s) — 더 좁은 폴더를 고르거나 %s 프로파일로 마운트하세요",
			humanBytes(bytes), humanBytes(maxBytes), ProfileDev)
	}
	if files > maxFiles {
		return fmt.Errorf("작업 폴더의 항목이 너무 많습니다(%d > %d) — 더 좁은 폴더를 고르거나 %s 프로파일로 마운트하세요",
			files, maxFiles, ProfileDev)
	}
	return nil
}

// errCopyOverLimit 은 걷기를 일찍 끝내는 신호다. 밖으로 나가지 않는다 —
// 사용자가 볼 사유는 무엇을 얼마나 넘었는지이며 그것은 호출자가 만든다.
var errCopyOverLimit = fmt.Errorf("copy: over limit")

func humanBytes(n int64) string {
	const unit = 1024
	if n < unit {
		return fmt.Sprintf("%d B", n)
	}
	div, exp := int64(unit), 0
	for v := n / unit; v >= unit; v /= unit {
		div *= unit
		exp++
	}
	return fmt.Sprintf("%.1f %ciB", float64(n)/float64(div), "KMGTPE"[exp])
}

// copyWork 는 갓 만든 컨테이너에 작업 폴더의 **내용**을 넣는다 (FR-SPK-11).
//
//	docker cp <host>/. <container>:/work
//
// 끝의 `.` 이 요점이다 — 그것이 "폴더 자체" 가 아니라 "폴더의 내용" 을 뜻하며,
// 없으면 `/work/<원본폴더이름>/` 이라는 한 겹이 더 생긴다.
//
// 부르는 자리는 `create` 하나다 (FR-SPK-12) — 재접속 경로에서 부르면 컨테이너
// 안의 작업을 호스트의 옛 내용이 덮는다.
func (m *Manager) copyWork(name string, p Profile, rs RunSpec) error {
	if p.Work != WorkCopy || rs.HostDir == "" {
		return nil
	}
	src := strings.TrimSuffix(rs.HostDir, "/") + "/."
	if out, err := m.run([]string{"cp", src, name + ":" + ContainerWorkdir}); err != nil {
		return fmt.Errorf("작업 폴더를 컨테이너에 복사하지 못했습니다(%s): %w: %s",
			rs.HostDir, err, strings.TrimSpace(out))
	}
	return nil
}

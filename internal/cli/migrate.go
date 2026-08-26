package cli

import (
	"fmt"
	"io"
	"os"
	"time"

	"dongminal/internal/migrate"
)

// targetFlags는 기본값이 아닌 대상을 가리킬 때 안내에 덧붙일 플래그다.
// 격리 인스턴스에 대해 `dongminal stop --all` 만 안내하면 그 명령이 운영
// 인스턴스를 향한다.
func targetFlags(c Common, port, home string) string {
	var s string
	if port != DefaultPort {
		s += " --port " + port
	}
	if c.Home != "" || os.Getenv(EnvHome) != "" {
		s += " --home " + home
	}
	return s
}

// RunMigrate는 `dongminal migrate` 다 (FR-ACT-11/12).
//
// 서버 실행 중 거부(FR-ACT-12)를 migrate.Apply 의 데몬 검사에 맡길 수 없다 —
// direct mode 로 도는 인스턴스는 paned.pid 가 죽은 pid 를 가리키므로 그
// 검사를 통과한다. 서버 자체를 두드려 확인한다.
func RunMigrate(o MigrateOpts, stdout, stderr io.Writer) int {
	home, err := o.ResolveHome()
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	port := o.ResolvePort()

	if !o.DryRun && ping(fmt.Sprintf("http://127.0.0.1:%s/api/ping", port), 2*time.Second) {
		fmt.Fprintf(stderr, "❌ dongminal 이 포트 %s 에서 실행 중입니다 — 변환하지 않았습니다.\n", port)
		fmt.Fprintln(stderr, "   서버와 데몬을 완전히 정지한 뒤 다시 실행하세요:")
		fmt.Fprintf(stderr, "     dongminal stop --all%s\n", targetFlags(o.Common, port, home))
		return 1
	}

	rep, err := migrate.Apply(home, o.DryRun)
	if err != nil {
		fmt.Fprintf(stderr, "마이그레이션 실패: %v\n변경된 파일 없음.\n", err)
		return 1
	}
	if rep.Empty {
		fmt.Fprintf(stdout, "마이그레이션 대상 없음 (%s)\n", home)
		return 0
	}
	if o.DryRun {
		fmt.Fprintln(stdout, "[dry-run] 파일을 변경하지 않습니다.")
	}
	if rep.AlreadyMigrated {
		fmt.Fprintln(stdout, "이미 v2 스키마입니다. 참조 정리만 수행합니다.")
	}
	fmt.Fprintf(stdout, "Window %d개, Tool %d개\n", rep.Windows, rep.Tools)
	if len(rep.Orphans) > 0 {
		fmt.Fprintf(stdout, "고아 도구 %d개 폐기: %v\n", len(rep.Orphans), rep.Orphans)
	}
	if len(rep.GhostRefs) > 0 {
		fmt.Fprintf(stdout, "agentsOrder 유령 참조 %d개 제거: %v\n", len(rep.GhostRefs), rep.GhostRefs)
	}
	if len(rep.ShortcutsRenamed) > 0 {
		fmt.Fprintf(stdout, "단축키 id %d개 개명: %v\n", len(rep.ShortcutsRenamed), rep.ShortcutsRenamed)
	}
	if len(rep.BrokenRefs) > 0 {
		fmt.Fprintf(stdout, "경고: 탭이 참조하나 도구가 없음 %d개: %v\n", len(rep.BrokenRefs), rep.BrokenRefs)
	}
	if id := rep.Identity; id.Total() > 0 {
		fmt.Fprintf(stdout, "구 식별자 %d개를 uuid 로 재작성: 창 %d, 분할 칸 %d, 탭 %d, 도구 %d\n",
			id.Total(), id.Windows, id.Panes, id.Tabs, id.Tools)
	} else {
		fmt.Fprintln(stdout, "구 식별자 없음 — 재작성할 것이 없습니다.")
	}
	if d := rep.Identity.Dangling; len(d) > 0 {
		fmt.Fprintf(stdout, "경고: 대상이 없어 값을 보존한 참조 %d개: %v\n", len(d), d)
	}
	if !o.DryRun {
		fmt.Fprintln(stdout, "백업: *.v1.bak (workspace/tools/settings)")
		if rep.Identity.Total() > 0 {
			fmt.Fprintln(stdout, "백업: *.preuuid.bak (식별자 재작성 직전 상태)")
		}
	}
	return 0
}

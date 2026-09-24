package cli

import (
	"dongminal/internal/shared/platform"
	"dongminal/internal/shared/toolipc"
)

// 홈의 구성 — **한 곳에서 선언한다** (M5 `G4-3`·`G3-4`).
//
// `backup` 이 담을 것과 `uninstall` 이 지울 것은 **같은 물음의 두 답**이다:
// "무엇이 이 제품의 것인가". 두 벌로 적으면 한쪽만 고쳐지고, 그때 백업은 담지
// 않은 것을 제거는 지운다 — 되돌릴 수 없는 손실이다.
//
// `rollbackTargets`·`bundleSettings`·`homeLogs` 는 **더 좁은 물음**의 답이라
// 그대로 둔다 (되돌릴 수 있는가 / 신고에 붙일 것인가 / 상한을 걸 것인가).
// 이 표는 그 셋을 대체하지 않고 위에서 덮으며, 검사가 셋 전부가 여기 있는지 본다.

// homeEntry 는 홈 아래 항목 하나다.
type homeEntry struct {
	// Name 은 홈 기준 이름이다. 디렉터리면 끝에 `/` 가 없다 — `IsDir` 이 답한다.
	Name  string
	IsDir bool
	// What 은 사람이 읽는 설명이다. `uninstall --dry-run` 의 목록이 곧 안내이므로
	// 비어 있으면 검사가 잡는다.
	What string
	// InBackup 은 **`backup` 이 zip 에 담는가**다.
	//
	// KeepOnUninstall 은 **맨 `dongminal uninstall` 이 보존하는가**다
	// (`--purge` 는 그것도 지운다).
	//
	// DOC_SYNC_SRS FR-DSY-60~62:
	//
	//	이전 동작: `Backup` 필드 **하나**가 두 물음에 답했다
	//	새  동작: 물음마다 필드가 하나다
	//	이유:     D-STR-4 가 이 겸직을 실측으로 발견했다 — `backup.go` 에게 이
	//	          필드는 "담는가" 이고 `uninstall.go` 의 `uninstallPlan` 은
	//	          `e.Backup && !purge` 로 걸러 **"보존하는가"** 로 읽는다.
	//	          그때는 되돌릴 수 없는 쪽(보존)을 따라 값을 정하는 것으로 막았고,
	//	          **필드가 두 물음을 겸하는 것 자체**는 두 명령의 계약 변경이라
	//	          그 묶음의 범위를 넘었다
	//
	// **값은 한 줄도 바뀌지 않았다** (FR-DSY-61). 지금 모든 항목에서 둘은 같다 —
	// 가르는 것이 이 변경이고, 답을 다시 정하는 것은 아니다. 갈라 두었으므로
	// 다음 사람은 항목마다 **두 물음을 따로** 답하게 된다.
	InBackup        bool
	KeepOnUninstall bool
	// Ephemeral 은 **다음 기동이 다시 만드는 것**인가다. 담아도 뜻이 없고,
	// 소켓은 zip 에 담기지도 않는다.
	Ephemeral bool
}

// homeLayout 은 홈의 전수 목록이다.
//
// 함수인 이유는 `restartLogFile` 같은 값이 다른 파일의 상수이기 때문이다 —
// 패키지 초기화 순서에 매이지 않는다 (`actionsOf` 와 같은 관례).
func homeLayout() []homeEntry {
	return []homeEntry{
		// ── 되살릴 수 있는 상태 ──
		{Name: "workspace.json", What: "창·칸·탭의 배치와 도구 연결", InBackup: true, KeepOnUninstall: true},
		{Name: "settings.json", What: "테마·단축키·상태바·레이아웃 프리셋", InBackup: true, KeepOnUninstall: true},
		{Name: "access.json", What: "접속 허용 목록 (기기·호스트 이름)", InBackup: true, KeepOnUninstall: true},
		{Name: "lsp-paths.json", What: "언어 서버 실행 파일 경로 표 (설정 ▸ Code)", InBackup: true, KeepOnUninstall: true},
		{Name: "runs.json", What: "Run(오케스트레이션) 기록", InBackup: true, KeepOnUninstall: true},
		{Name: "tools.json", What: "도구의 이름·작업 폴더 등 복원 정보", InBackup: true, KeepOnUninstall: true},
		{Name: "server.json", What: "서버 기동값 (host·port·로그)", InBackup: true, KeepOnUninstall: true},
		{Name: "sandbox.json", What: "샌드박스 프로파일 정의", InBackup: true, KeepOnUninstall: true},

		// ── 사용자가 만든 내용 ──
		{Name: "notes", IsDir: true, What: "메모장", InBackup: true, KeepOnUninstall: true},

		// ── 다시 만들어지는 것 ──
		{Name: "bin", IsDir: true, What: "런타임 헬퍼 (서버가 기동마다 다시 채운다)", Ephemeral: true},
		{Name: "tool-history", IsDir: true, What: "도구 셸의 히스토리 파일", Ephemeral: true},
		{Name: daemonSockFile, What: "데몬 IPC 소켓", Ephemeral: true},
		{Name: daemonPIDFile, What: "데몬 pidfile", Ephemeral: true},
		{Name: platform.LastExitFile, What: "마지막 종료가 정상이었는지의 표시", Ephemeral: true},
		{Name: "server.log", What: "웹 서버 로그", Ephemeral: true},
		{Name: "daemon.log", What: "dongminald 로그", Ephemeral: true},
		{Name: restartLogFile, What: "재시작 대리의 출력", Ephemeral: true},

		// ── 2026-09-21 에 더한 것 (STRUCTURE_CLEANUP_SRS FR-STR-30) ──
		//
		// 표가 홈의 절반쯤만 알고 있었다. `scripts/check-home-layout.sh` 가 코드에서
		// 파생한 결과와 대조하며, 그 검사가 **열하나**를 찾았다 — 감사가 손으로 센
		// 일곱보다 많다.
		//
		// `git-worktrees` 가 이 묶음에서 가장 비싼 판단이었다 (D-STR-4).
		//
		// **두 물음이 갈린 지금도 답은 둘 다 true 다** (DOC_SYNC_SRS FR-DSY-62).
		// `KeepOnUninstall` 이 true 인 것은 명백하다 — 사용자가 Git 창에서 만든
		// worktree 이고 커밋하지 않은 작업이 그 안에 있다. `InBackup` 이 true 인
		// 것은 덜 명백하다: worktree 의 `.git` 은 절대 경로라 **다른 기계에서 풀면
		// 깨진 것이 복원된다.** 그래도 담는 쪽인 이유는 대가가 bounded 이기
		// 때문이다 — 같은 기계 복원은 그대로 되고, 다른 기계에서는 가리키는 곳이
		// 없는 디렉터리가 하나 생길 뿐 **조용한 손실이 아니다**.
		//
		// 갈라 두었으므로 이제 이 둘을 **따로** 뒤집을 수 있다. 종전에는 한쪽을
		// 바꾸면 다른 쪽이 끌려갔다.
		{Name: "git-worktrees", IsDir: true, What: "Git 창에서 만든 사용자 worktree", InBackup: true, KeepOnUninstall: true},
		{Name: "panes.json", What: "변환 전 레이아웃 (migrate 가 workspace.json 으로 옮긴다)", InBackup: true, KeepOnUninstall: true},

		{Name: "worktrees", IsDir: true, What: "Run 격리 worktree (정리는 Run 레코드가 정한다)", Ephemeral: true},
		{Name: "ext", IsDir: true, What: "편집기 플러그인·언어 서버 (다시 받을 수 있다)", Ephemeral: true},
		// 이름의 출처는 `shared/sandbox` 의 `helperCacheDir` 인데 그것은 내보내지
		// 않았고, 여기서 그 패키지를 끌어오면 축 경계가 흔들린다. 값이 두 자리에
		// 있는 것을 `check-home-layout.sh` 가 대조한다.
		{Name: "cache", IsDir: true, What: "컨테이너용 리눅스 헬퍼 캐시 (판마다 다시 만든다)", Ephemeral: true},
		{Name: toolHomeDir, IsDir: true, What: "격리 기동에서 도구 셸이 쓰는 홈", Ephemeral: true},
		{Name: toolipc.DaemonBuildFile, What: "도는 데몬의 코드 지문", Ephemeral: true},
		{Name: "doctor", IsDir: true, What: "doctor 의 IPC 자리", Ephemeral: true},
		{Name: "doctor-tools", IsDir: true, What: "doctor 가 띄운 도구의 데이터", Ephemeral: true},
		{Name: "doctor-probe.txt", What: "doctor 탐침의 출력", Ephemeral: true},
		{Name: "verify-too-large.bin", What: "verify 가 413 을 확인할 때 쓰는 큰 파일 (죽으면 남는다)", Ephemeral: true},
	}
}

// backupNames 는 담을 이름들이다. 묻는 것은 **"zip 에 담는가"** 하나다.
func backupNames() []string {
	var out []string
	for _, e := range homeLayout() {
		if e.InBackup {
			out = append(out, e.Name)
		}
	}
	return out
}

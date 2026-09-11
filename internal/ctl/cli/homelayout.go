package cli

import "dongminal/internal/shared/platform"

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
	// Backup 은 `backup` 이 담는가다.
	Backup bool
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
		{Name: "workspace.json", What: "창·칸·탭의 배치와 도구 연결", Backup: true},
		{Name: "settings.json", What: "테마·단축키·상태바·레이아웃 프리셋", Backup: true},
		{Name: "access.json", What: "접속 허용 목록 (기기·호스트 이름)", Backup: true},
		{Name: "runs.json", What: "Run(오케스트레이션) 기록", Backup: true},
		{Name: "tools.json", What: "도구의 이름·작업 폴더 등 복원 정보", Backup: true},
		{Name: "server.json", What: "서버 기동값 (host·port·로그)", Backup: true},
		{Name: "sandbox.json", What: "샌드박스 프로파일 정의", Backup: true},

		// ── 사용자가 만든 내용 ──
		{Name: "notes", IsDir: true, What: "메모장", Backup: true},

		// ── 다시 만들어지는 것 ──
		{Name: "bin", IsDir: true, What: "런타임 헬퍼 (서버가 기동마다 다시 채운다)", Ephemeral: true},
		{Name: "tool-history", IsDir: true, What: "도구 셸의 히스토리 파일", Ephemeral: true},
		{Name: daemonSockFile, What: "데몬 IPC 소켓", Ephemeral: true},
		{Name: daemonPIDFile, What: "데몬 pidfile", Ephemeral: true},
		{Name: platform.LastExitFile, What: "마지막 종료가 정상이었는지의 표시", Ephemeral: true},
		{Name: "server.log", What: "웹 서버 로그", Ephemeral: true},
		{Name: "daemon.log", What: "dongminald 로그", Ephemeral: true},
		{Name: restartLogFile, What: "재시작 대리의 출력", Ephemeral: true},
	}
}

// backupNames 는 담을 이름들이다.
func backupNames() []string {
	var out []string
	for _, e := range homeLayout() {
		if e.Backup {
			out = append(out, e.Name)
		}
	}
	return out
}

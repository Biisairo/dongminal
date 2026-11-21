package httpapi

// 탐색기(/api/fs/*)의 상한 표 (REFACTOR3_GO_STRUCT_SRS FR-RGS-5). 값마다 근거 요구는
// 옆 주석에 있다. 상한을 고칠 때 이 파일 하나만 본다.

// 서버 하나의 상한 기본값이다. `defaultLimits` 가 `serverLimits` 에 싣고, 시험만이
// 서버 하나의 값을 낮춘다.
const (
	// fsListMax·fsDeleteMax — FS_LIST_MAX·FS_DELETE_MAX (FR-EDT-65·118).
	fsListMax   = 10000
	fsDeleteMax = 10000
	// fsCopyMax 는 복사의 항목 수 상한이다. 삭제와 같은 규약이다 (FR-WBR-66): 먼저
	// 세고, 넘으면 시작하지 않는다.
	fsCopyMax = 10000
	// fsUploadMaxBytes 는 업로드 본문의 상한이다 (FR-FTR-5, D-6).
	fsUploadMaxBytes int64 = 512 << 20
)

// 폴더 zip 내려받기의 상한. const 가 아닌 것은 테스트가 낮춰 잡기 위해서다 — 실제
// 값으로 픽스처를 만들면 테스트가 파일 5만 개를 만든다.
var (
	// FR-ETR-12: 항목 수 상한. 트리 전체를 걷는 비용의 상한이기도 하다.
	zipMaxEntries = 50000
	// FR-ETR-12: 압축 **전** 총 바이트의 상한.
	zipMaxBytes int64 = 2 << 30
	// FR-ETR-45 (`SEC-20`): 동시 요청 상한. 한 요청이 최대 2GiB 를 압축하며 CPU 와
	// 디스크를 함께 쓰므로, 겹치면 서버가 그 시간 동안 다른 일을 못 한다.
	zipMaxConcurrent int64 = 2
)
